import "dotenv/config";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const REQUEST_TIMEOUT_MS = 60_000;

// Rough budget for *history* tokens sent with each request (the current message is extra).
// Gemini has a huge context window, but every resent token costs latency and money.
export const HISTORY_TOKEN_BUDGET = Number(process.env.HISTORY_TOKEN_BUDGET) || 24_000;

// ~4 characters per token is a good-enough estimate for English text/code.
const estimateTokens = (text = "") => Math.ceil(text.length / 4);

const SYSTEM_INSTRUCTION =
  "You are SigmaGPT, a helpful assistant. Answer clearly and format code and structure with Markdown.";

export class GeminiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
  }
}

/**
 * Keep the most recent messages that fit inside the token budget.
 * `history` is oldest -> newest: [{ role: "user" | "model", content }]
 */
export const trimHistory = (history = [], budget = HISTORY_TOKEN_BUDGET) => {
  const kept = [];
  let used = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    // Image-only user messages are stored with empty content; keep the turn as a placeholder
    // so user/model alternation is preserved (old images are NOT re-sent).
    const text = history[i].content?.trim() || (history[i].role === "user" ? "[image attached]" : "");
    if (!text) continue;

    const cost = estimateTokens(text);
    if (used + cost > budget) break;
    used += cost;
    kept.push({ role: history[i].role, text });
  }

  kept.reverse();
  // A conversation must start with a user turn.
  while (kept.length && kept[0].role !== "user") kept.shift();
  return kept;
};

const getGeminiAPIResponse = async (message, imagePayload = null, history = []) => {
  const contents = trimHistory(history).map(({ role, text }) => ({
    role,
    parts: [{ text }],
  }));

  const parts = [];
  if (imagePayload) {
    parts.push({ inlineData: { mimeType: imagePayload.mimeType, data: imagePayload.data } });
  }
  // Gemini needs some text alongside an image; default to a sensible instruction.
  parts.push({ text: message || "Describe and analyze this image." });
  contents.push({ role: "user", parts });

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Header instead of ?key= so the key never lands in URLs/logs.
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("Gemini network error:", err.message);
    throw new GeminiError(
      err.name === "TimeoutError" ? "The AI took too long to respond." : "Could not reach the AI service.",
      504
    );
  }

  if (!response.ok) {
    console.error(`Gemini API failed: ${response.status}`);
    throw new GeminiError(
      response.status === 429 ? "The AI service is busy. Try again shortly." : "The AI service returned an error.",
      response.status === 429 ? 429 : 502
    );
  }

  const data = await response.json();

  if (data?.promptFeedback?.blockReason) {
    throw new GeminiError("That request was blocked by the AI safety filters.", 422);
  }

  // Join all text parts (thinking models can return more than one part).
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  if (!text) throw new GeminiError("The AI returned an empty response.", 502);
  return text;
};

export default getGeminiAPIResponse;

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

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

let client;
const getClient = () => (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));

/**
 * Streams the model's reply as an async generator of text chunks (SDK, not raw fetch,
 * so we get real server-sent tokens back from Gemini instead of one big JSON blob).
 *
 * @param {string} message              The new user message (may be empty if only an image is sent).
 * @param {{mimeType: string, data: string}|null} imagePayload  Base64 image for THIS turn only.
 * @param {Array<{role: string, content: string}>} history      Prior turns, oldest -> newest.
 * @param {AbortSignal} [signal]         Abort to stop generation (e.g. client disconnected).
 */
export async function* streamGeminiResponse(message, imagePayload = null, history = [], signal) {
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

  let stream;
  try {
    stream = await getClient().models.generateContentStream({
      model: MODEL,
      contents,
      config: { systemInstruction: SYSTEM_INSTRUCTION, abortSignal: signal },
    });
  } catch (err) {
    if (signal?.aborted) return;
    console.error("Gemini stream start error:", err?.message || err);
    const status = err?.status === 429 ? 429 : err?.status === 400 ? 422 : 502;
    throw new GeminiError(
      status === 429 ? "The AI service is busy. Try again shortly." : "The AI service returned an error.",
      status
    );
  }

  let sawBlock = false;
  try {
    for await (const chunk of stream) {
      if (chunk?.promptFeedback?.blockReason) sawBlock = true;
      const text = chunk.text;
      if (text) yield text;
    }
  } catch (err) {
    if (signal?.aborted) return; // caller disconnected — not a real error
    console.error("Gemini stream read error:", err?.message || err);
    throw new GeminiError("The AI service was interrupted.", 502);
  }

  if (sawBlock) throw new GeminiError("That request was blocked by the AI safety filters.", 422);
}

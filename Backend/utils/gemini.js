import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Rough budget for *history* tokens sent with each request (the current message is extra).
// Gemini has a huge context window, but every resent token costs latency and money.
export const HISTORY_TOKEN_BUDGET = Number(process.env.HISTORY_TOKEN_BUDGET) || 24_000;

// ~4 characters per token is a good-enough estimate for English text/code.
const estimateTokens = (text = "") => Math.ceil(text.length / 4);

const SYSTEM_INSTRUCTION =
  "You are SigmaGPT, an AI study assistant. Students bring you notes, textbook excerpts, and papers " +
  "to understand. Explain concepts clearly and at the level the student seems to be working at; break " +
  "down complex ideas step by step rather than just stating conclusions; use short examples or analogies " +
  "where they genuinely aid understanding; and format code, formulas, and structure with Markdown. " +
  "When the conversation includes source material (uploaded documents), ground your answers in it and " +
  "say clearly when something goes beyond what's provided, rather than guessing. When it doesn't, answer " +
  "from general knowledge as usual, but stay in the study-assistant register: teach, don't just answer. " +
  "When a message includes a 'Retrieved context' block, each excerpt is numbered like [1], [2]. Cite the " +
  "excerpts you actually rely on inline using that same [n] marker right after the claim it supports — do " +
  "not invent a citation for a claim the excerpts don't support, and don't cite an excerpt you didn't use.";

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
 * Builds the "Retrieved context" block injected ahead of the user's message when
 * RAG found relevant chunks. Numbering here ([1], [2]...) is what the model is
 * instructed (see SYSTEM_INSTRUCTION) to cite inline, and what the frontend maps
 * back to source chunks via the `citations` array returned alongside the reply.
 *
 * @param {Array<{fileName: string, chunkIndex: number, text: string}>} chunks
 */
export function buildContextBlock(chunks) {
  if (!chunks?.length) return "";
  const excerpts = chunks
    .map((c, i) => `[${i + 1}] (from "${c.fileName}", section ${c.chunkIndex + 1}):\n${c.text}`)
    .join("\n\n");
  return `Retrieved context from the student's uploaded documents:\n\n${excerpts}\n\n---\n\n`;
}

/**
 * Streams the model's reply as an async generator of text chunks (SDK, not raw fetch,
 * so we get real server-sent tokens back from Gemini instead of one big JSON blob).
 *
 * @param {string} message              The new user message (may be empty if only an image is sent).
 * @param {{mimeType: string, data: string}|null} imagePayload  Base64 image for THIS turn only.
 * @param {Array<{role: string, content: string}>} history      Prior turns, oldest -> newest.
 * @param {AbortSignal} [signal]         Abort to stop generation (e.g. client disconnected).
 * @param {Array<{fileName: string, chunkIndex: number, text: string}>} [retrievedChunks]  RAG context for THIS turn only.
 */
export async function* streamGeminiResponse(message, imagePayload = null, history = [], signal, retrievedChunks = []) {
  const contents = trimHistory(history).map(({ role, text }) => ({
    role,
    parts: [{ text }],
  }));

  const parts = [];
  if (imagePayload) {
    parts.push({ inlineData: { mimeType: imagePayload.mimeType, data: imagePayload.data } });
  }
  const contextBlock = buildContextBlock(retrievedChunks);
  // Gemini needs some text alongside an image; default to a sensible instruction.
  parts.push({ text: contextBlock + (message || "Describe and analyze this image.") });
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

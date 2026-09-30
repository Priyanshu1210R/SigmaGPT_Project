// Splits extracted document text into overlapping chunks small enough to embed
// and to hand to Gemini as retrieved context.
//
// Strategy: paragraph-aware. Pack whole paragraphs into a chunk up to `chunkChars`;
// if a single paragraph is itself bigger than that, hard-split it by sentence, then by
// raw characters as a last resort. Each chunk after the first repeats the last
// `overlapChars` of the previous one, so an answer whose evidence straddles a chunk
// boundary doesn't get cut in half.

export const DEFAULT_CHUNK_CHARS = 1200; // ~300 tokens
export const DEFAULT_OVERLAP_CHARS = 150; // ~40 tokens
export const MAX_CHUNKS_PER_DOCUMENT = 400; // cost/storage ceiling per upload

const splitIntoParagraphs = (text) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

const splitIntoSentences = (text) => text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g)?.map((s) => s.trim()) ?? [text];

// Break one oversized unit into <= chunkChars pieces without losing any text.
function hardSplit(text, chunkChars) {
  const pieces = [];
  for (let i = 0; i < text.length; i += chunkChars) pieces.push(text.slice(i, i + chunkChars));
  return pieces;
}

/**
 * @param {string} text
 * @param {{chunkChars?: number, overlapChars?: number}} [opts]
 * @returns {string[]} chunk texts, in reading order
 */
export function chunkText(text, opts = {}) {
  const chunkChars = opts.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const overlapChars = opts.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  const clean = (text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  // Flatten to a list of "units" no single one of which exceeds chunkChars.
  const units = [];
  for (const para of splitIntoParagraphs(clean)) {
    if (para.length <= chunkChars) {
      units.push(para);
      continue;
    }
    for (const sentence of splitIntoSentences(para)) {
      if (sentence.length <= chunkChars) units.push(sentence);
      else units.push(...hardSplit(sentence, chunkChars));
    }
  }

  // Greedily pack units into chunks, carrying an overlap tail forward.
  const chunks = [];
  let current = "";
  for (const unit of units) {
    const joined = current ? `${current}\n\n${unit}` : unit;
    if (joined.length <= chunkChars) {
      current = joined;
      continue;
    }
    if (current) chunks.push(current);
    // Start the next chunk with the overlap tail of the one we just closed.
    const tail = current.slice(-overlapChars).trim();
    current = tail && unit.length <= chunkChars ? `${tail}\n\n${unit}` : unit;
    // Edge case: unit itself (rare, only if hardSplit's chunkChars rounding + overlap
    // pushes it over) is still within a fudge factor; leave as-is rather than lose text.
  }
  if (current) chunks.push(current);

  return chunks.slice(0, MAX_CHUNKS_PER_DOCUMENT);
}

import { createRequire } from "module";
const require = createRequire(import.meta.url);
// Legacy (non-worker) Node build: no DOM/Worker needed, runs text extraction in-process.
const { getDocument } = require("pdfjs-dist/legacy/build/pdf.mjs");

export class UnsupportedFileError extends Error {}

const SUPPORTED = new Set(["application/pdf", "text/plain", "text/markdown", "text/x-markdown"]);

export const isSupportedMimeType = (mimeType) => SUPPORTED.has(mimeType);

async function extractPdfText(buffer) {
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false, // untrusted uploads — don't let embedded PDF JS run
  }).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Group by line the same way pdf.js examples do: a Y-coordinate change starts a new line.
    let lastY = null;
    let line = "";
    const lines = [];
    for (const item of content.items) {
      if (lastY !== null && item.transform[5] !== lastY) {
        lines.push(line);
        line = "";
      }
      line += item.str;
      lastY = item.transform[5];
    }
    if (line) lines.push(line);
    pages.push(lines.join("\n"));
  }
  await doc.destroy();
  return pages.join("\n\n");
}

/**
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<string>} plain text extracted from the file
 */
export async function extractText(buffer, mimeType) {
  if (mimeType === "application/pdf") {
    let text;
    try {
      text = await extractPdfText(buffer);
    } catch (err) {
      throw new UnsupportedFileError(`Could not read this PDF (${err.message || "corrupt or unsupported PDF"}).`);
    }
    if (!text?.trim()) {
      // Most likely a scanned/image-only PDF with no embedded text layer — we don't OCR.
      throw new UnsupportedFileError("No extractable text found (this may be a scanned/image-only PDF).");
    }
    return text;
  }

  if (mimeType === "text/plain" || mimeType === "text/markdown" || mimeType === "text/x-markdown") {
    return buffer.toString("utf-8");
  }

  throw new UnsupportedFileError(`Unsupported file type: ${mimeType}`);
}

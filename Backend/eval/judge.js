// LLM-as-judge for the two things string matching can't decide:
//   1. correctness — does the answer say what the reference answer says?
//   2. grounding   — is every claim in the answer supported by the excerpts the model was given?
//
// Caveat worth stating whenever you quote a number from this: a model grading its own output
// tends to be lenient. Set EVAL_JUDGE_MODEL to a different (ideally stronger) model than the
// one that generated the answers, and spot-check a few verdicts by hand (the JSON results
// include the judge's reason for every grade).
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { withRetry } from "./util.js";

export const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";

export const CORRECTNESS_VERDICTS = ["CORRECT", "PARTIAL", "INCORRECT"];
export const GROUNDING_VERDICTS = ["FULLY_SUPPORTED", "PARTIALLY_SUPPORTED", "UNSUPPORTED"];

export function correctnessPrompt({ question, expected, answer }) {
  return `You are grading an AI study assistant's answer against a reference answer taken from the source document.

Question: ${question}

Reference answer (ground truth): ${expected}

Candidate answer:
"""
${answer}
"""

Grade the candidate:
- CORRECT: it states everything essential in the reference answer and nothing in it contradicts the reference.
- PARTIAL: it gets part of the essential content right but omits a key part or contains a minor error.
- INCORRECT: it is wrong, contradicts the reference, or does not answer the question.

Rules:
- Extra true detail beyond the reference does NOT make an answer incorrect unless it contradicts the reference.
- Judge meaning, not wording. Equivalent numbers/units count (e.g. "8KB" = "8 kilobytes").
- If the reference says the document does NOT contain the information, the candidate is CORRECT only if it says the provided material doesn't contain it (it may add clearly-labelled general knowledge). If it states a specific answer as though the document supports it, it is INCORRECT.

Respond with JSON only: {"verdict": "CORRECT" | "PARTIAL" | "INCORRECT", "reason": "<one short sentence>"}`;
}

export function groundingPrompt({ question, chunks, answer }) {
  const excerpts = chunks.map((c, i) => `[${i + 1}]\n${c.text}`).join("\n\n");
  return `You are checking whether an AI assistant's answer is faithful to the source excerpts it was given.

Source excerpts:
"""
${excerpts || "(none)"}
"""

Question: ${question}

Answer to check:
"""
${answer}
"""

Identify every factual claim the answer makes about the source material (specific facts, numbers, names, behaviours of the system described). A claim is SUPPORTED if the excerpts state it or it follows directly from them.

Do NOT count against the answer: citation markers like [1]; teaching analogies; and general background knowledge that the answer clearly labels as general knowledge or as outside the provided material.

Verdict:
- FULLY_SUPPORTED: every claim is supported by the excerpts.
- PARTIALLY_SUPPORTED: at least one claim is supported and at least one is not.
- UNSUPPORTED: no substantive claim is supported, or the answer contradicts the excerpts.
If the answer only says the information is not in the provided material, that is FULLY_SUPPORTED when the excerpts indeed do not contain it.

Respond with JSON only: {"verdict": "FULLY_SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED", "unsupported_claims": ["<claim>", ...]}`;
}

/** Tolerant JSON extraction: handles ```json fences and stray prose around the object. */
export function parseJudgeJson(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const direct = tryParse(cleaned);
  if (direct && typeof direct === "object") return direct;
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start >= 0 && end > start ? tryParse(cleaned.slice(start, end + 1)) : null;
}

/**
 * @param {{apiKey?: string, model?: string, client?: object}} [opts]  `client` lets tests inject a fake.
 */
export function createJudge({ apiKey = process.env.GEMINI_API_KEY, model = JUDGE_MODEL, client } = {}) {
  const ai = client ?? new GoogleGenAI({ apiKey });

  async function ask(prompt, allowed) {
    // One re-ask if the model returns something we can't parse into an allowed verdict.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await withRetry(() =>
        ai.models.generateContent({
          model,
          contents: prompt,
          config: { temperature: 0, responseMimeType: "application/json" },
        })
      );
      const parsed = parseJudgeJson(res?.text);
      const verdict = typeof parsed?.verdict === "string" ? parsed.verdict.trim().toUpperCase() : "";
      if (allowed.includes(verdict)) return { ...parsed, verdict };
    }
    return { verdict: "JUDGE_ERROR", reason: "Judge returned an unparseable or out-of-range verdict twice." };
  }

  return {
    model,
    async judgeCorrectness({ question, expected, answer }) {
      const out = await ask(correctnessPrompt({ question, expected, answer }), CORRECTNESS_VERDICTS);
      return { verdict: out.verdict, reason: out.reason ?? "" };
    },
    async judgeGrounding({ question, chunks, answer }) {
      const out = await ask(groundingPrompt({ question, chunks, answer }), GROUNDING_VERDICTS);
      return {
        verdict: out.verdict,
        unsupported: Array.isArray(out.unsupported_claims) ? out.unsupported_claims : [],
        reason: out.reason ?? "",
      };
    },
  };
}

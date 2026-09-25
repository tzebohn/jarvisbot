import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const WAKE_PHRASE = "Jarvis";
export const WAKE_KEYWORD = "JARVIS";
export const DEFAULT_WAKE_THRESHOLD = 0.25;
export const DEFAULT_WAKE_SCORE = 1.5;
/** U.S. English: canonical first, then just the natural unstressed-vowel alternative. */
export const WAKE_PRONUNCIATIONS = [
    { id: "canonical", keyword: WAKE_KEYWORD, tokens: ["JH", "AA1", "R", "V", "AH0", "S"],
        description: "Canonical American Jarvis with a pronounced r and reduced, unstressed second vowel." },
    { id: "rhotic-ih", keyword: "JARVIS_RHOTIC_IH", tokens: ["JH", "AA1", "R", "V", "IH0", "S"],
        description: "Rhotic Jarvis with a clearer unstressed ih in vis, rather than schwa." },
] as const;
export type WakePronunciationId = typeof WAKE_PRONUNCIATIONS[number]["id"];
export const WAKE_TOKENS = WAKE_PRONUNCIATIONS[0].tokens;

/** Native labels identify acoustic paths; all accepted labels still mean the one phrase Jarvis. */
export function getWakePronunciation(keyword: string) {
    return WAKE_PRONUNCIATIONS.find((pronunciation) => pronunciation.keyword === keyword);
}

/** Validate against the actual installed/downloaded model before producing its keyword file. */
export function buildWakeKeywords(vocabulary: string): string {
    const tokens = new Set(vocabulary.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]));
    for (const pronunciation of WAKE_PRONUNCIATIONS) {
        for (const token of pronunciation.tokens) {
            if (!tokens.has(token)) throw new Error(`Wake model vocabulary is missing ${token}, required by Jarvis pronunciation ${pronunciation.id}.`);
        }
    }
    return WAKE_PRONUNCIATIONS.map(({ tokens, keyword }) => `${tokens.join(" ")} @${keyword}`).join("\n") + "\n";
}

export function validateWakeKeywords(keywords: string, vocabulary: string): void {
    const expected = buildWakeKeywords(vocabulary);
    const normalize = (text: string) => text.trim().split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, " ")).join("\n");
    if (normalize(keywords) !== normalize(expected)) {
        throw new Error("The Jarvis keyword file is outdated or modified. Run pnpm --filter bot setup:wake --keywords-only to regenerate the validated pronunciations.");
    }
}
export const MODEL_NAME = "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20";
export const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${MODEL_NAME}.tar.bz2`;
export const DEFAULT_MODEL_DIRECTORY = fileURLToPath(new URL("../../../models/wake/", import.meta.url));
export const MODEL_FILES = {
    encoder: "encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx",
    decoder: "decoder-epoch-13-avg-2-chunk-8-left-64.onnx",
    joiner: "joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx",
    tokens: "tokens.txt",
};

export function wakeModelPaths(directory = DEFAULT_MODEL_DIRECTORY) {
    return { encoder: join(directory, MODEL_FILES.encoder), decoder: join(directory, MODEL_FILES.decoder),
        joiner: join(directory, MODEL_FILES.joiner), tokens: join(directory, MODEL_FILES.tokens),
        keywords: join(directory, "jarvis.txt") };
}

import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import { WakeEngine } from "../src/voice/wake/WakeEngine.ts";
import { createWebRtcVadFactory } from "../src/voice/processing/WebRtcVad.ts";
import { DEFAULT_WAKE_SCORE, DEFAULT_WAKE_THRESHOLD, WAKE_PRONUNCIATIONS } from "../src/voice/wake/wakeModel.ts";
import { decodeWav, opusRoundTrip } from "./voice-audio.mjs";
import { syntheticWakeCases } from "./voice-synthetic.mjs";
import { replayWake } from "./wake-replay.mjs";

const flags = new Set();
const args = [];
let prefixMs;
const rawArgs = process.argv.slice(2);
for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (["--compare-vad", "--debug", "--opus", "--phonemes"].includes(arg)) flags.add(arg);
    else if (arg === "--prefix-ms") {
        prefixMs = Number(rawArgs[++index]);
        if (!Number.isInteger(prefixMs) || prefixMs < 20 || prefixMs > 60_000 || prefixMs % 20) {
            throw new Error("--prefix-ms must be a multiple of 20 between 20 and 60000, ending just after the wake phrase in your recording.");
        }
    } else args.push(arg);
}
const cases = [];
if (args.length === 1 && args[0] === "--synthetic") {
    console.log("Synthetic TTS/IPA checks are smoke tests, not microphone/accent accuracy measurements. IPA samples prescribe phones; they aren't recordings of accented speakers.");
    cases.push(...syntheticWakeCases());
} else {
    for (let index = 0; index < args.length; index += 2) {
        const label = args[index];
        const path = args[index + 1];
        if (!["--positive", "--negative"].includes(label) || !path) throw new Error("Usage: diagnose:wake [--compare-vad] [--debug] [--opus] [--phonemes] [--prefix-ms 1200] --positive sample.wav --negative ordinary-chat.wav, or --synthetic on Windows.");
        if ((await stat(path)).size > 50_000_000) throw new Error("Diagnostic samples must be smaller than 50 MB and no longer than 60 seconds.");
        cases.push({ name: path, expected: label === "--positive", pcm: decodeWav(await readFile(path)) });
    }
}
if (!cases.length) throw new Error("Provide --positive/--negative WAV samples or --synthetic.");
const createVad = await createWebRtcVadFactory(Number(process.env.VOICE_VAD_MODE?.trim() || "2"));
const engine = await WakeEngine.create(process.env.VOICE_WAKE_MODEL_DIR?.trim() || undefined,
    Number(process.env.VOICE_WAKE_THRESHOLD?.trim() || DEFAULT_WAKE_THRESHOLD), Number(process.env.VOICE_WAKE_SCORE?.trim() || DEFAULT_WAKE_SCORE));
let falsePositives = 0;
let falseNegatives = 0;
let comparisonFailures = 0;
const gates = flags.has("--compare-vad") ? ["voice", "segment", "off"] : ["voice"];
console.log(JSON.stringify({ threshold: engine.threshold, score: Number(process.env.VOICE_WAKE_SCORE?.trim() || DEFAULT_WAKE_SCORE),
    pronunciations: WAKE_PRONUNCIATIONS,
    vadMode: Number(process.env.VOICE_VAD_MODE?.trim() || "2"), gates, opusRoundTrip: flags.has("--opus"),
    prefixMs, note: "KWS returns complete keywords, not transcripts, rejected hypotheses, or confidence scores. Optional greedy phonemes are a separate diagnostic hypothesis." }));
try {
    const phonemes = flags.has("--phonemes")
        ? await (await import("./wake-phonemes.mjs")).createPhonemeProbe(process.env.VOICE_WAKE_MODEL_DIR?.trim() || undefined) : undefined;
    for (const sample of cases) {
        if (flags.has("--opus")) sample.pcm = opusRoundTrip(sample.pcm);
        const variants = [{ name: "full", pcm: sample.pcm }];
        if (prefixMs !== undefined) variants.push({ name: `prefix-${prefixMs}ms`, pcm: sample.pcm.subarray(0, prefixMs * 192) });
        for (const variant of variants) {
            if (phonemes) console.log(JSON.stringify({ sample: sample.name, variant: variant.name, ...phonemes(variant.pcm) }));
            for (const gate of gates) {
                const result = await replayWake(variant.pcm, engine.createBackend, createVad, { gate,
                    onDiagnostic: flags.has("--debug")
                        ? (event, details) => console.log(JSON.stringify({ sample: sample.name, variant: variant.name, gate, event, ...details })) : undefined });
                if (gate === "voice" && variant.name === "full") {
                    if (result.detected && !sample.expected) falsePositives++;
                    if (!result.detected && sample.expected) falseNegatives++;
                } else if (result.detected !== sample.expected) comparisonFailures++;
                console.log(JSON.stringify({ sample: sample.name, variant: variant.name, gate, expected: sample.expected, ...result }));
            }
        }
    }
    console.log(JSON.stringify({ samples: cases.length, threshold: engine.threshold, falsePositives, falseNegatives, comparisonFailures }));
    if (falsePositives || falseNegatives) process.exitCode = 1;
} finally { await engine.close(); }

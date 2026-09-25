import "dotenv/config";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createSpeechToText } from "../src/voice/transcription/config.ts";
import { MODEL_NAME, WAKE_PRONUNCIATIONS, wakeModelPaths } from "../src/voice/wake/wakeModel.ts";
import { AUDIO_FILTERS, decodeWav, opusRoundTrip, audioQuality } from "./voice-audio.mjs";
import { syntheticVoiceCorpus } from "./voice-synthetic.mjs";
import { DEFAULT_EVALUATIONS, validateManifest, evaluateCorpus } from "./voice-evaluation.mjs";

const usage = "Usage: diagnose:voice --manifest corpus.json | --synthetic [--opus] [--stt local] [--output report.json]\n"
    + "Compares raw audio, VAD/keyword tuning, 80 Hz high-pass, and mild FFT denoising using labelled clips.\n"
    + "Synthetic speech requires Windows. STT is off unless --stt local is supplied; it uses the cached local model.\n"
    + "Reports contain labels and optional transcripts. --output creates a new file in an existing directory.\n"
    + "Exit 1 means at least one evaluated configuration had a miss, false wake, STT mismatch, or error.";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") { console.log(usage); process.exit(0); }
const options = {};
for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--manifest", "--synthetic", "--opus", "--stt", "--output"].includes(flag) || Object.hasOwn(options, flag)) throw new Error(usage);
    if (["--synthetic", "--opus"].includes(flag)) options[flag] = true;
    else {
        if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(usage);
        options[flag] = args[++i];
    }
}
if (!!options["--manifest"] === !!options["--synthetic"] || (options["--stt"] && options["--stt"] !== "local")) throw new Error(usage);
const modelDirectory = process.env.VOICE_WAKE_MODEL_DIR?.trim() || undefined;
const modelFilesSha256 = Object.fromEntries(await Promise.all(Object.entries(wakeModelPaths(modelDirectory))
    .map(async ([name, path]) => [name, createHash("sha256").update(await readFile(path)).digest("hex")])));

let configurations = DEFAULT_EVALUATIONS;
let samples;
if (options["--synthetic"]) samples = syntheticVoiceCorpus();
else {
    const path = resolve(options["--manifest"]);
    if ((await stat(path)).size > 1_000_000) throw new Error("Corpus manifest is too large (maximum 1 MB).");
    const manifest = validateManifest(JSON.parse(await readFile(path, "utf8")));
    configurations = manifest.configurations;
    samples = [];
    let bytes = 0;
    for (const sample of manifest.samples) {
        const file = resolve(dirname(path), sample.file);
        const info = await stat(file);
        if (!info.isFile() || info.size > 50_000_000) throw new Error(`Sample ${sample.id} must be a WAV smaller than 50 MB.`);
        const pcm = decodeWav(await readFile(file));
        bytes += pcm.length;
        if (bytes > 128 * 1024 * 1024) throw new Error("Decoded corpus exceeds 128 MiB. Split it into smaller evaluation batches.");
        samples.push({ ...sample, pcm });
    }
}
const corpus = samples.map((sample) => {
    if (options["--opus"]) sample.pcm = opusRoundTrip(sample.pcm);
    return { id: sample.id, source: sample.source, conditions: sample.conditions, expectedWake: sample.expectedWake,
        sha256: createHash("sha256").update(sample.pcm).digest("hex"), quality: audioQuality(sample.pcm),
        sttReference: sample.referenceText !== undefined };
});
if (options["--stt"] && !samples.some((sample) => sample.referenceText !== undefined)) throw new Error("Add referenceText to command samples for STT comparison.");
const metadata = { version: 1, model: MODEL_NAME, modelFilesSha256, pronunciations: WAKE_PRONUNCIATIONS, filters: AUDIO_FILTERS,
    configurations, opusRoundTrip: !!options["--opus"], stt: options["--stt"] ?? "off", corpus,
    note: "Offline full-clip replay, not live capture accuracy or wall-clock latency. Synthetic noise is a proxy; tune with held-out Discord recordings. False keyword hits/hour excludes session cooldown. No production settings are changed." };
console.log(JSON.stringify({ type: "configuration", ...metadata }));
// Force local mode even when the bot's .env defaults to Groq. No cloud upload from this diagnostic.
const stt = options["--stt"] ? createSpeechToText({ ...process.env, VOICE_STT_MODE: "local" }) : undefined;
try {
    const report = await evaluateCorpus(samples, configurations, {
        modelDirectory,
        transcribe: stt ? (audio) => stt.transcribe(audio, new AbortController().signal) : undefined,
        onResult: (result) => console.log(JSON.stringify({ type: "sample", ...result })) });
    for (const summary of report.summaries) console.log(JSON.stringify({ type: "summary", ...summary }));
    console.log(JSON.stringify({ type: "coverage", missingLiveConditions: report.missingLiveConditions }));
    if (options["--output"]) await writeFile(resolve(options["--output"]), JSON.stringify({ ...metadata, ...report }, null, 2) + "\n", { flag: "wx" });
    if (report.summaries.some((summary) => !summary.passed)) process.exitCode = 1;
} finally { stt?.close(); }

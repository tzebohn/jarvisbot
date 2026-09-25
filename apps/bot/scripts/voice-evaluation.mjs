import { WakeEngine } from "../src/voice/wake/WakeEngine.ts";
import { createWebRtcVadFactory } from "../src/voice/processing/WebRtcVad.ts";
import { normalizeTranscript } from "../src/voice/transcription/normalizeTranscript.ts";
import { PCM_FORMAT } from "../src/voice/receive/SpeakerStream.ts";
import { DEFAULT_WAKE_SCORE, DEFAULT_WAKE_THRESHOLD, WAKE_PHRASE } from "../src/voice/wake/wakeModel.ts";
import { AUDIO_FILTERS, audioQuality, preprocessAudio } from "./voice-audio.mjs";
import { replayWake } from "./wake-replay.mjs";

export const LIVE_CONDITIONS = ["quiet", "keyboard", "fan", "hiss", "speakers", "headphones", "background-speech"];
const baseline = { id: "baseline", vadMode: 2, threshold: DEFAULT_WAKE_THRESHOLD, score: DEFAULT_WAKE_SCORE, preprocessing: "raw" };
export const DEFAULT_EVALUATIONS = [baseline,
    { ...baseline, id: "vad-1", vadMode: 1 }, { ...baseline, id: "vad-3", vadMode: 3 },
    { ...baseline, id: "threshold-0.20", threshold: 0.2 }, { ...baseline, id: "threshold-0.30", threshold: 0.3 },
    { ...baseline, id: "highpass", preprocessing: "highpass" }, { ...baseline, id: "denoise", preprocessing: "denoise" }];

function fields(value, allowed, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
        throw new Error(`Invalid ${label} fields.`);
    }
}
const identifier = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value);

export function validateManifest(manifest) {
    fields(manifest, ["version", "configurations", "samples"], "manifest");
    if (manifest.version !== 1) throw new Error("Voice corpus version must be 1.");
    const configurations = manifest.configurations ?? DEFAULT_EVALUATIONS;
    if (!Array.isArray(configurations) || !configurations.length || configurations.length > 16) throw new Error("Use 1–16 configurations.");
    for (const config of configurations) {
        fields(config, ["id", "vadMode", "threshold", "score", "preprocessing"], "configuration");
        if (!identifier(config.id) || !Number.isInteger(config.vadMode) || config.vadMode < 0 || config.vadMode > 3
            || !Number.isFinite(config.threshold) || config.threshold <= 0 || config.threshold > 1
            || !Number.isFinite(config.score) || config.score <= 0 || config.score > 5
            || !Object.hasOwn(AUDIO_FILTERS, config.preprocessing)) throw new Error("Invalid evaluation configuration.");
    }
    if (configurations[0].preprocessing !== "raw") throw new Error("The first configuration must be the raw baseline.");
    if (new Set(configurations.map(({ id }) => id)).size !== configurations.length) throw new Error("Configuration IDs must be unique.");
    const { samples } = manifest;
    if (!Array.isArray(samples) || samples.length < 2 || samples.length > 200) throw new Error("Use 2–200 labelled samples.");
    for (const sample of samples) {
        fields(sample, ["id", "file", "source", "conditions", "expectedWake", "referenceText"], "sample");
        if (!identifier(sample.id) || typeof sample.file !== "string" || !sample.file.trim() || sample.file.length > 2048
            || !["recording", "synthetic"].includes(sample.source) || typeof sample.expectedWake !== "boolean"
            || !Array.isArray(sample.conditions) || !sample.conditions.length || sample.conditions.length > 8
            || sample.conditions.some((condition) => ![...LIVE_CONDITIONS, "near-miss", "speaker-echo", "other"].includes(condition))
            || (sample.referenceText !== undefined && (typeof sample.referenceText !== "string" || sample.referenceText.length > 1000))) {
            throw new Error("Invalid sample: require an ID, file, source, conditions, and boolean expectedWake; referenceText is optional.");
        }
    }
    if (new Set(samples.map(({ id }) => id)).size !== samples.length) throw new Error("Sample IDs must be unique.");
    if (!samples.some(({ expectedWake }) => expectedWake) || !samples.some(({ expectedWake }) => !expectedWake)) {
        throw new Error("Include both positive and negative recordings to measure misses and false wakes.");
    }
    return { version: 1, configurations, samples };
}

/** Word edit distance after the same leading-wake normalization as production STT. */
export function wordError(reference, hypothesis) {
    const words = (text) => normalizeTranscript(text).toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
    const expected = words(reference), actual = words(hypothesis);
    let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
    for (let i = 1; i <= expected.length; i++) {
        const row = [i];
        for (let j = 1; j <= actual.length; j++) {
            row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + Number(expected[i - 1] !== actual[j - 1]));
        }
        previous = row;
    }
    const edits = previous[actual.length];
    return { edits, referenceWords: expected.length, wer: expected.length ? edits / expected.length : null, exact: edits === 0 };
}

export function summarizeResults(rows) {
    const complete = rows.filter((row) => !row.error);
    const positives = complete.filter((row) => row.expectedWake), negatives = complete.filter((row) => !row.expectedWake);
    const falsePositives = negatives.filter((row) => row.detected).length;
    const falseNegatives = positives.filter((row) => !row.detected).length;
    const negativeSeconds = negatives.reduce((sum, row) => sum + (row.summary ? row.summary.analyzedMs / 1000 : row.audioSeconds), 0);
    const negativeKeywordHits = negatives.reduce((sum, row) => sum + row.hits.length, 0);
    const transcribed = rows.filter((row) => row.stt && !row.stt.error);
    const edits = transcribed.reduce((sum, row) => sum + row.stt.edits, 0);
    const referenceWords = transcribed.reduce((sum, row) => sum + row.stt.referenceWords, 0);
    const errors = rows.length - complete.length;
    const sttErrors = rows.filter((row) => row.stt?.error).length;
    const sttMismatches = transcribed.filter((row) => !row.stt.exact).length;
    return { samples: rows.length, testedPositives: positives.length, testedNegatives: negatives.length, errors,
        falsePositives, falseNegatives, recall: positives.length ? 1 - falseNegatives / positives.length : null,
        falsePositiveClipRate: negatives.length ? falsePositives / negatives.length : null,
        negativeSeconds, negativeKeywordHits, falseKeywordHitsPerHour: negativeSeconds ? negativeKeywordHits * 3600 / negativeSeconds : null,
        sttSamples: transcribed.length, sttErrors, sttMismatches, wordEdits: edits, referenceWords,
        wer: referenceWords ? edits / referenceWords : null,
        passed: rows.length > 0 && !errors && !falsePositives && !falseNegatives && !sttErrors && !sttMismatches };
}

export function compareToBaseline(baselineRows, candidateRows) {
    const byId = new Map(baselineRows.map((row) => [row.sampleId, row]));
    const recoveredWakes = [], regressedWakes = [], improvedTranscripts = [], regressedTranscripts = [];
    let pairedSamples = 0;
    for (const row of candidateRows) {
        const before = byId.get(row.sampleId);
        if (!before || before.error || row.error) continue;
        pairedSamples++;
        const wasCorrect = before.detected === before.expectedWake, isCorrect = row.detected === row.expectedWake;
        if (!wasCorrect && isCorrect) recoveredWakes.push(row.sampleId);
        if (wasCorrect && !isCorrect) regressedWakes.push(row.sampleId);
        if (before.stt && row.stt && !before.stt.error && !row.stt.error) {
            if (row.stt.edits < before.stt.edits) improvedTranscripts.push(row.sampleId);
            if (row.stt.edits > before.stt.edits) regressedTranscripts.push(row.sampleId);
        }
    }
    return { pairedSamples, recoveredWakes, regressedWakes, improvedTranscripts, regressedTranscripts };
}

/** Bounded sequential replay; each case owns fresh VAD/KWS state. No Discord connection or execution. */
export async function evaluateCorpus(samples, configurations, options = {}) {
    const results = [];
    const sttCache = new Map(); // Cache only text/metrics for the same sample + preprocessing, never audio.
    for (const config of configurations) {
        const createVad = await (options.createVad ?? createWebRtcVadFactory)(config.vadMode);
        const engine = await (options.createEngine ?? WakeEngine.create)(options.modelDirectory, config.threshold, config.score);
        try {
            for (const sample of samples) {
                const row = { configurationId: config.id, sampleId: sample.id, source: sample.source,
                    conditions: sample.conditions, expectedWake: sample.expectedWake };
                try {
                    const started = performance.now();
                    const pcm = preprocessAudio(sample.pcm, config.preprocessing);
                    row.preprocessingMs = performance.now() - started;
                    row.quality = audioQuality(pcm);
                    Object.assign(row, await replayWake(pcm, engine.createBackend, createVad));
                    // Deliberately evaluate labelled clips even after a wake miss to isolate STT quality.
                    // This is an explicit offline experiment; production remains session-gated.
                    if (options.transcribe && sample.referenceText !== undefined) {
                        const key = `${sample.id}/${config.preprocessing}`;
                        const reused = sttCache.has(key);
                        if (!reused) {
                            try {
                                if (pcm.length > 2_688_000) throw new Error("Reference-labelled STT clips must be no longer than 14 seconds.");
                                const transcription = await options.transcribe({ pcm, format: PCM_FORMAT, wake: { phrase: WAKE_PHRASE } });
                                sttCache.set(key, { ...wordError(sample.referenceText, transcription.text), text: transcription.text,
                                    referenceText: sample.referenceText, elapsedMs: transcription.elapsedMs,
                                    provider: transcription.provider, model: transcription.model });
                            } catch (error) { sttCache.set(key, { error: error instanceof Error ? error.message : "Local transcription failed." }); }
                        }
                        row.stt = { ...sttCache.get(key), reused };
                    }
                } catch (error) { row.error = error instanceof Error ? error.message : "Audio evaluation failed."; }
                results.push(row);
                options.onResult?.(row);
            }
        } finally { await engine.close(); }
    }
    const baselineRows = results.filter((row) => row.configurationId === configurations[0].id);
    const summaries = configurations.map((config) => {
        const rows = results.filter((row) => row.configurationId === config.id);
        const groups = new Set(rows.flatMap((row) => row.conditions.map((condition) => `${row.source}/${condition}`)));
        return { configuration: config, ...summarizeResults(rows), comparison: compareToBaseline(baselineRows, rows),
            byCondition: Object.fromEntries([...groups].map((key) => [key, summarizeResults(rows.filter((row) =>
                row.conditions.some((condition) => `${row.source}/${condition}` === key)))])) };
    });
    const missingLiveConditions = LIVE_CONDITIONS.filter((condition) => !samples.some((sample) =>
        sample.source === "recording" && sample.conditions.includes(condition)));
    return { results, summaries, missingLiveConditions };
}

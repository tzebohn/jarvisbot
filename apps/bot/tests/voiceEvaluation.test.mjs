import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { audioQuality, decodeWav, preprocessAudio, opusRoundTrip, validatePcm } from "../scripts/voice-audio.mjs";
import { mixAtSnr, noisePcm } from "../scripts/voice-synthetic.mjs";
import { validateManifest, DEFAULT_EVALUATIONS, wordError, summarizeResults, compareToBaseline, evaluateCorpus } from "../scripts/voice-evaluation.mjs";
import { replayWake } from "../scripts/wake-replay.mjs";
import { pcmToWav } from "../src/voice/receive/wav.ts";
import { wakeModelPaths } from "../src/voice/wake/wakeModel.ts";

function tone(ms = 200, frequency = 1000, amplitude = 2000) {
    const pcm = Buffer.alloc(ms * 192);
    for (let i = 0; i < pcm.length / 4; i++) {
        const value = Math.round(amplitude * Math.sin(2 * Math.PI * frequency * i / 48_000));
        pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2);
    }
    return pcm;
}

const baseline = DEFAULT_EVALUATIONS[0];
const sample = (id, expectedWake) => ({ id, file: `${id}.wav`, source: "recording", conditions: ["quiet", "headphones"], expectedWake });
const corpus = () => ({ version: 1, samples: [sample("wake", true), sample("chat", false)] });

test("corpus labels require a raw baseline and both wake and non-wake exposure; typoed tuning fails early", async () => {
    assert.equal(validateManifest(corpus()).configurations.length, 7);
    validateManifest(JSON.parse(await readFile(new URL("../scripts/voice-corpus.example.json", import.meta.url), "utf8")));
    for (const invalid of [
        { ...corpus(), version: 2 }, { ...corpus(), samples: [sample("wake", true), sample("wake2", true)] },
        { ...corpus(), samples: [sample("same", true), sample("same", false)] },
        { ...corpus(), samples: [sample("yes", "true"), sample("no", false)] },
        { ...corpus(), configurations: [{ ...baseline, threshold: 0 }] },
        { ...corpus(), configurations: [{ ...baseline, score: 6 }] },
        { ...corpus(), configurations: [{ ...baseline, vadMode: 4 }] },
        { ...corpus(), configurations: [{ ...baseline, preprocessing: "denoise" }] },
        { ...corpus(), configurations: [baseline, { ...baseline, id: "bad", preprocessing: "custom" }] },
        { ...corpus(), configurations: [{ ...baseline, threhsold: 0.2 }] },
        { ...corpus(), configurations: [baseline, baseline] },
    ]) assert.throws(() => validateManifest(invalid));
});

test("signal metrics expose silence, clipped channels and destructive stereo downmix without modifying audio", () => {
    const silent = Buffer.alloc(3840);
    assert.equal(audioQuality(silent).mono.rmsDbfs, null);
    const pcm = Buffer.alloc(3840);
    for (let i = 0; i < pcm.length; i += 4) { pcm.writeInt16LE(32767, i); pcm.writeInt16LE(-32768, i + 2); }
    const original = Buffer.from(pcm);
    const quality = audioQuality(pcm);
    assert.equal(quality.durationMs, 20);
    assert.equal(quality.left.clippedFraction, 1);
    assert.equal(quality.right.clippedFraction, 1);
    assert.equal(quality.right.dcOffset, -1);
    assert.equal(quality.mono.peak, 0, "production downmix rounds the opposing channels to zero");
    assert.equal(quality.mono.rmsDbfs, null);
    assert.deepEqual(pcm, original);
    assert.throws(() => validatePcm(Buffer.alloc(3841)), /never silently truncated/);
    assert.throws(() => validatePcm(Buffer.alloc(0)), /20 ms/);
});

test("real FFmpeg comparisons preserve format, stereo ownership, length and speech-band energy", () => {
    const pcm = tone(300);
    for (let i = 0; i < pcm.length; i += 4) pcm.writeInt16LE(-pcm.readInt16LE(i), i + 2);
    const original = Buffer.from(pcm);
    assert.equal(preprocessAudio(pcm, "raw"), pcm);
    assert.deepEqual(decodeWav(pcmToWav(pcm)), pcm);
    const low = tone(300, 20);
    const filteredLow = preprocessAudio(low, "highpass");
    assert.ok(audioQuality(filteredLow).left.rmsDbfs < audioQuality(low).left.rmsDbfs - 15, "attenuate low-frequency rumble");
    const highpass = preprocessAudio(pcm, "highpass");
    assert.ok(Math.abs(audioQuality(highpass).left.rmsDbfs - audioQuality(pcm).left.rmsDbfs) < 1, "retain 1 kHz energy");
    for (const mode of ["highpass", "denoise"]) {
        const processed = preprocessAudio(pcm, mode);
        assert.equal(processed.length, pcm.length);
        assert.ok(audioQuality(processed).left.peak > 0);
        assert.ok(audioQuality(processed).mono.peak < 0.001, "filters do not merge independent stereo channels");
        const silent = Buffer.alloc(3840 * 3);
        assert.deepEqual(preprocessAudio(silent, mode), silent);
    }
    assert.deepEqual(pcm, original);
    assert.equal(opusRoundTrip(tone(21)).length, 21 * 192, "codec tail padding cannot inflate exposure duration");
    assert.throws(() => decodeWav(Buffer.from("not a WAV")), /diagnostic audio/);
    assert.throws(() => decodeWav(pcmToWav(Buffer.alloc(60_020 * 192))), /never silently truncated/);
});

test("seeded noise mixing gives paired, repeatable 15 dB clip-level SNR without mutating the source", () => {
    const pcm = tone(300), original = Buffer.from(pcm);
    for (const kind of ["keyboard", "fan", "hiss"]) {
        const noise = noisePcm(kind, pcm.length / 4);
        assert.deepEqual(noise, noisePcm(kind, pcm.length / 4));
        const mixed = mixAtSnr(pcm, noise, 15);
        let speechEnergy = 0, noiseEnergy = 0;
        for (let i = 0; i < pcm.length; i += 2) {
            speechEnergy += pcm.readInt16LE(i) ** 2;
            noiseEnergy += (mixed.readInt16LE(i) - pcm.readInt16LE(i)) ** 2;
        }
        assert.ok(Math.abs(10 * Math.log10(speechEnergy / noiseEnergy) - 15) < 0.02);
    }
    assert.deepEqual(pcm, original);
});

test("transcript metrics count substitutions, deletions, insertions and wake-only hallucinations", () => {
    assert.deepEqual(wordError("Jarvis, play Numb by Linkin Park!", "PLAY numb by linkin park"),
        { edits: 0, referenceWords: 5, wer: 0, exact: true });
    assert.equal(wordError("play Numb by Linkin Park", "play Num by Linkin Park").edits, 1);
    assert.equal(wordError("play Numb", "play").edits, 1);
    assert.equal(wordError("pause", "pause the music").edits, 2);
    assert.deepEqual(wordError("Jarvis", "play"), { edits: 1, referenceWords: 0, wer: null, exact: false });
    assert.equal(wordError("Jarvis", "Hey Jarvis").exact, true);
});

test("reports count false-wake clips and all native hits separately, keep errors out of successful exposure", () => {
    const rows = [
        { sampleId: "a", expectedWake: true, detected: false, hits: [], audioSeconds: 2 },
        { sampleId: "b", expectedWake: false, detected: true, hits: [{}, {}], audioSeconds: 10 },
        { sampleId: "c", expectedWake: false, detected: false, hits: [], audioSeconds: 10.019, summary: { analyzedMs: 10000 } },
        { sampleId: "d", expectedWake: false, error: "worker failure" },
    ];
    const summary = summarizeResults(rows);
    assert.equal(summary.falsePositives, 1);
    assert.equal(summary.falseNegatives, 1);
    assert.equal(summary.negativeSeconds, 20);
    assert.equal(summary.negativeKeywordHits, 2);
    assert.equal(summary.falseKeywordHitsPerHour, 360);
    assert.equal(summary.errors, 1);
    assert.equal(summary.passed, false);
    assert.equal(summarizeResults([]).passed, false);
    const candidate = rows.map((row) => ({ ...row, detected: row.sampleId === "a" || row.sampleId === "c" }));
    const comparison = compareToBaseline(rows, candidate);
    assert.deepEqual(comparison.recoveredWakes, ["a", "b"]);
    assert.deepEqual(comparison.regressedWakes, ["c"]);
    assert.equal(comparison.pairedSamples, 3);
});

test("shared replay uses onset context once, flushes final results, and always disposes its detectors", async () => {
    const received = [], hits = [{ keyword: "JARVIS_RHOTIC_IH" }];
    const backend = { accept: mock.fn(async (audio, final) => { received.push(...audio); return final ? hits : []; }), destroy: mock.fn() };
    let frame = 0;
    const vad = { isSpeech: () => ++frame === 4, destroy: mock.fn() };
    const result = await replayWake(tone(120), () => backend, () => vad);
    assert.equal(received.length, 120 * 48);
    assert.equal(result.summary.inputStartMs, 0);
    assert.equal(result.summary.reason, "stream-end");
    assert.equal(result.hits[0].pronunciationId, "rhotic-ih");
    assert.equal(vad.destroy.mock.callCount(), 1);
    assert.equal(backend.destroy.mock.callCount(), 1);
    const broken = { accept: async () => { throw new Error("failed inference"); }, destroy: mock.fn() };
    const secondVad = { isSpeech: () => true, destroy: mock.fn() };
    await assert.rejects(replayWake(tone(), () => broken, () => secondVad), /failed inference/);
    assert.equal(secondVad.destroy.mock.callCount(), 1);
    assert.equal(broken.destroy.mock.callCount(), 1);
});

test("evaluation isolates cases, runs only explicit STT references, reuses identical STT work and closes engines", async () => {
    const calls = [], engines = [], detectors = [];
    const createEngine = async (directory, threshold, score) => {
        calls.push({ directory, threshold, score });
        const engine = { createBackend: () => ({ accept: async () => [], destroy() {} }), close: mock.fn() };
        engines.push(engine);
        return engine;
    };
    const createVad = async () => () => {
        const detector = { isSpeech: () => false, destroy: mock.fn() };
        detectors.push(detector); return detector;
    };
    const transcribe = mock.fn(async () => ({ text: "play Num", provider: "faster-whisper", model: "small.en", elapsedMs: 10 }));
    const positive = { ...sample("positive", true), pcm: tone(), referenceText: "play Numb" };
    const negative = { ...sample("negative", false), pcm: Buffer.alloc(3840) };
    const report = await evaluateCorpus([positive, negative], [baseline, { ...baseline, id: "sensitive", threshold: 0.2 }],
        { createEngine, createVad, transcribe, modelDirectory: "fixture" });
    assert.equal(report.results.length, 4);
    assert.equal(transcribe.mock.callCount(), 1, "labelled full-clip STT is evaluated even though KWS missed, then reused for threshold-only tuning");
    assert.equal(report.results[2].stt.reused, true);
    assert.equal(report.summaries[0].falseNegatives, 1);
    assert.equal(report.summaries[0].wer, 0.5);
    assert.equal(report.summaries[0].sttMismatches, 1);
    assert.equal(report.summaries[0].byCondition["recording/quiet"].samples, 2);
    assert.ok(report.missingLiveConditions.includes("fan"));
    assert.ok(!report.missingLiveConditions.includes("headphones"));
    assert.deepEqual(calls, [{ directory: "fixture", threshold: 0.25, score: 1.5 }, { directory: "fixture", threshold: 0.2, score: 1.5 }]);
    assert.ok(engines.every((engine) => engine.close.mock.callCount() === 1));
    assert.equal(detectors.length, 4);
    assert.ok(detectors.every((detector) => detector.destroy.mock.callCount() === 1));
});

test("STT/preprocessing failures stay visible and report-handler errors still close the worker", async () => {
    const engine = { createBackend: () => { throw new Error("unexpected inference"); }, close: mock.fn() };
    const options = { createEngine: async () => engine,
        createVad: async () => () => ({ isSpeech: () => false, destroy() {} }),
        transcribe: async () => { throw new Error("missing local model"); } };
    const positive = { ...sample("wake", true), pcm: tone(), referenceText: "pause" };
    const broken = { ...sample("chat", false), pcm: Buffer.alloc(1) };
    const report = await evaluateCorpus([positive, broken], [baseline], options);
    assert.equal(report.summaries[0].errors, 1);
    assert.equal(report.summaries[0].sttErrors, 1);
    assert.equal(report.summaries[0].sttSamples, 0);
    assert.equal(report.summaries[0].passed, false);
    await assert.rejects(evaluateCorpus([positive], [baseline], { ...options, onResult: () => { throw new Error("report failed"); } }), /report failed/);
    assert.equal(engine.close.mock.callCount(), 2);
});

test("manifest CLI resolves relative WAV paths, writes a reproducible report and exits nonzero for a real-model miss", async (context) => {
    try { await stat(wakeModelPaths().encoder); }
    catch (error) {
        if (error.code === "ENOENT") { context.skip("Run setup:wake for native corpus replay"); return; }
        throw error;
    }
    const directory = await mkdtemp(join(tmpdir(), "voice-corpus-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "silence sample.wav"), pcmToWav(Buffer.alloc(19200)));
    const manifest = { version: 1, configurations: [baseline], samples: [true, false].map((expectedWake, index) =>
        ({ ...sample(`case-${index}`, expectedWake), source: "synthetic", file: "silence sample.wav" })) };
    await writeFile(join(directory, "corpus.json"), JSON.stringify(manifest));
    const output = join(directory, "report.json");
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/diagnose-voice.mjs", "--manifest",
        join(directory, "corpus.json"), "--output", output], { cwd: new URL("../", import.meta.url),
        encoding: "utf8", timeout: 30_000, env: { ...process.env, VOICE_WAKE_MODEL_DIR: "", VOICE_STT_MODE: "auto", GROQ_API_KEY: "unused" } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.stt, "off", "bot auto mode must not enable diagnostic cloud transcription");
    assert.equal(report.summaries[0].errors, 0);
    assert.equal(report.summaries[0].falseNegatives, 1);
    assert.equal(report.summaries[0].testedNegatives, 1);
    assert.equal(report.summaries[0].negativeSeconds, 0.1);
    assert.ok(report.results.every((row) => row.summary.outcome === "vad-gate-never-opened"));
    assert.equal(report.corpus[0].sha256, report.corpus[1].sha256);
    assert.match(report.modelFilesSha256.keywords, /^[a-f0-9]{64}$/);
    assert.equal(report.missingLiveConditions.length, 7, "synthetic labels cannot satisfy live acceptance");
});

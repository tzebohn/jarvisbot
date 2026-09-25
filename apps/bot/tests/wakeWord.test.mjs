import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { AudioBuffer } from "../src/voice/processing/AudioBuffer.ts";
import { WakeWordDetector, stereoToMono } from "../src/voice/wake/WakeWordDetector.ts";
import { WAKE_KEYWORD, WAKE_PRONUNCIATIONS } from "../src/voice/wake/wakeModel.ts";

function fixture(context, value = 2000, options = {}) {
    const ring = new AudioBuffer(2000);
    const hits = [];
    const errors = [];
    const backend = { accept: mock.fn(async () => []), destroy: mock.fn() };
    const factory = mock.fn(() => backend);
    const detector = new WakeWordDetector(factory, () => ring.snapshot(), (event) => hits.push(event), (error) => errors.push(error), options);
    let audioTimeMs = 0;
    const feed = (speaking = true, voice = speaking, frameValue = value) => {
        const pcm = Buffer.alloc(3840);
        for (let index = 0; index < pcm.length; index += 2) pcm.writeInt16LE(frameValue, index);
        ring.append(pcm);
        audioTimeMs += 20;
        const mono = new Int16Array(960).fill(frameValue);
        detector.process({ pcm, mono, isVoice: voice, isSpeaking: speaking, audioTimeMs });
        return { pcm, mono };
    };
    context.after(() => detector.destroy());
    return { ring, hits, errors, backend, factory, detector, feed };
}

test("wake conversion averages only a speaker's own stereo channels and scales signed s16le correctly", () => {
    const pcm = Buffer.alloc(12);
    pcm.writeInt16LE(-32768, 0); pcm.writeInt16LE(-32768, 2);
    pcm.writeInt16LE(32767, 4); pcm.writeInt16LE(32767, 6);
    pcm.writeInt16LE(2000, 8); pcm.writeInt16LE(-1000, 10);
    assert.deepEqual(stereoToMono(pcm), Float32Array.from([-1, 32767 / 32768, 500 / 32768]));
    assert.throws(() => stereoToMono(Buffer.alloc(3)), /whole stereo/);
});

test("the reported 100 ms onset / 3 second trace submits the beginning and all later audio exactly once", async (context) => {
    const f = fixture(context);
    for (let index = 0; index < 150; index++) {
        f.feed(index >= 8, index >= 4 && index < 132 && index !== 25, index + 1);
        await f.detector.whenIdle();
    }
    await f.detector.finish();
    const summary = await f.detector.result;
    assert.equal(summary.inputStartMs, 0);
    assert.equal(summary.analyzedMs, 3000);
    assert.equal(summary.voicedMs, 2540);
    assert.equal(summary.requests, 147);
    assert.equal(summary.submittedAudioMs, 3000);
    assert.equal(summary.completedAudioMs, 3000);
    assert.equal(summary.outcome, "no-keyword-returned");
    assert.equal(summary.reason, "stream-end");
    let offset = 0;
    for (const call of f.backend.accept.mock.calls) {
        for (const sample of call.arguments[0]) {
            assert.equal(sample, (Math.floor(offset / 960) + 1) / 32768, "no onset clipping, duplication, or frame reordering");
            offset++;
        }
    }
    assert.equal(offset, 144_000);
    assert.equal(f.backend.accept.mock.calls.at(-1).arguments[1], true);
});

test("completion summaries settle on cancellation and distinguish submitted from completed input", async (context) => {
    const f = fixture(context);
    let resolve;
    f.backend.accept.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    f.feed();
    await Promise.resolve();
    f.detector.destroy("cancelled");
    const summary = await f.detector.result;
    assert.equal(summary.reason, "cancelled");
    assert.equal(summary.submittedAudioMs, 20);
    assert.equal(summary.completedAudioMs, 0);
    resolve([]);
    await f.detector.whenIdle();
});

test("fragmented VAD voice admits a whole phrase even without a confirmed speech segment", async (context) => {
    const f = fixture(context);
    for (let index = 0; index < 40; index++) f.feed(false);
    f.feed(false, true);
    await f.detector.whenIdle();
    assert.equal(f.factory.mock.callCount(), 1);
    assert.equal(f.backend.accept.mock.calls[0].arguments[0].length, 41 * 960, "recover Hey before a late VAD decision, beyond the old 500 ms prefix");
    for (let index = 0; index < 10; index++) f.feed(false, index % 2 === 0);
    await f.detector.whenIdle();
    assert.equal(f.factory.mock.callCount(), 1, "never reset keyword state at individual VAD-negative frames");
    const legacy = fixture(context, 2000, { gate: "segment" });
    for (let index = 0; index < 50; index++) legacy.feed(false, index % 2 === 0);
    assert.equal(legacy.factory.mock.callCount(), 0, "segment admission reproduces the old false-negative path");
});

test("delivery includes audio that arrived during inference and maps keyword timestamps to the receive clock", async (context) => {
    const f = fixture(context);
    for (let index = 0; index < 60; index++) f.feed(false);
    let resolve;
    f.backend.accept.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    f.feed();
    await Promise.resolve();
    for (let index = 0; index < 10; index++) f.feed();
    resolve([{ keyword: WAKE_KEYWORD, keywordStartMs: 300, keywordEndMs: 700 }]);
    await f.detector.whenIdle();
    const event = f.hits[0];
    assert.equal(event.processedAudioTimeMs, 1220);
    assert.equal(event.audioTimeMs, 1420);
    assert.equal(event.preRoll.length, 71 * 3840);
    assert.equal(event.preRollStartMs, 0);
    assert.equal(event.keywordStartMs, 520);
    assert.equal(event.keywordEndMs, 920);
});

test("resume watermark excludes paused-session audio from inference and activation pre-roll", async (context) => {
    const f = fixture(context, 2000, { minimumAudioTimeMs: 1000 });
    for (let index = 0; index < 50; index++) f.feed(false);
    f.backend.accept.mock.mockImplementationOnce(async () => [{ keyword: WAKE_KEYWORD }]);
    f.feed();
    await f.detector.whenIdle();
    assert.equal(f.backend.accept.mock.calls[0].arguments[0].length, 960);
    assert.equal(f.hits[0].preRollStartMs, 1000);
    assert.equal(f.hits[0].preRoll.length, 3840);
});

test("diagnostics distinguish no voice from examined audio with no keyword, without invented transcripts/confidence", async (context) => {
    for (const speech of [false, true]) {
        const logs = [];
        const f = fixture(context, 2000, { onDiagnostic: (event, details) => logs.push({ event, ...details }) });
        for (let index = 0; index < 150; index++) { f.feed(speech); await f.detector.whenIdle(); }
        await f.detector.finish();
        const summary = logs.find((log) => log.event === "summary");
        assert.equal(summary.outcome, speech ? "no-keyword-returned" : "vad-gate-never-opened");
        assert.equal(summary.voicedMs, speech ? 3000 : 0);
        assert.ok(logs.length < 10, "logging is bounded, not per frame");
        assert.ok(logs.every((log) => log.transcript === undefined && log.confidence === undefined));
    }
});

test("VAD gates model allocation, recovers onset audio once, and silence never opens an inference stream", async (context) => {
    const f = fixture(context);
    for (let index = 0; index < 20; index++) f.feed(false);
    assert.equal(f.factory.mock.callCount(), 0);
    f.feed(true);
    await f.detector.whenIdle();
    assert.equal(f.backend.accept.mock.calls[0].arguments[0].length, 21 * 960);
    f.feed(true);
    await f.detector.whenIdle();
    assert.equal(f.backend.accept.mock.calls[1].arguments[0].length, 960, "pre-roll must not be fed twice");
    await f.detector.finish();
    assert.equal(f.backend.accept.mock.calls.at(-1).arguments[1], true);
    assert.equal(f.backend.destroy.mock.callCount(), 1);
    assert.deepEqual(f.errors, []);
});

test("only the complete configured phrase triggers, with an immutable bounded stereo snapshot", async (context) => {
    const f = fixture(context);
    for (let index = 0; index < 120; index++) f.feed(false);
    f.backend.accept.mock.mockImplementationOnce(async () => ["JAR", "VIS", "JERVIS", "JARVIS_UNKNOWN", "jarvis",
        "JARVIS_NON_RHOTIC_SCHWA", "JARVIS_NON_RHOTIC_IH", "JARVIS_FRONTED_RHOTIC"].map((keyword) => ({ keyword })));
    f.feed();
    await f.detector.whenIdle();
    assert.equal(f.hits.length, 0);
    f.backend.accept.mock.mockImplementationOnce(async () => [{ keyword: WAKE_KEYWORD }]);
    const input = f.feed();
    input.mono.fill(0);
    input.pcm.fill(0);
    await f.detector.whenIdle();
    assert.equal(f.hits.length, 1);
    assert.equal(f.hits[0].phrase, "Jarvis");
    assert.equal(f.hits[0].preRoll.length, 384_000);
    assert.equal(f.hits[0].preRoll.readInt16LE(0), 2000);
    assert.equal(f.hits[0].format.channels, 2);
    assert.equal(f.hits[0].confidence, undefined);
    assert.ok(f.backend.accept.mock.calls.at(-1).arguments[0].every((sample) => sample === 2000 / 32768));
    f.ring.clear();
    assert.equal(f.hits[0].preRoll.length, 384_000);
});

for (const pronunciation of WAKE_PRONUNCIATIONS) {
    test(`${pronunciation.id} reports the same Jarvis activation with path diagnostics and unchanged PCM`, async (context) => {
        const logs = [];
        const f = fixture(context, 1000, { onDiagnostic: (event, details) => logs.push({ event, ...details }) });
        f.backend.accept.mock.mockImplementationOnce(async () => [{ keyword: pronunciation.keyword,
            tokens: [...pronunciation.tokens], keywordStartMs: 0, keywordEndMs: 20 }]);
        f.feed();
        await f.detector.whenIdle();
        assert.equal(f.hits.length, 1);
        assert.equal(f.hits[0].phrase, "Jarvis");
        assert.equal(f.hits[0].pronunciationId, pronunciation.id);
        assert.equal(f.hits[0].preRoll.length, 3840);
        assert.equal(f.hits[0].preRoll.readInt16LE(0), 1000);
        assert.equal(f.hits[0].keywordStartMs, 0);
        assert.equal(f.hits[0].keywordEndMs, 20);
        const candidate = logs.find((entry) => entry.event === "candidate");
        assert.equal(candidate.pronunciationId, pronunciation.id);
        assert.equal(candidate.accepted, true);
        assert.deepEqual(candidate.configuredTokens, pronunciation.tokens);
        assert.equal(candidate.confidence, null);
    });
}

test("independent speakers cannot combine partial wake phrases or PCM buffers", async (context) => {
    const alice = fixture(context, 1000);
    const bob = fixture(context, -2000);
    alice.backend.accept.mock.mockImplementation(async () => [{ keyword: "JAR" }]);
    bob.backend.accept.mock.mockImplementation(async () => [{ keyword: "VIS" }]);
    alice.feed(); bob.feed();
    await Promise.all([alice.detector.whenIdle(), bob.detector.whenIdle()]);
    assert.equal(alice.hits.length + bob.hits.length, 0);
    alice.backend.accept.mock.mockImplementationOnce(async () => [{ keyword: WAKE_KEYWORD }]);
    alice.feed();
    await alice.detector.whenIdle();
    assert.equal(alice.hits[0].preRoll.readInt16LE(0), 1000);
    assert.equal(bob.hits.length, 0);
    assert.equal(bob.backend.destroy.mock.callCount(), 0);
});

test("natural end flushes a delayed detection after VAD buffers have been released", async (context) => {
    const f = fixture(context);
    f.backend.accept.mock.mockImplementation(async (_audio, final) => final ? [{ keyword: WAKE_KEYWORD }] : []);
    f.feed();
    const finished = f.detector.finish();
    f.ring.clear();
    await finished;
    assert.equal(f.hits.length, 1);
    assert.equal(f.hits[0].preRoll.length, 3840);
    assert.equal(f.backend.destroy.mock.callCount(), 1);
});

test("disconnect cancels an in-flight detection without a late wake or error", async (context) => {
    const f = fixture(context);
    let resolve;
    f.backend.accept.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    f.feed();
    await Promise.resolve();
    f.detector.destroy();
    resolve([{ keyword: WAKE_KEYWORD }]);
    await f.detector.whenIdle();
    assert.deepEqual(f.hits, []);
    assert.deepEqual(f.errors, []);
    assert.equal(f.backend.destroy.mock.callCount(), 1);
});

test("slow inference is bounded and disables only the overloaded detector", async (context) => {
    const f = fixture(context);
    let resolve;
    f.backend.accept.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    f.feed();
    await Promise.resolve();
    for (let index = 0; index < 150; index++) f.feed();
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0].message, /fell behind/);
    assert.equal(f.backend.destroy.mock.callCount(), 1);
    resolve([{ keyword: WAKE_KEYWORD }]);
    await f.detector.whenIdle();
    assert.equal(f.hits.length, 0);
});

test("backend failures settle without unhandled rejection and release their stream", async (context) => {
    const f = fixture(context);
    f.backend.accept.mock.mockImplementationOnce(async () => { throw new Error("worker failed"); });
    f.feed();
    await f.detector.finish();
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0].message, /worker failed/);
    assert.equal(f.backend.destroy.mock.callCount(), 1);
});

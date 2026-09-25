import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { AudioBuffer } from "../src/voice/processing/AudioBuffer.ts";
import { VoiceActivityDetector } from "../src/voice/processing/VoiceActivityDetector.ts";
import { createWebRtcVadFactory, VAD_FRAME_SAMPLES } from "../src/voice/processing/WebRtcVad.ts";

function frame(left = 0, right = left) {
    const pcm = Buffer.alloc(3840);
    for (let sample = 0; sample < 960; sample++) {
        pcm.writeInt16LE(left, sample * 4);
        pcm.writeInt16LE(right, sample * 4 + 2);
    }
    return pcm;
}

function setup(context, options = {}) {
    const events = [];
    const backend = { isSpeech: mock.fn((mono) => mono[0] > 0), destroy: mock.fn() };
    const activity = new VoiceActivityDetector(backend, { ...options, onEvent: (event) => events.push(event) });
    context.after(() => activity.destroy());
    return { activity, backend, events };
}

test("rolling PCM retains only its bounded chronological tail and snapshots cannot alter it", () => {
    const buffer = new AudioBuffer(40);
    const a = frame(100);
    const b = frame(200);
    const c = frame(300);
    buffer.append(a);
    const snapshot = buffer.snapshot();
    buffer.append(b);
    buffer.append(c);
    assert.deepEqual(buffer.snapshot(), Buffer.concat([b, c]));
    assert.deepEqual(snapshot, a);
    assert.equal(buffer.size, buffer.capacity);
    assert.equal(buffer.durationMs, 40);
    buffer.snapshot().fill(0);
    assert.deepEqual(buffer.snapshot(), Buffer.concat([b, c]));
    buffer.append(Buffer.concat([c, b, a]));
    assert.deepEqual(buffer.snapshot(), Buffer.concat([b, a]));
    buffer.clear();
    assert.equal(buffer.size, 0);
    buffer.append(c);
    assert.deepEqual(buffer.snapshot(), c);
    assert.throws(() => buffer.append(Buffer.alloc(3)), /whole stereo sample/);
    assert.throws(() => new AudioBuffer(10_001), /duration/);
});

test("arbitrary PCM chunk boundaries produce exact mono frames while retaining original stereo PCM", (context) => {
    const { activity, backend } = setup(context);
    const input = Buffer.concat([frame(3000, -1000), frame(-1000, -3000), frame(32767, -32768)]);
    const received = [];
    backend.isSpeech.mock.mockImplementation((mono) => { received.push(Int16Array.from(mono)); return false; });
    const splits = [1, 17, 3800, 3921, 7013, input.length];
    let start = 0;
    for (const end of splits) {
        activity.process(input.subarray(start, end));
        start = end;
    }
    assert.equal(received.length, 3);
    assert.ok(received[0].every((sample) => sample === 1000));
    assert.ok(received[1].every((sample) => sample === -2000));
    assert.ok(received[2].every((sample) => sample === 0));
    assert.ok(received.every((mono) => mono.length === 960));
    assert.deepEqual(activity.recentAudio, input);
    assert.equal(activity.summary.processedMs, 60);
    activity.process(Buffer.alloc(11));
    assert.equal(activity.summary.processedMs, 60, "a partial frame must not be padded into fake speech");
    activity.destroy();
    assert.equal(activity.recentAudio.length, 0);
    assert.equal(backend.destroy.mock.callCount(), 1);
});

test("speech hysteresis rejects brief detections, bridges short pauses, and ends after sustained non-speech", (context) => {
    const { activity, events } = setup(context);
    const feed = (voice, count) => { for (let i = 0; i < count; i++) activity.process(frame(voice ? 1000 : 0)); };
    feed(false, 20);
    feed(true, 4); // 80 ms: below the 100 ms onset requirement.
    feed(false, 1);
    assert.deepEqual(events, []);
    feed(true, 5);
    assert.equal(activity.isSpeaking, true);
    assert.deepEqual(events[0], { type: "speech-start", audioTimeMs: 500, durationMs: 0 });
    feed(false, 3);
    feed(true, 3);
    assert.equal(events.length, 1, "a short pause must not split speech");
    feed(false, 29);
    assert.equal(activity.isSpeaking, true);
    feed(false, 1);
    assert.equal(activity.isSpeaking, false);
    assert.deepEqual(events[1], { type: "speech-end", audioTimeMs: 720, durationMs: 220, reason: "silence" });
    feed(true, 60);
    assert.equal(activity.summary.speechSegments, 2);
    assert.ok(events.some((event) => event.type === "speech-active"));
    activity.destroy("stream-end");
    assert.equal(events.at(-1).type, "speech-end");
    assert.equal(events.at(-1).reason, "stream-end");
});

test("simultaneous speaker processors never share buffers, thresholds, or classifier state", (context) => {
    const alice = setup(context);
    const bob = setup(context);
    for (let index = 0; index < 10; index++) {
        alice.activity.process(frame(1000));
        bob.activity.process(frame(-2000));
    }
    assert.equal(alice.activity.isSpeaking, true);
    assert.equal(bob.activity.isSpeaking, false);
    assert.equal(alice.events[0].type, "speech-start");
    assert.deepEqual(bob.events, []);
    assert.deepEqual(alice.activity.recentAudio, Buffer.concat(Array(10).fill(frame(1000))));
    assert.deepEqual(bob.activity.recentAudio, Buffer.concat(Array(10).fill(frame(-2000))));
    alice.activity.destroy();
    assert.equal(alice.activity.recentAudio.length, 0);
    assert.equal(bob.activity.recentAudio.length, 10 * 3840);
    assert.equal(bob.backend.destroy.mock.callCount(), 0);
});

test("long-running audio stays bounded and disposal releases classifier state exactly once", (context) => {
    const { activity, backend } = setup(context);
    const silence = frame();
    for (let count = 0; count < 10_000; count++) activity.process(silence);
    assert.equal(activity.recentAudio.length, 192_000);
    assert.equal(activity.summary.bufferedMs, 1000);
    assert.equal(activity.summary.processedMs, 200_000);
    assert.equal(activity.summary.voicedMs, 0);
    assert.equal(activity.summary.speechSegments, 0);
    activity.destroy();
    activity.destroy();
    assert.equal(backend.destroy.mock.callCount(), 1);
    assert.equal(activity.summary.bufferedMs, 0);
    assert.throws(() => activity.process(silence), /stopped/);
});

test("invalid speech-processing configuration releases an already allocated backend", () => {
    for (const options of [{ startMs: 0 }, { startMs: 31 }, { endSilenceMs: 6001 }, { bufferMs: Infinity }]) {
        const backend = { isSpeech: mock.fn(), destroy: mock.fn() };
        assert.throws(() => new VoiceActivityDetector(backend, options));
        assert.equal(backend.destroy.mock.callCount(), 1);
    }
});

test("real WebRTC WASM rejects silence/quiet noise, reacts to voice-like audio, and frees its instances", async () => {
    const create = await createWebRtcVadFactory(2);
    const silence = create();
    const voiced = create();
    let seed = 12345;
    let voiceFrames = 0;
    try {
        for (let frameIndex = 0; frameIndex < 100; frameIndex++) {
            assert.equal(silence.isSpeech(new Int16Array(VAD_FRAME_SAMPLES)), false);
            const noise = new Int16Array(VAD_FRAME_SAMPLES);
            const signal = new Int16Array(VAD_FRAME_SAMPLES);
            for (let i = 0; i < VAD_FRAME_SAMPLES; i++) {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                noise[i] = (seed % 17) - 8;
                const time = (frameIndex * VAD_FRAME_SAMPLES + i) / 48_000;
                const amplitude = 6000 * (0.6 + 0.4 * Math.sin(time * 2 * Math.PI * 3));
                signal[i] = Math.round(amplitude * (Math.sin(2 * Math.PI * 140 * time)
                    + 0.4 * Math.sin(2 * Math.PI * 280 * time) + 0.2 * Math.sin(2 * Math.PI * 700 * time)));
            }
            assert.equal(silence.isSpeech(noise), false);
            if (voiced.isSpeech(signal)) voiceFrames++;
        }
        assert.ok(voiceFrames > 0, "VAD must not be a detector that always returns silence");
        assert.throws(() => voiced.isSpeech(new Int16Array(100)), /20 ms/);
    } finally {
        silence.destroy();
        voiced.destroy();
    }
    silence.destroy();
    assert.throws(() => silence.isSpeech(new Int16Array(960)), /destroyed/);
    await assert.rejects(createWebRtcVadFactory(4), /mode/);
});

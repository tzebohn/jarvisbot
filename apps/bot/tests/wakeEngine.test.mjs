import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import { WakeEngine } from "../src/voice/wake/WakeEngine.ts";
import { wakeModelPaths, WAKE_TOKENS, WAKE_PRONUNCIATIONS } from "../src/voice/wake/wakeModel.ts";
import { createPhonemeProbe } from "../scripts/wake-phonemes.mjs";

const installed = await Promise.all(Object.values(wakeModelPaths()).map((path) => access(path))).then(() => true, () => false);

test("invalid wake tuning fails before model/native initialization", async () => {
    for (const threshold of [0, -1, 1.1, NaN]) await assert.rejects(WakeEngine.create(undefined, threshold), /THRESHOLD/);
    for (const score of [0, 6, NaN]) await assert.rejects(WakeEngine.create(undefined, 0.25, score), /SCORE/);
});

test("native diagnostics distinguish accepted audio, resampled audio, final padding, and actual decoder work", {
    skip: installed ? false : "Run setup:wake for native diagnostics", timeout: 30_000,
}, async () => {
    const engine = await WakeEngine.create();
    const backend = engine.createBackend();
    try {
        assert.equal(backend.getDiagnostics(), undefined);
        for (let index = 0; index < 150; index++) await backend.accept(new Float32Array(960));
        assert.deepEqual(await backend.accept(new Float32Array(), true), []);
        const summary = backend.getDiagnostics();
        assert.equal(summary.inputSamples48k, 144_000);
        assert.equal(summary.resampledSamples16k, 48_000);
        assert.equal(summary.paddingSamples16k, 6_400);
        assert.ok(summary.decodedChunks > 0 && summary.decodedChunks < 150);
        assert.equal(summary.rollovers, 0);
        summary.decodedChunks = -1;
        assert.ok(backend.getDiagnostics().decodedChunks > 0, "callers cannot mutate native counters");
    } finally { backend.destroy(); await engine.close(); }
});

test("offline greedy probe reports phonemes rather than inventing a transcript or wake confidence", {
    skip: installed ? false : "Run setup:wake for the acoustic probe", timeout: 30_000,
}, async () => {
    const probe = await createPhonemeProbe();
    const result = probe(Buffer.alloc(192_000));
    assert.equal(result.type, "diagnostic-greedy-phonemes");
    assert.deepEqual(result.tokens, []);
    assert.deepEqual(result.tokenTimesMs, []);
    assert.equal(result.transcript, undefined);
    assert.equal(result.confidence, undefined);
    assert.deepEqual(result.expectedWakeTokens, WAKE_TOKENS);
    assert.deepEqual(result.configuredPronunciations, WAKE_PRONUNCIATIONS);
    assert.throws(() => probe(Buffer.alloc(3)), /whole stereo/);
});

test("real worker supports independent streams, resampling, bounded long-stream rollover, and cancellation", {
    skip: installed ? false : "Run pnpm --filter bot setup:wake to enable the local-model integration test", timeout: 30_000,
}, async () => {
    const engine = await WakeEngine.create();
    const alice = engine.createBackend();
    const bob = engine.createBackend();
    try {
        for (let index = 0; index < 9; index++) {
            const results = await Promise.all([alice.accept(new Float32Array(96_000)), bob.accept(new Float32Array(960))]);
            assert.deepEqual(results, [[], []]);
        }
        assert.deepEqual(await alice.accept(new Float32Array(), true), []);
        const pending = assert.rejects(bob.accept(new Float32Array(48_000)), /cancelled/);
        bob.destroy();
        await pending;
        assert.deepEqual(await engine.createBackend().accept(new Float32Array(960), true), []);
    } finally { alice.destroy(); bob.destroy(); await engine.close(); }
    assert.throws(() => engine.createBackend(), /unavailable/);
});

import { parentPort, workerData } from "node:worker_threads";
import sherpa, { type OnlineStream } from "sherpa-onnx-node";
import type { KeywordDetection, WakeBackendDiagnostics, WakeConfiguration } from "./WakeBackend.js";

const config: WakeConfiguration = workerData.config;
const { paths } = config;
const spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: { transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
        tokens: paths.tokens, numThreads: 1, provider: "cpu", debug: 0 },
    keywordsFile: paths.keywords, keywordsThreshold: config.threshold, keywordsScore: config.score, numTrailingBlanks: 1,
});

interface State {
    stream: OnlineStream;
    resampler: InstanceType<typeof sherpa.LinearResampler>;
    tail: Float32Array;
    total: number;
    modelStart: number;
    replayUntil: number;
    diagnostics: WakeBackendDiagnostics;
}
const streams = new Map<number, State>();

function newState(): State {
    return { stream: spotter.createStream(), resampler: new sherpa.LinearResampler(48_000, 16_000),
        tail: new Float32Array(), total: 0, modelStart: 0, replayUntil: 0,
        diagnostics: { inputSamples48k: 0, resampledSamples16k: 0, paddingSamples16k: 0, decodedChunks: 0, rollovers: 0 } };
}

function decode(state: State, samples: Float32Array, final: boolean): KeywordDetection[] {
    const detections: KeywordDetection[] = [];
    // Bound native feature history during very long, continuously transmitting speech.
    // Replay two seconds into a fresh stream so a phrase at the rollover is preserved.
    if (state.total - state.modelStart >= 15 * 48_000) {
        state.diagnostics.rollovers++;
        state.stream = spotter.createStream();
        state.resampler = new sherpa.LinearResampler(48_000, 16_000);
        state.modelStart = state.total - state.tail.length;
        state.replayUntil = state.total;
        state.stream.acceptWaveform({ samples: state.resampler.resample(state.tail), sampleRate: 16_000 });
    }
    const joined = new Float32Array(state.tail.length + samples.length);
    joined.set(state.tail);
    joined.set(samples, state.tail.length);
    state.tail = joined.slice(-2 * 48_000);
    state.total += samples.length;
    const resampled = final ? state.resampler.flush(samples) : state.resampler.resample(samples);
    state.diagnostics.inputSamples48k += samples.length;
    state.diagnostics.resampledSamples16k += resampled.length;
    state.stream.acceptWaveform({ samples: resampled, sampleRate: 16_000 });
    if (final) {
        // Finish the model's look-ahead even when Discord sends no trailing silence.
        // Padding is analysis-only and is never appended to a user's preserved PCM.
        state.stream.acceptWaveform({ samples: new Float32Array(6_400), sampleRate: 16_000 });
        state.diagnostics.paddingSamples16k += 6_400;
        state.stream.inputFinished();
    }
    while (spotter.isReady(state.stream)) {
        spotter.decode(state.stream);
        state.diagnostics.decodedChunks++;
        const result = spotter.getResult(state.stream);
        if (result.keyword) {
            const seconds = result.start_time + (result.timestamps.at(-1) ?? 0);
            const endpoint = state.modelStart + seconds * 48_000;
            if (endpoint > state.replayUntil) detections.push({ keyword: result.keyword,
                keywordStartMs: state.modelStart / 48 + (result.start_time + (result.timestamps[0] ?? 0)) * 1_000,
                keywordEndMs: endpoint / 48, tokens: result.tokens });
            spotter.reset(state.stream);
        }
    }
    return detections;
}

parentPort!.on("message", (message: { type: "audio" | "close"; streamId: number; requestId: number; samples: Float32Array; final: boolean }) => {
    if (message.type === "close") {
        // Native bindings free stream/resampler handles via finalizers after references are released.
        streams.delete(message.streamId);
        return;
    }
    try {
        let state = streams.get(message.streamId);
        if (!state) {
            if (streams.size >= 32) throw new Error("Too many active wake streams.");
            state = newState();
            streams.set(message.streamId, state);
        }
        const detections = decode(state, message.samples, message.final);
        if (message.final) streams.delete(message.streamId);
        parentPort!.postMessage({ type: "result", requestId: message.requestId, detections, diagnostics: state.diagnostics });
    } catch (error) {
        streams.delete(message.streamId);
        parentPort!.postMessage({ type: "result", requestId: message.requestId,
            error: error instanceof Error ? error.message : "Local keyword inference failed." });
    }
});
parentPort!.postMessage({ type: "ready" });

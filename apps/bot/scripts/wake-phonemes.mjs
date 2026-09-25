import { stereoToMono } from "../src/voice/wake/WakeWordDetector.ts";
import { WAKE_TOKENS, WAKE_PRONUNCIATIONS, wakeModelPaths } from "../src/voice/wake/wakeModel.ts";

/** Opt-in offline acoustic probe, using the installed model. Never imported by the live bot. */
export async function createPhonemeProbe(directory) {
    const { default: sherpa } = await import("sherpa-onnx-node");
    const paths = wakeModelPaths(directory);
    const recognizer = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: 16_000, featureDim: 80 },
        modelConfig: { transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
            tokens: paths.tokens, numThreads: 1, provider: "cpu", debug: 0 },
        decodingMethod: "greedy_search", enableEndpoint: false,
    });
    return (pcm) => {
        if (pcm.length > 60 * 192_000) throw new Error("Phoneme diagnostics are limited to 60 seconds per clip.");
        const stream = recognizer.createStream();
        const resampler = new sherpa.LinearResampler(48_000, 16_000);
        for (let offset = 0; offset < pcm.length; offset += 3840) {
            const samples = resampler.resample(stereoToMono(pcm.subarray(offset, offset + 3840)));
            stream.acceptWaveform({ samples, sampleRate: 16_000 });
            while (recognizer.isReady(stream)) recognizer.decode(stream);
        }
        stream.acceptWaveform({ samples: resampler.flush(new Float32Array()), sampleRate: 16_000 });
        stream.acceptWaveform({ samples: new Float32Array(6_400), sampleRate: 16_000 });
        stream.inputFinished();
        while (recognizer.isReady(stream)) recognizer.decode(stream);
        const result = recognizer.getResult(stream);
        return { type: "diagnostic-greedy-phonemes", expectedWakeTokens: WAKE_TOKENS,
            configuredPronunciations: WAKE_PRONUNCIATIONS,
            tokens: result.tokens, tokenTimesMs: result.timestamps.map((time) => Math.round((result.start_time + time) * 1_000)),
            // Raw greedy-path log probabilities, not KWS probabilities or a phrase confidence.
            tokenLogProbabilities: result.ys_probs,
            note: "Separate ungated greedy hypothesis from the same acoustic model. Not an English transcript, the KWS search path, or a wake confidence score. Never used for activation." };
    };
}

import { WakeWordDetector, WAKE_PRE_ROLL_MS } from "../src/voice/wake/WakeWordDetector.ts";
import { VoiceActivityDetector } from "../src/voice/processing/VoiceActivityDetector.ts";

/** Use production framing, VAD admission, pre-roll, and finalization in every offline comparison. */
export async function replayWake(pcm, createBackend, createVad, options = {}) {
    let activity;
    let failure;
    const hits = [];
    const wake = new WakeWordDetector(createBackend, () => activity.recentAudio,
        (event) => hits.push({ audioTimeMs: event.audioTimeMs, keywordStartMs: event.keywordStartMs,
            keywordEndMs: event.keywordEndMs, pronunciationId: event.pronunciationId, preservedBytes: event.preRoll.length }),
        (error) => { failure = error; }, options);
    const started = performance.now();
    try {
        activity = new VoiceActivityDetector(createVad(), { bufferMs: WAKE_PRE_ROLL_MS, onFrame: (frame) => wake.process(frame) });
        for (let offset = 0; offset < pcm.length; offset += 3840) {
            activity.process(pcm.subarray(offset, offset + 3840));
            // Faster than real time, but respect the production backlog bound.
            await wake.whenIdle();
        }
        await wake.finish();
        if (failure) throw failure;
        return { detected: hits.length > 0, hits, speech: activity.summary, summary: await wake.result,
            audioSeconds: pcm.length / 192_000, processingMs: performance.now() - started };
    } finally { wake.destroy(); activity?.destroy("stream-end"); }
}

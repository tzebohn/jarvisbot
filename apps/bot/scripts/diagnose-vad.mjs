import "dotenv/config";
import { createWebRtcVadFactory } from "../src/voice/processing/WebRtcVad.ts";
import { VoiceActivityDetector } from "../src/voice/processing/VoiceActivityDetector.ts";

const seconds = Number(process.argv[2] ?? 10);
const speakers = Number(process.argv[3] ?? 8);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120
    || !Number.isInteger(speakers) || speakers < 1 || speakers > 32) {
    throw new Error("Usage: diagnose:vad [seconds: 1–120] [interleaved speakers: 1–32]");
}
const mode = Number(process.env.VOICE_VAD_MODE?.trim() || "2");
const create = await createWebRtcVadFactory(mode);
console.log(`Synthetic VAD diagnostics: mode ${mode}, 48 kHz stereo input, 20 ms mono analysis. These are not microphone-quality tests.`);
for (const scenario of ["silence", "quiet background noise", "voice-like harmonics", "loud broadband noise"]) {
    const processors = Array.from({ length: speakers }, () => new VoiceActivityDetector(create()));
    let seed = 12345;
    try {
        for (let frame = 0; frame < seconds * 50; frame++) {
            const pcm = Buffer.alloc(3840);
            for (let sample = 0; sample < 960; sample++) {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                const time = (frame * 960 + sample) / 48_000;
                const value = scenario === "silence" ? 0
                    : scenario === "quiet background noise" ? (seed % 17) - 8
                    : scenario === "loud broadband noise" ? (seed % 8001) - 4000
                    : 6000 * (0.6 + 0.4 * Math.sin(time * 2 * Math.PI * 3))
                        * (Math.sin(2 * Math.PI * 140 * time) + 0.4 * Math.sin(2 * Math.PI * 280 * time)
                            + 0.2 * Math.sin(2 * Math.PI * 700 * time));
                pcm.writeInt16LE(Math.round(value), sample * 4);
                pcm.writeInt16LE(Math.round(value), sample * 4 + 2);
            }
            for (const processor of processors) processor.process(pcm);
        }
        const summaries = processors.map((processor) => processor.summary);
        const totalMs = summaries.reduce((sum, result) => sum + result.processingMs, 0);
        console.log(JSON.stringify({
            scenario, speakers, secondsPerSpeaker: seconds,
            voicedMsPerSpeaker: summaries[0].voicedMs,
            segmentsPerSpeaker: summaries[0].speechSegments,
            processingMs: Number(totalMs.toFixed(2)),
            msPerAudioSecond: Number((totalMs / speakers / seconds).toFixed(3)),
            maxRollingBytesPerSpeaker: Math.max(...summaries.map((summary) => summary.bufferedMs * 192)),
        }));
    } finally {
        for (const processor of processors) processor.destroy("stream-end");
    }
}

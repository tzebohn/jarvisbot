import { PCM_BYTES_PER_SECOND } from "../receive/SpeakerStream.js";
import { AudioBuffer } from "./AudioBuffer.js";
import { VAD_FRAME_MS, VAD_FRAME_SAMPLES, type VoiceFrameDetector } from "./WebRtcVad.js";

const FRAME_BYTES = PCM_BYTES_PER_SECOND * VAD_FRAME_MS / 1_000;
export const SPEECH_START_MS = 100;

export interface SpeechSummary {
    processedMs: number;
    voicedMs: number;
    speechSegments: number;
    processingMs: number;
    bufferedMs: number;
}

export interface SpeechEvent {
    type: "speech-start" | "speech-active" | "speech-end";
    audioTimeMs: number;
    durationMs: number;
    reason?: "silence" | "stream-end" | "cancelled" | "error";
}

export interface VoiceActivityOptions {
    startMs?: number;
    endSilenceMs?: number;
    bufferMs?: number;
    onEvent?: (event: SpeechEvent) => void;
    onFrame?: (frame: VoiceFrame) => void;
}

export interface VoiceFrame {
    pcm: Buffer;
    mono: Int16Array;
    isVoice: boolean;
    isSpeaking: boolean;
    audioTimeMs: number;
}

/** Per-speaker framing, VAD hysteresis, and bounded pre-roll. No transcription or command execution. */
export class VoiceActivityDetector {
    private readonly buffer: AudioBuffer;
    private readonly mono = new Int16Array(VAD_FRAME_SAMPLES);
    private pending: Buffer = Buffer.alloc(0);
    private readonly startMs: number;
    private readonly endSilenceMs: number;
    private processedMs = 0;
    private voicedMs = 0;
    private speechSegments = 0;
    private processingMs = 0;
    private voicedRunMs = 0;
    private silenceMs = 0;
    private speechStartMs = 0;
    private lastActiveMs = 0;
    private speaking = false;
    private destroyed = false;

    constructor(private readonly detector: VoiceFrameDetector, private readonly options: VoiceActivityOptions = {}) {
        this.startMs = options.startMs ?? SPEECH_START_MS;
        this.endSilenceMs = options.endSilenceMs ?? 600;
        try {
            for (const value of [this.startMs, this.endSilenceMs]) {
                if (!Number.isInteger(value) || value < VAD_FRAME_MS || value > 5_000 || value % VAD_FRAME_MS !== 0) {
                    throw new Error("Speech thresholds must be multiples of 20 ms between 20 and 5000 ms.");
                }
            }
            this.buffer = new AudioBuffer(options.bufferMs);
        } catch (error) {
            detector.destroy();
            throw error;
        }
    }

    get isSpeaking(): boolean { return this.speaking; }
    get recentAudio(): Buffer { return this.buffer.snapshot(); }
    get summary(): SpeechSummary {
        return { processedMs: this.processedMs, voicedMs: this.voicedMs, speechSegments: this.speechSegments,
            processingMs: this.processingMs, bufferedMs: this.buffer.durationMs };
    }

    process(pcm: Buffer): void {
        if (this.destroyed) throw new Error("Speech processing has stopped.");
        const started = performance.now();
        let offset = 0;
        try {
            // Decoder output can have arbitrary chunk sizes. Retain less than one frame,
            // and avoid concatenating/copying a whole large input chunk.
            if (this.pending.length) {
                const needed = Math.min(FRAME_BYTES - this.pending.length, pcm.length);
                this.pending = Buffer.concat([this.pending, pcm.subarray(0, needed)]);
                offset = needed;
                if (this.pending.length === FRAME_BYTES) {
                    this.processFrame(this.pending);
                    this.pending = Buffer.alloc(0);
                }
            }
            while (offset + FRAME_BYTES <= pcm.length) {
                this.processFrame(pcm.subarray(offset, offset + FRAME_BYTES));
                offset += FRAME_BYTES;
            }
            if (offset < pcm.length) this.pending = Buffer.from(pcm.subarray(offset));
        } finally {
            this.processingMs += performance.now() - started;
        }
    }

    destroy(reason: "stream-end" | "cancelled" | "error" = "cancelled"): void {
        if (this.destroyed) return;
        this.destroyed = true;
        try {
            if (this.speaking) this.endSpeech(reason);
        } finally {
            this.pending = Buffer.alloc(0);
            this.mono.fill(0);
            this.buffer.clear();
            this.detector.destroy();
        }
    }

    private processFrame(stereo: Buffer): void {
        for (let sample = 0; sample < VAD_FRAME_SAMPLES; sample++) {
            const offset = sample * 4;
            this.mono[sample] = Math.trunc((stereo.readInt16LE(offset) + stereo.readInt16LE(offset + 2)) / 2);
        }
        const voice = this.detector.isSpeech(this.mono);
        this.processedMs += VAD_FRAME_MS;
        this.buffer.append(stereo);
        if (voice) {
            this.voicedMs += VAD_FRAME_MS;
            this.voicedRunMs += VAD_FRAME_MS;
            this.silenceMs = 0;
            if (!this.speaking && this.voicedRunMs >= this.startMs) {
                this.speaking = true;
                this.speechStartMs = this.processedMs - this.voicedRunMs;
                this.lastActiveMs = this.processedMs;
                this.speechSegments++;
                this.options.onEvent?.({ type: "speech-start", audioTimeMs: this.speechStartMs, durationMs: 0 });
            }
        } else {
            this.voicedRunMs = 0;
            if (this.speaking) {
                this.silenceMs += VAD_FRAME_MS;
                if (this.silenceMs >= this.endSilenceMs) this.endSpeech("silence");
            }
        }
        if (this.speaking && this.processedMs - this.lastActiveMs >= 1_000) {
            this.lastActiveMs = this.processedMs;
            this.options.onEvent?.({ type: "speech-active", audioTimeMs: this.processedMs,
                durationMs: this.processedMs - this.speechStartMs });
        }
        // Consumers must copy any data retained asynchronously; the mono frame is reused.
        this.options.onFrame?.({ pcm: stereo, mono: this.mono, isVoice: voice,
            isSpeaking: this.speaking, audioTimeMs: this.processedMs });
    }

    private endSpeech(reason: SpeechEvent["reason"]): void {
        this.speaking = false;
        const end = this.processedMs - this.silenceMs;
        this.options.onEvent?.({ type: "speech-end", audioTimeMs: end,
            durationMs: end - this.speechStartMs, reason });
        this.silenceMs = 0;
        this.voicedRunMs = 0;
    }
}

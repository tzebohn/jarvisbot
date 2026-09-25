import { PCM_BYTES_PER_SECOND, PCM_FORMAT } from "../receive/SpeakerStream.js";
import type { VoiceFrame } from "../processing/VoiceActivityDetector.js";
import type { WakeBackend, WakeBackendDiagnostics, WakeBackendFactory } from "./WakeBackend.js";
import { getWakePronunciation, WAKE_PHRASE, type WakePronunciationId } from "./wakeModel.js";

// Two seconds of phrase context plus the maximum two-second inference backlog.
export const WAKE_PRE_ROLL_MS = 4_000;
const WAKE_ONSET_PRE_ROLL_MS = 1_000;

export type WakeDiagnostic = (event: string, details: Record<string, unknown>) => void;
export interface WakeDetectorOptions {
    onDiagnostic?: WakeDiagnostic;
    // Diagnostic replay can isolate VAD failures without changing production VAD settings.
    gate?: "voice" | "segment" | "off";
    // On resume, never replay audio from a paused command session.
    minimumAudioTimeMs?: number;
}

export interface WakeDetection {
    phrase: typeof WAKE_PHRASE;
    preRoll: Buffer;
    format: typeof PCM_FORMAT;
    /** End of preRoll on the receive stream's PCM clock (exclusive). */
    audioTimeMs: number;
    preRollStartMs: number;
    /** Input processed by the model; may lag audioTimeMs while inference is in flight. */
    processedAudioTimeMs: number;
    keywordStartMs?: number;
    keywordEndMs?: number;
    /** Which explicitly configured acoustic path matched; not an accent or confidence estimate. */
    pronunciationId?: WakePronunciationId;
}

export interface WakeActivation extends WakeDetection {
    guildId: string;
    userId: string;
    streamId: string;
    streamEnded: boolean;
    detectedAt: number;
}

export interface WakeSummary {
    reason: string;
    audioTimeMs: number;
    analyzedMs: number;
    voicedMs: number;
    modelOpened: boolean;
    inputStartMs?: number;
    submittedAudioMs: number;
    completedAudioMs: number;
    requests: number;
    detections: number;
    outcome: "error" | "vad-gate-never-opened" | "keyword-detected" | "no-keyword-returned";
    inferenceMs: number;
    maxInferenceMs: number;
    native?: WakeBackendDiagnostics;
}

/** Async, VAD-gated keyword input for exactly one speaker. It never interprets commands. */
export class WakeWordDetector {
    private backend?: WakeBackend;
    private queued: Float32Array[] = [];
    private queuedSamples = 0;
    private processing?: Promise<void>;
    private ending = false;
    private flushed = false;
    private disposed = false;
    private audioTimeMs = 0;
    private inputStartMs = 0;
    private terminalSnapshot?: Buffer;
    private frames = 0;
    private voicedFrames = 0;
    private requests = 0;
    private detections = 0;
    private inferenceMs = 0;
    private maxInferenceMs = 0;
    private lastReportMs = 0;
    private energy = 0;
    private peak = 0;
    private submittedSamples = 0;
    private completedSamples = 0;
    private resolveResult!: (summary: WakeSummary) => void;
    /** Settles on natural end, error, or cancellation, including when no keyword was returned. */
    readonly result = new Promise<WakeSummary>((resolve) => { this.resolveResult = resolve; });

    constructor(private readonly createBackend: WakeBackendFactory,
        private readonly recentAudio: () => Buffer,
        private readonly onDetection: (detection: WakeDetection) => void,
        private readonly onError: (error: Error) => void,
        private readonly options: WakeDetectorOptions = {}) {}

    process(frame: VoiceFrame): void {
        if (this.disposed || this.ending) return;
        if (frame.audioTimeMs <= (this.options.minimumAudioTimeMs ?? 0)) return;
        this.audioTimeMs = frame.audioTimeMs;
        this.frames++;
        if (frame.isVoice) this.voicedFrames++;
        if (this.options.onDiagnostic) {
            for (const sample of frame.mono) {
                this.energy += (sample / 32768) ** 2;
                this.peak = Math.max(this.peak, Math.abs(sample / 32768));
            }
        }
        try {
            let mono: Float32Array;
            if (!this.backend) {
                // Segment confirmation is deliberately stricter than keyword admission.
                // A single VAD-positive frame opens KWS; only a full acoustic keyword activates.
                const admitted = this.options.gate === "off" || (this.options.gate === "segment" ? frame.isSpeaking : frame.isVoice);
                if (!admitted) return;
                this.backend = this.createBackend();
                // Recover the beginning of the wake phrase spoken before VAD admission.
                const prefixMs = Math.min(WAKE_ONSET_PRE_ROLL_MS, frame.audioTimeMs - (this.options.minimumAudioTimeMs ?? 0));
                const prefix = this.recentAudio().subarray(-Math.max(4, Math.floor(prefixMs * PCM_BYTES_PER_SECOND / 1_000)));
                this.inputStartMs = frame.audioTimeMs - prefix.length / PCM_BYTES_PER_SECOND * 1_000;
                mono = stereoToMono(prefix);
                this.options.onDiagnostic?.("gate-open", { gate: this.options.gate ?? "voice", audioTimeMs: frame.audioTimeMs,
                    inputStartMs: this.inputStartMs, prefixMs: mono.length / 48 });
            } else {
                mono = Float32Array.from(frame.mono, (sample) => sample / 32768);
            }
            this.queued.push(mono);
            this.queuedSamples += mono.length;
            if (this.queuedSamples > 2 * 48_000) throw new Error("Wake inference fell behind by more than two seconds.");
            this.pump();
        } catch (error) {
            this.fail(error);
        }
    }

    async finish(): Promise<void> {
        if (this.disposed) return;
        this.ending = true;
        // The receive/VAD layer may release its rolling buffer before inference finishes.
        this.terminalSnapshot = this.recentAudio();
        this.pump();
        await this.whenIdle();
        this.destroy("stream-end");
    }

    async whenIdle(): Promise<void> {
        while (this.processing) await this.processing;
    }

    destroy(reason = "cancelled"): void {
        if (this.disposed) return;
        this.disposed = true;
        const summary: WakeSummary = { reason, audioTimeMs: this.audioTimeMs, analyzedMs: this.frames * 20,
            voicedMs: this.voicedFrames * 20, modelOpened: !!this.backend, requests: this.requests, detections: this.detections,
            inputStartMs: this.backend ? this.inputStartMs : undefined, submittedAudioMs: this.submittedSamples / 48,
            completedAudioMs: this.completedSamples / 48, native: this.backend?.getDiagnostics?.(),
            outcome: reason === "error" ? "error" : !this.backend ? "vad-gate-never-opened" : this.detections ? "keyword-detected" : "no-keyword-returned",
            inferenceMs: Math.round(this.inferenceMs), maxInferenceMs: Math.round(this.maxInferenceMs) };
        this.resolveResult(summary);
        this.options.onDiagnostic?.("summary", { ...summary,
            rmsDbfs: this.energy ? Math.round(10 * Math.log10(this.energy / (this.frames * 960))) : null,
            peak: this.peak });
        this.queued = [];
        this.queuedSamples = 0;
        this.terminalSnapshot = undefined;
        this.backend?.destroy();
        this.backend = undefined;
    }

    private pump(): void {
        if (this.disposed || this.processing || !this.backend) return;
        const final = this.ending && this.queuedSamples === 0 && !this.flushed;
        if (!this.queuedSamples && !final) return;
        if (final) this.flushed = true;
        const samples = new Float32Array(this.queuedSamples);
        let offset = 0;
        for (const chunk of this.queued) { samples.set(chunk, offset); offset += chunk.length; }
        this.queued = [];
        this.queuedSamples = 0;
        const audioTimeMs = this.audioTimeMs;
        const backend = this.backend;
        const started = performance.now();
        this.requests++;
        this.submittedSamples += samples.length;
        this.processing = Promise.resolve().then(() => backend.accept(samples, final)).then((detections) => {
            if (this.disposed) return;
            this.completedSamples += samples.length;
            const elapsed = performance.now() - started;
            this.inferenceMs += elapsed;
            this.maxInferenceMs = Math.max(this.maxInferenceMs, elapsed);
            if (detections.length || final || audioTimeMs - this.lastReportMs >= 1_000) {
                this.lastReportMs = audioTimeMs;
                this.options.onDiagnostic?.("inference", { processedAudioTimeMs: audioTimeMs,
                    inputMs: samples.length / 48, final, elapsedMs: Number(elapsed.toFixed(3)), queuedMs: this.queuedSamples / 48,
                    native: backend.getDiagnostics?.(),
                    result: detections.length ? "keyword-returned" : "no-keyword-returned" });
            }
            for (const detection of detections) {
                if (this.disposed) break;
                const pronunciation = getWakePronunciation(detection.keyword);
                this.options.onDiagnostic?.("candidate", { ...detection, accepted: !!pronunciation,
                    pronunciationId: pronunciation?.id, configuredTokens: pronunciation?.tokens,
                    reason: pronunciation ? "configured-keyword" : "unexpected-keyword", confidence: null });
                if (!pronunciation) continue;
                this.detections++;
                // Snapshot at delivery, not at submission: include audio arriving during inference.
                const recent = this.terminalSnapshot ?? this.recentAudio();
                const allowedBytes = Math.max(0, Math.round((this.audioTimeMs - (this.options.minimumAudioTimeMs ?? 0)) * PCM_BYTES_PER_SECOND / 1_000));
                const snapshot = recent.subarray(Math.max(0, recent.length - allowedBytes));
                this.onDetection({ phrase: WAKE_PHRASE, pronunciationId: pronunciation.id, preRoll: Buffer.from(snapshot), format: PCM_FORMAT,
                    audioTimeMs: this.audioTimeMs, preRollStartMs: this.audioTimeMs - snapshot.length / PCM_BYTES_PER_SECOND * 1_000,
                    processedAudioTimeMs: audioTimeMs,
                    ...(detection.keywordStartMs === undefined ? {} : { keywordStartMs: this.inputStartMs + detection.keywordStartMs }),
                    ...(detection.keywordEndMs === undefined ? {} : { keywordEndMs: this.inputStartMs + detection.keywordEndMs }) });
            }
        }).catch((error: unknown) => this.fail(error)).finally(() => {
            this.processing = undefined;
            if (final) this.destroy("stream-end");
            else this.pump();
        });
    }

    private fail(error: unknown): void {
        if (this.disposed) return;
        this.destroy("error");
        this.onError(error instanceof Error ? error : new Error("Wake detection failed."));
    }
}

export function stereoToMono(stereo: Buffer): Float32Array {
    if (stereo.length % 4) throw new Error("Wake audio must contain whole stereo s16le sample frames.");
    const mono = new Float32Array(stereo.length / 4);
    for (let sample = 0; sample < mono.length; sample++) {
        mono[sample] = (stereo.readInt16LE(sample * 4) + stereo.readInt16LE(sample * 4 + 2)) / 65536;
    }
    return mono;
}

import { randomUUID } from "node:crypto";
import { PCM_BYTES_PER_SECOND, PCM_FORMAT } from "../receive/SpeakerStream.js";
import type { VoiceEvents } from "../VoiceEvents.js";
import type { WakeActivation } from "../wake/WakeWordDetector.js";
import { SPEECH_START_MS } from "../processing/VoiceActivityDetector.js";
import type { WakeAcknowledgement } from "../feedback/WakeAcknowledgement.js";

export type CommandCaptureReason = "speech-end" | "silence-timeout" | "max-duration";
export type CommandSessionState = "contention" | "listening" | "processing";

export interface CommandAudio {
    sessionId: string;
    guildId: string;
    userId: string;
    startedAt: number;
    wake: Omit<WakeActivation, "preRoll">;
    streamIds: string[];
    pcm: Buffer;
    format: typeof PCM_FORMAT;
    preRollMs: number;
    durationMs: number;
    reason: CommandCaptureReason;
    truncated: boolean;
}

/** One owner's bounded original PCM, spanning receive streams with independent clocks. */
export class VoiceCommandSession {
    readonly id = randomUUID();
    readonly guildId: string;
    readonly userId: string;
    readonly startedAt = Date.now();
    readonly wake: Omit<WakeActivation, "preRoll">;
    readonly abort = new AbortController();
    readonly contenders = new Set<string>();
    state: CommandSessionState = "contention";
    feedbackTerminal = false;
    pendingEnd?: CommandCaptureReason;
    currentStreamId: string;
    commandSpeechStarted = false;
    acknowledgement?: WakeAcknowledgement;
    private chunks: Buffer[] = [];
    private bytes = 0;
    private readonly watermarks = new Map<string, number>();
    private readonly maxBytes: number;
    private readonly preRollMs: number;

    constructor(activation: WakeActivation, maxCaptureMs: number, readonly voiceChannelId: string | null = null) {
        const { preRoll, ...wake } = activation;
        this.wake = wake;
        this.guildId = activation.guildId;
        this.userId = activation.userId;
        this.currentStreamId = activation.streamId;
        this.contenders.add(this.userId);
        this.preRollMs = preRoll.length / PCM_BYTES_PER_SECOND * 1_000;
        this.maxBytes = preRoll.length + maxCaptureMs * PCM_BYTES_PER_SECOND / 1_000;
        this.chunks.push(Buffer.from(preRoll));
        this.bytes = preRoll.length;
        this.watermarks.set(activation.streamId, activation.audioTimeMs);
    }

    get full(): boolean { return this.bytes >= this.maxBytes; }
    get ambiguous(): boolean { return this.contenders.size > 1; }

    /** KWS reports the last token's timestamp, not a sample-exact word ending.
     * Use the existing VAD onset allowance for that final token. Unknown endpoints
     * fall back to delivery's audio boundary; subsequent voiced frames win immediately.
     */
    observeVoice(streamId: string, audioTimeMs: number): void {
        const boundary = this.wake.keywordEndMs === undefined ? this.wake.audioTimeMs
            : Math.min(this.wake.audioTimeMs, this.wake.keywordEndMs + SPEECH_START_MS);
        if (streamId === this.currentStreamId && (streamId !== this.wake.streamId || audioTimeMs > boundary)) {
            this.commandSpeechStarted = true;
            this.acknowledgement?.cancel();
        }
    }

    startStream(streamId: string): void {
        if (this.state === "processing" || this.ambiguous || this.watermarks.has(streamId)) return;
        this.currentStreamId = streamId;
        this.watermarks.set(streamId, 0);
    }

    append(frame: Pick<VoiceEvents["pcm"][0], "streamId" | "audioTimeMs" | "pcm">): void {
        if (this.state === "processing" || this.ambiguous || this.full) return;
        const previous = this.watermarks.get(frame.streamId);
        // A late event from an older stream must not switch the owner back to it.
        if (previous !== undefined && frame.streamId !== this.currentStreamId) return;
        const startMs = frame.audioTimeMs - frame.pcm.length / PCM_BYTES_PER_SECOND * 1_000;
        const skip = Math.max(0, Math.round(((previous ?? startMs) - startMs) * PCM_BYTES_PER_SECOND / 1_000 / 4) * 4);
        const pcm = frame.pcm.subarray(skip, Math.min(frame.pcm.length, skip + this.maxBytes - this.bytes));
        if (!pcm.length) return;
        this.currentStreamId = frame.streamId;
        this.watermarks.set(frame.streamId, frame.audioTimeMs);
        this.chunks.push(Buffer.from(pcm));
        this.bytes += pcm.length;
    }

    takeAudio(reason: CommandCaptureReason): CommandAudio {
        const audio: CommandAudio = { sessionId: this.id, guildId: this.guildId, userId: this.userId,
            startedAt: this.startedAt, wake: this.wake, streamIds: [...this.watermarks.keys()],
            pcm: Buffer.concat(this.chunks, this.bytes), format: PCM_FORMAT, preRollMs: this.preRollMs,
            durationMs: this.bytes / PCM_BYTES_PER_SECOND * 1_000, reason, truncated: reason === "max-duration" };
        this.clearAudio();
        return audio;
    }

    clearAudio(): void {
        this.chunks = [];
        this.bytes = 0;
        this.watermarks.clear();
    }
}

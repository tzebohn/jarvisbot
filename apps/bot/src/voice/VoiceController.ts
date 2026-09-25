import { Writable, pipeline } from "node:stream";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
    EndBehaviorType, VoiceConnectionStatus,
    type AudioReceiveStream, type VoiceConnection, type VoiceConnectionState, type VoiceUserData,
} from "@discordjs/voice";
import { PCM_BYTES_PER_SECOND, PCM_FORMAT, SpeakerStream } from "./receive/SpeakerStream.js";
import { VoiceActivityDetector, type SpeechSummary } from "./processing/VoiceActivityDetector.js";
import type { VoiceFrameDetectorFactory } from "./processing/WebRtcVad.js";
import type { WakeBackendFactory } from "./wake/WakeBackend.js";
import { WakeWordDetector, WAKE_PRE_ROLL_MS, type WakeActivation, type WakeDetection, type WakeSummary } from "./wake/WakeWordDetector.js";
import type { VoiceAudioSnapshot, VoiceEvents, WakeListeningState } from "./VoiceEvents.js";

export const RECEIVE_SILENCE_MS = 1_000;
export const CAPTURE_WAIT_MS = 15_000;
export const MAX_CAPTURE_MS = 10_000;
export const WAKE_USER_COOLDOWN_MS = 3_000;
const MAX_CAPTURE_BYTES = PCM_BYTES_PER_SECOND * MAX_CAPTURE_MS / 1_000;

export interface CapturedUtterance {
    guildId: string;
    userId: string;
    streamId: string;
    pcm: Buffer;
    format: typeof PCM_FORMAT;
    durationMs: number;
    truncated: boolean;
    speech?: SpeechSummary;
    wakeResult?: Promise<WakeSummary>;
}

interface Capture {
    started: boolean;
    streamId?: string;
    chunks: Buffer[];
    bytes: number;
    timer: NodeJS.Timeout;
    resolve: (utterance: CapturedUtterance) => void;
    reject: (error: Error) => void;
}

interface Speaker {
    streamId: string;
    ended: boolean;
    source: AudioReceiveStream;
    decoder: SpeakerStream;
    packets: number;
    bytes: number;
    startupTimer: NodeJS.Timeout;
    activity?: VoiceActivityDetector;
    lastVoiceTimeMs?: number;
    wake?: WakeWordDetector;
}

interface WakeWatch {
    resolve: (event: WakeActivation) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

/** Per-guild receive/segmentation. Diagnostic utterances are separate from command sessions. */
export class VoiceController extends EventEmitter<VoiceEvents> {
    private readonly speakers = new Map<string, Speaker>();
    private readonly captures = new Map<string, Capture>();
    private destroyed = false;
    private readonly pendingWake = new Map<string, Set<WakeWordDetector>>();
    private readonly wakeWatches = new Map<string, WakeWatch>();
    private readonly lastWake = new Map<string, number>();
    private wakePaused = false;
    private previousWakeState?: WakeListeningState;

    constructor(readonly connection: VoiceConnection, private readonly debug = false,
        private readonly createVad?: VoiceFrameDetectorFactory, private readonly createWake?: WakeBackendFactory,
        private readonly wakeDebug = false) {
        super();
        connection.receiver.speaking.on("start", this.onSpeakingStart);
        connection.receiver.ssrcMap.on("delete", this.onUserLeft);
        connection.on("stateChange", this.onConnectionStateChange);
        connection.on("error", this.onConnectionError);
        this.reportWakeState("receiver-attached");
    }

    get isDestroyed(): boolean {
        return this.destroyed;
    }

    get wakeAvailable(): boolean { return !!this.createVad && !!this.createWake && !this.destroyed; }

    get wakeState(): WakeListeningState {
        if (!this.wakeAvailable || this.connection.state.status !== VoiceConnectionStatus.Ready) return "unavailable";
        return this.wakePaused ? "paused" : "listening";
    }

    /** Catch up an already-open owner stream, e.g. one started while an older stream flushed. */
    getAudioSnapshot(userId: string): VoiceAudioSnapshot | undefined {
        const speaker = this.speakers.get(userId);
        if (!speaker?.activity || speaker.source.destroyed) return undefined;
        const pcm = speaker.activity.recentAudio;
        const audioTimeMs = speaker.activity.summary.processedMs;
        return { guildId: this.connection.joinConfig.guildId, userId, streamId: speaker.streamId,
            pcm, format: PCM_FORMAT, startMs: audioTimeMs - pcm.length / PCM_BYTES_PER_SECOND * 1_000,
            audioTimeMs, isSpeaking: speaker.activity.isSpeaking, lastVoiceTimeMs: speaker.lastVoiceTimeMs };
    }

    /** Suspend only keyword inference. PCM/VAD continue for the command-session owner. */
    setWakeListening(enabled: boolean, reason = enabled ? "wake-resumed" : "wake-paused"): void {
        if (this.destroyed || this.wakePaused === !enabled) return;
        this.wakePaused = !enabled;
        for (const detectors of this.pendingWake.values()) for (const detector of detectors) detector.destroy(reason);
        this.pendingWake.clear();
        for (const [userId, speaker] of this.speakers) {
            speaker.wake = undefined;
            if (enabled && this.wakeAvailable && speaker.activity) this.attachWake(userId, speaker, speaker.activity.summary.processedMs);
        }
        // A fast command or rejected contention must not bypass the per-user cooldown.
        // Fresh detectors still exclude all audio received while the session was paused.
        if (!enabled) for (const userId of this.wakeWatches.keys()) this.failWakeWatch(userId, "Wake listening is paused.");
        this.reportWakeState(reason);
    }

    waitForWake(userId: string): { result: Promise<WakeActivation>; cancel: () => void } {
        if (!this.wakeAvailable) throw new Error("Wake detection is unavailable. Run `pnpm --filter bot setup:wake`, enable VAD/wake detection, and restart the bot.");
        if (this.wakePaused) throw new Error("Wake listening is paused.");
        if (this.connection.state.status !== VoiceConnectionStatus.Ready) throw new Error("The voice connection is not ready.");
        if (this.wakeWatches.has(userId)) throw new Error("You already have a wake test pending.");
        const result = new Promise<WakeActivation>((resolve, reject) => {
            const timer = setTimeout(() => this.failWakeWatch(userId,
                'No "Jarvis" activation was detected within 30 seconds. Enable VOICE_WAKE_DEBUG=1 and use !waketest sample to capture a failed attempt for replay.'), 30_000);
            timer.unref();
            this.wakeWatches.set(userId, { resolve, reject, timer });
        });
        void result.catch(() => {});
        const watch = this.wakeWatches.get(userId);
        return { result, cancel: () => {
            if (this.wakeWatches.get(userId) === watch) this.failWakeWatch(userId, "Wake test cancelled.");
        } };
    }

    captureNextUtterance(userId: string): { result: Promise<CapturedUtterance>; cancel: () => void } {
        if (this.destroyed || this.connection.state.status !== VoiceConnectionStatus.Ready) {
            throw new Error("The voice connection is not ready. Use `!join` and try again.");
        }
        if (this.captures.has(userId)) {
            throw new Error("You already have a voice test pending. Finish it before starting another.");
        }
        if (this.speakers.has(userId)) {
            throw new Error("Finish speaking and wait a second, then run `!voicetest` before your next utterance.");
        }
        const result = new Promise<CapturedUtterance>((resolve, reject) => {
            const timer = setTimeout(() => this.failCapture(userId,
                "No utterance was received within 15 seconds. Check that your microphone and the bot are not deafened/muted, then try again."), CAPTURE_WAIT_MS);
            timer.unref();
            this.captures.set(userId, { started: false, chunks: [], bytes: 0, timer, resolve, reject });
        });
        // The command may still be sending its initial Discord reply when voice disconnects.
        void result.catch(() => {});
        const capture = this.captures.get(userId);
        return { result, cancel: () => {
            if (this.captures.get(userId) === capture) this.failCapture(userId, "Voice test cancelled.");
        } };
    }

    stopUser(userId: string, reason = "The speaker left the voice channel."): void {
        this.emit("userStopped", { guildId: this.connection.joinConfig.guildId, userId, reason });
        this.failCapture(userId, reason);
        this.failWakeWatch(userId, reason);
        this.lastWake.delete(userId);
        for (const detector of this.pendingWake.get(userId) ?? []) detector.destroy();
        this.pendingWake.delete(userId);
        const speaker = this.speakers.get(userId);
        if (speaker) {
            clearTimeout(speaker.startupTimer);
            speaker.activity?.destroy("cancelled");
            speaker.source.destroy();
            speaker.decoder.destroy();
        }
        // Keep ownership until pipeline closes. VoiceReceiver removes its subscription
        // on 'close'; replacing it earlier could let an old close delete a new stream.
    }

    reset(reason: string): void {
        this.wakePaused = false;
        for (const userId of this.captures.keys()) this.failCapture(userId, reason);
        for (const userId of new Set([...this.speakers.keys(), ...this.pendingWake.keys(), ...this.wakeWatches.keys(), ...this.lastWake.keys()])) {
            this.stopUser(userId, reason);
        }
        this.emit("reset", { guildId: this.connection.joinConfig.guildId, reason });
        this.reportWakeState(reason);
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.connection.receiver.speaking.off("start", this.onSpeakingStart);
        this.connection.receiver.ssrcMap.off("delete", this.onUserLeft);
        this.connection.off("stateChange", this.onConnectionStateChange);
        this.connection.off("error", this.onConnectionError);
        this.reset("Voice receiving stopped because the bot left or the connection closed.");
    }

    private readonly onSpeakingStart = (userId: string): void => {
        if (this.destroyed || this.connection.state.status !== VoiceConnectionStatus.Ready || this.speakers.has(userId)) return;
        let source: AudioReceiveStream | undefined;
        let decoder: SpeakerStream | undefined;
        try {
            // Subscribe synchronously on 'start' so the first packet is not lost.
            source = this.connection.receiver.subscribe(userId, {
                end: { behavior: EndBehaviorType.AfterSilence, duration: RECEIVE_SILENCE_MS },
            });
            decoder = new SpeakerStream();
            const speaker: Speaker = {
                streamId: randomUUID(), ended: false,
                source, decoder, packets: 0, bytes: 0,
                // The library's silence timer starts only after its first Opus packet.
                startupTimer: setTimeout(() => this.stopUser(userId,
                    "Speaking was detected, but no Opus audio arrived. Check the voice connection and try again."), RECEIVE_SILENCE_MS),
            };
            speaker.startupTimer.unref();
            this.speakers.set(userId, speaker);
            this.emit("streamStart", { guildId: this.connection.joinConfig.guildId, userId, streamId: speaker.streamId });
            if (this.wakeState === "listening") this.attachWake(userId, speaker);
            if (this.createVad) {
                try {
                    speaker.activity = new VoiceActivityDetector(this.createVad(), {
                        onEvent: (event) => {
                            this.log(event.type, { userId, ...event });
                            if (!this.debug) this.logWake(event.type, { userId, streamId: speaker.streamId, ...event });
                            this.emit("speech", { guildId: this.connection.joinConfig.guildId, userId, streamId: speaker.streamId, ...event });
                        },
                        bufferMs: this.wakeAvailable ? WAKE_PRE_ROLL_MS : undefined,
                        onFrame: (frame) => {
                            if (frame.isVoice) speaker.lastVoiceTimeMs = frame.audioTimeMs;
                            speaker.wake?.process(frame);
                            if (this.listenerCount("pcm")) this.emit("pcm", { guildId: this.connection.joinConfig.guildId,
                                userId, streamId: speaker.streamId, pcm: Buffer.from(frame.pcm), format: PCM_FORMAT,
                                audioTimeMs: frame.audioTimeMs, isVoice: frame.isVoice, isSpeaking: frame.isSpeaking });
                        },
                    });
                } catch {
                    speaker.wake?.destroy();
                    this.emit("streamError", { guildId: this.connection.joinConfig.guildId, userId, streamId: speaker.streamId,
                        reason: "vad-initialization-failed" });
                    this.failWakeWatch(userId, "Could not initialize voice activity detection for the wake test.");
                    console.error("Could not initialize speaker VAD.", { guildId: this.connection.joinConfig.guildId, userId });
                }
            }
            const capture = this.captures.get(userId);
            if (capture) {
                capture.started = true;
                capture.streamId = speaker.streamId;
                clearTimeout(capture.timer);
                capture.timer = setTimeout(() => this.completeCapture(userId, true), MAX_CAPTURE_MS);
                capture.timer.unref();
            }
            this.log("speaker started", { userId });
            source.on("data", () => {
                speaker.packets++;
                clearTimeout(speaker.startupTimer);
            });
            const sink = new Writable({
                write: (pcm: Buffer, _encoding, done) => {
                    speaker.bytes += pcm.length;
                    if (speaker.bytes === pcm.length) this.logWake("audio-arriving", { userId, streamId: speaker.streamId,
                        pcmBytes: pcm.length, format: PCM_FORMAT });
                    try {
                        speaker.activity?.process(pcm);
                    } catch {
                        speaker.wake?.destroy();
                        this.failWakeWatch(userId, "Voice activity detection failed during the wake test.");
                        speaker.activity?.destroy("error");
                        speaker.activity = undefined;
                        this.emit("streamError", { guildId: this.connection.joinConfig.guildId, userId, streamId: speaker.streamId,
                            reason: "vad-failed" });
                        console.error("Speaker VAD failed.", { guildId: this.connection.joinConfig.guildId, userId });
                    }
                    this.capturePcm(userId, pcm);
                    // Retain only bounded VAD pre-roll and explicitly requested diagnostic audio.
                    done();
                },
            });
            pipeline(source, decoder, sink, (error) => {
                clearTimeout(speaker.startupTimer);
                if (this.speakers.get(userId) !== speaker) return;
                this.speakers.delete(userId);
                speaker.ended = true;
                if (error) {
                    this.failCapture(userId, "Voice receiving or Opus decoding failed. Try another utterance.");
                    if (!this.destroyed && error.code !== "ERR_STREAM_PREMATURE_CLOSE") {
                        console.error("Voice receive failed.", { guildId: this.connection.joinConfig.guildId, userId, error: error.message });
                    }
                } else {
                    this.completeCapture(userId, false, speaker.activity?.summary, speaker.wake);
                }
                const wake = speaker.wake;
                if (wake) {
                    // Natural end flushes model look-ahead before releasing the immutable
                    // pre-roll. Disconnect/error cancellation must never publish a late wake.
                    if (error) wake.destroy();
                    void (error ? Promise.resolve() : wake.finish()).finally(() => {
                        const pending = this.pendingWake.get(userId);
                        pending?.delete(wake);
                        if (pending?.size === 0) this.pendingWake.delete(userId);
                    });
                }
                speaker.activity?.destroy(error ? "error" : "stream-end");
                this.emit("streamEnd", { guildId: this.connection.joinConfig.guildId, userId, streamId: speaker.streamId,
                    audioTimeMs: speaker.activity?.summary.processedMs ?? 0, reason: error ? "error" : "stream-end" });
                this.log("utterance ended", { userId, packets: speaker.packets, pcmBytes: speaker.bytes,
                    speech: speaker.activity?.summary });
            });
        } catch (error) {
            // Stream errors must have a listener even if decoder construction failed.
            source?.on("error", () => {});
            source?.destroy();
            decoder?.destroy();
            const speaker = this.speakers.get(userId);
            if (speaker) {
                clearTimeout(speaker.startupTimer);
                speaker.activity?.destroy("error");
                speaker.wake?.destroy();
                if (speaker.wake) this.pendingWake.get(userId)?.delete(speaker.wake);
                this.speakers.delete(userId);
                this.emit("streamError", { guildId: this.connection.joinConfig.guildId, userId, streamId: speaker.streamId,
                    reason: "receive-start-failed" });
            }
            this.failCapture(userId, "Could not start voice receiving. Check the bot's Opus installation.");
            console.error("Could not start voice receiving.", { guildId: this.connection.joinConfig.guildId, userId,
                error: error instanceof Error ? error.message : "Unknown receive error" });
        }
    };

    private capturePcm(userId: string, pcm: Buffer): void {
        const capture = this.captures.get(userId);
        if (!capture?.started) return;
        const chunk = Buffer.from(pcm.subarray(0, MAX_CAPTURE_BYTES - capture.bytes));
        capture.chunks.push(chunk);
        capture.bytes += chunk.length;
        if (capture.bytes >= MAX_CAPTURE_BYTES) this.completeCapture(userId, true);
    }

    private completeCapture(userId: string, truncated: boolean, speech = this.speakers.get(userId)?.activity?.summary,
        wake = this.speakers.get(userId)?.wake): void {
        const capture = this.captures.get(userId);
        if (!capture?.started) return;
        if (!capture.bytes) {
            this.failCapture(userId, "No decodable audio was received. Check your microphone and try again.");
            return;
        }
        this.captures.delete(userId);
        clearTimeout(capture.timer);
        const pcm = Buffer.concat(capture.chunks, capture.bytes);
        capture.chunks = [];
        capture.resolve({ guildId: this.connection.joinConfig.guildId, userId, streamId: capture.streamId!, pcm, format: PCM_FORMAT,
            wakeResult: wake?.result,
            durationMs: pcm.length / PCM_BYTES_PER_SECOND * 1_000, truncated, ...(speech ? { speech } : {}) });
    }

    private failCapture(userId: string, reason: string): void {
        const capture = this.captures.get(userId);
        if (!capture) return;
        this.captures.delete(userId);
        clearTimeout(capture.timer);
        capture.chunks = [];
        capture.reject(new Error(reason));
    }

    private attachWake(userId: string, speaker: Speaker, minimumAudioTimeMs = 0): void {
        const wake = new WakeWordDetector(this.createWake!,
            () => speaker.activity?.recentAudio ?? Buffer.alloc(0),
            (detection) => this.onWake(userId, speaker, wake, detection),
            (error) => {
                const pending = this.pendingWake.get(userId);
                pending?.delete(wake);
                if (pending?.size === 0) this.pendingWake.delete(userId);
                this.failWakeWatch(userId, "Wake detection failed. Check the bot logs and try again.");
                this.emit("wakeError", { guildId: this.connection.joinConfig.guildId, userId, streamId: speaker.streamId });
                console.error("Wake detection failed.", { guildId: this.connection.joinConfig.guildId, userId, error: error.message });
            }, { minimumAudioTimeMs, onDiagnostic: this.wakeDebug
                ? (event, details) => this.logWake(event, { userId, streamId: speaker.streamId, ...details }) : undefined });
        speaker.wake = wake;
        const pending = this.pendingWake.get(userId) ?? new Set<WakeWordDetector>();
        pending.add(wake);
        this.pendingWake.set(userId, pending);
    }

    private onWake(userId: string, speaker: Speaker, detector: WakeWordDetector, detection: WakeDetection): void {
        if (this.destroyed || this.connection.state.status !== VoiceConnectionStatus.Ready
            || this.wakePaused || !this.pendingWake.get(userId)?.has(detector)) {
            this.logWake("rejected", { userId, reason: "inactive-or-cancelled" });
            return;
        }
        const now = Date.now();
        for (const [id, time] of this.lastWake) if (now - time >= WAKE_USER_COOLDOWN_MS) this.lastWake.delete(id);
        const remainingMs = WAKE_USER_COOLDOWN_MS - (now - (this.lastWake.get(userId) ?? -Infinity));
        if (remainingMs > 0) {
            this.logWake("rejected", { userId, reason: "cooldown", remainingMs });
            return;
        }
        this.lastWake.set(userId, now);
        const event: VoiceEvents["wake"][0] = { ...detection, guildId: this.connection.joinConfig.guildId, userId,
            streamId: speaker.streamId, streamEnded: speaker.ended, detectedAt: now, lastVoiceTimeMs: speaker.lastVoiceTimeMs };
        this.logWake("accepted", { userId, streamId: speaker.streamId, audioTimeMs: event.audioTimeMs,
            pronunciationId: event.pronunciationId, processedAudioTimeMs: event.processedAudioTimeMs,
            keywordEndMs: event.keywordEndMs, preRollBytes: event.preRoll.length });
        const watch = this.wakeWatches.get(userId);
        if (watch) {
            clearTimeout(watch.timer);
            this.wakeWatches.delete(userId);
            watch.resolve(event);
        }
        this.emit("wake", event);
    }

    private failWakeWatch(userId: string, reason: string): void {
        const watch = this.wakeWatches.get(userId);
        if (!watch) return;
        clearTimeout(watch.timer);
        this.wakeWatches.delete(userId);
        watch.reject(new Error(reason));
    }

    private readonly onUserLeft = ({ userId }: VoiceUserData): void => this.stopUser(userId);

    private readonly onConnectionStateChange = (_old: VoiceConnectionState, state: VoiceConnectionState): void => {
        if (state.status === VoiceConnectionStatus.Destroyed) this.destroy();
        else if (state.status !== VoiceConnectionStatus.Ready) this.reset("The voice connection was interrupted. Try again once connected.");
        else this.reportWakeState("connection-ready");
    };

    private readonly onConnectionError = (): void => this.destroy();

    private log(event: string, details: Record<string, unknown>): void {
        if (this.debug) console.log(`[voice] ${event}`, { guildId: this.connection.joinConfig.guildId, ...details });
    }

    private reportWakeState(reason: string): void {
        const state = this.wakeState;
        if (this.previousWakeState === state) return;
        this.previousWakeState = state;
        this.logWake("state", { state, reason });
        this.emit("wakeState", { guildId: this.connection.joinConfig.guildId, state, reason });
    }

    private logWake(event: string, details: Record<string, unknown>): void {
        if (this.wakeDebug) console.log(`[wake] ${event}`, { guildId: this.connection.joinConfig.guildId, ...details });
    }
}

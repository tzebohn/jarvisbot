import { EventEmitter } from "node:events";
import type { VoiceController } from "../VoiceController.js";
import type { VoiceEvents } from "../VoiceEvents.js";
import { VoiceCommandSession, type CommandAudio, type CommandCaptureReason, type CommandSessionState } from "./VoiceCommandSession.js";
import { SttError, type TranscriptionResult } from "../transcription/types.js";
import type { CommandParseResult } from "../commands/types.js";
import { isTerminalFeedback, type ReportVoiceFeedback, type VoiceCommandUpdate, type VoiceFeedbackEvent } from "../feedback/VoiceCommandFeedback.js";
import { DEFAULT_WAKE_ACK_DELAY_MS, WakeAcknowledgement, type PlayWakeAcknowledgement } from "../feedback/WakeAcknowledgement.js";

export const COMMAND_CONTENTION_MS = 300;
export const COMMAND_SILENCE_MS = 1_500;
export const COMMAND_MAX_CAPTURE_MS = 10_000;
export const COMMAND_PROCESSING_TIMEOUT_MS = 15_000;
export const COMMAND_EXECUTION_TIMEOUT_MS = 60_000;

export interface VoiceSessionOptions {
    contentionMs?: number;
    silenceMs?: number;
    maxCaptureMs?: number;
    processingTimeoutMs?: number;
    executionTimeoutMs?: number;
    debug?: boolean;
    wakeAckDelayMs?: number;
    playWakeAcknowledgement?: PlayWakeAcknowledgement;
    /** Phase V5 boundary. Honor the signal; do not retain audio after settling/aborting. */
    processCapture?: (audio: CommandAudio, signal: AbortSignal) => void | TranscriptionResult | Promise<void | TranscriptionResult>;
    /** Phase V6 boundary. Runs under the same owner lock; returns data, never executes music. */
    parseTranscript?: (transcript: CommandTranscript, signal: AbortSignal) => CommandParseResult | Promise<CommandParseResult>;
    /** Phase V7 boundary. Await execution inside the owner lock; cancellation invalidates pending work. */
    executeCommand?: (command: ParsedSessionCommand, signal: AbortSignal, report: ReportVoiceFeedback) => void | Promise<void>;
}

export interface SessionIdentity { guildId: string; userId: string; sessionId: string }
export interface SessionEnd extends SessionIdentity { reason: string; contenders: string[] }
export interface CommandTranscript extends SessionIdentity, TranscriptionResult { audioDurationMs: number; truncated: boolean }
export interface ParsedSessionCommand extends SessionIdentity, CommandParseResult { voiceChannelId: string | null }
export interface SessionEvents {
    state: [SessionIdentity & { state: CommandSessionState | "idle" }];
    capture: [CommandAudio];
    transcript: [CommandTranscript];
    command: [ParsedSessionCommand];
    feedback: [VoiceFeedbackEvent];
    end: [SessionEnd];
}

interface Watch<T> {
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

/** One guild's owner lock, arbitration, capture timers, and asynchronous processing lifetime. */
export class GuildVoiceSessions extends EventEmitter<SessionEvents> {
    private active?: VoiceCommandSession;
    private disposed = false;
    private contentionTimer?: NodeJS.Timeout;
    private silenceTimer?: NodeJS.Timeout;
    private maximumTimer?: NodeJS.Timeout;
    private processingTimer?: NodeJS.Timeout;
    private readonly watches = new Map<string, Watch<CommandAudio>>();
    private readonly transcriptWatches = new Map<string, Watch<CommandTranscript>>();
    private readonly commandWatches = new Map<string, Watch<ParsedSessionCommand>>();
    private readonly contentionMs: number;
    private readonly silenceMs: number;
    private readonly maxCaptureMs: number;
    private readonly processingTimeoutMs: number;
    private readonly executionTimeoutMs: number;

    constructor(private readonly controller: VoiceController, private readonly options: VoiceSessionOptions = {}) {
        super();
        this.contentionMs = options.contentionMs ?? COMMAND_CONTENTION_MS;
        this.silenceMs = options.silenceMs ?? COMMAND_SILENCE_MS;
        this.maxCaptureMs = options.maxCaptureMs ?? COMMAND_MAX_CAPTURE_MS;
        this.processingTimeoutMs = options.processingTimeoutMs ?? COMMAND_PROCESSING_TIMEOUT_MS;
        this.executionTimeoutMs = options.executionTimeoutMs ?? COMMAND_EXECUTION_TIMEOUT_MS;
        for (const ms of [this.contentionMs, this.silenceMs, this.maxCaptureMs, this.processingTimeoutMs, this.executionTimeoutMs]) {
            if (!Number.isInteger(ms) || ms <= 0 || ms > 60_000) throw new Error("Session timeouts must be integer milliseconds between 1 and 60000.");
        }
        if (this.contentionMs >= this.silenceMs || this.silenceMs >= this.maxCaptureMs) {
            throw new Error("Session timeouts must satisfy contention < silence < maximum capture.");
        }
        const ackDelay = options.wakeAckDelayMs ?? DEFAULT_WAKE_ACK_DELAY_MS;
        if (options.playWakeAcknowledgement && (!Number.isInteger(ackDelay)
            || ackDelay <= this.contentionMs || ackDelay >= this.silenceMs)) {
            throw new Error("VOICE_WAKE_ACK_DELAY_MS must satisfy contention < acknowledgement delay < silence timeout.");
        }
        controller.on("wake", this.onWake);
        controller.on("wakeError", this.onWakeError);
        controller.on("streamStart", this.onStreamStart);
        controller.on("pcm", this.onPcm);
        controller.on("speech", this.onSpeech);
        controller.on("streamEnd", this.onStreamEnd);
        controller.on("streamError", this.onStreamError);
        controller.on("userStopped", this.onUserStopped);
        controller.on("reset", this.onReset);
    }

    get state(): CommandSessionState | "idle" { return this.active?.state ?? "idle"; }
    get ownerId(): string | undefined { return this.active?.userId; }
    get transcriptionEnabled(): boolean { return !!this.options.processCapture; }
    get parsingEnabled(): boolean { return this.transcriptionEnabled && !!this.options.parseTranscript; }
    get executionEnabled(): boolean { return this.parsingEnabled && !!this.options.executeCommand; }

    /** Explicit diagnostic only; observing a capture never creates a session or changes its owner. */
    waitForCapture(userId: string): { result: Promise<CommandAudio>; cancel: () => void } {
        return this.observe(this.watches, userId, 45_000);
    }

    waitForTranscript(userId: string): { result: Promise<CommandTranscript>; cancel: () => void } {
        if (!this.transcriptionEnabled) throw new Error("Voice transcription is disabled.");
        return this.observe(this.transcriptWatches, userId, 45_000 + this.processingTimeoutMs);
    }

    waitForCommand(userId: string): { result: Promise<ParsedSessionCommand>; cancel: () => void } {
        if (!this.parsingEnabled) throw new Error("Voice command parsing is disabled.");
        return this.observe(this.commandWatches, userId, 45_000 + this.processingTimeoutMs);
    }

    private observe<T>(watches: Map<string, Watch<T>>, userId: string, timeoutMs: number): { result: Promise<T>; cancel: () => void } {
        if (this.disposed || this.controller.wakeState === "unavailable") throw new Error("Voice command capture is unavailable. Join voice and check the wake configuration.");
        if (this.active || this.controller.wakeState !== "listening") throw new Error("A voice command session is busy. Wait for it to finish, then try again.");
        if (watches.has(userId)) throw new Error("You already have a command capture test pending.");
        const result = new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => this.failWatch(userId, `No command result completed within ${timeoutMs / 1_000} seconds. Try the wake phrase again.`), timeoutMs);
            timer.unref();
            watches.set(userId, { resolve, reject, timer });
        });
        void result.catch(() => {});
        const watch = watches.get(userId);
        return { result, cancel: () => {
            if (watches.get(userId) === watch) this.failWatch(userId, "Command capture test cancelled.");
        } };
    }

    destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.active) this.end(this.active, "Voice command sessions stopped.");
        for (const userId of this.watches.keys()) this.failWatch(userId, "Voice command sessions stopped.");
        for (const userId of this.transcriptWatches.keys()) this.failWatch(userId, "Voice command sessions stopped.");
        for (const userId of this.commandWatches.keys()) this.failWatch(userId, "Voice command sessions stopped.");
        this.controller.off("wake", this.onWake);
        this.controller.off("wakeError", this.onWakeError);
        this.controller.off("streamStart", this.onStreamStart);
        this.controller.off("pcm", this.onPcm);
        this.controller.off("speech", this.onSpeech);
        this.controller.off("streamEnd", this.onStreamEnd);
        this.controller.off("streamError", this.onStreamError);
        this.controller.off("userStopped", this.onUserStopped);
        this.controller.off("reset", this.onReset);
    }

    private readonly onWake = (event: VoiceEvents["wake"][0]): void => {
        if (this.disposed || event.guildId !== this.controller.connection.joinConfig.guildId) return;
        if (this.active) {
            if (this.active.state === "contention") {
                this.active.contenders.add(event.userId);
                if (this.active.ambiguous) {
                    this.active.acknowledgement?.cancel();
                    this.active.clearAudio();
                }
            }
            // Neither repeated wakes nor other speakers can replace a session owner.
            return;
        }
        if (this.controller.wakeState !== "listening") return;
        const session = new VoiceCommandSession(event, this.maxCaptureMs, this.controller.connection.joinConfig.channelId);
        this.active = session;
        if (event.lastVoiceTimeMs !== undefined) session.observeVoice(event.streamId, event.lastVoiceTimeMs);
        // Listeners are already installed. Catch up an owner stream opened while the old one flushed.
        const snapshot = this.controller.getAudioSnapshot(event.userId);
        if (snapshot) {
            session.append(snapshot);
            if (snapshot.lastVoiceTimeMs !== undefined) session.observeVoice(snapshot.streamId, snapshot.lastVoiceTimeMs);
            // Older/custom receive adapters may expose only segment state.
            else if (snapshot.isSpeaking) session.observeVoice(snapshot.streamId, snapshot.audioTimeMs);
        }
        this.contentionTimer = setTimeout(() => this.selectOwner(session), this.contentionMs);
        this.maximumTimer = setTimeout(() => this.complete(session, "max-duration"), this.maxCaptureMs);
        this.contentionTimer.unref();
        this.maximumTimer.unref();
        this.armSilence(session);
        if (this.options.playWakeAcknowledgement && !session.commandSpeechStarted) {
            const canPlay = () => this.active === session && !this.disposed && !this.controller.isDestroyed
                && this.controller.wakeState !== "unavailable" && session.state === "listening"
                && !session.ambiguous && !session.pendingEnd && !session.commandSpeechStarted && !session.abort.signal.aborted;
            session.acknowledgement = new WakeAcknowledgement(session.abort.signal,
                this.options.wakeAckDelayMs ?? DEFAULT_WAKE_ACK_DELAY_MS, {
                    ...this.identity(session), canPlay,
                    onStart: (durationMs) => {
                        if (canPlay()) this.armSilence(session, durationMs + this.silenceMs);
                    },
                }, this.options.playWakeAcknowledgement);
        }
        this.reportState(session);
        // Capture already owns the first accepted wake. No VAD/background event reaches the UI.
        this.reportFeedback(session, { state: "listening" });
    };

    private selectOwner(session: VoiceCommandSession): void {
        if (this.active !== session) return;
        if (session.ambiguous) {
            // Cancel all remaining candidate inference before resuming with a fresh audio boundary.
            this.controller.setWakeListening(false, "command-contention-rejected");
            this.end(session, "Multiple users activated together. Please try again one at a time.", { state: "failed", reason: "contention" });
            return;
        }
        session.state = "listening";
        this.controller.setWakeListening(false, "command-listening");
        this.reportState(session);
        if (session.pendingEnd) this.complete(session, session.pendingEnd);
        else if (session.full) this.complete(session, "max-duration");
    }

    private readonly onPcm = (frame: VoiceEvents["pcm"][0]): void => {
        const session = this.active;
        if (!session || frame.guildId !== session.guildId || session.state === "processing" || session.ambiguous || frame.userId !== session.userId) return;
        session.append(frame);
        if (frame.streamId !== session.currentStreamId) return;
        if (frame.isVoice) {
            session.observeVoice(frame.streamId, frame.audioTimeMs);
            if (session.pendingEnd !== "max-duration") session.pendingEnd = undefined;
            this.armSilence(session);
        }
        if (session.full) this.complete(session, "max-duration");
    };

    private readonly onSpeech = (event: VoiceEvents["speech"][0]): void => {
        const session = this.active;
        if (!session || event.guildId !== session.guildId || event.userId !== session.userId || event.streamId !== session.currentStreamId || session.state === "processing") return;
        if (event.type === "speech-start") session.observeVoice(event.streamId, event.audioTimeMs);
        if (event.type === "speech-end" && event.reason === "silence") {
            session.observeVoice(event.streamId, event.audioTimeMs);
            // The wake phrase's segment ending is not a command ending. Keep the
            // existing wall timer alive while waiting, including after the cue.
            if (session.commandSpeechStarted) this.complete(session, "speech-end");
        }
        if (event.reason === "error" || event.reason === "cancelled") this.end(session, "The owner's speech processing stopped.",
            { state: "failed", reason: event.reason === "error" ? "capture-failed" : "cancelled" });
    };

    private readonly onStreamEnd = (event: VoiceEvents["streamEnd"][0]): void => {
        if (event.reason !== "stream-end") this.onStreamError(event);
        // Discord can stop sending packets without a VAD end. The wall silence timer
        // covers that path and allows the same owner to continue on a fresh stream.
    };

    private readonly onStreamError = (event: VoiceEvents["streamError"][0]): void => {
        const session = this.active;
        // Once captured, STT owns an immutable clip. Errors from older/later receive
        // streams cannot cancel it; departure and connection reset still abort all stages.
        if (session && session.state !== "processing" && event.guildId === session.guildId
            && event.userId === session.userId && event.streamId === session.currentStreamId) {
            this.end(session, "The owner's voice receive or speech processing failed.",
                { state: "failed", reason: "capture-failed" });
        }
    };

    private readonly onStreamStart = (event: VoiceEvents["streamStart"][0]): void => {
        const session = this.active;
        if (session && event.guildId === session.guildId && event.userId === session.userId) session.startStream(event.streamId);
    };

    private readonly onWakeError = (event: VoiceEvents["wakeError"][0]): void => {
        if (event.guildId !== this.controller.connection.joinConfig.guildId) return;
        const reason = "Wake detection failed. Check the bot logs and try again.";
        const session = this.active;
        if (session?.userId === event.userId) {
            // Keyword inference is needed only through arbitration, not after ownership.
            if (session.state === "contention" && event.streamId === session.currentStreamId) {
                this.end(session, reason, { state: "failed", reason: "capture-failed" });
            }
        } else this.failWatch(event.userId, reason);
    };

    private readonly onUserStopped = (event: VoiceEvents["userStopped"][0]): void => {
        if (event.guildId !== this.controller.connection.joinConfig.guildId) return;
        this.failWatch(event.userId, event.reason);
        if (this.active?.userId === event.userId) this.end(this.active, event.reason);
    };

    private readonly onReset = (event: VoiceEvents["reset"][0]): void => {
        if (event.guildId !== this.controller.connection.joinConfig.guildId) return;
        if (this.active) this.end(this.active, event.reason);
        for (const userId of this.watches.keys()) this.failWatch(userId, event.reason);
        for (const userId of this.transcriptWatches.keys()) this.failWatch(userId, event.reason);
        for (const userId of this.commandWatches.keys()) this.failWatch(userId, event.reason);
        if (this.controller.isDestroyed) this.destroy();
    };

    private armSilence(session: VoiceCommandSession, delayMs = this.silenceMs): void {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = setTimeout(() => this.complete(session, "silence-timeout"), delayMs);
        this.silenceTimer.unref();
    }

    private complete(session: VoiceCommandSession, reason: CommandCaptureReason): void {
        if (this.active !== session || session.state === "processing" || session.ambiguous) return;
        if (session.state === "contention") {
            if (session.pendingEnd !== "max-duration") session.pendingEnd = reason;
            return;
        }
        clearTimeout(this.silenceTimer);
        clearTimeout(this.maximumTimer);
        session.acknowledgement?.cancel();
        session.state = "processing";
        const audio = session.takeAudio(reason);
        this.processingTimer = setTimeout(() => this.end(session, "Command processing timed out.", { state: "failed", reason: "timeout" }), this.processingTimeoutMs);
        this.processingTimer.unref();
        this.reportState(session);
        this.reportFeedback(session, { state: "processing" });
        // The processing promise is owned here, never by an async EventEmitter listener.
        void this.process(session, audio);
    }

    private async process(session: VoiceCommandSession, audio: CommandAudio | undefined): Promise<void> {
        let stage: "transcription" | "parsing" | "execution" = "transcription";
        try {
            if (!audio?.pcm.length) {
                this.end(session, "No command audio was captured.", { state: "failed", reason: "no-command" });
                return;
            }
            const voiceChannelId = session.voiceChannelId;
            this.log("captured", { ...this.identity(session), durationMs: audio.durationMs, preRollMs: audio.preRollMs,
                pcmBytes: audio.pcm.length, reason: audio.reason, truncated: audio.truncated });
            const watch = this.watches.get(session.userId);
            if (watch) {
                clearTimeout(watch.timer);
                this.watches.delete(session.userId);
                watch.resolve(audio);
            }
            this.emit("capture", audio);
            const result = this.active === session ? await this.options.processCapture?.(audio, session.abort.signal) : undefined;
            const audioDurationMs = audio.durationMs, truncated = audio.truncated;
            audio = undefined; // Parsing receives text/metadata only; release the owned PCM reference.
            if (result && this.active === session && !session.abort.signal.aborted) {
                const transcript: CommandTranscript = { ...result, ...this.identity(session),
                    audioDurationMs, truncated };
                const watch = this.transcriptWatches.get(session.userId);
                if (watch) {
                    this.transcriptWatches.delete(session.userId);
                    clearTimeout(watch.timer);
                    watch.resolve(transcript);
                }
                this.emit("transcript", transcript);
                const empty = result.status === "empty" || !result.text.trim();
                if (empty) this.reportFeedback(session, { state: "failed",
                    reason: result.rawText.trim() ? "no-command" : "empty-transcript" });
                if (this.options.parseTranscript && this.active === session && !session.abort.signal.aborted) {
                    stage = "parsing";
                    const parsed = await this.options.parseTranscript(transcript, session.abort.signal);
                    if (this.active === session && !session.abort.signal.aborted) {
                        const command: ParsedSessionCommand = { ...parsed, ...this.identity(session), voiceChannelId };
                        const watch = this.commandWatches.get(session.userId);
                        if (watch) {
                            this.commandWatches.delete(session.userId);
                            clearTimeout(watch.timer);
                            watch.resolve(command);
                        }
                        this.emit("command", command);
                        if (command.command.type === "unknown") this.reportFeedback(session, { state: "failed",
                            reason: parsed.reason === "unsupported" ? "unsupported-command"
                                : parsed.reason === "timeout" ? "timeout" : parsed.reason === "truncated" ? "truncated" : "unknown-command" });
                        if (!empty && command.command.type !== "unknown" && this.options.executeCommand
                            && this.active === session && !session.abort.signal.aborted) {
                            // Discovery/extraction have their own bounded execution allowance. Wake
                            // listening remains paused, and owner departure still aborts immediately.
                            clearTimeout(this.processingTimer);
                            this.processingTimer = setTimeout(() => this.end(session, "Command execution timed out.", { state: "failed", reason: "timeout" }), this.executionTimeoutMs);
                            this.processingTimer.unref();
                            stage = "execution";
                            await this.options.executeCommand(command, session.abort.signal, (update) => this.reportFeedback(session, update));
                        }
                    }
                }
            }
            this.end(session, "complete", !this.options.processCapture
                ? { state: "completed", captureOnly: true } : { state: "completed" });
        } catch (error) {
            if (this.active !== session) return;
            console.error("[voice-session] processing failed", { ...this.identity(session), stage }, error);
            this.end(session, error instanceof SttError ? error.message : "Command processing failed.", { state: "failed",
                reason: error instanceof SttError && error.code === "TIMEOUT" ? "timeout"
                    : stage === "transcription" ? "stt-failed" : "processing-failed" });
        }
    }

    private end(session: VoiceCommandSession, reason: string, outcome: VoiceCommandUpdate = { state: "failed", reason: "cancelled" }): void {
        if (this.active !== session) return;
        session.acknowledgement?.cancel();
        this.reportFeedback(session, outcome);
        this.active = undefined;
        for (const timer of [this.contentionTimer, this.silenceTimer, this.maximumTimer, this.processingTimer]) clearTimeout(timer);
        this.contentionTimer = this.silenceTimer = this.maximumTimer = this.processingTimer = undefined;
        session.clearAudio();
        session.abort.abort();
        try {
            for (const userId of session.contenders) this.failWatch(userId, reason);
            const event: SessionEnd = { ...this.identity(session), reason, contenders: [...session.contenders] };
            this.log("ended", { ...event });
            this.emit("end", event);
            this.emit("state", { ...this.identity(session), state: "idle" });
        } finally {
            this.controller.setWakeListening(true, "command-complete");
        }
    }

    private failWatch(userId: string, reason: string): void {
        for (const watches of [this.watches, this.transcriptWatches, this.commandWatches]) {
            const watch = watches.get(userId);
            if (!watch) continue;
            watches.delete(userId);
            clearTimeout(watch.timer);
            watch.reject(new Error(reason));
        }
    }

    private identity(session: VoiceCommandSession): SessionIdentity {
        return { guildId: session.guildId, userId: session.userId, sessionId: session.id };
    }

    private reportState(session: VoiceCommandSession): void {
        const event = { ...this.identity(session), state: session.state };
        this.log("state", event);
        this.emit("state", event);
    }

    private reportFeedback(session: VoiceCommandSession, update: VoiceCommandUpdate): void {
        if (this.active !== session || session.feedbackTerminal) return;
        session.feedbackTerminal = isTerminalFeedback(update);
        // Feedback observers cannot throw into capture, execution, or the cleanup/finally path.
        try { this.emit("feedback", { ...this.identity(session), voiceChannelId: session.voiceChannelId, update }); }
        catch (error) { console.error("[voice-session] feedback observer failed", this.identity(session), error); }
    }

    private log(event: string, details: Record<string, unknown>): void {
        if (this.options.debug) console.log(`[voice-session] ${event}`, details);
    }
}

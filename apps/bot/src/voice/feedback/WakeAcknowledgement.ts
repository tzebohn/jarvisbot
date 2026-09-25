export const DEFAULT_WAKE_ACK_DELAY_MS = 700;

export interface WakeAcknowledgementRequest {
    guildId: string;
    userId: string;
    sessionId: string;
    signal: AbortSignal;
    /** Recheck at the output boundary, including after any asynchronous preparation. */
    canPlay: () => boolean;
    /** Called once, when the first cue frame is about to be sent. */
    onStart: (durationMs: number) => void;
}

export type PlayWakeAcknowledgement = (request: WakeAcknowledgementRequest) => void | Promise<void>;

/** A one-shot UX task owned by one command session, never by keyword inference. */
export class WakeAcknowledgement {
    private timer?: NodeJS.Timeout;
    private ready?: NodeJS.Immediate;
    private readonly abort = new AbortController();
    private readonly cancelFromSession = () => this.cancel();

    constructor(private readonly sessionSignal: AbortSignal, delayMs: number,
        private readonly request: Omit<WakeAcknowledgementRequest, "signal">,
        private readonly play: PlayWakeAcknowledgement) {
        sessionSignal.addEventListener("abort", this.cancelFromSession, { once: true });
        if (sessionSignal.aborted) { this.cancel(); return; }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            // Give queued PCM/I/O a chance to win a deadline tie before requesting audio.
            this.ready = setImmediate(() => {
                this.ready = undefined;
                if (this.abort.signal.aborted || !request.canPlay()) return;
                void this.run();
            });
            this.ready.unref();
        }, delayMs);
        this.timer.unref();
    }

    cancel(): void {
        clearTimeout(this.timer);
        clearImmediate(this.ready);
        this.timer = this.ready = undefined;
        this.sessionSignal.removeEventListener("abort", this.cancelFromSession);
        this.abort.abort();
    }

    private async run(): Promise<void> {
        try { await this.play({ ...this.request, signal: this.abort.signal }); }
        catch (error) {
            // A missing/broken cue must never fail command capture or music playback.
            if (!this.abort.signal.aborted) console.error("[voice-ack] playback failed", {
                guildId: this.request.guildId, sessionId: this.request.sessionId,
            }, error);
        }
    }
}

export function wakeAcknowledgementDelay(value = process.env.VOICE_WAKE_ACK_DELAY_MS): number {
    const delay = value?.trim() ? Number(value) : DEFAULT_WAKE_ACK_DELAY_MS;
    if (!Number.isInteger(delay) || delay <= 0 || delay > 60_000) {
        throw new Error("VOICE_WAKE_ACK_DELAY_MS must be integer milliseconds between 1 and 60000.");
    }
    return delay;
}

import { Readable } from "node:stream";
import { AudioResource } from "@discordjs/voice";
import opus from "@discordjs/opus";

const FRAME_MS = 20;
const FRAME_BYTES = 48_000 * 2 * 2 * FRAME_MS / 1_000;

export interface AudioCueRequest {
    signal: AbortSignal;
    canPlay: () => boolean;
    onStart: (durationMs: number) => void;
}

interface Cue {
    pcm: Buffer;
    request: AudioCueRequest;
    offset: number;
    cancel: () => void;
    finished: () => void;
}

/** Pull-time mixing on Discord's own 20 ms clock: no second player, subscription,
 * resource swap, or ahead-of-time cue buffer. The source keeps its stream, playback
 * position, backpressure and errors. A paused source is never read for a cue.
 */
export class AudioCueResource extends AudioResource {
    musicPaused = false;
    private cue?: Cue;
    private readonly decoder = new opus.OpusEncoder(48_000, 2);
    private readonly outputEncoder = new opus.OpusEncoder(48_000, 2);

    constructor(private readonly source?: AudioResource) {
        super([], [source?.playStream ?? new Readable({ read() {} })], source?.metadata, 0);
        this.started = source?.started ?? true;
    }

    get hasCue(): boolean { return !!this.cue; }
    override get readable(): boolean { return this.source ? this.source.readable : !!this.cue; }
    override get ended(): boolean { return !this.readable; }

    startCue(pcm: Buffer, request: AudioCueRequest, finished: () => void): boolean {
        if (this.cue || request.signal.aborted || !request.canPlay() || !pcm.length || pcm.length % 4) return false;
        const cue: Cue = { pcm, request, offset: 0, cancel: () => this.finishCue(cue), finished };
        this.cue = cue;
        request.signal.addEventListener("abort", cue.cancel, { once: true });
        return true;
    }

    cancelCue(): void { if (this.cue) this.finishCue(this.cue); }

    override read(): Buffer | null {
        // This runs immediately before Discord prepares the packet, not when an
        // encoder's upstream buffer happens to fill. Speech can still cancel here.
        let cue = this.cue;
        if (cue) {
            try {
                if (cue.offset >= cue.pcm.length || cue.request.signal.aborted || !cue.request.canPlay()) {
                    this.finishCue(cue);
                } else if (cue.offset === 0) {
                    cue.request.onStart(Math.ceil(cue.pcm.length / FRAME_BYTES) * FRAME_MS);
                    if (cue.request.signal.aborted || !cue.request.canPlay()) this.finishCue(cue);
                }
            } catch (error) {
                this.finishCue(cue);
                console.error("[voice-ack] cue callback failed", error);
            }
        }
        cue = this.cue;
        // Keep a paused song stationary, even while the transport is sending a cue.
        const packet = this.musicPaused ? null : this.source?.read();
        if (!packet && !cue) return null;
        try {
            // Use one continuous output encoder so switching between music and the
            // mix cannot splice unrelated Opus prediction states. Factories still
            // supply their existing Opus resources; no provider changes are needed.
            const pcm = packet ? this.decoder.decode(packet) : Buffer.alloc(FRAME_BYTES);
            if (pcm.length !== FRAME_BYTES) throw new Error("Expected a 20 ms stereo Opus frame.");
            if (cue) {
                const bytes = Math.min(FRAME_BYTES, cue.pcm.length - cue.offset);
                for (let i = 0; i < bytes; i += 2) {
                    const sample = pcm.readInt16LE(i) + cue.pcm.readInt16LE(cue.offset + i);
                    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
                }
                cue.offset += bytes;
            }
            this.playbackDuration = this.source?.playbackDuration ?? this.playbackDuration + FRAME_MS;
            return this.outputEncoder.encode(pcm);
        } catch (error) {
            // Report stream failures through the AudioPlayer's existing error path.
            this.playStream.destroy(error instanceof Error ? error : new Error("Audio mixing failed."));
            return null;
        }
    }

    private finishCue(cue: Cue): void {
        if (this.cue !== cue) return;
        this.cue = undefined;
        cue.request.signal.removeEventListener("abort", cue.cancel);
        cue.finished();
    }
}

import { PCM_BYTES_PER_SECOND } from "../receive/SpeakerStream.js";

/** Fixed-size ring of original stereo s16le PCM. Snapshots never alias storage. */
export class AudioBuffer {
    private readonly storage: Buffer;
    private position = 0;
    private length = 0;

    constructor(durationMs = 1_000) {
        if (!Number.isInteger(durationMs) || durationMs < 20 || durationMs > 10_000) {
            throw new Error("Rolling audio duration must be 20–10000 milliseconds.");
        }
        this.storage = Buffer.alloc(PCM_BYTES_PER_SECOND * durationMs / 1_000);
    }

    get size(): number { return this.length; }
    get capacity(): number { return this.storage.length; }
    get durationMs(): number { return this.length / PCM_BYTES_PER_SECOND * 1_000; }

    append(pcm: Buffer): void {
        if (pcm.length % 4 !== 0) throw new Error("Rolling PCM must contain whole stereo sample frames.");
        if (pcm.length >= this.storage.length) {
            pcm.copy(this.storage, 0, pcm.length - this.storage.length);
            this.position = 0;
            this.length = this.storage.length;
            return;
        }
        const first = Math.min(pcm.length, this.storage.length - this.position);
        pcm.copy(this.storage, this.position, 0, first);
        pcm.copy(this.storage, 0, first);
        this.position = (this.position + pcm.length) % this.storage.length;
        this.length = Math.min(this.length + pcm.length, this.storage.length);
    }

    snapshot(): Buffer {
        const result = Buffer.alloc(this.length);
        const start = (this.position - this.length + this.storage.length) % this.storage.length;
        const first = Math.min(this.length, this.storage.length - start);
        this.storage.copy(result, 0, start, start + first);
        this.storage.copy(result, first, 0, this.length - first);
        return result;
    }

    clear(): void {
        this.storage.fill(0);
        this.position = 0;
        this.length = 0;
    }
}

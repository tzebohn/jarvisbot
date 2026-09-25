import { Transform, type TransformCallback } from "node:stream";
import opus from "@discordjs/opus";

export const PCM_FORMAT = {
    sampleRate: 48_000, channels: 2, bitsPerSample: 16, signed: true, endianness: "little",
} as const;
export const PCM_BYTES_PER_SECOND = PCM_FORMAT.sampleRate * PCM_FORMAT.channels * PCM_FORMAT.bitsPerSample / 8;

/** One decoder per speaker/utterance: Opus packets in, signed 16-bit LE PCM out. */
export class SpeakerStream extends Transform {
    private decoder?: opus.OpusEncoder = new opus.OpusEncoder(PCM_FORMAT.sampleRate, PCM_FORMAT.channels);

    constructor() {
        super({ writableObjectMode: true });
    }

    override _transform(packet: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        try {
            if (!Buffer.isBuffer(packet) || !this.decoder) {
                throw new Error("Expected an Opus packet for an active speaker decoder.");
            }
            callback(null, this.decoder.decode(packet));
        } catch (error) {
            callback(error instanceof Error ? error : new Error("Opus decoding failed."));
        }
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        // @discordjs/opus has no explicit dispose API; release the native wrapper for GC.
        this.decoder = undefined;
        callback(error);
    }
}

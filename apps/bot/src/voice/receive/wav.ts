import { PCM_BYTES_PER_SECOND, PCM_FORMAT } from "./SpeakerStream.js";

/** Wrap a bounded diagnostic PCM sample without transcoding or writing to disk. */
export function pcmToWav(pcm: Buffer): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // Uncompressed PCM.
    header.writeUInt16LE(PCM_FORMAT.channels, 22);
    header.writeUInt32LE(PCM_FORMAT.sampleRate, 24);
    header.writeUInt32LE(PCM_BYTES_PER_SECOND, 28);
    header.writeUInt16LE(PCM_FORMAT.channels * PCM_FORMAT.bitsPerSample / 8, 32);
    header.writeUInt16LE(PCM_FORMAT.bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

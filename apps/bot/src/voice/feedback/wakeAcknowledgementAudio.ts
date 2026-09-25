import { readFile } from "node:fs/promises";

export const WAKE_ACKNOWLEDGEMENT_URL = new URL("../../../assets/voice/wake-acknowledgement.wav", import.meta.url);

/** Load the supplied short PCM WAV once. Both src/ and dist/ resolve to bot/assets/. */
export async function loadWakeAcknowledgement(): Promise<Buffer> {
    const wav = await readFile(WAKE_ACKNOWLEDGEMENT_URL);
    if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE"
        || wav.readUInt32LE(4) + 8 !== wav.length) throw new Error("Invalid wake acknowledgement WAV.");
    let validFormat = false;
    let pcm: Buffer | undefined;
    for (let offset = 12; offset + 8 <= wav.length;) {
        const type = wav.toString("ascii", offset, offset + 4);
        const size = wav.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (start + size > wav.length) throw new Error("Truncated wake acknowledgement WAV.");
        if (type === "fmt ") validFormat = size >= 16 && wav.readUInt16LE(start) === 1
            && wav.readUInt16LE(start + 2) === 2 && wav.readUInt32LE(start + 4) === 48_000
            && wav.readUInt32LE(start + 8) === 192_000 && wav.readUInt16LE(start + 12) === 4
            && wav.readUInt16LE(start + 14) === 16;
        if (type === "data") pcm = wav.subarray(start, start + size);
        offset = start + size + (size % 2);
    }
    if (!validFormat || !pcm?.length || pcm.length % 4 || pcm.length > 5 * 192_000) {
        throw new Error("Wake acknowledgement must be a PCM WAV: 48 kHz, stereo, signed 16-bit LE, at most 5 seconds.");
    }
    return pcm;
}

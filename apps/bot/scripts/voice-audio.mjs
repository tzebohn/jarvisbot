import { spawnSync } from "node:child_process";
import opus from "@discordjs/opus";

export const MAX_AUDIO_BYTES = 60 * 192_000;
// Offline experiments only; these filters are not enabled in the receive or STT pipeline.
export const AUDIO_FILTERS = Object.freeze({ raw: null, highpass: "highpass=f=80",
    denoise: "highpass=f=80,afftdn=nr=6:nf=-50:tn=1" });

function ffmpeg(args, input) {
    const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-f", "s16le", "pipe:1"],
        { input, maxBuffer: MAX_AUDIO_BYTES + 192_000, timeout: 15_000 });
    if (result.error || result.status !== 0) throw new Error("Could not process diagnostic audio. Check FFmpeg, its highpass/afftdn filters, and the WAV input.");
    return result.stdout;
}

export function validatePcm(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.length < 3840 || pcm.length > MAX_AUDIO_BYTES || pcm.length % 4) {
        throw new Error("Use a WAV between 20 ms and 60 seconds (48 kHz stereo s16le after decoding); clips are never silently truncated.");
    }
}

export function decodeWav(wav) {
    // Read a little beyond the limit so an overlong sample fails rather than appearing to pass.
    const pcm = ffmpeg(["-f", "wav", "-i", "pipe:0", "-t", "60.02", "-ar", "48000", "-ac", "2"], wav);
    validatePcm(pcm);
    return pcm;
}

export function preprocessAudio(pcm, mode) {
    validatePcm(pcm);
    if (!Object.hasOwn(AUDIO_FILTERS, mode)) throw new Error("Unknown preprocessing mode.");
    if (mode === "raw") return pcm;
    const processed = ffmpeg(["-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", "-af", AUDIO_FILTERS[mode]], pcm);
    if (processed.length !== pcm.length) throw new Error("Preprocessing changed the sample count; this would invalidate the paired comparison.");
    return processed;
}

export function opusRoundTrip(pcm) {
    const encoder = new opus.OpusEncoder(48_000, 2);
    const decoder = new opus.OpusEncoder(48_000, 2);
    const frames = [];
    for (let offset = 0; offset < pcm.length; offset += 3840) {
        const frame = Buffer.alloc(3840);
        pcm.copy(frame, 0, offset, Math.min(offset + 3840, pcm.length));
        frames.push(Buffer.from(decoder.decode(encoder.encode(frame))));
    }
    // Don't count final codec frame padding as additional negative-test exposure.
    return Buffer.concat(frames).subarray(0, pcm.length);
}

/** Signal measurements, not estimates of SNR, intelligibility, or recognition confidence. */
export function audioQuality(pcm) {
    validatePcm(pcm);
    const count = pcm.length / 4;
    const energy = [0, 0, 0], sum = [0, 0, 0], peak = [0, 0, 0], clipped = [0, 0, 0];
    for (let offset = 0; offset < pcm.length; offset += 4) {
        const left = pcm.readInt16LE(offset), right = pcm.readInt16LE(offset + 2);
        const values = [left, right, Math.trunc((left + right) / 2)];
        for (let channel = 0; channel < 3; channel++) {
            const value = values[channel] / 32768;
            energy[channel] += value * value;
            sum[channel] += value;
            peak[channel] = Math.max(peak[channel], Math.abs(value));
            if (values[channel] === -32768 || values[channel] === 32767) clipped[channel]++;
        }
    }
    const channels = energy.map((squares, channel) => ({ rmsDbfs: squares ? 10 * Math.log10(squares / count) : null,
        peak: peak[channel], dcOffset: sum[channel] / count, clippedFraction: clipped[channel] / count }));
    return { durationMs: pcm.length / 192, left: channels[0], right: channels[1], mono: channels[2] };
}

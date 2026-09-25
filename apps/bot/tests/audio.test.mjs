import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import opus from "@discordjs/opus";
import { Readable } from "node:stream";
import { createAudioResource } from "@discordjs/voice";
import { createTestAudioResource } from "../src/music/testAudio.ts";
import { YtDlpAudio } from "../src/music/providers/youtube/YtDlpAudio.ts";
import { SpeakerStream } from "../src/voice/receive/SpeakerStream.ts";
import { pcmToWav } from "../src/voice/receive/wav.ts";

test("received Opus decodes to PCM and its diagnostic WAV plays through real FFmpeg", { timeout: 10_000 }, async () => {
    const packet = new opus.OpusEncoder(48_000, 2).encode(Buffer.alloc(3840));
    const decoder = new SpeakerStream();
    const decoded = [];
    Readable.from([packet, packet, packet]).pipe(decoder);
    for await (const pcm of decoder) decoded.push(pcm);
    assert.equal(decoder.destroyed, true);
    const pcm = Buffer.concat(decoded);
    assert.equal(pcm.length, 3 * 3840);
    const resource = createAudioResource(Readable.from([pcmToWav(pcm)]));
    try {
        const [encoded] = await once(resource.playStream, "data", { signal: AbortSignal.timeout(5_000) });
        assert.ok(encoded.length > 0);
    } finally {
        resource.playStream.destroy();
    }
});

test("the installed native Opus encoder can encode Discord's PCM format", () => {
    const encoder = new opus.OpusEncoder(48_000, 2);
    const packet = encoder.encode(Buffer.alloc(960 * 2 * 2));
    assert.ok(Buffer.isBuffer(packet));
    assert.ok(packet.length > 0);
});

test("the supplied local MP3 decodes into Opus packets", { timeout: 10_000 }, async () => {
    const resource = createTestAudioResource();
    try {
        const [packet] = await once(resource.playStream, "data", { signal: AbortSignal.timeout(5_000) });
        assert.ok(Buffer.isBuffer(packet));
        assert.ok(packet.length > 0);
    } finally {
        resource.playStream.destroy();
    }
});

test("extractor stdout passes through real FFmpeg to Discord Opus and cleans up", { timeout: 10_000 }, async () => {
    const path = fileURLToPath(new URL("../assets/test.mp3", import.meta.url));
    let child;
    const audio = new YtDlpAudio("fixture", () => {
        child = spawn(process.execPath, ["-e", `require('fs').createReadStream(${JSON.stringify(path)}).pipe(process.stdout)`],
            { stdio: "pipe", windowsHide: true });
        return child;
    });
    const resource = await audio.getAudio("abcdefghijk");
    try {
        const [packet] = await once(resource.playStream, "data", { signal: AbortSignal.timeout(5_000) });
        assert.ok(Buffer.isBuffer(packet));
        assert.ok(packet.length > 0);
    } finally {
        resource.playStream.destroy();
        await once(resource.playStream, "close");
        assert.ok(child.stdout.destroyed);
    }
});

test("normal producer exit does not truncate buffered audio in the real FFmpeg pipeline", { timeout: 10_000 }, async () => {
    let packets = 0;
    let packetsAtExit;
    const audio = new YtDlpAudio("fixture", () => {
        const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "sine=frequency=440:sample_rate=48000:duration=2", "-ac", "2", "-f", "wav", "pipe:1"],
        { stdio: "pipe", windowsHide: true });
        child.once("exit", (code) => {
            assert.equal(code, 0);
            packetsAtExit = packets;
        });
        return child;
    });
    const resource = await audio.getAudio("abcdefghijk");
    try {
        for await (const packet of resource.playStream) {
            assert.ok(packet.length > 0);
            packets++;
            await delay(5); // Apply backpressure rather than just checking the first packet.
        }
        assert.ok(packets >= 100 && packets <= 102, `expected all 2 seconds of audio, got ${packets} frames`);
        assert.ok(packetsAtExit < packets, "buffered audio must outlive the producer");
        assert.equal(resource.playStream.readableEnded, true);
    } finally {
        resource.playStream.destroy();
    }
});

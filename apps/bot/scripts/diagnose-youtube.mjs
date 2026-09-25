import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import { YtDlpAudio } from "../src/music/providers/youtube/YtDlpAudio.ts";
import { parseYouTubeInput } from "../src/music/providers/youtube/youtubeUrl.ts";
import { describePlaybackError } from "../src/music/playbackDiagnostics.ts";

const id = parseYouTubeInput(process.argv[2] ?? "");
if (!id) {
    throw new Error("Usage: pnpm --filter bot diagnose:youtube <YouTube-video-URL> [seconds=90]");
}
const seconds = Number(process.argv[3] ?? 90);
if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("The duration must be a positive number of seconds.");
}
const start = Date.now();
const log = (event, detail = "") => console.log(`[${((Date.now() - start) / 1000).toFixed(2)}s] ${event}`, detail);
process.env.MUSIC_DEBUG ??= "1";
const controller = new AbortController();
let resource;
try {
    const audio = new YtDlpAudio(process.env.YT_DLP_PATH?.trim() || "yt-dlp");
    resource = await audio.getAudio(id, controller.signal);
    log("resource created", resource.edges.map((edge) => edge.type));
    let failure;
    resource.playStream.on("error", (error) => {
        failure = error;
        log("playStream error", describePlaybackError(error));
    });
    resource.playStream.on("end", () => log("playStream end"));
    resource.playStream.on("close", () => log("playStream close"));
    let packets = 0;
    let misses = 0;
    let nextFrameAt = Date.now();
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline && !resource.playStream.destroyed) {
        // Read one 20 ms Opus frame per tick, like Discord. Draining as fast as
        // possible would miss real-time backpressure and process-lifetime bugs.
        if (resource.playStream.read()) {
            packets++;
            if (packets % 500 === 0) log("playback progress", { audioSeconds: packets / 50, misses });
        } else {
            misses++;
        }
        nextFrameAt += 20;
        await delay(Math.max(0, nextFrameAt - Date.now()));
    }
    log("diagnostic complete", { audioSeconds: packets / 50, misses, ended: resource.playStream.readableEnded });
    if (failure) throw failure;
} catch (error) {
    log("diagnostic failed", describePlaybackError(error));
    process.exitCode = 1;
} finally {
    controller.abort();
    resource?.playStream.destroy();
}

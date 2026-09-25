import { spawn } from "node:child_process";
import { createAudioResource, StreamType, type AudioResource } from "@discordjs/voice";
import { ProviderError } from "../ProviderError.js";
import { YOUTUBE_VIDEO_ID, youtubeUrl } from "./youtubeUrl.js";
import { logPlaybackError, playbackDebug, sanitizeDiagnostic } from "../../playbackDiagnostics.js";

/** Stream one video to FFmpeg, without saving media or caching expiring audio URLs. */
export class YtDlpAudio {
    constructor(
        private readonly executable = "yt-dlp",
        private readonly launch: typeof spawn = spawn,
        private readonly startupTimeoutMs = 30_000,
    ) {}

    getAudio(id: string, signal?: AbortSignal): Promise<AudioResource> {
        if (!YOUTUBE_VIDEO_ID.test(id)) {
            return Promise.reject(this.error("Invalid YouTube video ID.", "INVALID_INPUT"));
        }
        if (signal?.aborted) {
            return Promise.reject(this.error("YouTube playback was cancelled."));
        }
        return new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const context = () => ({ videoId: id, elapsedMs: Date.now() - startedAt });
            let child: ReturnType<typeof spawn>;
            try {
                child = this.launch(this.executable, [
                    "--ignore-config", "--no-playlist", "--no-progress", "--quiet",
                    "--no-cache-dir", "--js-runtimes", `node:${process.execPath}`,
                    // A default YouTube HTTP chunk can be 10 MiB. Real-time voice
                    // backpressure can leave that CDN response open for minutes.
                    // Small byte ranges finish promptly and resume at exact offsets.
                    "--http-chunk-size", "256K",
                    "--socket-timeout", "15", "--retries", "3", "--fragment-retries", "3",
                    "--format", "bestaudio[protocol=https]/bestaudio", "--output", "-", "--", youtubeUrl(id),
                ], { shell: false, windowsHide: true, stdio: "pipe" });
            } catch (cause) {
                const error = this.error("Could not start yt-dlp. Install it or set YT_DLP_PATH.", "UNAVAILABLE", cause);
                logPlaybackError("yt-dlp spawn failed", error, context());
                reject(error);
                return;
            }
            const stdout = child.stdout!;
            let resource: AudioResource | undefined;
            let closed = false;
            let stderr = "";
            let stderrTruncated = false;
            const stderrTail = () => {
                // If the bounded tail cuts through a line (possibly a signed URL),
                // drop that incomplete line before exposing any diagnostic text.
                const text = stderrTruncated ? stderr.slice(stderr.indexOf("\n") + 1) : stderr;
                return sanitizeDiagnostic(stderrTruncated && !stderr.includes("\n") ? "[oversized stderr line omitted]" : text).trim();
            };
            const timer = setTimeout(() => fail(this.error("YouTube audio extraction timed out. Try again later.", "UNAVAILABLE")),
                this.startupTimeoutMs);
            const cleanup = (reason: string) => {
                if (closed) {
                    return;
                }
                closed = true;
                playbackDebug("YouTube audio cleanup", { ...context(), reason });
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                stdout.removeListener("readable", onReadable);
                stdout.destroy();
                child.stdin?.destroy();
                child.stderr?.destroy();
                if (child.exitCode === null && !child.killed) {
                    child.kill();
                }
            };
            const fail = (error: ProviderError) => {
                if (closed) {
                    return;
                }
                logPlaybackError("YouTube audio pipeline failed", error, {
                    ...context(), exitCode: child.exitCode, stderr: stderrTail(),
                });
                cleanup("failure");
                resource?.playStream.destroy(error);
                reject(error);
            };
            const onAbort = () => {
                // Stop/skip/leave is deliberate disposal, not a stream failure.
                cleanup("cancelled");
                resource?.playStream.destroy();
                reject(this.error("YouTube playback was cancelled."));
            };
            const onReadable = () => {
                if (closed || !stdout.readableLength) {
                    return;
                }
                stdout.removeListener("readable", onReadable);
                try {
                    resource = createAudioResource(stdout, { inputType: StreamType.Arbitrary });
                    // Capture decoder/demuxer errors even during the handoff window.
                    // The player's listener still receives the original stream error.
                    resource.playStream.on("error", (cause) => {
                        if (!closed) {
                            fail(this.error("The YouTube decoding pipeline failed. Check the bot logs.", "NOT_PLAYABLE", cause));
                        }
                    });
                    resource.playStream.once("close", () => cleanup("playStream close"));
                    resource.playStream.once("end", () => cleanup("playStream end"));
                    clearTimeout(timer);
                    playbackDebug("YouTube audio resource ready", context());
                    resolve(resource);
                } catch (cause) {
                    fail(this.error("Could not decode YouTube audio. Check that FFmpeg is installed.", "UNAVAILABLE", cause));
                }
            };
            child.on("spawn", () => playbackDebug("yt-dlp spawned", { ...context(), pid: child.pid }));
            child.on("error", (cause) => fail(this.error("Could not run yt-dlp. Install it or check YT_DLP_PATH.", "UNAVAILABLE", cause)));
            child.on("exit", (code, signal) => playbackDebug("yt-dlp exit", { ...context(), code, signal, disposed: closed }));
            child.on("close", (code, signal) => {
                playbackDebug("yt-dlp close", { ...context(), code, signal, disposed: closed, stderr: stderrTail() });
                if (code !== 0 || !resource) {
                    const cause = new Error(`yt-dlp exited with code=${code}, signal=${signal ?? "none"}.`
                        + (!resource ? " No audio was produced." : "") + (stderrTail() ? `\n${stderrTail()}` : ""));
                    fail(this.error("YouTube audio download failed. Check the bot logs for yt-dlp's error.", "NOT_PLAYABLE", cause));
                }
                // Exit 0 is download completion, NOT playback completion. FFmpeg
                // and the Opus stream may still hold many seconds of queued audio.
            });
            stdout.on("error", (cause) => fail(this.error("The YouTube audio stream failed.", "NOT_PLAYABLE", cause)));
            child.stdin?.on("error", () => {});
            child.stdin?.end();
            // Drain stderr even under audio backpressure. Retain only a bounded
            // tail, and sanitize it at the logging boundary, never for Discord.
            child.stderr?.on("error", () => {});
            child.stderr?.setEncoding("utf8");
            child.stderr?.on("data", (chunk: string) => {
                stderr += chunk;
                if (stderr.length > 16_384) {
                    stderr = stderr.slice(-16_384);
                    stderrTruncated = true;
                }
            });
            stdout.on("readable", onReadable);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) {
                onAbort();
            }
        });
    }

    private error(message: string, code: "INVALID_INPUT" | "NOT_PLAYABLE" | "UNAVAILABLE" = "NOT_PLAYABLE", cause?: unknown): ProviderError {
        return new ProviderError(message, { provider: "youtube", operation: "getAudio", code, cause });
    }
}

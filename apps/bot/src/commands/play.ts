import type { MusicPlayer } from "../music/MusicPlayer.js";
import type { MusicService } from "../music/MusicService.js";
import { ProviderError } from "../music/providers/ProviderError.js";
import { logPlaybackError } from "../music/playbackDiagnostics.js";
import { trackLabel } from "./formatTrack.js";
import { assertCommandCurrent, MusicCommandAccessError, requireMusicMember, type MusicCommandContext } from "./MusicCommandContext.js";
import type { MusicCommandUpdate } from "../music/MusicCommandFeedback.js";

export async function handlePlay(
    context: MusicCommandContext,
    query: string,
    player: MusicPlayer,
    music?: MusicService,
    requestVersion = player.requestVersion,
): Promise<void> {
    const reply = async (content: string, update: MusicCommandUpdate) => {
        assertCommandCurrent(context);
        if (context.feedback) context.feedback(update);
        else await context.reply(content);
    };
    const authorize = () => requireMusicMember(context, player, "Join my voice channel before requesting music.");
    let accepted = false;
    try {
        await authorize();
        if (!query.trim() || query.length > 500) {
            await reply("Usage: `!play <song name or YouTube video URL>` (1–500 characters).", { state: "failed", reason: "no-results" });
            return;
        }
        if (!music) {
            await reply("YouTube playback is not configured. Set YOUTUBE_API_KEY and restart the bot.", { state: "failed", reason: "music-unavailable" });
            return;
        }
        context.feedback?.({ state: "searching", query });
        const result = await music.play(player, query, (error) => {
            if (accepted) {
                if (context.playbackFailed) { context.playbackFailed(); return; }
                void context.notify("YouTube playback failed and the queue was cleared. "
                    + (error instanceof ProviderError ? error.message : "Check the bot logs for the underlying error."))
                    .catch(() => console.error("Could not report the YouTube playback failure to Discord."));
            }
        }, requestVersion, { signal: context.signal, beforeCommit: authorize,
            requestedBy: { guildId: context.guild.id, userId: context.userId } });
        accepted = true;
        if (result.status === "no-results") {
            await reply("I couldn't find an available YouTube video. Try a song and artist, or a different video URL.", { state: "failed", reason: "no-results" });
        } else if ("track" in result) {
            await reply(`${result.status === "playing" ? "Playing" : "Queued"}: **${trackLabel(result.track)}**\n<${result.track.url}>`,
                { state: result.status, track: result.track });
        }
    } catch (error) {
        assertCommandCurrent(context);
        if (error instanceof MusicCommandAccessError) {
            await reply(error.message, { state: "failed", reason: "voice-access" });
        } else if (error instanceof ProviderError) {
            logPlaybackError("YouTube request failed", error, { guildId: context.guild.id });
            await reply(error.message, { state: "failed", reason: error.operation === "getAudio" ? "playback-failed" : "search-failed" });
        } else {
            logPlaybackError("Music request failed", error, { guildId: context.guild.id });
            await reply("Playback could not start or was cancelled. Check the voice connection and try again.",
                { state: "failed", reason: player.isDestroyed || player.requestVersion !== requestVersion ? "cancelled" : "playback-failed" });
        }
    }
}

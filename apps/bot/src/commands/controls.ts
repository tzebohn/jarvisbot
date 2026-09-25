import type { MusicPlayer } from "../music/MusicPlayer.js";
import { ProviderError } from "../music/providers/ProviderError.js";
import { durationLabel, queueItemLabel, trackLabel } from "./formatTrack.js";
import { assertCommandCurrent, MusicCommandAccessError, requireMusicMember, type MusicCommandContext } from "./MusicCommandContext.js";
import { logPlaybackError } from "../music/playbackDiagnostics.js";

export const musicControlCommands = ["pause", "resume", "skip", "stop", "queue", "nowplaying", "shuffle", "loop"];

export async function handleMusicControl(context: MusicCommandContext, command: string, args: string, player?: MusicPlayer): Promise<void> {
    const reply = (content: string) => { assertCommandCurrent(context); return context.reply(content); };
    assertCommandCurrent(context);
    const readOnly = command === "queue" || command === "nowplaying";
    if (player && (!readOnly || context.requireVoiceForRead)) {
        try { await requireMusicMember(context, player, "Join my voice channel before using music controls."); }
        catch (error) {
            if (!(error instanceof MusicCommandAccessError)) throw error;
            if (context.feedback) { context.feedback({ state: "failed", reason: "voice-access" }); return; }
            await reply(error.message);
            return;
        }
    }
    if (command === "nowplaying") {
        const track = player?.currentTrack;
        await reply(!player?.current ? "Nothing is currently playing."
            : `Now playing (${player.playbackState}): ${track
                ? `**${trackLabel(track)}**\nDuration: ${durationLabel(track.duration)}\n<${track.url}>`
                : "Local test audio"}\nLoop: ${player.loopMode}`);
        return;
    }
    if (command === "queue") {
        const queue = player?.queue ?? [];
        const page = args ? Number(args) : 1;
        const pages = Math.max(1, Math.ceil(queue.length / 5));
        if ((args && !/^[1-9]\d*$/.test(args)) || !Number.isSafeInteger(page) || page > pages) {
            await reply(`Usage: \`!queue [page]\`. Choose a page from 1 to ${pages}.`);
            return;
        }
        const current = player?.current
            ? `Current (${player.playbackState}): ${queueItemLabel(player.current)}` : "Nothing is currently playing.";
        const offset = (page - 1) * 5;
        const lines = queue.slice(offset, offset + 5).map((item, index) => `${offset + index + 1}. ${queueItemLabel(item)}`);
        await reply(`${current}\nLoop: ${player?.loopMode ?? "off"}\n${queue.length
            ? `Up next (${queue.length} tracks, page ${page}/${pages}):\n${lines.join("\n")}`
            : "The queue is empty."}${pages > 1 ? "\nUse `!queue <page>` to see more." : ""}`);
        return;
    }
    if (!player || player.isDestroyed) {
        await reply("Nothing is playing. I'm not connected to voice; use `!play <song name>` or `!join`.");
        return;
    }
    if (command === "stop") {
        player.stop();
        await reply("Stopped playback and cleared the queue. Pending play requests were cancelled; I'll stay in voice.");
        return;
    }
    if (!player.isVoiceReady) {
        await reply("The voice connection is not ready. Try again shortly or use `!leave` and `!join`.");
        return;
    }
    if (command === "loop") {
        const mode = args.toLowerCase();
        if (!mode) {
            await reply(`Loop mode: **${player.loopMode}**. Use \`!loop off\`, \`!loop song\`, or \`!loop queue\`.`);
        } else if (mode !== "off" && mode !== "song" && mode !== "queue") {
            await reply("Usage: `!loop off`, `!loop song`, or `!loop queue`.");
        } else if (mode !== "off" && !player.current) {
            await reply("Nothing is currently playing. Use `!play` before enabling looping.");
        } else {
            player.setLoopMode(mode);
            await reply(`Loop mode set to **${mode}**.`);
        }
    } else if (command === "shuffle") {
        await reply(player.shuffle() ? `Shuffled ${player.queue.length} queued tracks. The current track is unchanged.`
            : player.queue.length === 0 ? "The queue is empty. Add tracks with `!play` before shuffling."
            : "There is only one queued track; add another before shuffling.");
    } else if (command === "pause") {
        await reply(!player.current ? "Nothing is currently playing."
            : player.pause() ? "Paused the current track."
            : player.playbackState === "paused" ? "The current track is already paused."
            : "The track is still loading. Try pausing again once playback starts.");
    } else if (command === "resume") {
        await reply(!player.current ? "Nothing is currently playing."
            : player.resume() ? "Resumed the current track."
            : player.playbackState === "loading" ? "The track is still loading."
            : "The current track is not paused.");
    } else if (command === "skip") {
        try {
            const skipped = await player.skip(context.signal);
            await reply(!skipped ? "Nothing is currently playing."
                : player.current ? "Skipped the current track. Playing the next queued track."
                : "Skipped the current track. The queue is now empty.");
        } catch (error) {
            assertCommandCurrent(context);
            logPlaybackError("Next track failed", error, { guildId: context.guild.id });
            if (context.feedback) { context.feedback({ state: "failed", reason: "playback-failed" }); return; }
            await reply(error instanceof ProviderError ? error.message
                : "The next track could not start or playback was cancelled. Check the voice connection and try `!play` again.");
        }
    }
}

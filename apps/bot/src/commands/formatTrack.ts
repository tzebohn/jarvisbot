import { escapeMarkdown } from "discord.js";
import type { Track } from "@discord-music-platform/shared";
import type { PlaybackItem } from "../music/MusicPlayer.js";

export function trackLabel(track: Track, titleLimit = 150, artistLimit = 100): string {
    return `${escapeMarkdown(track.title.slice(0, titleLimit))} — ${escapeMarkdown(track.artist.slice(0, artistLimit))}`;
}

export function durationLabel(seconds?: number): string {
    if (seconds === undefined) return "duration unknown";
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    return minutes >= 60
        ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
        : `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function queueItemLabel(item: PlaybackItem): string {
    return item.track ? `**${trackLabel(item.track, 80, 40)}** (${durationLabel(item.track.duration)})` : "Local test audio";
}

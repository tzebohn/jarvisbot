import type { Track } from "@discord-music-platform/shared";

/** Presentation-independent outcomes from the shared music handlers. */
export type MusicFailure = "no-results" | "search-failed" | "playback-failed" | "music-unavailable" | "cancelled" | "voice-access";
export type MusicCommandUpdate =
    | { state: "searching"; query: string }
    | { state: "playing" | "queued"; track: Track }
    | { state: "failed"; reason: MusicFailure }
    | { state: "completed"; content?: string };

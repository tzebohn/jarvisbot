import type { Track } from "@discord-music-platform/shared";
import type { AudioResource } from "@discordjs/voice";
import type { MusicProvider } from "./MusicProvider.js";

export interface PlaybackProvider extends MusicProvider {
    /**
     * Resolve a fresh playable resource for a normalized track. Track.url is
     * a discovery URL, not necessarily audio, and track.source may differ
     * from this provider's source. Failures reject with ProviderError.
     *
     * Resolve just before playback: the caller owns the returned resource
     * until handing it to the player, and must destroy its playStream if unused.
     * Honor the optional signal during extraction and release owned streams/processes
     * on cancellation or when the returned playStream is destroyed.
     */
    getAudio(track: Track, signal?: AbortSignal): Promise<AudioResource>;
}

export function isPlaybackProvider(provider: MusicProvider): provider is PlaybackProvider {
    return "getAudio" in provider && typeof provider.getAudio === "function";
}

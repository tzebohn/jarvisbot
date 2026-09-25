import type { MusicSource, TrackCandidate } from "@discord-music-platform/shared";

export interface MusicProvider {
    readonly source: MusicSource;

    /**
     * Return normalized candidates, not a selected track. No matches is [].
     * Failures reject with ProviderError; providers map their SDK/API fields
     * to the common metadata shape before normalizing candidates.
     */
    search(query: string): Promise<TrackCandidate[]>;
}

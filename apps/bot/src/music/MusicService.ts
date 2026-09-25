import { MusicPlayer } from "./MusicPlayer.js";
import { TrackResolver } from "./TrackResolver.js";
import type { PlaybackProvider } from "./providers/PlaybackProvider.js";
import { abortable } from "./abortable.js";

export interface MusicPlayRequest {
    signal?: AbortSignal;
    beforeCommit?: () => Promise<void>;
    requestedBy?: { guildId: string; userId: string };
}

export class MusicService {
    private readonly resolver: TrackResolver;

    constructor(private readonly provider: PlaybackProvider) {
        this.resolver = new TrackResolver(provider);
    }

    async play(player: MusicPlayer, query: string, onError?: (error: Error) => void, requestVersion = player.requestVersion,
        request: MusicPlayRequest = {}) {
        const assertRequest = () => {
            request.signal?.throwIfAborted();
            if (player.isDestroyed || player.requestVersion !== requestVersion) {
                throw new Error("Playback was stopped or replaced.");
            }
        };
        assertRequest();
        const resolution = await abortable(this.resolver.resolve(query), request.signal);
        assertRequest();
        if (resolution.status !== "resolved") {
            return resolution;
        }
        if (request.beforeCommit) await abortable(request.beforeCommit(), request.signal);
        assertRequest();
        const track = resolution.candidate.track;
        const status = await player.play({
            track, createResource: (signal) => this.provider.getAudio(track, signal), onError, requestedBy: request.requestedBy,
        }, request.signal);
        return { status, track, candidates: resolution.candidates };
    }
}

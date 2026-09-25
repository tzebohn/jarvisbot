import type { TrackCandidate } from "@discord-music-platform/shared";
import type { MusicProvider } from "./providers/MusicProvider.js";
import { playbackDebug } from "./playbackDiagnostics.js";

export type TrackResolution =
    | { status: "resolved"; candidate: TrackCandidate; candidates: TrackCandidate[] }
    | { status: "no-results"; candidates: TrackCandidate[] };

/** Phase 4: select from scored candidates from a single discovery provider. */
export class TrackResolver {
    constructor(private readonly provider: MusicProvider) {}

    async resolve(query: string): Promise<TrackResolution> {
        const candidates = (await this.provider.search(query))
            // Providers validate availability; confidence ranks matches, including zero-score results.
            .filter(({ confidence }) => Number.isFinite(confidence) && confidence >= 0 && confidence <= 1)
            .sort((a, b) => b.confidence - a.confidence);
        const best = candidates[0];
        if (!best) {
            return { status: "no-results", candidates };
        }
        playbackDebug("Track selected", {
            provider: best.provider, trackId: best.track.id, confidence: best.confidence, candidateCount: candidates.length,
        });
        return { status: "resolved", candidate: best, candidates };
    }
}

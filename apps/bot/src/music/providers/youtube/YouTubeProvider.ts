import type { Track, TrackCandidate } from "@discord-music-platform/shared";
import type { AudioResource } from "@discordjs/voice";
import type { PlaybackProvider } from "../PlaybackProvider.js";
import { ProviderError, toProviderError } from "../ProviderError.js";
import { scoreCandidate } from "../../scoreCandidate.js";
import { YouTubeClient, object, youtubeResponseError } from "./YouTubeClient.js";
import { normalizeYouTubeVideo } from "./normalizeYouTubeVideo.js";
import { parseYouTubeInput, YOUTUBE_VIDEO_ID, youtubeUrl } from "./youtubeUrl.js";
import { YtDlpAudio } from "./YtDlpAudio.js";

export class YouTubeProvider implements PlaybackProvider {
    readonly source = "youtube";

    constructor(
        private readonly client: YouTubeClient,
        private readonly audio: Pick<YtDlpAudio, "getAudio"> = new YtDlpAudio(),
    ) {}

    async search(query: string): Promise<TrackCandidate[]> {
        try {
            const text = query.trim().replace(/\s+/g, " ");
            if (!text || text.length > 500) {
                throw new ProviderError("Enter a song/artist or YouTube video URL (up to 500 characters).", {
                    provider: this.source, operation: "search", code: "INVALID_INPUT",
                });
            }
            const directId = parseYouTubeInput(text);
            const ids = directId ? [directId] : await this.client.searchVideoIds(text);
            const videos = await this.client.getVideos(ids);
            const candidates: TrackCandidate[] = [];
            const seen = new Set<string>();
            for (const video of videos) {
                const id = object(video).id;
                if (typeof id !== "string" || !ids.includes(id)) {
                    throw youtubeResponseError();
                }
                const candidate = normalizeYouTubeVideo(video);
                if (candidate && !seen.has(id)) {
                    seen.add(id);
                    candidates.push(directId ? { ...candidate, confidence: 1 } : scoreCandidate(text, candidate));
                }
            }
            return candidates.sort((a, b) => b.confidence - a.confidence);
        } catch (error) {
            throw toProviderError(error, this.source, "search");
        }
    }

    async getAudio(track: Track, signal?: AbortSignal): Promise<AudioResource> {
        // Cross-provider matching belongs in the resolver, not an implicit search
        // here. Only canonical, validated YouTube tracks reach the extractor.
        if (track.source !== this.source || !YOUTUBE_VIDEO_ID.test(track.id) || track.url !== youtubeUrl(track.id)) {
            throw new ProviderError("This track has no resolved YouTube playback source.", {
                provider: this.source, operation: "getAudio", code: "NOT_PLAYABLE",
            });
        }
        try {
            return await this.audio.getAudio(track.id, signal);
        } catch (error) {
            throw toProviderError(error, this.source, "getAudio");
        }
    }
}

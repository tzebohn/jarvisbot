import { ProviderError, type ProviderErrorCode } from "../ProviderError.js";
import { YOUTUBE_VIDEO_ID } from "./youtubeUrl.js";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

export function youtubeResponseError(): ProviderError {
    return new ProviderError("YouTube returned invalid metadata.", {
        provider: "youtube", operation: "search", code: "INVALID_RESPONSE",
    });
}

export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw youtubeResponseError();
    }
    return value as Record<string, unknown>;
}

/** Data API access only; credentials never go into discovery URLs or audio extraction. */
export class YouTubeClient {
    constructor(
        private readonly apiKey: string,
        private readonly fetchApi: typeof fetch = fetch,
        private readonly timeoutMs = 10_000,
    ) {}

    async searchVideoIds(query: string): Promise<string[]> {
        const items = await this.request("search", {
            part: "snippet", type: "video", q: query, maxResults: "5", order: "relevance",
        });
        return [...new Set(items.map((item) => {
            const id = object(object(item).id).videoId;
            if (typeof id !== "string" || !YOUTUBE_VIDEO_ID.test(id)) {
                throw youtubeResponseError();
            }
            return id;
        }))];
    }

    async getVideos(ids: string[]): Promise<unknown[]> {
        if (!ids.length) {
            return [];
        }
        return this.request("videos", {
            part: "snippet,contentDetails,status", id: ids.join(","),
        });
    }

    private async request(endpoint: string, parameters: Record<string, string>): Promise<unknown[]> {
        if (!this.apiKey.trim()) {
            throw new ProviderError("Set YOUTUBE_API_KEY in apps/bot/.env to enable YouTube search.", {
                provider: "youtube", operation: "search", code: "UNAUTHORIZED",
            });
        }
        const url = new URL(`${YOUTUBE_API_BASE}/${endpoint}`);
        url.search = new URLSearchParams(parameters).toString();
        try {
            const response = await this.fetchApi(url, {
                headers: { "X-Goog-Api-Key": this.apiKey.trim() },
                signal: AbortSignal.timeout(this.timeoutMs),
            });
            if (!response.ok) {
                // Do not echo Google's response or request headers: either may contain credentials.
                const body = await response.json().catch(() => ({})) as {
                    error?: { errors?: { reason?: string }[] };
                };
                const reasons = body?.error?.errors;
                const limited = Array.isArray(reasons) && reasons.some(({ reason }) =>
                    ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"].includes(reason ?? ""));
                const code: ProviderErrorCode = response.status === 429 || limited ? "RATE_LIMITED"
                    : [400, 401, 403].includes(response.status) ? "UNAUTHORIZED" : "UNAVAILABLE";
                const message = code === "RATE_LIMITED" ? "YouTube's API quota or rate limit has been reached. Try again later."
                    : code === "UNAUTHORIZED" ? "YouTube rejected the API key. Check YOUTUBE_API_KEY and enable YouTube Data API v3."
                        : "YouTube is temporarily unavailable. Try again later.";
                throw new ProviderError(message, { provider: "youtube", operation: "search", code });
            }
            const body = object(await response.json().catch(() => { throw youtubeResponseError(); }));
            if (!Array.isArray(body.items)) {
                throw youtubeResponseError();
            }
            return body.items;
        } catch (error) {
            if (error instanceof ProviderError) {
                throw error;
            }
            throw new ProviderError("YouTube could not be reached. Try again later.", {
                provider: "youtube", operation: "search", code: "UNAVAILABLE",
            });
        }
    }
}

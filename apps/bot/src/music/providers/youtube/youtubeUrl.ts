import { ProviderError } from "../ProviderError.js";

export const YOUTUBE_VIDEO_ID = /^[\w-]{11}$/;

export function youtubeUrl(id: string): string {
    return `https://www.youtube.com/watch?v=${id}`;
}

/** Text returns undefined. URL-like inputs must identify a single YouTube video. */
export function parseYouTubeInput(input: string): string | undefined {
    const text = input.trim();
    const bareUrl = /^(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)\//i.test(text);
    if (!bareUrl && !/^[a-z][\w+.-]*:|^\/\//i.test(text)) {
        return undefined;
    }
    const invalid = () => new ProviderError("Use a YouTube video URL, not a playlist or another website.", {
        provider: "youtube", operation: "search", code: "INVALID_INPUT",
    });
    let url: URL;
    try {
        url = new URL(bareUrl ? `https://${text}` : text);
    } catch {
        throw invalid();
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
        throw invalid();
    }
    let id: string | null | undefined;
    if (["youtu.be", "www.youtu.be"].includes(url.hostname)) {
        id = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    } else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
        "www.youtube-nocookie.com", "youtube-nocookie.com"].includes(url.hostname)) {
        id = url.pathname === "/watch" ? url.searchParams.get("v")
            : /^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    }
    if (!id || !YOUTUBE_VIDEO_ID.test(id)) {
        throw invalid();
    }
    return id;
}

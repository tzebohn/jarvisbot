import type { TrackCandidate } from "@discord-music-platform/shared";
import { normalizeCandidate } from "../normalizeCandidate.js";
import { normalizeQuery } from "../../scoreCandidate.js";
import { object, youtubeResponseError } from "./YouTubeClient.js";
import { YOUTUBE_VIDEO_ID, youtubeUrl } from "./youtubeUrl.js";

export function decodeYouTubeText(value: string): string {
    const entities: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, name: string) => {
        if (!name.startsWith("#")) {
            return entities[name.toLowerCase()];
        }
        const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
            ? String.fromCodePoint(code) : entity;
    });
}

export function parseYouTubeDuration(value: unknown): number {
    if (typeof value !== "string") {
        throw youtubeResponseError();
    }
    const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
    if (!match || !match.slice(1).some((part) => part !== undefined)) {
        throw youtubeResponseError();
    }
    const seconds = Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600
        + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
    if (!Number.isFinite(seconds)) {
        throw youtubeResponseError();
    }
    return seconds;
}

/** Unavailable and live/upcoming videos are deliberately excluded from the music queue. */
export function normalizeYouTubeVideo(value: unknown): TrackCandidate | undefined {
    const video = object(value);
    const snippet = object(video.snippet);
    const status = object(video.status);
    const details = object(video.contentDetails);
    if (status.privacyStatus === "private" || status.uploadStatus !== "processed"
        || (snippet.liveBroadcastContent !== undefined && snippet.liveBroadcastContent !== "none")) {
        return undefined;
    }
    if (typeof video.id !== "string" || !YOUTUBE_VIDEO_ID.test(video.id)
        || typeof snippet.title !== "string" || typeof snippet.channelTitle !== "string") {
        throw youtubeResponseError();
    }
    const title = decodeYouTubeText(snippet.title).trim();
    const channel = decodeYouTubeText(snippet.channelTitle).replace(/\s*-\s*Topic$|VEVO$/i, "").trim();
    // YouTube supplies an uploader, not a structured recording artist. Use the
    // common "Artist - Title" convention where present, otherwise the channel.
    const split = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
    const artistKey = (text: string) => normalizeQuery(text).replace(/\s/g, "");
    const titleFirst = split && artistKey(split[2]) === artistKey(channel);
    let thumbnail: unknown;
    if (snippet.thumbnails !== undefined) {
        const thumbnails = object(snippet.thumbnails);
        const preferred = thumbnails.maxres ?? thumbnails.standard ?? thumbnails.high ?? thumbnails.medium ?? thumbnails.default;
        if (preferred !== undefined) {
            thumbnail = object(preferred).url;
        }
    }
    return normalizeCandidate("youtube", {
        id: video.id, title: split ? split[titleFirst ? 1 : 2] : title,
        artist: split ? split[titleFirst ? 2 : 1] : channel,
        duration: parseYouTubeDuration(details.duration), thumbnail, url: youtubeUrl(video.id),
    });
}

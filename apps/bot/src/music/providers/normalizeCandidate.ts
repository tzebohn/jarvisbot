import type { MusicSource, Track, TrackCandidate } from "@discord-music-platform/shared";
import { ProviderError } from "./ProviderError.js";

function invalid(provider: MusicSource, message: string): never {
    throw new ProviderError(message, { provider, operation: "normalize", code: "INVALID_RESPONSE" });
}

function requiredString(provider: MusicSource, value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
        invalid(provider, `Invalid candidate: ${field} must be a non-empty string.`);
    }
    return value.trim();
}

function optionalString(provider: MusicSource, value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "string") {
        invalid(provider, `Invalid candidate: ${field} must be a string when provided.`);
    }
    return value.trim() || undefined;
}

function webUrl(provider: MusicSource, value: unknown, field: string): string {
    const text = requiredString(provider, value, field);
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        invalid(provider, `Invalid candidate: ${field} must be an absolute HTTP(S) URL.`);
    }
    if (!/^https?:\/\//i.test(text) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        invalid(provider, `Invalid candidate: ${field} must be an absolute HTTP(S) URL without credentials.`);
    }
    return url.href;
}

/**
 * Normalize flat metadata already mapped by a provider adapter: id, title,
 * artist, url, optional album/duration/thumbnail/confidence. Durations are seconds.
 * Missing confidence is 0 (unscored); this function never computes match scores.
 * The trusted provider argument supplies both track.source and candidate.provider.
 */
export function normalizeCandidate(provider: MusicSource, input: unknown): TrackCandidate {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        invalid(provider, "Invalid candidate: metadata must be an object.");
    }
    const metadata = input as Record<string, unknown>;
    const track: Track = {
        id: requiredString(provider, metadata.id, "id"),
        title: requiredString(provider, metadata.title, "title").replace(/\s+/gu, " "),
        artist: requiredString(provider, metadata.artist, "artist").replace(/\s+/gu, " "),
        source: provider,
        url: webUrl(provider, metadata.url, "url"),
    };

    const album = optionalString(provider, metadata.album, "album");
    if (album !== undefined) {
        track.album = album.replace(/\s+/gu, " ");
    }
    if (metadata.duration !== undefined && metadata.duration !== null) {
        if (typeof metadata.duration !== "number" || !Number.isFinite(metadata.duration) || metadata.duration < 0) {
            invalid(provider, "Invalid candidate: duration must be a finite, non-negative number of seconds.");
        }
        track.duration = metadata.duration;
    }
    const thumbnail = optionalString(provider, metadata.thumbnail, "thumbnail");
    if (thumbnail !== undefined) {
        track.thumbnail = webUrl(provider, thumbnail, "thumbnail");
    }

    const confidence = metadata.confidence ?? 0;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        invalid(provider, "Invalid candidate: confidence must be a finite number between 0 and 1.");
    }
    return { track, confidence, provider };
}

/** Preserve every result's order; malformed results fail explicitly rather than disappear. */
export function normalizeCandidates(provider: MusicSource, input: unknown): TrackCandidate[] {
    if (!Array.isArray(input)) {
        invalid(provider, "Invalid candidates: expected an array of mapped metadata.");
    }
    return Array.from(input, (metadata) => normalizeCandidate(provider, metadata));
}

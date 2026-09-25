import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ProviderError,
    toProviderError,
    normalizeCandidate,
    normalizeCandidates,
    isPlaybackProvider,
} from "../src/music/providers/index.ts";

function metadata(overrides = {}) {
    return {
        id: "AbC_123",
        title: "Numb (Live Remix)",
        artist: "Linkin Park",
        url: "https://example.com/watch?v=AbC_123",
        ...overrides,
    };
}

function isInvalidResponse(error) {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.provider, "youtube");
    assert.equal(error.operation, "normalize");
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
}

test("mapped provider metadata becomes an independent shared candidate without mutating its input", () => {
    const input = Object.freeze(metadata({
        id: "  AbC_123  ",
        title: "  Numb\t(Live  Remix)  ",
        artist: " Linkin\nPark ",
        album: "  Live  Recordings ",
        duration: 200.25,
        thumbnail: " https://EXAMPLE.com/artwork.jpg ",
        url: " https://EXAMPLE.com/watch?v=AbC_123 ",
        confidence: 0.81,
        provider: "spotify",
        source: "spotify",
        rawResponse: { internal: true },
    }));
    const result = normalizeCandidate("youtube", input);
    assert.deepEqual(result, {
        track: {
            id: "AbC_123",
            title: "Numb (Live Remix)",
            artist: "Linkin Park",
            album: "Live Recordings",
            duration: 200.25,
            thumbnail: "https://example.com/artwork.jpg",
            source: "youtube",
            url: "https://example.com/watch?v=AbC_123",
        },
        confidence: 0.81,
        provider: "youtube",
    });
    result.track.title = "Changed by caller";
    assert.equal(input.title, "  Numb\t(Live  Remix)  ");
});

test("normalization preserves meaningful version words, Unicode, case, and opaque IDs", () => {
    const input = metadata({
        id: " Case Sensitive ID ",
        title: "  Jóga – Official AUDIO (Live / REMIX, sped up)  ",
        artist: " Björk  &  Guests ",
    });
    const result = normalizeCandidate("youtube", input);
    assert.equal(result.track.id, "Case Sensitive ID");
    assert.equal(result.track.title, "Jóga – Official AUDIO (Live / REMIX, sped up)");
    assert.equal(result.track.artist, "Björk & Guests");
});

test("all documented discovery sources use the same candidate shape", () => {
    for (const provider of ["spotify", "youtube", "soundcloud"]) {
        const candidate = normalizeCandidate(provider, metadata());
        assert.equal(candidate.provider, provider);
        assert.equal(candidate.track.source, provider);
    }
});

test("absent optional fields stay absent and unknown confidence defaults to unscored zero", () => {
    for (const confidence of [undefined, null]) {
        const candidate = normalizeCandidate("youtube", metadata({
            album: " \t ", duration: null, thumbnail: "", confidence,
        }));
        assert.equal(candidate.confidence, 0);
        assert.equal(Object.hasOwn(candidate.track, "album"), false);
        assert.equal(Object.hasOwn(candidate.track, "duration"), false);
        assert.equal(Object.hasOwn(candidate.track, "thumbnail"), false);
    }
});

test("valid supplied confidence is preserved including both endpoints", () => {
    for (const confidence of [0, 0.12345, 0.89, 1]) {
        assert.equal(normalizeCandidate("youtube", metadata({ confidence })).confidence, confidence);
    }
});

test("invalid confidence is rejected rather than coerced, clamped, or turned into a score", () => {
    for (const confidence of [-0.1, 1.01, NaN, Infinity, -Infinity, "0.9", true, {}, []]) {
        assert.throws(() => normalizeCandidate("youtube", metadata({ confidence })), isInvalidResponse);
    }
});

test("duration uses non-negative finite seconds, preserves fractions, and does not guess units", () => {
    for (const duration of [0, 1.25, 200, 200_000]) {
        assert.equal(normalizeCandidate("youtube", metadata({ duration })).track.duration, duration);
    }
    for (const duration of [-1, Infinity, -Infinity, NaN, "200", "3:20", false, {}]) {
        assert.throws(() => normalizeCandidate("youtube", metadata({ duration })), isInvalidResponse);
    }
});

test("invalid metadata objects and missing required fields yield structured normalization errors", () => {
    for (const input of [null, undefined, false, 12, "track", [], {}]) {
        assert.throws(() => normalizeCandidate("youtube", input), isInvalidResponse);
    }
    for (const field of ["id", "title", "artist", "url"]) {
        for (const value of [undefined, null, "", " \t ", 123, false, {}, []]) {
            assert.throws(() => normalizeCandidate("youtube", metadata({ [field]: value })), (error) => {
                isInvalidResponse(error);
                assert.ok(error.message.includes(field));
                return true;
            });
        }
    }
});

test("optional text fields accept missing values but reject non-string values", () => {
    for (const field of ["album", "thumbnail"]) {
        for (const value of [undefined, null, "", "   "]) {
            const candidate = normalizeCandidate("youtube", metadata({ [field]: value }));
            assert.equal(Object.hasOwn(candidate.track, field), false);
        }
        for (const value of [123, false, {}, []]) {
            assert.throws(() => normalizeCandidate("youtube", metadata({ [field]: value })), isInvalidResponse);
        }
    }
});

test("discovery and artwork URLs must be absolute HTTP(S) URLs without embedded credentials", () => {
    for (const field of ["url", "thumbnail"]) {
        for (const value of [
            "/relative", "//example.com/audio", "not a url", "https:example.com", "https://",
            "file:///tmp/audio.mp3", "javascript:alert(1)", "spotify:track:123",
            "https://user:private-password@example.com/track",
        ]) {
            assert.throws(() => normalizeCandidate("youtube", metadata({ [field]: value })), (error) => {
                isInvalidResponse(error);
                assert.equal(error.message.includes("private-password"), false);
                return true;
            });
        }
    }
    assert.equal(normalizeCandidate("youtube", metadata({ url: "http://example.com/track" })).track.url,
        "http://example.com/track");
});

test("batch normalization preserves order and duplicate candidates without selecting or scoring", () => {
    const input = [metadata({ confidence: 0.1 }), metadata({ title: "Numb", confidence: 0.9 }), metadata({ confidence: 0.1 })];
    const candidates = normalizeCandidates("youtube", input);
    assert.equal(candidates.length, 3);
    assert.deepEqual(candidates.map((candidate) => candidate.track.title), ["Numb (Live Remix)", "Numb", "Numb (Live Remix)"]);
    assert.deepEqual(candidates.map((candidate) => candidate.confidence), [0.1, 0.9, 0.1]);
    assert.deepEqual(candidates[0], candidates[2]);
    assert.notEqual(candidates[0].track, candidates[2].track);
});

test("an empty result set remains a successful search with no matches", () => {
    assert.deepEqual(normalizeCandidates("youtube", []), []);
});

test("malformed batches fail explicitly instead of silently dropping invalid entries", () => {
    for (const input of [null, undefined, {}, "results", [metadata(), {}], new Array(1)]) {
        assert.throws(() => normalizeCandidates("youtube", input), isInvalidResponse);
    }
});

test("classified provider errors retain their operation, code, and original cause", () => {
    const cause = new Error("upstream failure");
    const error = new ProviderError("Search is temporarily unavailable.", {
        provider: "soundcloud", operation: "search", code: "UNAVAILABLE", cause,
    });
    assert.ok(error instanceof Error);
    assert.equal(error.name, "ProviderError");
    assert.equal(error.provider, "soundcloud");
    assert.equal(error.operation, "search");
    assert.equal(error.code, "UNAVAILABLE");
    assert.equal(error.cause, cause);
});

test("wrapping unknown failures keeps SDK details in the cause rather than the public message", () => {
    for (const cause of [new Error("SDK detail: token=private"), "token=private", { status: 429 }, undefined, null]) {
        const error = toProviderError(cause, "youtube", "getAudio");
        assert.ok(error instanceof ProviderError);
        assert.equal(error.provider, "youtube");
        assert.equal(error.operation, "getAudio");
        assert.equal(error.code, "UNKNOWN");
        assert.equal(error.message, "youtube getAudio failed.");
        assert.equal(error.cause, cause);
    }
});

test("wrapping an existing provider error preserves its classification and normalization context", () => {
    let original;
    try {
        normalizeCandidate("spotify", metadata({ title: null }));
    } catch (error) {
        original = error;
    }
    const wrapped = toProviderError(original, "spotify", "search");
    assert.equal(wrapped, original);
    assert.equal(wrapped.operation, "normalize");
    assert.equal(wrapped.code, "INVALID_RESPONSE");
});

test("metadata-only providers do not need a dummy audio method", () => {
    const provider = { source: "spotify", async search() { return []; } };
    assert.equal(isPlaybackProvider(provider), false);
    for (const getAudio of [undefined, null, false, "unsupported"]) {
        assert.equal(isPlaybackProvider({ ...provider, getAudio }), false);
    }
});

test("playback capability detection supports both object and class-based providers without invoking them", () => {
    const getAudio = async () => { throw new Error("must not resolve audio during capability detection"); };
    assert.equal(isPlaybackProvider({ source: "youtube", async search() { return []; }, getAudio }), true);
    class Provider {
        source = "soundcloud";
        async search() { return []; }
        getAudio() { return getAudio(); }
    }
    assert.equal(isPlaybackProvider(new Provider()), true);
});

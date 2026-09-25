import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { YouTubeClient } from "../src/music/providers/youtube/YouTubeClient.ts";
import { YouTubeProvider } from "../src/music/providers/youtube/YouTubeProvider.ts";
import { parseYouTubeInput, youtubeUrl } from "../src/music/providers/youtube/youtubeUrl.ts";
import { parseYouTubeDuration, normalizeYouTubeVideo } from "../src/music/providers/youtube/normalizeYouTubeVideo.ts";
import { ProviderError } from "../src/music/providers/ProviderError.ts";
import { scoreCandidate } from "../src/music/scoreCandidate.ts";
import { TrackResolver } from "../src/music/TrackResolver.ts";

const firstId = "abcdefghijk";
const secondId = "lmnopqrstuv";

function video(id = firstId, title = "Linkin Park - Numb (Official Audio)") {
    return {
        id, snippet: { title, channelTitle: "Linkin Park", liveBroadcastContent: "none",
            thumbnails: { high: { url: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg" } } },
        contentDetails: { duration: "PT3M7S" },
        status: { privacyStatus: "public", uploadStatus: "processed" },
    };
}

function setup(responses) {
    const fetchApi = mock.fn(async () => Response.json(responses.shift()));
    return { fetchApi, provider: new YouTubeProvider(new YouTubeClient("secret-test-key", fetchApi)) };
}

test("Data API search batches video details and scoring can select a later result", async () => {
    const { fetchApi, provider } = setup([
        { items: [{ id: { videoId: firstId } }, { id: { videoId: secondId } }, { id: { videoId: secondId } }] },
        { items: [video(firstId, "Linkin Park - Numb (Live)"), video(secondId)] },
    ]);
    const resolution = await new TrackResolver(provider).resolve("  Numb by Linkin Park  ");
    assert.equal(resolution.status, "resolved");
    assert.equal(resolution.candidate.track.id, secondId);
    assert.equal(resolution.candidates.length, 2);
    assert.equal(resolution.candidate.track.duration, 187);
    assert.equal(resolution.candidate.track.title, "Numb (Official Audio)");
    assert.equal(resolution.candidate.track.artist, "Linkin Park");
    const [searchUrl, options] = fetchApi.mock.calls[0].arguments;
    assert.equal(searchUrl.pathname, "/youtube/v3/search");
    assert.equal(searchUrl.searchParams.get("type"), "video");
    assert.equal(searchUrl.searchParams.get("q"), "Numb by Linkin Park");
    assert.equal(options.headers["X-Goog-Api-Key"], "secret-test-key");
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!searchUrl.href.includes("secret-test-key"));
    const [detailsUrl] = fetchApi.mock.calls[1].arguments;
    assert.equal(detailsUrl.searchParams.get("id"), `${firstId},${secondId}`);
    assert.equal(detailsUrl.searchParams.get("part"), "snippet,contentDetails,status");
});

test("video links bypass search, retain the requested ID, and have exact-match confidence", async () => {
    const { fetchApi, provider } = setup([{ items: [video()] }]);
    const results = await provider.search(`https://youtu.be/${firstId}?t=20&list=ignored`);
    assert.equal(fetchApi.mock.callCount(), 1);
    assert.equal(fetchApi.mock.calls[0].arguments[0].pathname, "/youtube/v3/videos");
    assert.equal(results[0].confidence, 1);
    assert.equal(results[0].track.url, youtubeUrl(firstId));
});

test("YouTube URLs are strictly parsed and canonicalized before extraction", () => {
    for (const input of [youtubeUrl(firstId), `https://youtu.be/${firstId}`, `youtube.com/watch?v=${firstId}`,
        `https://music.youtube.com/watch?v=${firstId}`, `https://www.youtube.com/shorts/${firstId}`,
        `https://www.youtube-nocookie.com/embed/${firstId}`]) {
        assert.equal(parseYouTubeInput(input), firstId);
    }
    assert.equal(parseYouTubeInput("Numb by Linkin Park"), undefined);
    assert.equal(parseYouTubeInput("Thunderbolt"), undefined, "11-character song names are text, not video IDs");
    for (const input of ["https://youtube.com/playlist?list=abc", "https://example.com/video",
        `https://youtube.com.evil.test/watch?v=${firstId}`, `https://youtube.com@evil.test/watch?v=${firstId}`,
        `https://user:pass@youtube.com/watch?v=${firstId}`, `https://youtube.com:123/watch?v=${firstId}`,
        "file:///etc/passwd", "https://youtube.com/watch?v=bad", `https://youtu.be/${firstId}/extra`]) {
        assert.throws(() => parseYouTubeInput(input), { code: "INVALID_INPUT" });
    }
});

test("invalid input and missing credentials fail before a network request", async () => {
    const fetchApi = mock.fn();
    const provider = new YouTubeProvider(new YouTubeClient("", fetchApi));
    for (const query of ["", "  ", "x".repeat(501), "https://example.com/video"]) {
        await assert.rejects(provider.search(query), { code: "INVALID_INPUT" });
    }
    await assert.rejects(provider.search("Numb"), { code: "UNAUTHORIZED" });
    assert.equal(fetchApi.mock.callCount(), 0);
});

test("empty searches avoid a detail request and unavailable direct videos return no results", async () => {
    const { fetchApi, provider } = setup([{ items: [] }, { items: [] }]);
    assert.deepEqual(await provider.search("unknown song"), []);
    assert.equal(fetchApi.mock.callCount(), 1);
    assert.deepEqual(await provider.search(youtubeUrl(firstId)), []);
});

test("normalization decodes entities, retains version words, and uses channel metadata as a fallback", () => {
    const input = video(firstId, "Artist &amp; Friend - Song &#39;Acoustic&#39; &#x1F3B5;");
    assert.equal(normalizeYouTubeVideo(input).track.title, "Song 'Acoustic' 🎵");
    assert.equal(normalizeYouTubeVideo(input).track.artist, "Artist & Friend");
    input.snippet.title = "Numb (Remix)";
    input.snippet.channelTitle = "Linkin Park - Topic";
    assert.equal(normalizeYouTubeVideo(input).track.artist, "Linkin Park");
    assert.equal(normalizeYouTubeVideo(input).track.title, "Numb (Remix)");
    assert.equal(parseYouTubeDuration("P1DT2H3M4.5S"), 93784.5);
    for (const duration of [undefined, "P", "PT", "3:07", "PT-3M"]) {
        assert.throws(() => parseYouTubeDuration(duration), { code: "INVALID_RESPONSE" });
    }
});

test("live, upcoming, private and unprocessed videos are excluded", () => {
    for (const status of ["live", "upcoming"]) {
        const input = video();
        input.snippet.liveBroadcastContent = status;
        assert.equal(normalizeYouTubeVideo(input), undefined);
    }
    for (const status of [{ privacyStatus: "private" }, { uploadStatus: "failed" }]) {
        const input = video();
        Object.assign(input.status, status);
        assert.equal(normalizeYouTubeVideo(input), undefined);
    }
});

test("channel metadata disambiguates title-first uploads and official matches beat lyric uploads", () => {
    const official = normalizeYouTubeVideo(video(firstId, "Numb (Official Music Video) [4K UPGRADE] – Linkin Park"));
    assert.equal(official.track.artist, "Linkin Park");
    assert.equal(official.track.title, "Numb (Official Music Video) [4K UPGRADE]");
    const lyrics = normalizeYouTubeVideo(video(secondId, "Linkin Park - Numb (Lyrics)"));
    assert.ok(scoreCandidate("Numb by Linkin Park", official).confidence > scoreCandidate("Numb by Linkin Park", lyrics).confidence);
});

test("malformed API data fails explicitly instead of fabricating metadata", async () => {
    for (const body of [{}, { items: null }, { items: [{ id: { videoId: "bad" } }] }]) {
        const { provider } = setup([body]);
        await assert.rejects(provider.search("Numb"), { code: "INVALID_RESPONSE" });
    }
    const { provider } = setup([{ items: [video(secondId)] }]);
    await assert.rejects(provider.search(youtubeUrl(firstId)), { code: "INVALID_RESPONSE" });
    assert.throws(() => normalizeYouTubeVideo({ ...video(), snippet: {} }), { code: "INVALID_RESPONSE" });
});

test("API failures distinguish quota, credentials, and availability without leaking responses", async () => {
    for (const [status, reason, code] of [[403, "quotaExceeded", "RATE_LIMITED"], [429, "", "RATE_LIMITED"],
        [403, "accessNotConfigured", "UNAUTHORIZED"], [400, "keyInvalid", "UNAUTHORIZED"], [503, "", "UNAVAILABLE"]]) {
        const client = new YouTubeClient("secret-test-key", async () => Response.json({
            error: { message: "secret-test-key", errors: [{ reason }] },
        }, { status }));
        await assert.rejects(client.searchVideoIds("Numb"), (error) => {
            assert.ok(error instanceof ProviderError);
            assert.equal(error.code, code);
            assert.ok(!error.message.includes("secret-test-key"));
            assert.equal(error.cause, undefined);
            return true;
        });
    }
    const unavailable = new YouTubeClient("key", async () => { throw new Error("network key=secret"); });
    await assert.rejects(unavailable.searchVideoIds("Numb"), { code: "UNAVAILABLE" });
});

test("HTTP requests are bounded by a timeout, including a pending response", async () => {
    const client = new YouTubeClient("key", async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
    }), 5);
    // AbortSignal.timeout is unref'd; keep this isolated test's event loop alive.
    const keepAlive = setTimeout(() => {}, 100);
    try {
        await assert.rejects(client.searchVideoIds("Numb"), { code: "UNAVAILABLE" });
    } finally {
        clearTimeout(keepAlive);
    }
});

test("scoring preserves requested versions and artist/title relationships", () => {
    const studio = normalizeYouTubeVideo(video());
    const live = normalizeYouTubeVideo(video(secondId, "Linkin Park - Numb (Live)"));
    const remix = normalizeYouTubeVideo(video(secondId, "Linkin Park - Numb (Remix)"));
    for (const query of ["Numb", "numb linkin park", "Numb by Linkin Park", "Linkin Park - Numb"]) {
        assert.ok(scoreCandidate(query, studio).confidence >= 0.75, query);
        assert.ok(scoreCandidate(query, studio).confidence > scoreCandidate(query, live).confidence, query);
    }
    assert.ok(scoreCandidate("numb live", live).confidence > scoreCandidate("numb live", studio).confidence);
    assert.ok(scoreCandidate("numb remix", remix).confidence > scoreCandidate("numb remix", studio).confidence);
    assert.ok(scoreCandidate("numb remix", studio).confidence < 0.75);
    assert.ok(scoreCandidate("completely unrelated song", studio).confidence < 0.5);
    assert.equal(studio.confidence, 0, "scoring does not mutate the provider candidate");
    const standByMe = normalizeYouTubeVideo(video(firstId, "Ben E. King - Stand by Me"));
    assert.ok(scoreCandidate("Stand by Me", standByMe).confidence >= 0.75);
});

test("resolver automatically selects a later low-confidence match using the existing scorer", async () => {
    const { provider } = setup([
        { items: [{ id: { videoId: firstId } }, { id: { videoId: secondId } }] },
        { items: [video(firstId, "The Weeknd - Starboy (Live Cover)"), video(secondId, "The Weeknd - Starboy (Remix)")] },
    ]);
    const resolution = await new TrackResolver(provider).resolve("Starboy");
    assert.equal(resolution.status, "resolved");
    assert.equal(resolution.candidate.track.id, secondId);
    assert.ok(resolution.candidate.confidence < 0.75);
    assert.ok(resolution.candidate.confidence > resolution.candidates[1].confidence);
    assert.equal(resolution.candidate.confidence,
        scoreCandidate("Starboy", normalizeYouTubeVideo(video(secondId, "The Weeknd - Starboy (Remix)"))).confidence);
});

test("resolver accepts official-label-only and zero-score results but still fails on empty searches", async () => {
    const { provider } = setup([
        { items: [{ id: { videoId: firstId } }] }, { items: [video()] },
        { items: [{ id: { videoId: firstId } }] }, { items: [video(firstId, "Linkin Park - Numb")] },
        { items: [] },
    ]);
    const resolver = new TrackResolver(provider);
    for (const confidence of [0.05, 0]) {
        const low = await resolver.resolve("completely unrelated song");
        assert.equal(low.status, "resolved");
        assert.equal(low.candidate.confidence, confidence);
        assert.equal(low.candidate.track.id, firstId);
    }
    assert.deepEqual(await resolver.resolve("no matches"), { status: "no-results", candidates: [] });
});

test("resolver ranks all valid confidence scores without changing them or requiring a minimum", async () => {
    const track = normalizeYouTubeVideo(video()).track;
    const candidate = (confidence) => ({ track, confidence, provider: "youtube" });
    const resolve = (scores) => new TrackResolver({ search: async () => scores.map(candidate) }).resolve("Numb");
    const resolved = await resolve([0.4, 0.05, 0.749, 0, NaN, 1.1, -0.1, Infinity, -Infinity]);
    assert.equal(resolved.status, "resolved");
    assert.deepEqual(resolved.candidates.map((entry) => entry.confidence), [0.749, 0.4, 0.05, 0]);
    assert.equal(resolved.candidate, resolved.candidates[0]);
    for (const scores of [[0.75, 0.6], [1], [0, 0.05], [0]]) {
        const result = await resolve(scores);
        assert.equal(result.status, "resolved");
        assert.equal(result.candidate.confidence, Math.max(...scores));
    }
    assert.deepEqual(await resolve([NaN, Infinity, -Infinity, -0.1, 1.1]), { status: "no-results", candidates: [] });
});

test("resolver returns no results when all YouTube matches are unavailable", async () => {
    const live = video();
    live.snippet.liveBroadcastContent = "live";
    const privateVideo = video(secondId);
    privateVideo.status.privacyStatus = "private";
    const { provider } = setup([
        { items: [{ id: { videoId: firstId } }, { id: { videoId: secondId } }] },
        { items: [live, privateVideo] },
    ]);
    assert.deepEqual(await new TrackResolver(provider).resolve("Numb"), { status: "no-results", candidates: [] });
});

test("audio accepts only a resolved YouTube track and forwards cancellation", async () => {
    const audio = { getAudio: mock.fn(async () => ({ playStream: {} })) };
    const provider = new YouTubeProvider(new YouTubeClient("key"), audio);
    const track = normalizeYouTubeVideo(video()).track;
    for (const invalid of [{ ...track, source: "spotify" }, { ...track, url: "https://evil.test" }, { ...track, id: "bad" }]) {
        await assert.rejects(provider.getAudio(invalid), { code: "NOT_PLAYABLE" });
    }
    assert.equal(audio.getAudio.mock.callCount(), 0);
    const signal = new AbortController().signal;
    await provider.getAudio(track, signal);
    assert.deepEqual(audio.getAudio.mock.calls[0].arguments, [firstId, signal]);
});

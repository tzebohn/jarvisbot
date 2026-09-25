import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { SpeechToText } from "../src/voice/transcription/SpeechToText.ts";
import { GroqSpeechToText, groqRetryAfter } from "../src/voice/transcription/GroqSpeechToText.ts";
import { normalizeTranscript } from "../src/voice/transcription/normalizeTranscript.ts";
import { SttError } from "../src/voice/transcription/types.ts";
import { PCM_FORMAT } from "../src/voice/receive/SpeakerStream.ts";
import { pcmToWav } from "../src/voice/receive/wav.ts";

const signal = () => new AbortController().signal;
const audio = (pcm = Buffer.alloc(3_840)) => ({ pcm, format: PCM_FORMAT, wake: { phrase: "Jarvis" } });
const response = (text = " Jarvis, Jarvis! Play Numb by Linkin Park. ") => ({ text, segments: [] });
function backend(provider, impl = async () => response()) {
    return { provider, model: "test", transcribe: mock.fn(impl) };
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body),
    { status, headers: { "content-type": "application/json", ...headers } });
// The SDK probes custom fetch implementations with a local data URL before multipart use.
const client = (fetch) => new GroqSpeechToText("test-key", "en",
    (url, init) => url === "data:," ? Promise.resolve(new Response()) : fetch(url, init));

test("Groq sends the exact command WAV once, with turbo and quality metadata, without a prompt", async () => {
    const clip = audio();
    const fetch = mock.fn(async (url, init) => {
        const req = new Request(url, init);
        assert.equal(req.url, "https://api.groq.com/openai/v1/audio/transcriptions");
        const form = await req.formData();
        assert.equal(form.get("model"), "whisper-large-v3-turbo");
        assert.equal(form.get("response_format"), "verbose_json");
        assert.equal(form.get("language"), "en");
        assert.equal(form.get("temperature"), "0");
        assert.equal(form.get("prompt"), null);
        assert.deepEqual(Buffer.from(await form.get("file").arrayBuffer()), pcmToWav(clip.pcm));
        return json({ text: "Jarvis, play Numb.", language: "english", segments: [{ start: 0, end: 1,
            avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 1.2 }] });
    });
    const local = backend("faster-whisper");
    const stt = new SpeechToText(client(fetch), local);
    const result = await stt.transcribe(clip, signal());
    assert.equal(result.text, "play Numb");
    assert.equal(result.rawText, "Jarvis, play Numb.");
    assert.equal(result.provider, "groq");
    assert.equal(result.segments[0].avgLogprob, -0.2);
    assert.equal(result.segments[0].noSpeechProb, 0.01);
    assert.ok(result.elapsedMs >= 0);
    assert.equal(local.transcribe.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 1);
});

for (const status of [408, 429, 500, 502, 503]) {
    test(`Groq HTTP ${status} falls back once with no SDK retries, then observes the shared cooldown`, async () => {
        let now = 0;
        const fetch = mock.fn(async () => json({ error: { message: "private error body" } }, status, { "retry-after": "120" }));
        const local = backend("faster-whisper");
        const stt = new SpeechToText(client(fetch), local, { now: () => now });
        const first = await stt.transcribe(audio(), signal());
        assert.equal(first.provider, "faster-whisper");
        assert.ok(first.fallbackReason);
        await stt.transcribe(audio(), signal());
        assert.equal(fetch.mock.callCount(), 1);
        assert.equal(local.transcribe.mock.callCount(), 2);
        now = 121_000;
        await stt.transcribe(audio(), signal());
        assert.equal(fetch.mock.callCount(), 2);
    });
}

for (const status of [400, 401, 403, 404, 413, 422]) {
    test(`Groq HTTP ${status} reports a sanitized error without hiding it through fallback`, async () => {
        const fetch = mock.fn(async () => json({ error: { message: "sensitive-body" } }, status));
        const local = backend("faster-whisper");
        const stt = new SpeechToText(client(fetch), local);
        await assert.rejects(stt.transcribe(audio(), signal()), (error) => error instanceof SttError
            && !error.message.includes("sensitive-body") && !error.message.includes("test-key"));
        assert.equal(fetch.mock.callCount(), 1);
        assert.equal(local.transcribe.mock.callCount(), 0);
    });
}

test("network failures use local fallback; invalid success bodies and missing keys fail explicitly", async () => {
    const local = backend("faster-whisper");
    const offline = client(async () => { throw new TypeError("network failed"); });
    assert.equal((await new SpeechToText(offline, local).transcribe(audio(), signal())).fallbackReason, "UNAVAILABLE");
    const invalid = client(async () => json({ error: "bad response" }));
    await assert.rejects(new SpeechToText(invalid, local).transcribe(audio(), signal()), { code: "INVALID_RESPONSE" });
    await assert.rejects(new SpeechToText(new GroqSpeechToText(""), local).transcribe(audio(), signal()), { code: "CONFIGURATION" });
    assert.equal(local.transcribe.mock.callCount(), 1);
});

test("rate cooldown uses retry-after seconds/dates and exhausted daily reset, never treats RPD reset as RPM", () => {
    assert.equal(groqRetryAfter(new Headers({ "retry-after": "2" })), 2_000);
    assert.equal(groqRetryAfter(new Headers({ "retry-after": "Thu, 01 Jan 1970 00:02:00 GMT" }), 0), 120_000);
    assert.equal(groqRetryAfter(new Headers({ "retry-after": "2", "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "23h59m1.5s" })), 86_341_500);
    assert.equal(groqRetryAfter(new Headers({ "retry-after": "2", "x-ratelimit-remaining-requests": "10",
        "x-ratelimit-reset-requests": "23h" })), 2_000);
    assert.equal(groqRetryAfter(new Headers({ "retry-after": "invalid" })), 60_000);
});

test("20/minute and 2000/rolling-day budgets are reserved across concurrent guilds and expire", async () => {
    let now = 0;
    const groq = backend("groq"), local = backend("faster-whisper");
    const stt = new SpeechToText(groq, local, { now: () => now });
    await Promise.all(Array.from({ length: 21 }, () => stt.transcribe(audio(), signal())));
    assert.equal(groq.transcribe.mock.callCount(), 20);
    assert.equal(local.transcribe.mock.callCount(), 1);
    for (let minute = 1; minute < 100; minute++) {
        now = minute * 60_001;
        await Promise.all(Array.from({ length: 20 }, () => stt.transcribe(audio(), signal())));
    }
    now += 60_001;
    const exhausted = await stt.transcribe(audio(), signal());
    assert.equal(exhausted.provider, "faster-whisper");
    assert.equal(groq.transcribe.mock.callCount(), 2_000);
    now = 86_400_001;
    assert.equal((await stt.transcribe(audio(), signal())).provider, "groq");
});

test("timeout aborts cloud I/O then falls back; owner cancellation never does", async () => {
    let cloudSignal;
    const groq = backend("groq", (_wav, signal) => { cloudSignal = signal; return new Promise(() => {}); });
    const local = backend("faster-whisper");
    const stt = new SpeechToText(groq, local, { groqTimeoutMs: 10 });
    assert.equal((await stt.transcribe(audio(), signal())).fallbackReason, "TIMEOUT");
    assert.equal(cloudSignal.aborted, true);
    const abort = new AbortController();
    const pending = new SpeechToText(groq, local).transcribe(audio(), abort.signal);
    abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(local.transcribe.mock.callCount(), 1);
    await assert.rejects(stt.transcribe(audio(), abort.signal), { name: "AbortError" });
});

test("local timeout/failure settles and empty transcripts are successful without cloud retries", async () => {
    const groq = backend("groq", async () => response("Jarvis, Jarvis!"));
    const local = backend("faster-whisper", () => new Promise(() => {}));
    assert.equal((await new SpeechToText(groq, local).transcribe(audio(), signal())).status, "empty");
    await assert.rejects(new SpeechToText(groq, local, { mode: "local", localTimeoutMs: 10 })
        .transcribe(audio(), signal()), { code: "TIMEOUT" });
    const broken = backend("faster-whisper", async () => { throw new SttError("LOCAL_FAILED", "Local failed."); });
    await assert.rejects(new SpeechToText(groq, broken, { mode: "local" }).transcribe(audio(), signal()), { code: "LOCAL_FAILED" });
});

test("empty PCM skips STT and malformed/oversized audio is rejected before either backend", async () => {
    const groq = backend("groq"), local = backend("faster-whisper");
    const stt = new SpeechToText(groq, local);
    assert.equal((await stt.transcribe(audio(Buffer.alloc(0)), signal())).provider, "none");
    for (const pcm of [Buffer.alloc(3), Buffer.alloc(2_688_004)]) {
        await assert.rejects(stt.transcribe(audio(pcm), signal()), { code: "INVALID_AUDIO" });
    }
    assert.equal(groq.transcribe.mock.callCount(), 0);
    assert.equal(local.transcribe.mock.callCount(), 0);
});

test("normalization removes repeated leading Jarvis, preserves artists and interior mentions", () => {
    for (const [input, expected] of [
        ["  ‘Jarvis, JARVIS… play   Numb by Linkin Park!’ ", "play Numb by Linkin Park"],
        ['“Hey Jarvis, Jarvis — play AC/DC’s Thunderstruck.”', "play AC/DC's Thunderstruck"],
        ["play P!nk - So What?", "play P!nk - So What"],
        ["play Jarvis Cocker", "play Jarvis Cocker"],
        ["my Jarvis is annoying", "my Jarvis is annoying"],
        ["Jarvis's song", "Jarvis's song"],
        ["Jarvison play Numb", "Jarvison play Numb"],
        ["Jarvis. Jarvis!", ""], ["...", ""], ["", ""],
    ]) assert.equal(normalizeTranscript(input), expected);
});

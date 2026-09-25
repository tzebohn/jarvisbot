import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { VoiceCommandParser } from "../src/voice/commands/VoiceCommandParser.ts";
import { GroqCommandNormalizer, DEFAULT_COMMAND_MODEL } from "../src/voice/commands/GroqCommandNormalizer.ts";
import { CommandParserError } from "../src/voice/commands/types.ts";
import { createVoiceCommandParser } from "../src/voice/commands/config.ts";

const signal = () => new AbortController().signal;
const backend = (impl = async () => ({ type: "skip", query: null, confidence: 0.98 })) => ({
    model: "fixture", normalize: mock.fn(impl),
});
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body),
    { status, headers: { "content-type": "application/json", ...headers } });
const completion = (content, finish_reason = "stop") => ({ choices: [{ finish_reason, message: { content } }] });
const cloud = (fetch) => new GroqCommandNormalizer("test-key", DEFAULT_COMMAND_MODEL, fetch);

test("common commands, polite wrappers, and narrow STT variants need zero Groq calls", async () => {
    const fallback = backend();
    const parser = new VoiceCommandParser(fallback);
    for (const [input, type] of [
        ["Jarvis, pause.", "pause"], ["Hey Jarvis, Jarvis! Could you please pause the music?", "pause"],
        ["paws the music", "pause"], ["pause it please", "pause"], ["unpause", "resume"],
        ["resume the song", "resume"], ["continue playing", "resume"], ["start playing again", "resume"],
        ["SKIP", "skip"], ["skip this one", "skip"], ["next track", "skip"], ["play the next song", "skip"],
        ["go to the next track", "skip"], ["queue", "queue"], ["show me the cue", "queue"],
        ["what’s in the queue?", "queue"], ["what's up next", "queue"], ["list the queue for me", "queue"],
        ["stop", "stop"], ["please stop the music, thanks", "stop"],
        ["leave", "leave"], ["disconnect", "leave"], ["leave the channel", "leave"], ["disconnect from the channel", "leave"],
        ["Jarvis, leave", "leave"], ["Jarvis, disconnect", "leave"], ["Jarvis, leave the channel", "leave"],
        ["Jarvis, disconnect from the channel", "leave"], ["Hey Jarvis, Jarvis! Could you please leave the voice channel?", "leave"],
        ["DISCONNECT FROM THIS VOICE CHANNEL, PLEASE!", "leave"], ["please leave, thanks", "leave"],
    ]) {
        const result = await parser.parse(input, signal());
        assert.deepEqual(result.command, { type }, input);
        assert.equal(result.source, "local");
        assert.equal(result.confidence, undefined, "local matching does not invent probabilities");
    }
    assert.equal(fallback.normalize.mock.callCount(), 0);
});

test("play extracts opaque queries and preserves case, artists, versions and command words in titles", async () => {
    const fallback = backend(), parser = new VoiceCommandParser(fallback);
    for (const [input, query] of [
        ["Jarvis, play Numb by Linkin Park", "Numb by Linkin Park"],
        ["Could you play AC/DC’s Thunderstruck live, please", "AC/DC's Thunderstruck live"],
        ["put on Blinding Lights (Remix)", "Blinding Lights (Remix)"],
        ["queue up Earth, Wind & Fire - September", "Earth, Wind & Fire - September"],
        ["add Numb to the queue", "Numb"], ["play Don't Stop Me Now by Queen", "Don't Stop Me Now by Queen"],
        ["play Stop", "Stop"], ["play Leave", "Leave"], ["play Disconnect", "Disconnect"], ["play Jarvis Cocker", "Jarvis Cocker"],
        ['play "Say Please"', "Say Please"], ['play "Stop and Play", please', "Stop and Play"],
        ["play Numb by linking park", "Numb by linking park"],
        ["play https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
        ["play 夜に駆ける", "夜に駆ける"], ["play " + "a".repeat(500), "a".repeat(500)],
    ]) assert.deepEqual((await parser.parse(input, signal())).command, { type: "play", query }, input);
    assert.equal(fallback.normalize.mock.callCount(), 0);
});

test("definite rejections and truncated captures never spend a cloud request", async () => {
    const fallback = backend(), parser = new VoiceCommandParser(fallback);
    for (const [input, reason] of [
        [undefined, "invalid-input"], [null, "invalid-input"], [123, "invalid-input"], [{ type: "skip" }, "invalid-input"],
        ["a".repeat(1001), "invalid-input"], ["skip\0", "invalid-input"], ["", "empty"], ["...", "empty"],
        ["Hey Jarvis, Jarvis!", "empty"], ["play", "missing-query"], ["put on please", "missing-query"],
        ["play it", "missing-query"], ["play the music", "missing-query"], ["play " + "x".repeat(501), "missing-query"],
        ["don't skip", "negated"], ["could you please not pause", "negated"], ["if I say skip", "negated"],
        ["shuffle", "unsupported"], ["join the channel", "unsupported"], ["loop the song", "unsupported"],
        ["don't leave", "negated"], ["do not disconnect from the channel", "negated"],
        ["if I say leave", "negated"], ["could you please not leave", "negated"],
        ["set the volume to 50", "unsupported"], ["clear the queue", "unsupported"],
        ["play Numb and then stop", "multiple-commands"], ["pause or skip", "multiple-commands"],
        ["skip; play Starboy", "multiple-commands"], ["pause. Resume", "multiple-commands"],
        ['play "Numb" and skip', "multiple-commands"],
        ["stop and leave", "multiple-commands"], ["leave and play Numb", "multiple-commands"],
        ["pause then disconnect", "multiple-commands"],
    ]) {
        const result = await parser.parse(input, signal());
        assert.deepEqual(result.command, { type: "unknown" }, input);
        assert.equal(result.reason, reason, input);
    }
    assert.equal((await parser.parse("skip", signal(), { truncated: true })).reason, "truncated");
    assert.equal(fallback.normalize.mock.callCount(), 0);
});

test("ambiguous politeness suffixes go to the fallback without locally deleting title words", async () => {
    const fallback = backend(async () => ({ type: "play", query: "Say Please", confidence: 0.95 }));
    const result = await new VoiceCommandParser(fallback).parse("play Say Please", signal());
    assert.deepEqual(result.command, { type: "play", query: "Say Please" });
    assert.equal(result.source, "groq");
    assert.equal(fallback.normalize.mock.calls[0].arguments[0], "play Say Please");
});

test("uncertain phrasing falls back once; conversation and unsupported semantics can remain unknown", async () => {
    const fallback = backend(async (text) => text === "move on from this track"
        ? { type: "skip", query: null, confidence: 0.98 } : { type: "unknown", query: null, confidence: 0.99 });
    const parser = new VoiceCommandParser(fallback);
    assert.deepEqual((await parser.parse("move on from this track", signal())).command, { type: "skip" });
    for (const text of ["my Jarvis is annoying", "we talked about skipping songs", "skip two songs",
        "pause after this song", "play Numb after this song", "can you tell me a joke"]) {
        const result = await parser.parse(text, signal());
        assert.equal(result.source, "groq");
        assert.equal(result.command.type, "unknown");
    }
    assert.equal(fallback.normalize.mock.callCount(), 7);
    assert.equal((await new VoiceCommandParser().parse("move on from this track", signal())).reason, "local-only");
});

test("real Groq SDK sends only bounded transcript data with strict schema, the free-plan model, and no tools", async () => {
    const fetch = mock.fn(async (url, init) => {
        const req = new Request(url, init);
        assert.equal(req.url, "https://api.groq.com/openai/v1/chat/completions");
        const body = await req.json();
        assert.equal(body.model, "openai/gpt-oss-20b");
        assert.equal(body.temperature, 0);
        assert.equal(body.max_completion_tokens, 1024);
        assert.equal(body.reasoning_effort, "low");
        assert.equal(body.tools, undefined);
        assert.equal(body.response_format.type, "json_schema");
        assert.equal(body.response_format.json_schema.strict, true);
        assert.deepEqual(body.response_format.json_schema.schema.properties.type.enum,
            ["play", "pause", "resume", "skip", "queue", "stop", "leave", "unknown"]);
        assert.equal(body.messages.length, 2);
        assert.deepEqual(body.messages[1], { role: "user", content: "I'd like to hear Numb by Linkin Park live" });
        return json(completion(JSON.stringify({ type: "play", query: "Numb by Linkin Park live", confidence: 0.97 })));
    });
    const result = await new VoiceCommandParser(cloud(fetch)).parse("I'd like to hear Numb by Linkin Park live", signal());
    assert.deepEqual(result.command, { type: "play", query: "Numb by Linkin Park live" });
    assert.equal(result.confidence, 0.97);
    assert.equal(result.model, DEFAULT_COMMAND_MODEL);
    assert.equal(fetch.mock.callCount(), 1);
});

test("less structured leave requests use the Groq schema and normalize to the same argument-free intent", async () => {
    const fetch = mock.fn(async (url, init) => {
        const body = await new Request(url, init).json();
        assert.ok(body.response_format.json_schema.schema.properties.type.enum.includes("leave"));
        assert.match(body.messages[0].content, /leave: immediately disconnect the bot from its current voice channel/);
        assert.equal(body.messages[1].content, "you can head out of voice now");
        return json(completion(JSON.stringify({ type: "leave", query: null, confidence: 0.97 })));
    });
    const result = await new VoiceCommandParser(cloud(fetch)).parse("Jarvis, you can head out of voice now", signal());
    assert.deepEqual(result.command, { type: "leave" });
    assert.equal(result.source, "groq");
    assert.equal(fetch.mock.callCount(), 1);

    const fallback = backend(async () => ({ type: "unknown", query: null, confidence: 0.99 }));
    const parser = new VoiceCommandParser(fallback);
    for (const text of ["leave after this song", "disconnect when the queue ends", "disconnect Alice", "we talked about leaving"]) {
        const result = await parser.parse(text, signal());
        assert.deepEqual(result.command, { type: "unknown" });
        assert.equal(result.source, "groq", "only the complete leave grammar is deterministic");
    }
    const low = await new VoiceCommandParser(backend(async () => ({ type: "leave", query: null, confidence: 0.89 })))
        .parse("you can head out of voice now", signal());
    assert.equal(low.command.type, "unknown");
    assert.equal(low.reason, "low-confidence");
});

test("model output is validated rather than cast, including unsupported types, extra fields and hallucinated queries", async () => {
    for (const data of [null, [], "skip", {}, { type: "skip", query: null },
        { type: "disconnect", query: null, confidence: 1 }, { type: "skip", query: "Numb", confidence: 1 },
        { type: "leave", query: "channel", confidence: 1 }, { type: "leave", query: null, confidence: 1, channelId: "other" },
        { type: "skip", query: null, confidence: "1" }, { type: "skip", query: null, confidence: 1.1 },
        { type: "skip", query: null, confidence: NaN }, { type: "skip", query: null, confidence: 1, execute: "arbitrary" },
        { type: "unknown", query: "something", confidence: 1 }, { type: "play", query: "", confidence: 1 },
        { type: "play", query: "Invented song", confidence: 1 }, { type: "play", query: "Num", confidence: 1 },
        { type: "play", query: "Numb ", confidence: 1 }, { type: "play", query: "Numb by Linkin Park", confidence: 1 },
    ]) {
        const result = await new VoiceCommandParser(backend(async () => data)).parse("I'd like to hear Numb", signal());
        assert.equal(result.command.type, "unknown", JSON.stringify(data));
        assert.equal(result.reason, "invalid-response", JSON.stringify(data));
    }
    const low = await new VoiceCommandParser(backend(async () => ({ type: "skip", query: null, confidence: 0.89 })))
        .parse("move on from this track", signal());
    assert.equal(low.reason, "low-confidence");
    assert.equal(low.command.type, "unknown");
    assert.equal(low.confidence, 0.89);
});

test("refusals, malformed JSON, tool calls, and truncated completions stay unknown without retries", async () => {
    for (const data of [completion("not JSON"), completion("```json\n{}\n```"), completion(null),
        completion('{"type":"skip","query":null,"confidence":1}', "length"), { choices: [] },
        { choices: [{ finish_reason: "stop", message: { content: "{}", tool_calls: [{}] } }] },
    ]) {
        const fetch = mock.fn(async () => json(data));
        const result = await new VoiceCommandParser(cloud(fetch)).parse("move on from this track", signal());
        assert.equal(result.reason, "invalid-response");
        assert.equal(fetch.mock.callCount(), 1);
    }
});

test("cache saves repeated requests, expires, and cannot be corrupted by a consumer", async () => {
    let now = 0;
    const fallback = backend(), parser = new VoiceCommandParser(fallback, { now: () => now });
    const first = await parser.parse("move on from this track", signal());
    first.command.type = "stop";
    const cached = await parser.parse("move on from this track", signal());
    assert.equal(cached.cached, true);
    assert.equal(cached.command.type, "skip");
    assert.equal(fallback.normalize.mock.callCount(), 1);
    now = 300_000;
    assert.equal((await parser.parse("move on from this track", signal())).cached, false);
    assert.equal(fallback.normalize.mock.callCount(), 2);
    assert.equal((await parser.parse("different uncertain words", signal())).cached, false);
    assert.equal(fallback.normalize.mock.callCount(), 3);
});

test("shared rolling budgets reserve concurrent requests, expire, and keep local commands available", async () => {
    let now = 0;
    const fallback = backend(), parser = new VoiceCommandParser(fallback, { now: () => now });
    const first = await Promise.all(Array.from({ length: 11 }, (_, i) => parser.parse(`uncertain request ${i}`, signal())));
    assert.equal(fallback.normalize.mock.callCount(), 10);
    assert.equal(first[10].reason, "rate-limited");
    assert.equal((await parser.parse("skip", signal())).command.type, "skip");
    assert.equal((await parser.parse("uncertain request 0", signal())).cached, true);
    for (let minute = 1; minute < 25; minute++) {
        now = minute * 60_001;
        await Promise.all(Array.from({ length: 10 }, (_, i) => parser.parse(`uncertain ${minute} ${i}`, signal())));
    }
    now += 60_001;
    assert.equal((await parser.parse("daily exhausted", signal())).reason, "rate-limited");
    assert.equal(fallback.normalize.mock.callCount(), 250);
    now = 86_400_001;
    assert.equal((await parser.parse("daily reset", signal())).source, "groq");
    assert.equal(fallback.normalize.mock.callCount(), 251);
});

for (const [status, reason] of [[429, "rate-limited"], [408, "timeout"], [500, "unavailable"], [503, "unavailable"],
    [400, "configuration"], [401, "configuration"], [403, "configuration"], [404, "configuration"]]) {
    test(`Groq HTTP ${status} returns a sanitized unknown result, no retries, and a shared cooldown`, async () => {
        let now = 0;
        const fetch = mock.fn(async () => json({ error: { message: "sensitive body" } }, status, { "retry-after": "120" }));
        const parser = new VoiceCommandParser(cloud(fetch), { now: () => now });
        const result = await parser.parse("move on from this track", signal());
        assert.equal(result.command.type, "unknown");
        assert.equal(result.reason, reason);
        assert.ok(!JSON.stringify(result).includes("sensitive"));
        assert.ok(!JSON.stringify(result).includes("test-key"));
        assert.equal((await parser.parse("another uncertain phrase", signal())).reason, reason);
        assert.equal((await parser.parse("stop", signal())).command.type, "stop");
        assert.equal(fetch.mock.callCount(), 1);
        now = 301_000;
        await parser.parse("try again later", signal());
        assert.equal(fetch.mock.callCount(), 2);
    });
}

test("timeouts abort I/O, late results are ignored, and cancellation is propagated rather than classified", async () => {
    let requestSignal, finish;
    const fallback = backend((_text, signal) => {
        requestSignal = signal;
        return new Promise((resolve) => { finish = resolve; });
    });
    const parser = new VoiceCommandParser(fallback, { timeoutMs: 10 });
    assert.equal((await parser.parse("move on from this track", signal())).reason, "timeout");
    assert.equal(requestSignal.aborted, true);
    finish({ type: "skip", query: null, confidence: 1 });
    const abort = new AbortController();
    const pending = new VoiceCommandParser(fallback).parse("some other phrase", abort.signal);
    abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(requestSignal.aborted, true);
    await assert.rejects(parser.parse("skip", abort.signal), { name: "AbortError" });
});

test("network failures stay unknown; transient errors are not cached", async () => {
    const fetch = mock.fn(async () => { throw new TypeError("network failed"); });
    assert.equal((await new VoiceCommandParser(cloud(fetch)).parse("uncertain words", signal())).reason, "unavailable");
    let now = 0;
    const fallback = backend();
    fallback.normalize.mock.mockImplementationOnce(async () => { throw new CommandParserError("unavailable"); });
    const parser = new VoiceCommandParser(fallback, { now: () => now });
    assert.equal((await parser.parse("uncertain words", signal())).reason, "unavailable");
    now = 15_001;
    assert.equal((await parser.parse("uncertain words", signal())).command.type, "skip");
    assert.equal(fallback.normalize.mock.callCount(), 2);
});

test("configuration reuses GROQ_API_KEY, supports local-only use, and rejects invalid modes", async () => {
    for (const env of [{}, { VOICE_COMMAND_MODE: "local", GROQ_API_KEY: "unused" }]) {
        const parser = createVoiceCommandParser(env);
        assert.equal((await parser.parse("pause", signal())).command.type, "pause");
        assert.equal((await parser.parse("unusual request", signal())).reason, "local-only");
    }
    assert.throws(() => createVoiceCommandParser({ VOICE_COMMAND_MODE: "invalid" }), /VOICE_COMMAND_MODE/);
});

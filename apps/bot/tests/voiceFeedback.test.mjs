import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { mock, test } from "node:test";
import { DiscordVoiceCommandFeedback } from "../src/voice/feedback/DiscordVoiceCommandFeedback.ts";

function setup() {
    const messages = [];
    const makeMessage = (payload) => {
        const message = { ...payload, edit: mock.fn(async (next) => { Object.assign(message, next); return message; }) };
        messages.push(message);
        return message;
    };
    const channel = { isSendable: () => true, send: mock.fn(async (payload) => makeMessage(payload)) };
    const client = { guilds: { cache: new Map([["guild", { channels: { cache: new Map([["voice", channel]]) } }]]) } };
    const feedback = new DiscordVoiceCommandFeedback(client);
    const identity = { guildId: "guild", userId: "user", sessionId: "first", voiceChannelId: "voice" };
    const update = (value, sessionId = "first") => feedback.update({ ...identity, sessionId, update: value });
    return { channel, messages, makeMessage, feedback, identity, update };
}

test("slow Discord sends coalesce progress and keep terminal outcomes on the correct session's message", async () => {
    const f = setup();
    let send;
    f.channel.send.mock.mockImplementationOnce((payload) => new Promise((resolve) => { send = () => resolve(f.makeMessage(payload)); }));
    f.update({ state: "listening" });
    f.update({ state: "processing" });
    f.update({ state: "searching", query: "older" });
    f.update({ state: "failed", reason: "cancelled" });
    f.update({ state: "listening" }, "second");
    f.update({ state: "completed", content: "New command completed." }, "second");
    await setImmediate();
    send();
    await setImmediate();
    assert.equal(f.channel.send.mock.callCount(), 2);
    assert.equal(f.messages[0].content, "New command completed.");
    assert.match(f.messages[1].content, /cancelled/);
    assert.equal(f.messages[1].edit.mock.callCount(), 1, "obsolete progress wasn't queued behind the slow send");
    f.update({ state: "searching", query: "stale" });
    await setImmediate();
    assert.match(f.messages[1].content, /cancelled/);
});

test("a deleted status is replaced once and cancellation during replacement isn't lost", async () => {
    const f = setup();
    f.update({ state: "listening" });
    await setImmediate();
    f.messages[0].edit.mock.mockImplementationOnce(async () => { throw Object.assign(new Error("deleted"), { code: 10008 }); });
    let replace;
    f.channel.send.mock.mockImplementationOnce((payload) => new Promise((resolve) => { replace = () => resolve(f.makeMessage(payload)); }));
    f.update({ state: "processing" });
    await setImmediate();
    f.update({ state: "failed", reason: "cancelled" });
    replace();
    await setImmediate();
    assert.equal(f.channel.send.mock.callCount(), 2);
    assert.match(f.messages[1].content, /cancelled/);
});

test("edit permissions failures disable that session's writes and leave subsequent sessions independent", async (context) => {
    context.mock.method(console, "error", () => {});
    const f = setup();
    f.update({ state: "listening" });
    await setImmediate();
    f.messages[0].edit.mock.mockImplementationOnce(async () => { throw Object.assign(new Error("private permissions detail"), { code: 50013 }); });
    f.update({ state: "processing" });
    await setImmediate();
    f.update({ state: "failed", reason: "stt-failed" });
    f.update({ state: "listening" }, "second");
    f.update({ state: "completed" }, "second");
    await setImmediate();
    assert.equal(f.channel.send.mock.callCount(), 2);
    assert.equal(f.messages[0].edit.mock.callCount(), 1);
    assert.match(f.messages[1].content, /completed/);
    assert.ok(f.messages.every((message) => !message.content.includes("private")));
});

test("playback feedback is bounded, markdown-escaped, mention-safe, and never exposes internal IDs or URLs", async () => {
    const f = setup();
    const track = { title: "*".repeat(300) + "@everyone", artist: "_".repeat(300), id: "private-id", url: "https://youtu.be/abcdefghijk" };
    f.update({ state: "listening" });
    f.update({ state: "playing", track });
    await setImmediate();
    const message = f.messages[0];
    assert.ok(message.content.length <= 2000);
    assert.ok(message.content.includes("\\*\\*"));
    assert.match(message.content, /▶️ Playing/);
    assert.doesNotMatch(message.content, /private-id|https?:\/\/|confiden|suggestion|\n\d\./i);
    assert.deepEqual(message.allowedMentions.parse, []);
    assert.deepEqual(f.channel.send.mock.calls[0].arguments[0].allowedMentions.parse, []);
});

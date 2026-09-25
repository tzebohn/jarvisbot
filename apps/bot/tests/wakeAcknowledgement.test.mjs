import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { beforeEach, mock, test } from "node:test";
import opus from "@discordjs/opus";
import { FakeConnection, resetVoiceMocks, voice } from "./helpers/voice.mjs";

const { VoiceReceiveManager } = await import("../src/voice/VoiceReceiveManager.ts");
const { PCM_FORMAT } = await import("../src/voice/receive/SpeakerStream.ts");
const { wakeAcknowledgementDelay } = await import("../src/voice/feedback/WakeAcknowledgement.ts");
const { WAKE_KEYWORD } = await import("../src/voice/wake/wakeModel.ts");
beforeEach(resetVoiceMocks);

function activation(overrides = {}) {
    return { guildId: "guild-a", userId: "alice", streamId: "a1", streamEnded: false,
        detectedAt: Date.now(), phrase: "Jarvis", format: PCM_FORMAT, preRoll: Buffer.alloc(1000 * 192),
        preRollStartMs: 0, audioTimeMs: 1000, processedAudioTimeMs: 1000,
        keywordEndMs: 600, lastVoiceTimeMs: 680, ...overrides };
}

function frame(controller, overrides = {}) {
    const event = { guildId: "guild-a", userId: "alice", streamId: "a1", pcm: Buffer.alloc(3840, 3),
        format: PCM_FORMAT, audioTimeMs: 1020, isVoice: true, isSpeaking: false, ...overrides };
    controller.emit("pcm", event);
    return event.pcm;
}

function endSpeech(controller, audioTimeMs = 680, streamId = "a1") {
    controller.emit("speech", { guildId: "guild-a", userId: "alice", streamId,
        type: "speech-end", reason: "silence", audioTimeMs, durationMs: audioTimeMs });
}

function setup(context, options = {}, factories = {}) {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const requests = [], captures = [], ends = [], feedback = [];
    const play = mock.fn((request) => { requests.push(request); request.onStart(920); });
    const manager = new VoiceReceiveManager(false,
        factories.vad ?? (() => ({ isSpeech: () => true, destroy() {} })),
        factories.wake ?? (() => ({ accept: async () => [], destroy() {} })), false,
        { playWakeAcknowledgement: play, ...options });
    const connection = new FakeConnection();
    context.after(() => { manager.destroy(); if (connection.state.status !== voice.VoiceConnectionStatus.Destroyed) connection.destroy(); });
    const controller = manager.attach(connection);
    const sessions = manager.getSessions("guild-a");
    sessions.on("capture", (event) => captures.push(event));
    sessions.on("end", (event) => ends.push(event));
    manager.on("feedback", (event) => feedback.push(event));
    return { manager, connection, controller, sessions, play, requests, captures, ends, feedback,
        tick: (ms) => context.mock.timers.tick(ms) };
}

test("configuration has a named 700 ms default and is bounded by the session's existing timers", (context) => {
    assert.equal(wakeAcknowledgementDelay(""), 700);
    assert.equal(wakeAcknowledgementDelay("850"), 850);
    for (const value of ["abc", "0", "-1", "1.2", "Infinity"]) assert.throws(() => wakeAcknowledgementDelay(value), /VOICE_WAKE_ACK_DELAY_MS/);
    assert.throws(() => setup(context, { wakeAckDelayMs: 1500 }), /acknowledgement delay/);
});

for (const pause of [0, 150, 650]) {
    test(`command speech after ${pause} ms suppresses the cue without delaying capture`, async (context) => {
        const f = setup(context);
        f.controller.emit("wake", activation());
        assert.equal(f.feedback[0].update.state, "listening");
        f.tick(pause);
        const command = frame(f.controller);
        f.tick(700 - pause);
        await setImmediate();
        assert.equal(f.play.mock.callCount(), 0);
        endSpeech(f.controller, 1020);
        await setImmediate();
        assert.equal(f.captures.length, 1);
        assert.deepEqual(f.captures[0].pcm.subarray(-3840), command);
        assert.equal(f.sessions.state, "idle");
    });
}

test("command speech already in the wake pre-roll suppresses the cue even if it has ended", async (context) => {
    const f = setup(context);
    f.controller.emit("wake", activation({ lastVoiceTimeMs: 960 }));
    f.tick(700);
    await setImmediate();
    assert.equal(f.play.mock.callCount(), 0);
    f.tick(800);
    await setImmediate();
    assert.equal(f.captures.length, 1);
});

for (const streamId of ["a1", "a2"]) {
    test(`a late wake observes command VAD history in catch-up stream ${streamId}`, async (context) => {
        const f = setup(context);
        context.mock.method(f.controller, "getAudioSnapshot", () => ({ streamId, audioTimeMs: 1200,
            pcm: Buffer.alloc(1200 * 192), isSpeaking: false, lastVoiceTimeMs: 1100 }));
        f.controller.emit("wake", activation());
        f.tick(700);
        await setImmediate();
        assert.equal(f.play.mock.callCount(), 0);
    });
}

test("wake-only VAD end stays listening, plays once, and accepts a command after the complete cue", async (context) => {
    const f = setup(context);
    f.controller.emit("wake", activation());
    endSpeech(f.controller);
    f.tick(699);
    await setImmediate();
    assert.equal(f.play.mock.callCount(), 0);
    assert.equal(f.sessions.state, "listening");
    f.tick(1);
    await setImmediate();
    assert.equal(f.play.mock.callCount(), 1);
    assert.equal(f.requests[0].sessionId, f.feedback[0].sessionId);
    f.controller.emit("wake", activation());
    f.tick(1320); // 920 ms cue, then 400 ms for the user to respond.
    assert.equal(f.sessions.state, "listening", "the original 1500 ms deadline was re-armed, not left running");
    frame(f.controller);
    assert.equal(f.requests[0].signal.aborted, true);
    endSpeech(f.controller, 1020);
    await setImmediate();
    assert.equal(f.captures.length, 1);
    assert.equal(f.sessions.state, "idle");
    assert.equal(f.play.mock.callCount(), 1);
});

test("silence after acknowledgement expires on the same wall timer and returns to idle", async (context) => {
    const f = setup(context);
    f.controller.emit("wake", activation());
    f.tick(700);
    await setImmediate();
    f.tick(2419);
    assert.equal(f.sessions.state, "listening");
    f.tick(1);
    await setImmediate();
    assert.equal(f.captures[0].reason, "silence-timeout");
    assert.equal(f.requests[0].signal.aborted, true);
    assert.equal(f.requests[0].canPlay(), false);
    assert.equal(f.sessions.state, "idle");
    assert.equal(f.controller.wakeState, "listening");
});

test("PCM queued on the acknowledgement deadline wins before its deferred playback request", async (context) => {
    const f = setup(context);
    f.controller.emit("wake", activation());
    f.tick(700);
    frame(f.controller);
    await setImmediate();
    assert.equal(f.play.mock.callCount(), 0);
});

test("the configured acknowledgement delay controls eligibility without moving capture start", async (context) => {
    const f = setup(context, { wakeAckDelayMs: 850 });
    f.controller.emit("wake", activation());
    assert.equal(f.sessions.state, "contention");
    f.tick(849);
    await setImmediate();
    assert.equal(f.play.mock.callCount(), 0);
    f.tick(1);
    await setImmediate();
    assert.equal(f.play.mock.callCount(), 1);
});

test("speech cancels an asynchronous playback handoff before it can emit audio", async (context) => {
    let finish, request;
    let emitted = 0;
    const f = setup(context, { playWakeAcknowledgement: async (event) => {
        request = event;
        await new Promise((resolve) => { finish = resolve; });
        if (!event.signal.aborted && event.canPlay()) emitted++;
    } });
    f.controller.emit("wake", activation());
    f.tick(700);
    await setImmediate();
    frame(f.controller);
    finish();
    await setImmediate();
    assert.equal(request.signal.aborted, true);
    assert.equal(emitted, 0);
});

for (const when of ["pending", "playing"]) for (const reason of ["departure", "reset", "disconnect", "destroy", "replacement", "contention", "processing"]) {
    if (when === "playing" && reason === "contention") continue;
    test(`${reason} cancels a ${when} acknowledgement and stale eligibility cannot revive`, async (context) => {
        const f = setup(context);
        f.controller.emit("wake", activation());
        if (when === "playing") { f.tick(700); await setImmediate(); }
        if (reason === "departure") f.controller.stopUser("alice");
        if (reason === "reset") f.controller.reset("cancelled");
        if (reason === "disconnect") f.connection.setStatus(voice.VoiceConnectionStatus.Disconnected);
        if (reason === "destroy") f.manager.destroy();
        if (reason === "replacement") f.manager.attach(new FakeConnection());
        if (reason === "contention") {
            f.controller.emit("wake", activation({ userId: "bob", streamId: "b1" }));
        }
        if (reason === "processing") { endSpeech(f.controller, 1040); f.tick(300); }
        const priorCalls = f.play.mock.callCount();
        f.tick(60_000);
        await setImmediate();
        assert.equal(f.play.mock.callCount(), priorCalls);
        if (f.requests.length) {
            assert.equal(f.requests[0].signal.aborted, true);
            assert.equal(f.requests[0].canPlay(), false);
        }
        assert.equal(f.sessions.state, "idle");
    });
}

test("an old cue request cannot play into the next session, even for the same user", async (context) => {
    const f = setup(context);
    f.controller.emit("wake", activation());
    f.tick(700);
    await setImmediate();
    const old = f.requests[0];
    f.controller.stopUser("alice");
    f.controller.emit("wake", activation({ streamId: "a2" }));
    f.tick(700);
    await setImmediate();
    assert.notEqual(f.requests[1].sessionId, old.sessionId);
    assert.equal(old.canPlay(), false);
    assert.equal(old.signal.aborted, true);
    assert.equal(f.requests[1].canPlay(), true);
});

test("unrelated users, guilds, old streams and unvoiced frames cannot cancel or extend the cue", async (context) => {
    const f = setup(context);
    f.controller.emit("wake", activation());
    frame(f.controller, { userId: "bob" });
    frame(f.controller, { guildId: "guild-b" });
    frame(f.controller, { isVoice: false });
    f.tick(700);
    await setImmediate();
    assert.equal(f.play.mock.callCount(), 1);
    f.controller.emit("streamStart", { guildId: "guild-a", userId: "alice", streamId: "a2" });
    frame(f.controller, { streamId: "a1" });
    assert.equal(f.requests[0].signal.aborted, false);
    frame(f.controller, { streamId: "a2", audioTimeMs: 20 });
    assert.equal(f.requests[0].signal.aborted, true);
});

test("a failed cue keeps capture alive and the hard maximum still bounds an extended listening allowance", async (context) => {
    const f = setup(context, { playWakeAcknowledgement: (request) => {
        request.onStart(20_000);
        throw new Error("fixture output failure");
    } });
    f.controller.emit("wake", activation());
    f.tick(700);
    await setImmediate();
    assert.equal(f.sessions.state, "listening");
    f.tick(9300);
    await setImmediate();
    assert.equal(f.captures[0].reason, "max-duration");
    assert.equal(f.sessions.state, "idle");
});

for (const command of [false, true]) test(`real receive VAD history survives wake flush (command already spoken: ${command})`, async (context) => {
    let voiced = true, flush;
    const f = setup(context, {}, {
        vad: () => ({ isSpeech: () => voiced, destroy() {} }),
        wake: () => ({ accept: async (_samples, final) => final ? new Promise((resolve) => { flush = resolve; }) : [], destroy() {} }),
    });
    f.connection.receiver.speaking.emit("start", "alice");
    const source = f.connection.receiver.subscriptions.get("alice");
    const encoder = new opus.OpusEncoder(48_000, 2);
    const push = (count) => { for (let i = 0; i < count; i++) source.push(encoder.encode(Buffer.alloc(3840))); };
    push(30);
    await setImmediate();
    voiced = false;
    push(30);
    source.push(null);
    await setImmediate();
    flush([{ keyword: WAKE_KEYWORD, keywordEndMs: command ? 100 : 500 }]);
    await setImmediate();
    f.tick(700);
    await setImmediate();
    assert.equal(f.play.mock.callCount(), command ? 0 : 1, "voice at 600 ms survives the closed speaker's VAD cleanup");
    assert.equal(f.sessions.state, "listening");
});

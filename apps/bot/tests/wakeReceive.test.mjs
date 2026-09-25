import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { beforeEach, mock, test } from "node:test";
import opus from "@discordjs/opus";
import { FakeConnection, connections, players, voice, resetVoiceMocks } from "./helpers/voice.mjs";
import { message, content, music } from "./helpers/messages.mjs";

const { VoiceReceiveManager } = await import("../src/voice/VoiceReceiveManager.ts");
const { VoiceController } = await import("../src/voice/VoiceController.ts");
const { createMessageHandler } = await import("../src/handleMessage.ts");
const { MusicService } = await import("../src/music/MusicService.ts");
const { WAKE_KEYWORD, WAKE_PHRASE, WAKE_PRONUNCIATIONS } = await import("../src/voice/wake/wakeModel.ts");
beforeEach(resetVoiceMocks);

function setup(context, speech = true) {
    const backends = [];
    const createWake = mock.fn(() => {
        const backend = { accept: mock.fn(async () => [{ keyword: WAKE_KEYWORD }]), destroy: mock.fn() };
        backends.push(backend);
        return backend;
    });
    const createVad = () => ({ isSpeech: () => speech, destroy() {} });
    // This suite isolates V3; session ownership is exercised in voiceSessions.test.mjs.
    const manager = new VoiceReceiveManager(false, createVad, createWake, false, false);
    const connection = new FakeConnection();
    const controller = manager.attach(connection);
    context.after(() => { if (connection.state.status !== voice.VoiceConnectionStatus.Destroyed) connection.destroy(); });
    const events = [];
    manager.on("wake", (event) => events.push(event));
    return { manager, controller, connection, events, createWake, createVad, backends };
}

function speak(connection, userId, amplitude = 1000, count = 6) {
    connection.receiver.speaking.emit("start", userId);
    const source = connection.receiver.subscriptions.get(userId);
    const encoder = new opus.OpusEncoder(48_000, 2);
    const pcm = Buffer.alloc(3840);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(amplitude, i);
    for (let i = 0; i < count; i++) source.push(encoder.encode(pcm));
    return source;
}

test("wake activations preserve the correct guild, speaker, and independent pre-roll during overlap", async (context) => {
    const f = setup(context);
    const a = f.controller.waitForWake("alice");
    const b = f.controller.waitForWake("bob");
    const alice = speak(f.connection, "alice", 1000);
    const bob = speak(f.connection, "bob", -3000);
    const [first, second] = await Promise.all([a.result, b.result]);
    assert.equal(first.guildId, "guild-a");
    assert.equal(first.userId, "alice");
    assert.equal(second.userId, "bob");
    assert.notDeepEqual(first.preRoll, second.preRoll);
    assert.equal(first.phrase, WAKE_PHRASE);
    assert.equal(first.confidence, undefined);
    assert.equal(first.preRoll.length, 6 * 3840, "include all PCM received while asynchronous inference was pending");
    assert.equal(first.audioTimeMs, 120);
    assert.equal(first.preRollStartMs, 0);
    assert.ok(first.streamId);
    assert.equal(f.createWake.mock.callCount(), 2);
    alice.push(null); bob.push(null);
    await setImmediate();
    assert.equal(f.connection.receiver.subscriptions.size, 0);
    assert.ok(f.backends.every((backend) => backend.destroy.mock.callCount() === 1));
    assert.equal(first.preRoll.length, 6 * 3840, "preserved audio survives VAD/stream cleanup");
});

test("wake state and cooldowns are isolated per guild and per user", async (context) => {
    const f = setup(context);
    let now = 1000;
    context.mock.method(Date, "now", () => now);
    const otherConnection = new FakeConnection();
    otherConnection.joinConfig.guildId = "guild-b";
    context.after(() => otherConnection.destroy());
    const other = f.manager.attach(otherConnection);
    const a = f.controller.waitForWake("alice");
    const b = other.waitForWake("alice");
    speak(f.connection, "alice").push(null);
    speak(otherConnection, "alice").push(null);
    assert.equal((await a.result).guildId, "guild-a");
    assert.equal((await b.result).guildId, "guild-b");
    await setImmediate();
    assert.equal(f.events.length, 2);
    speak(f.connection, "alice").push(null);
    await setImmediate();
    assert.equal(f.events.length, 2, "same user's repeated wake is suppressed for three seconds");
    now += 3001;
    speak(f.connection, "alice").push(null);
    await setImmediate();
    assert.equal(f.events.length, 3);
});

test("different Jarvis paths share the same user's cooldown and carry pronunciation diagnostics", async (context) => {
    const f = setup(context);
    let now = 1000;
    context.mock.method(Date, "now", () => now);
    speak(f.connection, "alice").push(null);
    await setImmediate();
    assert.equal(f.events[0].pronunciationId, "canonical");
    const alternate = WAKE_PRONUNCIATIONS.find(({ id }) => id === "rhotic-ih");
    f.createWake.mock.mockImplementation(() => ({ accept: async () => [{ keyword: alternate.keyword }], destroy() {} }));
    speak(f.connection, "alice").push(null);
    await setImmediate();
    assert.equal(f.events.length, 1, "another pronunciation cannot bypass cooldown");
    now += 3001;
    speak(f.connection, "alice").push(null);
    await setImmediate();
    assert.equal(f.events.length, 2);
    assert.equal(f.events[1].pronunciationId, alternate.id);
    assert.equal(f.events[1].phrase, "Jarvis");
});

test("pause/resume preserves PCM receiving, suppresses inference, and excludes old command audio", async (context) => {
    const f = setup(context);
    let now = 1000;
    context.mock.method(Date, "now", () => now);
    const frames = [];
    const states = [];
    f.controller.on("pcm", (frame) => frames.push(frame));
    f.controller.on("wakeState", (state) => states.push(state.state));
    f.controller.once("wake", () => f.controller.setWakeListening(false, "command-listening"));
    const source = speak(f.connection, "alice");
    await setImmediate();
    assert.equal(f.events.length, 1);
    assert.equal(f.controller.wakeState, "paused");
    assert.equal(f.backends[0].destroy.mock.callCount(), 1);
    assert.throws(() => f.controller.waitForWake("alice"), /paused/);
    const retained = Buffer.from(frames[0].pcm);
    speak(f.connection, "alice", -3000, 10);
    await setImmediate();
    assert.equal(frames.length, 16, "Phase 4 can receive the owner while wake inference is paused");
    assert.equal(f.createWake.mock.callCount(), 1);
    assert.equal(f.events.length, 1);
    assert.deepEqual(frames[0].pcm, retained, "PCM events own their data");
    f.controller.setWakeListening(true, "command-complete");
    now += 3000;
    speak(f.connection, "alice", 1000, 6);
    await setImmediate();
    assert.equal(f.events.length, 2, "resume permits a fresh wake after the user's cooldown");
    assert.equal(f.events[1].preRollStartMs, 320);
    assert.equal(f.events[1].audioTimeMs, 440);
    assert.equal(f.events[1].preRoll.length, 6 * 3840);
    assert.equal(f.backends[1].accept.mock.calls[0].arguments[0].length, 960, "no paused-session prefix is reprocessed");
    const live = frames.filter((frame) => frame.streamId === f.events[0].streamId && frame.audioTimeMs > f.events[0].audioTimeMs);
    assert.equal(live.length, 16, "pre-roll plus frames after its watermark are contiguous without duplicates");
    assert.deepEqual(states, ["paused", "listening"]);
    source.push(null);
});

test("pausing cancels an in-flight wake and leaves other guilds listening", async (context) => {
    const f = setup(context);
    let resolve;
    f.createWake.mock.mockImplementationOnce(() => ({ accept: () => new Promise((done) => { resolve = done; }), destroy() {} }));
    const otherConnection = new FakeConnection();
    otherConnection.joinConfig.guildId = "guild-b";
    context.after(() => otherConnection.destroy());
    const other = f.manager.attach(otherConnection);
    const source = speak(f.connection, "alice");
    await setImmediate();
    f.controller.setWakeListening(false);
    resolve([{ keyword: WAKE_KEYWORD }]);
    await setImmediate();
    assert.equal(f.events.length, 0);
    assert.equal(other.wakeState, "listening");
    const watch = other.waitForWake("bob");
    speak(otherConnection, "bob").push(null);
    assert.equal((await watch.result).guildId, "guild-b");
    assert.equal(source.destroyed, false);
    f.connection.setStatus(voice.VoiceConnectionStatus.Disconnected);
    assert.equal(f.controller.wakeState, "unavailable");
    f.connection.setStatus(voice.VoiceConnectionStatus.Ready);
    assert.equal(f.controller.wakeState, "listening", "connection reset clears an abandoned pause");
});

test("a flush-only wake identifies an already-ended stream and exposes lifecycle events", async (context) => {
    const f = setup(context);
    f.createWake.mock.mockImplementation(() => ({
        accept: async (_samples, final) => final ? [{ keyword: WAKE_KEYWORD }] : [], destroy() {},
    }));
    const ends = [];
    const stops = [];
    f.controller.on("streamEnd", (event) => ends.push(event));
    f.controller.on("userStopped", (event) => stops.push(event));
    const watch = f.controller.waitForWake("alice");
    speak(f.connection, "alice").push(null);
    const wake = await watch.result;
    assert.equal(wake.streamEnded, true);
    assert.equal(wake.streamId, ends[0].streamId);
    assert.equal(wake.audioTimeMs, ends[0].audioTimeMs);
    f.controller.stopUser("alice", "left");
    assert.deepEqual(stops[0], { guildId: "guild-a", userId: "alice", reason: "left" });
});

test("a delayed old-stream wake can catch up the owner's already-open next stream", async (context) => {
    const f = setup(context);
    let resolve;
    f.createWake.mock.mockImplementationOnce(() => ({
        accept: async (_samples, final) => final ? new Promise((done) => { resolve = done; }) : [], destroy() {},
    }));
    f.createWake.mock.mockImplementation(() => ({ accept: async () => [], destroy() {} }));
    const watch = f.controller.waitForWake("alice");
    speak(f.connection, "alice").push(null);
    await setImmediate();
    speak(f.connection, "alice", -2000, 10);
    await setImmediate();
    resolve([{ keyword: WAKE_KEYWORD }]);
    const wake = await watch.result;
    const current = f.controller.getAudioSnapshot("alice");
    assert.notEqual(wake.streamId, current.streamId);
    assert.equal(wake.streamEnded, true);
    assert.equal(current.startMs, 0);
    assert.equal(current.audioTimeMs, 200);
    assert.equal(current.isSpeaking, true);
    assert.equal(current.pcm.length, 10 * 3840);
    current.pcm.fill(0);
    assert.ok(f.controller.getAudioSnapshot("alice").pcm.some((sample) => sample !== 0));
    f.controller.stopUser("alice");
    assert.equal(f.controller.getAudioSnapshot("alice"), undefined);
});

test("debug logs explain cooldown rejection, and normal operation omits diagnostic logging", async (context) => {
    const logs = context.mock.method(console, "log", () => {});
    const f = setup(context);
    speak(f.connection, "alice").push(null);
    await setImmediate();
    assert.equal(logs.mock.callCount(), 0);
    const connection = new FakeConnection();
    const controller = new VoiceController(connection, false, f.createVad, f.createWake, true);
    context.after(() => connection.destroy());
    speak(connection, "alice").push(null);
    await setImmediate();
    assert.ok(logs.mock.calls.some(({ arguments: args }) => args[0] === "[wake] rejected" && args[1].reason === "cooldown"));
    assert.ok(logs.mock.calls.some(({ arguments: args }) => args[0] === "[wake] audio-arriving"));
    assert.equal(controller.wakeState, "listening");
});

test("silence creates no keyword stream and a wake test times out without affecting receiving", async (context) => {
    const f = setup(context, false);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const watch = f.controller.waitForWake("alice");
    assert.throws(() => f.controller.waitForWake("alice"), /already have/);
    speak(f.connection, "alice").push(null);
    await setImmediate();
    assert.equal(f.createWake.mock.callCount(), 0);
    const timeout = assert.rejects(watch.result, /within 30 seconds/);
    context.mock.timers.tick(30_000);
    await timeout;
    assert.equal(f.events.length, 0);
    assert.equal(f.controller.isDestroyed, false);
});

for (const departure of ["user", "bot", "connection"]) {
    test(`${departure} departure cancels a delayed wake even after its receive utterance ended`, async (context) => {
        const f = setup(context);
        let resolve;
        f.createWake.mock.mockImplementationOnce(() => ({
            accept: () => new Promise((done) => { resolve = done; }), destroy: mock.fn(),
        }));
        const watch = f.controller.waitForWake("alice");
        speak(f.connection, "alice").push(null);
        await setImmediate();
        assert.equal(f.connection.receiver.subscriptions.size, 0);
        const rejected = assert.rejects(watch.result);
        if (departure === "user") f.controller.stopUser("alice");
        if (departure === "bot") f.manager.handleVoiceStateUpdate({ channelId: "voice-a" }, {
            id: "bot", client: { user: { id: "bot" } }, guild: { id: "guild-a" }, channelId: null,
        });
        if (departure === "connection") f.connection.destroy();
        await rejected;
        resolve([{ keyword: WAKE_KEYWORD }]);
        await setImmediate();
        assert.equal(f.events.length, 0);
    });
}

test("late cancellation from an old wake test cannot cancel a replacement watch", async (context) => {
    const f = setup(context);
    const first = f.controller.waitForWake("alice");
    const rejected = assert.rejects(first.result, /cancelled/);
    first.cancel();
    await rejected;
    const second = f.controller.waitForWake("alice");
    first.cancel();
    speak(f.connection, "alice").push(null);
    assert.equal((await second.result).userId, "alice");
});

test("wake failure reports to the requesting user while audio receiving remains available", async (context) => {
    const f = setup(context);
    f.createWake.mock.mockImplementationOnce(() => { throw new Error("worker stopped"); });
    const watch = f.controller.waitForWake("alice");
    const rejected = assert.rejects(watch.result, /Wake detection failed/);
    speak(f.connection, "alice").push(null);
    await rejected;
    await setImmediate();
    assert.equal(f.connection.receiver.subscriptions.size, 0);
    assert.equal(f.controller.isDestroyed, false);
});

test("!waketest enforces guild/voice state and model availability", async () => {
    const handle = createMessageHandler();
    for (const [request, expected] of [[message("!waketest"), /Use `!join`/], [message("!waketest invalid"), /Usage:/]]) {
        await handle(request); assert.match(content(request), expected);
    }
    const dm = message("!waketest"); dm.guild = null;
    await handle(dm);
    assert.match(content(dm), /inside a server/);
    await handle(message("!join"));
    const wrong = message("!waketest", "guild-a", "elsewhere");
    await handle(wrong);
    assert.match(content(wrong), /Join my voice channel/);
    const disabled = message("!waketest");
    await handle(disabled);
    assert.match(content(disabled), /Wake detection is unavailable/);
    await handle(message("!leave"));
});

for (const wav of [false, true]) {
    test(`!waketest ${wav ? "wav uploads only the owner's preserved audio" : "reports activation without uploading audio"}`, async (context) => {
        const f = setup(context);
        const { provider } = music();
        const handle = createMessageHandler(new MusicService(provider), f.manager);
        await handle(message("!play song"));
        const request = message(wav ? "!waketest wav" : "!waketest");
        const pending = handle(request);
        await setImmediate();
        assert.ok(content(request).includes(WAKE_PHRASE));
        speak(connections[0], "another-user", -2000).push(null);
        await setImmediate();
        assert.equal(request.reply.mock.callCount(), 1, "another user's wake must not complete this test");
        speak(connections[0], "user-a", 1000).push(null);
        await pending;
        assert.ok(content(request, 1).includes(`Detected **${WAKE_PHRASE}** for user user-a in guild guild-a`));
        const response = request.reply.mock.calls[1].arguments[0];
        assert.equal(response.files.length, wav ? 1 : 0);
        if (wav) assert.equal(response.files[0].attachment.subarray(0, 4).toString(), "RIFF");
        assert.equal(players[0].state.status, voice.AudioPlayerStatus.Playing);
        assert.equal(players.length, 1);
        await handle(message("!leave"));
    });
}

for (const outcome of ["miss", "hit", "no-speech", "error"]) {
    test(`!waketest sample uploads the complete requested utterance and a final ${outcome} report`, async (context) => {
        const f = setup(context, outcome !== "no-speech");
        f.createWake.mock.mockImplementation(() => ({
            accept: async (_audio, final) => {
                if (outcome === "error") throw new Error("test inference failure");
                return outcome === "hit" && final ? [{ keyword: WAKE_KEYWORD }] : [];
            }, destroy() {},
        }));
        const { provider } = music();
        const handle = createMessageHandler(new MusicService(provider), f.manager);
        await handle(message("!play song"));
        const request = message("!waketest sample");
        const pending = handle(request);
        await setImmediate();
        assert.match(content(request), /even if no wake is detected/);
        speak(connections[0], "another-user", -2000).push(null);
        await setImmediate();
        assert.equal(request.reply.mock.callCount(), 1);
        const source = speak(connections[0], "user-a", 1000, 10);
        for (let index = 0; index < 7; index++) {
            await setImmediate();
            speak(connections[0], "user-a", 1000, 20);
        }
        source.push(null);
        await pending;
        const response = request.reply.mock.calls[1].arguments[0];
        assert.equal(response.files.length, 2);
        assert.equal(response.files[0].attachment.length, 44 + 150 * 3840, "save whole failed utterance, not only wake pre-roll");
        const report = JSON.parse(response.files[1].attachment.toString());
        assert.equal(report.userId, "user-a");
        assert.equal(report.durationMs, 3000);
        assert.equal(report.truncated, false);
        assert.equal(report.acceptedWakeEvents, outcome === "hit" ? 1 : 0);
        assert.equal(report.summary.outcome, { miss: "no-keyword-returned", hit: "keyword-detected", "no-speech": "vad-gate-never-opened", error: "error" }[outcome]);
        assert.equal(report.resultComplete, outcome !== "error");
        assert.equal(f.manager.get("guild-a").listenerCount("wake"), 1, "remove the diagnostic listener after reporting");
        assert.equal(players[0].state.status, voice.AudioPlayerStatus.Playing);
        await handle(message("!leave"));
    });
}

test("a failed sample prompt cancels the recording and removes its diagnostic listener", async (context) => {
    const f = setup(context);
    const handle = createMessageHandler(undefined, f.manager);
    await handle(message("!join"));
    const request = message("!waketest sample");
    request.reply.mock.mockImplementationOnce(async () => { throw new Error("reply unavailable"); });
    await handle(request);
    const controller = f.manager.get("guild-a");
    assert.equal(controller.listenerCount("wake"), 1);
    const capture = controller.captureNextUtterance("user-a");
    capture.cancel();
    await assert.rejects(capture.result, /cancelled/);
    await handle(message("!leave"));
});

test("a truncated wake sample reports incomplete results without stopping live recognition", async (context) => {
    const f = setup(context);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const handle = createMessageHandler(undefined, f.manager);
    await handle(message("!join"));
    const request = message("!waketest sample");
    const pending = handle(request);
    await setImmediate();
    const source = speak(connections[0], "user-a");
    await setImmediate();
    context.mock.timers.tick(10_000);
    await pending;
    const report = JSON.parse(request.reply.mock.calls[1].arguments[0].files[1].attachment.toString());
    assert.equal(report.truncated, true);
    assert.equal(report.summary, null);
    assert.equal(report.resultComplete, false);
    assert.equal(source.destroyed, false);
    assert.equal(f.backends[0].destroy.mock.callCount(), 0);
    await handle(message("!leave"));
});

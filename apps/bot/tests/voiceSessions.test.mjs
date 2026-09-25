import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { beforeEach, mock, test } from "node:test";
import opus from "@discordjs/opus";
import { FakeConnection, connections, players, voice, resetVoiceMocks } from "./helpers/voice.mjs";
import { message, content, music } from "./helpers/messages.mjs";

const { VoiceReceiveManager } = await import("../src/voice/VoiceReceiveManager.ts");
const { PCM_FORMAT } = await import("../src/voice/receive/SpeakerStream.ts");
const { WAKE_PHRASE, WAKE_KEYWORD } = await import("../src/voice/wake/wakeModel.ts");
const { createMessageHandler } = await import("../src/handleMessage.ts");
const { MusicService } = await import("../src/music/MusicService.ts");
const { VoiceCommandParser } = await import("../src/voice/commands/VoiceCommandParser.ts");
beforeEach(resetVoiceMocks);

function setup(context, options = {}, factories = {}) {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const createVad = factories.vad ?? (() => ({ isSpeech: () => true, destroy() {} }));
    const createWake = factories.wake ?? (() => ({ accept: async () => [], destroy() {} }));
    const manager = new VoiceReceiveManager(false, createVad, createWake, false, options);
    const connection = new FakeConnection();
    const controller = manager.attach(connection);
    const sessions = manager.getSessions("guild-a");
    const captures = [], ends = [], states = [];
    sessions.on("capture", (audio) => captures.push(audio));
    sessions.on("end", (event) => ends.push(event));
    sessions.on("state", (event) => states.push(event.state));
    context.after(() => {
        manager.destroy();
        if (connection.state.status !== voice.VoiceConnectionStatus.Destroyed) connection.destroy();
    });
    return { manager, controller, sessions, connection, captures, ends, states, tick: (ms) => context.mock.timers.tick(ms) };
}

function activation(overrides = {}) {
    return { guildId: "guild-a", userId: "alice", streamId: "a1", streamEnded: false,
        detectedAt: Date.now(), phrase: WAKE_PHRASE, format: PCM_FORMAT, preRoll: Buffer.alloc(3840, 1),
        preRollStartMs: 0, audioTimeMs: 20, processedAudioTimeMs: 20, ...overrides };
}

function pcm(controller, { userId = "alice", streamId = "a1", end = 40, value = 2, ms = 20, isVoice = true } = {}) {
    const frame = { guildId: controller.connection.joinConfig.guildId, userId, streamId,
        pcm: Buffer.alloc(ms * 192, value), format: PCM_FORMAT, audioTimeMs: end, isVoice, isSpeaking: isVoice };
    controller.emit("pcm", frame);
    return frame.pcm;
}

function speechEnd(controller, streamId = "a1", userId = "alice") {
    controller.emit("speech", { guildId: controller.connection.joinConfig.guildId, userId, streamId,
        type: "speech-end", audioTimeMs: 40, durationMs: 40, reason: "silence" });
}

test("owner capture retains pre-roll and contention audio exactly once, excludes other users, and pauses through processing", async (context) => {
    let done, signal;
    const f = setup(context, { processCapture: (_audio, abort) => { signal = abort; return new Promise((resolve) => { done = resolve; }); } });
    const event = activation();
    f.controller.emit("wake", event);
    event.preRoll.fill(9); // The session owns its seed, not a borrowed event buffer.
    pcm(f.controller, { end: 20, value: 8 }); // Already in pre-roll.
    const during = pcm(f.controller);
    during.fill(9);
    pcm(f.controller, { userId: "bob", value: 7 });
    f.controller.emit("wake", activation()); // Same-user repetition is not contention.
    assert.equal(f.sessions.state, "contention");
    assert.equal(f.controller.wakeState, "listening");
    f.tick(300);
    assert.equal(f.sessions.state, "listening");
    assert.equal(f.controller.wakeState, "paused");
    f.controller.emit("wake", activation({ userId: "bob" }));
    pcm(f.controller, { end: 60, value: 3 });
    speechEnd(f.controller);
    assert.equal(f.sessions.state, "processing");
    assert.equal(f.sessions.ownerId, "alice");
    assert.equal(f.controller.wakeState, "paused");
    assert.equal(f.captures.length, 1);
    assert.deepEqual(f.captures[0].pcm, Buffer.concat([Buffer.alloc(3840, 1), Buffer.alloc(3840, 2), Buffer.alloc(3840, 3)]));
    assert.equal(f.captures[0].wake.preRoll, undefined);
    assert.equal(f.captures[0].reason, "speech-end");
    pcm(f.controller, { end: 80 });
    done();
    await setImmediate();
    assert.equal(signal.aborted, true);
    assert.equal(f.sessions.state, "idle");
    assert.equal(f.controller.wakeState, "listening");
    assert.deepEqual(f.states, ["contention", "listening", "processing", "idle"]);
});

test("different users within the entire contention window reject the command and their diagnostic watches", async (context) => {
    const f = setup(context);
    const a = assert.rejects(f.sessions.waitForCapture("alice").result, /one at a time/);
    const b = assert.rejects(f.sessions.waitForCapture("bob").result, /one at a time/);
    f.controller.emit("wake", activation());
    f.tick(299);
    f.controller.emit("wake", activation({ userId: "bob", streamId: "b1" }));
    pcm(f.controller);
    speechEnd(f.controller);
    f.tick(1);
    await Promise.all([a, b]);
    assert.equal(f.captures.length, 0);
    assert.deepEqual(f.ends[0].contenders, ["alice", "bob"]);
    assert.equal(f.sessions.state, "idle");
    assert.equal(f.controller.wakeState, "listening");
    f.controller.emit("wake", activation({ userId: "bob", streamId: "b2" }));
    f.tick(300);
    speechEnd(f.controller, "b2", "bob");
    await setImmediate();
    assert.equal(f.captures[0].userId, "bob");
});

test("speech end during contention waits for arbitration; resumed speech cancels the pending end", async (context) => {
    const f = setup(context);
    f.controller.emit("wake", activation());
    speechEnd(f.controller);
    assert.equal(f.captures.length, 0);
    pcm(f.controller);
    f.tick(300);
    assert.equal(f.captures.length, 0);
    speechEnd(f.controller);
    await setImmediate();
    assert.equal(f.captures.length, 1);
    f.controller.emit("wake", activation({ streamId: "a2" }));
    speechEnd(f.controller, "a2");
    f.tick(300);
    await setImmediate();
    assert.equal(f.captures.length, 2);
});

test("late flush activation catches up a newer stream, deduplicates overlapping snapshots, and ignores stale old-stream end", async (context) => {
    const f = setup(context);
    context.mock.method(f.controller, "getAudioSnapshot", () => ({ guildId: "guild-a", userId: "alice", streamId: "a2",
        pcm: Buffer.alloc(3840 * 2, 4), format: PCM_FORMAT, startMs: 0, audioTimeMs: 40, isSpeaking: true }));
    f.controller.emit("wake", activation({ streamEnded: true }));
    pcm(f.controller, { streamId: "a2", end: 40, value: 8 });
    pcm(f.controller, { streamId: "a2", end: 60, value: 5 });
    f.tick(300);
    speechEnd(f.controller, "a1");
    assert.equal(f.captures.length, 0);
    pcm(f.controller, { streamId: "a1", end: 60, value: 8 });
    speechEnd(f.controller, "a2");
    await setImmediate();
    assert.deepEqual(f.captures[0].streamIds, ["a1", "a2"]);
    assert.deepEqual(f.captures[0].pcm, Buffer.concat([Buffer.alloc(3840, 1), Buffer.alloc(7680, 4), Buffer.alloc(3840, 5)]));
});

test("same-stream catch-up appends only the suffix beyond wake audioTimeMs", async (context) => {
    const f = setup(context);
    context.mock.method(f.controller, "getAudioSnapshot", () => ({ streamId: "a1", audioTimeMs: 60,
        pcm: Buffer.concat([Buffer.alloc(3840, 1), Buffer.alloc(7680, 2)]) }));
    f.controller.emit("wake", activation());
    pcm(f.controller, { end: 60, value: 8 });
    f.tick(1500);
    await setImmediate();
    assert.deepEqual(f.captures[0].pcm, Buffer.concat([Buffer.alloc(3840, 1), Buffer.alloc(7680, 2)]));
});

test("delayed old-stream errors cannot cancel a newer capture or immutable audio already in STT", async (context) => {
    let finish;
    const f = setup(context, { processCapture: () => new Promise((resolve) => { finish = resolve; }) });
    f.controller.emit("wake", activation());
    f.tick(300);
    f.controller.stopUser("alice");
    f.controller.emit("wake", activation({ streamId: "a2" }));
    f.tick(300);
    f.controller.emit("streamEnd", { guildId: "guild-a", userId: "alice", streamId: "a1", reason: "error" });
    f.controller.emit("streamError", { guildId: "guild-a", userId: "alice", streamId: "a1", reason: "vad-failed" });
    assert.equal(f.sessions.state, "listening");
    pcm(f.controller, { streamId: "a2", value: 5 });
    speechEnd(f.controller, "a2");
    f.controller.emit("streamError", { guildId: "guild-a", userId: "alice", streamId: "a2", reason: "receive-failed" });
    assert.equal(f.sessions.state, "processing", "the completed clip no longer depends on receiving");
    finish();
    await setImmediate();
    assert.equal(f.captures.length, 1);
    assert.deepEqual(f.captures[0].streamIds, ["a2"]);
    assert.equal(f.ends.length, 2);
    assert.equal(f.sessions.state, "idle");
});

test("a continuation failing VAD initialization before its first PCM still cancels its owner's capture", async (context) => {
    let fail = false;
    const f = setup(context, {}, { vad: () => {
        if (fail) throw new Error("VAD initialization failed");
        return { isSpeech: () => true, destroy() {} };
    } });
    f.controller.emit("wake", activation({ streamEnded: true }));
    f.tick(300);
    fail = true;
    speak(f.connection, "alice", 1);
    await setImmediate();
    assert.equal(f.sessions.state, "idle");
    assert.equal(f.captures.length, 0);
    assert.match(f.ends[0].reason, /receive or speech processing failed/);
});

test("foreign guild lifecycle and PCM events cannot mutate this guild's owner or diagnostic watches", async (context) => {
    const f = setup(context);
    const watch = f.sessions.waitForCapture("alice");
    f.controller.emit("wake", activation());
    f.tick(300);
    const foreign = { guildId: "guild-b", userId: "alice", streamId: "a1", reason: "error" };
    for (const event of ["streamStart", "streamError", "streamEnd", "userStopped", "reset", "wakeError"]) f.controller.emit(event, foreign);
    f.controller.emit("speech", { ...foreign, type: "speech-end" });
    f.controller.emit("pcm", { ...foreign, pcm: Buffer.alloc(3840, 9), audioTimeMs: 40, isVoice: true });
    assert.equal(f.sessions.ownerId, "alice");
    speechEnd(f.controller);
    const audio = await watch.result;
    assert.deepEqual(audio.pcm, Buffer.alloc(3840, 1));
    await setImmediate();
    assert.equal(f.ends.length, 1);
});

test("flush-only activation and missing packets complete on wall silence, without requiring a new speech-start", async (context) => {
    const f = setup(context);
    f.controller.emit("wake", activation({ streamEnded: true }));
    f.tick(1499);
    assert.equal(f.captures.length, 0);
    f.tick(1);
    await setImmediate();
    assert.equal(f.captures[0].reason, "silence-timeout");
    assert.equal(f.captures[0].pcm.length, 3840);
    assert.equal(f.sessions.state, "idle");
});

test("natural stream end permits an owner continuation, while non-voice packets cannot keep capture open", async (context) => {
    const f = setup(context);
    f.controller.emit("wake", activation());
    f.tick(300);
    f.controller.emit("streamEnd", { guildId: "guild-a", userId: "alice", streamId: "a1", audioTimeMs: 20, reason: "stream-end" });
    f.tick(700);
    pcm(f.controller, { streamId: "a2", end: 20, value: 3 });
    f.tick(1000);
    pcm(f.controller, { streamId: "a2", end: 40, value: 0, isVoice: false });
    pcm(f.controller, { userId: "bob", streamId: "b1" });
    f.tick(499);
    assert.equal(f.captures.length, 0);
    f.tick(1);
    await setImmediate();
    assert.deepEqual(f.captures[0].streamIds, ["a1", "a2"]);
    assert.equal(f.captures[0].durationMs, 60);
});

for (const limit of ["wall", "bytes"]) {
    test(`hard ${limit} bound completes even with continuous speech`, async (context) => {
        const f = setup(context);
        f.controller.emit("wake", activation());
        if (limit === "bytes") {
            pcm(f.controller, { ms: 20_000, end: 20_020 });
            assert.equal(f.captures.length, 0, "even accelerated PCM must wait for arbitration");
            f.tick(300);
        } else {
            for (let i = 1; i <= 9; i++) { f.tick(1000); pcm(f.controller, { end: 20 + i * 20 }); }
            f.tick(1000);
        }
        await setImmediate();
        assert.equal(f.captures[0].reason, "max-duration");
        assert.equal(f.captures[0].truncated, true);
        assert.ok(f.captures[0].pcm.length <= 3840 + 10_000 * 192);
        if (limit === "bytes") assert.equal(f.captures[0].pcm.length, 3840 + 10_000 * 192);
        assert.equal(f.sessions.state, "idle");
    });
}

for (const failure of ["user-left", "bot-move", "deafened", "connection-loss", "destroy", "receive", "vad", "manager-close"]) {
    test(`${failure} cancels capture, clears timers, and releases the owner`, async (context) => {
        const f = setup(context);
        const rejected = assert.rejects(f.sessions.waitForCapture("alice").result);
        f.controller.emit("wake", activation());
        f.tick(300);
        if (failure === "user-left") f.controller.stopUser("alice");
        if (failure === "bot-move" || failure === "deafened") f.manager.handleVoiceStateUpdate({ channelId: "voice-a" }, {
            id: "bot", guild: { id: "guild-a" }, client: { user: { id: "bot" } },
            channelId: failure === "bot-move" ? "voice-b" : "voice-a", deaf: failure === "deafened",
        });
        if (failure === "connection-loss") f.connection.setStatus(voice.VoiceConnectionStatus.Disconnected);
        if (failure === "destroy") f.connection.destroy();
        if (failure === "manager-close") f.manager.destroy();
        if (failure === "receive") f.controller.emit("streamEnd", { guildId: "guild-a", userId: "alice", streamId: "a1", audioTimeMs: 20, reason: "error" });
        if (failure === "vad") f.controller.emit("streamError", { guildId: "guild-a", userId: "alice", streamId: "a1", reason: "vad-failed" });
        await rejected;
        f.tick(60_000);
        await setImmediate();
        assert.equal(f.sessions.state, "idle");
        assert.equal(f.sessions.ownerId, undefined);
        assert.equal(f.captures.length, 0);
        assert.equal(f.ends.length, 1);
        if (f.controller.isDestroyed) for (const event of ["pcm", "speech", "streamStart", "streamEnd", "streamError", "wakeError", "reset", "userStopped"]) {
            assert.equal(f.controller.listenerCount(event), 0, `${event} listener must be removed`);
        }
    });
}

for (const failure of ["throw", "reject", "timeout", "disconnect"]) {
    test(`processing ${failure} resumes listening, and late completion cannot release a newer owner`, async (context) => {
        let resolve, abort;
        const processor = mock.fn((_audio, signal) => {
            abort = signal;
            if (failure === "throw") throw new Error("failure");
            if (failure === "reject") return Promise.reject(new Error("failure"));
            return new Promise((done) => { resolve = done; });
        });
        const f = setup(context, { processCapture: processor });
        f.controller.emit("wake", activation());
        f.tick(300);
        speechEnd(f.controller);
        if (failure === "timeout") f.tick(15_000);
        if (failure === "disconnect") f.controller.stopUser("alice");
        await setImmediate();
        assert.equal(abort.aborted, true);
        assert.equal(f.sessions.state, "idle");
        assert.equal(f.controller.wakeState, "listening");
        assert.equal(f.ends.length, 1);
        f.controller.emit("wake", activation({ userId: "bob", streamId: "b1" }));
        f.tick(300);
        resolve?.();
        await setImmediate();
        assert.equal(f.sessions.ownerId, "bob");
        assert.equal(f.controller.wakeState, "paused");
    });
}

test("guilds and replacement connections have independent sessions and stale cleanup cannot remove a replacement", async (context) => {
    const f = setup(context);
    const other = new FakeConnection();
    other.joinConfig.guildId = "guild-b";
    context.after(() => other.destroy());
    const b = f.manager.attach(other);
    f.controller.emit("wake", activation());
    b.emit("wake", activation({ guildId: "guild-b", userId: "bob", streamId: "b1" }));
    f.tick(300);
    f.controller.stopUser("alice");
    assert.equal(f.manager.getSessions("guild-b").ownerId, "bob");
    const replacement = new FakeConnection();
    context.after(() => replacement.destroy());
    const newer = f.manager.attach(replacement);
    newer.emit("wake", activation({ userId: "charlie", streamId: "c1" }));
    f.connection.destroy();
    assert.equal(f.manager.get("guild-a"), newer);
    assert.equal(f.manager.getSessions("guild-a").ownerId, "charlie");
    assert.equal(f.manager.attach(replacement), newer);
    assert.equal(newer.listenerCount("pcm"), 1);
});

function speak(connection, userId, count = 6, amplitude = 1000) {
    connection.receiver.speaking.emit("start", userId);
    const source = connection.receiver.subscriptions.get(userId);
    const encoder = new opus.OpusEncoder(48_000, 2);
    const audio = Buffer.alloc(3840);
    for (let i = 0; i < audio.length; i += 2) audio.writeInt16LE(amplitude, i);
    for (let i = 0; i < count; i++) source.push(encoder.encode(audio));
    return source;
}

test("real Opus receive and VAD boundaries drive session capture while wake inference pauses and resumes fresh", async (context) => {
    let now = 1000;
    context.mock.method(Date, "now", () => now);
    let voiced = true;
    const backends = [];
    const f = setup(context, {}, {
        vad: () => ({ isSpeech: () => voiced, destroy() {} }),
        wake: () => { const backend = { accept: mock.fn(async () => [{ keyword: WAKE_KEYWORD }]), destroy: mock.fn() }; backends.push(backend); return backend; },
    });
    const frames = [];
    f.controller.on("pcm", (frame) => frames.push(frame));
    const source = speak(f.connection, "alice");
    await setImmediate();
    assert.equal(f.sessions.state, "contention");
    speak(f.connection, "alice", 5);
    await setImmediate();
    f.tick(300);
    assert.equal(backends[0].destroy.mock.callCount(), 1);
    speak(f.connection, "bob", 5, -2000);
    speak(f.connection, "alice", 10);
    await setImmediate();
    voiced = false;
    speak(f.connection, "alice", 30, 0);
    await setImmediate();
    assert.equal(f.captures.length, 1);
    assert.equal(f.captures[0].reason, "speech-end");
    const expected = Buffer.concat(frames.filter((frame) => frame.userId === "alice").map((frame) => frame.pcm));
    // VAD announces speech-end before publishing that frame's trailing silence.
    assert.deepEqual(f.captures[0].pcm, expected.subarray(0, expected.length - 3840));
    assert.equal(f.controller.wakeState, "listening");
    voiced = true;
    now += 3000;
    speak(f.connection, "alice");
    await setImmediate();
    assert.equal(f.sessions.state, "contention", "fresh audio may activate again after the user's cooldown");
    assert.equal(backends[1].accept.mock.calls[0].arguments[0].length, 960, "old command prefix is not replayed");
    source.push(null);
});

test("a real flush-only wake captures an already-started next owner stream before it ends", async (context) => {
    let resolveFlush;
    const wake = mock.fn(() => ({ accept: async () => [], destroy() {} }));
    wake.mock.mockImplementationOnce(() => ({
        accept: async (_samples, final) => final ? new Promise((resolve) => { resolveFlush = resolve; }) : [], destroy() {},
    }));
    const f = setup(context, {}, { wake });
    const frames = [];
    f.controller.on("pcm", (frame) => frames.push(frame));
    speak(f.connection, "alice").push(null);
    await setImmediate();
    assert.equal(f.sessions.state, "idle");
    const continuation = speak(f.connection, "alice", 10, -2000);
    await setImmediate();
    resolveFlush([{ keyword: WAKE_KEYWORD }]);
    await setImmediate();
    assert.equal(f.sessions.state, "contention");
    f.tick(300);
    speak(f.connection, "alice", 5, -2000);
    await setImmediate();
    continuation.push(null);
    await setImmediate();
    assert.equal(f.sessions.state, "listening", "natural end does not cancel the capture");
    f.tick(1500);
    await setImmediate();
    assert.equal(f.captures[0].streamIds.length, 2);
    assert.deepEqual(f.captures[0].pcm, Buffer.concat(frames.map((frame) => frame.pcm)));
});

test("a real VAD failure before a confirmed segment still cancels the owner's session immediately", async (context) => {
    let fail = false;
    const f = setup(context, {}, {
        vad: () => ({ isSpeech: () => { if (fail) throw new Error("VAD stopped"); return true; }, destroy() {} }),
        wake: () => ({ accept: async () => [{ keyword: WAKE_KEYWORD }], destroy() {} }),
    });
    speak(f.connection, "alice", 1);
    await setImmediate();
    f.tick(300);
    assert.equal(f.sessions.state, "listening");
    fail = true;
    speak(f.connection, "alice", 1);
    await setImmediate();
    assert.equal(f.sessions.state, "idle");
    assert.equal(f.captures.length, 0);
    assert.equal(f.ends.length, 1);
    assert.match(f.ends[0].reason, /failed/);
});

for (const wav of [false, true]) {
    test(`!commandtest ${wav ? "wav uploads" : "reports"} only the requesting owner's real session and preserves playback`, async (context) => {
        const f = setup(context, {}, { wake: () => ({ accept: async () => [{ keyword: WAKE_KEYWORD }], destroy() {} }) });
        const { provider } = music();
        const handle = createMessageHandler(new MusicService(provider), f.manager);
        await handle(message("!play song"));
        const request = message(wav ? "!commandtest wav" : "!commandtest");
        const pending = handle(request);
        await setImmediate();
        assert.match(content(request), /Jarvis/);
        speak(connections[0], "user-a").push(null);
        await setImmediate();
        f.tick(1500);
        await pending;
        assert.match(content(request, 1), /Command capture for user user-a/);
        assert.match(content(request, 1), /silence-timeout/);
        const files = request.reply.mock.calls[1].arguments[0].files;
        assert.equal(files.length, wav ? 1 : 0);
        if (wav) assert.equal(files[0].attachment.subarray(0, 4).toString(), "RIFF");
        assert.equal(players[0].state.status, voice.AudioPlayerStatus.Playing);
        assert.equal(players.length, 1);
        await handle(message("!leave"));
    });
}

test("command diagnostics validate context, clear failed prompts, and reject pending watches on disconnect", async (context) => {
    const f = setup(context);
    const handle = createMessageHandler(undefined, f.manager);
    for (const [request, expected] of [[message("!commandtest invalid"), /Usage:/], [message("!commandtest", "missing"), /Use `!join`/],
        [message("!commandtest", "guild-a", "elsewhere"), /Join my voice channel/]]) {
        await handle(request); assert.match(content(request), expected);
    }
    const dm = message("!commandtest"); dm.guild = null;
    await handle(dm); assert.match(content(dm), /inside a server/);
    const failed = message("!commandtest");
    failed.reply.mock.mockImplementationOnce(async () => { throw new Error("no reply"); });
    await handle(failed);
    const next = message("!commandtest");
    const pending = handle(next);
    await setImmediate();
    assert.match(content(next), /Jarvis/);
    f.controller.stopUser("user-a");
    await pending;
    assert.match(content(next, 1), /left/);
    const old = f.sessions.waitForCapture("user-a");
    old.cancel(); await assert.rejects(old.result, /cancelled/);
    const fresh = f.sessions.waitForCapture("user-a");
    old.cancel();
    const expired = assert.rejects(fresh.result, /45 seconds/);
    f.tick(45_000); await expired;
});

test("Phase V5 transcribes only a completed owner's capture and publishes a correlated audio-free result", async (context) => {
    const { SpeechToText } = await import("../src/voice/transcription/SpeechToText.ts");
    const groq = { provider: "groq", model: "whisper-large-v3-turbo", transcribe: mock.fn(async () => ({ text: "Jarvis, Jarvis, play Numb.", segments: [] })) };
    const local = { provider: "faster-whisper", model: "small.en", transcribe: mock.fn() };
    const stt = new SpeechToText(groq, local);
    const f = setup(context, { processCapture: (audio, signal) => stt.transcribe(audio, signal) });
    const transcripts = [];
    f.manager.on("transcript", (result) => transcripts.push(result));
    pcm(f.controller); // Speech without activation is never submitted.
    assert.equal(groq.transcribe.mock.callCount(), 0);
    const watch = f.sessions.waitForTranscript("alice");
    f.controller.emit("wake", activation());
    pcm(f.controller, { userId: "bob", value: 7 });
    f.tick(300);
    assert.equal(groq.transcribe.mock.callCount(), 0);
    speechEnd(f.controller);
    const result = await watch.result;
    assert.equal(result.userId, "alice");
    assert.equal(result.guildId, "guild-a");
    assert.equal(result.sessionId, f.captures[0].sessionId);
    assert.equal(result.text, "play Numb");
    assert.equal(result.pcm, undefined);
    assert.equal(result.rawText, "Jarvis, Jarvis, play Numb.");
    assert.equal(transcripts.length, 1);
    assert.deepEqual(groq.transcribe.mock.calls[0].arguments[0].subarray(44), f.captures[0].pcm);
    assert.equal(local.transcribe.mock.callCount(), 0);
    assert.equal(f.sessions.state, "idle");
});

test("transcript observers reject on cancellation/failure and discard late results", async (context) => {
    let finish;
    const f = setup(context, { processCapture: () => new Promise((resolve) => { finish = resolve; }) });
    const transcripts = [];
    f.manager.on("transcript", (result) => transcripts.push(result));
    const cancelled = assert.rejects(f.sessions.waitForTranscript("alice").result, /left/);
    f.controller.emit("wake", activation());
    f.tick(300);
    speechEnd(f.controller);
    f.controller.stopUser("alice");
    await cancelled;
    finish({ text: "stale transcript" });
    await setImmediate();
    assert.equal(transcripts.length, 0);
    assert.equal(f.sessions.state, "idle");
    const waiting = assert.rejects(f.sessions.waitForTranscript("alice").result, /stopped/);
    f.manager.destroy();
    await waiting;
});

test("!commandtest wav includes normalized STT, fallback metadata, and suppresses mentions", async (context) => {
    const { SpeechToText } = await import("../src/voice/transcription/SpeechToText.ts");
    const { SttError } = await import("../src/voice/transcription/types.ts");
    const stt = new SpeechToText({ provider: "groq", model: "test", transcribe: async () => { throw new SttError("RATE_LIMITED", "limit"); } },
        { provider: "faster-whisper", model: "small.en", transcribe: async () => ({ text: "Jarvis, play @everyone.", segments: [] }) });
    const f = setup(context, { processCapture: (audio, signal) => stt.transcribe(audio, signal) });
    const handle = createMessageHandler(undefined, f.manager);
    const request = message("!commandtest wav");
    const pending = handle(request);
    await setImmediate();
    f.controller.emit("wake", activation({ userId: "user-a" }));
    f.tick(1500);
    await pending;
    assert.match(content(request, 1), /Command capture/);
    assert.match(content(request, 2), /faster-whisper/);
    assert.match(content(request, 2), /RATE_LIMITED/);
    assert.match(content(request, 2), /Transcript: play @everyone/);
    assert.deepEqual(request.reply.mock.calls[2].arguments[0].allowedMentions.parse, []);
    assert.equal(request.reply.mock.calls[1].arguments[0].files.length, 1);
});

const transcriptResult = (text = "move on from this track") => ({ text, rawText: text, status: text ? "transcribed" : "empty",
    provider: "groq", model: "fixture", segments: [], elapsedMs: 1, groqMs: 1, localMs: 0 });

test("an activated capture with no audio terminates explicitly without calling STT", async (context) => {
    const processCapture = mock.fn();
    const f = setup(context, { processCapture });
    const feedback = [];
    f.manager.on("feedback", (event) => feedback.push(event.update));
    f.controller.emit("wake", activation({ preRoll: Buffer.alloc(0), audioTimeMs: 0 }));
    f.tick(1500);
    await setImmediate();
    assert.deepEqual(feedback.at(-1), { state: "failed", reason: "no-command" });
    assert.equal(processCapture.mock.callCount(), 0);
    assert.equal(f.sessions.state, "idle");
    assert.equal(f.controller.wakeState, "listening");
});

test("a throwing feedback observer cannot interrupt capture or strand the owner lock", async (context) => {
    const f = setup(context, { processCapture: async () => transcriptResult("pause") });
    f.manager.on("feedback", () => { throw new Error("broken UI observer"); });
    f.controller.emit("wake", activation());
    f.tick(1500);
    await setImmediate();
    assert.equal(f.captures.length, 1);
    assert.equal(f.ends.length, 1);
    assert.equal(f.sessions.state, "idle");
    assert.equal(f.controller.wakeState, "listening");
});

test("Phase V6 awaits parsing under the owner lock and publishes only correlated command data", async (context) => {
    let finish, parseSignal;
    const parser = new VoiceCommandParser({ model: "fixture", normalize: (_text, signal) => {
        parseSignal = signal; return new Promise((resolve) => { finish = resolve; });
    } });
    const parseTranscript = mock.fn((transcript, signal) => parser.parse(transcript.text, signal, { truncated: transcript.truncated }));
    const f = setup(context, { processCapture: async () => transcriptResult(), parseTranscript });
    const commands = [];
    f.manager.on("command", (command) => commands.push(command));
    const watch = f.sessions.waitForCommand("alice");
    const transcriptWatch = f.sessions.waitForTranscript("alice");
    const bob = f.sessions.waitForCommand("bob");
    pcm(f.controller); // No wake, no parse.
    assert.equal(parseTranscript.mock.callCount(), 0);
    f.controller.emit("wake", activation());
    f.tick(1500);
    const transcript = await transcriptWatch.result;
    assert.equal(transcript.userId, "alice");
    assert.equal(f.sessions.state, "processing");
    assert.equal(f.controller.wakeState, "paused");
    assert.equal(f.sessions.ownerId, "alice");
    assert.equal(parseTranscript.mock.calls[0].arguments[0].pcm, undefined);
    f.controller.emit("wake", activation({ userId: "bob" }));
    finish({ type: "skip", query: null, confidence: 0.98 });
    const command = await watch.result;
    assert.deepEqual(command.command, { type: "skip" });
    assert.equal(command.userId, "alice");
    assert.equal(command.guildId, "guild-a");
    assert.equal(command.sessionId, transcript.sessionId);
    assert.equal(command.pcm, undefined);
    assert.equal(command.text, undefined);
    assert.equal(command.rawText, undefined);
    assert.equal(commands.length, 1);
    assert.equal(parseTranscript.mock.callCount(), 1);
    assert.equal(f.sessions.state, "idle");
    assert.equal(f.controller.wakeState, "listening");
    assert.equal(parseSignal.aborted, false, "completed backend listener is released before session abort");
    bob.cancel();
    await assert.rejects(bob.result, /cancelled/);
});

for (const failure of ["timeout", "disconnect", "reset", "failure", "shutdown"]) {
    test(`parsing ${failure} releases ownership and suppresses late command results`, async (context) => {
        let finish, reject, parseSignal;
        const f = setup(context, { processCapture: async () => transcriptResult(), parseTranscript: (_text, signal) => {
            parseSignal = signal;
            return new Promise((resolve, fail) => { finish = resolve; reject = fail; });
        } });
        const commands = [];
        f.manager.on("command", (command) => commands.push(command));
        const watch = assert.rejects(f.sessions.waitForCommand("alice").result);
        f.controller.emit("wake", activation());
        f.tick(1500);
        await setImmediate();
        assert.equal(f.sessions.state, "processing");
        if (failure === "timeout") f.tick(15_000);
        if (failure === "disconnect") f.controller.stopUser("alice");
        if (failure === "reset") f.controller.reset("connection reset");
        if (failure === "failure") reject(new Error("parser failed"));
        if (failure === "shutdown") f.manager.destroy();
        await watch;
        assert.equal(parseSignal.aborted, true);
        assert.equal(f.sessions.state, "idle");
        if (failure !== "shutdown") {
            f.controller.emit("wake", activation({ userId: "bob", streamId: "b1" }));
            assert.equal(f.sessions.ownerId, "bob");
        }
        finish({ command: { type: "skip" }, source: "groq", reason: "matched", elapsedMs: 1 });
        await setImmediate();
        assert.equal(commands.length, 0);
        if (failure !== "shutdown") assert.equal(f.sessions.ownerId, "bob", "old result cannot unlock Bob");
    });
}

test("rejected contention never parses; empty and truncated transcripts produce unknown without a cloud call", async (context) => {
    const fallback = { model: "fixture", normalize: mock.fn() };
    const parser = new VoiceCommandParser(fallback);
    const parseTranscript = mock.fn((transcript, signal) => parser.parse(transcript.text, signal, { truncated: transcript.truncated }));
    let text = "";
    const f = setup(context, { processCapture: async () => transcriptResult(text), parseTranscript });
    f.controller.emit("wake", activation());
    f.controller.emit("wake", activation({ userId: "bob" }));
    f.tick(300);
    assert.equal(parseTranscript.mock.callCount(), 0);
    const empty = f.sessions.waitForCommand("alice");
    f.controller.emit("wake", activation());
    f.tick(1500);
    assert.equal((await empty.result).reason, "empty");
    text = "play Numb";
    const truncated = f.sessions.waitForCommand("alice");
    f.controller.emit("wake", activation());
    pcm(f.controller, { ms: 20_000, end: 20_020 });
    f.tick(300);
    assert.equal((await truncated.result).reason, "truncated");
    assert.equal(fallback.normalize.mock.callCount(), 0);
});

test("!commandtest reports Phase V6 output while current playback continues", async (context) => {
    const parser = new VoiceCommandParser();
    const f = setup(context, { processCapture: async () => transcriptResult("skip"),
        parseTranscript: (transcript, signal) => parser.parse(transcript.text, signal, { truncated: transcript.truncated }) });
    const { provider } = music();
    const handle = createMessageHandler(new MusicService(provider), f.manager);
    await handle(message("!play song"));
    const request = message("!commandtest");
    const pending = handle(request);
    await setImmediate();
    f.manager.get("guild-a").emit("wake", activation({ userId: "user-a" }));
    f.tick(1500);
    await pending;
    assert.match(content(request, 3), /Parser: local/);
    assert.match(content(request, 3), /Command: \*\*skip\*\*/);
    assert.match(content(request, 3), /no music action was executed/);
    assert.deepEqual(request.reply.mock.calls[3].arguments[0].allowedMentions.parse, []);
    assert.equal(players[0].state.status, voice.AudioPlayerStatus.Playing);
    assert.equal(players.length, 1);
    await handle(message("!leave"));
});

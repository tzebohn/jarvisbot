import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { beforeEach, mock, test } from "node:test";
import opus from "@discordjs/opus";
import { resetVoiceMocks, voice } from "./helpers/voice.mjs";
import { message, music } from "./helpers/messages.mjs";

const { VoiceReceiveManager } = await import("../src/voice/VoiceReceiveManager.ts");
const { GuildMusicPlayers } = await import("../src/music/GuildMusicPlayers.ts");
const { MusicService } = await import("../src/music/MusicService.ts");
const { createMessageHandler } = await import("../src/handleMessage.ts");
const { VoiceMusicCommands } = await import("../src/voice/commands/VoiceMusicCommands.ts");
const { VoiceCommandParser } = await import("../src/voice/commands/VoiceCommandParser.ts");
const { SpeechToText } = await import("../src/voice/transcription/SpeechToText.ts");
const { WAKE_KEYWORD } = await import("../src/voice/wake/wakeModel.ts");
beforeEach(resetVoiceMocks);

const hit = () => [{ keyword: WAKE_KEYWORD }];
const backend = (accept = async () => hit()) => ({ accept: mock.fn(accept), destroy: mock.fn() });
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
};
const response = (text = "Jarvis, Jarvis, pause") => ({ text, segments: [] });

// Real per-user Opus decoding, session/STT/parser/dispatch and music state. Only the
// transport, VAD classifications, keyword results and external providers are controlled.
async function setup(context, sttOptions = {}) {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    const plans = [], backends = [], frames = [], captures = [], commands = [], ends = [], feedback = [];
    const speakers = new Map();
    const createWake = mock.fn(() => {
        const plan = plans.shift();
        if (plan instanceof Error) throw plan;
        const value = plan ?? backend();
        backends.push(value);
        return value;
    });
    const createVad = mock.fn(() => ({ isSpeech: () => true, destroy() {} }));
    const primary = { provider: "groq", model: "fixture", transcribe: mock.fn(async () => response()) };
    const local = { provider: "faster-whisper", model: "fixture", transcribe: mock.fn(async () => response()) };
    const stt = new SpeechToText(primary, local, sttOptions);
    const parser = new VoiceCommandParser();
    const execute = mock.fn((...args) => dispatcher.execute(...args));
    const processCapture = mock.fn((audio, signal) => stt.transcribe(audio, signal));
    const manager = new VoiceReceiveManager(false, createVad, createWake, false, {
        processCapture, parseTranscript: (result, signal) => parser.parse(result.text, signal, { truncated: result.truncated }),
        executeCommand: execute,
    });
    const registry = new GuildMusicPlayers(manager);
    const { provider } = music();
    const service = new MusicService(provider);
    const guilds = new Map();
    const dispatcher = new VoiceMusicCommands({ guilds: { cache: guilds } }, registry, manager, service);
    const handle = createMessageHandler(service, manager, registry);
    manager.on("command", (event) => commands.push(event));
    manager.on("sessionEnd", (event) => ends.push(event));
    manager.on("feedback", (event) => feedback.push(event));
    context.after(() => { manager.destroy(); registry.destroy(); stt.close(); });

    async function text(input, guildId = "guild-a") {
        const request = message(input, guildId);
        if (!guilds.has(guildId)) {
            request.guild.members.fetch.mock.mockImplementation(async (id) => ({
                user: { id, bot: false }, voice: { channel: { id: "voice-a", name: "Music" } },
            }));
            guilds.set(guildId, request.guild);
        }
        request.guild = guilds.get(guildId);
        await handle(request);
    }
    async function join(guildId = "guild-a") {
        await text("!join", guildId);
        const controller = manager.get(guildId), sessions = manager.getSessions(guildId);
        controller.on("pcm", (frame) => frames.push(frame));
        sessions.on("capture", (audio) => captures.push(audio));
        return { guildId, controller, sessions, connection: controller.connection };
    }
    function speaker(guild, userId = "alice", amplitude = 1000) {
        guild.connection.receiver.speaking.emit("start", userId);
        const source = guild.connection.receiver.subscriptions.get(userId);
        assert.ok(source);
        const encoder = new opus.OpusEncoder(48_000, 2), pcm = Buffer.alloc(3840);
        for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(amplitude, i);
        const speaker = { source, push: (count = 1) => {
            for (let i = 0; i < count; i++) source.push(encoder.encode(pcm));
        }, end: () => source.push(null) };
        speakers.set(`${guild.guildId}/${userId}`, speaker);
        return speaker;
    }
    async function speechEnd(guild, userId = "alice") {
        // A wake-only segment no longer ends command capture. Send a real owner
        // command frame after activation before publishing its terminal boundary.
        speakers.get(`${guild.guildId}/${userId}`).push();
        await setImmediate();
        const frame = frames.findLast((frame) => frame.guildId === guild.guildId && frame.userId === userId);
        guild.controller.emit("speech", { guildId: guild.guildId, userId, streamId: frame.streamId,
            type: "speech-end", audioTimeMs: frame.audioTimeMs, durationMs: 20, reason: "silence" });
    }
    return { manager, registry, plans, backends, createWake, createVad, primary, local, processCapture, execute,
        frames, captures, commands, ends, feedback, text, join, speaker, speechEnd,
        a: await join(), tick: (ms) => context.mock.timers.tick(ms) };
}

test("overlapping Opus speakers during playback capture only the activator and execute repeated Jarvis exactly once", async (context) => {
    const f = await setup(context);
    await f.text("!play Current song");
    f.plans.push(backend(), backend(async () => []));
    const alice = f.speaker(f.a), bob = f.speaker(f.a, "bob", -3000);
    for (let i = 0; i < 6; i++) { alice.push(); bob.push(); }
    await setImmediate();
    assert.equal(f.a.sessions.ownerId, "alice");
    f.tick(300);
    alice.push(4); bob.push(8);
    await setImmediate();
    assert.equal(f.registry.get("guild-a").playbackState, "playing", "capture does not mute or pause playback");
    alice.end(); bob.end();
    await setImmediate();
    f.tick(1500);
    await setImmediate();
    assert.equal(f.captures.length, 1);
    const expected = Buffer.concat(f.frames.filter((frame) => frame.userId === "alice").map((frame) => frame.pcm));
    assert.deepEqual(f.captures[0].pcm, expected);
    assert.deepEqual(f.primary.transcribe.mock.calls[0].arguments[0].subarray(44), expected);
    assert.equal(f.primary.transcribe.mock.callCount(), 1);
    assert.equal(f.execute.mock.callCount(), 1);
    assert.deepEqual(f.commands[0].command, { type: "pause" });
    assert.equal(f.registry.get("guild-a").playbackState, "paused");
    assert.equal(f.a.sessions.state, "idle");
});

for (const echo of [false, true]) {
    test(`${echo ? "identical playback-echo proxy audio in two microphones" : "two different simultaneous wake speakers"} rejects contention without STT or music action`, async (context) => {
        const f = await setup(context);
        await f.text("!play Current song");
        const alice = f.speaker(f.a), bob = f.speaker(f.a, "bob", echo ? 1000 : -3000);
        for (let i = 0; i < 6; i++) { alice.push(); bob.push(); }
        await setImmediate();
        const first = f.frames.find((frame) => frame.userId === "alice"), second = f.frames.find((frame) => frame.userId === "bob");
        if (echo) assert.deepEqual(first.pcm, second.pcm, "identical signals retain distinct Discord identities");
        f.tick(300);
        await setImmediate();
        assert.deepEqual(f.ends[0].contenders, ["alice", "bob"]);
        assert.equal(f.primary.transcribe.mock.callCount(), 0);
        assert.equal(f.execute.mock.callCount(), 0);
        assert.equal(f.captures.length, 0);
        assert.equal(f.feedback.filter(({ update }) => update.state === "listening").length, 1);
        assert.equal(f.feedback.at(-1).update.reason, "contention");
        assert.equal(f.registry.get("guild-a").playbackState, "playing");
        // More copies of the wake after rejection cannot open another contention window.
        alice.push(); bob.push();
        await setImmediate();
        assert.equal(f.a.sessions.state, "idle");
        assert.equal(f.ends.length, 1);
        alice.end(); bob.end();
    });
}

test("a delayed competitor and echo audio during STT cannot steal ownership or be replayed on resume", async (context) => {
    const f = await setup(context);
    const delayedWake = deferred(), transcription = deferred();
    f.plans.push(backend(), backend(() => delayedWake.promise));
    f.primary.transcribe.mock.mockImplementationOnce(() => transcription.promise);
    const alice = f.speaker(f.a), bob = f.speaker(f.a, "bob");
    alice.push(); bob.push();
    await setImmediate();
    f.tick(300);
    delayedWake.resolve(hit()); // Simulate a backend ignoring cancellation.
    await f.speechEnd(f.a);
    await setImmediate();
    assert.equal(f.a.sessions.state, "processing");
    assert.equal(f.a.sessions.ownerId, "alice");
    const echo = f.speaker(f.a, "charlie");
    echo.push(10);
    await setImmediate();
    assert.equal(f.createWake.mock.callCount(), 2, "busy guilds do not run more keyword inference");
    assert.equal(f.primary.transcribe.mock.callCount(), 1);
    transcription.resolve(response());
    await setImmediate();
    assert.equal(f.a.sessions.state, "idle");
    assert.equal(f.commands.length, 1);
    echo.push();
    await setImmediate();
    assert.equal(f.a.sessions.ownerId, "charlie");
    assert.equal(f.backends[2].accept.mock.calls[0].arguments[0].length, 960, "paused echo is excluded from new keyword input");
    await f.speechEnd(f.a, "charlie");
    f.tick(300);
    await setImmediate();
    assert.equal(f.captures[1].preRollMs, 20, "new capture does not include the old echo burst");
    assert.equal(f.commands.length, 2);
    alice.end(); bob.end(); echo.end();
});

test("rapid commands retain the three-second user cooldown across completion without blocking another user or guild", async (context) => {
    const f = await setup(context);
    const alice = f.speaker(f.a);
    alice.push();
    await setImmediate();
    await f.speechEnd(f.a);
    f.tick(300);
    await setImmediate();
    assert.equal(f.execute.mock.callCount(), 1);
    alice.push();
    await setImmediate();
    assert.equal(f.a.sessions.state, "idle", "completing a short command must not clear its cooldown");

    const b = await f.join("guild-b"), otherAlice = f.speaker(b), bob = f.speaker(f.a, "bob");
    otherAlice.push(); bob.push();
    await setImmediate();
    assert.equal(b.sessions.ownerId, "alice");
    assert.equal(f.a.sessions.ownerId, "bob");
    await f.speechEnd(b); await f.speechEnd(f.a, "bob");
    f.tick(300);
    await setImmediate();
    assert.equal(f.execute.mock.callCount(), 3);
    alice.end();
    await setImmediate();
    f.tick(2399);
    const retry = f.speaker(f.a);
    retry.push();
    await setImmediate();
    assert.equal(f.a.sessions.state, "idle");
    f.tick(1);
    retry.push();
    await setImmediate();
    assert.equal(f.a.sessions.ownerId, "alice", "ignored repeats do not extend the cooldown");
    await f.speechEnd(f.a);
    f.tick(300);
    await setImmediate();
    assert.equal(f.execute.mock.callCount(), 4);
    assert.equal(new Set(f.commands.map((event) => event.sessionId)).size, 4);
    retry.end(); bob.end(); otherAlice.end();
});

test("one guild's STT timeout aborts only its request and suppresses late text while another guild completes", async (context) => {
    const f = await setup(context, { mode: "local", localTimeoutMs: 500 });
    const late = deferred();
    f.local.transcribe.mock.mockImplementationOnce(() => late.promise);
    const alice = f.speaker(f.a);
    alice.push();
    await setImmediate();
    await f.speechEnd(f.a); f.tick(300);
    await setImmediate();
    const b = await f.join("guild-b"), otherAlice = f.speaker(b);
    otherAlice.push();
    await setImmediate();
    await f.speechEnd(b); f.tick(300);
    await setImmediate();
    assert.equal(b.sessions.state, "idle");
    assert.equal(f.a.sessions.state, "processing");
    assert.deepEqual(f.commands.map((event) => event.guildId), ["guild-b"]);
    f.tick(200);
    await setImmediate();
    assert.equal(f.local.transcribe.mock.calls[0].arguments[1].aborted, true);
    assert.equal(f.feedback.findLast((event) => event.guildId === "guild-a").update.reason, "timeout");
    assert.equal(f.a.sessions.state, "idle");
    alice.end();
    await setImmediate();
    f.tick(2200); // Alice may issue a fresh command at the original activation + 3 s.
    const retry = f.speaker(f.a);
    retry.push();
    await setImmediate();
    assert.equal(f.a.sessions.ownerId, "alice");
    late.resolve(response("Jarvis stop"));
    await setImmediate();
    assert.equal(f.a.sessions.state, "contention", "late STT cannot release the replacement session");
    await f.speechEnd(f.a); f.tick(300);
    await setImmediate();
    assert.deepEqual(f.commands.map((event) => event.command.type), ["pause", "pause"]);
    retry.end(); otherAlice.end();
});

for (const failure of ["startup", "inference", "after-wake"]) {
    test(`wake ${failure} failure releases affected diagnostics/session while a different guild remains usable`, async (context) => {
        const f = await setup(context);
        const b = await f.join("guild-b");
        const bad = backend(async () => { throw new Error("inference failed"); });
        if (failure === "after-wake") bad.accept.mock.mockImplementationOnce(async () => hit());
        f.plans.push(failure === "startup" ? new Error("worker unavailable") : bad);
        const watch = assert.rejects(f.a.sessions.waitForCapture("alice").result, /Wake detection failed/);
        const alice = f.speaker(f.a);
        alice.push();
        await setImmediate();
        if (failure === "after-wake") {
            assert.equal(f.a.sessions.state, "contention");
            alice.push();
            await setImmediate();
        }
        await watch;
        assert.equal(f.a.sessions.state, "idle");
        assert.equal(alice.source.destroyed, false, "keyword failure does not destroy raw receiving");
        const other = f.speaker(b);
        other.push();
        await setImmediate();
        await f.speechEnd(b); f.tick(300);
        await setImmediate();
        assert.deepEqual(f.commands.map((event) => event.guildId), ["guild-b"]);
        alice.end(); other.end();
        await setImmediate();
        f.tick(3000);
        const retry = f.speaker(f.a);
        retry.push();
        await setImmediate();
        await f.speechEnd(f.a); f.tick(300);
        await setImmediate();
        assert.deepEqual(f.commands.map((event) => event.guildId), ["guild-b", "guild-a"]);
        retry.end();
    });
}

for (const stage of ["capture", "transcription", "execution"]) {
    for (const failure of ["owner-left", "connection-loss"]) {
        test(`${failure} during ${stage} cancels its guild and cannot unlock another guild or a replacement session`, async (context) => {
            const f = await setup(context);
            const b = await f.join("guild-b"), late = deferred();
            if (stage === "transcription") f.primary.transcribe.mock.mockImplementationOnce(() => late.promise);
            if (stage === "execution") f.execute.mock.mockImplementationOnce(() => late.promise);
            const alice = f.speaker(f.a), other = f.speaker(b);
            alice.push(); other.push();
            await setImmediate();
            f.tick(300);
            if (stage !== "capture") { await f.speechEnd(f.a); await setImmediate(); }
            assert.equal(f.a.sessions.state, stage === "capture" ? "listening" : "processing");
            if (failure === "owner-left") f.manager.handleVoiceStateUpdate({ channelId: "voice-a" }, {
                id: "alice", guild: { id: "guild-a" }, channelId: null, client: { user: { id: "bot" } },
            });
            else f.a.connection.setStatus(voice.VoiceConnectionStatus.Disconnected);
            await setImmediate();
            assert.equal(f.a.sessions.state, "idle");
            if (stage !== "capture") assert.equal(f.processCapture.mock.calls[0].arguments[1].aborted, true);
            assert.equal(b.sessions.ownerId, "alice");
            assert.equal(b.controller.wakeState, "paused");
            await f.speechEnd(b);
            await setImmediate();
            assert.equal(b.sessions.state, "idle");
            assert.equal(f.commands.at(-1).guildId, "guild-b");
            if (failure === "connection-loss") {
                assert.equal(f.a.controller.wakeState, "unavailable");
                f.a.connection.setStatus(voice.VoiceConnectionStatus.Ready);
            }
            const replacement = f.speaker(f.a, "bob");
            replacement.push();
            await setImmediate();
            f.tick(300);
            late.resolve(response("Jarvis stop"));
            await setImmediate();
            assert.equal(f.a.sessions.ownerId, "bob");
            assert.equal(f.a.controller.wakeState, "paused");
            assert.ok(f.commands.every((event) => event.command.type !== "stop"));
            await f.speechEnd(f.a, "bob");
            await setImmediate();
            assert.equal(f.a.sessions.state, "idle");
            replacement.end(); other.end();
        });
    }
}

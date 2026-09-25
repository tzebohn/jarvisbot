import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { beforeEach, mock, test } from "node:test";
import { voice, connections, players, resetVoiceMocks } from "./helpers/voice.mjs";
import { message, content, music } from "./helpers/messages.mjs";

const { VoiceReceiveManager } = await import("../src/voice/VoiceReceiveManager.ts");
const { GuildMusicPlayers } = await import("../src/music/GuildMusicPlayers.ts");
const { MusicService } = await import("../src/music/MusicService.ts");
const { VoiceMusicCommands } = await import("../src/voice/commands/VoiceMusicCommands.ts");
const { VoiceCommandParser } = await import("../src/voice/commands/VoiceCommandParser.ts");
const { DiscordVoiceCommandFeedback } = await import("../src/voice/feedback/DiscordVoiceCommandFeedback.ts");
const { normalizeTranscript } = await import("../src/voice/transcription/normalizeTranscript.ts");
const { SttError } = await import("../src/voice/transcription/types.ts");
const { ProviderError } = await import("../src/music/providers/ProviderError.ts");
const { createMessageHandler } = await import("../src/handleMessage.ts");
const { PCM_FORMAT } = await import("../src/voice/receive/SpeakerStream.ts");
const { WAKE_PHRASE } = await import("../src/voice/wake/wakeModel.ts");
beforeEach(resetVoiceMocks);

function setup(context) {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { provider, track } = music();
    const candidates = (title, confidence = 1) => [{ track: { ...track, title }, confidence, provider: "youtube" }];
    provider.search.mock.mockImplementation(async (query) => candidates(query));
    const guilds = new Map(), members = new Map(), channels = new Map(), transcripts = new Map();
    const parser = new VoiceCommandParser();
    const execute = mock.fn((...args) => dispatcher.execute(...args));
    const transcribe = mock.fn(async (audio) => {
        const rawText = transcripts.get(`${audio.guildId}/${audio.userId}`) ?? "";
        const text = normalizeTranscript(rawText);
        return { text, rawText, status: text ? "transcribed" : "empty", provider: "groq", model: "fixture",
            segments: [], elapsedMs: 1, groqMs: 1, localMs: 0 };
    });
    const manager = new VoiceReceiveManager(false, () => ({ isSpeech: () => true, destroy() {} }),
        () => ({ accept: async () => [], destroy() {} }), false, {
            processCapture: transcribe, parseTranscript: (transcript, signal) => parser.parse(transcript.text, signal, { truncated: transcript.truncated }),
            executeCommand: execute, processingTimeoutMs: 55_000,
        });
    const registry = new GuildMusicPlayers(manager), service = new MusicService(provider);
    const client = { guilds: { cache: guilds } };
    const feedback = new DiscordVoiceCommandFeedback(client);
    manager.on("feedback", feedback.update);
    const dispatcher = new VoiceMusicCommands(client, registry, manager, service, feedback);
    const handle = createMessageHandler(service, manager, registry);
    const commands = [], ends = [], updates = [];
    manager.on("command", (event) => commands.push(event));
    manager.on("sessionEnd", (event) => ends.push(event));
    manager.on("feedback", (event) => updates.push(event));
    context.after(() => { manager.destroy(); registry.destroy(); });

    function channel(guildId = "guild-a", id = "voice-a") {
        const key = `${guildId}/${id}`;
        if (!channels.has(key)) {
            const messages = [];
            channels.set(key, { id, name: id, messages, isSendable: () => true, send: mock.fn(async (payload) => {
                const message = { ...payload, edit: mock.fn(async (next) => { Object.assign(message, next); return message; }) };
                messages.push(message);
                return message;
            }) });
        }
        return channels.get(key);
    }
    function guild(guildId = "guild-a") {
        if (!guilds.has(guildId)) guilds.set(guildId, { id: guildId, voiceAdapterCreator: () => {},
            members: { fetch: mock.fn(async (id) => {
                const member = members.get(`${guildId}/${id}`);
                if (!member) throw new Error("Unknown member");
                return member;
            }) }, channels: { cache: { get: (id) => channels.get(`${guildId}/${id}`) } } });
        return guilds.get(guildId);
    }
    function member(userId = "alice", guildId = "guild-a", channelId = "voice-a") {
        guild(guildId);
        const value = { user: { id: userId, bot: false }, voice: { channel: channelId ? channel(guildId, channelId) : null } };
        members.set(`${guildId}/${userId}`, value);
        return value;
    }
    async function text(input, guildId = "guild-a", userId = "user-a") {
        if (!members.has(`${guildId}/${userId}`)) member(userId, guildId);
        const request = message(input, guildId);
        request.guild = guild(guildId);
        request.author.id = userId;
        await handle(request);
        return request;
    }
    function activation(userId = "alice", guildId = "guild-a") {
        return { guildId, userId, streamId: `stream-${commands.length}`, streamEnded: false,
            detectedAt: Date.now(), phrase: WAKE_PHRASE, format: PCM_FORMAT, preRoll: Buffer.alloc(3840),
            preRollStartMs: 0, audioTimeMs: 20, processedAudioTimeMs: 20 };
    }
    function start(input, guildId = "guild-a", userId = "alice") {
        transcripts.set(`${guildId}/${userId}`, input);
        assert.equal(manager.getSessions(guildId).state, "idle");
        const ended = new Promise((resolve) => {
            const listener = (event) => {
                if (event.guildId === guildId && event.userId === userId) {
                    manager.off("sessionEnd", listener);
                    resolve(event);
                }
            };
            manager.on("sessionEnd", listener);
        });
        manager.get(guildId).emit("wake", activation(userId, guildId));
        context.mock.timers.tick(1500);
        return ended.then(async (event) => { await setImmediate(); return event; });
    }
    function leaveUser(userId = "alice", guildId = "guild-a") {
        const oldChannel = members.get(`${guildId}/${userId}`).voice.channel;
        members.get(`${guildId}/${userId}`).voice.channel = null;
        manager.handleVoiceStateUpdate({ channelId: oldChannel?.id }, { id: userId, guild: guild(guildId),
            channelId: null, client: { user: { id: "bot" } } });
    }
    member(); member("bob");
    return { provider, track, candidates, manager, registry, dispatcher, execute, transcribe, handle, guild, member, channel,
        text, start, activation, leaveUser, commands, ends, updates, feedback,
        status: (guildId, channelId) => channel(guildId, channelId).messages.at(-1)?.content,
        tick: (ms) => context.mock.timers.tick(ms) };
}

test("Jarvis's playback commands use the same player, queue, controls and resolver as prefix commands", async (context) => {
    const f = setup(context);
    await f.text("!join");
    await f.start("Jarvis, play Alpha by Artist");
    const player = f.registry.get("guild-a");
    assert.equal(player.currentTrack.title, "Alpha by Artist");
    assert.deepEqual(player.current.requestedBy, { guildId: "guild-a", userId: "alice" });
    assert.equal(f.commands[0].voiceChannelId, "voice-a");
    assert.equal(f.commands[0].sessionId, f.ends[0].sessionId);
    assert.equal(f.execute.mock.calls[0].arguments[1].aborted, true, "normal completion releases session ownership");
    assert.equal(player.playbackState, "playing", "completed session must not abort committed playback");
    await f.start("play Beta");
    await f.text("!play Gamma");
    assert.deepEqual(player.queue.map((item) => item.track.title), ["Beta", "Gamma"]);
    assert.deepEqual(player.queue[0].requestedBy, { guildId: "guild-a", userId: "alice" });
    assert.deepEqual(player.queue[1].requestedBy, { guildId: "guild-a", userId: "user-a" });
    await f.start("pause");
    assert.equal(player.playbackState, "paused");
    await f.start("resume");
    assert.equal(player.playbackState, "playing");
    await f.start("show me the queue");
    assert.match(f.status(), /1\. \*\*Beta/);
    await f.text("!loop song");
    await f.start("next track");
    assert.equal(player.currentTrack.title, "Beta");
    assert.equal(player.loopMode, "song");
    await f.start("stop");
    assert.equal(player.current, undefined);
    assert.deepEqual(player.queue, []);
    assert.equal(player.loopMode, "off");
    assert.equal(connections.length, 1);
    assert.equal(players.length, 1);
    assert.equal(connections[0].state.status, voice.VoiceConnectionStatus.Ready);
    assert.equal(f.manager.getSessions("guild-a").state, "idle");
    assert.equal(f.manager.get("guild-a").wakeState, "listening");
    for (const call of f.channel().send.mock.calls) assert.deepEqual(call.arguments[0].allowedMentions.parse, []);
    for (const call of f.execute.mock.calls) assert.equal(call.arguments[0].userId, "alice");
});

test("unknown, unsupported and empty commands never dispatch; command events are observation only", async (context) => {
    const f = setup(context);
    await f.text("!play Current");
    for (const input of ["Jarvis", "", "don't skip", "shuffle", "play", "skip and stop", "ordinary conversation"]) {
        await f.start(input);
    }
    assert.equal(f.execute.mock.callCount(), 0);
    assert.equal(f.provider.search.mock.callCount(), 1);
    assert.equal(f.channel().send.mock.callCount(), 7, "one status per activated session, including rejected commands");
    assert.ok(f.channel().messages.every((message) => /didn't|couldn't|isn't supported/.test(message.content)));
    f.manager.emit("command", { ...f.commands[0], command: { type: "stop" } });
    assert.equal(f.registry.get("guild-a").currentTrack.title, "Current");
});

test("voice and prefix commands automatically play and queue low-confidence matches without suggestions", async (context) => {
    const f = setup(context);
    await f.text("!join");
    f.provider.search.mock.mockImplementation(async () => [
        ...f.candidates("Lower match", 0.4), ...f.candidates("@everyone Possible song", 0.6),
    ]);
    await f.start("play Starboy");
    assert.match(f.status(), /▶️ Playing/);
    const prefix = await f.text("!play Starboy");
    await f.start("play Starboy");
    const reply = f.channel().messages.at(-1);
    assert.match(content(prefix), /^Queued:/);
    assert.match(reply.content, /➕ Queued \*\*@everyone Possible song/);
    assert.doesNotMatch(reply.content, /confiden|suggestion|Lower match|https?:\/\/|Jarvis, play/i);
    assert.deepEqual(f.updates.map(({ update }) => update.state),
        ["listening", "processing", "searching", "playing", "listening", "processing", "searching", "queued"]);
    assert.deepEqual(reply.allowedMentions.parse, []);
    assert.equal(f.provider.getAudio.mock.callCount(), 1);
    assert.equal(f.provider.getAudio.mock.calls[0].arguments[0].title, "@everyone Possible song");
    assert.equal(f.registry.get("guild-a").currentTrack.title, "@everyone Possible song");
    assert.deepEqual(f.registry.get("guild-a").queue.map(({ track }) => track.title),
        ["@everyone Possible song", "@everyone Possible song"]);
    assert.equal(f.manager.getSessions("guild-a").state, "idle");
    assert.equal(f.manager.get("guild-a").wakeState, "listening");
    f.provider.search.mock.mockImplementation(async () => []);
    await f.start("play missing song");
    assert.match(f.status(), /couldn't find a suitable track/);
    assert.equal(f.provider.getAudio.mock.callCount(), 1);
    assert.equal(f.registry.get("guild-a").queue.length, 2);
});

test("voice authorization uses the triggering member for mutations AND queue, including bots and missing members", async (context) => {
    const f = setup(context);
    await f.text("!play Current");
    f.member("alice", "guild-a", "elsewhere");
    for (const input of ["pause", "resume", "skip", "stop", "queue", "leave", "play forbidden"]) await f.start(input);
    assert.equal(f.registry.get("guild-a").currentTrack.title, "Current");
    assert.equal(f.registry.get("guild-a").playbackState, "playing");
    assert.equal(f.provider.search.mock.callCount(), 1);
    for (const message of f.channel().messages) assert.match(message.content, /Join my voice channel/);
    assert.equal(f.guild().members.fetch.mock.calls.at(-1).arguments[0], "alice");
    f.member("alice").user.bot = true;
    for (const input of ["stop", "leave"]) {
        await f.start(input);
        await f.start(input, "guild-a", "missing-user");
    }
    assert.equal(f.registry.get("guild-a").playbackState, "playing");
    assert.match(f.status(), /couldn't complete/);
    f.member("outsider", "guild-a", null);
    assert.match(content(await f.text("!queue", "guild-a", "outsider")), /Current/, "prefix queue keeps its existing read-only policy");
});

test("dispatch rejects malformed data and stale channel/player context without connecting or moving the bot", async (context) => {
    const f = setup(context);
    await f.text("!play Current");
    const event = { guildId: "guild-a", userId: "alice", voiceChannelId: "voice-a", sessionId: "fixture",
        source: "local", reason: "matched", elapsedMs: 0 };
    for (const command of [null, {}, [], { type: "unknown" }, { type: "disconnect" }, { type: "stop", extra: true },
        { type: "leave", query: "other channel" }, { type: "leave", extra: true },
        { type: ["stop"] }, { type: "play", query: "" }, { type: "play", query: "x".repeat(501) }]) {
        await f.dispatcher.execute({ ...event, command }, new AbortController().signal);
    }
    for (const type of ["stop", "leave"]) {
        for (const extra of [{ guildId: "missing-guild" }, { voiceChannelId: "elsewhere" }, { voiceChannelId: null }]) {
            await f.dispatcher.execute({ ...event, ...extra, command: { type } }, new AbortController().signal);
        }
        const abort = new AbortController(); abort.abort();
        await assert.rejects(f.dispatcher.execute({ ...event, command: { type } }, abort.signal), { name: "AbortError" });
    }
    assert.equal(f.registry.get("guild-a").currentTrack.title, "Current");
    assert.equal(f.provider.search.mock.callCount(), 1);
    assert.equal(f.channel().send.mock.callCount(), 0);
    assert.equal(connections.length, 1);
});

test("authorization is rechecked after discovery before committing a track", async (context) => {
    const f = setup(context);
    await f.text("!join");
    let resolve;
    f.provider.search.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = f.start("play stale song");
    await setImmediate();
    // Simulate current Discord member state changing before the gateway cancellation is delivered.
    f.member("alice", "guild-a", "elsewhere");
    resolve(f.candidates("stale song"));
    await pending;
    assert.equal(f.provider.getAudio.mock.callCount(), 0);
    assert.equal(f.registry.get("guild-a").current, undefined);
    assert.match(f.status(), /Join my voice channel/);
});

test("owner departure during member fetch cancels immediately, and a late lookup cannot affect a newer owner", async (context) => {
    const f = setup(context);
    await f.text("!play Current");
    let resolve;
    f.guild().members.fetch.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = f.start("stop");
    await setImmediate();
    f.leaveUser();
    await pending;
    await f.start("pause", "guild-a", "bob");
    resolve({ user: { bot: false }, voice: { channel: f.channel() } });
    await setImmediate();
    assert.equal(f.registry.get("guild-a").playbackState, "paused");
    assert.equal(f.registry.get("guild-a").currentTrack.title, "Current");
    assert.equal(f.channel().send.mock.callCount(), 2);
    assert.match(f.channel().messages[0].content, /cancelled/);
});

for (const cancellation of ["owner-left", "leave", "move", "timeout", "reset", "shutdown"]) {
    test(`${cancellation} during voice discovery suppresses late playback and stale success replies`, async (context) => {
        const f = setup(context);
        await f.text("!join");
        let resolve;
        f.provider.search.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
        const pending = f.start("play old song");
        await setImmediate();
        assert.equal(f.manager.getSessions("guild-a").state, "processing");
        assert.equal(f.manager.get("guild-a").wakeState, "paused");
        if (cancellation === "owner-left") f.leaveUser();
        if (cancellation === "leave") await f.text("!leave");
        if (cancellation === "move") {
            f.member("user-a", "guild-a", "voice-b");
            await f.text("!join");
        }
        if (cancellation === "timeout") {
            f.tick(55_000);
            assert.equal(f.manager.getSessions("guild-a").state, "processing", "execution has a fresh allowance after STT/parsing");
            f.tick(5_000);
        }
        if (cancellation === "reset") f.manager.get("guild-a").reset("voice interrupted");
        if (cancellation === "shutdown") { f.manager.destroy(); f.registry.destroy(); }
        await pending;
        assert.equal(f.execute.mock.calls[0].arguments[1].aborted, true);
        if (cancellation !== "shutdown") {
            if (!f.registry.get("guild-a")) await f.text("!join");
            const channelId = f.registry.get("guild-a").voiceChannelId;
            f.member("bob", "guild-a", channelId);
            await f.start("play replacement", "guild-a", "bob");
        }
        resolve(f.candidates("old song"));
        await setImmediate();
        assert.ok(f.provider.getAudio.mock.calls.every((call) => call.arguments[0].title !== "old song"));
        if (cancellation !== "shutdown") assert.equal(f.registry.get("guild-a").currentTrack.title, "replacement");
        assert.ok(f.channel().messages.every((message) => !message.content.includes("old song")));
        assert.match(f.channel().messages[0].content, cancellation === "timeout" ? /too long/ : /cancelled/);
    });
}

test("prefix stop invalidates a pending voice play search, and subsequent voice requests can play normally", async (context) => {
    const f = setup(context);
    await f.text("!join");
    let resolve;
    f.provider.search.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = f.start("play cancelled");
    await setImmediate();
    await f.text("!stop");
    resolve(f.candidates("cancelled"));
    await pending;
    assert.equal(f.provider.getAudio.mock.callCount(), 0);
    assert.match(f.status(), /cancelled/);
    await f.start("play replacement");
    assert.equal(f.registry.get("guild-a").currentTrack.title, "replacement");
});

test("cancelling a voice resource startup aborts and disposes its late audio while preserving other queued requests", async (context) => {
    const f = setup(context);
    await f.text("!join");
    let resolve, audioSignal;
    f.provider.getAudio.mock.mockImplementationOnce((_track, signal) => {
        audioSignal = signal;
        return new Promise((done) => { resolve = done; });
    });
    const pending = f.start("play slow voice song");
    await setImmediate();
    assert.equal(f.registry.get("guild-a").playbackState, "loading");
    await f.text("!play Another user's song");
    f.leaveUser();
    await pending;
    await setImmediate();
    assert.equal(audioSignal.aborted, true);
    const resource = { playStream: { destroy: mock.fn() } };
    resolve(resource);
    await setImmediate();
    assert.equal(resource.playStream.destroy.mock.callCount(), 1);
    assert.equal(f.registry.get("guild-a").currentTrack.title, "Another user's song");
    assert.equal(players[0].play.mock.callCount(), 1);
    assert.equal(f.channel().send.mock.callCount(), 1);
    assert.match(f.status(), /cancelled/);
});

test("one guild can execute while another guild searches, with separate owners and response destinations", async (context) => {
    const f = setup(context);
    f.member("alice", "guild-b");
    await f.text("!join");
    await f.text("!join", "guild-b");
    let resolve;
    f.provider.search.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pendingA = f.start("play Alpha");
    await setImmediate();
    f.manager.get("guild-a").emit("wake", f.activation("bob"));
    f.manager.get("guild-a").emit("wake", f.activation("alice"));
    assert.equal(f.transcribe.mock.callCount(), 1, "busy/repeated activations cannot start a second execution");
    await f.start("play Beta", "guild-b");
    await f.start("pause", "guild-b");
    assert.equal(f.manager.getSessions("guild-a").state, "processing");
    assert.equal(f.registry.get("guild-b").currentTrack.title, "Beta");
    assert.equal(f.registry.get("guild-b").playbackState, "paused");
    resolve(f.candidates("Alpha"));
    await pendingA;
    assert.equal(f.registry.get("guild-a").currentTrack.title, "Alpha");
    assert.deepEqual(f.registry.get("guild-b").current.requestedBy, { guildId: "guild-b", userId: "alice" });
    assert.equal(f.channel().send.mock.callCount(), 1);
    assert.equal(f.channel("guild-b").send.mock.callCount(), 2);
    assert.equal(connections.length, 2);
    assert.equal(players.length, 2);
});

test("cancelling voice skip during next-track startup disposes late audio and preserves the remaining queue", async (context) => {
    const f = setup(context);
    await f.text("!play First");
    await f.text("!play Slow next");
    await f.text("!play Last");
    let resolve, audioSignal;
    f.provider.getAudio.mock.mockImplementationOnce((_track, signal) => {
        audioSignal = signal;
        return new Promise((done) => { resolve = done; });
    });
    const pending = f.start("skip");
    await setImmediate();
    assert.equal(f.registry.get("guild-a").currentTrack.title, "Slow next");
    f.leaveUser();
    await pending;
    const resource = { playStream: { destroy: mock.fn() } };
    resolve(resource);
    await setImmediate();
    assert.equal(audioSignal.aborted, true);
    assert.equal(resource.playStream.destroy.mock.callCount(), 1);
    assert.equal(f.registry.get("guild-a").currentTrack.title, "Last");
    assert.equal(f.registry.get("guild-a").playbackState, "playing");
    assert.equal(f.channel().send.mock.callCount(), 1);
    assert.match(f.status(), /cancelled/);
});

test("queued voice playback survives normal session completion and reports later extraction failure to its own channel", async (context) => {
    const f = setup(context);
    await f.text("!play Current");
    await f.start("play Broken");
    assert.match(f.status(), /Queued/);
    f.provider.getAudio.mock.mockImplementationOnce(async () => { throw new Error("private extraction failure"); });
    players[0].setStatus(voice.AudioPlayerStatus.Idle);
    await setImmediate();
    assert.match(f.channel().send.mock.calls[1].arguments[0].content, /playback failed.*queue was cleared/);
    assert.doesNotMatch(f.channel().send.mock.calls[1].arguments[0].content, /private extraction failure/);
    assert.equal(f.registry.get("guild-a").current, undefined);
    assert.equal(f.manager.get("guild-a").wakeState, "listening");
});

test("a failed Discord feedback send does not replay the action or roll back committed music", async (context) => {
    const f = setup(context);
    await f.text("!join");
    f.channel().send.mock.mockImplementation(async () => { throw new Error("Missing permissions"); });
    await f.start("play Numb");
    assert.equal(f.provider.getAudio.mock.callCount(), 1);
    assert.equal(f.registry.get("guild-a").playbackState, "playing");
    assert.equal(f.channel().send.mock.callCount(), 1);
    assert.equal(f.manager.getSessions("guild-a").state, "idle");
});

test("!commandtest observes actual execution and accurately explains where music results appear", async (context) => {
    const f = setup(context);
    await f.text("!play Current");
    const request = message("!commandtest");
    request.guild = f.guild();
    const diagnostic = f.handle(request);
    await setImmediate();
    assert.match(content(request), /Supported commands will run/);
    await f.start("pause", "guild-a", "user-a");
    await diagnostic;
    assert.match(content(request, 3), /being handled by the music engine/);
    assert.doesNotMatch(content(request, 3), /no music action was executed/);
    assert.equal(f.registry.get("guild-a").playbackState, "paused");
    assert.match(f.status(), /Paused the current track/);
});

test("accepted wake immediately opens one status, then processing/search/play edit it in order", async (context) => {
    const f = setup(context);
    await f.text("!join");
    let transcribe, search;
    f.transcribe.mock.mockImplementationOnce(() => new Promise((resolve) => { transcribe = resolve; }));
    f.provider.search.mock.mockImplementationOnce(() => new Promise((resolve) => { search = resolve; }));
    // Background PCM, VAD, and ordinary chat do not create feedback.
    f.manager.get("guild-a").emit("pcm", { userId: "alice" });
    f.manager.get("guild-a").emit("speech", { userId: "alice", type: "speech-start" });
    assert.equal(f.channel().send.mock.callCount(), 0);
    const pending = f.start("play Numb by Linkin Park");
    assert.equal(f.channel().send.mock.calls[0].arguments[0].content, "🎙️ Listening...");
    assert.deepEqual(f.updates.slice(0, 2).map(({ update }) => update.state), ["listening", "processing"]);
    await setImmediate();
    assert.match(f.status(), /Processing your command/);
    transcribe({ text: "play Numb by Linkin Park", rawText: "Jarvis play Numb by Linkin Park", status: "transcribed" });
    await setImmediate();
    assert.match(f.status(), /Searching for \*\*Numb by Linkin Park\*\*/);
    search(f.candidates("Numb"));
    await pending;
    assert.match(f.status(), /▶️ Playing \*\*Numb — Linkin Park\*\*/);
    assert.equal(f.channel().send.mock.callCount(), 1);
    assert.deepEqual(f.updates.map(({ update }) => update.state), ["listening", "processing", "searching", "playing"]);
    assert.equal(f.channel().messages[0].edit.mock.callCount(), 3);
});

for (const [input, reason, message] of [["Jarvis", "no-command", /didn't catch a command/],
    ["", "empty-transcript", /couldn't make out any words/], ["shuffle", "unsupported-command", /isn't supported/],
    ["ordinary conversation", "unknown-command", /didn't understand/]]) {
    test(`${reason} gives useful feedback and immediately permits the next command`, async (context) => {
        const f = setup(context);
        await f.text("!join");
        await f.start(input);
        assert.match(f.status(), message);
        assert.deepEqual(f.updates.at(-1).update, { state: "failed", reason });
        assert.equal(f.execute.mock.callCount(), 0);
        assert.equal(f.manager.getSessions("guild-a").state, "idle");
        await f.start("play Next song");
        assert.equal(f.registry.get("guild-a").currentTrack.title, "Next song");
    });
}

for (const failure of ["stt", "search", "playback", "stt-timeout", "parser-timeout"]) {
    test(`${failure} reports a sanitized outcome and restores wake listening`, async (context) => {
        const f = setup(context);
        await f.text("!join");
        let parse;
        if (failure === "stt") f.transcribe.mock.mockImplementationOnce(async () => { throw new SttError("LOCAL_FAILED", "private API failure id=123"); });
        if (failure === "search") f.provider.search.mock.mockImplementationOnce(async () => {
            throw new ProviderError("private API failure id=123", { provider: "youtube", operation: "search", code: "UNAVAILABLE" });
        });
        if (failure === "playback") f.provider.getAudio.mock.mockImplementationOnce(async () => {
            throw new ProviderError("private API failure id=123", { provider: "youtube", operation: "getAudio", code: "NOT_PLAYABLE" });
        });
        if (failure === "stt-timeout") f.transcribe.mock.mockImplementationOnce(() => new Promise(() => {}));
        if (failure === "parser-timeout") {
            parse = context.mock.method(VoiceCommandParser.prototype, "parse", async () => ({ command: { type: "unknown" }, reason: "timeout", source: "groq", elapsedMs: 5000 }));
        }
        const pending = f.start("play Failing song");
        if (failure === "stt-timeout") f.tick(55_000);
        await pending;
        const expected = failure.includes("timeout") ? "timeout" : `${failure}-failed`;
        assert.deepEqual(f.updates.at(-1).update, { state: "failed", reason: expected });
        assert.doesNotMatch(f.status(), /private|API|id=123|ProviderError|LOCAL_FAILED/);
        assert.equal(f.manager.getSessions("guild-a").state, "idle");
        assert.equal(f.manager.get("guild-a").wakeState, "listening");
        parse?.mock.restore();
        await f.start("play Retry");
        assert.match(f.status(), /Playing/);
    });
}

test("simultaneous users share one contention message; rejected audio never reaches STT", async (context) => {
    const f = setup(context);
    await f.text("!join");
    const controller = f.manager.get("guild-a");
    controller.emit("wake", f.activation());
    assert.equal(f.status(), "🎙️ Listening...");
    controller.emit("wake", f.activation()); // Same-user repeats don't create messages.
    controller.emit("wake", f.activation("bob"));
    f.tick(300);
    await setImmediate();
    assert.equal(f.channel().send.mock.callCount(), 1);
    assert.match(f.status(), /one at a time/);
    assert.equal(f.transcribe.mock.callCount(), 0);
    assert.equal(f.manager.getSessions("guild-a").state, "idle");
    assert.equal(controller.wakeState, "listening");
    await f.start("play Retry", "guild-a", "bob");
    assert.match(f.status(), /Playing/);
});

test("low-confidence playback releases ownership even when Discord never finishes sending feedback", async (context) => {
    const f = setup(context);
    await f.text("!join");
    f.channel().send.mock.mockImplementationOnce(() => new Promise(() => {}));
    f.provider.search.mock.mockImplementationOnce(async () => f.candidates("Maybe", 0.6));
    await f.start("play Uncertain");
    assert.equal(f.updates.at(-1).update.state, "playing");
    assert.equal(f.manager.getSessions("guild-a").state, "idle");
    assert.equal(f.manager.get("guild-a").wakeState, "listening");
    assert.equal(f.provider.getAudio.mock.callCount(), 1);
    await f.start("play Next song");
    assert.match(f.status(), /Queued/);
    f.tick(5_000);
    await setImmediate();
    assert.equal(f.channel().send.mock.callCount(), 2, "no retries or stale extra messages");
});

for (const input of ["!leave", "Jarvis, leave", "Jarvis, disconnect", "Jarvis, leave the channel", "Jarvis, disconnect from the channel"]) {
    test(`${input} shares guild removal and releases playback, receive streams, diagnostics and sessions`, async (context) => {
        const f = setup(context);
        await f.text("!play Current");
        await f.text("!play Queued");
        await f.text("!loop queue");
        await f.text("!play Other guild", "guild-b");
        const player = f.registry.get("guild-a"), connection = f.registry.getConnection("guild-a");
        const controller = f.manager.get("guild-a"), sessions = f.manager.getSessions("guild-a");
        const resource = players[0].state.resource, playbackSignal = f.provider.getAudio.mock.calls[0].arguments[1];
        const version = player.requestVersion;
        const capture = controller.captureNextUtterance("observer"), commandWatch = sessions.waitForCommand("observer");
        const remove = context.mock.method(f.registry, "remove");
        const receive = () => connection.receiver.speaking.emit("start", "bob");
        if (input === "!leave") {
            receive();
            assert.match(content(await f.text(input)), /Left the voice channel/);
        } else {
            f.manager.once("command", receive);
            await f.start(input);
            assert.deepEqual(f.commands.at(-1).command, { type: "leave" });
            assert.equal(f.execute.mock.calls.at(-1).arguments[1].aborted, true);
            assert.deepEqual(f.updates.map(({ update }) => update.state), ["listening", "processing", "completed"]);
            assert.match(f.status(), /Left the voice channel/);
        }
        await assert.rejects(capture.result, /left|closed|stopped/);
        await assert.rejects(commandWatch.result, /left|closed|stopped/);
        await setImmediate();
        assert.equal(remove.mock.callCount(), 1);
        assert.deepEqual(remove.mock.calls[0].arguments, ["guild-a", player]);
        assert.equal(connection.destroy.mock.callCount(), 1);
        assert.equal(player.isDestroyed, true);
        assert.equal(player.current, undefined);
        assert.deepEqual(player.queue, []);
        assert.equal(player.loopMode, "off");
        assert.ok(player.requestVersion > version);
        assert.equal(playbackSignal.aborted, true);
        assert.equal(resource.playStream.destroy.mock.callCount(), 1);
        assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 1);
        assert.equal(connection.receiver.subscriptions.size, 0);
        assert.equal(connection.receiver.speaking.listenerCount("start"), 0);
        assert.equal(controller.isDestroyed, true);
        assert.equal(controller.wakeState, "unavailable");
        assert.equal(sessions.state, "idle");
        assert.equal(sessions.ownerId, undefined);
        assert.equal(f.registry.get("guild-a"), undefined);
        assert.equal(f.registry.getConnection("guild-a"), undefined);
        assert.equal(f.manager.get("guild-a"), undefined);
        assert.equal(f.manager.getSessions("guild-a"), undefined);
        assert.equal(f.registry.get("guild-b").currentTrack.title, "Other guild");
        assert.equal(f.manager.get("guild-b").wakeState, "listening");
        f.tick(60_000);
        assert.equal(f.updates.filter(({ update }) => update.state === "failed").length, 0, "no late cancellation or watchdog feedback");
        f.registry.remove("guild-a", player);
        assert.equal(connection.destroy.mock.callCount(), 1, "shared removal is idempotent");
    });
}

test("leave works while idle and safely ignores commands after disconnection", async (context) => {
    const f = setup(context);
    await f.text("!join");
    await f.start("Jarvis, disconnect");
    assert.equal(f.registry.get("guild-a"), undefined);
    assert.equal(f.provider.getAudio.mock.callCount(), 0);
    const report = mock.fn();
    await f.dispatcher.execute(f.commands[0], new AbortController().signal, report);
    assert.deepEqual(report.mock.calls[0].arguments[0], { state: "failed", reason: "cancelled" });
    assert.match(content(await f.text("!leave")), /not currently in a voice channel/);
    assert.equal(connections.length, 1);
    assert.equal(connections[0].destroy.mock.callCount(), 1);
});

test("voice leave aborts pending playback startup and disposes late audio without opening queued tracks", async (context) => {
    const f = setup(context);
    let resolve, audioSignal;
    f.provider.getAudio.mock.mockImplementationOnce((_track, signal) => {
        audioSignal = signal;
        return new Promise((done) => { resolve = done; });
    });
    const pending = f.text("!play Slow");
    await setImmediate();
    const player = f.registry.get("guild-a");
    assert.equal(player.playbackState, "loading");
    await f.text("!play Queued");
    await f.start("disconnect");
    await pending;
    const resource = { playStream: { destroy: mock.fn() } };
    resolve(resource);
    await setImmediate();
    assert.equal(audioSignal.aborted, true);
    assert.equal(resource.playStream.destroy.mock.callCount(), 1);
    assert.equal(f.provider.getAudio.mock.callCount(), 1);
    assert.equal(player.current, undefined);
    assert.deepEqual(player.queue, []);
    assert.equal(f.registry.get("guild-a"), undefined);
    assert.match(f.status(), /Left the voice channel/);
});

for (const stage of ["transcription", "authorization"]) {
    for (const interruption of ["destroyed", "interrupted", "replaced"]) {
        test(`connection ${interruption} during leave ${stage} cancels late work without disconnecting a recovered or replacement connection`, async (context) => {
            const f = setup(context);
            await f.text("!play Current");
            let resolve;
            const member = f.member();
            const target = stage === "transcription" ? f.transcribe : f.guild().members.fetch;
            target.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
            const remove = context.mock.method(f.registry, "remove");
            const pending = f.start("leave");
            await setImmediate();
            assert.equal(typeof resolve, "function");
            const connection = f.registry.getConnection("guild-a");
            if (interruption === "interrupted") {
                connection.setStatus(voice.VoiceConnectionStatus.Disconnected);
                connection.setStatus(voice.VoiceConnectionStatus.Ready);
            } else {
                connection.destroy();
                if (interruption === "replaced") await f.text("!play Replacement");
            }
            await pending;
            resolve(stage === "transcription" ? { text: "leave", rawText: "Jarvis, leave", status: "transcribed" } : member);
            await setImmediate();
            assert.equal(remove.mock.callCount(), 0, "cancelled leave never commits removal");
            assert.equal(f.execute.mock.callCount(), stage === "transcription" ? 0 : 1);
            assert.deepEqual(f.updates.at(-1).update, { state: "failed", reason: "cancelled" });
            if (interruption === "destroyed") {
                assert.equal(f.registry.get("guild-a"), undefined);
                assert.equal(f.manager.getSessions("guild-a"), undefined);
            } else {
                assert.equal(f.registry.get("guild-a").currentTrack.title, interruption === "replaced" ? "Replacement" : "Current");
                assert.equal(f.registry.getConnection("guild-a").state.status, voice.VoiceConnectionStatus.Ready);
                assert.equal(f.manager.get("guild-a").wakeState, "listening");
                assert.equal(f.manager.getSessions("guild-a").state, "idle");
            }
        });
    }
}

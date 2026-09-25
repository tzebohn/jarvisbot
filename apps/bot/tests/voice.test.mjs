import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { beforeEach, mock, test } from "node:test";
import {
    voice, FakeConnection, connections, players, joinVoiceChannel,
    createAudioPlayer, createAudioResource, entersState, resetVoiceMocks,
} from "./helpers/voice.mjs";
import { message, content, music } from "./helpers/messages.mjs";

const { AudioPlayerStatus, VoiceConnectionStatus } = voice;
const { createMessageHandler } = await import("../src/handleMessage.ts");
const { ProviderError } = await import("../src/music/providers/ProviderError.ts");
beforeEach(resetVoiceMocks);

test("repeated !join waits for a reconnecting voice connection without replacing its player", async () => {
    const handle = createMessageHandler();
    const connection = await joinGuild(handle);
    connection.setStatus(VoiceConnectionStatus.Connecting);
    const request = message("!join");
    const pending = handle(request);
    await setImmediate();
    assert.equal(request.reply.mock.callCount(), 0);
    assert.equal(joinVoiceChannel.mock.callCount(), 1);
    connection.setStatus(VoiceConnectionStatus.Ready);
    await pending;
    assert.match(content(request), /Joined/);
    assert.equal(players.length, 1);
    await handle(message("!leave"));
});

test("!play reports invalid URLs, unavailable videos, and failed searches through the real YouTube provider", async () => {
    const { YouTubeClient, YouTubeProvider } = await import("../src/music/providers/index.ts");
    const { MusicService } = await import("../src/music/MusicService.ts");
    const fetchApi = mock.fn(async () => Response.json({ items: [] }));
    const audio = { getAudio: mock.fn() };
    const handle = createMessageHandler(new MusicService(new YouTubeProvider(new YouTubeClient("test-key", fetchApi), audio)));
    for (const url of ["https://youtube.com/watch?v=bad", "https://example.com/video", "https://youtube.com/playlist?list=abc"]) {
        const request = message(`!play ${url}`);
        await handle(request);
        assert.match(content(request), /Use a YouTube video URL/);
    }
    assert.equal(fetchApi.mock.callCount(), 0);
    const unavailable = message("!play https://youtu.be/abcdefghijk");
    await handle(unavailable);
    assert.match(content(unavailable), /couldn't find an available/);
    fetchApi.mock.mockImplementationOnce(async () => { throw new Error("network offline"); });
    const failedSearch = message("!play song");
    await handle(failedSearch);
    assert.match(content(failedSearch), /YouTube/);
    assert.equal(audio.getAudio.mock.callCount(), 0);
    assert.equal(connections.length, 1);
    await handle(message("!leave"));
});

async function joinGuild(handle, guildId = "guild-a") {
    await handle(message("!join", guildId));
    return connections.at(-1);
}

test("only exact ! commands from users are handled; names are case insensitive", async () => {
    const handle = createMessageHandler();
    for (const text of ["hello", "/join", "/play song", "!", "!unknown", "!playful song", " !join"]) {
        const request = message(text);
        await handle(request);
        assert.equal(request.reply.mock.callCount(), 0);
    }
    for (const field of ["bot", "webhook"]) {
        const request = message("!join");
        if (field === "bot") request.author.bot = true;
        else request.webhookId = "webhook-id";
        await handle(request);
        assert.equal(request.reply.mock.callCount(), 0);
    }
    const ping = message("!PiNg");
    ping.guild = null;
    await handle(ping);
    assert.equal(content(ping), "Pong!");
    assert.equal(joinVoiceChannel.mock.callCount(), 0);
});

test("music commands reject DMs before accessing guild state", async () => {
    const handle = createMessageHandler();
    for (const command of ["join", "leave", "playtest", "pluh", "play song", "voicetest"]) {
        const request = message(`!${command}`);
        request.guild = null;
        await handle(request);
        assert.match(content(request), /only be used inside a server/);
    }
    assert.equal(joinVoiceChannel.mock.callCount(), 0);
});

test("!join requires the caller to be in a voice channel", async () => {
    const request = message("!join", "guild-a", null);
    await createMessageHandler()(request);
    assert.equal(joinVoiceChannel.mock.callCount(), 0);
    assert.match(content(request), /need to be in a voice channel/);
});

test("!join uses the guild adapter and waits for Ready before confirming", async () => {
    const connection = new FakeConnection();
    connection.setStatus(VoiceConnectionStatus.Signalling);
    joinVoiceChannel.mock.mockImplementation(() => connection);
    const handle = createMessageHandler();
    const request = message("!join");
    const pending = handle(request);
    await setImmediate();
    assert.equal(request.reply.mock.callCount(), 0);
    assert.deepEqual(joinVoiceChannel.mock.calls[0].arguments[0], {
        channelId: "voice-a", guildId: "guild-a", adapterCreator: request.guild.voiceAdapterCreator,
        selfDeaf: false,
    });
    assert.deepEqual(entersState.mock.calls[0].arguments, [connection, VoiceConnectionStatus.Ready, 10_000]);
    connection.setStatus(VoiceConnectionStatus.Ready);
    await pending;
    assert.match(content(request), /Joined \*\*Music\*\*/);
    await handle(message("!leave"));
});

test("a join timeout destroys the connection and clears the guild entry", async () => {
    const connection = new FakeConnection();
    connection.setStatus(VoiceConnectionStatus.Signalling);
    joinVoiceChannel.mock.mockImplementation(() => connection);
    entersState.mock.mockImplementation((target, status) => voice.entersState(target, status, 1));
    const handle = createMessageHandler();
    const request = message("!join");
    await handle(request);
    assert.equal(connection.destroy.mock.callCount(), 1);
    assert.match(content(request), /couldn't connect/);
    const play = message("!playtest");
    await handle(play);
    assert.match(content(play), /Use `!join` first/);
});

test("a superseded join's late failure cannot destroy the newer connection", async () => {
    let rejectFirst;
    entersState.mock.mockImplementation((target, status, timeout) => {
        if (!rejectFirst) return new Promise((_resolve, reject) => { rejectFirst = reject; });
        return voice.entersState(target, status, timeout);
    });
    const handle = createMessageHandler();
    const first = handle(message("!join"));
    await setImmediate();
    const older = connections[0];
    await handle(message("!join", "guild-a", "voice-b"));
    const newer = connections.at(-1);
    rejectFirst(new Error("old connection timed out"));
    await first;
    assert.equal(older.destroy.mock.callCount(), 1);
    assert.equal(newer.destroy.mock.callCount(), 0);
    await handle(message("!leave"));
    assert.equal(newer.destroy.mock.callCount(), 1);
});

test("!playtest and !leave explain when the bot has not joined", async () => {
    const handle = createMessageHandler();
    const play = message("!playtest");
    const leave = message("!leave");
    await handle(play);
    await handle(leave);
    assert.match(content(play), /Use `!join` first/);
    assert.match(content(leave), /not currently in a voice channel/);
    assert.equal(createAudioPlayer.mock.callCount(), 0);
});

test("!playtest waits for readiness and playback, with !pluh as a restart alias", async () => {
    const handle = createMessageHandler();
    const connection = await joinGuild(handle);
    connection.setStatus(VoiceConnectionStatus.Connecting);
    const player = players[0];
    player.play.mock.mockImplementationOnce(() => player.setStatus(AudioPlayerStatus.Buffering));
    const request = message("!playtest");
    const pending = handle(request);
    await setImmediate();
    assert.equal(player.play.mock.callCount(), 0);
    assert.equal(createAudioResource.mock.callCount(), 0);
    assert.equal(request.reply.mock.callCount(), 0);
    connection.setStatus(VoiceConnectionStatus.Ready);
    await setImmediate();
    assert.equal(request.reply.mock.callCount(), 0);
    assert.equal(entersState.mock.calls.at(-1).arguments[0], player);
    assert.equal(entersState.mock.calls.at(-1).arguments[1], AudioPlayerStatus.Playing);
    assert.ok(entersState.mock.calls.at(-1).arguments[2] instanceof AbortSignal);
    assert.equal(createAudioPlayer.mock.calls[0].arguments[0].behaviors.noSubscriber, voice.NoSubscriberBehavior.Stop);
    assert.deepEqual(createAudioResource.mock.calls[0].arguments, [fileURLToPath(new URL("../assets/test.mp3", import.meta.url))]);
    player.setStatus(AudioPlayerStatus.Playing);
    await pending;
    assert.equal(content(request), "Playing test audio.");
    await handle(message("!pluh"));
    assert.equal(player.play.mock.callCount(), 2);
    assert.equal(players.length, 1);
    assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 1);
    await handle(message("!leave"));
    await handle(message("!leave"));
    assert.equal(player.stop.mock.callCount(), 2);
    assert.equal(connection.destroy.mock.callCount(), 1);
});

test("joining another channel stops old audio before replacing the connection", async () => {
    const handle = createMessageHandler();
    const older = await joinGuild(handle);
    await handle(message("!playtest"));
    await handle(message("!join", "guild-a", "voice-b"));
    assert.equal(older.destroy.mock.callCount(), 1);
    assert.equal(players[0].stop.mock.callCount(), 1);
    assert.equal(older.subscriptions[0].unsubscribe.mock.callCount(), 1);
    assert.equal(connections.at(-1).state.status, VoiceConnectionStatus.Ready);
    await handle(message("!leave"));
});

test("guilds retain independent connections and audio players", async () => {
    const handle = createMessageHandler();
    const first = await joinGuild(handle, "guild-a");
    const second = await joinGuild(handle, "guild-b");
    await handle(message("!playtest", "guild-a"));
    await handle(message("!playtest", "guild-b"));
    await handle(message("!leave", "guild-a"));
    assert.equal(first.state.status, VoiceConnectionStatus.Destroyed);
    assert.equal(second.state.status, VoiceConnectionStatus.Ready);
    assert.equal(players[1].state.status, AudioPlayerStatus.Playing);
    await handle(message("!leave", "guild-b"));
});

test("natural completion releases the subscription but keeps voice connected", async () => {
    const handle = createMessageHandler();
    const connection = await joinGuild(handle);
    await handle(message("!playtest"));
    players[0].setStatus(AudioPlayerStatus.Idle);
    assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 1);
    assert.equal(connection.state.status, VoiceConnectionStatus.Ready);
    await handle(message("!leave"));
    assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 1);
});

for (const failure of ["resource", "buffering", "playing", "destroyed", "connection"]) {
    test(`${failure} failure releases audio and reports diagnostic errors appropriately`, async () => {
        const handle = createMessageHandler();
        const connection = await joinGuild(handle);
        const player = players[0];
        if (failure === "resource") createAudioResource.mock.mockImplementationOnce(() => { throw new Error("FFmpeg not found"); });
        if (failure === "buffering") player.play.mock.mockImplementationOnce(() => {
            player.setStatus(AudioPlayerStatus.Buffering);
            queueMicrotask(() => player.emit("error", new Error("invalid audio")));
        });
        const request = message("!playtest");
        await handle(request);
        if (failure === "playing") player.emit("error", new Error("stream failed"));
        if (failure === "destroyed") connection.destroy();
        if (failure === "connection") connection.emit("error", new Error("transport failed"));
        await setImmediate();
        assert.equal(player.state.status, AudioPlayerStatus.Idle);
        assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 1);
        if (["resource", "buffering"].includes(failure)) {
            assert.equal(request.reply.mock.callCount(), 1);
            assert.match(content(request), /couldn't play the test audio/);
        }
        if (failure === "playing") assert.equal(content(request, 1), "Test audio playback failed.");
        await handle(message("!leave"));
        assert.equal(connection.destroy.mock.callCount(), 1);
    });
}

test("Discord API failures are handled even if the error reply also fails", async () => {
    const request = message("!join");
    request.guild.members.fetch.mock.mockImplementation(async () => { throw new Error("member fetch failed"); });
    request.reply.mock.mockImplementation(async () => { throw new Error("missing permissions"); });
    await assert.doesNotReject(createMessageHandler()(request));
    assert.match(content(request), /couldn't complete that command/);
    assert.equal(joinVoiceChannel.mock.callCount(), 0);
});

test("!play validates its query before joining or searching", async () => {
    const { provider, handle } = music();
    for (const text of ["!play", "!play   ", `!play ${"x".repeat(501)}`]) {
        const request = message(text);
        await handle(request);
        assert.match(content(request), /Usage: `!play/);
    }
    assert.equal(provider.search.mock.callCount(), 0);
    assert.equal(joinVoiceChannel.mock.callCount(), 0);
});

test("!play rejects callers outside voice or in another channel without moving the bot", async () => {
    const { provider, handle } = music();
    const disconnected = message("!play song", "guild-a", null);
    await handle(disconnected);
    assert.match(content(disconnected), /need to be in a voice channel/);
    assert.equal(joinVoiceChannel.mock.callCount(), 0);
    await joinGuild(handle);
    const wrongChannel = message("!play song", "guild-a", "elsewhere");
    await handle(wrongChannel);
    assert.match(content(wrongChannel), /Join my voice channel/);
    assert.equal(provider.search.mock.callCount(), 0);
    assert.equal(joinVoiceChannel.mock.callCount(), 1);
    await handle(message("!leave"));
});

test("!play auto-joins and concurrent requests share one pending connection and player", async () => {
    const { provider, handle } = music();
    const connection = new FakeConnection();
    connection.setStatus(VoiceConnectionStatus.Connecting);
    joinVoiceChannel.mock.mockImplementation(() => connection);
    const first = message("!play first song");
    const second = message("!play second song");
    const join = message("!join");
    const pending = Promise.all([handle(first), handle(second), handle(join)]);
    await setImmediate();
    assert.equal(joinVoiceChannel.mock.callCount(), 1);
    assert.equal(createAudioPlayer.mock.callCount(), 1);
    assert.equal(provider.search.mock.callCount(), 0);
    connection.setStatus(VoiceConnectionStatus.Ready);
    await pending;
    assert.match(content(first), /^Playing:/);
    assert.match(content(second), /^Queued:/);
    assert.match(content(join), /Joined/);
    assert.equal(provider.getAudio.mock.callCount(), 1);
    await handle(message("!join"));
    assert.equal(joinVoiceChannel.mock.callCount(), 1);
    assert.equal(players[0].stop.mock.callCount(), 0);
    await handle(message("!leave"));
});

for (const failure of ["throw", "timeout", "leave"]) {
    test(`!play auto-join ${failure} does not search, leak a connection, or restart later`, async () => {
        const { provider, handle } = music();
        const connection = new FakeConnection();
        connection.setStatus(VoiceConnectionStatus.Connecting);
        joinVoiceChannel.mock.mockImplementation(() => {
            if (failure === "throw") throw new Error("missing voice adapter");
            return connection;
        });
        let ready;
        if (failure === "timeout") entersState.mock.mockImplementation((target, status) => voice.entersState(target, status, 1));
        if (failure === "leave") entersState.mock.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
        const request = message("!play song");
        const pending = handle(request);
        if (failure === "leave") {
            await setImmediate();
            await handle(message("!leave"));
            ready();
        }
        await pending;
        assert.match(content(request), /couldn't connect/);
        assert.equal(provider.search.mock.callCount(), 0);
        if (failure !== "throw") assert.equal(connection.destroy.mock.callCount(), 1);
        const leave = message("!leave");
        await handle(leave);
        assert.match(content(leave), /not currently in a voice channel/);
    });
}

test("!play preserves multi-word arguments, confirms playback, and queues audio lazily", async () => {
    const { provider, handle } = music();
    await joinGuild(handle);
    const first = message("!PLAY   Numb by Linkin Park   ");
    await handle(first);
    assert.deepEqual(provider.search.mock.calls[0].arguments, ["Numb by Linkin Park"]);
    assert.match(content(first), /^Playing:/);
    const second = message("!play https://youtu.be/abcdefghijk");
    await handle(second);
    assert.deepEqual(provider.search.mock.calls[1].arguments, ["https://youtu.be/abcdefghijk"]);
    assert.match(content(second), /^Queued:/);
    assert.equal(provider.getAudio.mock.callCount(), 1);
    players[0].setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(provider.getAudio.mock.callCount(), 2);
    await handle(message("!leave"));
});

test("!play fails on no results, then automatically plays and queues the highest-scoring low-confidence track", async () => {
    const { provider, handle, track } = music();
    await joinGuild(handle);
    provider.search.mock.mockImplementationOnce(async () => []);
    const empty = message("!play song");
    await handle(empty);
    assert.match(content(empty), /couldn't find an available/);
    assert.equal(provider.getAudio.mock.callCount(), 0);
    const lower = { ...track, id: "lmnopqrstuv", title: "Lower match", url: "https://www.youtube.com/watch?v=lmnopqrstuv" };
    const lowest = { ...track, id: "zyxwvutsrqp", title: "Lowest match", url: "https://www.youtube.com/watch?v=zyxwvutsrqp" };
    provider.search.mock.mockImplementation(async () => [
        { track: lower, confidence: 0.2, provider: "youtube" },
        { track, confidence: 0.3, provider: "youtube" },
        { track: lowest, confidence: 0, provider: "youtube" },
    ]);
    const uncertain = message("!play song");
    await handle(uncertain);
    assert.match(content(uncertain), /^Playing:/);
    assert.ok(content(uncertain).includes(track.url));
    assert.equal(provider.getAudio.mock.callCount(), 1);
    assert.equal(provider.getAudio.mock.calls[0].arguments[0], track);
    const queued = message("!play song");
    await handle(queued);
    assert.match(content(queued), /^Queued:/);
    assert.equal(provider.getAudio.mock.callCount(), 1, "queued audio still resolves lazily");
    for (const request of [uncertain, queued]) {
        assert.equal(request.reply.mock.callCount(), 1);
        assert.doesNotMatch(content(request), /confiden|suggestion|choose|\n\d\./i);
        assert.ok(!content(request).includes(lower.url));
        assert.ok(!content(request).includes(lowest.url));
    }
    players[0].setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(provider.getAudio.mock.callCount(), 2);
    assert.equal(provider.getAudio.mock.calls[1].arguments[0], track);
    await handle(message("!leave"));
});

test("!play surfaces classified provider errors and suppresses metadata mentions", async () => {
    const { provider, handle, track } = music();
    await joinGuild(handle);
    provider.search.mock.mockImplementationOnce(async () => {
        throw new ProviderError("YouTube quota reached.", { provider: "youtube", operation: "search", code: "RATE_LIMITED" });
    });
    const failure = message("!play song");
    await handle(failure);
    assert.equal(content(failure), "YouTube quota reached.");
    track.title = "@everyone **song**";
    const request = message("!play song");
    await handle(request);
    assert.deepEqual(request.reply.mock.calls[0].arguments[0].allowedMentions, { parse: [], repliedUser: false });
    assert.ok(content(request).includes("\\*\\*song\\*\\*"));
    await handle(message("!leave"));
});

test("!leave during search prevents late results from starting audio", async () => {
    const { provider, handle } = music();
    await joinGuild(handle);
    const candidates = await provider.search();
    let resolve;
    provider.search.mock.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const request = message("!play song");
    const pending = handle(request);
    await setImmediate();
    await handle(message("!leave"));
    resolve(candidates);
    await pending;
    assert.equal(provider.getAudio.mock.callCount(), 0);
    assert.match(content(request), /could not start or was cancelled/);
});

test("failure starting a queued YouTube track notifies its channel after acceptance", async () => {
    const { provider, handle } = music();
    await joinGuild(handle);
    await handle(message("!play song"));
    const queued = message("!play song");
    await handle(queued);
    provider.getAudio.mock.mockImplementation(async () => { throw new Error("extractor failed"); });
    players[0].setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(queued.channel.send.mock.callCount(), 1);
    assert.match(queued.channel.send.mock.calls[0].arguments[0].content, /queue was cleared/);
    await handle(message("!leave"));
});

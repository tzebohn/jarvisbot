import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { beforeEach, test } from "node:test";
import { voice, connections, players, resetVoiceMocks } from "./helpers/voice.mjs";
import { message, content, music } from "./helpers/messages.mjs";

const { AudioPlayerStatus, VoiceConnectionStatus } = voice;
beforeEach(resetVoiceMocks);

test("the complete prefix flow keeps queues, loop modes, and connections isolated per guild", async () => {
    const { handle, provider, track } = music();
    provider.search.mock.mockImplementation(async (title) => [{
        track: { ...track, title }, confidence: 1, provider: "youtube",
    }]);
    await Promise.all([run(handle, "!play Alpha", "guild-a"), run(handle, "!play Beta", "guild-b")]);
    await run(handle, "!play Alpha next", "guild-a");
    await run(handle, "!play Beta next", "guild-b");
    await run(handle, "!loop queue", "guild-a");
    await run(handle, "!loop song", "guild-b");
    await run(handle, "!pause", "guild-a");
    assert.match(await run(handle, "!nowplaying", "guild-b"), /\(playing\).*Beta/);
    await run(handle, "!resume", "guild-a");
    await run(handle, "!shuffle", "guild-a");
    await run(handle, "!skip", "guild-a");
    assert.match(await run(handle, "!nowplaying", "guild-a"), /Alpha next/);
    assert.match(await run(handle, "!queue", "guild-b"), /Beta next/);
    await run(handle, "!stop", "guild-a");
    assert.match(await run(handle, "!loop", "guild-b"), /\*\*song\*\*/);
    await run(handle, "!leave", "guild-a");
    assert.equal(connections[0].state.status, VoiceConnectionStatus.Destroyed);
    assert.equal(connections[1].state.status, VoiceConnectionStatus.Ready);
    players[1].setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.match(await run(handle, "!nowplaying", "guild-b"), /Beta/);
    assert.equal(connections.length, 2);
    assert.equal(players.length, 2);
    await run(handle, "!leave", "guild-b");
});

test("every control rejects DMs and slash invocations; mutations require the caller's voice channel", async () => {
    const { handle } = music();
    const controls = ["pause", "resume", "skip", "stop", "queue", "nowplaying", "shuffle", "loop"];
    await run(handle, "!play song");
    for (const command of controls) {
        const dm = message(`!${command}`);
        dm.guild = null;
        await handle(dm);
        assert.match(content(dm), /inside a server/);
        const slash = message(`/${command}`);
        await handle(slash);
        assert.equal(slash.reply.mock.callCount(), 0);
        if (!["queue", "nowplaying"].includes(command)) {
            assert.match(await run(handle, `!${command}`, "guild-a", "elsewhere"), /Join my voice channel/);
        }
    }
    assert.equal(players[0].state.status, AudioPlayerStatus.Playing);
    assert.equal(players.length, 1);
    await run(handle, "!leave");
});

test("!loop validates modes, repeats fresh audio, bypasses repeat on skip, and resets on stop", async () => {
    const { handle, provider, track } = music();
    assert.match(await run(handle, "!loop"), /Nothing is playing/);
    await run(handle, "!join");
    assert.match(await run(handle, "!loop"), /Loop mode: \*\*off\*\*/);
    assert.match(await run(handle, "!loop song"), /Nothing is currently playing/);
    assert.match(await run(handle, "!loop off"), /set to \*\*off\*\*/);
    provider.search.mock.mockImplementation(async (title) => [{
        track: { ...track, title }, confidence: 1, provider: "youtube",
    }]);
    await run(handle, "!play First");
    await run(handle, "!play Second");
    assert.match(await run(handle, "!loop song", "guild-a", "elsewhere"), /Join my voice channel/);
    assert.match(await run(handle, "!loop SONG"), /set to \*\*song\*\*/);
    assert.match(await run(handle, "!loop nonsense"), /Usage:/);
    assert.match(await run(handle, "!loop"), /Loop mode: \*\*song\*\*/);
    players[0].setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.deepEqual(provider.getAudio.mock.calls.map((call) => call.arguments[0].title), ["First", "First"]);
    assert.match(await run(handle, "!queue"), /1\. \*\*Second/);
    await run(handle, "!skip");
    assert.equal(provider.getAudio.mock.calls.at(-1).arguments[0].title, "Second");
    await run(handle, "!loop queue");
    await run(handle, "!play Third");
    players[0].setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(provider.getAudio.mock.calls.at(-1).arguments[0].title, "Third");
    assert.match(await run(handle, "!queue"), /1\. \*\*Second/);
    await run(handle, "!loop off");
    players[0].setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(provider.getAudio.mock.calls.at(-1).arguments[0].title, "Second");
    await run(handle, "!loop song");
    await run(handle, "!stop");
    assert.match(await run(handle, "!loop"), /Loop mode: \*\*off\*\*/);
    assert.match(await run(handle, "!queue"), /queue is empty/);
    await run(handle, "!leave");
});

test("!shuffle only reorders pending tracks, preserving the current resource and every queue item", async (context) => {
    const { handle, provider, track } = music();
    context.mock.method(Math, "random", () => 0);
    assert.match(await run(handle, "!shuffle"), /Nothing is playing/);
    await run(handle, "!join");
    assert.match(await run(handle, "!shuffle"), /queue is empty/);
    provider.search.mock.mockImplementation(async (title) => [{
        track: { ...track, title }, confidence: 1, provider: "youtube",
    }]);
    await run(handle, "!play Current");
    await run(handle, "!play First");
    assert.match(await run(handle, "!shuffle"), /only one queued track/);
    await run(handle, "!play Second");
    await run(handle, "!play Third");
    await run(handle, "!pause");
    assert.match(await run(handle, "!shuffle", "guild-a", null), /Join my voice channel/);
    assert.match(await run(handle, "!shuffle"), /Shuffled 3 queued tracks/);
    const queue = await run(handle, "!queue");
    assert.match(queue, /Current \(paused\): \*\*Current/);
    assert.match(queue, /1\. \*\*Second/);
    assert.match(queue, /2\. \*\*Third/);
    assert.match(queue, /3\. \*\*First/);
    assert.equal(provider.getAudio.mock.callCount(), 1);
    await run(handle, "!skip");
    assert.equal(provider.getAudio.mock.calls[1].arguments[0].title, "Second");
    assert.equal(players.length, 1);
    await run(handle, "!leave");
});

test("!nowplaying shows metadata and state, including loading, paused, and local audio", async () => {
    const { handle, provider, track } = music();
    assert.equal(await run(handle, "!nowplaying"), "Nothing is currently playing.");
    let resolve;
    provider.getAudio.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = run(handle, "!play song");
    await setImmediate();
    assert.match(await run(handle, "!nowplaying"), /Now playing \(loading\).*Numb/);
    resolve({ playStream: { destroy() {} } });
    await pending;
    const playing = await run(handle, "!nowplaying", "guild-a", null);
    assert.match(playing, /Now playing \(playing\).*Numb.*Linkin Park/);
    assert.match(playing, /Duration: 3:07/);
    assert.ok(playing.includes(track.url));
    await run(handle, "!pause");
    assert.match(await run(handle, "!nowplaying"), /\(paused\)/);
    await run(handle, "!playtest");
    assert.match(await run(handle, "!nowplaying"), /Local test audio/);
    await run(handle, "!stop");
    assert.equal(await run(handle, "!nowplaying"), "Nothing is currently playing.");
    await run(handle, "!leave");
});

test("!queue includes current and pending tracks, paginates safely, and is readable outside voice", async () => {
    const { handle, provider, track } = music();
    assert.match(await run(handle, "!queue"), /Nothing is currently playing\.[\s\S]*The queue is empty/);
    let count = 0;
    provider.search.mock.mockImplementation(async () => [{
        track: { ...track, title: `Song ${++count}` }, confidence: 1, provider: "youtube",
    }]);
    for (let i = 0; i < 8; i++) await run(handle, "!play song");
    await run(handle, "!pause");
    const first = await run(handle, "!queue", "guild-a", null);
    assert.match(first, /Current \(paused\).*Song 1.*3:07/);
    assert.match(first, /7 tracks, page 1\/2/);
    assert.match(first, /1\. \*\*Song 2/);
    assert.match(first, /5\. \*\*Song 6/);
    assert.doesNotMatch(first, /Song 7/);
    const second = await run(handle, "!queue 2");
    assert.match(second, /6\. \*\*Song 7/);
    assert.match(second, /7\. \*\*Song 8/);
    for (const page of ["0", "-1", "3", "1.5", "abc", "1 2"]) {
        assert.match(await run(handle, `!queue ${page}`), /Usage:/);
    }
    assert.equal(provider.getAudio.mock.callCount(), 1);
    await run(handle, "!stop");
    assert.match(await run(handle, "!queue"), /queue is empty/);
    track.title = "*".repeat(200);
    track.artist = "_".repeat(200);
    provider.search.mock.mockImplementation(async () => [{ track, confidence: 1, provider: "youtube" }]);
    for (let i = 0; i < 6; i++) await run(handle, "!play song");
    const request = message("!queue");
    await handle(request);
    assert.ok(content(request).length <= 2000);
    assert.ok(content(request).includes("\\*"));
    assert.deepEqual(request.reply.mock.calls[0].arguments[0].allowedMentions, { parse: [], repliedUser: false });
    await run(handle, "!leave");
});

test("!stop clears queued audio, stays connected, and is safe to repeat", async () => {
    const { handle, provider } = music();
    assert.match(await run(handle, "!stop"), /Nothing is playing/);
    await run(handle, "!play first");
    await run(handle, "!play second");
    assert.match(await run(handle, "!stop", "guild-a", "elsewhere"), /Join my voice channel/);
    assert.match(await run(handle, "!stop"), /Stopped playback and cleared the queue/);
    await run(handle, "!stop");
    players[0].setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(provider.getAudio.mock.callCount(), 1);
    assert.equal(connections[0].state.status, VoiceConnectionStatus.Ready);
    await run(handle, "!play new song");
    assert.equal(players.length, 1);
    assert.equal(provider.getAudio.mock.callCount(), 2);
    await run(handle, "!leave");
});

for (const phase of ["join", "search", "extraction"]) {
    test(`!stop during ${phase} cancels late playback without affecting a new request`, async () => {
        const { handle, provider } = music();
        const candidates = await provider.search();
        let resolve;
        if (phase === "join") {
            // Explicit join creates the connection; the play request then waits on its readiness.
            const { joinVoiceChannel, FakeConnection } = await import("./helpers/voice.mjs");
            joinVoiceChannel.mock.mockImplementationOnce(() => {
                const connection = new FakeConnection();
                connections.push(connection);
                connection.setStatus(VoiceConnectionStatus.Connecting);
                return connection;
            });
        } else {
            provider[phase === "search" ? "search" : "getAudio"].mock.mockImplementationOnce(
                () => new Promise((done) => { resolve = done; }));
        }
        const pending = run(handle, "!play old song");
        await setImmediate();
        await run(handle, "!stop");
        if (phase === "join") connections[0].setStatus(VoiceConnectionStatus.Ready);
        let disposed = false;
        if (phase === "search") resolve(candidates);
        if (phase === "extraction") resolve({ playStream: { destroy() { disposed = true; } } });
        assert.match(await pending, /could not start or was cancelled/);
        await setImmediate();
        if (phase === "extraction") assert.equal(disposed, true);
        assert.equal(players[0].play.mock.callCount(), 0);
        assert.match(await run(handle, "!play replacement"), /^Playing:/);
        assert.equal(players[0].play.mock.callCount(), 1);
        await run(handle, "!leave");
    });
}

test("!skip advances paused playback once and handles the last track and empty player", async () => {
    const { handle, provider } = music();
    assert.match(await run(handle, "!skip"), /Nothing is playing/);
    await run(handle, "!join");
    assert.match(await run(handle, "!skip"), /Nothing is currently playing/);
    await run(handle, "!play first");
    await run(handle, "!play second");
    await run(handle, "!pause");
    assert.match(await run(handle, "!skip", "guild-a", null), /Join my voice channel/);
    assert.match(await run(handle, "!skip"), /Playing the next queued track/);
    assert.equal(players[0].state.status, AudioPlayerStatus.Playing);
    assert.equal(provider.getAudio.mock.callCount(), 2);
    assert.equal(connections.length, 1);
    assert.match(await run(handle, "!skip"), /queue is now empty/);
    assert.equal(players[0].state.status, AudioPlayerStatus.Idle);
    assert.equal(connections[0].state.status, VoiceConnectionStatus.Ready);
    await run(handle, "!leave");
});

test("!skip reports a failed queued track without leaving audio running", async () => {
    const { handle, provider } = music();
    await run(handle, "!play first");
    await run(handle, "!play broken");
    await run(handle, "!play last");
    provider.getAudio.mock.mockImplementationOnce(async () => { throw new Error("unavailable video"); });
    assert.match(await run(handle, "!skip"), /next track could not start/);
    assert.equal(players[0].state.status, AudioPlayerStatus.Idle);
    assert.match(await run(handle, "!skip"), /Nothing is currently playing/);
    assert.equal(provider.getAudio.mock.callCount(), 2);
    await run(handle, "!leave");
});

test("!resume resumes the same resource without losing queued tracks", async () => {
    const { handle, provider } = music();
    assert.match(await run(handle, "!resume"), /Nothing is playing/);
    await run(handle, "!join");
    assert.match(await run(handle, "!resume"), /Nothing is currently playing/);
    await run(handle, "!play song");
    await run(handle, "!play next");
    assert.match(await run(handle, "!resume"), /not paused/);
    await run(handle, "!pause");
    assert.match(await run(handle, "!resume", "guild-a", "elsewhere"), /Join my voice channel/);
    assert.equal(players[0].state.status, AudioPlayerStatus.Paused);
    assert.match(await run(handle, "!resume"), /^Resumed/);
    assert.equal(players[0].state.status, AudioPlayerStatus.Playing);
    assert.equal(provider.getAudio.mock.callCount(), 1);
    players[0].setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(provider.getAudio.mock.callCount(), 2);
    await run(handle, "!leave");
});

async function run(handle, text, guildId = "guild-a", channelId = "voice-a") {
    const request = message(text, guildId, channelId);
    await handle(request);
    return content(request);
}

test("!pause handles disconnected, idle, playing, paused, and loading states", async () => {
    const { handle, provider } = music();
    assert.match(await run(handle, "!pause"), /Nothing is playing/);
    await run(handle, "!join");
    assert.match(await run(handle, "!pause"), /Nothing is currently playing/);
    await run(handle, "!play song");
    await run(handle, "!play next song");
    assert.match(await run(handle, "!pause"), /^Paused/);
    assert.equal(players[0].state.status, AudioPlayerStatus.Paused);
    assert.match(await run(handle, "!pause"), /already paused/);
    assert.equal(provider.getAudio.mock.callCount(), 1);
    await run(handle, "!leave");

    let resolve;
    provider.getAudio.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = run(handle, "!play loading");
    await setImmediate();
    assert.match(await run(handle, "!pause"), /still loading/);
    resolve({ playStream: { destroy() {} } });
    assert.match(await pending, /^Playing:/);
    await run(handle, "!leave");
});

test("!pause enforces guild and voice state without creating players", async () => {
    const { handle } = music();
    const dm = message("!pause");
    dm.guild = null;
    await handle(dm);
    assert.match(content(dm), /inside a server/);
    await run(handle, "!play song");
    for (const channel of [null, "elsewhere"]) {
        assert.match(await run(handle, "!pause", "guild-a", channel), /Join my voice channel/);
    }
    assert.equal(players[0].state.status, AudioPlayerStatus.Playing);
    connections[0].setStatus(VoiceConnectionStatus.Connecting);
    assert.match(await run(handle, "!pause"), /voice connection is not ready/);
    assert.equal(players.length, 1);
    await run(handle, "!leave");
});

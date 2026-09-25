import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { beforeEach, mock, test } from "node:test";
import { voice, FakeConnection, players, entersState, resetVoiceMocks } from "./helpers/voice.mjs";

const { AudioPlayerStatus, VoiceConnectionStatus, AudioPlayerError } = voice;
const { MusicPlayer } = await import("../src/music/MusicPlayer.ts");
const { ProviderError } = await import("../src/music/providers/ProviderError.ts");

beforeEach(resetVoiceMocks);

test("loop queue rotates all tracks and loops a lone track without reusing streams", async (context) => {
    const { player, audio } = setup(context);
    const first = item("first");
    const second = item("second");
    const third = item("third");
    await player.play(first);
    await player.play(second);
    await player.play(third);
    player.setLoopMode("queue");
    for (const expected of [second, third, first, second]) {
        audio.setStatus(AudioPlayerStatus.Idle);
        await setImmediate();
        assert.equal(player.current, expected);
        assert.equal(player.queue.length, 2);
    }
    assert.equal(first.createResource.mock.callCount(), 2);
    assert.notEqual(first.createResource.mock.calls[0].result, first.createResource.mock.calls[1].result);
    assert.equal(first.createResource.mock.calls[0].result.playStream.destroy.mock.callCount(), 1);
    player.stop();
    assert.equal(player.loopMode, "off");
    await player.play(first);
    player.setLoopMode("queue");
    audio.setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(player.current, first);
    assert.deepEqual(player.queue, []);
    await player.skip();
    assert.equal(player.current, undefined);
});

test("loop song preserves pending items and errors stop looping rather than retrying forever", async (context) => {
    const { player, audio } = setup(context);
    const first = item("first");
    const second = item("second");
    await player.play(first);
    await player.play(second);
    player.setLoopMode("song");
    audio.setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(player.current, first);
    assert.deepEqual(player.queue, [second]);
    first.createResource.mock.mockImplementationOnce(() => { throw new Error("video became unavailable"); });
    audio.setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(player.current, undefined);
    assert.equal(player.loopMode, "off");
    assert.deepEqual(player.queue, []);
    assert.equal(first.onError.mock.callCount(), 1);
    assert.equal(second.createResource.mock.callCount(), 0);
    player.destroy();
    assert.equal(player.setLoopMode("song"), false);
});

function item(id) {
    return {
        track: { id, title: id, artist: "Artist", source: "youtube", url: `https://example.com/${id}` },
        createResource: mock.fn(() => ({ playStream: { destroy: mock.fn() } })),
        onError: mock.fn(),
    };
}

function setup(context) {
    const connection = new FakeConnection();
    const player = new MusicPlayer(connection);
    context.after(() => player.destroy());
    return { player, connection, audio: players.at(-1) };
}

test("the player waits for Ready, separates current from pending, and starts one resource", async (context) => {
    const { player, connection, audio } = setup(context);
    connection.setStatus(VoiceConnectionStatus.Connecting);
    const first = item("first");
    const pending = player.play(first);
    await setImmediate();
    assert.equal(first.createResource.mock.callCount(), 0);
    assert.equal(connection.subscribe.mock.callCount(), 0);
    assert.equal(player.currentTrack, first.track);
    assert.deepEqual(player.queue, []);
    connection.setStatus(VoiceConnectionStatus.Ready);
    assert.equal(await pending, "playing");
    assert.equal(audio.play.mock.callCount(), 1);
    assert.equal(first.createResource.mock.callCount(), 1);
});

test("queued tracks advance in FIFO order on Idle, constructing audio only when needed", async (context) => {
    const { player, connection, audio } = setup(context);
    const first = item("first");
    const second = item("second");
    const third = item("third");
    await player.play(first);
    assert.equal(await player.play(second), "queued");
    assert.equal(await player.play(third), "queued");
    assert.deepEqual(player.queue, [second, third]);
    player.queue.pop();
    assert.deepEqual(player.queue, [second, third]);
    assert.equal(second.createResource.mock.callCount(), 0);
    audio.setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(player.currentTrack, second.track);
    assert.deepEqual(player.queue, [third]);
    assert.equal(third.createResource.mock.callCount(), 0);
    audio.setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(player.currentTrack, third.track);
    audio.setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(player.current, undefined);
    assert.deepEqual(player.queue, []);
    assert.equal(connection.state.status, VoiceConnectionStatus.Ready);
    assert.equal(players.length, 1);
    for (const subscription of connection.subscriptions) {
        assert.equal(subscription.unsubscribe.mock.callCount(), 1);
    }
});

test("pause and resume preserve the current track and queued work", async (context) => {
    const { player, audio } = setup(context);
    const first = item("first");
    const second = item("second");
    assert.equal(player.pause(), false);
    assert.equal(player.resume(), false);
    await player.play(first);
    assert.equal(player.pause(), true);
    assert.equal(await player.play(second), "queued");
    assert.equal(audio.state.status, AudioPlayerStatus.Paused);
    assert.equal(player.currentTrack, first.track);
    assert.equal(second.createResource.mock.callCount(), 0);
    assert.equal(player.resume(), true);
    assert.equal(audio.state.status, AudioPlayerStatus.Playing);
    assert.deepEqual(player.queue, [second]);
});

test("skip advances exactly once even from paused playback, and ends cleanly on the last track", async (context) => {
    const { player } = setup(context);
    const first = item("first");
    const second = item("second");
    const third = item("third");
    assert.equal(await player.skip(), false);
    await player.play(first);
    await player.play(second);
    await player.play(third);
    player.pause();
    assert.equal(await player.skip(), true);
    assert.equal(player.currentTrack, second.track);
    assert.deepEqual(player.queue, [third]);
    assert.equal(first.createResource.mock.calls[0].result.playStream.destroy.mock.callCount(), 1);
    await player.skip();
    assert.equal(player.currentTrack, third.track);
    await player.skip();
    assert.equal(player.current, undefined);
    assert.equal(await player.skip(), false);
});

test("stop clears pending items without opening them or disconnecting voice", async (context) => {
    const { player, connection, audio } = setup(context);
    const first = item("first");
    const second = item("second");
    await player.play(first);
    await player.play(second);
    player.stop();
    audio.setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(player.current, undefined);
    assert.deepEqual(player.queue, []);
    assert.equal(second.createResource.mock.callCount(), 0);
    assert.equal(connection.state.status, VoiceConnectionStatus.Ready);
    assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 1);
    assert.equal(await player.play(item("new")), "playing");
});

test("stop aborts pending readiness and a cancelled start cannot clear a replacement queue", async (context) => {
    const { player, connection } = setup(context);
    connection.setStatus(VoiceConnectionStatus.Connecting);
    const first = item("first");
    const oldStart = assert.rejects(player.play(first));
    await setImmediate();
    player.stop();
    const replacement = item("replacement");
    const last = item("last");
    const newStart = player.play(replacement);
    await player.play(last);
    await oldStart;
    assert.equal(player.current, replacement);
    assert.deepEqual(player.queue, [last]);
    assert.equal(first.createResource.mock.callCount(), 0);
    assert.equal(first.onError.mock.callCount(), 0);
    connection.setStatus(VoiceConnectionStatus.Ready);
    assert.equal(await newStart, "playing");
});

test("skip cancels a buffering start without losing the rest of the queue", async (context) => {
    const { player, audio } = setup(context);
    const normalPlay = audio.play;
    audio.play.mock.mockImplementationOnce((resource) => audio.setStatus(AudioPlayerStatus.Buffering, resource));
    const first = item("first");
    const second = item("second");
    const third = item("third");
    const pending = assert.rejects(player.play(first));
    await setImmediate();
    await player.play(second);
    await player.play(third);
    await player.skip();
    await pending;
    assert.equal(audio.play, normalPlay);
    assert.equal(player.current, second);
    assert.deepEqual(player.queue, [third]);
    assert.equal(first.onError.mock.callCount(), 0);
});

test("destroy cancels buffering, releases resources, and prevents further playback", async (context) => {
    const { player, connection, audio } = setup(context);
    audio.play.mock.mockImplementation((resource) => audio.setStatus(AudioPlayerStatus.Buffering, resource));
    const first = item("first");
    const pending = assert.rejects(player.play(first));
    await setImmediate();
    await player.play(item("queued"));
    player.destroy();
    player.destroy();
    await pending;
    assert.equal(player.isDestroyed, true);
    assert.equal(player.current, undefined);
    assert.deepEqual(player.queue, []);
    assert.equal(connection.destroy.mock.callCount(), 1);
    assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 1);
    assert.equal(first.createResource.mock.calls[0].result.playStream.destroy.mock.callCount(), 1);
    const later = item("later");
    await assert.rejects(player.play(later), /destroyed/);
    assert.equal(later.createResource.mock.callCount(), 0);
    assert.equal(player.pause(), false);
    assert.equal(player.resume(), false);
});

test("resource creation failure rejects the start, reports once, and releases the subscription", async (context) => {
    const { player, connection } = setup(context);
    const broken = item("broken");
    broken.createResource.mock.mockImplementation(() => { throw new Error("cannot decode"); });
    await assert.rejects(player.play(broken), /cannot decode/);
    assert.equal(broken.onError.mock.callCount(), 1);
    assert.equal(player.current, undefined);
    assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 1);
    assert.equal(await player.play(item("good")), "playing");
});

test("errors on an automatically started queued track are reported and stop the queue", async (context) => {
    const { player, audio } = setup(context);
    const broken = item("broken");
    const last = item("last");
    broken.createResource.mock.mockImplementation(() => { throw new Error("cannot decode queued audio"); });
    await player.play(item("first"));
    await player.play(broken);
    await player.play(last);
    audio.setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(broken.onError.mock.callCount(), 1);
    assert.match(broken.onError.mock.calls[0].arguments[0].message, /queued audio/);
    assert.equal(player.current, undefined);
    assert.deepEqual(player.queue, []);
    assert.equal(last.createResource.mock.callCount(), 0);
});

test("stream errors release the current resource and do not auto-start another track", async (context) => {
    const { player, audio, connection } = setup(context);
    const first = item("first");
    const second = item("second");
    await player.play(first);
    await player.play(second);
    audio.emit("error", new AudioPlayerError(new Error("stream failed"), audio.state.resource));
    await setImmediate();
    assert.equal(first.onError.mock.callCount(), 1);
    assert.equal(player.current, undefined);
    assert.deepEqual(player.queue, []);
    assert.equal(second.createResource.mock.callCount(), 0);
    assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 1);
});

test("player failures recover the stream's original cause discarded by AudioPlayerError", async (context) => {
    const { player, audio } = setup(context);
    const first = item("youtube");
    await player.play(first);
    await player.play(item("queued"));
    const original = new ProviderError("YouTube download failed.", {
        provider: "youtube", operation: "getAudio", code: "NOT_PLAYABLE",
        cause: new Error("458752 bytes read, 1211397 more expected"),
    });
    audio.state.resource.playStream.errored = original;
    const wrapped = new AudioPlayerError(original, audio.state.resource);
    assert.equal(wrapped.cause, undefined);
    audio.emit("error", wrapped);
    assert.equal(first.onError.mock.callCount(), 1);
    assert.equal(first.onError.mock.calls[0].arguments[0], original);
    assert.ok(console.error.mock.calls.some(({ arguments: args }) => args[1]?.includes("1211397 more expected")));
    assert.equal(player.current, undefined);
    assert.deepEqual(player.queue, []);
});

test("a late error belonging to a stopped resource cannot stop newer playback", async (context) => {
    const { player, audio } = setup(context);
    const first = item("first");
    const second = item("second");
    await player.play(first);
    const oldResource = audio.state.resource;
    player.stop();
    await player.play(second);
    audio.emit("error", new AudioPlayerError(new Error("late old error"), oldResource));
    assert.equal(player.current, second);
    assert.equal(audio.state.status, AudioPlayerStatus.Playing);
    assert.equal(second.onError.mock.callCount(), 0);
});

test("externally destroyed connections dispose their player and queue", async (context) => {
    const { player, connection } = setup(context);
    await player.play(item("first"));
    const second = item("second");
    await player.play(second);
    connection.destroy();
    assert.equal(player.isDestroyed, true);
    assert.equal(player.current, undefined);
    assert.deepEqual(player.queue, []);
    assert.equal(second.createResource.mock.callCount(), 0);
    assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 1);
});

test("connection failure while waiting for Ready cancels startup and disposes the player", async (context) => {
    const { player, connection } = setup(context);
    connection.setStatus(VoiceConnectionStatus.Connecting);
    const first = item("first");
    const pending = assert.rejects(player.play(first), /transport failed/);
    await setImmediate();
    connection.emit("error", new Error("transport failed"));
    await pending;
    assert.equal(player.isDestroyed, true);
    assert.equal(first.createResource.mock.callCount(), 0);
    assert.equal(first.onError.mock.callCount(), 1);
});

test("readiness timeout reports failure without creating an audio resource", async (context) => {
    const { player, connection } = setup(context);
    connection.setStatus(VoiceConnectionStatus.Connecting);
    entersState.mock.mockImplementation((target, status) => voice.entersState(target, status, 1));
    const first = item("first");
    await assert.rejects(player.play(first));
    assert.equal(first.createResource.mock.callCount(), 0);
    assert.equal(first.onError.mock.callCount(), 1);
    assert.equal(player.current, undefined);
});

test("ending during buffering rejects promptly instead of reporting playback success", async (context) => {
    const { player, audio } = setup(context);
    audio.play.mock.mockImplementation((resource) => {
        audio.setStatus(AudioPlayerStatus.Buffering, resource);
        queueMicrotask(() => audio.setStatus(AudioPlayerStatus.Idle));
    });
    const first = item("first");
    await assert.rejects(player.play(first), /ended before playback started/);
    assert.equal(first.onError.mock.callCount(), 1);
    assert.equal(player.current, undefined);
});

test("resource-only local playback does not require fabricated Track metadata", async (context) => {
    const { player } = setup(context);
    const local = { createResource: mock.fn(() => ({ playStream: { destroy: mock.fn() } })) };
    assert.equal(await player.play(local), "playing");
    assert.equal(player.current, local);
    assert.equal(player.currentTrack, undefined);
});

test("async resource factories remain lazy and enter playback only after resolving", async (context) => {
    const { player, audio } = setup(context);
    let resolve;
    const first = item("async");
    first.createResource.mock.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = player.play(first);
    await setImmediate();
    assert.equal(audio.play.mock.callCount(), 0);
    const second = item("queued");
    assert.equal(await player.play(second), "queued");
    assert.equal(second.createResource.mock.callCount(), 0);
    resolve({ playStream: { destroy: mock.fn() } });
    assert.equal(await pending, "playing");
    audio.setStatus(AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(player.current, second);
});

for (const operation of ["stop", "skip", "destroy"]) {
    test(`${operation} cancels extraction promptly and destroys late resources without affecting replacement playback`, async (context) => {
        const { player, audio } = setup(context);
        let resolve;
        const first = item("async");
        first.createResource.mock.mockImplementation(() => new Promise((done) => { resolve = done; }));
        const pending = assert.rejects(player.play(first), /stopped or replaced/);
        await setImmediate();
        const signal = first.createResource.mock.calls[0].arguments[0];
        await player[operation]();
        await pending;
        assert.equal(signal.aborted, true);
        const replacement = item("replacement");
        if (operation !== "destroy") {
            await player.play(replacement);
        }
        const late = { playStream: { destroy: mock.fn() } };
        resolve(late);
        await setImmediate();
        assert.equal(late.playStream.destroy.mock.callCount(), 1);
        assert.equal(first.onError.mock.callCount(), 0);
        assert.equal(audio.play.mock.callCount(), operation === "destroy" ? 0 : 1);
        if (operation !== "destroy") {
            assert.equal(player.current, replacement);
        }
    });
}

test("late async rejection after cancellation cannot clear a new queue", async (context) => {
    const { player } = setup(context);
    let reject;
    const first = item("async");
    first.createResource.mock.mockImplementation(() => new Promise((_done, fail) => { reject = fail; }));
    const pending = assert.rejects(player.play(first));
    await setImmediate();
    player.stop();
    await pending;
    const replacement = item("replacement");
    const queued = item("queued");
    await player.play(replacement);
    await player.play(queued);
    reject(new Error("late network failure"));
    await setImmediate();
    assert.equal(player.current, replacement);
    assert.deepEqual(player.queue, [queued]);
    assert.equal(first.onError.mock.callCount(), 0);
});

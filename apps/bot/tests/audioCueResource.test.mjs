import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { beforeEach, mock, test } from "node:test";
import opus from "@discordjs/opus";
import { FakeConnection, resetVoiceMocks, voice, players, createAudioPlayer } from "./helpers/voice.mjs";

const { AudioCueResource } = await import("../src/music/AudioCueResource.ts");
const { MusicPlayer } = await import("../src/music/MusicPlayer.ts");
const { loadWakeAcknowledgement } = await import("../src/voice/feedback/wakeAcknowledgementAudio.ts");
const cuePcm = await loadWakeAcknowledgement();
beforeEach(resetVoiceMocks);

function source(frames = 200) {
    const stream = new Readable({ objectMode: true, read() {} });
    const encoder = new opus.OpusEncoder(48_000, 2);
    const pcm = Buffer.alloc(3840);
    for (let i = 0; i < 960; i++) for (let channel = 0; channel < 2; channel++) {
        pcm.writeInt16LE(Math.round(2000 * Math.sin(i * Math.PI / 48)), i * 4 + channel * 2);
    }
    for (let i = 0; i < frames; i++) stream.push(encoder.encode(pcm));
    const resource = new voice.AudioResource([], [stream], null, 5);
    resource.started = true;
    return resource;
}

function request() {
    const abort = new AbortController();
    return { abort, signal: abort.signal, canPlay: mock.fn(() => true), onStart: mock.fn() };
}

function setup(context) {
    const connection = new FakeConnection();
    const player = new MusicPlayer(connection, true);
    context.after(() => player.destroy());
    return { connection, player, audio: players.at(-1) };
}

function track(id) {
    return { track: { id, title: id, artist: "fixture", source: "youtube", url: `https://example.com/${id}` },
        createResource: mock.fn(() => source()), onError: mock.fn() };
}

function finishCue(output) {
    let frames = 0;
    while (output.hasCue && frames++ < 300) output.read();
    assert.equal(output.hasCue, false, "cue must be finite");
}

test("the supplied WAV is loaded as 48 kHz stereo PCM and encodes into a finite acknowledgement", () => {
    assert.equal(cuePcm.length / 192_000, 0.9172083333333333);
    const output = new AudioCueResource();
    const cue = request(), finished = mock.fn();
    assert.equal(output.startCue(cuePcm, cue, finished), true);
    const decoder = new opus.OpusEncoder(48_000, 2);
    const decoded = [];
    while (output.readable) {
        const packet = output.read();
        if (packet) decoded.push(Buffer.from(decoder.decode(packet)));
    }
    assert.equal(decoded.length, 46);
    assert.ok(Buffer.concat(decoded).some((byte) => byte !== 0));
    assert.equal(cue.onStart.mock.callCount(), 1);
    assert.deepEqual(cue.onStart.mock.calls[0].arguments, [920]);
    assert.equal(finished.mock.callCount(), 1);
    output.playStream.destroy();
});

for (const mode of ["abort", "ineligible"]) {
    test(`${mode} at the output boundary suppresses even the first prepared cue frame`, () => {
        const output = new AudioCueResource();
        const cue = request(), finished = mock.fn();
        output.startCue(cuePcm, cue, finished);
        if (mode === "abort") cue.abort.abort();
        else cue.canPlay.mock.mockImplementation(() => false);
        assert.equal(output.read(), null);
        assert.equal(cue.onStart.mock.callCount(), 0);
        assert.equal(finished.mock.callCount(), 1);
        output.playStream.destroy();
    });
}

test("cue mixing retains song/queue/loop/subscription and speech cancellation leaves music flowing", async (context) => {
    const { player, audio, connection } = setup(context);
    const first = track("first"), next = track("next");
    await player.play(first);
    await player.play(next);
    player.setLoopMode("queue");
    const output = audio.state.resource;
    const original = first.createResource.mock.calls[0].result;
    output.read();
    const position = original.playbackDuration;
    const cue = request();
    player.playCue(cuePcm, cue);
    assert.equal(audio.state.resource, output);
    assert.equal(audio.play.mock.callCount(), 1, "a cue never calls play over a song");
    assert.equal(connection.subscribe.mock.callCount(), 1);
    assert.ok(output.read().length > 0);
    assert.equal(original.playbackDuration, position + 20);
    cue.abort.abort();
    assert.equal(output.hasCue, false);
    assert.ok(output.read().length > 0);
    assert.equal(original.playStream.destroyed, false);
    assert.equal(original.playbackDuration, position + 40);
    assert.equal(player.current, first);
    assert.deepEqual(player.queue, [next]);
    assert.equal(player.loopMode, "queue");
    assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 0);
});

test("a paused song stays stationary throughout acknowledgement and resumes from its exact resource", async (context) => {
    const { player, audio } = setup(context);
    const first = track("paused");
    await player.play(first);
    const output = audio.state.resource;
    const original = first.createResource.mock.calls[0].result;
    output.read();
    player.pause();
    const position = original.playbackDuration;
    player.playCue(cuePcm, request());
    assert.equal(player.playbackState, "paused");
    assert.equal(audio.state.status, voice.AudioPlayerStatus.Playing, "transport alone sends the cue");
    finishCue(output);
    assert.equal(original.playbackDuration, position);
    assert.equal(audio.state.status, voice.AudioPlayerStatus.Paused);
    assert.equal(player.playbackState, "paused");
    assert.equal(player.resume(), true);
    output.read();
    assert.equal(original.playbackDuration, position + 20);
    assert.equal(player.current, first);
});

test("pause and resume during a cue affect the song without cutting or restarting the cue", async (context) => {
    const { player, audio } = setup(context);
    const first = track("first");
    await player.play(first);
    const original = first.createResource.mock.calls[0].result, output = audio.state.resource;
    const cue = request();
    player.playCue(cuePcm, cue);
    output.read();
    assert.equal(player.pause(), true);
    const position = original.playbackDuration;
    output.read();
    assert.equal(original.playbackDuration, position);
    assert.equal(player.resume(), true);
    output.read();
    assert.equal(original.playbackDuration, position + 20);
    assert.equal(cue.onStart.mock.callCount(), 1);
    player.pause();
    cue.abort.abort();
    assert.equal(audio.state.status, voice.AudioPlayerStatus.Paused);
});

test("idle acknowledgement releases only its own resource/subscription and creates no queue item", (context) => {
    const { player, audio, connection } = setup(context);
    player.playCue(cuePcm, request());
    const output = audio.state.resource;
    assert.equal(player.current, undefined);
    assert.equal(player.playbackState, "idle");
    finishCue(output);
    assert.equal(output.playStream.destroyed, true);
    assert.equal(audio.state.status, voice.AudioPlayerStatus.Idle);
    assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 1);
    assert.deepEqual(player.queue, []);
});

for (const completeFirst of [false, true]) {
    test(`a loading song safely takes over standalone cue output (cue finished first: ${completeFirst})`, async (context) => {
        const { player, audio, connection } = setup(context);
        let resolve;
        const first = track("loading"), next = track("next");
        first.createResource.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
        const pending = player.play(first);
        await setImmediate();
        await player.play(next);
        player.playCue(cuePcm, request());
        const cueOutput = audio.state.resource;
        cueOutput.read();
        if (completeFirst) finishCue(cueOutput);
        const original = source();
        resolve(original);
        assert.equal(await pending, "playing");
        assert.equal(player.current, first);
        assert.deepEqual(player.queue, [next]);
        assert.equal(first.onError.mock.callCount(), 0);
        assert.equal(original.playStream.destroyed, false);
        assert.equal(cueOutput.playStream.destroyed, true);
        assert.equal(connection.subscriptions[0].unsubscribe.mock.callCount(), 0);
    });
}

test("skipping a song with an active cue advances exactly once and disposes the old resource", async (context) => {
    const { player, audio } = setup(context);
    const first = track("first"), next = track("next");
    await player.play(first);
    await player.play(next);
    player.setLoopMode("song");
    player.playCue(cuePcm, request());
    const oldOutput = audio.state.resource;
    oldOutput.read();
    await player.skip();
    assert.equal(oldOutput.hasCue, false);
    assert.equal(first.createResource.mock.calls[0].result.playStream.destroyed, true);
    assert.equal(player.current, next);
    assert.deepEqual(player.queue, []);
    assert.equal(next.createResource.mock.callCount(), 1);
});

test("standalone cue errors cannot fail a loading song or clear its queue", async (context) => {
    const { player, audio } = setup(context);
    let resolve;
    const first = track("loading"), next = track("next");
    first.createResource.mock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = player.play(first);
    await setImmediate();
    await player.play(next);
    player.playCue(cuePcm, request());
    audio.emit("error", new voice.AudioPlayerError(new Error("fixture cue failure"), audio.state.resource));
    resolve(source());
    await pending;
    assert.equal(first.onError.mock.callCount(), 0);
    assert.equal(player.current, first);
    assert.deepEqual(player.queue, [next]);
});

test("source end takes priority over a cue so queue progression is never delayed by acknowledgement", async (context) => {
    const { player, audio } = setup(context);
    const first = track("first"), next = track("next");
    const original = source(1);
    original.playStream.push(null);
    first.createResource.mock.mockImplementationOnce(() => original);
    await player.play(first);
    await player.play(next);
    const output = audio.state.resource;
    player.playCue(cuePcm, request());
    output.read();
    await setImmediate();
    for (let i = 0; i < 6 && output.readable; i++) output.read();
    assert.equal(output.readable, false);
    audio.setStatus(voice.AudioPlayerStatus.Idle);
    await setImmediate();
    assert.equal(output.hasCue, false);
    assert.equal(player.current, next);
    assert.equal(next.createResource.mock.callCount(), 1);
});

test("mixed music retains its original stream error reporting and cleanup", async (context) => {
    const { player, audio } = setup(context);
    const first = track("first"), next = track("next");
    await player.play(first);
    await player.play(next);
    player.playCue(cuePcm, request());
    const output = audio.state.resource;
    audio.emit("error", new voice.AudioPlayerError(new Error("source failed"), output));
    assert.equal(first.onError.mock.callCount(), 1);
    assert.equal(output.hasCue, false);
    assert.equal(output.playStream.destroyed, true);
    assert.equal(player.current, undefined);
    assert.deepEqual(player.queue, []);
    assert.equal(next.createResource.mock.callCount(), 0);
});

test("the real Discord AudioPlayer consumes the mixer and preserves its real subscription", async (context) => {
    createAudioPlayer.mock.mockImplementation((options) => {
        const player = voice.createAudioPlayer(options);
        players.push(player);
        return player;
    });
    const { player, audio, connection } = setup(context);
    connection.prepareAudioPacket = mock.fn();
    connection.dispatchAudio = mock.fn();
    connection.setSpeaking = mock.fn();
    connection.onSubscriptionRemoved = () => {};
    connection.subscribe.mock.mockImplementation((audioPlayer) => audioPlayer.subscribe(connection));
    const first = track("real"), next = track("next");
    await player.play(first);
    await player.play(next);
    const output = audio.state.resource, subscription = audio.subscribers[0];
    const cue = request();
    player.playCue(cuePcm, cue);
    assert.equal(audio.checkPlayable(), true);
    audio._stepPrepare();
    const [packet] = connection.prepareAudioPacket.mock.calls.at(-1).arguments;
    assert.equal(new opus.OpusEncoder(48_000, 2).decode(packet).length, 3840);
    player.pause();
    const position = first.createResource.mock.calls[0].result.playbackDuration;
    audio._stepPrepare();
    assert.equal(first.createResource.mock.calls[0].result.playbackDuration, position);
    cue.abort.abort();
    assert.equal(audio.state.status, voice.AudioPlayerStatus.Paused);
    assert.equal(audio.state.resource, output);
    assert.equal(audio.subscribers[0], subscription);
    assert.equal(connection.subscribe.mock.callCount(), 1);
    assert.equal(player.resume(), true);
    audio._stepPrepare();
    assert.equal(first.createResource.mock.calls[0].result.playbackDuration, position + 20);
    assert.deepEqual(player.queue, [next]);
});

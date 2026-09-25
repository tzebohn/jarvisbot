import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { beforeEach, mock, test } from "node:test";
import opus from "@discordjs/opus";
import { voice, FakeConnection, connections, players, resetVoiceMocks } from "./helpers/voice.mjs";
import { message, content, music } from "./helpers/messages.mjs";

const { VoiceController, RECEIVE_SILENCE_MS, CAPTURE_WAIT_MS, MAX_CAPTURE_MS } = await import("../src/voice/VoiceController.ts");
const { VoiceReceiveManager } = await import("../src/voice/VoiceReceiveManager.ts");
const { PCM_BYTES_PER_SECOND } = await import("../src/voice/receive/SpeakerStream.ts");
const { createMessageHandler } = await import("../src/handleMessage.ts");
const { VoiceConnectionStatus, AudioPlayerStatus, EndBehaviorType } = voice;

beforeEach(resetVoiceMocks);

test("V2 keeps independent VAD state and rolling buffers per receiver subscription and frees them on disconnect", async (context) => {
    const classifiers = [];
    const createVad = () => {
        const voice = classifiers.length === 0;
        const classifier = { isSpeech: mock.fn(() => voice), destroy: mock.fn() };
        classifiers.push(classifier);
        return classifier;
    };
    const log = context.mock.method(console, "log", () => {});
    const manager = new VoiceReceiveManager(true, createVad);
    const connection = new FakeConnection();
    context.after(() => connection.destroy());
    const controller = manager.attach(connection);
    const alice = controller.captureNextUtterance("alice");
    const bob = controller.captureNextUtterance("bob");
    const a = start(connection, "alice", Array(10).fill(packet(440)));
    const b = start(connection, "bob", Array(10).fill(packet(1200)));
    await setImmediate();
    a.push(null);
    const result = await alice.result;
    assert.equal(result.speech.processedMs, 200);
    assert.equal(result.speech.voicedMs, 200);
    assert.equal(result.speech.speechSegments, 1);
    assert.equal(result.speech.bufferedMs, 200);
    assert.equal(classifiers[0].destroy.mock.callCount(), 1);
    assert.equal(classifiers[1].destroy.mock.callCount(), 0);
    const rejected = assert.rejects(bob.result, /left the voice channel/);
    controller.stopUser("bob");
    await rejected;
    await setImmediate();
    assert.equal(classifiers[1].destroy.mock.callCount(), 1);
    assert.equal(b.destroyed, true);
    const starts = log.mock.calls.filter(({ arguments: args }) => args[0] === "[voice] speech-start");
    assert.deepEqual(starts.map(({ arguments: args }) => args[1].userId), ["alice"]);
    assert.equal(connection.receiver.subscriptions.size, 0);
});

test("a VAD failure leaves raw PCM capture and the guild receiver usable", async (context) => {
    const backend = { isSpeech: mock.fn(() => { throw new Error("VAD failed"); }), destroy: mock.fn() };
    const connection = new FakeConnection();
    const controller = new VoiceController(connection, false, () => backend);
    context.after(() => { controller.destroy(); connection.destroy(); });
    const capture = controller.captureNextUtterance("alice");
    start(connection, "alice", Array(5).fill(packet())).push(null);
    const result = await capture.result;
    assert.equal(result.pcm.length, 5 * 3840);
    assert.equal(result.speech, undefined);
    assert.equal(backend.destroy.mock.callCount(), 1);
    assert.equal(backend.isSpeech.mock.callCount(), 1);
    assert.equal(controller.isDestroyed, false);
});

test("real Opus receive integrates with real WebRTC VAD and preserves the diagnostic PCM format", async (context) => {
    const { createWebRtcVadFactory } = await import("../src/voice/processing/WebRtcVad.ts");
    const connection = new FakeConnection();
    const controller = new VoiceController(connection, false, await createWebRtcVadFactory());
    context.after(() => { controller.destroy(); connection.destroy(); });
    const capture = controller.captureNextUtterance("alice");
    const encoder = new opus.OpusEncoder(48_000, 2);
    const silence = encoder.encode(Buffer.alloc(3840));
    start(connection, "alice", Array(50).fill(silence)).push(null);
    const result = await capture.result;
    assert.equal(result.pcm.length, 192_000);
    assert.equal(result.format.channels, 2);
    assert.equal(result.speech.processedMs, 1000);
    assert.equal(result.speech.voicedMs, 0);
    assert.equal(result.speech.speechSegments, 0);
    assert.equal(result.speech.bufferedMs, 1000);
    assert.equal(connection.receiver.subscriptions.size, 0);
});

test("!voicetest reports VAD results while preserving its raw audio diagnostic", async () => {
    const { createWebRtcVadFactory } = await import("../src/voice/processing/WebRtcVad.ts");
    const manager = new VoiceReceiveManager(false, await createWebRtcVadFactory());
    const handle = createMessageHandler(undefined, manager);
    await handle(message("!join"));
    const request = message("!voicetest");
    const pending = handle(request);
    await setImmediate();
    const silence = new opus.OpusEncoder(48_000, 2).encode(Buffer.alloc(3840));
    start(connections[0], "user-a", Array(5).fill(silence)).push(null);
    await pending;
    assert.match(content(request, 1), /19200 PCM bytes/);
    assert.match(content(request, 1), /VAD: 0 speech segment\(s\), 0 ms classified as voice out of 100 ms analyzed/);
    await handle(message("!leave"));
});

function packet(frequency = 440) {
    const encoder = new opus.OpusEncoder(48_000, 2);
    const pcm = Buffer.alloc(960 * 2 * 2);
    for (let frame = 0; frame < 960; frame++) {
        const sample = Math.round(12_000 * Math.sin(2 * Math.PI * frequency * frame / 48_000));
        pcm.writeInt16LE(sample, frame * 4);
        pcm.writeInt16LE(sample, frame * 4 + 2);
    }
    return encoder.encode(pcm);
}

function start(connection, userId, packets = [packet()]) {
    connection.receiver.speaking.emit("start", userId);
    const source = connection.receiver.subscriptions.get(userId);
    assert.ok(source, "speaker must be subscribed synchronously before the first Opus packet");
    for (const data of packets) source.push(data);
    return source;
}

function udpSender(connection) {
    const key = Buffer.alloc(32, 17);
    connection.state.networking = { state: { code: 4 } };
    connection.receiver.connectionData = {
        encryptionMode: "aead_aes256_gcm_rtpsize", nonceBuffer: Buffer.alloc(12), secretKey: key,
    };
    let sequence = 0;
    return (ssrc, data) => {
        const header = Buffer.alloc(12);
        header[0] = 0x80; // RTP version 2, no extensions.
        header[1] = 120; // Discord's Opus payload type.
        header.writeUInt32BE(ssrc, 8);
        const nonce = Buffer.alloc(12);
        nonce.writeUInt32BE(++sequence);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(header);
        const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
        connection.receiver.onUdpMessage(Buffer.concat([header, encrypted, cipher.getAuthTag(), nonce.subarray(0, 4)]));
    };
}

function setup(context, debug = false) {
    const connection = new FakeConnection();
    const controller = new VoiceController(connection, debug);
    context.after(() => { controller.destroy(); connection.destroy(); });
    return { connection, controller };
}

test("PCM is 48 kHz, interleaved stereo, signed 16-bit little-endian with 192000 bytes per second", async (context) => {
    const { controller, connection } = setup(context);
    const original = Buffer.alloc(3840);
    for (let frame = 0; frame < 960; frame++) {
        original.writeInt16LE(Math.round(12_000 * Math.sin(2 * Math.PI * 440 * frame / 48_000)), frame * 4);
        original.writeInt16LE(Math.round(8_000 * Math.sin(2 * Math.PI * 1200 * frame / 48_000)), frame * 4 + 2);
    }
    const encoder = new opus.OpusEncoder(48_000, 2);
    const encoded = encoder.encode(original);
    const capture = controller.captureNextUtterance("alice");
    start(connection, "alice", [encoded]).push(null);
    const result = await capture.result;
    assert.deepEqual(result.format, { sampleRate: 48_000, channels: 2, bitsPerSample: 16, signed: true, endianness: "little" });
    assert.equal(PCM_BYTES_PER_SECOND, 192_000);
    assert.equal(result.durationMs, 20);
    assert.equal(result.pcm.length, 960 * 2 * 2);
    const left = [];
    const right = [];
    for (let offset = 0; offset < result.pcm.length; offset += 4) {
        left.push(result.pcm.readInt16LE(offset));
        right.push(result.pcm.readInt16LE(offset + 2));
    }
    assert.ok(left.some((value) => value < 0) && left.some((value) => value > 0));
    assert.ok(right.some((value) => value < 0) && right.some((value) => value > 0));
    assert.notDeepEqual(left, right, "stereo channels must not accidentally be downmixed or duplicated");
    assert.deepEqual(result.pcm, new opus.OpusEncoder(48_000, 2).decode(encoded));
});

test("Alice and Bob decode into separate complete PCM utterances, including their first packets", async (context) => {
    const { connection, controller } = setup(context, true);
    const log = context.mock.method(console, "log", () => {});
    const alice = controller.captureNextUtterance("alice");
    const bob = controller.captureNextUtterance("bob");
    const alicePacket = packet(440);
    const bobPacket = packet(1200);
    const first = start(connection, "alice", [alicePacket, alicePacket]);
    const second = start(connection, "bob", [bobPacket]);
    assert.notEqual(first, second);
    assert.deepEqual(first.end, { behavior: EndBehaviorType.AfterSilence, duration: RECEIVE_SILENCE_MS });
    connection.receiver.speaking.emit("start", "alice");
    assert.equal(connection.receiver.subscriptions.get("alice"), first);
    first.push(null);
    second.push(null);
    const [a, b] = await Promise.all([alice.result, bob.result]);
    assert.equal(a.guildId, "guild-a");
    assert.equal(a.userId, "alice");
    assert.equal(b.userId, "bob");
    assert.equal(a.pcm.length, 2 * 3840);
    assert.equal(b.pcm.length, 3840);
    assert.equal(a.durationMs, 40);
    assert.equal(a.truncated, false);
    assert.deepEqual(a.format, { sampleRate: 48_000, channels: 2, bitsPerSample: 16, signed: true, endianness: "little" });
    const aliceDecoder = new opus.OpusEncoder(48_000, 2);
    assert.deepEqual(a.pcm, Buffer.concat([aliceDecoder.decode(alicePacket), aliceDecoder.decode(alicePacket)]));
    assert.deepEqual(b.pcm, new opus.OpusEncoder(48_000, 2).decode(bobPacket));
    assert.notDeepEqual(a.pcm.subarray(0, 3840), b.pcm);
    await setImmediate();
    assert.equal(connection.receiver.subscriptions.size, 0);
    assert.ok(log.mock.calls.some(({ arguments: args }) => args[0] === "[voice] speaker started" && args[1].userId === "alice"));
    assert.ok(log.mock.calls.some(({ arguments: args }) => args[0] === "[voice] speaker started" && args[1].userId === "bob"));
    assert.ok(log.mock.calls.every(({ arguments: args }) => !Object.values(args[1]).some(Buffer.isBuffer)));
});

test("real receiver SSRC routing preserves distinct Discord IDs and PCM with interleaved encrypted packets", async (context) => {
    const { connection, controller } = setup(context, true);
    const log = context.mock.method(console, "log", () => {});
    const aliceId = "111111111111111111";
    const bobId = "222222222222222222";
    const send = udpSender(connection);
    // These are the actual Speaking voice-WebSocket payloads that populate SSRCMap.
    connection.receiver.onWsPacket({ op: 5, d: { user_id: aliceId, ssrc: 101, speaking: 1 } });
    connection.receiver.onWsPacket({ op: 5, d: { user_id: bobId, ssrc: 202, speaking: 1 } });
    const alice = controller.captureNextUtterance(aliceId);
    const bob = controller.captureNextUtterance(bobId);
    const a = packet(440);
    const b = packet(1200);
    send(101, a);
    send(202, b);
    send(202, b);
    send(999, a); // Unknown SSRC must not be attributed to either person.
    send(101, a);
    const sources = [...connection.receiver.subscriptions.values()];
    assert.equal(sources.length, 2);
    for (const source of sources) source.push(null);
    const [first, second] = await Promise.all([alice.result, bob.result]);
    assert.equal(first.userId, aliceId);
    assert.equal(second.userId, bobId);
    const decoderA = new opus.OpusEncoder(48_000, 2);
    const decoderB = new opus.OpusEncoder(48_000, 2);
    assert.deepEqual(first.pcm, Buffer.concat([decoderA.decode(a), decoderA.decode(a)]));
    assert.deepEqual(second.pcm, Buffer.concat([decoderB.decode(b), decoderB.decode(b)]));
    assert.notDeepEqual(first.pcm, second.pcm);
    assert.deepEqual(log.mock.calls.filter(({ arguments: args }) => args[0] === "[voice] speaker started")
        .map(({ arguments: args }) => args[1].userId), [aliceId, bobId]);
    await setImmediate();
    assert.equal(connection.receiver.subscriptions.size, 0);
    assert.ok(sources.every((source) => source.destroyed));
});

test("real ClientDisconnect during speaking cleans Alice's stream while Bob continues without a crash", async (context) => {
    const { connection, controller } = setup(context);
    const send = udpSender(connection);
    connection.receiver.onWsPacket({ op: 5, d: { user_id: "alice", ssrc: 101, speaking: 1 } });
    connection.receiver.onWsPacket({ op: 5, d: { user_id: "bob", ssrc: 202, speaking: 1 } });
    const alice = controller.captureNextUtterance("alice");
    const bob = controller.captureNextUtterance("bob");
    send(101, packet(440));
    send(202, packet(1200));
    await setImmediate();
    const source = connection.receiver.subscriptions.get("alice");
    const rejected = assert.rejects(alice.result, /left the voice channel/);
    assert.doesNotThrow(() => connection.receiver.onWsPacket({ op: 13, d: { user_id: "alice" } }));
    await rejected;
    await setImmediate();
    assert.equal(source.destroyed, true);
    assert.equal(connection.receiver.subscriptions.has("alice"), false);
    assert.doesNotThrow(() => send(101, packet(440))); // A late packet has no remaining user mapping.
    send(202, packet(1200));
    connection.receiver.subscriptions.get("bob").push(null);
    const result = await bob.result;
    assert.equal(result.userId, "bob");
    assert.equal(result.pcm.length, 7680);
    assert.equal(connection.state.status, VoiceConnectionStatus.Ready);
});

test("the receive stream ends after silence, not the speaking map's short end event", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { controller, connection } = setup(context);
    const capture = controller.captureNextUtterance("alice");
    const source = start(connection, "alice");
    await setImmediate();
    connection.receiver.speaking.emit("end", "alice");
    context.mock.timers.tick(200);
    assert.equal(source.destroyed, false);
    source.push(packet());
    await setImmediate();
    context.mock.timers.tick(RECEIVE_SILENCE_MS - 1);
    assert.equal(source.destroyed, false);
    context.mock.timers.tick(1);
    const result = await capture.result;
    assert.equal(result.pcm.length, 7680);
    assert.equal(result.truncated, false);
    assert.equal(source.destroyed, true);
});

test("ordinary receiving retains no past utterance and permits a fresh test after cleanup", async (context) => {
    const { controller, connection } = setup(context);
    const ordinary = start(connection, "alice", [packet(1200)]);
    assert.throws(() => controller.captureNextUtterance("alice"), /Finish speaking/);
    ordinary.push(null);
    await setImmediate();
    const capture = controller.captureNextUtterance("alice");
    start(connection, "alice", [packet(440)]).push(null);
    const result = await capture.result;
    assert.equal(result.pcm.length, 3840);
    assert.deepEqual(result.pcm, new opus.OpusEncoder(48_000, 2).decode(packet(440)));
    assert.equal(connection.receiver.subscriptions.size, 0);
});

test("capture wait timeout and speaking-without-audio timeout release pending tests", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { controller, connection } = setup(context);
    const silent = controller.captureNextUtterance("alice");
    assert.throws(() => controller.captureNextUtterance("alice"), /already have a voice test/);
    const timeout = assert.rejects(silent.result, /within 15 seconds/);
    context.mock.timers.tick(CAPTURE_WAIT_MS);
    await timeout;
    assert.equal(connection.receiver.subscriptions.size, 0);
    const noPackets = controller.captureNextUtterance("alice");
    const source = start(connection, "alice", []);
    const noAudio = assert.rejects(noPackets.result, /no Opus audio arrived/);
    context.mock.timers.tick(RECEIVE_SILENCE_MS);
    await noAudio;
    await setImmediate();
    assert.equal(source.destroyed, true);
    assert.equal(connection.receiver.subscriptions.size, 0);
});

test("capture enforces its PCM byte bound even if packets arrive faster than real time", async (context) => {
    const { controller, connection } = setup(context);
    const capture = controller.captureNextUtterance("alice");
    const source = start(connection, "alice", Array(510).fill(packet()));
    const result = await capture.result;
    assert.equal(result.pcm.length, PCM_BYTES_PER_SECOND * MAX_CAPTURE_MS / 1000);
    assert.equal(result.durationMs, MAX_CAPTURE_MS);
    assert.equal(result.truncated, true);
    // Receiving remains live; the bounded diagnostic stops retaining new PCM.
    assert.equal(source.destroyed, false);
    source.push(null);
    await setImmediate();
    assert.equal(connection.receiver.subscriptions.size, 0);
});

test("capture has a wall-clock limit even when audio arrives only intermittently", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { controller, connection } = setup(context);
    const capture = controller.captureNextUtterance("alice");
    const source = start(connection, "alice");
    await setImmediate();
    for (let step = 0; step < 11; step++) {
        context.mock.timers.tick(900);
        source.push(packet());
        await setImmediate();
    }
    context.mock.timers.tick(100);
    const result = await capture.result;
    assert.equal(result.truncated, true);
    assert.ok(result.durationMs < MAX_CAPTURE_MS);
    source.push(null);
    await setImmediate();
});

for (const failure of ["decode", "receive", "user-left", "connection-interrupted", "destroy"]) {
    test(`${failure} cancels affected captures, releases subscriptions, and permits recovery`, async (context) => {
        const { controller, connection } = setup(context);
        const capture = controller.captureNextUtterance("alice");
        const source = start(connection, "alice");
        await setImmediate();
        const rejected = assert.rejects(capture.result);
        if (failure === "decode") source.push(Buffer.from([255, 255, 255]));
        if (failure === "receive") source.destroy(new Error("transport decryption failed"));
        if (failure === "user-left") connection.receiver.ssrcMap.emit("delete", { userId: "alice", audioSSRC: 1 });
        if (failure === "connection-interrupted") connection.setStatus(VoiceConnectionStatus.Disconnected);
        if (failure === "destroy") controller.destroy();
        await rejected;
        await setImmediate();
        assert.equal(source.destroyed, true);
        assert.equal(connection.receiver.subscriptions.size, 0);
        if (failure !== "destroy") {
            connection.setStatus(VoiceConnectionStatus.Ready);
            const next = controller.captureNextUtterance("alice");
            start(connection, "alice").push(null);
            assert.equal((await next.result).truncated, false);
        } else {
            assert.throws(() => controller.captureNextUtterance("alice"), /not ready/);
            assert.equal(connection.receiver.speaking.listenerCount("start"), 0);
            assert.equal(connection.receiver.ssrcMap.listenerCount("delete"), 0);
            assert.equal(connection.listenerCount("stateChange"), 0);
        }
    });
}

test("a failed speaker does not cancel another speaker or a later test", async (context) => {
    const { controller, connection } = setup(context);
    const alice = controller.captureNextUtterance("alice");
    const bob = controller.captureNextUtterance("bob");
    const a = start(connection, "alice");
    const b = start(connection, "bob");
    const rejected = assert.rejects(alice.result);
    a.destroy(new Error("bad packet"));
    b.push(null);
    await rejected;
    assert.equal((await bob.result).pcm.length, 3840);
    const replacement = controller.captureNextUtterance("bob");
    bob.cancel(); // A late finally block from the old command must not cancel the new one.
    start(connection, "bob").push(null);
    assert.equal((await replacement.result).pcm.length, 3840);
});

test("manager reuses controllers, isolates guilds, and handles gateway departures before audio starts", async (context) => {
    const manager = new VoiceReceiveManager();
    const a = new FakeConnection();
    const b = new FakeConnection();
    b.joinConfig.guildId = "guild-b";
    context.after(() => {
        if (a.state.status !== VoiceConnectionStatus.Destroyed) a.destroy();
        b.destroy();
    });
    const first = manager.attach(a);
    const second = manager.attach(b);
    assert.equal(manager.attach(a), first);
    assert.equal(a.receiver.speaking.listenerCount("start"), 1);
    const pendingA = first.captureNextUtterance("alice");
    const pendingB = second.captureNextUtterance("alice");
    const rejected = assert.rejects(pendingA.result, /left the voice channel/);
    manager.handleVoiceStateUpdate({ channelId: "voice-a" }, {
        id: "alice", guild: { id: "guild-a" }, client: { user: { id: "bot" } }, channelId: null,
    });
    await rejected;
    start(b, "alice").push(null);
    assert.equal((await pendingB.result).guildId, "guild-b");
    const replacement = new FakeConnection();
    context.after(() => replacement.destroy());
    const newer = manager.attach(replacement);
    assert.equal(first.isDestroyed, true);
    a.setStatus(VoiceConnectionStatus.Destroyed); // Late event from an old connection.
    assert.equal(manager.get("guild-a"), newer);
    assert.equal(manager.get("guild-b"), second);
});

test("a bot move or deafen cancels active and pending samples", async (context) => {
    const manager = new VoiceReceiveManager();
    const connection = new FakeConnection();
    context.after(() => connection.destroy());
    const controller = manager.attach(connection);
    const alice = controller.captureNextUtterance("alice");
    const bob = controller.captureNextUtterance("bob");
    const source = start(connection, "alice");
    const rejected = Promise.all([assert.rejects(alice.result, /bot moved/), assert.rejects(bob.result, /bot moved/)]);
    manager.handleVoiceStateUpdate({ channelId: "voice-a" }, {
        id: "bot", guild: { id: "guild-a" }, client: { user: { id: "bot" } }, channelId: "voice-a", deaf: true,
    });
    await rejected;
    await setImmediate();
    assert.equal(source.destroyed, true);
    assert.equal(connection.receiver.subscriptions.size, 0);
});

test("!voicetest validates guild, connection, membership, and arguments before capture", async () => {
    const handle = createMessageHandler();
    const disconnected = message("!voicetest");
    await handle(disconnected);
    assert.match(content(disconnected), /Use `!join` first/);
    const dm = message("!voicetest");
    dm.guild = null;
    await handle(dm);
    assert.match(content(dm), /inside a server/);
    await handle(message("!join"));
    const wrongChannel = message("!voicetest", "guild-a", "elsewhere");
    await handle(wrongChannel);
    assert.match(content(wrongChannel), /Join my voice channel/);
    const invalid = message("!voicetest unknown");
    await handle(invalid);
    assert.match(content(invalid), /Usage:/);
    assert.equal(connections[0].receiver.subscriptions.size, 0);
    await handle(message("!leave"));
});

for (const wav of [false, true]) {
    test(`!voicetest ${wav ? "wav returns a sample" : "returns statistics only"} while music keeps playing`, async () => {
        const { handle } = music();
        await handle(message("!play song"));
        const connection = connections[0];
        assert.equal(connection.joinConfig.selfDeaf, false);
        const request = message(wav ? "!voicetest wav" : "!voicetest");
        const pending = handle(request);
        await setImmediate();
        assert.match(content(request), /Ready for your next utterance/);
        start(connection, "user-a").push(null);
        await pending;
        assert.match(content(request, 1), /user user-a: 0\.02s, 3840 PCM bytes/);
        const files = request.reply.mock.calls[1].arguments[0].files;
        assert.equal(files.length, wav ? 1 : 0);
        if (wav) {
            const sample = files[0].attachment;
            assert.equal(sample.subarray(0, 4).toString(), "RIFF");
            assert.equal(sample.readUInt32LE(24), 48_000);
            assert.equal(sample.readUInt16LE(22), 2);
            assert.equal(sample.readUInt16LE(34), 16);
            assert.equal(sample.readUInt32LE(40), 3840);
            assert.equal(sample.length, 44 + 3840);
        }
        assert.equal(players.length, 1);
        assert.equal(players[0].state.status, AudioPlayerStatus.Playing);
        assert.equal(connection.receiver.subscriptions.size, 0);
        await handle(message("!join"));
        assert.equal(connection.receiver.speaking.listenerCount("start"), 1);
        await handle(message("!leave"));
        assert.equal(connection.receiver.speaking.listenerCount("start"), 0);
    });
}

test("!leave during a diagnostic cancels capture and releases all receive resources", async () => {
    const handle = createMessageHandler();
    await handle(message("!join"));
    const request = message("!voicetest");
    const pending = handle(request);
    await setImmediate();
    const source = start(connections[0], "user-a");
    await setImmediate();
    await handle(message("!leave"));
    await pending;
    assert.match(content(request, 1), /connection|bot left/);
    await setImmediate();
    assert.equal(source.destroyed, true);
    assert.equal(connections[0].receiver.subscriptions.size, 0);
    assert.equal(connections[0].receiver.speaking.listenerCount("start"), 0);
});

test("a failed initial Discord reply cancels its pending capture so a later test can run", async () => {
    const handle = createMessageHandler();
    await handle(message("!join"));
    const first = message("!voicetest");
    first.reply.mock.mockImplementationOnce(async () => { throw new Error("reply unavailable"); });
    await handle(first);
    const second = message("!voicetest");
    const pending = handle(second);
    await setImmediate();
    assert.match(content(second), /Ready/);
    start(connections[0], "user-a").push(null);
    await pending;
    await handle(message("!leave"));
});

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { beforeEach, mock, test } from "node:test";
import { createAudioResource, resetVoiceMocks } from "./helpers/voice.mjs";
const { YtDlpAudio } = await import("../src/music/providers/youtube/YtDlpAudio.ts");

beforeEach(resetVoiceMocks);

function setup(context, timeout = 1000) {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, killed: false });
    child.kill = mock.fn(() => { child.killed = true; });
    const launch = mock.fn(() => child);
    const output = new PassThrough();
    createAudioResource.mock.mockImplementation(() => ({ playStream: output }));
    context.after(() => { output.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); });
    return { child, launch, output, audio: new YtDlpAudio("C:\\Tools With Spaces\\yt-dlp.exe", launch, timeout) };
}

test("extractor uses a canonical single-video argument, no shell, and releases its process with the resource", async (context) => {
    const { child, launch, output, audio } = setup(context);
    const pending = audio.getAudio("abcdefghijk");
    child.stdout.write("audio bytes");
    const resource = await pending;
    assert.equal(resource.playStream, output);
    const [executable, args, options] = launch.mock.calls[0].arguments;
    assert.equal(executable, "C:\\Tools With Spaces\\yt-dlp.exe");
    assert.equal(options.shell, false);
    assert.deepEqual(args.slice(-2), ["--", "https://www.youtube.com/watch?v=abcdefghijk"]);
    assert.ok(args.includes("--no-playlist"));
    assert.equal(args[args.indexOf("--http-chunk-size") + 1], "256K");
    assert.equal(args[args.indexOf("--retries") + 1], "3");
    assert.ok(args.includes(`node:${process.execPath}`));
    assert.ok(!args.some((arg) => arg.includes("API_KEY")));
    resource.playStream.destroy();
    await setImmediate();
    assert.equal(child.kill.mock.callCount(), 1);
    assert.ok(child.stdout.destroyed);
});

test("missing executable rejects with actionable configuration information", async (context) => {
    const { child, audio } = setup(context);
    const pending = assert.rejects(audio.getAudio("abcdefghijk"), { code: "UNAVAILABLE", message: /YT_DLP_PATH/ });
    child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await pending;
    assert.ok(child.stdout.destroyed);
});

test("empty and failed extractor exits reject before playback", async (context) => {
    for (const code of [0, 1]) {
        const { child, audio } = setup(context);
        const pending = assert.rejects(audio.getAudio("abcdefghijk"), { code: "NOT_PLAYABLE" });
        child.exitCode = code;
        child.emit("close", code);
        await pending;
        assert.ok(child.stdout.destroyed);
    }
});

test("startup timeout kills the extractor", async (context) => {
    const { child, audio } = setup(context, 5);
    await assert.rejects(audio.getAudio("abcdefghijk"), { code: "UNAVAILABLE", message: /timed out/ });
    assert.equal(child.kill.mock.callCount(), 1);
});

test("cancellation before and during extraction releases owned resources", async (context) => {
    const { child, launch, audio } = setup(context);
    const controller = new AbortController();
    const pending = assert.rejects(audio.getAudio("abcdefghijk", controller.signal), /cancelled/);
    controller.abort();
    await pending;
    assert.equal(child.kill.mock.callCount(), 1);
    await assert.rejects(audio.getAudio("abcdefghijk", controller.signal), /cancelled/);
    assert.equal(launch.mock.callCount(), 1);
});

test("extractor errors after handoff surface through the playable stream", async (context) => {
    const { child, audio } = setup(context);
    const pending = audio.getAudio("abcdefghijk");
    child.stdout.write("audio bytes");
    const resource = await pending;
    const failure = once(resource.playStream, "error");
    child.stderr.write("ERROR: 458752 bytes read, 1211397 more expected. Giving up after 3 retries\n");
    child.exitCode = 1;
    child.emit("close", 1);
    const [error] = await failure;
    assert.equal(error.code, "NOT_PLAYABLE");
    assert.match(error.cause.message, /code=1/);
    assert.match(error.cause.message, /1211397 more expected/);
    assert.ok(console.error.mock.calls.some(({ arguments: args }) => args[1]?.includes("1211397 more expected")));
    assert.ok(resource.playStream.destroyed);
});

test("decoding setup failure cleans up and reports FFmpeg requirements", async (context) => {
    const { child, audio } = setup(context);
    createAudioResource.mock.mockImplementation(() => { throw new Error("ffmpeg absent"); });
    const pending = assert.rejects(audio.getAudio("abcdefghijk"), { code: "UNAVAILABLE", message: /FFmpeg/ });
    child.stdout.write("audio bytes");
    await pending;
    assert.equal(child.kill.mock.callCount(), 1);
});

test("the startup deadline is cleared once audio is available, not used as a playback limit", async (context) => {
    const { child, output, audio } = setup(context, 5);
    const pending = audio.getAudio("abcdefghijk");
    child.stdout.write("audio bytes");
    await pending;
    await delay(20);
    assert.equal(output.destroyed, false);
    assert.equal(child.kill.mock.callCount(), 0);
    assert.equal(console.error.mock.callCount(), 0);
});

test("normal extractor completion leaves buffered audio alive until the consumer finishes", async (context) => {
    const { child, output, audio } = setup(context);
    const pending = audio.getAudio("abcdefghijk");
    child.stdout.write("audio bytes");
    const resource = await pending;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    assert.equal(output.destroyed, false);
    assert.equal(child.kill.mock.callCount(), 0);
    output.write("buffered audio");
    assert.equal(resource.playStream.read().toString(), "buffered audio");
    output.end();
    output.resume();
    await once(output, "close");
    assert.equal(child.kill.mock.callCount(), 0);
    assert.equal(console.error.mock.callCount(), 0);
});

test("cancelling a playing resource is disposal, not a fatal stream error", async (context) => {
    const { child, audio } = setup(context);
    const controller = new AbortController();
    const pending = audio.getAudio("abcdefghijk", controller.signal);
    child.stdout.write("audio bytes");
    const resource = await pending;
    const onError = mock.fn();
    resource.playStream.on("error", onError);
    controller.abort();
    await setImmediate();
    child.emit("close", null, "SIGTERM");
    assert.equal(resource.playStream.destroyed, true);
    assert.equal(child.kill.mock.callCount(), 1);
    assert.equal(onError.mock.callCount(), 0);
    assert.equal(console.error.mock.callCount(), 0);
});

test("decoder errors retain their underlying cause and terminate the extractor", async (context) => {
    const { child, audio } = setup(context);
    const pending = audio.getAudio("abcdefghijk");
    child.stdout.write("audio bytes");
    const resource = await pending;
    const underlying = Object.assign(new Error("decoder pipe failed"), { code: "EPIPE" });
    const failure = once(resource.playStream, "error");
    resource.playStream.destroy(underlying);
    assert.equal((await failure)[0], underlying);
    assert.equal(child.kill.mock.callCount(), 1);
    assert.ok(console.error.mock.calls.some(({ arguments: args }) => args[1]?.includes("EPIPE")));
});

test("stderr is bounded, retained across chunks, and sanitized before it is logged", async (context) => {
    const { child, audio } = setup(context);
    const pending = audio.getAudio("abcdefghijk");
    child.stdout.write("audio bytes");
    const resource = await pending;
    child.stderr.write("old oversized line ".repeat(2000) + "\n");
    child.stderr.write("ERROR: incomplete response https://media.example/audio?sig=sec");
    child.stderr.write("ret\nCookie: session=private\nMore bytes expected\n");
    const failure = once(resource.playStream, "error");
    child.exitCode = 1;
    child.emit("close", 1);
    const [error] = await failure;
    assert.match(error.cause.message, /More bytes expected/);
    assert.ok(error.cause.message.length < 16_384);
    const logged = JSON.stringify(console.error.mock.calls.map((call) => call.arguments));
    assert.ok(!logged.includes("sig=secret"));
    assert.ok(!logged.includes("session=private"));
    assert.ok(!logged.includes("old oversized line"));
});

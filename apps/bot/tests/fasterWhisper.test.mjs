import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FasterWhisperSpeechToText } from "../src/voice/transcription/FasterWhisperSpeechToText.ts";
import { localSttOptions } from "../src/voice/transcription/config.ts";
import { SpeechToText } from "../src/voice/transcription/SpeechToText.ts";
import { pcmToWav } from "../src/voice/receive/wav.ts";
import { PCM_FORMAT } from "../src/voice/receive/SpeakerStream.ts";

const fixture = fileURLToPath(new URL("./helpers/sttWorker.mjs", import.meta.url));
const signal = () => new AbortController().signal;
const wav = (marker = 0) => { const pcm = Buffer.alloc(3_840); pcm.writeInt16LE(marker); return pcmToWav(pcm); };
function setup(context) {
    const children = [];
    const local = new FasterWhisperSpeechToText(localSttOptions({}), (_python, args, options) => {
        assert.ok(args.includes("--model"));
        assert.equal(options.env.HF_HUB_OFFLINE, "1");
        const child = spawn(process.execPath, [fixture], options);
        children.push(child);
        return child;
    });
    context.after(() => local.close());
    return { local, children };
}

test("local worker starts lazily, reuses one model process, and correlates queued clips", async (context) => {
    const { local, children } = setup(context);
    assert.equal(children.length, 0);
    const results = await Promise.all([local.transcribe(wav(1), signal()), local.transcribe(wav(5), signal())]);
    assert.deepEqual(results.map((r) => r.text), ["Jarvis play 1", "Jarvis play 5"]);
    assert.equal(children.length, 1);
    assert.equal(results[0].segments[0].avgLogprob, -0.3);
    assert.equal((await local.transcribe(wav(6), signal())).text, "Jarvis play 6");
    assert.equal(children.length, 1);
});

test("cancelling active inference kills its worker; another guild's queued clip restarts safely", async (context) => {
    const { local, children } = setup(context);
    const abort = new AbortController();
    const active = assert.rejects(local.transcribe(wav(2), abort.signal), { name: "AbortError" });
    const queued = local.transcribe(wav(5), signal());
    abort.abort();
    await active;
    assert.equal((await queued).text, "Jarvis play 5");
    assert.equal(children.length, 2);
    assert.equal(children[0].killed, true);
});

test("queued cancellation does not kill another guild's active request; backlog is bounded", async (context) => {
    const { local, children } = setup(context);
    const active = local.transcribe(wav(1), signal());
    const abort = new AbortController();
    const cancelled = assert.rejects(local.transcribe(wav(5), abort.signal), { name: "AbortError" });
    abort.abort();
    const queued = [6, 7, 8, 9].map((marker) => local.transcribe(wav(marker), signal()));
    await assert.rejects(local.transcribe(wav(10), signal()), { code: "BUSY" });
    await cancelled;
    await active;
    assert.deepEqual((await Promise.all(queued)).map((r) => r.text), [6, 7, 8, 9].map((n) => `Jarvis play ${n}`));
    assert.equal(children.length, 1);
    assert.equal(children[0].killed, false);
});

for (const marker of [3, 4]) {
    test(`malformed protocol/worker exit (${marker}) rejects and subsequent work recovers`, async (context) => {
        const { local } = setup(context);
        const failed = assert.rejects(local.transcribe(wav(marker), signal()), { code: "LOCAL_FAILED" });
        const queued = local.transcribe(wav(5), signal());
        await failed;
        assert.equal((await queued).text, "Jarvis play 5");
    });
}

test("local timeout terminates the child; close rejects pending work and prevents respawn", async (context) => {
    const { local, children } = setup(context);
    const stt = new SpeechToText(local, local, { mode: "local", localTimeoutMs: 100 });
    await assert.rejects(stt.transcribe({ pcm: wav(2).subarray(44), format: PCM_FORMAT, wake: { phrase: "Jarvis" } }, signal()), { code: "TIMEOUT" });
    assert.equal(children[0].killed, true);
    const pending = assert.rejects(local.transcribe(wav(2), signal()), { code: "LOCAL_FAILED" });
    const queued = assert.rejects(local.transcribe(wav(5), signal()), { code: "LOCAL_FAILED" });
    local.close();
    await Promise.all([pending, queued]);
    await assert.rejects(local.transcribe(wav(), signal()), { code: "LOCAL_FAILED" });
});

test("missing Python produces an actionable error without exposing OS details", async (context) => {
    const local = new FasterWhisperSpeechToText({ ...localSttOptions({}), python: "nonexistent-stt-python-executable" });
    context.after(() => local.close());
    await assert.rejects(local.transcribe(wav(), signal()), (error) => error.code === "LOCAL_FAILED"
        && error.message.includes("VOICE_STT_PYTHON") && !error.message.includes("ENOENT"));
});

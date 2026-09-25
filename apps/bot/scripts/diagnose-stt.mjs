import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createSpeechToText } from "../src/voice/transcription/config.ts";
import { PCM_FORMAT } from "../src/voice/receive/SpeakerStream.ts";
import { WAKE_PHRASE } from "../src/voice/wake/wakeModel.ts";

const args = process.argv.slice(2);
const local = args[0] === "--local";
if (local) args.shift();
const [path, count = "3"] = args;
const runs = Number(count);
if (!path || args.length > 2 || !Number.isInteger(runs) || runs < 1 || runs > 10) {
    throw new Error("Usage: diagnose:stt [--local] command-test.wav [1-10 runs], or --synthetic instead of a path on Windows. Auto mode uploads this clip to Groq; transcripts are printed.");
}
let wav;
if (path === "--synthetic") {
    if (process.platform !== "win32") throw new Error("Synthetic speech uses Windows System.Speech. Pass a command WAV on other platforms.");
    const speech = spawnSync("powershell", ["-NoProfile", "-Command",
        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $m = New-Object IO.MemoryStream; $s.SetOutputToWaveStream($m); $s.Speak('Jarvis, play Numb by Linkin Park'); $s.Dispose(); [Convert]::ToBase64String($m.ToArray())"],
    { encoding: "utf8", maxBuffer: 5_000_000, timeout: 15_000 });
    if (speech.error || speech.status !== 0) throw new Error("Could not create the Windows synthetic speech sample.");
    wav = Buffer.from(speech.stdout.trim(), "base64");
} else {
    if ((await stat(path)).size > 5_000_000) throw new Error("Use a command WAV smaller than 5 MB and no longer than 14 seconds.");
    wav = await readFile(path);
}
const decoded = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-t", "14.01",
    "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1"], { input: wav, maxBuffer: 3_000_000, timeout: 10_000 });
if (decoded.error || decoded.status !== 0) throw new Error("Could not decode the command WAV. Check FFmpeg and the input file.");
if (!decoded.stdout.length || decoded.stdout.length > 2_688_000) throw new Error("Use a nonempty command clip no longer than 14 seconds.");
const stt = createSpeechToText({ ...process.env, VOICE_STT_MODE: local ? "local" : "auto" });
const audio = { pcm: decoded.stdout, format: PCM_FORMAT, wake: { phrase: WAKE_PHRASE } };
const elapsed = [];
try {
    for (let i = 0; i < runs; i++) {
        const result = await stt.transcribe(audio, new AbortController().signal);
        elapsed.push(result.elapsedMs);
        console.log(JSON.stringify({ run: i + 1, audioMs: audio.pcm.length / 192, ...result }));
    }
    const sorted = [...elapsed].sort((a, b) => a - b);
    console.log(JSON.stringify({ runs, firstMs: elapsed[0], medianMs: sorted[Math.floor(sorted.length / 2)],
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], note: "First local run includes Python/model startup. Compare transcripts as well as latency." }));
} finally { stt.close(); }

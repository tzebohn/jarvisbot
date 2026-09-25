import "dotenv/config";
import { spawn } from "node:child_process";
import { localSttOptions } from "../src/voice/transcription/config.ts";
import { localWorkerArgs } from "../src/voice/transcription/FasterWhisperSpeechToText.ts";

const options = localSttOptions();
const child = spawn(options.python, [...localWorkerArgs(options), "--download"], { stdio: "inherit", windowsHide: true });
child.on("error", () => { console.error("Could not start Python. Set VOICE_STT_PYTHON to the environment containing scripts/requirements-stt.txt."); process.exitCode = 1; });
child.on("close", (code) => { process.exitCode = code ?? 1; });

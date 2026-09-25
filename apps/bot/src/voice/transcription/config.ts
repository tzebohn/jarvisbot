import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { FasterWhisperSpeechToText, type FasterWhisperOptions } from "./FasterWhisperSpeechToText.js";
import { GroqSpeechToText } from "./GroqSpeechToText.js";
import { SpeechToText } from "./SpeechToText.js";

export function localSttOptions(env: NodeJS.ProcessEnv = process.env): FasterWhisperOptions {
    const venvPython = fileURLToPath(new URL(process.platform === "win32"
        ? "../../../.venv-stt/Scripts/python.exe" : "../../../.venv-stt/bin/python", import.meta.url));
    const threads = Number(env.VOICE_STT_THREADS?.trim() || "2");
    const device = env.VOICE_STT_DEVICE?.trim() || "cpu";
    const language = env.VOICE_STT_LANGUAGE?.trim() || "en";
    if (!Number.isInteger(threads) || threads < 1 || threads > 16) throw new Error("VOICE_STT_THREADS must be an integer from 1 to 16.");
    if (device !== "cpu" && device !== "cuda") throw new Error("VOICE_STT_DEVICE must be cpu or cuda.");
    if (!/^(?:auto|[a-z]{2,3})$/.test(language)) throw new Error("VOICE_STT_LANGUAGE must be a language code or auto.");
    return { python: env.VOICE_STT_PYTHON?.trim() || (existsSync(venvPython) ? venvPython : process.platform === "win32" ? "python" : "python3"),
        model: env.VOICE_STT_LOCAL_MODEL?.trim() || "small.en", device,
        computeType: env.VOICE_STT_COMPUTE_TYPE?.trim() || (device === "cpu" ? "int8" : "float16"), threads, language,
        cacheDir: env.VOICE_STT_CACHE_DIR?.trim() || fileURLToPath(new URL("../../../models/stt", import.meta.url)) };
}

export function createSpeechToText(env: NodeJS.ProcessEnv = process.env): SpeechToText | undefined {
    const mode = env.VOICE_STT_MODE?.trim() || "auto";
    if (mode === "off") return undefined;
    if (mode !== "auto" && mode !== "local") throw new Error("VOICE_STT_MODE must be auto, local, or off.");
    const local = localSttOptions(env);
    return new SpeechToText(new GroqSpeechToText(env.GROQ_API_KEY ?? "", local.language),
        new FasterWhisperSpeechToText(local), { mode });
}

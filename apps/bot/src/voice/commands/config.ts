import { DEFAULT_COMMAND_MODEL, GroqCommandNormalizer } from "./GroqCommandNormalizer.js";
import { VoiceCommandParser } from "./VoiceCommandParser.js";

export function createVoiceCommandParser(env: NodeJS.ProcessEnv = process.env): VoiceCommandParser {
    const mode = env.VOICE_COMMAND_MODE?.trim() || "hybrid";
    if (mode !== "hybrid" && mode !== "local") throw new Error("VOICE_COMMAND_MODE must be hybrid or local.");
    const key = env.GROQ_API_KEY?.trim();
    return new VoiceCommandParser(mode === "hybrid" && key
        ? new GroqCommandNormalizer(key, env.VOICE_COMMAND_MODEL?.trim() || DEFAULT_COMMAND_MODEL) : undefined);
}

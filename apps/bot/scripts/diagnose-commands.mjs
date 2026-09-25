import "dotenv/config";
import { createVoiceCommandParser } from "../src/voice/commands/config.ts";

const args = process.argv.slice(2);
const local = args[0] === "--local";
if (local) args.shift();
if (!args.length) {
    console.error('Usage: pnpm --filter bot diagnose:commands [--local] "Jarvis, play Numb by Linkin Park"');
    process.exitCode = 2;
} else {
    const parser = createVoiceCommandParser({ ...process.env, ...(local ? { VOICE_COMMAND_MODE: "local" } : {}) });
    const result = await parser.parse(args.join(" "), new AbortController().signal);
    console.log(JSON.stringify(result, null, 2));
    if (["configuration", "unavailable", "timeout", "rate-limited", "invalid-response"].includes(result.reason)) process.exitCode = 1;
}

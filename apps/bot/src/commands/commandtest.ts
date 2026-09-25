import { AttachmentBuilder, escapeMarkdown, type Message } from "discord.js";
import type { VoiceReceiveManager } from "../voice/VoiceReceiveManager.js";
import type { GuildVoiceSessions } from "../voice/sessions/GuildVoiceSessions.js";
import { pcmToWav } from "../voice/receive/wav.js";
import { WAKE_PHRASE } from "../voice/wake/wakeModel.js";
import { replyTo } from "./reply.js";

/** Observe the real session pipeline; WAV upload requires this explicit per-user request. */
export async function handleCommandTest(message: Message, args: string, receivers: VoiceReceiveManager): Promise<void> {
    const reply = (content: string) => replyTo(message, content);
    const mode = args.toLowerCase();
    if (mode && mode !== "wav") { await reply("Usage: `!commandtest` or `!commandtest wav` (upload your next activated command capture)."); return; }
    const controller = receivers.get(message.guild!.id);
    if (!controller) { await reply("Use `!join` first, then `!commandtest`."); return; }
    const member = await message.guild!.members.fetch(message.author.id);
    if (member.voice.channel?.id !== controller.connection.joinConfig.channelId) {
        await reply("Join my voice channel before testing command capture.");
        return;
    }
    const sessions = receivers.getSessions(message.guild!.id);
    if (!sessions) { await reply("Voice command sessions are unavailable."); return; }
    let watch: ReturnType<GuildVoiceSessions["waitForCapture"]> | undefined;
    let transcriptWatch: ReturnType<GuildVoiceSessions["waitForTranscript"]> | undefined;
    let commandWatch: ReturnType<GuildVoiceSessions["waitForCommand"]> | undefined;
    try {
        watch = sessions.waitForCapture(message.author.id);
        if (sessions.transcriptionEnabled) transcriptWatch = sessions.waitForTranscript(message.author.id);
        if (sessions.parsingEnabled) commandWatch = sessions.waitForCommand(message.author.id);
        await reply(`Say "${WAKE_PHRASE}, play Numb by Linkin Park", then stop speaking. `
            + "I'll report your next activated command capture (45-second test limit). "
            + (mode ? "Your captured audio will be uploaded here. " : "Audio stays in memory. ")
            + (transcriptWatch ? "I'll also post the normalized STT transcript here." : "Transcription is disabled; only statistics are reported.")
            + (commandWatch ? " Then I'll report the parsed command and whether local rules or Groq recognized it." : "")
            + (sessions.executionEnabled ? " Supported commands will run; music results appear in the voice channel's text chat." : ""));
        const audio = await watch.result;
        await message.reply({
            content: `Command capture for user ${audio.userId} in guild ${audio.guildId}: `
                + `${(audio.durationMs / 1_000).toFixed(2)}s, ${audio.pcm.length} PCM bytes, `
                + `${audio.preRollMs} ms pre-roll, ${audio.streamIds.length} receive stream(s). `
                + `Finished: ${audio.reason}${audio.truncated ? " (truncated)" : ""}. `
                + (transcriptWatch ? "Transcribing your command…" : "Transcription is disabled."),
            allowedMentions: { parse: [], repliedUser: false },
            files: mode ? [new AttachmentBuilder(pcmToWav(audio.pcm), { name: "command-test.wav" })] : [],
        });
        if (transcriptWatch) {
            const transcript = await transcriptWatch.result;
            await reply(`STT: ${transcript.provider}${transcript.model ? ` (${transcript.model})` : ""}, `
                + `${Math.round(transcript.elapsedMs)} ms total (Groq ${Math.round(transcript.groqMs)} ms, local ${Math.round(transcript.localMs)} ms). `
                + (transcript.fallbackReason ? `Fallback: ${transcript.fallbackReason}. ` : "")
                + (transcript.status === "empty" ? "No command text was recognized after removing the wake phrase."
                    : `Transcript: ${escapeMarkdown(transcript.text).slice(0, 1_200)}`));
        }
        if (commandWatch) {
            const parsed = await commandWatch.result;
            await reply(`Parser: ${parsed.source}${parsed.model ? ` (${parsed.model})` : ""}, `
                + `${Math.round(parsed.elapsedMs)} ms${parsed.cached ? " (cached)" : ""}. `
                + `Command: **${parsed.command.type}**. `
                + (parsed.command.type === "play" ? `Query: ${escapeMarkdown(parsed.command.query)}. ` : "")
                + (parsed.command.type === "unknown" ? `Reason: ${parsed.reason}. ` : "")
                + (parsed.confidence !== undefined ? `Model confidence: ${parsed.confidence.toFixed(2)} (self-reported). ` : "")
                + (sessions.executionEnabled
                    ? parsed.command.type === "unknown" ? "No music action: the command was not recognized."
                        : "The command is being handled by the music engine; results appear in the voice channel's text chat."
                    : "Phase V6 parsing only; no music action was executed."));
        }
    } catch (error) {
        await reply(error instanceof Error ? error.message : "Command capture testing failed.");
    } finally { watch?.cancel(); transcriptWatch?.cancel(); commandWatch?.cancel(); }
}

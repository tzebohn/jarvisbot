import { AttachmentBuilder, type Message } from "discord.js";
import type { VoiceController } from "../voice/VoiceController.js";
import { pcmToWav } from "../voice/receive/wav.js";
import { replyTo } from "./reply.js";

export async function handleVoiceTest(message: Message, args: string, controller?: VoiceController): Promise<void> {
    const reply = (content: string) => replyTo(message, content);
    if (args && args.toLowerCase() !== "wav") {
        await reply("Usage: `!voicetest` (audio statistics) or `!voicetest wav` (upload your test recording here).");
        return;
    }
    if (!controller) {
        await reply("I'm not connected to voice. Use `!join` first, then `!voicetest`.");
        return;
    }
    const member = await message.guild!.members.fetch(message.author.id);
    if (!member.voice.channel || member.voice.channel.id !== controller.connection.joinConfig.channelId) {
        await reply("Join my voice channel before running a voice test.");
        return;
    }
    let capture: ReturnType<VoiceController["captureNextUtterance"]> | undefined;
    try {
        capture = controller.captureNextUtterance(message.author.id);
        await reply("Ready for your next utterance. Speak within 15 seconds, then stay quiet for one second. "
            + "I'll capture up to 10 seconds from your Discord audio stream. "
            + (args ? "The WAV sample will be uploaded to this text channel." : "I'll report audio statistics only."));
        const utterance = await capture.result;
        await message.reply({
            content: `Voice test received for user ${utterance.userId}: ${(utterance.durationMs / 1_000).toFixed(2)}s, `
                + `${utterance.pcm.length} PCM bytes, 48 kHz stereo, signed 16-bit little-endian.`
                + (utterance.truncated ? " Capture reached its 10-second limit; this sample is truncated." : " Utterance completed.")
                + (utterance.speech ? `\nVAD: ${utterance.speech.speechSegments} speech segment(s), `
                    + `${utterance.speech.voicedMs} ms classified as voice out of ${utterance.speech.processedMs} ms analyzed; `
                    + `${utterance.speech.processingMs.toFixed(2)} ms processing time.` : "")
                + (args ? "" : " Audio discarded after this test."),
            allowedMentions: { parse: [], repliedUser: false },
            files: args ? [new AttachmentBuilder(pcmToWav(utterance.pcm), { name: "voice-test.wav" })] : [],
        });
    } catch (error) {
        await reply(error instanceof Error ? error.message : "The voice test failed. Please try again.");
    } finally {
        capture?.cancel();
    }
}

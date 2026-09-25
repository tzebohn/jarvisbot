import { AttachmentBuilder, type Message } from "discord.js";
import type { VoiceController } from "../voice/VoiceController.js";
import { pcmToWav } from "../voice/receive/wav.js";
import { replyTo } from "./reply.js";
import type { WakeActivation, WakeSummary } from "../voice/wake/WakeWordDetector.js";
import { WAKE_PHRASE } from "../voice/wake/wakeModel.js";

export async function handleWakeTest(message: Message, args: string, controller?: VoiceController): Promise<void> {
    const reply = (content: string) => replyTo(message, content);
    const mode = args.trim().toLowerCase();
    if (mode && !["wav", "sample"].includes(mode)) {
        await reply("Usage: `!waketest`, `!waketest wav` (successful wake pre-roll), or `!waketest sample` (upload one complete attempt, including misses).");
        return;
    }
    if (!controller) { await reply("Use `!join` first, then `!waketest`."); return; }
    const member = await message.guild!.members.fetch(message.author.id);
    if (member.voice.channel?.id !== controller.connection.joinConfig.channelId) {
        await reply("Join my voice channel before testing the wake phrase.");
        return;
    }
    let watch: ReturnType<VoiceController["waitForWake"]> | undefined;
    try {
        if (mode === "sample") {
            await captureWakeSample(message, controller);
            return;
        }
        watch = controller.waitForWake(message.author.id);
        await reply(`Say "${WAKE_PHRASE}" within 30 seconds. This test listens only for your activation. `
            + (args ? "The preserved audio will be uploaded to this channel." : "I'll report the detection without uploading audio."));
        const event = await watch.result;
        await message.reply({
            content: `Detected **${event.phrase}** for user ${event.userId} in guild ${event.guildId}. `
                + `Preserved ${(event.preRoll.length / 192_000).toFixed(2)}s of your recent audio. `
                + "The keyword engine does not expose a per-detection confidence score.",
            allowedMentions: { parse: [], repliedUser: false },
            files: args ? [new AttachmentBuilder(pcmToWav(event.preRoll), { name: "wake-test.wav" })] : [],
        });
    } catch (error) {
        await reply(error instanceof Error ? error.message : "Wake testing failed.");
    } finally { watch?.cancel(); }
}

/** Explicit raw diagnostic. Normal wake events can also activate the session pipeline. */
async function captureWakeSample(message: Message, controller: VoiceController): Promise<void> {
    if (controller.wakeState !== "listening") throw new Error("Wake detection is unavailable or paused. Join voice and check the wake configuration.");
    let capture: ReturnType<VoiceController["captureNextUtterance"]> | undefined;
    const accepted = new Map<string, number>();
    const onWake = (event: WakeActivation) => {
        if (event.userId === message.author.id && (accepted.has(event.streamId) || accepted.size < 8)) {
            accepted.set(event.streamId, (accepted.get(event.streamId) ?? 0) + 1);
        }
    };
    controller.on("wake", onWake);
    try {
        capture = controller.captureNextUtterance(message.author.id);
        await replyTo(message, `Say one test sentence, then stop speaking. Try "${WAKE_PHRASE} play Numb by Linkin Park". `
            + "Your next utterance (up to 10 seconds) and diagnostic JSON will be uploaded here even if no wake is detected.");
        const clip = await capture.result;
        let summary: WakeSummary | undefined;
        // A truncated capture can end while the live detector continues; never flush/cancel that detector for a test.
        if (!clip.truncated && clip.wakeResult) {
            let timer: NodeJS.Timeout | undefined;
            try {
                summary = await Promise.race([clip.wakeResult, new Promise<undefined>((resolve) => {
                    timer = setTimeout(() => resolve(undefined), 6_000);
                    timer.unref();
                })]);
            } finally { if (timer) clearTimeout(timer); }
        }
        const acceptedWakeEvents = accepted.get(clip.streamId) ?? 0;
        const report = { version: 1, guildId: clip.guildId, userId: clip.userId, streamId: clip.streamId,
            format: clip.format, durationMs: clip.durationMs, truncated: clip.truncated, speech: clip.speech,
            acceptedWakeEvents, summary: summary ?? null,
            resultComplete: summary?.reason === "stream-end",
            note: "Keyword spotting only: no transcript or per-wake confidence is available. This recording is diagnostic, not a command capture." };
        await message.reply({
            content: `${acceptedWakeEvents ? "Wake activation detected" : "No accepted wake activation"} in this sample. `
                + `Captured ${(clip.durationMs / 1_000).toFixed(2)}s. `
                + (summary ? `Keyword result: ${summary.outcome}; ${summary.detections} native keyword result(s), ${acceptedWakeEvents} accepted activation(s). ` : "Final keyword result unavailable. ")
                + (clip.truncated ? "Capture truncated at the diagnostic limit; use a shorter sentence. " : "")
                + "Save both attachments and replay the WAV with diagnose:wake --phonemes --compare-vad.",
            allowedMentions: { parse: [], repliedUser: false },
            files: [new AttachmentBuilder(pcmToWav(clip.pcm), { name: "wake-attempt.wav" }),
                new AttachmentBuilder(Buffer.from(JSON.stringify(report, null, 2)), { name: "wake-attempt.json" })],
        });
    } finally {
        capture?.cancel();
        controller.off("wake", onWake);
    }
}

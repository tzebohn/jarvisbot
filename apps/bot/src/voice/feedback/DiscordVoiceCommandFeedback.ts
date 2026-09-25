import { escapeMarkdown, type Client, type Message, type SendableChannels } from "discord.js";
import { trackLabel } from "../../commands/formatTrack.js";
import { isTerminalFeedback, type VoiceCommandFeedback, type VoiceCommandUpdate, type VoiceFailure,
    type VoiceFeedbackEvent, type VoiceFeedbackIdentity } from "./VoiceCommandFeedback.js";

const failures: Record<VoiceFailure, string> = {
    "no-command": "🎙️ I heard Jarvis, but didn't catch a command. Say ‘Jarvis, play [song] by [artist]’.",
    "empty-transcript": "🎙️ I couldn't make out any words. Please say Jarvis and try again.",
    "stt-failed": "⚠️ I couldn't transcribe your command. Please try again shortly.",
    "unknown-command": "❓ I didn't understand that command. Try ‘Jarvis, play [song] by [artist]’.",
    "unsupported-command": "❓ That voice command isn't supported. Try play, pause, resume, skip, queue, stop, or leave.",
    "truncated": "🎙️ That command was too long. Please say Jarvis and try a shorter request.",
    "timeout": "⌛ Your command took too long. Please say Jarvis and try again.",
    "cancelled": "✋ Voice command cancelled. Say Jarvis when you're ready to try again.",
    "contention": "🎙️ I heard multiple people say Jarvis together. Please try again one at a time.",
    "capture-failed": "⚠️ I lost your command audio. Check your voice connection and try again.",
    "processing-failed": "⚠️ I couldn't complete that voice command. Please try again.",
    "no-results": "🔎 I couldn't find a suitable track. Try again with the song and artist.",
    "search-failed": "⚠️ I couldn't search for music right now. Please try again shortly.",
    "playback-failed": "⚠️ Music playback failed. Please try the song again or choose another track.",
    "music-unavailable": "⚠️ Music playback is unavailable right now. Please try again later.",
    "voice-access": "🎙️ Join my voice channel before using voice music commands.",
};

function render(update: VoiceCommandUpdate): string {
    switch (update.state) {
        case "listening": return "🎙️ Listening...";
        case "processing": return "⏳ Processing your command...";
        case "searching": return `🔎 Searching for **${escapeMarkdown(update.query.slice(0, 500))}**...`;
        case "playing": return `▶️ Playing **${trackLabel(update.track)}**`;
        case "queued": return `➕ Queued **${trackLabel(update.track)}**`;
        case "failed": return failures[update.reason];
        case "completed": return "captureOnly" in update ? "✅ Command captured. Voice transcription is currently disabled."
            : update.content ?? "✅ Command completed.";
    }
}

interface StatusMessage {
    identity: VoiceFeedbackIdentity;
    channel: SendableChannels;
    message?: Message;
    pending?: string;
    last?: string;
    writing: boolean;
    disabled: boolean;
    replaced: boolean;
}

/** One editable message per activated session. Discord I/O never holds the owner lock. */
export class DiscordVoiceCommandFeedback implements VoiceCommandFeedback {
    private readonly sessions = new Map<string, StatusMessage>();

    constructor(private readonly client: Pick<Client, "guilds">, private readonly timeoutMs = 5_000) {}

    readonly update = (event: VoiceFeedbackEvent): void => {
        const key = `${event.guildId}/${event.sessionId}`;
        let status = this.sessions.get(key);
        if (!status) {
            // Only session activation may open a message; late results cannot resurrect it.
            if (event.update.state !== "listening") return;
            const channel = this.channel(event);
            if (!channel) return;
            status = { identity: { guildId: event.guildId, userId: event.userId, sessionId: event.sessionId,
                voiceChannelId: event.voiceChannelId }, channel, writing: false, disabled: false, replaced: false };
            this.sessions.set(key, status);
        }
        // The drain owns its bounded final write; no completed session stays in this map.
        if (isTerminalFeedback(event.update)) this.sessions.delete(key);
        if (status.disabled) return;
        const content = render(event.update).slice(0, 2_000);
        if (content === (status.pending ?? status.last)) return;
        status.pending = content;
        if (!status.writing) void this.drain(status);
    };

    playbackFailed(event: VoiceFeedbackIdentity): void {
        const channel = this.channel(event);
        if (!channel) return;
        // A later player failure is a new notification, never an edit of a newer session.
        void this.write(() => channel.send({ content: failures["playback-failed"] + " The queue was cleared.",
            allowedMentions: { parse: [] } })).catch((error) => this.log(event, error));
    }

    private channel(event: VoiceFeedbackIdentity): SendableChannels | undefined {
        const channel = event.voiceChannelId ? this.client.guilds.cache.get(event.guildId)?.channels.cache.get(event.voiceChannelId) : undefined;
        if (channel?.isSendable()) return channel;
        console.error("Voice command feedback channel is unavailable.", event);
        return undefined;
    }

    private async drain(status: StatusMessage): Promise<void> {
        status.writing = true;
        try {
            while (status.pending !== undefined) {
                const content = status.pending;
                status.pending = undefined;
                const payload = { content, allowedMentions: { parse: [] as const } };
                try {
                    status.message = await this.write(() => status.message ? status.message.edit(payload) : status.channel.send(payload));
                } catch (error) {
                    // Recover once from a deleted message, but don't retry permissions/network failures.
                    if (!status.message || status.replaced || !error || typeof error !== "object" || !("code" in error) || error.code !== 10008) throw error;
                    status.replaced = true;
                    const replacementContent = status.pending ?? content;
                    status.pending = undefined;
                    status.message = await this.write(() => status.channel.send({ ...payload, content: replacementContent }));
                }
                status.last = status.message.content;
            }
        } catch (error) {
            status.disabled = true;
            status.pending = undefined;
            this.log(status.identity, error);
        } finally { status.writing = false; }
    }

    private async write(operation: () => Promise<Message>): Promise<Message> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Discord voice feedback timed out.")), this.timeoutMs);
                timer.unref();
            })]);
        } finally { clearTimeout(timer); }
    }

    private log(event: VoiceFeedbackIdentity, error: unknown): void {
        console.error("Could not update voice command feedback.", event, error);
    }
}

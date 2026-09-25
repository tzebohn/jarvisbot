import type { MusicCommand } from "@discord-music-platform/shared";
import type { Client } from "discord.js";
import { handleMusicControl } from "../../commands/controls.js";
import { handlePlay } from "../../commands/play.js";
import { MusicCommandAccessError, requireMusicMember, type MusicCommandContext } from "../../commands/MusicCommandContext.js";
import type { GuildMusicPlayers } from "../../music/GuildMusicPlayers.js";
import type { MusicService } from "../../music/MusicService.js";
import type { ParsedSessionCommand } from "../sessions/GuildVoiceSessions.js";
import type { VoiceReceiveManager } from "../VoiceReceiveManager.js";
import type { ReportVoiceFeedback, VoiceCommandFeedback } from "../feedback/VoiceCommandFeedback.js";

function isMusicCommand(value: unknown): value is MusicCommand {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const command = value as Record<string, unknown>;
    if (!Object.hasOwn(command, "type") || typeof command.type !== "string") return false;
    if (command.type === "play") return Object.keys(command).length === 2 && Object.hasOwn(command, "query") && typeof command.query === "string"
        && command.query.trim().length > 0 && command.query.length <= 500;
    return Object.keys(command).length === 1 && ["pause", "resume", "skip", "queue", "stop", "leave"].includes(command.type);
}

/** Adapter only: the same handlers, resolver and guild player power prefix and voice commands. */
export class VoiceMusicCommands {
    constructor(private readonly client: Pick<Client, "guilds">, private readonly players: GuildMusicPlayers,
        private readonly receivers: VoiceReceiveManager, private readonly music?: MusicService,
        private readonly feedback?: VoiceCommandFeedback) {}

    async execute(event: ParsedSessionCommand, signal: AbortSignal, report: ReportVoiceFeedback = () => {}): Promise<void> {
        signal.throwIfAborted();
        if (!isMusicCommand(event.command)) { report({ state: "failed", reason: "unsupported-command" }); return; }
        if (!event.voiceChannelId) { report({ state: "failed", reason: "cancelled" }); return; }
        const command = event.command;
        const guild = this.client.guilds.cache.get(event.guildId);
        const player = this.players.get(event.guildId);
        const connection = this.players.getConnection(event.guildId);
        if (!guild || !player || !connection) { report({ state: "failed", reason: "cancelled" }); return; }
        const assertCurrent = () => {
            signal.throwIfAborted();
            if (this.players.get(event.guildId) !== player || player.isDestroyed
                || this.players.getConnection(event.guildId) !== connection
                || this.receivers.get(event.guildId)?.connection !== connection
                || player.voiceChannelId !== event.voiceChannelId) {
                throw new DOMException("The voice command's connection was replaced or closed.", "AbortError");
            }
        };
        // Session outcomes use the same status sink as capture/STT. Late player errors
        // have their own notification, fixed to the original activation channel.
        const context: MusicCommandContext = { guild, userId: event.userId, signal, assertCurrent,
            requireVoiceForRead: true, feedback: report,
            playbackFailed: () => this.feedback?.playbackFailed(event),
            notify: async () => { this.feedback?.playbackFailed(event); },
            reply: async (content) => { assertCurrent(); report({ state: "completed", content }); } };
        try {
            assertCurrent();
            // No synthetic prefix message, dynamic function lookup, or transcript execution.
            if (command.type === "leave") {
                await requireMusicMember(context, player, "Join my voice channel before using voice music commands.");
                assertCurrent();
                // Removal synchronously aborts this session through connection cleanup. Publish
                // terminal success first so that cleanup cannot replace it with cancellation.
                report({ state: "completed", content: "Left the voice channel." });
                this.players.remove(event.guildId, player);
            } else if (command.type === "play") await handlePlay(context, command.query, player, this.music, player.requestVersion);
            else await handleMusicControl(context, command.type, "", player);
        } catch (error) {
            if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
                report({ state: "failed", reason: "cancelled" });
                return;
            }
            if (error instanceof MusicCommandAccessError) {
                report({ state: "failed", reason: "voice-access" });
                return;
            }
            console.error("Voice music command failed.", { guildId: event.guildId, userId: event.userId,
                sessionId: event.sessionId, type: command.type }, error);
            report({ state: "failed", reason: "processing-failed" });
        }
    }
}

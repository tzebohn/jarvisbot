import { VoiceConnectionStatus, entersState, joinVoiceChannel, type VoiceConnection } from "@discordjs/voice";
import type { Guild, VoiceBasedChannel } from "discord.js";
import type { VoiceReceiveManager } from "../voice/VoiceReceiveManager.js";
import { MusicPlayer } from "./MusicPlayer.js";

/** Shared ownership for every input method: exactly one connection/player per guild. */
export class GuildMusicPlayers {
    private readonly entries = new Map<string, { player: MusicPlayer; connection: VoiceConnection; ready: Promise<unknown> }>();

    constructor(private readonly voiceReceivers: VoiceReceiveManager, private readonly audioCues = false) {}

    get(guildId: string): MusicPlayer | undefined { return this.entries.get(guildId)?.player; }
    getConnection(guildId: string): VoiceConnection | undefined { return this.entries.get(guildId)?.connection; }

    remove(guildId: string, player: MusicPlayer): void {
        // A late failure from an older join must not remove a newer connection.
        if (this.entries.get(guildId)?.player === player) this.entries.delete(guildId);
        player.destroy();
    }

    async join(guild: Guild, channel: VoiceBasedChannel): Promise<{ player: MusicPlayer; requestVersion: number }> {
        const startedAt = Date.now();
        const context = () => ({ guildId: guild.id, channelId: channel.id, elapsedMs: Date.now() - startedAt });
        // Diagnostics only: do not turn an unavailable cache entry into a permission denial.
        try {
            const member = guild.members.me;
            const permissions = member ? channel.permissionsFor(member) : null;
            console.log("[voice-permissions]", { ...context(), botMemberCached: !!member,
                viewChannel: permissions?.has("ViewChannel") ?? null,
                connect: permissions?.has("Connect") ?? null,
                speak: permissions?.has("Speak") ?? null,
                joinable: channel.joinable ?? null, speakable: channel.speakable ?? null, full: channel.full ?? null });
        } catch (error) { console.error("[voice-permissions] inspection failed", context(), error); }
        let entry = this.entries.get(guild.id);
        if (entry && entry.player.voiceChannelId !== channel.id) {
            this.remove(guild.id, entry.player);
            entry = undefined;
        }
        if (!entry) {
            const connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator, selfDeaf: false });
            console.log("[voice-connection] created", { ...context(), status: connection.state.status,
                selfDeaf: connection.joinConfig.selfDeaf });
            connection.on("stateChange", (oldState, newState) => {
                console.log(`[voice-connection] ${oldState.status} -> ${newState.status}`, { ...context(),
                    ...(newState.status === VoiceConnectionStatus.Disconnected ? { reason: newState.reason,
                        closeCode: "closeCode" in newState ? newState.closeCode : undefined } : {}) });
            });
            connection.on("error", (error) => console.error("[voice-connection] error", context(), error));
            let player: MusicPlayer;
            let phase = "create-player";
            try {
                player = new MusicPlayer(connection, this.audioCues);
                phase = "attach-receiver";
                this.voiceReceivers.attach(connection);
                console.log("[voice-join] receiver/session initialization complete", { ...context(), status: connection.state.status });
            } catch (error) {
                console.error("[voice-join] initialization failed", { ...context(), phase, status: connection.state.status }, error);
                connection.destroy();
                throw error;
            }
            // Publish ownership before awaiting: simultaneous play/join requests reuse it.
            entry = { player, connection, ready: entersState(connection, VoiceConnectionStatus.Ready, 10_000) };
            this.entries.set(guild.id, entry);
            connection.once(VoiceConnectionStatus.Destroyed, () => {
                if (this.entries.get(guild.id)?.player === player) this.entries.delete(guild.id);
            });
        }
        const requestVersion = entry.player.requestVersion;
        try {
            console.log("[voice-join] waiting for ready", { ...context(), status: entry.connection.state.status });
            await entry.ready;
            if (!entry.player.isDestroyed && !entry.player.isVoiceReady) {
                await entersState(entry.connection, VoiceConnectionStatus.Ready, 10_000);
            }
            if (this.entries.get(guild.id) !== entry || entry.player.isDestroyed) {
                throw new Error("The voice connection was replaced or closed.");
            }
            console.log("[voice-join] ready", { ...context(), status: entry.connection.state.status });
            return { player: entry.player, requestVersion };
        } catch (error) {
            // Log before cleanup changes the status to Destroyed, preserving the failure point.
            console.error("[voice-join] readiness failed", { ...context(), status: entry.connection.state.status }, error);
            this.remove(guild.id, entry.player);
            throw error;
        }
    }

    destroy(): void {
        for (const { player } of this.entries.values()) player.destroy();
        this.entries.clear();
    }
}

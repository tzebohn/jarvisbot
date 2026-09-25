import { VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";
import type { VoiceState } from "discord.js";
import { VoiceController } from "./VoiceController.js";
import type { VoiceFrameDetectorFactory } from "./processing/WebRtcVad.js";
import { EventEmitter } from "node:events";
import type { WakeBackendFactory } from "./wake/WakeBackend.js";
import type { WakeActivation } from "./wake/WakeWordDetector.js";
import { GuildVoiceSessions, type CommandTranscript, type ParsedSessionCommand, type SessionEnd, type VoiceSessionOptions } from "./sessions/GuildVoiceSessions.js";
import type { VoiceFeedbackEvent } from "./feedback/VoiceCommandFeedback.js";

/** Shares existing connections; never creates a voice connection or music player. */
export class VoiceReceiveManager extends EventEmitter<{
    wake: [WakeActivation]; sessionEnd: [SessionEnd]; transcript: [CommandTranscript]; command: [ParsedSessionCommand];
    feedback: [VoiceFeedbackEvent];
}> {
    private readonly controllers = new Map<string, VoiceController>();
    private readonly sessions = new Map<string, GuildVoiceSessions>();

    constructor(private readonly debug = false, private readonly createVad?: VoiceFrameDetectorFactory,
        private readonly createWake?: WakeBackendFactory, private readonly wakeDebug = false,
        private readonly sessionOptions: VoiceSessionOptions | false = {}) { super(); }

    attach(connection: VoiceConnection): VoiceController {
        const guildId = connection.joinConfig.guildId;
        const existing = this.controllers.get(guildId);
        if (existing?.connection === connection && !existing.isDestroyed) return existing;
        existing?.destroy();
        this.sessions.get(guildId)?.destroy();
        this.sessions.delete(guildId);
        const controller = new VoiceController(connection, this.debug, this.createVad, this.createWake, this.wakeDebug);
        if (this.sessionOptions !== false) {
            const sessions = new GuildVoiceSessions(controller, this.sessionOptions);
            sessions.on("end", (event) => this.emit("sessionEnd", event));
            sessions.on("transcript", (event) => this.emit("transcript", event));
            sessions.on("command", (event) => this.emit("command", event));
            sessions.on("feedback", (event) => this.emit("feedback", event));
            this.sessions.set(guildId, sessions);
        }
        controller.on("wake", (event) => this.emit("wake", event));
        this.controllers.set(guildId, controller);
        connection.once(VoiceConnectionStatus.Destroyed, () => {
            controller.destroy();
            if (this.controllers.get(guildId) === controller) {
                this.controllers.delete(guildId);
                this.sessions.get(guildId)?.destroy();
                this.sessions.delete(guildId);
            }
        });
        return controller;
    }

    get(guildId: string): VoiceController | undefined {
        const controller = this.controllers.get(guildId);
        return controller?.isDestroyed ? undefined : controller;
    }

    getSessions(guildId: string): GuildVoiceSessions | undefined {
        return this.get(guildId) ? this.sessions.get(guildId) : undefined;
    }

    destroy(): void {
        for (const controller of this.controllers.values()) controller.destroy();
        for (const sessions of this.sessions.values()) sessions.destroy();
        this.controllers.clear();
        this.sessions.clear();
    }

    readonly handleVoiceStateUpdate = (oldState: VoiceState, newState: VoiceState): void => {
        const controller = this.get(newState.guild.id);
        if (!controller) return;
        if (newState.id === newState.client.user?.id) {
            if (oldState.channelId !== newState.channelId || newState.deaf) {
                controller.reset("The bot moved, disconnected, or was deafened. Start a new voice test after reconnecting.");
            }
        } else if (oldState.channelId !== newState.channelId) {
            // Also cancels a pending test for a user who leaves before sending any audio/SSRC.
            controller.stopUser(newState.id);
        }
    };
}

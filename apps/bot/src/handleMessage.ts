import { escapeMarkdown, type Message } from "discord.js";
import { GuildMusicPlayers } from "./music/GuildMusicPlayers.js";
import { messageMusicContext } from "./commands/MusicCommandContext.js";
import { createTestAudioResource } from "./music/testAudio.js";
import type { MusicService } from "./music/MusicService.js";
import { handlePlay } from "./commands/play.js";
import { replyTo } from "./commands/reply.js";
import { handleMusicControl, musicControlCommands } from "./commands/controls.js";
import { VoiceReceiveManager } from "./voice/VoiceReceiveManager.js";
import { handleVoiceTest } from "./commands/voicetest.js";
import { handleWakeTest } from "./commands/waketest.js";
import { handleCommandTest } from "./commands/commandtest.js";

export function createMessageHandler(music?: MusicService, voiceReceivers = new VoiceReceiveManager(),
    musicPlayers = new GuildMusicPlayers(voiceReceivers)) {
    return async (message: Message): Promise<void> => {
        if (message.author.bot || message.webhookId || !message.content.startsWith("!")) {
            return;
        }
        const match = /^!(\S+)(?:\s+([\s\S]*))?$/.exec(message.content);
        if (!match) {
            return;
        }
        const command = match[1].toLowerCase();
        const args = (match[2] ?? "").trim();
        const reply = (content: string) => replyTo(message, content);

        try {
            if (command === "ping") {
                await reply("Pong!");
                return;
            }

            if (!["join", "leave", "pluh", "playtest", "play", "voicetest", "waketest", "commandtest", ...musicControlCommands].includes(command)) {
                return;
            }

            const guild = message.guild;
            if (!guild) {
                await reply("This command can only be used inside a server.");
                return;
            }

            if (command === "voicetest") {
                await handleVoiceTest(message, args, voiceReceivers.get(guild.id));
                return;
            }

            if (command === "waketest") {
                await handleWakeTest(message, args, voiceReceivers.get(guild.id));
                return;
            }

            if (command === "commandtest") {
                await handleCommandTest(message, args, voiceReceivers);
                return;
            }

            if (command === "play" && (!args || args.length > 500)) {
                await reply("Usage: `!play <song name or YouTube video URL>` (1–500 characters).");
                return;
            }

            if (command === "join" || command === "play") {
                if (command === "play" && !music) {
                    await reply("YouTube playback is not configured. Set YOUTUBE_API_KEY and restart the bot.");
                    return;
                }
                const member = await guild.members.fetch(message.author.id);
                const voiceChannel = member.voice.channel;
                if (!voiceChannel) {
                    await reply("You need to be in a voice channel first.");
                    return;
                }

                const existingPlayer = musicPlayers.get(guild.id);
                if (command === "play" && existingPlayer && existingPlayer.voiceChannelId !== voiceChannel.id) {
                    await reply("Join my voice channel before requesting music.");
                    return;
                }

                let joined: Awaited<ReturnType<GuildMusicPlayers["join"]>>;
                try {
                    joined = await musicPlayers.join(guild, voiceChannel);
                } catch (error) {
                    console.error("[voice] Failed to join voice channel:", error);
                    await reply("I couldn't connect to the voice channel. Check my View Channel, Connect, and Speak permissions, then try again.");
                    return;
                }

                if (command === "play") {
                    await handlePlay(messageMusicContext(message), args, joined.player, music, joined.requestVersion);
                } else {
                    await reply(`Joined **${escapeMarkdown(voiceChannel.name)}**.`);
                }
                return;
            }

            const player = musicPlayers.get(guild.id);
            if (musicControlCommands.includes(command)) {
                await handleMusicControl(messageMusicContext(message), command, args, player);
                return;
            }
            if (command === "leave") {
                if (!player) {
                    await reply("I'm not currently in a voice channel.");
                    return;
                }
                musicPlayers.remove(guild.id, player);
                await reply("Left the voice channel.");
                return;
            }

            if (!player) {
                await reply("I'm not connected to a voice channel. Use `!join` first.");
                return;
            }

            let started = false;
            try {
                // !playtest remains a restartable diagnostic, not a queue command.
                player.stop();
                await player.play({
                    createResource: createTestAudioResource,
                    onError: () => {
                        if (started) {
                            void reply("Test audio playback failed.").catch(() => {
                                console.error("Could not report the test audio failure to Discord.");
                            });
                        }
                    },
                });
                started = true;
            } catch {
                await reply("I couldn't play the test audio. Check the local audio file and voice connection.");
                return;
            }

            await reply("Playing test audio.");
        } catch {
            console.error(`Command !${command} failed.`);
            try {
                await reply("I couldn't complete that command. Please try again.");
            } catch {
                console.error("Could not report the command failure to Discord.");
            }
        }
    };
}

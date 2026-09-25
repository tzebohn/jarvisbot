import type { Guild, Message } from "discord.js";
import type { MusicPlayer } from "../music/MusicPlayer.js";
import { abortable } from "../music/abortable.js";
import { replyTo } from "./reply.js";
import type { MusicCommandUpdate } from "../music/MusicCommandFeedback.js";

/** Input adapter: shared handlers never need to fabricate a Discord Message for voice. */
export interface MusicCommandContext {
    guild: Guild;
    userId: string;
    reply: (content: string) => Promise<unknown>;
    /** Playback notifications outlive the request/session that queued the track. */
    notify: (content: string) => Promise<unknown>;
    signal?: AbortSignal;
    assertCurrent?: () => void;
    requireVoiceForRead?: boolean;
    /** Optional structured status sink; input adapters choose how to display it. */
    feedback?: (update: MusicCommandUpdate) => void;
    playbackFailed?: () => void;
}

export class MusicCommandAccessError extends Error {}

export function assertCommandCurrent(context: MusicCommandContext): void {
    context.signal?.throwIfAborted();
    context.assertCurrent?.();
}

export async function requireMusicMember(context: MusicCommandContext, player: MusicPlayer, message: string): Promise<void> {
    assertCommandCurrent(context);
    const member = await abortable(context.guild.members.fetch(context.userId), context.signal);
    assertCommandCurrent(context);
    if (member.user?.bot || !member.voice.channel || member.voice.channel.id !== player.voiceChannelId) {
        throw new MusicCommandAccessError(message);
    }
}

export function messageMusicContext(message: Message): MusicCommandContext {
    return { guild: message.guild!, userId: message.author.id, reply: (content) => replyTo(message, content),
        notify: async (content) => {
            if (message.channel.isSendable()) await message.channel.send({ content, allowedMentions: { parse: [] } });
        } };
}

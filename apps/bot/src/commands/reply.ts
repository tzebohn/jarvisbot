import type { Message } from "discord.js";

export function replyTo(message: Message, content: string) {
    return message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
}

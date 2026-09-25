import { mock } from "node:test";
import "./voice.mjs";

const { createMessageHandler } = await import("../../src/handleMessage.ts");
const { MusicService } = await import("../../src/music/MusicService.ts");

export function message(text, guildId = "guild-a", voiceChannelId = "voice-a") {
    return {
        content: text,
        guildId,
        guild: {
            id: guildId,
            voiceAdapterCreator: () => {},
            members: { fetch: mock.fn(async () => ({ voice: {
                channel: voiceChannelId ? { id: voiceChannelId, name: "Music" } : null,
            } })) },
        },
        author: { id: "user-a", bot: false },
        webhookId: null,
        channel: { isSendable: () => true, send: mock.fn(async () => {}) },
        reply: mock.fn(async () => {}),
    };
}

export function content(request, index = 0) {
    return request.reply.mock.calls[index]?.arguments[0].content;
}

export function music() {
    const track = { id: "abcdefghijk", title: "Numb", artist: "Linkin Park", source: "youtube",
        url: "https://www.youtube.com/watch?v=abcdefghijk", duration: 187 };
    const provider = {
        source: "youtube",
        search: mock.fn(async () => [{ track, confidence: 1, provider: "youtube" }]),
        getAudio: mock.fn(async () => ({ playStream: { destroy: mock.fn() } })),
    };
    return { track, provider, handle: createMessageHandler(new MusicService(provider)) };
}

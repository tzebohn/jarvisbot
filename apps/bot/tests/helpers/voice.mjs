import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock } from "node:test";
import * as voice from "@discordjs/voice";

export { voice };
const { AudioPlayerStatus, VoiceConnectionStatus } = voice;

class StateEmitter extends EventEmitter {
    setStatus(status, resource = this.state?.resource) {
        const oldState = this.state;
        this.state = { status };
        if (resource && status !== AudioPlayerStatus.Idle) {
            this.state.resource = resource;
        }
        this.emit("stateChange", oldState, this.state);
        this.emit(status, oldState, this.state);
    }
}

export class FakeConnection extends StateEmitter {
    state = { status: VoiceConnectionStatus.Ready };
    joinConfig = { channelId: "voice-a", guildId: "guild-a" };
    receiver = new voice.VoiceReceiver(this);
    subscriptions = [];
    destroy = mock.fn(() => {
        assert.notEqual(this.state.status, VoiceConnectionStatus.Destroyed, "must not destroy twice");
        this.setStatus(VoiceConnectionStatus.Destroyed);
    });
    subscribe = mock.fn((player) => {
        const subscription = { player, unsubscribe: mock.fn() };
        this.subscriptions.push(subscription);
        return subscription;
    });
}

export class FakePlayer extends StateEmitter {
    state = { status: AudioPlayerStatus.Idle };
    play = mock.fn((resource) => this.setStatus(AudioPlayerStatus.Playing, resource));
    stop = mock.fn((force) => {
        assert.equal(force, true, "cleanup must immediately release the audio resource");
        if (this.state.status !== AudioPlayerStatus.Idle) {
            this.setStatus(AudioPlayerStatus.Idle);
        }
        return true;
    });
    pause = mock.fn(() => {
        if (this.state.status !== AudioPlayerStatus.Playing) {
            return false;
        }
        this.setStatus(AudioPlayerStatus.Paused);
        return true;
    });
    unpause = mock.fn(() => {
        if (this.state.status !== AudioPlayerStatus.Paused) {
            return false;
        }
        this.setStatus(AudioPlayerStatus.Playing);
        return true;
    });
}

export const connections = [];
export const players = [];
export const joinVoiceChannel = mock.fn();
export const createAudioPlayer = mock.fn();
export const createAudioResource = mock.fn();
export const entersState = mock.fn();

mock.module("@discordjs/voice", {
    namedExports: { ...voice, joinVoiceChannel, createAudioPlayer, createAudioResource, entersState },
});

export function resetVoiceMocks(context) {
    context.mock.method(console, "error", () => {});
    connections.length = 0;
    players.length = 0;
    for (const fn of [joinVoiceChannel, createAudioPlayer, createAudioResource, entersState]) {
        fn.mock.resetCalls();
    }
    joinVoiceChannel.mock.mockImplementation((config) => {
        const connection = new FakeConnection();
        connection.joinConfig = { ...config };
        connections.push(connection);
        return connection;
    });
    createAudioPlayer.mock.mockImplementation(() => {
        const player = new FakePlayer();
        players.push(player);
        return player;
    });
    createAudioResource.mock.mockImplementation(() => ({ playStream: { destroy: mock.fn() } }));
    // Exercise the library's real readiness/event waiting, without a Discord gateway.
    entersState.mock.mockImplementation(voice.entersState);
}

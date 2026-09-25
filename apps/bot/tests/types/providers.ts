// Compile-time contract tests, checked by `pnpm --filter bot typecheck`.
// This file is not executed or included in the production build.
import type { Track, TrackCandidate } from "@discord-music-platform/shared";
import type { AudioResource } from "@discordjs/voice";
import {
    isPlaybackProvider,
    normalizeCandidate,
    type MusicProvider,
    type PlaybackProvider,
} from "../../src/music/providers/index.js";
import { createTestAudioResource } from "../../src/music/testAudio.js";

const candidate: TrackCandidate = normalizeCandidate("spotify", {
    id: "test", title: "Test", artist: "Artist", url: "https://example.com/test",
});
const track: Track = candidate.track;

const metadataOnly: MusicProvider = {
    source: "spotify",
    async search(_query: string) { return [candidate]; },
};

const playback: PlaybackProvider = {
    source: "youtube",
    async search(_query: string) { return []; },
    async getAudio(_track: Track) { return createTestAudioResource(); },
};

const searchProvider: MusicProvider = playback;
const audio: Promise<AudioResource> = playback.getAudio(track);
const results: Promise<TrackCandidate[]> = metadataOnly.search("test");

if (isPlaybackProvider(searchProvider)) {
    const narrowedAudio: Promise<AudioResource> = searchProvider.getAudio(track);
}

// @ts-expect-error Search alone must not imply audio playback support.
const missingPlayback: PlaybackProvider = metadataOnly;

// @ts-expect-error A metadata-only provider has no audio method.
metadataOnly.getAudio(track);

// @ts-expect-error Provider identity is stable after construction.
metadataOnly.source = "youtube";

const unknownSource: MusicProvider = {
    // @ts-expect-error The architecture's MusicSource union stays intact.
    source: "local",
    async search() { return []; },
};

const rawTracks: MusicProvider = {
    source: "youtube",
    // @ts-expect-error Search must produce candidates, not bare tracks.
    async search() { return [track]; },
};

const synchronousSearch: MusicProvider = {
    source: "youtube",
    // @ts-expect-error The search contract is asynchronous.
    search() { return [candidate]; },
};

const urlOnlyPlayback: PlaybackProvider = {
    source: "youtube",
    async search() { return []; },
    // @ts-expect-error A discovery URL is not a playable AudioResource.
    async getAudio() { return track.url; },
};

const synchronousPlayback: PlaybackProvider = {
    source: "youtube",
    async search() { return []; },
    // @ts-expect-error The playback-provider contract is asynchronous too.
    getAudio() { return createTestAudioResource(); },
};

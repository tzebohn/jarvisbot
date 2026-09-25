import type { Track } from "@discord-music-platform/shared";
import {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    VoiceConnectionStatus,
    createAudioPlayer,
    entersState,
    type AudioPlayerError,
    type AudioPlayerState,
    type AudioResource,
    type PlayerSubscription,
    type VoiceConnection,
    type VoiceConnectionState,
} from "@discordjs/voice";
import { MusicQueue } from "./Queue.js";
import { logPlaybackError, playbackDebug } from "./playbackDiagnostics.js";
import { AudioCueResource, type AudioCueRequest } from "./AudioCueResource.js";

// Bot-local playback input, not a discovery/provider interface. The local test
// clip has no discovered Track; shared MusicSource stays exactly as documented.
export interface PlaybackItem {
    track?: Track;
    requestedBy?: { guildId: string; userId: string };
    createResource: (signal: AbortSignal) => AudioResource | Promise<AudioResource>;
    onError?: (error: Error) => void;
}

export type LoopMode = "off" | "song" | "queue";

interface ActivePlayback {
    item: PlaybackItem;
    abort: AbortController;
    started: boolean;
    resource?: AudioResource;
    output?: AudioResource;
    subscription?: PlayerSubscription;
    error?: Error;
}

export class MusicPlayer {
    private readonly audioPlayer = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
    });
    private readonly musicQueue = new MusicQueue<PlaybackItem>();
    private active?: ActivePlayback;
    private destroyed = false;
    private requestGeneration = 0;
    private looping: LoopMode = "off";
    private standaloneCue?: { resource: AudioCueResource; subscription: PlayerSubscription };

    constructor(private readonly connection: VoiceConnection, private readonly audioCues = false) {
        this.audioPlayer.on(AudioPlayerStatus.Idle, this.onIdle);
        this.audioPlayer.on("error", this.onAudioError);
        this.audioPlayer.on("stateChange", this.onAudioStateChange);
        connection.once(VoiceConnectionStatus.Destroyed, this.onConnectionDestroyed);
        connection.on("error", this.onConnectionError);
        connection.on("stateChange", this.onConnectionStateChange);
    }

    get current(): PlaybackItem | undefined {
        return this.active?.item;
    }

    get currentTrack(): Track | undefined {
        return this.current?.track;
    }

    // Only pending items; the current item is kept separately. Callers get a snapshot.
    get queue(): readonly PlaybackItem[] {
        return this.musicQueue.all;
    }

    get isDestroyed() {
        return this.destroyed;
    }

    // Invalidate discovery requests as well as active extraction when stopped.
    get requestVersion(): number {
        return this.requestGeneration;
    }

    get loopMode(): LoopMode {
        return this.looping;
    }

    setLoopMode(mode: LoopMode): boolean {
        if (this.destroyed) return false;
        this.looping = mode;
        return true;
    }

    get voiceChannelId(): string | null {
        return this.connection.joinConfig.channelId;
    }

    get isVoiceReady(): boolean {
        return !this.destroyed && this.connection.state.status === VoiceConnectionStatus.Ready;
    }

    get playbackState(): "idle" | "loading" | "playing" | "paused" {
        if (!this.active) return "idle";
        if (!this.active.started) return "loading";
        if (this.active.output instanceof AudioCueResource && this.active.output.musicPaused) return "paused";
        const status = this.audioPlayer.state.status;
        return status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused ? "paused" : "playing";
    }

    async play(item: PlaybackItem, signal?: AbortSignal): Promise<"playing" | "queued"> {
        signal?.throwIfAborted();
        if (this.destroyed) {
            throw new Error("The music player has been destroyed.");
        }
        this.musicQueue.add(item);
        if (this.active) {
            return "queued";
        }
        await this.playNext(undefined, signal);
        return "playing";
    }

    pause(): boolean {
        if (this.destroyed || this.playbackState !== "playing") return false;
        const output = this.active?.output;
        if (output instanceof AudioCueResource) {
            output.musicPaused = true;
            if (output.hasCue) return true;
        }
        return this.audioPlayer.pause();
    }

    resume(): boolean {
        if (this.destroyed || this.playbackState !== "paused") return false;
        const output = this.active?.output;
        if (output instanceof AudioCueResource) {
            output.musicPaused = false;
            if (output.hasCue) return true;
        }
        return this.audioPlayer.unpause();
    }

    /** Session UX audio never enters the queue or replaces an active song resource. */
    playCue(pcm: Buffer, request: AudioCueRequest): void {
        if (!this.audioCues || !this.isVoiceReady || request.signal.aborted || !request.canPlay()) return;
        const output = this.active?.output;
        if (output instanceof AudioCueResource) {
            if (output.startCue(pcm, request, () => {
                if (this.active?.output === output && output.musicPaused) this.audioPlayer.pause();
            }) && output.musicPaused) this.audioPlayer.unpause();
            return;
        }
        if (output || this.standaloneCue) return;
        // Idle/loading playback has no song resource on the transport yet.
        const resource = new AudioCueResource();
        const subscription = this.active?.subscription ?? this.connection.subscribe(this.audioPlayer);
        if (!subscription) { resource.playStream.destroy(); return; }
        this.standaloneCue = { resource, subscription };
        try {
            if (!resource.startCue(pcm, request, () => this.releaseStandaloneCue(resource))) {
                this.releaseStandaloneCue(resource);
                return;
            }
            this.audioPlayer.play(resource);
        } catch (error) {
            this.releaseStandaloneCue(resource);
            throw error;
        }
    }

    shuffle(): boolean {
        if (this.destroyed || this.musicQueue.size < 2) return false;
        this.musicQueue.shuffle();
        return true;
    }

    async skip(signal?: AbortSignal): Promise<boolean> {
        signal?.throwIfAborted();
        if (this.destroyed || !this.active) {
            return false;
        }
        this.releaseCurrent();
        await this.playNext(undefined, signal);
        return true;
    }

    stop(): void {
        this.requestGeneration++;
        this.looping = "off";
        this.musicQueue.clear();
        this.releaseCurrent();
        this.releaseStandaloneCue();
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.stop();
        this.audioPlayer.off(AudioPlayerStatus.Idle, this.onIdle);
        this.audioPlayer.off("stateChange", this.onAudioStateChange);
        this.connection.off("stateChange", this.onConnectionStateChange);
        this.connection.off(VoiceConnectionStatus.Destroyed, this.onConnectionDestroyed);
        if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            this.connection.destroy();
        }
        // Error handlers stay attached to these owned emitters to absorb late
        // transport/stream errors. A destroyed player cannot start more audio.
    }

    private async playNext(repeat?: PlaybackItem, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        if (this.destroyed || this.active) {
            return;
        }
        const item = repeat ?? this.musicQueue.next();
        if (!item) {
            return;
        }
        const active: ActivePlayback = { item, abort: new AbortController(), started: false };
        this.active = active;
        // Request cancellation owns only this startup. Never stop a newer track or clear
        // unrelated queued work. Once playing/queued is acknowledged, the music outlives its session.
        const cancelStartup = () => {
            if (this.active !== active || active.started) return;
            this.releaseCurrent();
            void this.playNext().catch(() => {});
        };
        signal?.addEventListener("abort", cancelStartup, { once: true });

        try {
            await entersState(this.connection, VoiceConnectionStatus.Ready,
                AbortSignal.any([active.abort.signal, AbortSignal.timeout(10_000)]));
            this.assertCurrent(active);

            active.subscription = this.connection.subscribe(this.audioPlayer);
            if (!active.subscription) {
                throw new Error("The voice connection could not subscribe to the audio player.");
            }
            // A queued resource is not opened until its turn to play.
            active.resource = await this.resolveResource(active);
            this.assertCurrent(active);
            this.releaseStandaloneCue();
            active.output = this.audioCues ? new AudioCueResource(active.resource) : active.resource;
            this.audioPlayer.play(active.output);
            await entersState(this.audioPlayer, AudioPlayerStatus.Playing,
                AbortSignal.any([active.abort.signal, AbortSignal.timeout(10_000)]));
            this.assertCurrent(active);
            active.started = true;
        } catch (error) {
            const failure = active.error ?? (error instanceof Error ? error : new Error(String(error)));
            if (this.active === active) {
                this.fail(active, failure);
            }
            throw failure;
        } finally { signal?.removeEventListener("abort", cancelStartup); }
    }

    private assertCurrent(active: ActivePlayback): void {
        if (this.destroyed || this.active !== active) {
            throw new Error("Playback was stopped or replaced.");
        }
    }

    private resolveResource(active: ActivePlayback): Promise<AudioResource> {
        const signal = active.abort.signal;
        return new Promise((resolve, reject) => {
            const onAbort = () => reject(new Error("Playback was stopped or replaced."));
            signal.addEventListener("abort", onAbort, { once: true });
            // Cancellation settles promptly even if a provider ignores the signal.
            // A late result is disposed rather than played over the replacement.
            void Promise.resolve().then(() => {
                signal.throwIfAborted();
                return active.item.createResource(signal);
            }).then((resource) => {
                signal.removeEventListener("abort", onAbort);
                if (signal.aborted) {
                    resource.playStream.destroy();
                } else {
                    active.resource = resource;
                    resolve(resource);
                }
            }, (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            });
        });
    }

    private releaseCurrent(): void {
        const active = this.active;
        if (!active) {
            return;
        }
        // Clear ownership before stop() emits Idle, so it cannot advance the queue.
        this.active = undefined;
        active.abort.abort();
        if (active.output instanceof AudioCueResource) active.output.cancelCue();
        // A loading song may share the subscription with standalone UX audio.
        if (active.output || !this.standaloneCue) this.audioPlayer.stop(true);
        active.resource?.playStream.destroy();
        if (active.subscription !== this.standaloneCue?.subscription) active.subscription?.unsubscribe();
    }

    private releaseStandaloneCue(resource = this.standaloneCue?.resource): void {
        const cue = this.standaloneCue;
        if (!cue || cue.resource !== resource) return;
        this.standaloneCue = undefined;
        cue.resource.cancelCue();
        if (this.audioPlayer.state.status !== AudioPlayerStatus.Idle && this.audioPlayer.state.resource === cue.resource) {
            this.audioPlayer.stop(true);
        }
        cue.resource.playStream.destroy();
        if (cue.subscription !== this.active?.subscription) cue.subscription.unsubscribe();
    }

    private fail(active: ActivePlayback, error: Error): void {
        active.error = error;
        logPlaybackError("Audio playback failed", error, {
            guildId: this.connection.joinConfig.guildId,
            trackId: active.item.track?.id, source: active.item.track?.source,
            audioState: this.audioPlayer.state.status, voiceState: this.connection.state.status,
            playbackDurationMs: active.resource?.playbackDuration,
        });
        this.stop();
        try {
            active.item.onError?.(error);
        } catch {
            console.error("Could not report the audio playback failure.");
        }
    }

    private readonly onIdle = (): void => {
        if (this.standaloneCue) { this.releaseStandaloneCue(); return; }
        const active = this.active;
        if (!active || !active.output) {
            return;
        }
        if (!active.started) {
            this.fail(active, new Error("The audio ended before playback started."));
            return;
        }
        const repeat = this.looping === "song" ? active.item : undefined;
        if (this.looping === "queue") {
            this.musicQueue.add(active.item);
        }
        this.releaseCurrent();
        // Reuse metadata/factories, never a consumed resource or expiring audio URL.
        // Automatic starts have no awaiting command; playNext already reports
        // errors via the item's onError callback and stops/clears the queue.
        void this.playNext(repeat).catch(() => {});
    };

    private readonly onAudioError = (error: AudioPlayerError): void => {
        if (this.standaloneCue && error.resource === this.standaloneCue.resource) {
            console.error("[voice-ack] audio output failed", error);
            this.releaseStandaloneCue();
            return;
        }
        const active = this.active;
        if (!active || (error.resource && error.resource !== active.output && error.resource !== active.resource)) {
            return;
        }
        // @discordjs/voice's AudioPlayerError copies message/stack but drops
        // code and cause. Recover the original error retained by Node's stream.
        const streamError = error.resource?.playStream.errored;
        this.fail(active, streamError instanceof Error ? streamError : error);
    };

    private readonly onAudioStateChange = (oldState: AudioPlayerState, newState: AudioPlayerState): void => {
        playbackDebug("audio player state", {
            guildId: this.connection.joinConfig.guildId,
            trackId: this.currentTrack?.id, from: oldState.status, to: newState.status,
            playbackDurationMs: this.active?.resource?.playbackDuration,
        });
    };

    private readonly onConnectionStateChange = (oldState: VoiceConnectionState, newState: VoiceConnectionState): void => {
        playbackDebug("voice connection state", {
            guildId: this.connection.joinConfig.guildId, from: oldState.status, to: newState.status,
        });
    };

    private readonly onConnectionDestroyed = (): void => {
        this.destroy();
    };

    private readonly onConnectionError = (error: Error): void => {
        if (this.destroyed) {
            return;
        }
        if (this.active) {
            this.fail(this.active, error);
        } else {
            logPlaybackError("Voice connection failed", error, { guildId: this.connection.joinConfig.guildId });
        }
        this.destroy();
    };
}

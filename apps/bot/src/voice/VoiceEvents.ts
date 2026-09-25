import type { PCM_FORMAT } from "./receive/SpeakerStream.js";
import type { SpeechEvent } from "./processing/VoiceActivityDetector.js";
import type { WakeActivation } from "./wake/WakeWordDetector.js";

export interface VoiceStreamIdentity { guildId: string; userId: string; streamId: string }
export type WakeListeningState = "listening" | "paused" | "unavailable";
export interface VoiceAudioSnapshot extends VoiceStreamIdentity {
    pcm: Buffer;
    format: typeof PCM_FORMAT;
    startMs: number;
    audioTimeMs: number;
    isSpeaking: boolean;
    lastVoiceTimeMs?: number;
}

/** Phase 3 transport contract. Phase 4 owns command sessions and their timeouts. */
export interface VoiceEvents {
    // Receive-side VAD history includes frames delivered while keyword inference ran.
    wake: [WakeActivation & { lastVoiceTimeMs?: number }];
    wakeError: [VoiceStreamIdentity];
    // Published before VAD setup/first PCM, so early initialization failures are identifiable.
    streamStart: [VoiceStreamIdentity];
    // Owned PCM copy, with an exclusive end offset on this stream's audio clock.
    pcm: [VoiceStreamIdentity & { pcm: Buffer; format: typeof PCM_FORMAT; audioTimeMs: number; isVoice: boolean; isSpeaking: boolean }];
    speech: [VoiceStreamIdentity & SpeechEvent];
    streamEnd: [VoiceStreamIdentity & { audioTimeMs: number; reason: string }];
    streamError: [VoiceStreamIdentity & { reason: string }];
    userStopped: [{ guildId: string; userId: string; reason: string }];
    reset: [{ guildId: string; reason: string }];
    wakeState: [{ guildId: string; state: WakeListeningState; reason: string }];
}

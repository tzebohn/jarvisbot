import type { MusicCommandUpdate, MusicFailure } from "../../music/MusicCommandFeedback.js";
import type { SessionIdentity } from "../sessions/GuildVoiceSessions.js";

export type VoiceFailure = MusicFailure | "no-command" | "empty-transcript" | "stt-failed" | "unknown-command"
    | "unsupported-command" | "truncated" | "timeout" | "contention" | "capture-failed" | "processing-failed";
export type VoiceCommandUpdate = MusicCommandUpdate
    | { state: "listening" | "processing" }
    | { state: "completed"; captureOnly: true }
    | { state: "failed"; reason: VoiceFailure };
export interface VoiceFeedbackIdentity extends SessionIdentity { voiceChannelId: string | null }
export interface VoiceFeedbackEvent extends VoiceFeedbackIdentity { update: VoiceCommandUpdate }
export type ReportVoiceFeedback = (update: VoiceCommandUpdate) => void;

/** Synchronous, non-blocking UI boundary. No audio, transcripts, or raw errors. */
export interface VoiceCommandFeedback {
    update(event: VoiceFeedbackEvent): void;
    /** Accepted playback can fail after its command session has ended. */
    playbackFailed(event: VoiceFeedbackIdentity): void;
}

export function isTerminalFeedback(update: VoiceCommandUpdate): boolean {
    return update.state !== "listening" && update.state !== "processing" && update.state !== "searching";
}

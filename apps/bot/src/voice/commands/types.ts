import type { MusicCommand } from "@discord-music-platform/shared";

export type ParsedVoiceCommand = MusicCommand | { type: "unknown" };
export type ParseReason = "matched" | "empty" | "invalid-input" | "truncated" | "missing-query"
    | "unsupported" | "negated" | "multiple-commands" | "unrecognized" | "local-only"
    | "low-confidence" | "invalid-response" | "rate-limited" | "timeout" | "unavailable" | "configuration";

export interface CommandParseResult {
    command: ParsedVoiceCommand;
    source: "local" | "groq";
    reason: ParseReason;
    elapsedMs: number;
    model?: string;
    /** Model self-assessment, not calibrated probability or an STT quality signal. */
    confidence?: number;
    cached?: boolean;
}

export interface CommandNormalizationBackend {
    readonly model: string;
    /** Untrusted data: the hybrid parser validates every response. */
    normalize(text: string, signal: AbortSignal): Promise<unknown>;
}

export class CommandParserError extends Error {
    constructor(readonly code: "invalid-response" | "rate-limited" | "timeout" | "unavailable" | "configuration",
        readonly retryAfterMs?: number) {
        super(`Voice command normalization failed (${code}).`);
        this.name = "CommandParserError";
    }
}

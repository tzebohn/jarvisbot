export type SttProvider = "groq" | "faster-whisper";
export type SttErrorCode = "RATE_LIMITED" | "UNAVAILABLE" | "TIMEOUT" | "CONFIGURATION"
    | "INVALID_AUDIO" | "INVALID_RESPONSE" | "BUSY" | "LOCAL_FAILED";

/** Messages are safe to report: never include API bodies, keys, audio, or transcripts. */
export class SttError extends Error {
    constructor(readonly code: SttErrorCode, message: string, readonly retryAfterMs?: number) {
        super(message);
        this.name = "SttError";
    }
}

export interface SegmentQuality {
    start?: number;
    end?: number;
    avgLogprob?: number;
    noSpeechProb?: number;
    compressionRatio?: number;
}

export interface SttResponse {
    text: string;
    language?: string;
    languageProbability?: number;
    segments: SegmentQuality[];
}

export interface SttBackend {
    readonly provider: SttProvider;
    readonly model: string;
    transcribe(wav: Buffer, signal: AbortSignal): Promise<SttResponse>;
    close?(): void;
}

export interface TranscriptionResult extends SttResponse {
    rawText: string;
    status: "transcribed" | "empty";
    provider: SttProvider | "none";
    model: string;
    fallbackReason?: SttErrorCode;
    elapsedMs: number;
    groqMs: number;
    localMs: number;
}

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Both adapters use Whisper's verbose JSON shape. Scores are not calibrated confidence. */
export function parseWhisperResponse(value: unknown): SttResponse {
    if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string" || value.text.length > 16_000) {
        throw new SttError("INVALID_RESPONSE", "The speech-to-text provider returned an invalid response.");
    }
    const data = value as Record<string, unknown>;
    const segments: SegmentQuality[] = [];
    if (Array.isArray(data.segments)) {
        for (const segment of data.segments.slice(0, 256)) {
            if (!segment || typeof segment !== "object") continue;
            segments.push({ start: finite(segment.start), end: finite(segment.end),
                avgLogprob: finite(segment.avg_logprob), noSpeechProb: finite(segment.no_speech_prob),
                compressionRatio: finite(segment.compression_ratio) });
        }
    }
    return { text: value.text, segments, language: typeof data.language === "string" ? data.language : undefined,
        languageProbability: finite(data.language_probability) };
}

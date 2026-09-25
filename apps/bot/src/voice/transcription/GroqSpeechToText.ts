import Groq, { toFile } from "groq-sdk";
import { parseWhisperResponse, SttError, type SttBackend, type SttResponse } from "./types.js";

function durationMs(value: string | null): number | undefined {
    if (!value) return undefined;
    const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
    if (!parts.length || parts.map((part) => part[0]).join("") !== value) return undefined;
    const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return parts.reduce((sum, part) => sum + Number(part[1]) * units[part[2]], 0);
}

export function groqRetryAfter(headers: Headers | undefined, now = Date.now()): number {
    const retry = headers?.get("retry-after");
    const delays = [60_000]; // No tight retry loop if the provider omits useful headers.
    if (retry) {
        const seconds = Number(retry);
        const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retry) - now;
        if (Number.isFinite(ms) && ms >= 0) delays[0] = ms;
    }
    // Groq documents the requests reset as RPD, not RPM. Only use it when exhausted.
    if (headers?.get("x-ratelimit-remaining-requests") === "0") {
        const reset = durationMs(headers.get("x-ratelimit-reset-requests"));
        if (reset !== undefined) delays.push(reset);
        else if (!retry) delays.push(86_400_000);
    }
    return Math.max(1_000, ...delays);
}

export class GroqSpeechToText implements SttBackend {
    readonly provider = "groq" as const;
    readonly model = "whisper-large-v3-turbo";
    private readonly client?: Groq;

    constructor(apiKey: string, private readonly language = "en", fetch?: typeof globalThis.fetch) {
        if (apiKey.trim()) this.client = new Groq({ apiKey: apiKey.trim(), maxRetries: 0, timeout: 8_000, fetch,
            logLevel: "off" });
    }

    async transcribe(wav: Buffer, signal: AbortSignal): Promise<SttResponse> {
        signal.throwIfAborted();
        if (!this.client) throw new SttError("CONFIGURATION", "Set GROQ_API_KEY before using voice transcription.");
        try {
            const file = await toFile(wav, "command.wav", { type: "audio/wav" });
            signal.throwIfAborted();
            const data = await this.client.audio.transcriptions.create({ file, model: this.model,
                language: this.language === "auto" ? undefined : this.language,
                temperature: 0, response_format: "verbose_json", timestamp_granularities: ["segment"] },
            { signal, maxRetries: 0 });
            signal.throwIfAborted();
            return parseWhisperResponse(data);
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof SttError) throw error;
            if (error instanceof Groq.APIConnectionTimeoutError) throw new SttError("TIMEOUT", "Groq transcription timed out.");
            if (error instanceof Groq.APIConnectionError) throw new SttError("UNAVAILABLE", "Could not connect to Groq transcription.");
            if (error instanceof Groq.APIError) {
                if (error.status === 429) throw new SttError("RATE_LIMITED", "Groq's transcription limit was reached.", groqRetryAfter(error.headers));
                if (error.status === 408) throw new SttError("TIMEOUT", "Groq transcription timed out.");
                if (error.status !== undefined && error.status >= 500) throw new SttError("UNAVAILABLE", "Groq transcription is temporarily unavailable.");
                if ([401, 403, 404].includes(error.status ?? 0)) throw new SttError("CONFIGURATION", "Check GROQ_API_KEY and Groq model permissions.");
                throw new SttError("INVALID_AUDIO", "Groq rejected the transcription request. Check the audio and STT configuration.");
            }
            throw new SttError("INVALID_RESPONSE", "Groq returned an unreadable transcription response.");
        }
    }
}

import { pcmToWav } from "../receive/wav.js";
import type { CommandAudio } from "../sessions/VoiceCommandSession.js";
import { normalizeTranscript } from "./normalizeTranscript.js";
import { SttError, type SttBackend, type SttErrorCode, type SttResponse, type TranscriptionResult } from "./types.js";

export const STT_GROQ_TIMEOUT_MS = 8_000;
export const STT_LOCAL_TIMEOUT_MS = 40_000;
export const STT_PROCESSING_TIMEOUT_MS = 55_000;

/** One shared service per bot: all guilds share the cloud budget and cooldown. */
export class SpeechToText {
    private blockedUntil = 0;
    private blockedReason: SttErrorCode = "RATE_LIMITED";
    private requests: number[] = [];

    constructor(private readonly primary: SttBackend, private readonly local: SttBackend,
        private readonly options: { mode?: "auto" | "local"; now?: () => number;
            groqTimeoutMs?: number; localTimeoutMs?: number } = {}) {}

    async transcribe(audio: CommandAudio, signal: AbortSignal): Promise<TranscriptionResult> {
        signal.throwIfAborted();
        const started = performance.now();
        let groqMs = 0, localMs = 0;
        const result = (response: SttResponse, backend?: SttBackend, fallbackReason?: SttErrorCode): TranscriptionResult => {
            const text = normalizeTranscript(response.text, audio.wake.phrase);
            return { ...response, rawText: response.text, text, status: text ? "transcribed" : "empty",
                provider: backend?.provider ?? "none", model: backend?.model ?? "", fallbackReason,
                elapsedMs: performance.now() - started, groqMs, localMs };
        };
        if (!audio.pcm.length) return result({ text: "", segments: [] });
        if (audio.format.sampleRate !== 48_000 || audio.format.channels !== 2 || audio.format.bitsPerSample !== 16
            || !audio.format.signed || audio.format.endianness !== "little" || audio.pcm.length % 4
            || audio.pcm.length > 2_688_000) {
            throw new SttError("INVALID_AUDIO", "STT requires a bounded command clip in 48 kHz stereo signed 16-bit LE PCM.");
        }
        // Both Whisper implementations decode/downmix/resample WAV to 16 kHz mono internally.
        const wav = pcmToWav(audio.pcm);
        let fallbackReason: SttErrorCode | undefined;
        if (this.options.mode !== "local") {
            const now = (this.options.now ?? Date.now)();
            this.requests = this.requests.filter((time) => time > now - 86_400_000);
            if (now < this.blockedUntil) fallbackReason = this.blockedReason;
            else if (this.requests.length >= 2_000 || this.requests.filter((time) => time > now - 60_000).length >= 20) {
                fallbackReason = "RATE_LIMITED";
            } else {
                this.requests.push(now); // Reserve synchronously, before another guild can submit.
                const attempt = performance.now();
                try {
                    const response = await this.attempt(this.primary, wav, signal, this.options.groqTimeoutMs ?? STT_GROQ_TIMEOUT_MS);
                    groqMs = performance.now() - attempt;
                    return result(response, this.primary);
                } catch (error) {
                    signal.throwIfAborted(); // Disconnects/shutdown never start fallback.
                    if (!(error instanceof SttError) || !["RATE_LIMITED", "UNAVAILABLE", "TIMEOUT"].includes(error.code)) throw error;
                    groqMs = performance.now() - attempt;
                    fallbackReason = error.code;
                    this.blockedReason = error.code;
                    this.blockedUntil = Math.max(this.blockedUntil, (this.options.now ?? Date.now)()
                        + (error.retryAfterMs ?? (error.code === "RATE_LIMITED" ? 60_000 : 15_000)));
                }
            }
        }
        const attempt = performance.now();
        const response = await this.attempt(this.local, wav, signal, this.options.localTimeoutMs ?? STT_LOCAL_TIMEOUT_MS);
        localMs = performance.now() - attempt;
        return result(response, this.local, fallbackReason);
    }

    close(): void { this.primary.close?.(); this.local.close?.(); }

    private async attempt(backend: SttBackend, wav: Buffer, parent: AbortSignal, timeoutMs: number): Promise<SttResponse> {
        parent.throwIfAborted();
        const abort = new AbortController();
        const cancel = () => abort.abort(parent.reason);
        parent.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(() => abort.abort(new SttError("TIMEOUT", `${backend.provider} transcription timed out.`)), timeoutMs);
        let rejectAbort: () => void = () => {};
        try {
            const cancelled = new Promise<never>((_resolve, reject) => {
                rejectAbort = () => reject(abort.signal.reason);
                abort.signal.addEventListener("abort", rejectAbort, { once: true });
            });
            const response = await Promise.race([backend.transcribe(wav, abort.signal), cancelled]);
            abort.signal.throwIfAborted();
            return response;
        } finally {
            clearTimeout(timer);
            parent.removeEventListener("abort", cancel);
            abort.signal.removeEventListener("abort", rejectAbort);
        }
    }
}

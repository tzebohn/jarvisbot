import { COMMAND_PARSE_TIMEOUT_MS } from "./GroqCommandNormalizer.js";
import { parseLocalCommand, validPlayQuery } from "./localParser.js";
import { CommandParserError, type CommandNormalizationBackend, type CommandParseResult, type ParseReason } from "./types.js";

export const MIN_COMMAND_CONFIDENCE = 0.9;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_SIZE = 128;

type Decision = Pick<CommandParseResult, "command" | "reason" | "confidence">;
const unknown = (reason: ParseReason): Decision => ({ command: { type: "unknown" }, reason });

/** Validate even schema-constrained output: schema correctness alone does not imply correct intent. */
function validateResponse(data: unknown, text: string): Decision {
    if (!data || typeof data !== "object" || Array.isArray(data)) return unknown("invalid-response");
    const value = data as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || !["type", "query", "confidence"].every((key) => Object.hasOwn(value, key))
        || typeof value.confidence !== "number" || !Number.isFinite(value.confidence)
        || value.confidence < 0 || value.confidence > 1) return unknown("invalid-response");
    const { type, query, confidence } = value;
    let decision: Decision;
    if (type === "play") {
        if (typeof query !== "string" || query !== query.trim() || !validPlayQuery(query)) return unknown("invalid-response");
        // Ground the query in the input, including word boundaries. No hallucinated/corrected metadata.
        const start = text.indexOf(query);
        if (start < 0 || /[\p{L}\p{N}]/u.test(text[start - 1] ?? "")
            || /[\p{L}\p{N}]/u.test(text[start + query.length] ?? "")) return unknown("invalid-response");
        decision = { command: { type, query: text.slice(start, start + query.length) }, reason: "matched" };
    } else {
        if (query !== null) return unknown("invalid-response");
        switch (type) {
            case "pause": case "resume": case "skip": case "queue": case "stop": case "leave":
                decision = { command: { type }, reason: "matched" }; break;
            case "unknown": decision = unknown("unrecognized"); break;
            default: return unknown("invalid-response");
        }
    }
    if (confidence < MIN_COMMAND_CONFIDENCE && decision.command.type !== "unknown") decision = unknown("low-confidence");
    return { ...decision, confidence };
}

/** One shared parser across guilds. No Discord/music-service dependency or execution capability. */
export class VoiceCommandParser {
    private readonly cache = new Map<string, { decision: Decision; expiresAt: number }>();
    private requests: number[] = [];
    private blockedUntil = 0;
    private blockedReason: ParseReason = "rate-limited";

    constructor(private readonly fallback?: CommandNormalizationBackend,
        private readonly options: { now?: () => number; timeoutMs?: number } = {}) {
        if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0
            || options.timeoutMs > COMMAND_PARSE_TIMEOUT_MS)) throw new Error("Parser timeout must be 1–5000 milliseconds.");
    }

    async parse(input: unknown, signal: AbortSignal, context: { truncated?: boolean } = {}): Promise<CommandParseResult> {
        signal.throwIfAborted();
        const started = performance.now();
        const result = (decision: Decision, source: "local" | "groq" = "local", cached = false): CommandParseResult => ({
            ...decision, command: { ...decision.command }, source, elapsedMs: performance.now() - started,
            ...(source === "groq" ? { model: this.fallback?.model, cached } : {}),
        });
        if (context.truncated) return result(unknown("truncated"));
        const local = parseLocalCommand(input);
        if ("command" in local) return result(local);
        if (!this.fallback) return result(unknown("local-only"));
        const now = (this.options.now ?? Date.now)();
        // Exact normalized text only: never reuse a decision across different queries.
        for (const [key, value] of this.cache) if (value.expiresAt <= now) this.cache.delete(key);
        const cached = this.cache.get(local.text);
        if (cached) return result(cached.decision, "groq", true);
        if (now < this.blockedUntil) return result(unknown(this.blockedReason));
        this.requests = this.requests.filter((time) => time > now - 86_400_000);
        if (this.requests.length >= 250 || this.requests.filter((time) => time > now - 60_000).length >= 10) {
            return result(unknown("rate-limited"));
        }
        this.requests.push(now); // Reserve before awaiting, shared across concurrent guilds.
        try {
            const response = await this.attempt(local.text, signal);
            signal.throwIfAborted();
            const decision = validateResponse(response, local.text);
            if (decision.reason !== "invalid-response") {
                if (this.cache.size >= CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
                this.cache.set(local.text, { decision, expiresAt: (this.options.now ?? Date.now)() + CACHE_TTL_MS });
            }
            return result(decision, "groq");
        } catch (error) {
            signal.throwIfAborted(); // Cancellation never becomes a command/unknown result.
            const failure = error instanceof CommandParserError ? error : new CommandParserError("unavailable");
            this.blockedReason = failure.code;
            this.blockedUntil = Math.max(this.blockedUntil, (this.options.now ?? Date.now)()
                + (failure.retryAfterMs ?? (failure.code === "configuration" ? 300_000 : 15_000)));
            return result(unknown(failure.code), "groq");
        }
    }

    private async attempt(text: string, parent: AbortSignal): Promise<unknown> {
        parent.throwIfAborted();
        const abort = new AbortController();
        const cancel = () => abort.abort(parent.reason);
        parent.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(() => abort.abort(new CommandParserError("timeout")), this.options.timeoutMs ?? COMMAND_PARSE_TIMEOUT_MS);
        let rejectAbort = () => {};
        try {
            const cancelled = new Promise<never>((_resolve, reject) => {
                rejectAbort = () => reject(abort.signal.reason);
                abort.signal.addEventListener("abort", rejectAbort, { once: true });
            });
            const response = await Promise.race([this.fallback!.normalize(text, abort.signal), cancelled]);
            abort.signal.throwIfAborted();
            return response;
        } finally {
            clearTimeout(timer);
            parent.removeEventListener("abort", cancel);
            abort.signal.removeEventListener("abort", rejectAbort);
        }
    }
}

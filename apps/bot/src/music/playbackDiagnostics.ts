import { stripVTControlCharacters } from "node:util";

/** Keep transport diagnostics useful without exposing signed media URLs or credentials. */
export function sanitizeDiagnostic(text: string): string {
    let result = stripVTControlCharacters(text).replace(/\r/g, "\n");
    for (const name of ["DISCORD_TOKEN", "YOUTUBE_API_KEY"]) {
        const secret = process.env[name];
        if (secret) result = result.replaceAll(secret, "[redacted]");
    }
    return result.replace(/https?:\/\/[^\s"'<>]+/gi, "[URL redacted]")
        .replace(/\b(authorization|cookie|set-cookie|x-goog-api-key)\s*[:=][^\n]*/gi, "$1: [redacted]");
}

export function describePlaybackError(error: unknown, depth = 0): Record<string, unknown> {
    if (!(error instanceof Error)) {
        return { message: sanitizeDiagnostic(String(error)) };
    }
    const result: Record<string, unknown> = {
        name: error.name, message: sanitizeDiagnostic(error.message),
        stack: error.stack ? sanitizeDiagnostic(error.stack) : undefined,
    };
    for (const key of ["code", "errno", "syscall", "provider", "operation"]) {
        const value = Reflect.get(error, key);
        if (typeof value === "string" || typeof value === "number") {
            result[key] = typeof value === "string" ? sanitizeDiagnostic(value) : value;
        }
    }
    if (error.cause !== undefined && depth < 3) {
        result.cause = describePlaybackError(error.cause, depth + 1);
    }
    return result;
}

export function logPlaybackError(message: string, error: unknown, context: Record<string, unknown> = {}): void {
    console.error(`[music] ${message}`, JSON.stringify({ ...context, error: describePlaybackError(error) }, null, 2));
}

export function playbackDebug(event: string, context: Record<string, unknown>): void {
    if (process.env.MUSIC_DEBUG === "1") {
        console.debug(`[music] ${event}`, JSON.stringify(context));
    }
}

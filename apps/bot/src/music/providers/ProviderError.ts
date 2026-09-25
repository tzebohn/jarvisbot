import type { MusicSource } from "@discord-music-platform/shared";

export type ProviderOperation = "search" | "normalize" | "getAudio";

export type ProviderErrorCode =
    | "INVALID_INPUT"
    | "INVALID_RESPONSE"
    | "UNAVAILABLE"
    | "UNAUTHORIZED"
    | "RATE_LIMITED"
    | "NOT_PLAYABLE"
    | "UNKNOWN";

export interface ProviderErrorOptions extends ErrorOptions {
    provider: MusicSource;
    operation: ProviderOperation;
    code: ProviderErrorCode;
}

export class ProviderError extends Error {
    readonly provider: MusicSource;
    readonly operation: ProviderOperation;
    readonly code: ProviderErrorCode;

    constructor(message: string, options: ProviderErrorOptions) {
        super(message, { cause: options.cause });
        this.name = "ProviderError";
        this.provider = options.provider;
        this.operation = options.operation;
        this.code = options.code;
    }
}

/** Preserve classified failures; retain unclassified SDK errors only as causes. */
export function toProviderError(
    error: unknown,
    provider: MusicSource,
    operation: ProviderOperation,
): ProviderError {
    if (error instanceof ProviderError) {
        return error;
    }
    return new ProviderError(`${provider} ${operation} failed.`, {
        provider,
        operation,
        code: "UNKNOWN",
        cause: error,
    });
}

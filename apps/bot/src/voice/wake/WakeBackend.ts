export interface KeywordDetection {
    keyword: string;
    // Acoustic token endpoint within this detector's input, not a confidence estimate.
    keywordStartMs?: number;
    keywordEndMs?: number;
    tokens?: string[];
}

/** Cumulative native work, not keyword hypotheses or confidence. Padding/replay are separate from input. */
export interface WakeBackendDiagnostics {
    inputSamples48k: number;
    resampledSamples16k: number;
    paddingSamples16k: number;
    decodedChunks: number;
    rollovers: number;
}

export interface WakeBackend {
    accept(mono48k: Float32Array, final?: boolean): Promise<KeywordDetection[]>;
    getDiagnostics?(): WakeBackendDiagnostics | undefined;
    destroy(): void;
}

export type WakeBackendFactory = () => WakeBackend;

export interface WakeConfiguration {
    paths: { encoder: string; decoder: string; joiner: string; tokens: string; keywords: string };
    threshold: number;
    score: number;
}

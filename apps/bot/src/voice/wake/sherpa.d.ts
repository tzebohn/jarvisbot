declare module "sherpa-onnx-node" {
    export interface OnlineStream {
        acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
        inputFinished(): void;
    }
    export interface KeywordResult { keyword: string; timestamps: number[]; tokens: string[]; start_time: number }
    export class KeywordSpotter {
        constructor(config: {
            featConfig: { sampleRate: number; featureDim: number };
            modelConfig: { transducer: { encoder: string; decoder: string; joiner: string };
                tokens: string; numThreads: number; provider: string; debug: number };
            keywordsFile: string; keywordsScore: number; keywordsThreshold: number; numTrailingBlanks: number;
        });
        createStream(): OnlineStream;
        isReady(stream: OnlineStream): boolean;
        decode(stream: OnlineStream): void;
        reset(stream: OnlineStream): void;
        getResult(stream: OnlineStream): KeywordResult;
    }
    export class LinearResampler {
        constructor(inputRate: number, outputRate: number);
        resample(samples: Float32Array): Float32Array;
        flush(samples: Float32Array): Float32Array;
    }
    const sherpa: { KeywordSpotter: typeof KeywordSpotter; LinearResampler: typeof LinearResampler };
    export default sherpa;
}

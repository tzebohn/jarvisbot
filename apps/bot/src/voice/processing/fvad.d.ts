declare module "@echogarden/fvad-wasm" {
    export interface FvadModule {
        HEAP16: Int16Array;
        _malloc(bytes: number): number;
        _free(pointer: number): void;
        _fvad_new(): number;
        _fvad_free(instance: number): void;
        _fvad_set_mode(instance: number, mode: number): number;
        _fvad_set_sample_rate(instance: number, rate: number): number;
        _fvad_process(instance: number, samples: number, length: number): number;
    }

    export default function initialize(): Promise<FvadModule>;
}

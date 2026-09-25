import initialize, { type FvadModule } from "@echogarden/fvad-wasm";
import { PCM_FORMAT } from "../receive/SpeakerStream.js";

export const VAD_FRAME_MS = 20;
export const VAD_FRAME_SAMPLES = PCM_FORMAT.sampleRate * VAD_FRAME_MS / 1_000;

export interface VoiceFrameDetector {
    isSpeech(mono: Int16Array): boolean;
    destroy(): void;
}

export type VoiceFrameDetectorFactory = () => VoiceFrameDetector;
let loaded: Promise<FvadModule> | undefined;

/** Load the bundled WASM once, then allocate independent, explicitly freed VAD state per speaker. */
export async function createWebRtcVadFactory(mode = 2): Promise<VoiceFrameDetectorFactory> {
    if (!Number.isInteger(mode) || mode < 0 || mode > 3) throw new Error("WebRTC VAD mode must be 0, 1, 2, or 3.");
    const wasm = await (loaded ??= initialize());
    return () => {
        const instance = wasm._fvad_new();
        const samples = wasm._malloc(VAD_FRAME_SAMPLES * 2);
        if (!instance || !samples || wasm._fvad_set_sample_rate(instance, PCM_FORMAT.sampleRate) !== 0
            || wasm._fvad_set_mode(instance, mode) !== 0) {
            if (samples) wasm._free(samples);
            if (instance) wasm._fvad_free(instance);
            throw new Error("Could not initialize the WebRTC voice activity detector.");
        }
        let destroyed = false;
        return {
            isSpeech(mono) {
                if (destroyed) throw new Error("The voice activity detector was destroyed.");
                if (mono.length !== VAD_FRAME_SAMPLES) throw new Error("VAD requires 20 ms of 48 kHz mono PCM.");
                // Read the current heap view each time; another allocation may grow WASM memory.
                wasm.HEAP16.set(mono, samples / 2);
                const decision = wasm._fvad_process(instance, samples, mono.length);
                if (decision !== 0 && decision !== 1) throw new Error("WebRTC VAD rejected an audio frame.");
                return decision === 1;
            },
            destroy() {
                if (destroyed) return;
                destroyed = true;
                wasm._free(samples);
                wasm._fvad_free(instance);
            },
        };
    };
}

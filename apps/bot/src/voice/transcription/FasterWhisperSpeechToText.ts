import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseWhisperResponse, SttError, type SttBackend, type SttResponse } from "./types.js";

export const LOCAL_WORKER_PATH = fileURLToPath(new URL("../../../scripts/faster-whisper-worker.py", import.meta.url));

export interface FasterWhisperOptions {
    python: string;
    model: string;
    device: "cpu" | "cuda";
    computeType: string;
    threads: number;
    language: string;
    cacheDir: string;
}

export function localWorkerArgs(options: FasterWhisperOptions): string[] {
    return ["-u", LOCAL_WORKER_PATH, "--model", options.model, "--device", options.device,
        "--compute-type", options.computeType, "--threads", String(options.threads),
        "--language", options.language, "--cache-dir", options.cacheDir];
}

interface Job {
    id: number;
    wav?: Buffer;
    signal: AbortSignal;
    cancel: () => void;
    resolve: (value: SttResponse) => void;
    reject: (error: unknown) => void;
}

/** Persistent, lazy Python model. One inference at a time, at most four waiting clips. */
export class FasterWhisperSpeechToText implements SttBackend {
    readonly provider = "faster-whisper" as const;
    readonly model: string;
    private child?: ChildProcessWithoutNullStreams;
    private ready = false;
    private stopping = false;
    private disposed = false;
    private sequence = 0;
    private active?: Job;
    private readonly queue: Job[] = [];

    constructor(private readonly options: FasterWhisperOptions,
        private readonly launch: typeof spawn = spawn) { this.model = options.model; }

    transcribe(wav: Buffer, signal: AbortSignal): Promise<SttResponse> {
        signal.throwIfAborted();
        if (this.disposed) return Promise.reject(new SttError("LOCAL_FAILED", "Local transcription has stopped."));
        if (this.queue.length >= 4) return Promise.reject(new SttError("BUSY", "Local transcription is busy. Please try again shortly."));
        return new Promise((resolve, reject) => {
            const job: Job = { id: ++this.sequence, wav, signal, resolve, reject, cancel: () => {
                if (this.active === job) {
                    this.settle(job, undefined, signal.reason);
                    // Native inference cannot be interrupted through stdin. Kill only this worker;
                    // waiting jobs restart on a fresh process after its close event.
                    this.stopWorker();
                } else {
                    const index = this.queue.indexOf(job);
                    if (index !== -1) this.queue.splice(index, 1);
                    this.settle(job, undefined, signal.reason);
                }
                this.pump();
            } };
            signal.addEventListener("abort", job.cancel, { once: true });
            this.queue.push(job);
            this.pump();
        });
    }

    close(): void {
        if (this.disposed) return;
        this.disposed = true;
        const error = new SttError("LOCAL_FAILED", "Local transcription has stopped.");
        if (this.active) this.settle(this.active, undefined, error);
        for (const job of this.queue.splice(0)) this.settle(job, undefined, error);
        this.stopWorker();
    }

    private pump(): void {
        if (this.disposed || this.stopping || this.active || !this.queue.length) return;
        this.active = this.queue.shift()!;
        if (!this.child) this.startWorker();
        else if (this.ready) this.send();
    }

    private startWorker(): void {
        try {
            const child = this.launch(this.options.python, localWorkerArgs(this.options), {
                stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
                env: { ...process.env, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", PYTHONIOENCODING: "utf-8" },
            }) as ChildProcessWithoutNullStreams;
            this.child = child;
            let output = "";
            child.stdout.setEncoding("utf8");
            child.stderr.resume(); // Never forward library errors containing audio, paths, or private content.
            child.stdout.on("data", (chunk: string) => {
                if (this.child !== child || this.stopping) return;
                output += chunk;
                if (Buffer.byteLength(output) > 131_072) { this.failWorker(); return; }
                let newline: number;
                while ((newline = output.indexOf("\n")) !== -1) {
                    const line = output.slice(0, newline);
                    output = output.slice(newline + 1);
                    try { this.onResponse(JSON.parse(line)); }
                    catch { this.failWorker(); return; }
                }
            });
            child.stdin.on("error", () => { if (this.child === child) this.failWorker(); });
            child.on("error", () => { if (this.child === child) this.failWorker(); });
            child.once("close", () => {
                if (this.child !== child) return;
                this.child = undefined;
                this.ready = false;
                this.stopping = false;
                if (this.active) this.settle(this.active, undefined, this.workerError());
                this.pump();
            });
        } catch {
            if (this.active) this.settle(this.active, undefined, this.workerError());
            this.pump();
        }
    }

    private send(): void {
        const job = this.active;
        if (!job?.wav || !this.child || !this.ready || this.stopping) return;
        const child = this.child;
        child.stdin.write(JSON.stringify({ id: job.id, wav: job.wav.toString("base64") }) + "\n", (error) => {
            if (error && this.child === child) this.failWorker();
        });
        job.wav = undefined;
    }

    private onResponse(message: Record<string, unknown>): void {
        if (message.type === "ready" && !this.ready) { this.ready = true; this.send(); return; }
        const job = this.active;
        if (!job || message.id !== job.id || !this.ready) throw this.workerError();
        if (message.type === "error") this.settle(job, undefined, this.workerError());
        else if (message.type === "result") this.settle(job, parseWhisperResponse(message));
        else throw this.workerError();
        this.pump();
    }

    private settle(job: Job, response?: SttResponse, error?: unknown): void {
        if (this.active === job) this.active = undefined;
        job.wav = undefined;
        job.signal.removeEventListener("abort", job.cancel);
        if (response) job.resolve(response);
        else job.reject(error ?? this.workerError());
    }

    private failWorker(): void {
        if (this.active) this.settle(this.active, undefined, this.workerError());
        this.stopWorker();
    }

    private stopWorker(): void {
        this.ready = false;
        if (this.child && !this.stopping) {
            this.stopping = true;
            this.child.stdin.destroy();
            this.child.kill("SIGKILL");
        }
    }

    private workerError(): SttError {
        return new SttError("LOCAL_FAILED", "Local faster-whisper failed. Check VOICE_STT_PYTHON, install requirements-stt.txt, and run setup:stt.");
    }
}

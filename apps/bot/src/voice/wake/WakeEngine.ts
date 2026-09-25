import { Worker } from "node:worker_threads";
import { readFile, stat } from "node:fs/promises";
import type { KeywordDetection, WakeBackend, WakeBackendDiagnostics, WakeConfiguration } from "./WakeBackend.js";
import { DEFAULT_WAKE_SCORE, DEFAULT_WAKE_THRESHOLD, validateWakeKeywords, wakeModelPaths } from "./wakeModel.js";

interface Pending {
    streamId: number;
    resolve: (detections: KeywordDetection[]) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    recordDiagnostics: (diagnostics: WakeBackendDiagnostics) => void;
}

/** Shared model on a worker thread; audio and decoder state remain separate for each speaker. */
export class WakeEngine {
    private readonly pending = new Map<number, Pending>();
    private readonly active = new Set<number>();
    private nextStream = 0;
    private nextRequest = 0;
    private closed = false;

    private constructor(private readonly worker: Worker, readonly threshold: number) {}

    static async create(directory?: string, threshold = DEFAULT_WAKE_THRESHOLD, score = DEFAULT_WAKE_SCORE): Promise<WakeEngine> {
        if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new Error("VOICE_WAKE_THRESHOLD must be > 0 and <= 1.");
        if (!Number.isFinite(score) || score <= 0 || score > 5) throw new Error("VOICE_WAKE_SCORE must be > 0 and <= 5.");
        const paths = wakeModelPaths(directory);
        for (const path of Object.values(paths)) {
            if (!(await stat(path)).isFile() || (await stat(path)).size === 0) throw new Error("Missing or empty wake model; run pnpm --filter bot setup:wake.");
        }
        validateWakeKeywords(await readFile(paths.keywords, "utf8"), await readFile(paths.tokens, "utf8"));
        const config: WakeConfiguration = { paths, threshold, score };
        const source = import.meta.url.endsWith(".ts");
        const worker = source
            ? new Worker(`const { workerData } = require('node:worker_threads'); import('tsx/esm/api').then(({ register }) => { register(); return import(workerData.moduleUrl); });`, {
                eval: true, execArgv: [], workerData: { config, moduleUrl: new URL("./wakeWorker.ts", import.meta.url).href },
            })
            : new Worker(new URL("./wakeWorker.js", import.meta.url), { workerData: { config }, execArgv: [] });
        const engine = new WakeEngine(worker, threshold);
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { cleanup(); reject(new Error("Wake model startup timed out.")); }, 30_000);
                const onReady = (message: { type: string }) => {
                    if (message.type === "ready") { cleanup(); resolve(); }
                };
                const onError = () => { cleanup(); reject(new Error("Could not load the wake model/native runtime.")); };
                const cleanup = () => {
                    clearTimeout(timer);
                    worker.off("message", onReady);
                    worker.off("error", onError);
                    worker.off("exit", onError);
                };
                worker.on("message", onReady);
                worker.once("error", onError);
                worker.once("exit", onError);
            });
        } catch (error) {
            await engine.close();
            throw error;
        }
        worker.on("message", (message: { requestId: number; detections: KeywordDetection[]; diagnostics?: WakeBackendDiagnostics; error?: string }) => {
            const pending = engine.pending.get(message.requestId);
            if (!pending) return;
            engine.pending.delete(message.requestId);
            clearTimeout(pending.timer);
            if (message.diagnostics) pending.recordDiagnostics(message.diagnostics);
            if (message.error) pending.reject(new Error(message.error));
            else pending.resolve(message.detections);
        });
        worker.on("error", () => { void engine.close(); });
        worker.on("exit", () => { void engine.close(); });
        return engine;
    }

    readonly createBackend = (): WakeBackend => {
        if (this.closed) throw new Error("Wake detection is unavailable; restart the bot and check its logs.");
        if (this.active.size >= 32) throw new Error("Wake detection is busy. Try again shortly.");
        const streamId = ++this.nextStream;
        this.active.add(streamId);
        let destroyed = false;
        let diagnostics: WakeBackendDiagnostics | undefined;
        return {
            getDiagnostics: () => diagnostics ? { ...diagnostics } : undefined,
            accept: (samples, final = false) => {
                if (destroyed || this.closed) return Promise.reject(new Error("Wake detection was cancelled."));
                if (samples.length > 2 * 48_000) return Promise.reject(new Error("Wake audio backlog exceeded two seconds."));
                return new Promise((resolve, reject) => {
                    const requestId = ++this.nextRequest;
                    const timer = setTimeout(() => { void this.close(); }, 5_000);
                    this.pending.set(requestId, { streamId, resolve, reject, timer,
                        recordDiagnostics: (value) => { diagnostics = value; } });
                    // Own a copy; callers may reuse their analysis frame immediately.
                    const copy = samples.slice();
                    try {
                        this.worker.postMessage({ type: "audio", streamId, requestId, samples: copy, final }, [copy.buffer]);
                    } catch {
                        clearTimeout(timer);
                        this.pending.delete(requestId);
                        reject(new Error("Wake worker is unavailable."));
                    }
                });
            },
            destroy: () => {
                if (destroyed) return;
                destroyed = true;
                this.active.delete(streamId);
                for (const [id, pending] of this.pending) {
                    if (pending.streamId !== streamId) continue;
                    clearTimeout(pending.timer);
                    pending.reject(new Error("Wake detection was cancelled."));
                    this.pending.delete(id);
                }
                if (!this.closed) this.worker.postMessage({ type: "close", streamId });
            },
        };
    };

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Wake detector stopped or timed out. Check the bot logs and restart."));
        }
        this.pending.clear();
        this.active.clear();
        await this.worker.terminate();
    }
}

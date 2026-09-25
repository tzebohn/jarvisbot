/** Settle promptly on cancellation, even when a discovery/Discord API ignores the signal. */
export async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work;
    let cancel = () => {};
    try {
        const cancelled = new Promise<never>((_resolve, reject) => {
            cancel = () => reject(signal.reason);
            signal.addEventListener("abort", cancel, { once: true });
            if (signal.aborted) cancel();
        });
        const result = await Promise.race([work, cancelled]);
        signal.throwIfAborted();
        return result;
    } finally { signal.removeEventListener("abort", cancel); }
}

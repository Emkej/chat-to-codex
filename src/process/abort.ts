export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : "Operation was cancelled");
  error.name = "AbortError";
  throw error;
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);

    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    }

    function abort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    }

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

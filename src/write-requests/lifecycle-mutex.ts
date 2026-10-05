import { WriteRequestError } from "./types.js";

/** Single lifecycle owner; abandoned queue entries never run or let successors overtake. */
export class LifecycleMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    let acquired = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(new WriteRequestError("WRITE_READ_UNAVAILABLE", "Write-request read was cancelled."));
        signal?.addEventListener("abort", cancel, { once: true });
        previous.then(() => {
          signal?.removeEventListener("abort", cancel);
          resolve();
        });
        if (signal?.aborted) cancel();
      });
      acquired = true;
      if (signal?.aborted) throw new WriteRequestError("WRITE_READ_UNAVAILABLE", "Write-request read was cancelled.");
      return await work();
    } finally {
      if (acquired) release();
      else void previous.then(release);
    }
  }
}

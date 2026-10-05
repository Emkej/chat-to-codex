import { performance } from "node:perf_hooks";
import { WriteRequestError } from "./types.js";

export const WRITE_OBSERVATION_TIMEOUT_MS = 5_000;

/** One deadline, including transport time and lifecycle queueing. */
export class WriteReadBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly deadline: number;
  private readonly cancel = () => this.controller.abort();

  constructor(private readonly parent?: AbortSignal, timeoutMs = WRITE_OBSERVATION_TIMEOUT_MS) {
    const duration = Math.max(0, Math.min(WRITE_OBSERVATION_TIMEOUT_MS, timeoutMs));
    this.deadline = performance.now() + duration;
    this.signal = this.controller.signal;
    this.timer = setTimeout(this.cancel, duration);
    this.timer.unref();
    parent?.addEventListener("abort", this.cancel, { once: true });
    if (parent?.aborted) this.cancel();
  }

  check(): void {
    if (this.signal.aborted || performance.now() >= this.deadline) {
      this.cancel();
      throw new WriteRequestError("WRITE_READ_UNAVAILABLE", "Write-request read was cancelled or exceeded its deadline.");
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.cancel);
  }
}

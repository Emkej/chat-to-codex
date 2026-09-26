import { MANAGER_REFRESH_INTERVAL_MS, MANAGER_STATUS_TIMEOUT_MS } from "./constants.js";

export interface StatusReadOptions {
  signal: AbortSignal;
}

interface ReadRecord {
  generation: number;
  controller: AbortController;
  promise: Promise<void>;
  timeout: ReturnType<typeof setTimeout> | null;
}

export interface RefreshCoordinatorOptions<T> {
  read(options: StatusReadOptions): Promise<T>;
  commit(value: T): void;
  fail(error: Error): void;
  onReadStart?(): void;
  onReadEnd?(): void;
  refreshIntervalMs?: number;
  timeoutMs?: number;
}

type ReadResult<T> = { kind: "value"; value: T } | { kind: "error"; error: Error } | { kind: "timeout" };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Completion-driven polling with a single active, abortable status read. */
export class RefreshCoordinator<T> {
  private readonly refreshIntervalMs: number;
  private readonly timeoutMs: number;
  private generation = 0;
  private current: ReadRecord | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: RefreshCoordinatorOptions<T>) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? MANAGER_REFRESH_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? MANAGER_STATUS_TIMEOUT_MS;
  }

  start(): void {
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.clearPollTimer();
    if (this.current) return this.current.promise;

    const record: ReadRecord = {
      generation: this.generation,
      controller: new AbortController(),
      promise: Promise.resolve(),
      timeout: null,
    };
    record.promise = this.runRead(record);
    this.current = record;
    return record.promise;
  }

  /** Invalidate a refresh immediately while allowing the foreground action to start. */
  beginForegroundAction(): Promise<void> {
    this.generation += 1;
    this.clearPollTimer();
    const current = this.current;
    current?.controller.abort(new Error("Status read superseded by a foreground action"));
    return current?.promise ?? Promise.resolve();
  }

  /** Start exactly one post-action read after the obsolete read has retired. */
  async refreshAfterAction(retiredRead: Promise<void>): Promise<void> {
    await retiredRead;
    if (this.closed) return;
    await this.refresh();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.clearPollTimer();
    this.current?.controller.abort(new Error("Manager is closing"));
    if (this.current?.timeout) {
      clearTimeout(this.current.timeout);
      this.current.timeout = null;
    }
  }

  private async runRead(record: ReadRecord): Promise<void> {
    await Promise.resolve();
    if (this.closed) return;
    this.options.onReadStart?.();
    const timeoutResult = new Promise<ReadResult<T>>((resolve) => {
      record.timeout = setTimeout(() => {
        record.controller.abort(new Error("Installation status read timed out"));
        resolve({ kind: "timeout" });
      }, this.timeoutMs);
    });
    const readResult: Promise<ReadResult<T>> = Promise.resolve()
      .then(() => this.options.read({ signal: record.controller.signal }))
      .then(
        (value) => ({ kind: "value", value }),
        (error) => ({ kind: "error", error: asError(error) })
      );

    try {
      const result = await Promise.race([readResult, timeoutResult]);
      if (!this.isCurrent(record)) return;
      if (result.kind === "value" && !record.controller.signal.aborted) this.options.commit(result.value);
      else if (result.kind === "timeout") this.options.fail(new Error("Installation status read timed out"));
      else if (result.kind === "error" && !record.controller.signal.aborted) this.options.fail(result.error);
    } catch (error) {
      if (this.isCurrent(record) && !record.controller.signal.aborted) this.options.fail(asError(error));
    } finally {
      if (record.timeout) clearTimeout(record.timeout);
      record.timeout = null;
      if (this.current === record) this.current = null;
      this.options.onReadEnd?.();
      if (!this.closed && this.generation === record.generation) this.scheduleNextRead();
    }
  }

  private isCurrent(record: ReadRecord): boolean {
    return !this.closed && this.generation === record.generation;
  }

  private scheduleNextRead(): void {
    this.clearPollTimer();
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.refresh();
    }, this.refreshIntervalMs);
  }

  private clearPollTimer(): void {
    if (!this.pollTimer) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Workspace } from "../workspace/manager.js";
import { signalLinuxProcessIdentity } from "../broker/process-identity.js";
import { LifecycleMutex } from "../write-requests/lifecycle-mutex.js";
import { CommandRequestStore } from "./store.js";
import { runCommand, type CommandRun, type RunnerOptions, type RunnerOutcome } from "./runner.js";
import { CommandRequestError, WINDOW_MS, emptyResult, terminal, validateInput, type CommandRecord } from "./types.js";

export interface CommandTarget { workspaceId: string; worktreeId?: string; workspace: Workspace }
export interface CommandServiceOptions {
  store: CommandRequestStore;
  resolveTarget: (workspaceId: string, worktreeId?: string) => CommandTarget;
  now?: () => number;
  runnerOptions?: RunnerOptions;
  signalLeader?: typeof signalLinuxProcessIdentity;
}
export class CommandRequestService {
  private readonly mutex = new LifecycleMutex();
  private active?: { record: CommandRecord; run: CommandRun; settled: Promise<void> };
  private blocked = false;
  private closing = false;
  private initialized = false;
  constructor(private readonly options: CommandServiceOptions) {}
  private now(): number { return (this.options.now ?? Date.now)(); }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private requireReady(): void {
    if (!this.initialized) throw new CommandRequestError("INTERNAL_ERROR", "Command service is unavailable.");
  }
  async initialize(): Promise<void> {
    await this.mutex.run(async () => {
      for (const record of this.options.store.list()) {
        if (record.status !== "running") continue;
        let termination: NonNullable<CommandRecord["result"]>["termination"] = "absent";
        try {
          if (record.leader) {
            const result = await (this.options.signalLeader ?? signalLinuxProcessIdentity)(record.leader);
            termination = result === "signaled" ? "leader" : result;
          }
        } catch { termination = "unavailable"; }
        this.options.store.update({ ...record, status: "interrupted", resolvedAt: this.timestamp(), resolutionCode: "BROKER_RESTART", result: { ...emptyResult(true), termination } });
      }
      this.prune();
      this.initialized = true;
    });
  }
  private project(record: CommandRecord, now: number): CommandRecord {
    return record.status === "pending" && Date.parse(record.expiresAt) <= now
      ? { ...record, status: "expired", resolvedAt: record.expiresAt, resolutionCode: "COMMAND_REQUEST_EXPIRED" } : record;
  }
  private prune(): void {
    const now = this.now();
    for (const stored of this.options.store.list()) {
      if (stored.id === this.active?.record.id) continue;
      const record = this.project(stored, now);
      if (terminal(record) && Date.parse(record.resolvedAt!) + WINDOW_MS <= now) this.options.store.remove(record.id);
      else if (stored.status !== record.status) this.options.store.update(record);
    }
  }
  private load(id: string, now: number): CommandRecord {
    const stored = this.options.store.get(id);
    if (!stored) throw new CommandRequestError("COMMAND_REQUEST_NOT_FOUND", "Command request was not found.");
    const record = this.project(stored, now);
    if (terminal(record) && Date.parse(record.resolvedAt!) + WINDOW_MS <= now) {
      throw new CommandRequestError("COMMAND_RESULT_UNAVAILABLE", "Command result is no longer available.");
    }
    return record;
  }
  /** Pure reads: no expiry persistence or cleanup, even at availability cutoffs. */
  get(id: string, target?: { workspaceId: string; worktreeId?: string }): CommandRecord {
    this.requireReady();
    const pinned = this.blocked && this.active?.record.id === id ? this.active.record : undefined;
    const stored = pinned ?? this.options.store.get(id);
    if (target && (!stored || stored.workspaceId !== target.workspaceId || stored.worktreeId !== target.worktreeId)) {
      throw new CommandRequestError("COMMAND_REQUEST_NOT_FOUND", "Command request was not found.");
    }
    return pinned ? structuredClone(pinned) : this.load(id, this.now());
  }
  listPending(target?: { workspaceId: string; worktreeId?: string }): CommandRecord[] {
    this.requireReady();
    const now = this.now();
    return this.options.store.list().map((r) => this.project(r, now)).filter((r) => r.status === "pending" &&
      (!target || (r.workspaceId === target.workspaceId && r.worktreeId === target.worktreeId)));
  }
  private cwd(workspaceId: string, worktreeId: string | undefined, cwd: string): { abs: string; rel: string } {
    let target: CommandTarget;
    try { target = this.options.resolveTarget(workspaceId, worktreeId); }
    catch {
      throw new CommandRequestError(worktreeId ? "WORKTREE_UNAVAILABLE" : "WORKSPACE_UNAVAILABLE", "Command target is unavailable.");
    }
    try {
      if (path.posix.isAbsolute(cwd) || path.win32.isAbsolute(cwd) || /^[A-Za-z]:/.test(cwd) || /^workspace:/i.test(cwd)) throw new Error();
      const resolved = target.workspace.resolve(cwd, { allowSensitive: true });
      if (!fs.statSync(resolved.abs).isDirectory()) throw new Error();
      return { abs: resolved.abs, rel: resolved.rel || "." };
    } catch (e) {
      if (e instanceof CommandRequestError) throw e;
      const code = (e as { code?: string }).code;
      if (code === "UNKNOWN_WORKSPACE") throw new CommandRequestError("WORKSPACE_UNAVAILABLE", "Workspace is unavailable.");
      if (code?.startsWith("WORKTREE_")) throw new CommandRequestError("WORKTREE_UNAVAILABLE", "Worktree is unavailable.");
      throw new CommandRequestError("COMMAND_INVALID", "Command cwd must resolve to a directory within the target.");
    }
  }
  async create(input: { workspaceId: string; worktreeId?: string; argv: string[]; cwd?: string; reason: string }): Promise<CommandRecord> {
    return this.mutex.run(() => {
      this.requireReady(); this.prune();
      const cwd = input.cwd ?? ".";
      validateInput(input.argv, cwd, input.reason);
      const resolved = this.cwd(input.workspaceId, input.worktreeId, cwd);
      const now = this.now();
      const record: CommandRecord = {
        id: `cr_${randomBytes(12).toString("hex")}`, kind: "command", status: "pending",
        workspaceId: input.workspaceId, ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
        argv: [...input.argv], cwd: resolved.rel, reason: input.reason,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + WINDOW_MS).toISOString(),
      };
      this.options.store.create(record);
      return structuredClone(record);
    });
  }
  private pending(id: string): CommandRecord {
    const record = this.load(id, this.now());
    if (record.status === "expired") throw new CommandRequestError("COMMAND_REQUEST_EXPIRED", "Command request expired.");
    if (record.status !== "pending") throw new CommandRequestError("COMMAND_REQUEST_NOT_PENDING", "Command request is not pending.");
    return record;
  }
  async reject(id: string): Promise<CommandRecord> {
    return this.mutex.run(() => {
      this.requireReady(); this.prune();
      const record: CommandRecord = { ...this.pending(id), status: "rejected", resolvedAt: this.timestamp() };
      this.options.store.update(record); this.prune();
      return record;
    });
  }
  async approve(id: string): Promise<CommandRecord> {
    return this.mutex.run(async () => {
      this.requireReady(); this.prune();
      const pending = this.pending(id);
      if (this.active || this.blocked || this.closing) throw new CommandRequestError("COMMAND_BUSY", "Command execution is busy or requires broker recovery.");
      const cwd = this.cwd(pending.workspaceId, pending.worktreeId, pending.cwd);
      const record: CommandRecord = { ...pending, status: "running" };
      this.options.store.update(record); // Durable claim before any process attempt.
      const run = runCommand(record.argv, cwd.abs, this.options.runnerOptions);
      const settled = run.done.then((outcome) => this.mutex.run(() => this.resolve(record, outcome)));
      this.active = { record, run, settled };
      const spawned = await run.started;
      if (!spawned) {
        const outcome = await run.done;
        this.resolve(record, outcome);
        const receipt = this.get(id);
        if (receipt.status === "running") throw new CommandRequestError("INTERNAL_ERROR", "Command terminal state could not be persisted.");
        return receipt;
      }
      Object.assign(record, spawned);
      try { this.options.store.update(record); }
      catch (e) { this.blocked = true; void run.interrupt("COMMAND_OUTPUT_INCOMPLETE"); throw e; }
      return structuredClone(record);
    });
  }
  private resolve(record: CommandRecord, outcome: RunnerOutcome): void {
    // The pre-spawn path can persist synchronously before the queued completion runs.
    if (this.active?.record.id !== record.id) return;
    try {
      this.options.store.update({ ...record, ...outcome, resolvedAt: this.timestamp() });
      this.active = undefined;
      this.prune();
    } catch { this.blocked = true; /* Durable running stays non-retryable. */ }
  }
  async close(): Promise<void> {
    this.closing = true;
    const active = this.active;
    if (active) { await active.run.interrupt("BROKER_SHUTDOWN"); await active.settled; }
  }
}

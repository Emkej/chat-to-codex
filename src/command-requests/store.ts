import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { COMMAND_ID, CommandRequestError, OUTPUT_BYTES, terminal, validateInput, type CommandRecord } from "./types.js";

const KEYS = new Set(["id", "kind", "status", "workspaceId", "worktreeId", "argv", "cwd", "reason", "createdAt", "expiresAt", "startedAt", "resolvedAt", "resolutionCode", "leader", "result"]);
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
function validate(value: unknown): asserts value is CommandRecord {
  const r = value as CommandRecord;
  if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((key) => !KEYS.has(key)) ||
    !COMMAND_ID.test(r.id) || r.kind !== "command" ||
    !["pending", "running", "completed", "failed", "interrupted", "rejected", "expired"].includes(r.status) ||
    typeof r.workspaceId !== "string" || !r.workspaceId ||
    (r.worktreeId !== undefined && (typeof r.worktreeId !== "string" || !r.worktreeId)) ||
    !date(r.createdAt) || !date(r.expiresAt) || (r.startedAt !== undefined && !date(r.startedAt)) ||
    (terminal(r) ? !date(r.resolvedAt) : r.resolvedAt !== undefined) ||
    (r.resolutionCode !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(r.resolutionCode))) throw new Error("Invalid record");
  validateInput(r.argv, r.cwd, r.reason);
  if (r.leader !== undefined && (Object.keys(r.leader).sort().join() !== "pid,startTimeTicks" ||
    !Number.isSafeInteger(r.leader.pid) || r.leader.pid <= 0 || !/^\d+$/.test(r.leader.startTimeTicks))) throw new Error("Invalid leader");
  const execution = ["completed", "failed", "interrupted"].includes(r.status);
  if (execution !== (r.result !== undefined)) throw new Error("Invalid result state");
  if (r.status === "pending" && (r.startedAt || r.leader)) throw new Error("Invalid pending state");
  if (r.status === "completed" && (!r.startedAt || r.result?.outputIncomplete)) throw new Error("Invalid completion");
  if (r.result) {
    const out = r.result;
    if (Object.keys(out).some((key) => !["exitCode", "signal", "stdout", "stderr", "stdoutTruncated", "stderrTruncated", "outputIncomplete", "termination"].includes(key)) ||
      !(out.exitCode === null || Number.isSafeInteger(out.exitCode)) || !(out.signal === null || typeof out.signal === "string") ||
      typeof out.stdout !== "string" || typeof out.stderr !== "string" ||
      Buffer.byteLength(out.stdout) > OUTPUT_BYTES || Buffer.byteLength(out.stderr) > OUTPUT_BYTES ||
      [out.stdoutTruncated, out.stderrTruncated, out.outputIncomplete].some((v) => typeof v !== "boolean") ||
      (out.termination !== undefined && !["group", "leader", "absent", "different", "unavailable"].includes(out.termination))) throw new Error("Invalid output");
  }
}
function storageError(): CommandRequestError {
  return new CommandRequestError("INTERNAL_ERROR", "Command state could not be read or persisted.");
}

/** Installation writer lease is held by the broker; this store introduces no second owner. */
export class CommandRequestStore {
  readonly directory: string;
  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.directory = path.join(fs.realpathSync(stateDir), "command-requests");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw storageError();
    fs.chmodSync(this.directory, 0o700);
  }
  private file(id: string): string {
    if (!COMMAND_ID.test(id)) throw new CommandRequestError("COMMAND_REQUEST_NOT_FOUND", "Command request was not found.");
    return path.join(this.directory, `${id}.json`);
  }
  get(id: string): CommandRecord | null {
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.file(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw storageError();
      const r: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
      validate(r);
      if (r.id !== id) throw storageError();
      return r;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (e instanceof CommandRequestError && e.code === "COMMAND_REQUEST_NOT_FOUND") throw e;
      throw storageError();
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  list(): CommandRecord[] {
    return fs.readdirSync(this.directory).filter((name) => name.endsWith(".json")).map((name) => {
      const r = this.get(name.slice(0, -5));
      if (!r) throw storageError();
      return r;
    });
  }
  create(record: CommandRecord): void { this.persist(record, true); }
  update(record: CommandRecord): void { this.persist(record, false); }
  remove(id: string): void { fs.unlinkSync(this.file(id)); }
  private persist(record: CommandRecord, create: boolean): void {
    const file = this.file(record.id);
    const temp = path.join(this.directory, `.${record.id}.${randomBytes(8).toString("hex")}.tmp`);
    let fd: number | undefined;
    try {
      validate(record);
      if (!create && !this.get(record.id)) throw storageError();
      fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      if (create) { fs.linkSync(temp, file); fs.unlinkSync(temp); }
      else fs.renameSync(temp, file);
      const dir = fs.openSync(this.directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch {
      throw storageError();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch { /* already renamed/removed */ }
    }
  }
}

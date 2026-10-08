import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "./helpers.js";

const probe = vi.hoisted(() => ({ mode: "group", trace: "" }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: (file: string, args: string[], opts: object, callback: (...args: unknown[]) => void) => {
    // Execute the real Python helper with controlled syscall/procfs seams. No OS signal is sent.
    const prefix = [
      "import os, signal, builtins, io, errno",
      `mode = ${JSON.stringify(probe.mode)}`,
      `trace = ${JSON.stringify(probe.trace)}`,
      "def fake_open(pid, flags):",
      "    if mode == 'absent': raise ProcessLookupError()",
      "    return 7",
      "os.pidfd_open = fake_open",
      "os.close = lambda fd: None",
      "fields = ['S','1','123'] + ['0'] * 16 + [('999' if mode == 'different' else '456')]",
      "if mode == 'not-leader': fields[2] = '1'",
      "real_open = builtins.open",
      "builtins.open = lambda *a, **k: io.StringIO('123 (fixture) ' + ' '.join(fields))",
      "def send(fd, sig, info=None, flags=0):",
      "    with real_open(trace, 'a') as output: output.write(str(flags) + '\\n')",
      "    if flags == 4 and mode == 'unsupported': raise OSError(errno.EINVAL, 'unsupported')",
      "    if mode == 'exit-race': raise ProcessLookupError()",
      "signal.pidfd_send_signal = send",
    ].join("\n");
    return actual.execFile(file, [args[0]!, prefix + "\n" + args[1], ...args.slice(2)], opts, callback as never);
  } };
});
import { signalLinuxOwnedProcessGroup, signalLinuxProcessIdentity } from "../src/broker/process-identity.js";

describe("pidfd-bound command signaling runtime branches", () => {
  it.each([
    ["group", "group", "4\n"], ["unsupported", "signaled", "4\n0\n"],
    ["not-leader", "signaled", "0\n"], ["different", "different", ""],
    ["absent", "absent", ""], ["exit-race", "absent", "4\n"],
  ])("%s uses only the bound pidfd", async (mode, expected, trace) => {
    probe.mode = mode; probe.trace = path.join(makeTmpDir("signal-probe"), "trace");
    expect(await signalLinuxOwnedProcessGroup({ pid: 123, startTimeTicks: "456" })).toBe(expected);
    expect(fs.existsSync(probe.trace) ? fs.readFileSync(probe.trace, "utf8") : "").toBe(trace);
  });
  it("restart's existing helper never attempts group signaling", async () => {
    probe.mode = "group"; probe.trace = path.join(makeTmpDir("restart-signal"), "trace");
    expect(await signalLinuxProcessIdentity({ pid: 123, startTimeTicks: "456" })).toBe("signaled");
    expect(fs.readFileSync(probe.trace, "utf8")).toBe("0\n");
  });
});

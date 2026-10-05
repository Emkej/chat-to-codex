"""Disposable tmux acceptance probe; never reads or writes the user's profile."""
import argparse
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, **kwargs).strip()


def wait_for(read, expected, timeout=6):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = read()
        if expected in value:
            return value
        time.sleep(0.04)
    raise AssertionError(f"Expected terminal marker: {expected}")


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def launch(tmux, scratch, state, entry, width, slow=False):
    env = dict(os.environ, C2C_STATE_DIR=str(state), C2C_PROFILE="change007-fixture", TERM="xterm-256color")
    if slow:
        env["PATH"] = str(scratch / "commands") + ":" + env["PATH"]
        env["C2C_DETAIL_SLOW_PID"] = str(scratch / "pids.json")
    child = scratch / "manager.pid"
    command = f"printf 'NORMAL_SCREEN_MARKER\\n'; {shlex.join(entry)} manager; printf 'RETURNED_SCREEN_MARKER\\n'; exec bash --noprofile --norc"
    overrides = [item for name in ("PATH", "C2C_STATE_DIR", "C2C_PROFILE", "TERM", "C2C_DETAIL_SLOW_PID") if name in env for item in ("-e", name + "=" + env[name])]
    tmux("new-session", "-d", "-x", str(width), "-y", "24", "-s", "ui", *overrides, command, env=env)
    screen = lambda: tmux("capture-pane", "-p", "-t", "ui")
    wait_for(screen, "Start broker")
    pane_pid = tmux("display-message", "-p", "-t", "ui", "#{pane_pid}")
    child.write_text(run("ps", "-o", "pid=", "--ppid", pane_pid).split()[0])
    return screen, child


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--entry", required=True)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[4]
    scratch = Path(tempfile.mkdtemp(prefix="change007-terminal-", dir=root / "work"))
    socket = "c2c-change007-" + str(os.getpid())
    tmux = lambda *items, **kwargs: run("tmux", "-L", socket, *items, **kwargs)
    results = []
    entry = ["node", args.entry]
    try:
        repo = scratch / "repo"
        repo.mkdir()
        run("git", "init", "-b", "main", str(repo))
        (repo / "fixture.txt").write_text("fixture\n")
        run("git", "-C", str(repo), "add", ".")
        run("git", "-C", str(repo), "-c", "user.name=C2C-test", "-c", "user.email=test@c2c.local", "commit", "-m", "fixture")
        for index in range(12):
            branch = f"detail-{index:02d}-" + "b" * 100 + f"-END{index:02d}"
            run("git", "-C", str(repo), "worktree", "add", "-b", branch, str(scratch / f"tree-{index}"))
        state = scratch / "state"
        (state / "workspaces").mkdir(parents=True)
        (state / "installation.json").write_text(json.dumps({"installationId": "c2c_inst_fixture", "schemaVersion": 1, "createdAt": "2026-10-04T00:00:00Z"}))
        workspace_id = "opaque-" + "id" * 65
        workspace_name = "Workspace " + "N" * 150
        rows = [{"id": workspace_id, "displayName": workspace_name, "canonicalRoot": str(repo), "registeredAt": "2026-10-04", "updatedAt": "2026-10-04"}]
        (state / "workspaces/registry.json").write_text(json.dumps({"schemaVersion": 1, "workspaces": rows}))
        before_state = {str(file.relative_to(state)): file.read_bytes() for file in state.rglob("*") if file.is_file()}
        commands = scratch / "commands"
        commands.mkdir()
        (commands / "package.json").write_text('{"type":"commonjs"}\n')
        git = commands / "git"
        git.write_text("#!/usr/bin/env node\nconst fs=require('node:fs'); const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.on('SIGTERM',()=>{}); fs.writeFileSync(process.env.C2C_DETAIL_SLOW_PID,JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);\n")
        git.chmod(0o700)
        for width in (80, 120):
            screen, _ = launch(tmux, scratch, state, entry, width)
            tmux("send-keys", "-t", "ui", "Enter")
            wait_for(screen, "Worktree id:")
            tmux("send-keys", "-t", "ui", "Down")
            wait_for(screen, "Workspace detail · 2–")
            tmux("send-keys", "-t", "ui", "Up")
            wait_for(screen, "Workspace detail · 1–")
            tmux("send-keys", "-t", "ui", "NPage")
            wait_for(screen, "Workspace detail · 21–")
            tmux("send-keys", "-t", "ui", "PPage")
            wait_for(screen, "Workspace detail · 1–")
            captures = [screen()]
            previous = ""
            while captures[-1] != previous:
                previous = captures[-1]
                tmux("send-keys", "-t", "ui", "NPage")
                time.sleep(0.1)
                captures.append(screen())
                assert len(captures) < 40
            combined = "\n".join(captures)
            for index in range(12):
                assert f"END{index:02d}" in combined, index
            for capture in captures:
                assert "Esc Back" in capture and "[q] Quit" in capture
                assert str(scratch) not in capture
            before = screen().splitlines()[0]
            prior_offset = int(re.search(r"· (\d+)–", before)[1]) - 1
            tmux("send-keys", "-t", "ui", "r")
            wait_for(screen, "Worktree id:")
            time.sleep(0.4)
            assert screen().splitlines()[0] == before
            tmux("resize-window", "-t", "ui", "-x", str(120 if width == 80 else 80), "-y", "24")
            time.sleep(0.2)
            assert "Esc Back" in screen()
            header = re.search(r"· (\d+)–\d+ / (\d+)", screen().splitlines()[0])
            assert int(header[1]) - 1 == min(prior_offset, max(0, int(header[2]) - 20))
            if width == 120:
                for index in range(2, 12):
                    run("git", "-C", str(repo), "worktree", "remove", str(scratch / f"tree-{index}"))
                tmux("send-keys", "-t", "ui", "r")
                wait_for(screen, "Workspace detail · 1–")
                wait_for(screen, "Worktree id:")
            tmux("send-keys", "-t", "ui", "Escape")
            wait_for(screen, "Start broker")
            tmux("send-keys", "-t", "ui", "Enter")
            wait_for(screen, "Name: Workspace")
            tmux("send-keys", "-t", "ui", "Escape")
            wait_for(screen, "Start broker")
            tmux("send-keys", "-t", "ui", "q")
            wait_for(screen, "RETURNED_SCREEN_MARKER")
            tmux("send-keys", "-t", "ui", "printf FOLLOWUP_OK", "Enter")
            wait_for(screen, "FOLLOWUP_OK")
            results.append({"dimensions": f"{width}x24", "overflow_and_all_branch_suffixes": "passed", "refresh_offset_preserved": "passed", "resize_offset_clamped": "passed", "refresh_after_fixture_inventory_shrink": "passed" if width == 120 else "not run", "Esc_selection_preserved": "passed", "normal_screen_restored": "passed"})
            tmux("kill-session", "-t", "ui")
        for method in ("q", "Ctrl+C", "SIGTERM", "Esc+q", "deadline+q"):
            (scratch / "pids.json").unlink(missing_ok=True)
            screen, manager_pid = launch(tmux, scratch, state, entry, 80, slow=True)
            tmux("send-keys", "-t", "ui", "Enter")
            wait_for(screen, "Loading worktrees...")
            wait_for(lambda: "ready" if (scratch / "pids.json").exists() else "", "ready")
            pids = json.loads((scratch / "pids.json").read_text())
            if method == "deadline+q":
                wait_for(screen, "Workspace detail is unavailable.", 6)
                assert "No derived worktrees." not in screen()
            started = time.monotonic()
            if method == "SIGTERM":
                os.kill(int(manager_pid.read_text()), 15)
            elif method == "Ctrl+C":
                tmux("send-keys", "-t", "ui", "C-c")
            else:
                if method == "Esc+q":
                    tmux("send-keys", "-t", "ui", "Escape")
                    wait_for(screen, "[Enter] Detail", 1)
                tmux("send-keys", "-t", "ui", "q")
            restored = wait_for(screen, "RETURNED_SCREEN_MARKER", 2)
            elapsed = time.monotonic() - started
            if "NORMAL_SCREEN_MARKER" not in restored or elapsed >= 2:
                excerpt = restored.replace(str(scratch), "[fixture]").replace(str(root), "[repository]").replace(str(Path.home()), "[home]")
                raise AssertionError(json.dumps({"method": method, "elapsed": elapsed, "alternate_screen": tmux("display-message", "-p", "-t", "ui", "#{alternate_on}"), "screen": excerpt}))
            wait_for(lambda: "reaped" if all(not alive(pid) for pid in pids) else "", "reaped", 2)
            tmux("send-keys", "-t", "ui", "printf FOLLOWUP_OK", "Enter")
            wait_for(screen, "FOLLOWUP_OK")
            results.append({"slow_read_exit": method, "loading_visible": True, "restoration_seconds": round(elapsed, 3), "owned_processes_retired": True, "normal_screen_usable": True})
            tmux("kill-session", "-t", "ui")
        after_state = {str(file.relative_to(state)): file.read_bytes() for file in state.rglob("*") if file.is_file()}
        assert before_state == after_state
        evidence = {"entry": args.label, "terminal": run("tmux", "-V"), "fixture_only": True, "services_started": False, "persistent_state_unchanged": True, "results": results}
        (Path(__file__).parent / f"terminal-{args.label}.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(evidence, indent=2))
    finally:
        subprocess.run(["tmux", "-L", socket, "kill-server"], capture_output=True)
        shutil.rmtree(scratch)


if __name__ == "__main__":
    main()

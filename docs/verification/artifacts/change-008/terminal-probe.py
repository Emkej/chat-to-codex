"""Candidate build acceptance in disposable tmux terminals; no live profile writes."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tempfile
import time

REPOSITORY = Path(__file__).resolve().parents[4]
ARTIFACTS = Path(__file__).parent


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, **kwargs).strip()


def wait(read, expected, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = read()
        if expected in value:
            return value
        time.sleep(0.025)
    raise AssertionError(f"Missing terminal marker: {expected}")


def inventory(state):
    return {str(file.relative_to(state)): hashlib.sha256(file.read_bytes()).hexdigest()
            for file in (state / "write-requests").glob("*.json")}


def main():
    scratch = Path(tempfile.mkdtemp(prefix="change008-terminal-", dir=REPOSITORY / "work"))
    socket = "c2c-change008-" + str(os.getpid())
    tmux = lambda *args: run("tmux", "-L", socket, *args)
    state = scratch / "state"
    env = dict(os.environ, C2C_STATE_DIR=str(state), C2C_PROBE_DIR=str(scratch), TERM="xterm-256color")
    fixture_log = open(scratch / "fixture.log", "w")
    broker = subprocess.Popen(["node", str(ARTIFACTS / "terminal-fixture.mjs")], env=env, stdout=fixture_log, stderr=fixture_log)
    results = []
    try:
        wait(lambda: "ready" if (scratch / "ready.json").exists() else "", "ready")
        ready = json.loads((scratch / "ready.json").read_text())
        before = inventory(state)
        # Use the installed launcher without replacing installed files. Only its
        # entry import resolves to this candidate build for the probe process.
        installed_entry = Path(run("readlink", "-f", "/usr/local/bin/c2c"))
        candidate = (REPOSITORY / "dist/cli/index.js").as_uri()
        original = (installed_entry.parent.parent / "dist/cli/index.js").as_uri()
        loader = scratch / "candidate-loader.mjs"
        loader.write_text("export async function resolve(s,c,n){if(s===" + json.dumps(original) +
                          "){return {url:" + json.dumps(candidate) + ",shortCircuit:true};}return n(s,c);}\n")

        def launch(width, installed=False):
            entry = ["c2c"] if installed else ["node", str(REPOSITORY / "bin/c2c.js")]
            if installed:
                entry = ["node", "--no-warnings", "--experimental-loader", str(loader), str(installed_entry)]
            command = "printf 'NORMAL_SCREEN_MARKER\\n'; " + shlex.join(entry + ["manager"]) + "; printf 'RETURNED_SCREEN_MARKER\\n'; exec bash --noprofile --norc"
            tmux("new-session", "-d", "-x", str(width), "-y", "24", "-s", "ui",
                 "-e", "C2C_STATE_DIR=" + str(state), "-e", "TERM=xterm-256color", command)
            screen = lambda: tmux("capture-pane", "-p", "-t", "ui")
            wait(screen, "pending 1")
            pane_pid = tmux("display-message", "-p", "-t", "ui", "#{pane_pid}")
            manager_pid = int(run("ps", "-o", "pid=", "--ppid", pane_pid).split()[0])
            return screen, manager_pid

        def finish(screen, method="q", manager_pid=None):
            started = time.monotonic()
            if method == "SIGTERM":
                os.kill(manager_pid, signal.SIGTERM)
            else:
                tmux("send-keys", "-t", "ui", "C-c" if method == "Ctrl+C" else "q")
            restored = wait(screen, "RETURNED_SCREEN_MARKER", 2)
            duration = time.monotonic() - started
            assert "NORMAL_SCREEN_MARKER" in restored and duration < 2
            tmux("send-keys", "-t", "ui", "printf FOLLOWUP_OK", "Enter")
            wait(screen, "FOLLOWUP_OK")
            tmux("kill-session", "-t", "ui")
            return round(duration, 3)

        for installed in (False, True):
            for width in (80, 120):
                screen, manager_pid = launch(width, installed)
                tmux("send-keys", "-t", "ui", "w")
                wait(screen, ready["id"])
                tmux("send-keys", "-t", "ui", "Enter")
                wait(screen, "Diff (controls")
                seen = screen()
                for _ in range(30):
                    tmux("send-keys", "-t", "ui", "NPage")
                    time.sleep(0.05)
                    seen += screen()
                    if "END-59" in seen:
                        break
                missing = [i for i in range(60) if "END-" + str(i) not in seen]
                assert not missing, json.dumps({"missing_suffixes": missing, "last_screen": screen()})
                assert "\\u{001b}[31m" in seen and "\\\\u{001b}" in seen
                tmux("resize-window", "-t", "ui", "-x", "100" if width == 80 else "80", "-y", "24")
                tmux("send-keys", "-t", "ui", "v")
                wait(screen, "confirms")
                tmux("send-keys", "-t", "ui", "n")
                assert inventory(state) == before
                assert not (scratch / "applied").exists()
                tmux("send-keys", "-t", "ui", "Escape")
                wait(screen, "expires ")
                tmux("send-keys", "-t", "ui", "Escape")
                wait(screen, "pending 1")
                results.append({"entry": "installed launcher + candidate import" if installed else "local build", "columns": width,
                                "all_hunks_reachable": True, "visible_controls": True, "resize": True,
                                "cancelled_confirmation_no_effect": True, "request_bytes_unchanged": True,
                                "restoration_seconds": finish(screen, manager_pid=manager_pid)})

        for method in ("q", "Ctrl+C", "SIGTERM", "deadline+q"):
            screen, manager_pid = launch(80)
            (scratch / "mode").write_text("slow-read")
            (scratch / "read-started").unlink(missing_ok=True)
            tmux("send-keys", "-t", "ui", "w")
            wait(screen, "Loading pending")
            wait(lambda: "ready" if (scratch / "read-started").exists() else "", "ready")
            if method == "deadline+q":
                wait(screen, "Pending requests unavailable", 6)
                assert "No active pending requests." not in screen()
            duration = finish(screen, "q" if method == "deadline+q" else method, manager_pid)
            (scratch / "mode").write_text("normal")
            assert inventory(state) == before
            results.append({"slow_read_exit": method, "restoration_seconds": duration, "request_bytes_unchanged": True})

        # Exit after dispatch cannot roll back the broker operation. Verify all
        # exit methods with fresh proposals and a real subsequent apply.
        import urllib.request
        runtime = json.loads(next((state / "runtime").glob("*.json")).read_text())
        def admin(route, body):
            request = urllib.request.Request("http://127.0.0.1:" + str(ready["port"]) + route,
                        data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + runtime["adminToken"], "Content-Type": "application/json"})
            return json.loads(urllib.request.urlopen(request, timeout=3).read())
        for index, method in enumerate(("q", "Ctrl+C", "SIGTERM")):
            screen, manager_pid = launch(80)
            tmux("send-keys", "-t", "ui", "w")
            wait(screen, ready["id"])
            time.sleep(0.15)
            tmux("send-keys", "-t", "ui", "Enter")
            wait(screen, "Diff (controls")
            (scratch / "mode").write_text("slow-approve")
            (scratch / "approval-started").unlink(missing_ok=True)
            (scratch / "applied").unlink(missing_ok=True)
            tmux("send-keys", "-t", "ui", "v")
            wait(screen, "confirms")
            tmux("send-keys", "-t", "ui", "y")
            wait(lambda: "ready" if (scratch / "approval-started").exists() else "", "ready")
            wait(screen, "UNKNOWN approval outcome: " + ready["id"])
            duration = finish(screen, method, manager_pid)
            (scratch / "mode").write_text("normal")
            wait(lambda: "ready" if (scratch / "applied").exists() else "", "ready")
            canonical = json.loads((state / "write-requests" / (ready["id"] + ".json")).read_text())
            assert canonical["status"] == "applied" and "patch" not in canonical
            results.append({"dispatched_approval_exit": method, "restoration_seconds": duration, "broker_applied_after_exit": True})
            if index < 2:
                # A different file avoids stale preconditions or duplicate applies.
                target = "next-" + str(index) + ".txt"
                created = admin("/admin/write-requests", {"workspaceId": ready["workspaceId"], "patch": "--- /dev/null\n+++ b/" + target + "\n@@ -0,0 +1 @@\n+next\n"})
                ready["id"] = created["id"]
        target = "visible-approval.txt"
        created = admin("/admin/write-requests", {"workspaceId": ready["workspaceId"], "patch": "--- /dev/null\n+++ b/" + target + "\n@@ -0,0 +1 @@\n+visible\n"})
        ready["id"] = created["id"]
        screen, manager_pid = launch(120, installed=True)
        tmux("send-keys", "-t", "ui", "w")
        wait(screen, ready["id"])
        time.sleep(0.15)
        tmux("send-keys", "-t", "ui", "Enter")
        wait(screen, "Diff (controls")
        tmux("send-keys", "-t", "ui", "v")
        wait(screen, "confirms")
        tmux("send-keys", "-t", "ui", "y")
        wait(screen, "Status: applied")
        assert (scratch / "project" / target).read_text() == "visible\n"
        try:
            admin("/admin/write-requests/" + ready["id"] + "/approve", {})
            raise AssertionError("Repeated approval must fail")
        except urllib.error.HTTPError as error:
            assert error.code == 409
        tmux("send-keys", "-t", "ui", "Escape")
        wait(screen, "expires ")
        tmux("send-keys", "-t", "ui", "Escape")
        wait(screen, "pending 0")
        results.append({"entry": "installed launcher + candidate import", "columns": 120,
                        "explicit_approval_applied_once": True, "terminal_receipt_visible": True, "count_refreshed_to_zero": True,
                        "restoration_seconds": finish(screen, manager_pid=manager_pid)})
        evidence = {"fixture_only": True, "live_profile_untouched": True, "installed_files_unchanged": True,
                    "installed_note": "Installed launcher exercised through a temporary process-only entry import redirect to the candidate build; candidate is not installed.",
                    "terminal": run("tmux", "-V"), "results": results}
        (ARTIFACTS / "terminal-acceptance.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps({"status": "passed", "cases": len(results), "artifact": str(ARTIFACTS / "terminal-acceptance.json")}))
    finally:
        subprocess.run(["tmux", "-L", socket, "kill-server"], capture_output=True)
        (scratch / "mode").write_text("normal")
        broker.terminate()
        try:
            broker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            broker.kill()
            broker.wait()
        fixture_log.close()
        shutil.rmtree(scratch)


if __name__ == "__main__":
    main()

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../src/workspace/manager.js";
import { preparePatch, MAX_PATCH_BYTES, MAX_SOURCE_BYTES } from "../src/write-requests/patch.js";
import { WriteRequestService } from "../src/write-requests/service.js";
import { WriteRequestStore } from "../src/write-requests/store.js";
import { WriteRequestError, type WriteRequestRecord } from "../src/write-requests/types.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) cleanup(dir);
});

function directory(name: string): string {
  const result = makeTmpDir(name);
  dirs.push(result);
  return result;
}

function updatePatch(pathName = "file.txt", before = "before", after = "after"): string {
  return "--- a/" + pathName + "\n+++ b/" + pathName + "\n@@ -1 +1 @@\n-" + before + "\n+" + after + "\n";
}

function multiUpdatePatch(): string {
  return "--- a/first.txt\n+++ b/first.txt\n@@ -1 +1 @@\n-first\n+changed-first\n" +
    "--- a/second.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-second\n+changed-second\n";
}

function serviceFor(
  workspace: Workspace,
  stateDir: string,
  options: { now?: () => number; applyHooks?: ConstructorParameters<typeof WriteRequestService>[0]["applyHooks"]; store?: WriteRequestStore } = {}
): WriteRequestService {
  return new WriteRequestService({
    store: options.store ?? new WriteRequestStore(stateDir),
    resolveTarget: (workspaceId, worktreeId) => ({ workspace, workspaceId, ...(worktreeId ? { worktreeId } : {}) }),
    protectedRoots: [stateDir],
    now: options.now,
    applyHooks: options.applyHooks,
  });
}

describe("unified text patch preparation", () => {
  it("preserves BOM, CRLF, untouched bytes, and exact file mode", () => {
    const root = directory("patch-crlf");
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("keep\r\nbefore\r\nlast\r\n")]);
    const file = path.join(root, "file.txt");
    fs.writeFileSync(file, raw);
    fs.chmodSync(file, 0o640);
    const workspace = new Workspace(root);
    const prepared = preparePatch(workspace,
      "--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n keep\n-before\n+after\n last\n");

    expect(prepared.files[0].resultBytes).toEqual(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("keep\r\nafter\r\nlast\r\n")])
    );
    expect(prepared.files[0].beforeMode).toBe(0o640);
  });

  it("creates a UTF-8 file and honors the no-final-newline marker", () => {
    const workspace = new Workspace(directory("patch-create"));
    const prepared = preparePatch(workspace,
      "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new text\n\\ No newline at end of file\n");
    expect(prepared.files[0].operation).toBe("create");
    expect(prepared.files[0].resultBytes.toString("utf8")).toBe("new text");
    expect(prepared.preconditions).toEqual([{ path: "new.txt", expected: "absent" }]);
  });

  it("rejects NUL bytes in a newly created text file", () => {
    const workspace = new Workspace(directory("patch-create-nul"));
    expect(() => preparePatch(workspace,
      "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+before\u0000after\n"))
      .toThrowError(expect.objectContaining({ code: "PATCH_UNSUPPORTED_OPERATION" }));
  });

  it("honors a no-final-newline update marker", () => {
    const root = directory("patch-update-no-final-newline");
    write(root, "file.txt", "before");
    const patchText = "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n";
    expect(preparePatch(new Workspace(root), patchText).files[0].resultBytes.toString("utf8")).toBe("after");
  });

  it("preserves mixed line endings outside the changed hunk", () => {
    const root = directory("patch-mixed-eol");
    write(root, "file.txt", "before\r\nkeep\nlast\r\n");
    const prepared = preparePatch(new Workspace(root), updatePatch());
    expect(prepared.files[0].resultBytes.toString("utf8")).toBe("after\r\nkeep\nlast\r\n");
  });

  it("resolves paired Git prefixes without corrupting real a/foo and b/foo targets", () => {
    const root = directory("patch-prefix");
    write(root, "a/foo", "before\n");
    write(root, "b/foo", "before\n");
    const workspace = new Workspace(root);
    const aPath = preparePatch(workspace,
      "--- a/a/foo\n+++ b/a/foo\n@@ -1 +1 @@\n-before\n+after\n");
    const bPath = preparePatch(workspace,
      "--- a/b/foo\n+++ b/b/foo\n@@ -1 +1 @@\n-before\n+after\n");
    expect(aPath.files[0].path).toBe("a/foo");
    expect(aPath.files[0].resultBytes.toString("utf8")).toBe("after\n");
    expect(bPath.files[0].path).toBe("b/foo");
    expect(bPath.files[0].resultBytes.toString("utf8")).toBe("after\n");
  });

  it("rejects mismatched update old and new paths", () => {
    const root = directory("patch-mismatched-update-paths");
    write(root, "old.txt", "before\n");
    const patchText = "--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-before\n+after\n";
    expect(() => preparePatch(new Workspace(root), patchText))
      .toThrowError(expect.objectContaining({ code: "PATCH_INVALID" }));
  });

  it("treats unmatched Git-style prefixes literally and still validates paths", () => {
    const root = directory("patch-unmatched-prefixes");
    write(root, "a/foo", "before\n");
    write(root, "b/foo", "before\n");
    const workspace = new Workspace(root);
    const literalA = preparePatch(workspace,
      "--- a/foo\n+++ a/foo\n@@ -1 +1 @@\n-before\n+after\n");
    const literalB = preparePatch(workspace,
      "--- b/foo\n+++ b/foo\n@@ -1 +1 @@\n-before\n+after\n");
    expect(literalA.files[0].path).toBe("a/foo");
    expect(literalB.files[0].path).toBe("b/foo");

    for (const [oldPath, newPath] of [["a/foo", "foo"], ["a/foo", "b/other"]]) {
      const patchText = `--- ${oldPath}\n+++ ${newPath}\n@@ -1 +1 @@\n-before\n+after\n`;
      expect(() => preparePatch(workspace, patchText))
        .toThrowError(expect.objectContaining({ code: "PATCH_INVALID" }));
    }
    const traversal = "--- a/../outside\n+++ a/../outside\n@@ -1 +1 @@\n-before\n+after\n";
    expect(() => preparePatch(workspace, traversal))
      .toThrowError(expect.objectContaining({ code: "PATCH_INVALID" }));
  });

  it("applies multiple hunks at their exact declared positions", () => {
    const root = directory("patch-multi-hunk");
    write(root, "file.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
    const patchText = "--- a/file.txt\n+++ b/file.txt\n" +
      "@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n" +
      "@@ -5,2 +5,2 @@\n-five\n+FIVE\n six\n";
    const prepared = preparePatch(new Workspace(root), patchText);
    expect(prepared.files[0].resultBytes.toString("utf8")).toBe("one\nTWO\nthree\nfour\nFIVE\nsix\n");
    expect(prepared.receiptFiles[0]).toMatchObject({ additions: 2, deletions: 2 });
  });

  it("rejects fuzzy-only matches and malformed ranges", () => {
    const root = directory("patch-exact");
    write(root, "file.txt", "before\n");
    expect(() => preparePatch(new Workspace(root), updatePatch("file.txt", "else", "after")))
      .toThrowError(expect.objectContaining({ code: "PATCH_DOES_NOT_APPLY" }));
    expect(() => preparePatch(new Workspace(root), "--- a/file.txt\n+++ b/file.txt\n@@ nope @@\n"))
      .toThrowError(expect.objectContaining({ code: "PATCH_INVALID" }));
  });

  it("rejects surrounding path whitespace instead of resolving a different file", () => {
    const root = directory("patch-path-whitespace");
    write(root, "file", "before\n");
    write(root, "file ", "other\n");
    expect(() => preparePatch(new Workspace(root), updatePatch("file ", "other", "changed")))
      .toThrowError(expect.objectContaining({ code: "PATCH_INVALID" }));
  });

  it("detects duplicate normalized targets before applying any hunk", () => {
    const root = directory("patch-duplicates");
    write(root, "file.txt", "before\n");
    const patchText = updatePatch() + "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-not-the-source\n+changed\n";
    expect(() => preparePatch(new Workspace(root), patchText))
      .toThrowError(expect.objectContaining({ code: "PATCH_INVALID" }));
  });

  it("rejects delete, rename, binary, mode, absolute, traversal, and invalid UTF-8 inputs", () => {
    const root = directory("patch-denials");
    write(root, "file.txt", "before\n");
    const workspace = new Workspace(root);
    const denied = [
      "--- a/file.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-before\n",
      "diff --git a/file.txt b/renamed.txt\nrename from file.txt\nrename to renamed.txt\n",
      "GIT binary patch\n",
      "diff --git a/file.txt b/file.txt\nold mode 100644\nnew mode 100755\n",
      "--- /etc/passwd\n+++ /etc/passwd\n@@ -1 +1 @@\n-x\n+y\n",
      "--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-x\n+y\n",
    ];
    for (const patchText of denied) expect(() => preparePatch(workspace, patchText)).toThrow(WriteRequestError);

    fs.writeFileSync(path.join(root, "binary.txt"), Buffer.from([0xff, 0xfe]));
    expect(() => preparePatch(workspace, updatePatch("binary.txt", "x", "y")))
      .toThrowError(expect.objectContaining({ code: "PATCH_UNSUPPORTED_OPERATION" }));
  });

  it("uses the shared sensitive policy and protects C2C/Git control roots", () => {
    const root = directory("patch-policy");
    write(root, ".env", "secret\n");
    write(root, ".C2C.JSON", "config\n");
    write(root, ".Git/config", "git\n");
    const workspace = new Workspace(root);
    expect(() => preparePatch(workspace, updatePatch(".env", "secret", "public")))
      .toThrowError(expect.objectContaining({ code: "WRITE_ACCESS_DENIED" }));
    for (const pathName of [".C2C.JSON", ".Git/config", ".c2cignore"]) {
      expect(() => preparePatch(workspace, updatePatch(pathName, "config", "new")))
        .toThrowError(expect.objectContaining({ code: "WRITE_PROTECTED_PATH" }));
    }
    expect(() => preparePatch(workspace, "--- /dev/null\n+++ b/.env.local\n@@ -0,0 +1 @@\n+secret\n"))
      .toThrowError(expect.objectContaining({ code: "WRITE_ACCESS_DENIED" }));
    expect(() => preparePatch(workspace, "--- /dev/null\n+++ b/.c2c/state.json\n@@ -0,0 +1 @@\n+state\n"))
      .toThrowError(expect.objectContaining({ code: "WRITE_PROTECTED_PATH" }));

    const c2cRoot = path.join(root, "state-material");
    write(root, "state-material/auth.json", "secret\n");
    expect(() => preparePatch(workspace, updatePatch("state-material/auth.json", "secret", "changed"), [c2cRoot]))
      .toThrowError(expect.objectContaining({ code: "WRITE_PROTECTED_PATH" }));
  });

  it("denies writes to a linked-worktree .git pointer file", async () => {
    const root = directory("patch-linked-worktree-git-pointer");
    const state = directory("patch-linked-worktree-git-pointer-state");
    const pointer = "gitdir: ../main/.git/worktrees/feature\n";
    write(root, ".git", pointer);
    const service = serviceFor(new Workspace(root), state);

    await expect(service.createManualRequest({
      workspaceId: "ws-1",
      patch: "--- a/.git\n+++ b/.git\n@@ -1 +1 @@\n-gitdir: ../main/.git/worktrees/feature\n+gitdir: ../main/.git/worktrees/other\n",
    })).rejects.toMatchObject({ code: "WRITE_PROTECTED_PATH" });
    expect(fs.readFileSync(path.join(root, ".git"), "utf8")).toBe(pointer);
  });

  it("protects relocated broker state even when it has an ordinary workspace-relative name", async () => {
    const root = directory("patch-relocated-state");
    const state = path.join(root, "project-data");
    fs.mkdirSync(state);
    write(root, "project-data/secret.json", "secret\n");
    const service = serviceFor(new Workspace(root), state);
    await expect(service.createManualRequest({
      workspaceId: "ws-1",
      patch: updatePatch("project-data/secret.json", "secret", "changed"),
    })).rejects.toMatchObject({ code: "WRITE_PROTECTED_PATH" });
    expect(fs.readFileSync(path.join(state, "secret.json"), "utf8")).toBe("secret\n");
  });

  it("denies writes when the selected workspace root is itself a protected state root", async () => {
    const state = directory("patch-state-root-workspace");
    write(state, "ordinary.txt", "private\n");
    const service = serviceFor(new Workspace(state), state);

    await expect(service.createManualRequest({
      workspaceId: "state-root-workspace",
      patch: updatePatch("ordinary.txt", "private", "changed"),
    })).rejects.toMatchObject({ code: "WRITE_PROTECTED_PATH" });
    expect(fs.readFileSync(path.join(state, "ordinary.txt"), "utf8")).toBe("private\n");
  });

  it("rejects a target reached through a symlink", () => {
    const root = directory("patch-symlink");
    write(root, "real.txt", "before\n");
    try {
      fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "alias.txt"));
    } catch {
      return;
    }
    expect(() => preparePatch(new Workspace(root), updatePatch("alias.txt", "before", "after")))
      .toThrowError(expect.objectContaining({ code: "WRITE_SYMLINK_DENIED" }));
  });

  it("denies a parent symlink that exists during patch preparation", () => {
    const root = directory("patch-parent-symlink-preparation");
    write(root, "real-dir/file.txt", "before\n");
    fs.symlinkSync(path.join(root, "real-dir"), path.join(root, "alias-dir"), "dir");

    expect(() => preparePatch(new Workspace(root), updatePatch("alias-dir/file.txt", "before", "after")))
      .toThrowError(expect.objectContaining({ code: "WRITE_SYMLINK_DENIED" }));
  });

  it("enforces patch and bounded source byte limits", () => {
    const root = directory("patch-limits");
    const workspace = new Workspace(root);
    expect(() => preparePatch(workspace, "x".repeat(MAX_PATCH_BYTES + 1)))
      .toThrowError(expect.objectContaining({ code: "PATCH_TOO_LARGE" }));
    fs.writeFileSync(path.join(root, "large.txt"), Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61));
    expect(() => preparePatch(workspace, updatePatch("large.txt", "a", "b")))
      .toThrowError(expect.objectContaining({ code: "WRITE_FILE_TOO_LARGE" }));
  });

  it("rejects a result over the per-file cap and more than fifty files", () => {
    const root = directory("patch-result-limit");
    const source = "start\n" + "x".repeat(MAX_SOURCE_BYTES - 6);
    write(root, "large-result.txt", source);
    const replacement = "y".repeat(100);
    expect(() => preparePatch(new Workspace(root), updatePatch("large-result.txt", "start", replacement)))
      .toThrowError(expect.objectContaining({ code: "WRITE_FILE_TOO_LARGE" }));

    const sections = Array.from({ length: 51 }, (_, index) => `--- /dev/null\n+++ b/new-${index}.txt\n`).join("");
    expect(() => preparePatch(new Workspace(root), sections))
      .toThrowError(expect.objectContaining({ code: "PATCH_TOO_MANY_FILES" }));
  });
});

describe("write-request lifecycle", () => {
  it("persists a pending request, applies it once, and scrubs the terminal receipt", async () => {
    const root = directory("request-apply");
    const state = directory("request-state");
    write(root, "file.txt", "before\n");
    write(root, "unrelated.txt", "untouched\n");
    const service = serviceFor(new Workspace(root), state);
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch() });
    expect(pending.status).toBe("pending");
    expect("patch" in pending).toBe(false);
    expect((await service.getRequest(pending.id, true)).patch).toBe(updatePatch());

    const applied = await service.approveManualRequest(pending.id);
    expect(applied.status).toBe("applied");
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("after\n");
    expect(fs.readFileSync(path.join(root, "unrelated.txt"), "utf8")).toBe("untouched\n");
    expect((await service.getRequest(pending.id, true)).patch).toBeUndefined();
    const recordFile = path.join(state, "write-requests", pending.id + ".json");
    expect(fs.statSync(recordFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(recordFile, "utf8")).not.toContain('"patch":');
  });

  it("replaces request records atomically in the same directory", () => {
    const state = directory("request-store-atomic");
    const store = new WriteRequestStore(state);
    const pending: WriteRequestRecord = {
      id: "wr_aaaaaaaaaaaaaaaaaaaaaaaa",
      kind: "patch",
      status: "pending",
      workspaceId: "ws-1",
      approvalMode: "manual-local",
      files: [],
      preconditions: [],
      patch: "disposable patch",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
    };
    store.create(pending);
    const file = path.join(store.directory, pending.id + ".json");
    const previousRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      expect(path.dirname(String(source))).toBe(store.directory);
      expect(path.dirname(String(destination))).toBe(store.directory);
      expect(store.get(pending.id)).toMatchObject({ status: "pending", patch: "disposable patch" });
      const listedDuringReplacement = store.list();
      expect(listedDuringReplacement).toHaveLength(1);
      expect(listedDuringReplacement[0]).toMatchObject({ status: "pending", patch: "disposable patch" });
      return previousRename(source, destination);
    });
    try {
      const terminal: WriteRequestRecord = {
        id: pending.id,
        kind: "patch",
        status: "rejected",
        workspaceId: pending.workspaceId,
        approvalMode: pending.approvalMode,
        files: pending.files,
        preconditions: pending.preconditions,
        createdAt: pending.createdAt,
        resolvedAt: "2026-01-01T00:01:00.000Z",
      };
      store.update(terminal);
      expect(store.get(pending.id)).toMatchObject({ status: "rejected", resolvedAt: terminal.resolvedAt });
      expect(fs.readFileSync(file, "utf8")).not.toContain("disposable patch");
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("rejects stale updates and creates without changing the external edit", async () => {
    const root = directory("request-stale");
    const state = directory("request-stale-state");
    write(root, "file.txt", "before\n");
    const service = serviceFor(new Workspace(root), state);
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch() });
    fs.writeFileSync(path.join(root, "file.txt"), "external\n");
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_STALE" });
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("external\n");
    expect((await service.getRequest(pending.id, true)).status).toBe("stale");
    expect((await service.getRequest(pending.id, true)).patch).toBeUndefined();

    const create = await service.createManualRequest({
      workspaceId: "ws-1",
      patch: "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+created\n",
    });
    write(root, "new.txt", "external create\n");
    await expect(service.approveManualRequest(create.id)).rejects.toMatchObject({ code: "WRITE_STALE" });
    expect(fs.readFileSync(path.join(root, "new.txt"), "utf8")).toBe("external create\n");
  });

  it("persists target-unavailable state as stale and scrubs the pending patch", async () => {
    const root = directory("request-unavailable-target");
    const state = directory("request-unavailable-target-state");
    write(root, "file.txt", "before\n");
    const workspace = new Workspace(root);
    let available = true;
    const service = new WriteRequestService({
      store: new WriteRequestStore(state),
      protectedRoots: [state],
      resolveTarget: (workspaceId) => {
        if (!available) throw new Error("workspace removed");
        return { workspace, workspaceId };
      },
    });
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch() });
    available = false;
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_STALE" });
    const stale = await service.getRequest(pending.id, true);
    expect(stale).toMatchObject({ status: "stale", resolutionCode: "WORKSPACE_UNAVAILABLE" });
    expect("patch" in stale).toBe(false);
  });

  it("creates a fresh pending receipt for every duplicate proposal", async () => {
    const root = directory("request-duplicate-proposals");
    const state = directory("request-duplicate-proposals-state");
    write(root, "file.txt", "before\n");
    const service = serviceFor(new Workspace(root), state);
    const first = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch() });
    const second = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch() });
    expect(first.id).not.toBe(second.id);
    expect((await service.listRequests()).map((record) => record.status)).toEqual(["pending", "pending"]);
  });

  it("marks the whole multi-file request stale before any intentional write", async () => {
    const root = directory("request-multifile-stale");
    const state = directory("request-multifile-stale-state");
    write(root, "first.txt", "first\n");
    write(root, "second.txt", "second\n");
    const service = serviceFor(new Workspace(root), state);
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: multiUpdatePatch() });
    fs.writeFileSync(path.join(root, "second.txt"), "external\n");
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_STALE" });
    expect(fs.readFileSync(path.join(root, "first.txt"), "utf8")).toBe("first\n");
    expect(fs.readFileSync(path.join(root, "second.txt"), "utf8")).toBe("external\n");
  });

  it("marks a target stale when it becomes a directory after proposal", async () => {
    const root = directory("request-target-directory");
    const state = directory("request-target-directory-state");
    const file = write(root, "file.txt", "before\n");
    const service = serviceFor(new Workspace(root), state);
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch() });

    fs.unlinkSync(file);
    fs.mkdirSync(file);

    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_STALE" });
    expect(await service.getRequest(pending.id, true)).toMatchObject({
      status: "stale",
      resolutionCode: "WRITE_TARGET_NOT_FILE",
    });
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  it("marks a target stale when its leaf becomes a symlink after proposal", async () => {
    const root = directory("request-target-symlink");
    const state = directory("request-target-symlink-state");
    const external = directory("request-target-symlink-outside");
    const file = write(root, "file.txt", "before\n");
    write(external, "file.txt", "before\n");
    const service = serviceFor(new Workspace(root), state);
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch() });

    fs.unlinkSync(file);
    try {
      fs.symlinkSync(path.join(external, "file.txt"), file);
    } catch {
      return;
    }
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_STALE" });
    expect(await service.getRequest(pending.id, true)).toMatchObject({
      status: "stale",
      resolutionCode: "WRITE_SYMLINK_DENIED",
    });
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(external, "file.txt"), "utf8")).toBe("before\n");
  });

  it("marks a target stale when its parent becomes a symlink", async () => {
    const root = directory("request-parent-symlink");
    const state = directory("request-parent-symlink-state");
    const external = directory("request-parent-symlink-outside");
    write(root, "nested/file.txt", "before\n");
    write(external, "file.txt", "before\n");
    const service = serviceFor(new Workspace(root), state);
    const pending = await service.createManualRequest({
      workspaceId: "ws-1",
      patch: updatePatch("nested/file.txt"),
    });
    fs.rmSync(path.join(root, "nested"), { recursive: true });
    try {
      fs.symlinkSync(external, path.join(root, "nested"), "dir");
    } catch {
      return;
    }
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_STALE" });
    expect((await service.getRequest(pending.id, true))).toMatchObject({ status: "stale", resolutionCode: "WRITE_SYMLINK_DENIED" });
    expect(fs.readFileSync(path.join(external, "file.txt"), "utf8")).toBe("before\n");
  });

  it("serializes concurrent approvals so one request applies once", async () => {
    const root = directory("request-concurrent");
    const state = directory("request-concurrent-state");
    write(root, "file.txt", "before\n");
    const service = serviceFor(new Workspace(root), state);
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch() });
    const results = await Promise.allSettled([
      service.approveManualRequest(pending.id),
      service.approveManualRequest(pending.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("after\n");
  });

  it("serializes approve versus reject and competing prepared writes", async () => {
    const root = directory("request-races");
    const state = directory("request-races-state");
    write(root, "file.txt", "before\n");
    const service = serviceFor(new Workspace(root), state);
    const approval = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch() });
    const racing = await Promise.allSettled([
      service.approveManualRequest(approval.id),
      service.rejectManualRequest(approval.id),
    ]);
    expect(racing.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    fs.writeFileSync(path.join(root, "file.txt"), "before\n");
    const first = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch("file.txt", "before", "first") });
    const second = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch("file.txt", "before", "second") });
    const commits = await Promise.allSettled([
      service.approveManualRequest(first.id),
      service.approveManualRequest(second.id),
    ]);
    expect(commits.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(commits.filter((result) => result.status === "rejected")).toHaveLength(1);
    const finalStates = [await service.getRequest(first.id), await service.getRequest(second.id)].map((record) => record.status);
    expect(finalStates.sort()).toEqual(["applied", "stale"]);
  });

  it("serializes host-confirmed and manual writes through the same broker lifecycle", async () => {
    const root = directory("request-host-manual-race");
    const state = directory("request-host-manual-race-state");
    write(root, "file.txt", "before\n");
    const service = serviceFor(new Workspace(root), state);
    const manual = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch("file.txt", "before", "manual") });
    const results = await Promise.allSettled([
      service.approveManualRequest(manual.id),
      service.applyHostConfirmedPatch({ workspaceId: "ws-1", patch: updatePatch("file.txt", "before", "host") }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(["manual\n", "host\n"]).toContain(fs.readFileSync(path.join(root, "file.txt"), "utf8"));
  });

  it("uses no-clobber create semantics when a target appears immediately before commit", async () => {
    const root = directory("request-create-race");
    const state = directory("request-create-race-state");
    const service = serviceFor(new Workspace(root), state, {
      applyHooks: { beforeCommit() { write(root, "new.txt", "external\n"); } },
    });
    const pending = await service.createManualRequest({
      workspaceId: "ws-1",
      patch: "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+created\n",
    });
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_STALE" });
    expect(fs.readFileSync(path.join(root, "new.txt"), "utf8")).toBe("external\n");
  });

  it("applies a successful multi-file patch", async () => {
    const root = directory("request-multifile-success");
    const state = directory("request-multifile-success-state");
    write(root, "first.txt", "first\n");
    write(root, "second.txt", "second\n");
    const service = serviceFor(new Workspace(root), state);
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: multiUpdatePatch() });
    const receipt = await service.approveManualRequest(pending.id);
    expect(receipt.status).toBe("applied");
    expect(fs.readFileSync(path.join(root, "first.txt"), "utf8")).toBe("changed-first\n");
    expect(fs.readFileSync(path.join(root, "second.txt"), "utf8")).toBe("changed-second\n");
  });

  it("applies an update and create together after validating both", async () => {
    const root = directory("request-update-create");
    const state = directory("request-update-create-state");
    write(root, "existing.txt", "before\n");
    const service = serviceFor(new Workspace(root), state);
    const patchText = updatePatch("existing.txt") + "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+created\n";
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: patchText });
    await service.approveManualRequest(pending.id);
    expect(fs.readFileSync(path.join(root, "existing.txt"), "utf8")).toBe("after\n");
    expect(fs.readFileSync(path.join(root, "new.txt"), "utf8")).toBe("created\n");
  });

  it("stages every result temp in its target parent before the first commit", async () => {
    const root = directory("request-stage-before-commit");
    const state = directory("request-stage-before-commit-state");
    const firstParent = path.join(root, "first");
    const secondParent = path.join(root, "second");
    const targetParents = [firstParent, secondParent];
    fs.mkdirSync(firstParent);
    fs.mkdirSync(secondParent);
    write(root, "first/file.txt", "before\n");
    const patchText = updatePatch("first/file.txt") + "--- /dev/null\n+++ b/second/new.txt\n@@ -0,0 +1 @@\n+created\n";
    let stagingAtFirstCommit: { tempPaths: string[]; parentCounts: number[] } | undefined;
    const service = serviceFor(new Workspace(root), state, {
      applyHooks: {
        beforeCommit(index) {
          if (index !== 0) return;
          const tempsByParent = targetParents.map((parent) => ({
            parent,
            names: fs.readdirSync(parent).filter((name) => name.startsWith(".c2c-tmp-")),
          }));
          stagingAtFirstCommit = {
            tempPaths: tempsByParent.flatMap(({ parent, names }) => names.map((name) => path.join(parent, name))),
            parentCounts: tempsByParent.map(({ names }) => names.length),
          };
        },
      },
    });
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: patchText });
    await service.approveManualRequest(pending.id);

    expect(stagingAtFirstCommit).toBeDefined();
    expect(stagingAtFirstCommit?.tempPaths).toHaveLength(2);
    expect(stagingAtFirstCommit?.parentCounts).toEqual([1, 1]);
    expect(stagingAtFirstCommit?.tempPaths.map((temp) => path.dirname(temp)).sort()).toEqual([...targetParents].sort());
    expect(fs.readdirSync(firstParent).some((name) => name.startsWith(".c2c-tmp-"))).toBe(false);
    expect(fs.readdirSync(secondParent).some((name) => name.startsWith(".c2c-tmp-"))).toBe(false);
  });

  it("detects an external edit before an update replacement", async () => {
    const root = directory("request-update-race");
    const state = directory("request-update-race-state");
    write(root, "file.txt", "before\n");
    const service = serviceFor(new Workspace(root), state, {
      applyHooks: { beforeCommit() { fs.writeFileSync(path.join(root, "file.txt"), "external\n"); } },
    });
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch() });
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_STALE" });
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("external\n");
  });

  it("applies host-confirmed writes through the same receipt lifecycle", async () => {
    const root = directory("request-host-confirmed");
    const state = directory("request-host-confirmed-state");
    write(root, "file.txt", "before\n");
    const service = serviceFor(new Workspace(root), state);
    const receipt = await service.applyHostConfirmedPatch({ workspaceId: "ws-1", patch: updatePatch() });
    expect(receipt.approvalMode).toBe("host-confirmed");
    expect(receipt.status).toBe("applied");
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("after\n");
    expect(await service.listRequests({ workspaceId: "ws-1" })).toEqual([receipt]);
  });

  it("preserves update permissions and honors the process umask for creates", async () => {
    const root = directory("request-modes");
    const state = directory("request-modes-state");
    const file = write(root, "existing.txt", "before\n");
    fs.chmodSync(file, 0o640);
    const service = serviceFor(new Workspace(root), state);
    const update = await service.createManualRequest({
      workspaceId: "ws-1",
      patch: updatePatch("existing.txt", "before", "after"),
    });
    await service.approveManualRequest(update.id);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);

    const modeReference = path.join(root, "mode-reference.txt");
    const descriptor = fs.openSync(modeReference, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o666);
    fs.closeSync(descriptor);
    const expectedCreateMode = fs.statSync(modeReference).mode & 0o777;
    const create = await service.createManualRequest({
      workspaceId: "ws-1",
      patch: "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n",
    });
    await service.approveManualRequest(create.id);
    expect(fs.statSync(path.join(root, "new.txt")).mode & 0o777).toBe(expectedCreateMode);
  });

  it("rolls back an earlier replacement after a later commit failure", async () => {
    const root = directory("request-rollback");
    const state = directory("request-rollback-state");
    const firstFile = write(root, "first.txt", "first\n");
    fs.chmodSync(firstFile, 0o640);
    write(root, "second.txt", "second\n");
    const service = serviceFor(new Workspace(root), state, {
      applyHooks: { beforeCommit(index) { if (index === 1) throw new Error("injected replacement failure"); } },
    });
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: multiUpdatePatch() });
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_APPLY_FAILED" });
    expect(fs.readFileSync(path.join(root, "first.txt"), "utf8")).toBe("first\n");
    expect(fs.statSync(firstFile).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(path.join(root, "second.txt"), "utf8")).toBe("second\n");
    expect(fs.readdirSync(root).some((name) => name.startsWith(".c2c-tmp-"))).toBe(false);
    expect((await service.getRequest(pending.id)).status).toBe("failed");
  });

  it("removes an earlier create when a later commit fails", async () => {
    const root = directory("request-create-rollback");
    const state = directory("request-create-rollback-state");
    write(root, "later.txt", "before\n");
    const service = serviceFor(new Workspace(root), state, {
      applyHooks: { beforeCommit(index) { if (index === 1) throw new Error("injected second commit failure"); } },
    });
    const patchText = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n" + updatePatch("later.txt");
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: patchText });
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_APPLY_FAILED" });
    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "later.txt"), "utf8")).toBe("before\n");
  });

  it("preserves WRITE_ROLLBACK_FAILED when its failed receipt also cannot be stored", async () => {
    class FailFailedReceiptStore extends WriteRequestStore {
      override update(record: WriteRequestRecord): void {
        if (record.status === "failed") throw new WriteRequestError("WRITE_RECEIPT_PERSIST_FAILED", "injected receipt failure");
        super.update(record);
      }
    }

    const root = directory("request-double-failure");
    const state = directory("request-double-failure-state");
    write(root, "first.txt", "first\n");
    write(root, "second.txt", "second\n");
    const store = new FailFailedReceiptStore(state);
    const service = serviceFor(new Workspace(root), state, {
      store,
      applyHooks: {
        beforeCommit(index) { if (index === 1) throw new Error("injected commit failure"); },
        beforeRollbackOwnershipCheck(_index, file) {
          if (file.path === "first.txt") fs.writeFileSync(path.join(root, "first.txt"), "external edit\n");
        },
      },
    });
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: multiUpdatePatch() });
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_ROLLBACK_FAILED" });
    expect(fs.readFileSync(path.join(root, "first.txt"), "utf8")).toBe("external edit\n");
  });

  it("leaves an external edit untouched and blocks writes when rollback ownership is lost", async () => {
    const root = directory("request-rollback-conflict");
    const state = directory("request-rollback-conflict-state");
    write(root, "first.txt", "first\n");
    write(root, "second.txt", "second\n");
    const service = serviceFor(new Workspace(root), state, {
      applyHooks: {
        beforeCommit(index) { if (index === 1) throw new Error("injected replacement failure"); },
        beforeRollbackOwnershipCheck(_index, file) {
          if (file.path === "first.txt") fs.writeFileSync(path.join(root, "first.txt"), "external edit\n");
        },
      },
    });
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: multiUpdatePatch() });
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_ROLLBACK_FAILED" });
    expect(fs.readFileSync(path.join(root, "first.txt"), "utf8")).toBe("external edit\n");
    await expect(service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch("second.txt", "second", "next") }))
      .rejects.toMatchObject({ code: "WRITE_ROLLBACK_FAILED" });
  });

  it("rolls back a receipt-persistence failure and allows an explicit retry", async () => {
    class FailFirstAppliedReceiptStore extends WriteRequestStore {
      failApplied = false;
      override update(record: WriteRequestRecord): void {
        if (this.failApplied && record.status === "applied") {
          this.failApplied = false;
          throw new WriteRequestError("WRITE_RECEIPT_PERSIST_FAILED", "injected receipt failure");
        }
        super.update(record);
      }
    }

    const root = directory("request-receipt-failure");
    const state = directory("request-receipt-failure-state");
    write(root, "file.txt", "before\n");
    const store = new FailFirstAppliedReceiptStore(state);
    const service = serviceFor(new Workspace(root), state, { store });
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch() });
    store.failApplied = true;
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_RECEIPT_PERSIST_FAILED" });
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("before\n");
    expect((await service.getRequest(pending.id, true)).status).toBe("pending");
    expect((await service.getRequest(pending.id, true)).patch).toBe(updatePatch());

    const retried = await service.approveManualRequest(pending.id);
    expect(retried.status).toBe("applied");
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("after\n");
  });

  it("expires pending requests and removes terminal history after seven days", async () => {
    const root = directory("request-expiry");
    const state = directory("request-expiry-state");
    write(root, "file.txt", "before\n");
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const service = serviceFor(new Workspace(root), state, { now: () => now });
    const pending = await service.createManualRequest({ workspaceId: "ws-1", patch: updatePatch() });
    now += 61 * 60 * 1000;
    await expect(service.approveManualRequest(pending.id)).rejects.toMatchObject({ code: "WRITE_REQUEST_EXPIRED" });
    expect((await service.getRequest(pending.id, true)).patch).toBeUndefined();
    now += 8 * 24 * 60 * 60 * 1000;
    expect(await service.listRequests()).toEqual([]);
  });
});

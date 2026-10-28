import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../src/workspace/manager.js";
import { createTextEditPatch } from "../src/write-requests/text-edits.js";
import { preparePatch } from "../src/write-requests/patch.js";
import { WriteRequestService } from "../src/write-requests/service.js";
import { WriteRequestStore } from "../src/write-requests/store.js";
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

function serviceFor(workspace: Workspace, stateDir: string): WriteRequestService {
  return new WriteRequestService({
    store: new WriteRequestStore(stateDir),
    resolveTarget: (workspaceId, worktreeId) => ({ workspace, workspaceId, ...(worktreeId ? { worktreeId } : {}) }),
    protectedRoots: [stateDir],
  });
}

describe("exact text edit patch conversion", () => {
  it("uses the unified patch lifecycle while preserving BOM, CRLF, and no final newline", async () => {
    const root = directory("text-edit-crlf");
    const state = directory("text-edit-crlf-state");
    const file = path.join(root, "file.txt");
    fs.writeFileSync(file, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("keep\r\nbefore\r\nlast"),
    ]));
    const workspace = new Workspace(root);
    const edits = [{ path: "file.txt", oldText: "before\n", newText: "after\n" }];
    const patch = createTextEditPatch(workspace, edits);
    const prepared = preparePatch(workspace, patch);
    const expected = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("keep\r\nafter\r\nlast"),
    ]);
    expect(prepared.files[0].resultBytes).toEqual(expected);

    const service = serviceFor(workspace, state);
    const pending = await service.createTextEditRequest({ workspaceId: "ws-1", edits });
    expect(pending.status).toBe("pending");
    await service.approveManualRequest(pending.id);
    expect(fs.readFileSync(file)).toEqual(expected);
  });

  it("applies ordered edits in one file and combines multiple files in one request", () => {
    const root = directory("text-edit-multiple");
    write(root, "first.txt", "one two\n");
    write(root, "second.txt", "second\n");
    const workspace = new Workspace(root);
    const patch = createTextEditPatch(workspace, [
      { path: "first.txt", oldText: "one", newText: "1" },
      { path: "first.txt", oldText: "two", newText: "2" },
      { path: "second.txt", oldText: "second", newText: "changed" },
    ]);
    const prepared = preparePatch(workspace, patch);
    expect(prepared.files.map((file) => [file.path, file.resultBytes.toString("utf8")])).toEqual([
      ["first.txt", "1 2\n"],
      ["second.txt", "changed\n"],
    ]);
  });

  it("renders compact hunks for multi-line and distant replacements", () => {
    const root = directory("text-edit-hunks");
    const original = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n") + "\n";
    write(root, "file.txt", original);
    const workspace = new Workspace(root);
    const patch = createTextEditPatch(workspace, [
      { path: "file.txt", oldText: "line-2\nline-3\n", newText: "changed-2\ninserted\nchanged-3\n" },
      { path: "file.txt", oldText: "line-18", newText: "changed-18" },
    ]);
    const prepared = preparePatch(workspace, patch);
    expect(prepared.files[0].resultBytes.toString("utf8")).toBe(
      "line-0\nline-1\nchanged-2\ninserted\nchanged-3\nline-4\nline-5\nline-6\nline-7\nline-8\nline-9\nline-10\nline-11\nline-12\nline-13\nline-14\nline-15\nline-16\nline-17\nchanged-18\nline-19\n"
    );
    expect(patch).toContain("@@ -1,7 +1,8 @@");
    expect(patch).toContain("@@ -16,5 +17,5 @@");
    expect(patch).not.toContain(" line-10\n");
  });

  it("reports missing and ambiguous matches with the edit index", () => {
    const root = directory("text-edit-diagnostics");
    write(root, "file.txt", "same same\n");
    const workspace = new Workspace(root);

    expect(() => createTextEditPatch(workspace, [{ path: "file.txt", oldText: "missing", newText: "x" }]))
      .toThrowError(expect.objectContaining({
        code: "PATCH_DOES_NOT_APPLY",
        details: { kind: "text-edit", path: "file.txt", editIndex: 1, reason: "NO_MATCH" },
      }));
    expect(() => createTextEditPatch(workspace, [{ path: "file.txt", oldText: "same", newText: "x" }]))
      .toThrowError(expect.objectContaining({
        code: "PATCH_DOES_NOT_APPLY",
        details: { kind: "text-edit", path: "file.txt", editIndex: 1, reason: "AMBIGUOUS_MATCH" },
      }));
  });

  it("rejects mixed line endings, binary and invalid UTF-8 sources, protected paths, and no-op edits", () => {
    const root = directory("text-edit-rejections");
    const protectedRoot = path.join(root, "protected");
    fs.mkdirSync(protectedRoot, { recursive: true });
    write(root, "mixed.txt", "before\r\nkeep\n");
    fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0x62, 0x00, 0x69]));
    fs.writeFileSync(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    write(protectedRoot, "secret.txt", "secret\n");
    write(root, "same.txt", "same\n");
    const workspace = new Workspace(root);

    expect(() => createTextEditPatch(workspace, [{ path: "mixed.txt", oldText: "before", newText: "after" }]))
      .toThrowError(expect.objectContaining({ code: "PATCH_UNSUPPORTED_OPERATION" }));
    expect(() => createTextEditPatch(workspace, [{ path: "binary.bin", oldText: "b", newText: "x" }]))
      .toThrowError(expect.objectContaining({ code: "PATCH_UNSUPPORTED_OPERATION" }));
    expect(() => createTextEditPatch(workspace, [{ path: "invalid.txt", oldText: "x", newText: "y" }]))
      .toThrowError(expect.objectContaining({ code: "PATCH_UNSUPPORTED_OPERATION" }));
    expect(() => createTextEditPatch(workspace, [{ path: "same.txt", oldText: "same", newText: "same" }]))
      .toThrowError(expect.objectContaining({ code: "PATCH_DOES_NOT_APPLY" }));

    expect(() => createTextEditPatch(
      workspace,
      [{ path: "protected/secret.txt", oldText: "secret", newText: "changed" }],
      [protectedRoot]
    )).toThrowError(expect.objectContaining({ code: "WRITE_PROTECTED_PATH" }));
  });
});

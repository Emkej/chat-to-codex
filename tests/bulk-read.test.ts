import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readFiles } from "../src/workspace/bulk-read.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

describe("readFiles", () => {
  it("keeps request order and isolates per-item errors without leaking paths", async () => {
    const root = makeTmpDir("bulk-read");
    write(root, "first.txt", "first line\nsecond line\n");
    write(root, "second.txt", "second file\n");
    write(root, ".env", "SECRET=must-not-return\n");
    fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    try {
      const result = await readFiles(new Workspace(root), [
        { path: "second.txt" },
        { path: ".env" },
        { path: "missing.txt" },
        { path: "first.txt", startLine: 2, endLine: 2 },
        { path: "binary.bin" },
      ]);

      expect(result.items.map((item) => item.index)).toEqual([0, 1, 2, 3, 4]);
      expect(result.items[0]).toMatchObject({ index: 0, path: "second.txt", status: "ok", content: "second file" });
      expect(result.items[3]).toMatchObject({ index: 3, path: "first.txt", status: "ok", content: "second line" });
      expect(result.items[1]).toMatchObject({
        status: "error",
        start_line: null,
        end_line: null,
        error: { code: "ACCESS_DENIED_SENSITIVE_FILE" },
      });
      expect(result.items[2]).toMatchObject({ status: "error", error: { code: "FILE_NOT_FOUND" } });
      expect(result.items[4]).toMatchObject({ status: "error", error: { code: "BINARY_FILE" } });
      expect(JSON.stringify(result)).not.toContain(root);
      expect(result.truncated).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  it("bounds the serialized response and marks later files as skipped", async () => {
    const root = makeTmpDir("bulk-read-budget");
    const content = Array.from({ length: 1000 }, (_, index) => `${String(index).padStart(4, "0")}-${"x".repeat(900)}`).join("\n");
    const requests = Array.from({ length: 10 }, (_, index) => {
      const file = `large-${index}.txt`;
      write(root, file, content);
      return { path: file };
    });
    try {
      const result = await readFiles(new Workspace(root), requests, 16 * 1024);
      expect(result.response_bytes).toBeLessThanOrEqual(16 * 1024);
      expect(result.truncated).toBe(true);
      expect(result.items).toHaveLength(10);
      expect(result.items.some((item) => item.status === "skipped")).toBe(true);
      expect(result.items.map((item) => item.index)).toEqual(Array.from({ length: 10 }, (_, index) => index));
      expect(result.items.filter((item) => item.status === "skipped").every((item) => item.error.code === "RESPONSE_LIMIT")).toBe(true);
    } finally {
      cleanup(root);
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString, type Key } from "ink";
import { ManagerController } from "../src/manager/controller.js";
import { workspaceDetailLines, detailViewport, wrapDetailValue } from "../src/manager/workspace-detail-layout.js";
import { WorkspaceDetail } from "../src/manager/ui/workspace-detail.js";
import { handleManagerInput, type ManagerInputState } from "../src/manager/ui/manager-input.js";

function snapshot() {
  const initial = new ManagerController().getSnapshot();
  return {
    ...initial,
    selectedWorkspaceId: "workspace-a",
    status: {
      installation: { state: "ready" as const, id: "c2c_inst_test", version: "0.2.0", profile: null },
      broker: { state: "running" as const }, authorization: { state: "unknown" as const },
      tunnel: { state: "stopped" as const, provider: null, preference: "unset" as const },
      workspaces: [{ id: "workspace-a", name: "Alpha", liveSessionCount: null as number | null }], observedAt: new Date().toISOString(),
    },
    workspaceDetail: { workspaceId: "workspace-a", state: "ready" as const, worktrees: [{ worktreeId: "wt-test", branch: null as string | null, commit: "123456" }] },
  };
}

describe("workspace detail presentation", () => {
  it("renders required metadata, detached state, unknown sessions and explicit empty/error states", () => {
    const state = snapshot();
    const lines = workspaceDetailLines(state, 78);
    const rendered = renderToString(createElement(WorkspaceDetail, { lines, offset: 0, height: 20 }), { columns: 80 });
    for (const value of ["Alpha", "workspace-a", "Live sessions: unknown", "wt-test", "Branch: detached", "Commit: 123456", "Esc Back", "[q] Quit"]) expect(rendered).toContain(value);
    expect(rendered).not.toContain("root");
    expect(workspaceDetailLines({ ...state, workspaceDetail: { ...state.workspaceDetail, worktrees: [] } }, 78).join("\n")).toContain("No derived worktrees.");
    expect(workspaceDetailLines({ ...state, workspaceDetail: { ...state.workspaceDetail, state: "loading", worktrees: [] } }, 78).join("\n")).toContain("Loading worktrees...");
    expect(workspaceDetailLines({ ...state, workspaceDetail: { ...state.workspaceDetail, state: "unavailable", worktrees: [] } }, 78).join("\n")).toContain("Workspace detail is unavailable.");
    state.status.workspaces[0]!.liveSessionCount = 0;
    expect(workspaceDetailLines(state, 78)).toContain("Live sessions: 0");
  });

  it.each([80, 120])("keeps every wrapped value reachable with fixed hints at %s columns", (columns) => {
    const state = snapshot();
    state.status.workspaces[0]!.name = "N".repeat(220);
    state.status.workspaces[0]!.id = state.workspaceDetail.workspaceId = "ID".repeat(90);
    state.workspaceDetail.worktrees = Array.from({ length: 30 }, (_, index) => ({ worktreeId: `wt-${index}`, branch: "branch/" + "b".repeat(170), commit: "c".repeat(40) }));
    const lines = workspaceDetailLines(state, columns - 2);
    const seen: string[] = [];
    for (let requested = 0; requested < lines.length; requested += 20) {
      const viewport = detailViewport(lines.length, 24, requested);
      const visible = lines.slice(viewport.offset, viewport.offset + viewport.height);
      seen.push(...visible);
      const rendered = renderToString(createElement(WorkspaceDetail, { lines, ...viewport }), { columns });
      expect(rendered.split("\n").length).toBeLessThanOrEqual(24);
      expect(rendered).toContain("Esc Back");
      expect(rendered).toContain("[q] Quit");
    }
    expect(seen).toEqual(expect.arrayContaining(lines));
    expect(lines.join("")).toContain("N".repeat(220));
    expect(lines.join("")).toContain("ID".repeat(90));
    for (let index = 0; index < 30; index++) expect(seen.join("\n")).toContain(`Worktree id: wt-${index}`);
    expect(detailViewport(lines.length, 24, 25).offset).toBe(25);
    expect(detailViewport(10, 24, 100).offset).toBe(0);
    expect(detailViewport(lines.length, 40, 100_000).offset).toBe(lines.length - 36);
  });

  it("wraps graphemes and removes terminal control sequences", () => {
    expect(wrapDetailValue("a\u0301世界a", 3)).toEqual(["a\u0301世", "界a"]);
    expect(wrapDetailValue("\x1b[31mAlpha\x1b[0m\x07", 80)).toEqual(["Alpha"]);
  });

  it.each(["〈", "𛀀"])("keeps every suffix reachable when %s occupies two terminal cells", (wide) => {
    const state = snapshot();
    state.workspaceDetail.worktrees = Array.from({ length: 20 }, (_, index) => ({ worktreeId: `wt-${index}`, branch: wide.repeat(77) + `END-${index}`, commit: "abc" }));
    const lines = workspaceDetailLines(state, 78);
    const screens: string[] = [];
    for (let requested = 0; requested < lines.length; requested += 20) {
      const viewport = detailViewport(lines.length, 24, requested);
      const rendered = renderToString(createElement(WorkspaceDetail, { lines, ...viewport }), { columns: 80 });
      expect(rendered.split("\n").length).toBeLessThanOrEqual(24);
      screens.push(rendered);
    }
    for (let index = 0; index < 20; index++) expect(screens.join("\n")).toContain(`END-${index}`);
  });
});

describe("Manager detail input precedence", () => {
  const controller = {
    openWorkspaceDetail: vi.fn(async () => true), closeWorkspaceDetail: vi.fn(),
    moveWorkspaceSelection: vi.fn(), perform: vi.fn(async () => true),
    confirmPendingAction: vi.fn(async () => true), cancelConfirmation: vi.fn(),
  } as unknown as ManagerController;
  function ui(overrides: Partial<ManagerInputState> = {}): ManagerInputState {
    return { menuOpen: false, helpOpen: false, menuIndex: 0, setMenuOpen: vi.fn(), setMenuIndex: vi.fn(), setHelpOpen: vi.fn(), scroll: vi.fn(), pageHeight: 20, resetScroll: vi.fn(), onQuit: vi.fn(), ...overrides };
  }
  function key(value: Partial<Key>): Key { return value as Key; }

  it("opens on Enter, scrolls rendered lines/pages and closes with Esc", () => {
    vi.clearAllMocks();
    const state = snapshot();
    const controls = ui();
    handleManagerInput("", key({ return: true }), { ...state, workspaceDetail: null }, controller, controls);
    expect(controller.openWorkspaceDetail).toHaveBeenCalledTimes(1);
    expect(controls.resetScroll).toHaveBeenCalledTimes(1);
    for (const [value, delta] of [[{ upArrow: true }, -1], [{ downArrow: true }, 1], [{ pageUp: true }, -20], [{ pageDown: true }, 20]] as const) {
      handleManagerInput("", key(value), state, controller, controls);
      expect(controls.scroll).toHaveBeenLastCalledWith(delta);
    }
    expect(controller.moveWorkspaceSelection).not.toHaveBeenCalled();
    handleManagerInput("", key({ escape: true }), state, controller, controls);
    expect(controller.closeWorkspaceDetail).toHaveBeenCalledTimes(1);
  });

  it.each(["confirmation", "menu", "help"])("keeps %s precedence for Enter/Esc and scroll keys", (mode) => {
    vi.clearAllMocks();
    const state = snapshot();
    const controls = ui({ menuOpen: mode === "menu", helpOpen: mode === "help" });
    const current = { ...state, confirmation: mode === "confirmation" ? "stop" as const : null };
    for (const value of [{ return: true }, { escape: true }, { upArrow: true }, { downArrow: true }, { pageUp: true }, { pageDown: true }]) handleManagerInput("", key(value), current, controller, controls);
    expect(controller.openWorkspaceDetail).not.toHaveBeenCalled();
    expect(controller.closeWorkspaceDetail).not.toHaveBeenCalled();
    expect(controller.moveWorkspaceSelection).not.toHaveBeenCalled();
    expect(controls.scroll).not.toHaveBeenCalled();
    if (mode === "confirmation") expect(controller.confirmPendingAction).toHaveBeenCalledTimes(1);
    if (mode === "menu") expect(controller.perform).toHaveBeenCalledTimes(1);
    if (mode === "help") expect(controls.setHelpOpen).toHaveBeenCalledWith(false);
  });

  it("keeps quit and Ctrl+C available while loading or inside a modal", () => {
    const state = { ...snapshot(), activeAction: "detail" as const, confirmation: "stop" as const };
    const controls = ui({ helpOpen: true });
    handleManagerInput("q", key({}), state, controller, controls);
    handleManagerInput("c", key({ ctrl: true }), state, controller, controls);
    expect(controls.onQuit).toHaveBeenCalledTimes(2);
  });
});

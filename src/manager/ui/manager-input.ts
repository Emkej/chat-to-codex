import type { Key } from "ink";
import type { Dispatch, SetStateAction } from "react";
import { getAvailableManagerActions, managerActionForShortcut } from "../action-policy.js";
import type { ManagerController } from "../controller.js";
import type { ManagerSnapshot } from "../types.js";

export interface ManagerInputState {
  menuOpen: boolean;
  menuIndex: number;
  helpOpen: boolean;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  setMenuIndex: Dispatch<SetStateAction<number>>;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  scroll(delta: number): void;
  pageHeight: number;
  resetScroll(): void;
  onQuit(): void;
}

/** Modal precedence is shared by overview and detail navigation. */
export function handleManagerInput(input: string, key: Key, snapshot: ManagerSnapshot, controller: ManagerController, ui: ManagerInputState): void {
  if ((key.ctrl && input === "c") || input === "q") { ui.onQuit(); return; }
  if (snapshot.confirmation) {
    if (input.toLowerCase() === "y" || key.return) void controller.confirmPendingAction();
    else if (input.toLowerCase() === "n" || key.escape) controller.cancelConfirmation();
    return;
  }
  if (input === "?") { ui.setHelpOpen((current) => !current); ui.setMenuOpen(false); return; }
  if (input === "a") { ui.setMenuOpen((current) => !current); ui.setHelpOpen(false); ui.setMenuIndex(0); return; }
  if (ui.menuOpen) {
    const actions = getAvailableManagerActions(snapshot);
    if (key.escape) ui.setMenuOpen(false);
    else if (actions.length && (key.upArrow || key.downArrow)) ui.setMenuIndex((current) => (current + (key.upArrow ? -1 : 1) + actions.length) % actions.length);
    else if (key.return) {
      const selected = actions[Math.max(0, Math.min(ui.menuIndex, actions.length - 1))];
      if (selected) {
        ui.setMenuOpen(false);
        if (selected.id === "quit") ui.onQuit();
        else void controller.perform(selected.id);
      }
    }
    return;
  }
  if (ui.helpOpen) { if (key.escape) ui.setHelpOpen(false); return; }
  if (snapshot.workspaceDetail) {
    if (key.escape) controller.closeWorkspaceDetail();
    else if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      ui.scroll(key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -ui.pageHeight : ui.pageHeight);
    } else {
      const action = managerActionForShortcut(snapshot, input.toLowerCase());
      if (action) void controller.perform(action.id);
    }
    return;
  }
  if (key.return) { ui.resetScroll(); void controller.openWorkspaceDetail(); return; }
  if (key.upArrow || key.downArrow) { controller.moveWorkspaceSelection(key.upArrow ? -1 : 1); return; }
  const action = managerActionForShortcut(snapshot, input.toLowerCase());
  if (action) void controller.perform(action.id);
}

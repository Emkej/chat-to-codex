import type { ManagerSnapshot } from "./types.js";
import type { ManagerWriteRequestServices } from "./write-request-service.js";
import { isTerminal, type WriteRequestReceipt } from "../write-requests/types.js";

export interface RequestReviewHost {
  snapshot(): ManagerSnapshot;
  patch(value: Partial<ManagerSnapshot>): void;
  run(work: (signal: AbortSignal) => Promise<void>): Promise<boolean>;
  cancel(): void;
}

/** Transient review state; transport and broker own records and write policy. */
export class RequestReviewController {
  private generation = 0;
  private confirmationId: string | null = null;

  constructor(private readonly host: RequestReviewHost, private readonly services: ManagerWriteRequestServices) {}

  async openQueue(): Promise<boolean> {
    const snapshot = this.host.snapshot();
    const workspaceId = snapshot.selectedWorkspaceId;
    if (!workspaceId || snapshot.activeAction || snapshot.confirmation || snapshot.closed) return false;
    const generation = ++this.generation;
    return this.host.run(async (signal) => {
      this.host.patch({ workspaceDetail: null, requestReview: { workspaceId, state: "loading", requests: [], overflow: false, selectedIndex: 0, detail: null } });
      await this.reconcileOwned(signal);
      try {
        const result = await this.services.list(workspaceId, signal);
        if (this.current(workspaceId, generation) && !signal.aborted) {
          this.host.patch({ requestReview: { workspaceId, state: "ready", requests: result.requests, overflow: result.overflow, selectedIndex: 0, detail: null } });
        }
      } catch {
        if (this.current(workspaceId, generation) && !signal.aborted) {
          this.host.patch({ requestReview: { workspaceId, state: "unavailable", requests: [], overflow: false, selectedIndex: 0, detail: null } });
        }
      }
    });
  }

  async openDetail(): Promise<boolean> {
    const snapshot = this.host.snapshot(), review = snapshot.requestReview;
    const request = review?.requests[review.selectedIndex];
    if (!review || !request || snapshot.activeAction || snapshot.confirmation) return false;
    const generation = ++this.generation;
    return this.host.run(async (signal) => {
      this.host.patch({ requestReview: { ...review, detail: { state: "loading", request: null } } });
      try {
        const detail = await this.services.detail(review.workspaceId, request.id, signal);
        if (detail.id !== request.id || detail.workspaceId !== review.workspaceId) throw new Error("Request target changed.");
        if (this.current(review.workspaceId, generation) && !signal.aborted) {
          this.host.patch({ requestReview: { ...review, detail: { state: "ready", request: detail } } });
        }
      } catch {
        if (this.current(review.workspaceId, generation) && !signal.aborted) {
          this.host.patch({ requestReview: { ...review, detail: { state: "unavailable", request: null } } });
        }
      }
    });
  }

  moveSelection(delta: number): void {
    const snapshot = this.host.snapshot(), review = snapshot.requestReview;
    if (!review || review.detail || !review.requests.length || snapshot.confirmation) return;
    this.host.patch({ requestReview: { ...review, selectedIndex: (review.selectedIndex + delta + review.requests.length) % review.requests.length } });
  }

  back(): void {
    const review = this.host.snapshot().requestReview;
    this.invalidate();
    this.host.patch({ requestReview: review?.detail ? { ...review, detail: null } : null });
  }

  invalidate(): void {
    this.generation++;
    this.confirmationId = null;
    this.host.cancel();
    if (this.host.snapshot().confirmation === "approve") this.host.patch({ confirmation: null });
  }

  requestApproval(): boolean {
    const snapshot = this.host.snapshot(), detail = snapshot.requestReview?.detail;
    const request = detail?.request;
    if (snapshot.closed || snapshot.activeAction || snapshot.confirmation || detail?.state !== "ready" ||
      !request || request.status !== "pending" || !request.patch || Date.parse(request.expiresAt ?? "") <= Date.now() ||
      snapshot.approvalAttempt?.state === "unknown") return false;
    this.confirmationId = request.id;
    this.host.patch({ confirmation: "approve", notice: `Apply ${request.id}? y/Enter confirms; n/Esc cancels.` });
    return true;
  }

  async confirmApproval(): Promise<boolean> {
    const snapshot = this.host.snapshot(), request = snapshot.requestReview?.detail?.request;
    const id = this.confirmationId;
    this.confirmationId = null;
    this.host.patch({ confirmation: null });
    if (snapshot.confirmation !== "approve" || !request || request.id !== id || snapshot.approvalAttempt?.state === "unknown") return false;
    return this.host.run(async (signal) => {
      try {
        const receipt = await this.services.approve(request.id, signal, () => {
          this.host.patch({ approvalAttempt: { id: request.id, workspaceId: request.workspaceId, state: "unknown" }, notice: `Approval dispatched for ${request.id}. Outcome awaits broker confirmation.` });
        });
        this.acceptReceipt(receipt);
      } catch (error) {
        if (!this.host.snapshot().closed) {
          this.host.patch({ notice: `Approval response unavailable: ${error instanceof Error ? error.message : "unknown error"}. Inspect ${request.id}; an already dispatched operation may still apply.` });
        }
      }
      if (!signal.aborted) await this.reconcileOwned(signal);
    });
  }

  async reconcile(): Promise<boolean> {
    if (this.host.snapshot().approvalAttempt?.state !== "unknown") return false;
    return this.host.run((signal) => this.reconcileOwned(signal));
  }

  private async reconcileOwned(signal: AbortSignal): Promise<void> {
    const attempt = this.host.snapshot().approvalAttempt;
    if (!attempt || attempt.state !== "unknown" || signal.aborted) return;
    try {
      const receipt = await this.services.receipt(attempt.workspaceId, attempt.id, signal);
      if (!signal.aborted) this.acceptReceipt(receipt);
    }
    catch { /* Pending, missing and unavailable receipts leave the dispatched outcome unknown. */ }
  }

  private acceptReceipt(receipt: WriteRequestReceipt): void {
    const snapshot = this.host.snapshot(), attempt = snapshot.approvalAttempt;
    if (!attempt || receipt.id !== attempt.id || receipt.workspaceId !== attempt.workspaceId ||
      !isTerminal(receipt.status) || !receipt.resolvedAt) return;
    const review = snapshot.requestReview;
    this.host.patch({
      approvalAttempt: { ...attempt, state: "resolved", receipt },
      notice: `${receipt.id}: ${receipt.status}${receipt.resolutionCode ? " (" + receipt.resolutionCode + ")" : ""}.`,
      ...(review?.detail?.request?.id === receipt.id ? { requestReview: { ...review, detail: { state: "ready", request: receipt } } } : {}),
    });
  }

  private current(workspaceId: string, generation: number): boolean {
    const snapshot = this.host.snapshot();
    return !snapshot.closed && generation === this.generation && snapshot.selectedWorkspaceId === workspaceId && snapshot.requestReview?.workspaceId === workspaceId;
  }
}

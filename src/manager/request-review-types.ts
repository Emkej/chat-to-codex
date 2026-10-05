import type { WriteRequestDetails } from "../write-requests/service.js";
import type { WriteRequestReceipt } from "../write-requests/types.js";

export interface RequestReviewState {
  workspaceId: string;
  state: "loading" | "ready" | "unavailable";
  requests: WriteRequestReceipt[];
  overflow: boolean;
  selectedIndex: number;
  detail: { state: "loading" | "ready" | "unavailable"; request: WriteRequestDetails | null } | null;
}

export interface ApprovalAttempt {
  workspaceId: string;
  id: string;
  state: "unknown" | "resolved";
  receipt?: WriteRequestReceipt;
}

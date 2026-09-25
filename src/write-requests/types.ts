export type WriteRequestStatus = "pending" | "applied" | "rejected" | "stale" | "expired" | "failed";
export type WriteApprovalMode = "manual-local" | "host-confirmed";
export type WriteOperation = "create" | "update";

export interface WriteRequestFile {
  path: string;
  operation: WriteOperation;
  additions: number;
  deletions: number;
  baseSha256?: string;
  resultSha256: string;
}

export type WritePrecondition =
  | { path: string; expected: "absent" }
  | { path: string; expected: "sha256"; baseSha256: string };

export interface WriteRequestRecord {
  id: string;
  kind: "patch";
  status: WriteRequestStatus;
  workspaceId: string;
  worktreeId?: string;
  approvalMode: WriteApprovalMode;
  files: WriteRequestFile[];
  preconditions: WritePrecondition[];
  patch?: string;
  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolutionCode?: string;
}

export type WriteRequestReceipt = Omit<WriteRequestRecord, "patch">;

export type WriteRequestErrorCode =
  | "PATCH_INVALID"
  | "PATCH_TOO_LARGE"
  | "PATCH_TOO_MANY_FILES"
  | "PATCH_UNSUPPORTED_OPERATION"
  | "PATCH_DOES_NOT_APPLY"
  | "WRITE_ACCESS_DENIED"
  | "WRITE_PROTECTED_PATH"
  | "WRITE_SYMLINK_DENIED"
  | "WRITE_TARGET_NOT_FILE"
  | "WRITE_TARGET_EXISTS"
  | "WRITE_PARENT_MISSING"
  | "WRITE_FILE_TOO_LARGE"
  | "WRITE_STALE"
  | "WRITE_REQUEST_NOT_FOUND"
  | "WRITE_REQUEST_NOT_PENDING"
  | "WRITE_REQUEST_EXPIRED"
  | "WRITE_APPLY_FAILED"
  | "WRITE_RECEIPT_PERSIST_FAILED"
  | "WRITE_ROLLBACK_FAILED"
  | "WRITE_OWNER_ALREADY_HELD"
  | "WRITE_OWNER_UNAVAILABLE"
  | "WORKSPACE_UNAVAILABLE"
  | "WORKTREE_UNAVAILABLE";

export class WriteRequestError extends Error {
  constructor(
    public readonly code: WriteRequestErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "WriteRequestError";
  }
}

export function isTerminal(status: WriteRequestStatus): boolean {
  return status !== "pending";
}

export function toReceipt(record: WriteRequestRecord): WriteRequestReceipt {
  const { patch: _patch, ...receipt } = record;
  return receipt;
}

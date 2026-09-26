export interface CodingPod {
  id: string;
  companyId: string;
  projectId: string;
  ownerAgentId: string;
  reviewerAgentId: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CodingPodIssueBinding {
  id: string;
  companyId: string;
  projectId: string;
  issueId: string;
  podId: string;
  ownerAgentId: string;
  reviewerAgentId: string;
  boardUserId: string;
  reviewStageId: string;
  approvalStageId: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CodingPodIssuePhase =
  | "not_configured"
  | "owner_working"
  | "review_pending"
  | "review_running"
  | "awaiting_board"
  | "candidate_stale"
  | "changes_requested"
  | "accepted";

export interface CodingPodIssueView {
  binding: CodingPodIssueBinding | null;
  candidate: null;
  phase: CodingPodIssuePhase;
}

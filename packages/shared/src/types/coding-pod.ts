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
  candidate: CodingPodCandidate | null;
  phase: CodingPodIssuePhase;
}

export interface CodingPodCandidate {
  id: string;
  companyId: string;
  projectId: string;
  issueId: string;
  ownerAgentId: string;
  reviewerAgentId: string;
  workspaceId: string;
  reviewWorkspaceId: string | null;
  baseSha: string;
  headSha: string;
  reviewStageId: string;
  entryStatusVersion: number;
  createdAt: Date;
}

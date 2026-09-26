import type { CodingPod, CodingPodIssueBinding, CodingPodIssueView } from "@paperclipai/shared";
import { api } from "./client";

const scope = (companyId: string) => `/companies/${encodeURIComponent(companyId)}`;

export const codingPodsApi = {
  getProject: (companyId: string, projectId: string) =>
    api.get<CodingPod | null>(`${scope(companyId)}/projects/${encodeURIComponent(projectId)}/coding-pod`),
  saveProject: (companyId: string, projectId: string, input: Pick<CodingPod, "ownerAgentId" | "reviewerAgentId" | "enabled">) =>
    api.put<CodingPod>(`${scope(companyId)}/projects/${encodeURIComponent(projectId)}/coding-pod`, input),
  getIssue: (companyId: string, issueId: string) =>
    api.get<CodingPodIssueView>(`${scope(companyId)}/issues/${encodeURIComponent(issueId)}/coding-pod`),
  attachIssue: (companyId: string, issueId: string) =>
    api.post<CodingPodIssueBinding>(`${scope(companyId)}/issues/${encodeURIComponent(issueId)}/coding-pod`, {}),
};

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingPodIssueView } from "@paperclipai/shared";
import { ProjectCodingPodCard } from "./ProjectCodingPodCard";
import { IssueCodingPodPanel } from "./IssueCodingPodPanel";

vi.mock("@/lib/router", () => ({ Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a> }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const agents = [
  { id: "owner", name: "Owner", status: "active" as const },
  { id: "reviewer", name: "Reviewer", status: "active" as const },
];
const binding = { id: "binding", companyId: "co", projectId: "project", issueId: "issue",
  podId: "pod", ownerAgentId: "owner", reviewerAgentId: "reviewer", boardUserId: "board",
  reviewStageId: "review", approvalStageId: "approval", createdAt: new Date(), updatedAt: new Date() };
const candidate = { id: "candidate", companyId: "co", projectId: "project", issueId: "issue",
  ownerAgentId: "owner", reviewerAgentId: "reviewer", workspaceId: "workspace", reviewWorkspaceId: "review-workspace",
  baseSha: "a".repeat(40), headSha: "b".repeat(40), reviewStageId: "review",
  entryStatusVersion: 3, createdAt: new Date() };

describe("coding pod cockpit", () => {
  it("requires distinct agents and an explicit save; shows setup failures", () => {
    const save = vi.fn();
    const element = render(<ProjectCodingPodCard agents={agents} pod={null} loading={false} isolatedWorkspacesEnabled
      onSave={save} saving={false} error={null} />);
    const button = Array.from(element.querySelectorAll("button")).find((item) => item.textContent?.includes("Save coding pod"))!;
    expect(button.disabled).toBe(true);
    const selects = element.querySelectorAll("select");
    act(() => { selects[0]!.value = "owner"; selects[0]!.dispatchEvent(new Event("change", { bubbles: true })); });
    act(() => { selects[1]!.value = "owner"; selects[1]!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button.disabled).toBe(true);
    act(() => { selects[1]!.value = "reviewer"; selects[1]!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(save).toHaveBeenCalledWith({ ownerAgentId: "owner", reviewerAgentId: "reviewer", enabled: true });
    expect(element.textContent).toContain("No task starts when you save");
  });

  it("shows isolated workspace setup path and API error", () => {
    const element = render(<ProjectCodingPodCard agents={agents} pod={null} loading={false} isolatedWorkspacesEnabled={false}
      onSave={vi.fn()} saving={false} error="Could not save" />);
    expect(element.textContent).toContain("Could not save");
    expect(element.querySelector('a[href="/company/settings/instance/experimental"]')).not.toBeNull();
  });

  it("shows explicit attachment without starting work", () => {
    const attach = vi.fn();
    const view: CodingPodIssueView = { binding: null, candidate: null, phase: "not_configured" };
    const element = render(<IssueCodingPodPanel view={view} loading={false} error={null} attachError={null}
      issueStatus="backlog" podConfigured onAttach={attach} attaching={false} onDecide={vi.fn()} deciding={false} />);
    expect(element.textContent).toContain("Attach coding pod");
    act(() => element.querySelector("button")!.click());
    expect(attach).toHaveBeenCalledOnce();
    expect(element.textContent).toContain("does not start the owner");
  });

  it("shows exact candidate, stale repair, board controls, and artifact links", () => {
    const decide = vi.fn();
    const base: CodingPodIssueView = { binding, candidate, phase: "awaiting_board" };
    const element = render(<IssueCodingPodPanel view={base} loading={false} error={null} attachError={null}
      issueStatus="in_review" podConfigured onAttach={vi.fn()} attaching={false} onDecide={decide} deciding={false} repoUrl="https://github.com/acme/repo.git" />);
    expect(element.textContent).toContain(candidate.headSha);
    expect(element.querySelector('a[href="/execution-workspaces/workspace"]')).not.toBeNull();
    expect(element.querySelector('a[href="#document-plan"]')).not.toBeNull();
    expect(element.querySelector(`a[href="https://github.com/acme/repo/compare/${candidate.baseSha}...${candidate.headSha}"]`)).not.toBeNull();
    act(() => { const note = element.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Reviewed exact commit"); note.dispatchEvent(new Event("input", { bubbles: true })); });
    const approve = Array.from(element.querySelectorAll("button")).find((item) => item.textContent?.includes("Approve candidate"))!;
    act(() => approve.click());
    expect(decide).toHaveBeenCalledWith("approved", "Reviewed exact commit");
    act(() => root!.render(<IssueCodingPodPanel view={{ ...base, phase: "candidate_stale" }} loading={false} error={null} attachError={null}
      issueStatus="in_review" podConfigured onAttach={vi.fn()} attaching={false} onDecide={decide} deciding={false} />));
    expect(element.textContent).toContain("Return the task to the owner");
    expect(element.textContent).not.toContain("Approve candidate");
    expect(element.querySelector('a[href="/api/companies/co/issues/issue/coding-pod/diff?candidateId=candidate"]')).not.toBeNull();
  });
});

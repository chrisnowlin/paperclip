import { useState } from "react";
import type { CodingPodIssuePhase, CodingPodIssueView } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

const phaseLabel: Record<CodingPodIssuePhase, string> = {
  not_configured: "Not configured", owner_working: "Owner working", review_pending: "Review pending",
  review_running: "Review running", awaiting_board: "Awaiting board", candidate_stale: "Candidate stale",
  changes_requested: "Changes requested", accepted: "Accepted",
};

function comparisonUrl(repoUrl: string | null | undefined, baseSha: string, headSha: string): string | null {
  const match = repoUrl?.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+)\/?$/i);
  return match ? `https://github.com/${match[1].replace(/\.git$/i, "")}/compare/${baseSha}...${headSha}` : null;
}

export function IssueCodingPodPanel({ view, loading, error, attachError, issueStatus, podConfigured, onAttach, attaching,
  onDecide, deciding, companyPrefix, repoUrl, onOpenArtifacts, canDecide = true }: {
  view: CodingPodIssueView | null;
  loading: boolean;
  error: string | null;
  attachError: string | null;
  issueStatus: string;
  podConfigured: boolean;
  onAttach: () => void;
  attaching: boolean;
  onDecide: (outcome: "approved" | "changes_requested", comment: string) => void;
  deciding: boolean;
  companyPrefix?: string | null;
  repoUrl?: string | null;
  onOpenArtifacts?: () => void;
  canDecide?: boolean;
}) {
  const [decisionComment, setDecisionComment] = useState("");
  const prefix = companyPrefix ? `/${encodeURIComponent(companyPrefix)}` : "";
  const phase = view?.phase ?? "not_configured";
  const candidate = view?.candidate;
  const compare = candidate ? comparisonUrl(repoUrl, candidate.baseSha, candidate.headSha) : null;
  return <Card>
    <CardHeader className="flex flex-row items-start justify-between gap-3">
      <div className="flex flex-col gap-2"><CardTitle>Coding pod</CardTitle><CardDescription>Owner implementation → agent review → board approval</CardDescription></div>
      <Badge variant={phase === "candidate_stale" ? "destructive" : "outline"}>{phaseLabel[phase]}</Badge>
    </CardHeader>
    <CardContent className="flex flex-col gap-4 text-sm">
      {loading ? <p className="text-muted-foreground">Loading coding pod…</p> : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {attachError ? <p role="alert" className="text-destructive">{attachError}</p> : null}
      {!view?.binding ? <>
        <p className="text-muted-foreground">{podConfigured ? "Attach this task to the project coding pod. Attachment does not start the owner." : "Configure a coding pod in the project first."}</p>
        {podConfigured && issueStatus === "backlog" ? <div><Button type="button" size="sm" disabled={attaching} onClick={onAttach}>{attaching ? "Attaching…" : "Attach coding pod"}</Button></div> : null}
      </> : <>
        <ol className="flex flex-wrap gap-2 text-muted-foreground" aria-label="Coding pod stages">
          <li>1. Owner</li><li>→</li><li>2. Reviewer</li><li>→</li><li>3. Board</li>
        </ol>
        {candidate ? <div className="flex flex-col gap-2">
          <p>Candidate commit <code className="font-mono break-all">{candidate.headSha}</code></p>
          <p>Base commit <code className="font-mono break-all">{candidate.baseSha}</code></p>
          <div className="flex flex-wrap gap-3">
            <a className="underline" href={compare ?? `/api/companies/${encodeURIComponent(candidate.companyId)}/issues/${encodeURIComponent(candidate.issueId)}/coding-pod/diff?candidateId=${encodeURIComponent(candidate.id)}`} target="_blank" rel="noreferrer">Inspect diff</a>
            <Link className="underline" to={`${prefix}/execution-workspaces/${candidate.workspaceId}`}>Owner workspace</Link>
            {candidate.reviewWorkspaceId ? <Link className="underline" to={`${prefix}/execution-workspaces/${candidate.reviewWorkspaceId}`}>Review workspace</Link> : null}
          </div>
        </div> : null}
        <nav className="flex flex-wrap gap-3 text-muted-foreground" aria-label="Task evidence">
          <a className="underline" href="#document-plan">Plan</a>
          {onOpenArtifacts ? <button className="underline" type="button" onClick={onOpenArtifacts}>Work products</button>
            : <a className="underline" href="#task-work-products">Work products</a>}
          <Link className="underline" to={`${prefix}/activity/runs`}>Run ledger</Link>
          <a className="underline" href="#task-conversation">Stage comments</a>
        </nav>
        {phase === "candidate_stale" ? <p role="alert" className="text-destructive">The source worktree changed after the candidate was captured. Return the task to the owner for a clean commit and a new review.</p> : null}
        {phase === "changes_requested" ? <p className="text-muted-foreground">The owner needs to address the review feedback and submit a new clean candidate.</p> : null}
        {phase === "awaiting_board" && !canDecide ? <p className="text-muted-foreground">Waiting for the pinned board approver.</p> : null}
        {phase === "awaiting_board" && canDecide ? <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-2">Decision note
            <textarea className="min-h-16 rounded-md border border-input bg-background p-2 text-sm" value={decisionComment} onChange={(event) => setDecisionComment(event.target.value)} placeholder="Explain your decision" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={deciding || !decisionComment.trim()} onClick={() => onDecide("approved", decisionComment.trim())}>Approve candidate</Button>
            <Button type="button" size="sm" variant="outline" disabled={deciding || !decisionComment.trim()} onClick={() => onDecide("changes_requested", decisionComment.trim())}>Request changes</Button>
          </div>
        </div> : null}
      </>}
    </CardContent>
  </Card>;
}

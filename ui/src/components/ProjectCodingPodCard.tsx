import { useEffect, useState } from "react";
import type { Agent, CodingPod } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

type AgentOption = Pick<Agent, "id" | "name" | "status">;
type PodInput = Pick<CodingPod, "ownerAgentId" | "reviewerAgentId" | "enabled">;

export function ProjectCodingPodCard({ agents, pod, loading, isolatedWorkspacesEnabled, onSave, saving, error }: {
  agents: AgentOption[];
  pod: CodingPod | null;
  loading: boolean;
  isolatedWorkspacesEnabled: boolean;
  onSave: (input: PodInput) => void;
  saving: boolean;
  error: string | null;
}) {
  const [ownerAgentId, setOwnerAgentId] = useState(pod?.ownerAgentId ?? "");
  const [reviewerAgentId, setReviewerAgentId] = useState(pod?.reviewerAgentId ?? "");
  const [enabled, setEnabled] = useState(pod?.enabled ?? true);
  useEffect(() => {
    setOwnerAgentId(pod?.ownerAgentId ?? "");
    setReviewerAgentId(pod?.reviewerAgentId ?? "");
    setEnabled(pod?.enabled ?? true);
  }, [pod?.ownerAgentId, pod?.reviewerAgentId, pod?.enabled]);
  const activeAgents = agents.filter((agent) => agent.status === "active");
  const valid = Boolean(ownerAgentId && reviewerAgentId && ownerAgentId !== reviewerAgentId &&
    activeAgents.some((agent) => agent.id === ownerAgentId) && activeAgents.some((agent) => agent.id === reviewerAgentId));
  return <Card className="mt-6">
    <CardHeader>
      <CardTitle>Coding pod</CardTitle>
      <CardDescription>Choose one owner and one independent reviewer for this project. No task starts when you save.</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      {!isolatedWorkspacesEnabled ? <p className="text-sm text-muted-foreground">
        Enable isolated workspaces in <Link className="underline" to="/company/settings/instance/experimental">instance settings</Link> before running a coding pod.
      </p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading coding pod…</p> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm font-medium">Owner agent
          <select aria-label="Owner agent" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={ownerAgentId} onChange={(event) => setOwnerAgentId(event.target.value)}>
            <option value="">Select owner</option>
            {activeAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm font-medium">Reviewer agent
          <select aria-label="Reviewer agent" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={reviewerAgentId} onChange={(event) => setReviewerAgentId(event.target.value)}>
            <option value="">Select reviewer</option>
            {activeAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Pod enabled</label>
      {ownerAgentId && reviewerAgentId && ownerAgentId === reviewerAgentId ? <p role="alert" className="text-sm text-destructive">Owner and reviewer must be different agents.</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div><Button type="button" disabled={!valid || loading || saving || !isolatedWorkspacesEnabled} onClick={() => onSave({ ownerAgentId, reviewerAgentId, enabled })}>
        {saving ? "Saving…" : "Save coding pod"}
      </Button></div>
    </CardContent>
  </Card>;
}

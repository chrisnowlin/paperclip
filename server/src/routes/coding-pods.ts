import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { issues, projects, type Db } from "@paperclipai/db";
import { attachCodingPodIssueSchema, upsertCodingPodSchema } from "@paperclipai/shared";
import { attachCodingPodToIssue, codingPodService, getCodingPodIssueView } from "../services/coding-pods.js";
import { readCodingPodCandidateDiff } from "../services/coding-pod-candidates.js";
import { logActivity } from "../services/activity-log.js";
import { validate } from "../middleware/validate.js";
import { assertBoard, getAccessibleResource, getActorInfo } from "./authz.js";

export function codingPodRoutes(db: Db) {
  const router = Router();
  const service = codingPodService(db);

  router.get("/companies/:companyId/projects/:projectId/coding-pod", async (req, res) => {
    const companyId = String(req.params.companyId);
    const projectId = String(req.params.projectId);
    const [project] = await db.select().from(projects).where(and(
      eq(projects.id, projectId), eq(projects.companyId, companyId),
    )).limit(1);
    if (!await getAccessibleResource(req, res, project, "Project not found")) return;
    res.json(await service.get(companyId, projectId));
  });

  router.put("/companies/:companyId/projects/:projectId/coding-pod", validate(upsertCodingPodSchema), async (req, res) => {
    assertBoard(req);
    const companyId = String(req.params.companyId);
    const projectId = String(req.params.projectId);
    const [project] = await db.select().from(projects).where(and(
      eq(projects.id, projectId), eq(projects.companyId, companyId),
    )).limit(1);
    if (!await getAccessibleResource(req, res, project, "Project not found")) return;
    const pod = await service.upsert(companyId, projectId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId, actorType: actor.actorType, actorId: actor.actorId,
      action: "coding_pod.updated", entityType: "project", entityId: projectId,
      details: { podId: pod.id, ownerAgentId: pod.ownerAgentId, reviewerAgentId: pod.reviewerAgentId, enabled: pod.enabled },
    });
    res.json(pod);
  });

  router.get("/companies/:companyId/issues/:issueId/coding-pod", async (req, res) => {
    const companyId = String(req.params.companyId);
    const issueId = String(req.params.issueId);
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
    if (!await getAccessibleResource(req, res, issue, "Issue not found")) return;
    res.json(await getCodingPodIssueView(db, companyId, issueId));
  });

  router.get("/companies/:companyId/issues/:issueId/coding-pod/diff", async (req, res) => {
    const companyId = String(req.params.companyId);
    const issueId = String(req.params.issueId);
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
    if (!await getAccessibleResource(req, res, issue, "Issue not found")) return;
    const candidateId = typeof req.query.candidateId === "string" ? req.query.candidateId : "";
    const diff = await readCodingPodCandidateDiff(db, { companyId, issueId, candidateId });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type("text/plain").send(diff);
  });

  router.post("/companies/:companyId/issues/:issueId/coding-pod", validate(attachCodingPodIssueSchema), async (req, res) => {
    assertBoard(req);
    const companyId = String(req.params.companyId);
    const issueId = String(req.params.issueId);
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
    if (!await getAccessibleResource(req, res, issue, "Issue not found")) return;
    const actor = getActorInfo(req);
    res.json(await attachCodingPodToIssue(db, { companyId, issueId, actorUserId: actor.actorId }));
  });

  return router;
}

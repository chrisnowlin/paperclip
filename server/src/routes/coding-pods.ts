import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { projects, type Db } from "@paperclipai/db";
import { upsertCodingPodSchema } from "@paperclipai/shared";
import { codingPodService } from "../services/coding-pods.js";
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

  return router;
}

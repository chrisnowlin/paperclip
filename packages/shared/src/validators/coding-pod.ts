import { z } from "zod";

export const upsertCodingPodSchema = z.object({
  ownerAgentId: z.string().uuid(),
  reviewerAgentId: z.string().uuid(),
  enabled: z.boolean(),
}).strict();

export type UpsertCodingPod = z.infer<typeof upsertCodingPodSchema>;

export const attachCodingPodIssueSchema = z.object({}).strict();

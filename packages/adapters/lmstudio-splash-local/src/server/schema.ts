import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return { fields: [{ key: "maxSteps", label: "Maximum model steps", type: "number", default: 20,
    hint: "Maximum model responses in one task run (1–24)." }] };
}

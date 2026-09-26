import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseLmStudioSplashStdoutLine(line: string, ts: string): TranscriptEntry[] {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return [{ kind: "stdout", ts, text: line }]; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [{ kind: "stdout", ts, text: line }];
  const event = value as Record<string, unknown>;
  if (event.type === "assistant" && typeof event.text === "string") {
    return [{ kind: "assistant", ts, text: event.text }];
  }
  if (event.type === "tool_call" && typeof event.name === "string") {
    return [{ kind: "tool_call", ts, name: event.name, input: {} }];
  }
  if (event.type === "tool_result" && typeof event.name === "string") {
    return [{ kind: "tool_result", ts, toolUseId: event.name, content: `${event.name} ${event.isError === true ? "failed" : "completed"}`,
      isError: event.isError === true }];
  }
  return [{ kind: "stdout", ts, text: line }];
}

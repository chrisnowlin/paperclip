export function printLmStudioSplashStreamEvent(raw: string, debug = false): void {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { if (debug) console.log(raw); return; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const event = value as Record<string, unknown>;
  if (event.type === "assistant" && typeof event.text === "string") console.log(event.text);
  else if (event.type === "tool_call" && typeof event.name === "string") console.log(`Using ${event.name}…`);
  else if (event.type === "tool_result" && typeof event.name === "string") console.log(`${event.name}: ${event.isError === true ? "failed" : "completed"}`);
  else if (debug) console.log(raw);
}

export const LMSTUDIO_SPLASH_MODEL = "qwen3.8-27b-splash";
const MODELS_URL = "http://127.0.0.1:1234/api/v1/models";
const COMPLETIONS_URL = "http://127.0.0.1:1234/v1/chat/completions";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 524_288;
const MAX_CONTENT_CHARS = 65_536;
const MAX_TOOL_CALLS = 4;

export interface LmStudioMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface LmStudioToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LmStudioToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("LM Studio returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("LM Studio response exceeds the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("LM Studio returned malformed JSON.");
  }
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function probeLmStudioSplash(fetcher: typeof fetch = fetch): Promise<{ modelId: string }> {
  let response: Response;
  try {
    response = await fetcher(MODELS_URL, { method: "GET", redirect: "error", signal: AbortSignal.timeout(2_000) });
  } catch {
    throw new Error("LM Studio is unavailable at 127.0.0.1:1234.");
  }
  if (!response.ok) throw new Error(`LM Studio readiness failed with HTTP ${response.status}.`);
  const body = await readBoundedJson(response);
  const models = isRecord(body) && Array.isArray(body.models) ? body.models : null;
  if (!models) throw new Error("LM Studio model inventory is malformed.");
  const selected = models.find((entry: unknown) => isRecord(entry) && entry.key === LMSTUDIO_SPLASH_MODEL);
  if (!selected) throw new Error("The exact Splash model is not available in LM Studio.");
  if (!isRecord(selected) || selected.format !== "splash") {
    throw new Error("The selected LM Studio model is not in Splash format.");
  }
  if (!Array.isArray(selected.loaded_instances) || selected.loaded_instances.length === 0) {
    throw new Error("The Splash model is not loaded in LM Studio. Load it explicitly before assigning work.");
  }
  return { modelId: LMSTUDIO_SPLASH_MODEL };
}

export async function completeLmStudioTurn(input: {
  messages: LmStudioMessage[];
  tools: LmStudioToolDefinition[];
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<{ content: string | null; toolCalls: LmStudioToolCall[]; usage: { inputTokens: number; outputTokens: number } }> {
  const payload = JSON.stringify({
    model: LMSTUDIO_SPLASH_MODEL,
    messages: input.messages,
    tools: input.tools,
    tool_choice: "auto",
    temperature: 0,
    max_tokens: 2_048,
    stream: false,
  });
  if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) throw new Error("LM Studio request exceeds the size limit.");
  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(COMPLETIONS_URL, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: requestSignal(input.signal, 120_000),
    });
  } catch {
    throw new Error("LM Studio inference is unavailable or timed out; no alternate provider was tried.");
  }
  if (!response.ok) throw new Error(`LM Studio inference failed with HTTP ${response.status}; no alternate provider was tried.`);
  const body = await readBoundedJson(response);
  const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : null;
  const message = isRecord(choice) ? choice.message : null;
  if (!isRecord(message)) throw new Error("LM Studio completion is malformed.");
  const content = message.content === null || message.content === undefined ? null : message.content;
  if (content !== null && (typeof content !== "string" || content.length > MAX_CONTENT_CHARS)) {
    throw new Error("LM Studio completion content is invalid.");
  }
  const rawCalls = message.tool_calls === undefined ? [] : message.tool_calls;
  if (!Array.isArray(rawCalls) || rawCalls.length > MAX_TOOL_CALLS) throw new Error("LM Studio tool call count is invalid.");
  const ids = new Set<string>();
  const toolCalls = rawCalls.map((entry: unknown): LmStudioToolCall => {
    const fn = isRecord(entry) ? entry.function : null;
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 128 ||
        entry.type !== "function" || !isRecord(fn) || typeof fn.name !== "string" ||
        !/^[a-z][a-z0-9_]*$/.test(fn.name) || typeof fn.arguments !== "string" ||
        fn.arguments.length > 65_536 || ids.has(entry.id)) {
      throw new Error("LM Studio tool call is malformed.");
    }
    ids.add(entry.id);
    let args: unknown;
    try { args = JSON.parse(fn.arguments); } catch { throw new Error("LM Studio tool call arguments are malformed."); }
    if (!isRecord(args)) throw new Error("LM Studio tool call arguments must be an object.");
    return { id: entry.id, name: fn.name, arguments: args };
  });
  if (content === null && toolCalls.length === 0) throw new Error("LM Studio completion has no content or tool call.");
  const rawUsage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  const tokenCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return { content: content as string | null, toolCalls, usage: {
    inputTokens: tokenCount(rawUsage.prompt_tokens), outputTokens: tokenCount(rawUsage.completion_tokens),
  } };
}

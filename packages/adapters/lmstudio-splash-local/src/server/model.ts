import { Agent, fetch as undiciFetch } from "undici";
import { LMSTUDIO_SPLASH_MODEL, SPLASH_PACKAGE_ID, SPLASH_CONTEXT_TOKEN_LIMIT, SPLASH_OUTPUT_TOKEN_BUDGET } from "../index.js";
export { LMSTUDIO_SPLASH_MODEL };
const READY_URL = "http://127.0.0.1:3321/ready";
const STATUS_URL = "http://127.0.0.1:3321/status";
const MODELS_URL = "http://127.0.0.1:3321/v1/models";
const COMPLETIONS_URL = "http://127.0.0.1:3321/v1/chat/completions";
const TEMPLATE_URL = "http://127.0.0.1:3321/apply-template";
const TOKENIZE_URL = "http://127.0.0.1:3321/tokenize";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TOKENIZE_RESPONSE_BYTES = 2_000_000;
const MAX_REQUEST_BYTES = 524_288;
const MAX_CONTENT_CHARS = 65_536;
const MAX_TOOL_CALLS = 4;
// Splash's non-streaming Chat response can take longer than Node fetch's
// 300-second header deadline. Keep this dispatcher scoped to loopback Splash.
const splashChatDispatcher = new Agent({ headersTimeout: 1_560_000, bodyTimeout: 1_560_000 });

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

async function readBoundedJson(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  if (!response.body) throw new Error("Splash returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Splash response exceeds the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Splash returned malformed JSON.");
  }
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function probeLmStudioSplash(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<{ modelId: string }> {
  const get = async (url: string) => {
    let response: Response;
    try { response = await fetcher(url, { method: "GET", redirect: "error", signal: requestSignal(signal, 2_000) }); }
    catch { throw new Error("The app-owned Splash server is unavailable at 127.0.0.1:3321."); }
    if (!response.ok) throw new Error(`Splash readiness failed with HTTP ${response.status}.`);
    return readBoundedJson(response);
  };
  const readiness = await get(READY_URL);
  if (!isRecord(readiness) || readiness.status !== "ready") throw new Error("The app-owned Splash server is not ready.");
  const status = await get(STATUS_URL);
  const instance = isRecord(status) ? status.instance : null;
  if (!isRecord(instance) || instance.model !== SPLASH_PACKAGE_ID || instance.host !== "127.0.0.1" || instance.port !== 3321 ||
      !isRecord(status) || status.maximum_context_tokens !== SPLASH_CONTEXT_TOKEN_LIMIT) {
    throw new Error("The listener is not the app-owned Splash model.");
  }
  const catalog = await get(MODELS_URL);
  const models = isRecord(catalog) && Array.isArray(catalog.data) ? catalog.data : null;
  if (!models?.some((entry: unknown) => isRecord(entry) && entry.id === LMSTUDIO_SPLASH_MODEL &&
      entry.root === SPLASH_PACKAGE_ID && entry.owned_by === "splash")) {
    throw new Error("The listener is not the app-owned Splash model.");
  }
  return { modelId: LMSTUDIO_SPLASH_MODEL };
}

/** Splash reports a model-lifetime aggregate; callers display turn deltas as approximate. */
export async function readSplashDecodeTokens(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<number | null> {
  try {
    const response = await fetcher(STATUS_URL, { method: "GET", redirect: "error", signal: requestSignal(signal, 2_000) });
    if (!response.ok) return null;
    const status = await readBoundedJson(response);
    const metrics = isRecord(status) ? status.metrics : null;
    const count = isRecord(metrics) ? metrics.decode_output_tokens : null;
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch { return null; }
}

export async function completeLmStudioTurn(input: {
  messages: LmStudioMessage[];
  tools: LmStudioToolDefinition[];
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  onTokenBudget?: (budget: { promptTokens: number; maxOutputTokens: number }) => void | Promise<void>;
}): Promise<{ content: string | null; toolCalls: LmStudioToolCall[]; usage: { inputTokens: number; outputTokens: number } }> {
  const fetcher = input.fetcher ?? fetch;
  const sizingBody = JSON.stringify({
    model: LMSTUDIO_SPLASH_MODEL,
    messages: input.messages,
    tools: input.tools,
    tool_choice: "auto",
    temperature: 0,
    stream: false,
  });
  if (Buffer.byteLength(sizingBody) > MAX_REQUEST_BYTES) throw new Error("Splash request exceeds the size limit.");
  const sizingRequest = async (url: string, body: string, maxBytes = MAX_RESPONSE_BYTES) => {
    let response: Response;
    try {
      response = await fetcher(url, { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json" }, body,
        signal: requestSignal(input.signal, 30_000) });
    } catch { throw new Error("App-owned Splash prompt sizing is unavailable; no model turn was sent."); }
    if (!response.ok) throw new Error(`Splash prompt sizing failed with HTTP ${response.status}; no model turn was sent.`);
    return readBoundedJson(response, maxBytes);
  };
  // Splash's Chat endpoint rejects prompt_tokens + max_tokens above its context
  // limit. Its template and tokenizer endpoints use the same text-only rendering
  // path as generation, so size this turn before requesting the 85% ceiling.
  const template = await sizingRequest(TEMPLATE_URL, sizingBody);
  if (!isRecord(template) || typeof template.prompt !== "string") throw new Error("Splash prompt template is malformed.");
  const tokenBody = JSON.stringify({ content: template.prompt, add_special: false });
  if (Buffer.byteLength(tokenBody) > MAX_REQUEST_BYTES) throw new Error("Splash rendered prompt exceeds the size limit.");
  const tokenized = await sizingRequest(TOKENIZE_URL, tokenBody, MAX_TOKENIZE_RESPONSE_BYTES);
  if (!isRecord(tokenized) || !Array.isArray(tokenized.tokens) ||
      tokenized.tokens.some((token: unknown) => !Number.isSafeInteger(token))) {
    throw new Error("Splash prompt token count is malformed.");
  }
  const remainingContext = SPLASH_CONTEXT_TOKEN_LIMIT - tokenized.tokens.length;
  if (remainingContext <= 0) throw new Error("Splash prompt fills the configured context window.");
  const maxOutputTokens = Math.min(SPLASH_OUTPUT_TOKEN_BUDGET, remainingContext);
  await input.onTokenBudget?.({ promptTokens: tokenized.tokens.length, maxOutputTokens });
  const payload = JSON.stringify({
    model: LMSTUDIO_SPLASH_MODEL,
    messages: input.messages,
    tools: input.tools,
    tool_choice: "auto",
    temperature: 0,
    max_tokens: maxOutputTokens,
    stream: false,
  });
  if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) throw new Error("Splash request exceeds the size limit.");
  const signal = requestSignal(input.signal, 1_500_000);
  let response: Response;
  try {
    const request = { method: "POST" as const, redirect: "error" as const,
      headers: { "Content-Type": "application/json" }, body: payload, signal };
    response = input.fetcher
      ? await input.fetcher(COMPLETIONS_URL, request)
      : await undiciFetch(COMPLETIONS_URL, { ...request, dispatcher: splashChatDispatcher }) as unknown as Response;
  } catch (error) {
    if (signal.aborted) throw new Error("App-owned Splash turn was cancelled or exceeded its 25-minute local limit; no alternate provider was tried.");
    const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : null;
    if (cause?.code === "UND_ERR_HEADERS_TIMEOUT") {
      throw new Error("App-owned Splash response headers exceeded the local transport wait; no alternate provider was tried.");
    }
    throw new Error("App-owned Splash inference is unavailable or timed out; no alternate provider was tried.");
  }
  if (!response.ok) throw new Error(`Splash inference failed with HTTP ${response.status}; no alternate provider was tried.`);
  const body = await readBoundedJson(response);
  const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : null;
  const message = isRecord(choice) ? choice.message : null;
  if (!isRecord(message)) throw new Error("Splash completion is malformed.");
  if (isRecord(choice) && choice.finish_reason === "length") {
    throw new Error(`Splash returned a length-limited answer with a requested output budget of ${SPLASH_OUTPUT_TOKEN_BUDGET.toLocaleString("en-US")} tokens; no partial tools were run.`);
  }
  const content = message.content === null || message.content === undefined ? null : message.content;
  if (content !== null && (typeof content !== "string" || content.length > MAX_CONTENT_CHARS)) {
    throw new Error("Splash completion content is invalid.");
  }
  const rawCalls = message.tool_calls === undefined ? [] : message.tool_calls;
  if (!Array.isArray(rawCalls) || rawCalls.length > MAX_TOOL_CALLS) throw new Error("Splash tool call count is invalid.");
  const ids = new Set<string>();
  const toolCalls = rawCalls.map((entry: unknown): LmStudioToolCall => {
    const fn = isRecord(entry) ? entry.function : null;
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 128 ||
        entry.type !== "function" || !isRecord(fn) || typeof fn.name !== "string" ||
        !/^[a-z][a-z0-9_]*$/.test(fn.name) || typeof fn.arguments !== "string" ||
        fn.arguments.length > 65_536 || ids.has(entry.id)) {
      throw new Error("Splash tool call is malformed.");
    }
    ids.add(entry.id);
    let args: unknown;
    try { args = JSON.parse(fn.arguments); } catch { throw new Error("Splash tool call arguments are malformed."); }
    if (!isRecord(args)) throw new Error("Splash tool call arguments must be an object.");
    return { id: entry.id, name: fn.name, arguments: args };
  });
  if (toolCalls.length === 0) {
    if (isRecord(choice) && choice.finish_reason !== "stop") throw new Error("Splash returned an unfinished answer.");
    if (typeof content !== "string" || !content.trim()) throw new Error("Splash completion has no content.");
  } else if (isRecord(choice) && choice.finish_reason !== "tool_calls") {
    throw new Error("Splash returned an unfinished tool call.");
  }
  const rawUsage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  const tokenCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return { content: content as string | null, toolCalls, usage: {
    inputTokens: tokenCount(rawUsage.prompt_tokens), outputTokens: tokenCount(rawUsage.completion_tokens),
  } };
}

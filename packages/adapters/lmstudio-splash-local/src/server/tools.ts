import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LmStudioToolCall, LmStudioToolDefinition } from "./model.js";

const MAX_FILE_BYTES = 262_144;
const MAX_READ_BYTES = 131_072;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_HTTP_BYTES = 65_536;
const MAX_ARGUMENTS = 64;
const MAX_COMMAND_MS = 300_000;
const GLM_FLASH_MODEL = "zai-coding-plan/glm-5.3-flash";
const MAX_CTO_HIRES_PER_RUN = 3;

export class UncertainPaperclipMutationError extends Error {
  constructor() { super("Paperclip request outcome is uncertain; do not retry this mutation automatically."); }
}

export class InterruptedCodingCommandError extends Error {}

const object = { type: "object", additionalProperties: false };
export const LMSTUDIO_TOOL_DEFINITIONS: LmStudioToolDefinition[] = [
  { type: "function", function: { name: "list_files", description: "List up to 200 entries in a workspace directory.",
    parameters: { ...object, properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 file inside the assigned workspace (128 KiB maximum).",
    parameters: { ...object, properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Atomically write a UTF-8 file inside an existing workspace directory.",
    parameters: { ...object, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "run_command", description: "Run a finite argv command in the assigned local-trusted workspace. No shell is added. Maximum 300 seconds and 64 KiB combined output; timeout or excess output aborts the entire agent run. Use narrow commands and never start a persistent dev server here.",
    parameters: { ...object, properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, timeoutMs: { type: "integer" } }, required: ["command"] } } },
  { type: "function", function: { name: "paperclip_request", description: "Call Paperclip with run auth. GET /api/companies/{companyId}/issues or /agents, /api/issues/{issueId} or /comments, or /api/agents/me; POST /api/companies/{companyId}/issues or /api/issues/{issueId}/comments; PATCH /api/issues/{issueId}; PUT /api/issues/{issueId}/watchdog. Task creation requires body.idempotencyKey. Issue access remains company-authorized by Paperclip.",
    parameters: { ...object, properties: { method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT"] }, path: { type: "string" }, body: { type: "object" } }, required: ["method", "path"] } } },
];

const CTO_HIRE_TOOL_DEFINITION: LmStudioToolDefinition = {
  type: "function",
  function: {
    name: "hire_coder",
    description: "CTO only. Hire one coder under your reporting line. Choose exactly one explicit route: app-managed local Splash, or the configured OpenCode GLM 5.3 Flash model. No Claude/OpenAI account, provider fallback, or credential copy. At most three new hires per run; record each task-to-agent route decision in its issue.",
    parameters: { ...object, properties: {
      name: { type: "string" },
      title: { type: "string" },
      capabilities: { type: "string" },
      route: { type: "string", enum: ["splash_local", "glm_5_3_flash"] },
    }, required: ["name", "capabilities", "route"] },
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textArg(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function within(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveWorkspacePath(root: string, requested: unknown, kind: "existing" | "write"): Promise<string> {
  const relative = textArg(requested, "Workspace path");
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Path must stay inside the workspace.");
  const candidate = path.resolve(root, relative);
  if (!within(root, candidate)) throw new Error("Path must stay inside the workspace.");
  const checked = kind === "write" ? path.dirname(candidate) : candidate;
  let actual: string;
  try { actual = await fs.realpath(checked); }
  catch { throw new Error("Workspace path does not exist."); }
  if (!within(root, actual)) throw new Error("Path must stay inside the workspace.");
  if (kind === "write") {
    const target = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (target?.isSymbolicLink()) throw new Error("Path must stay inside the workspace.");
  }
  return candidate;
}

function commandEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: os.tmpdir(),
    TMPDIR: os.tmpdir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    CI: "1",
  };
}

async function runCommand(input: {
  root: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
}): Promise<string> {
  const command = textArg(input.args.command, "Command", 80);
  if (!/^[A-Za-z][A-Za-z0-9._+-]*$/.test(command)) throw new Error("Command must be an executable name without a path.");
  const args = input.args.args === undefined ? [] : input.args.args;
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS || args.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))) {
    throw new Error("Command arguments are invalid.");
  }
  const requestedTimeout = input.args.timeoutMs ?? 60_000;
  if (typeof requestedTimeout !== "number" || !Number.isInteger(requestedTimeout) || requestedTimeout < 1 || requestedTimeout > MAX_COMMAND_MS) {
    throw new Error("Command timeout is invalid.");
  }
  if (input.signal?.aborted) throw new InterruptedCodingCommandError("Run cancelled.");
  const child = spawn(command, args as string[], {
    cwd: input.root, env: commandEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let terminationRequested = false;
  const killGroup = () => {
    if (!child.pid || terminationRequested) return;
    const processGroupId = child.pid;
    terminationRequested = true;
    try { process.kill(-processGroupId, "SIGTERM"); } catch { /* already exited */ }
    // A child can exit while one of its descendants keeps the process group alive.
    // Keep this timer after the direct child's close event so Stop reaps that group.
    const hardKill = setTimeout(() => {
      try { process.kill(-processGroupId, "SIGKILL"); } catch { /* already exited */ }
    }, 250);
    hardKill.unref();
  };
  let timedOut = false;
  let outputExceeded = false;
  const timeout = setTimeout(() => { timedOut = true; killGroup(); }, requestedTimeout);
  const abort = () => killGroup();
  input.signal?.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let outputSize = 0;
  const collect = (chunk: Buffer) => {
    outputSize += chunk.byteLength;
    if (outputSize > MAX_OUTPUT_BYTES) { outputExceeded = true; killGroup(); return; }
    chunks.push(chunk);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // Keep a rejecting spawn result handled even if process registration fails first.
  void completion.catch(() => undefined);
  try {
    if (child.pid) await input.onSpawn?.({ pid: child.pid, processGroupId: child.pid, startedAt: new Date().toISOString() });
    const exitCode = await completion;
    if (input.signal?.aborted) throw new InterruptedCodingCommandError("Run cancelled.");
    if (timedOut) throw new InterruptedCodingCommandError("Command timed out.");
    if (outputExceeded) throw new InterruptedCodingCommandError("Command output exceeds the size limit.");
    const output = Buffer.concat(chunks).toString("utf8");
    if (exitCode !== 0) throw new Error(`Command exited with code ${exitCode}: ${output.slice(0, 1024)}`);
    return output;
  } catch (error) {
    killGroup();
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTTP_BYTES) { await reader.cancel(); throw new Error("Paperclip response exceeds the size limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

function allowedPaperclipPath(raw: unknown, companyId: string, method: string): string {
  const requested = textArg(raw, "Paperclip path", 2048);
  if (!requested.startsWith("/") || requested.startsWith("//") || /%2e|%2f|%5c|\\|\.\./i.test(requested)) {
    throw new Error("Paperclip path is invalid.");
  }
  const url = new URL(requested, "http://paperclip.invalid");
  if (url.hash || (method !== "GET" && url.search)) throw new Error("Paperclip path is invalid.");
  const companyPrefix = `/api/companies/${encodeURIComponent(companyId)}`;
  const issuePath = `${companyPrefix}/issues`;
  const agentPath = `${companyPrefix}/agents`;
  const issueDetail = /^\/api\/issues\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname);
  const issueComments = /^\/api\/issues\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/comments$/i.test(url.pathname);
  const issueWatchdog = /^\/api\/issues\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/watchdog$/i.test(url.pathname);
  if (method === "GET" && (url.pathname === issuePath || url.pathname === agentPath ||
      issueDetail || issueComments || url.pathname === "/api/agents/me")) return requested;
  if (method === "POST" && (url.pathname === issuePath || issueComments)) return requested;
  if (method === "PATCH" && issueDetail) return requested;
  if (method === "PUT" && issueWatchdog) return requested;
  if (requested.includes("/api/companies/")) throw new Error("Paperclip request cannot access another company or unsupported path.");
  throw new Error("Paperclip path is not allowed.");
}

export async function createLmStudioToolExecutor(input: {
  workspace: string;
  companyId: string;
  runId: string;
  authToken: string;
  apiUrl: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  ctoAgentId?: string;
  hireWorkspaceRoot?: string;
  glmOpenCodeCommand?: string;
}): Promise<{ definitions: LmStudioToolDefinition[]; execute(call: LmStudioToolCall): Promise<string> }> {
  if (!path.isAbsolute(input.workspace)) throw new Error("The selected workspace must be absolute.");
  const root = await fs.realpath(input.workspace);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("The selected workspace is not a directory.");
  const api = new URL(input.apiUrl);
  if (!(["http:", "https:"].includes(api.protocol)) || api.username || api.password || !input.authToken) {
    throw new Error("Paperclip runtime API or run credential is unavailable.");
  }
  let newHireCount = 0;
  async function requestPaperclip(method: "GET" | "POST" | "PATCH" | "PUT", requestPath: string,
    body?: Record<string, unknown>): Promise<string> {
    const encoded = method === "GET" ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > MAX_HTTP_BYTES) throw new Error("Paperclip request body exceeds the size limit.");
    const headers: Record<string, string> = { Authorization: `Bearer ${input.authToken}` };
    if (method !== "GET") { headers["Content-Type"] = "application/json"; headers["X-Paperclip-Run-Id"] = input.runId; }
    let response: Response;
    try {
      response = await (input.fetcher ?? fetch)(new URL(requestPath, api).toString(), {
        method, headers, body: encoded, redirect: "error",
        signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
    } catch {
      if (method === "GET") throw new Error("Paperclip read failed.");
      throw new UncertainPaperclipMutationError();
    }
    const text = await boundedText(response).catch(() => {
      if (method === "GET") throw new Error("Paperclip read failed.");
      throw new UncertainPaperclipMutationError();
    });
    if (!response.ok) {
      if (method !== "GET" && response.status >= 500) throw new UncertainPaperclipMutationError();
      throw new Error(`Paperclip request failed with HTTP ${response.status}: ${text.slice(0, 1024)}`);
    }
    return text;
  }
  return {
    definitions: input.ctoAgentId ? [...LMSTUDIO_TOOL_DEFINITIONS, CTO_HIRE_TOOL_DEFINITION] : LMSTUDIO_TOOL_DEFINITIONS,
    async execute(call) {
      if (input.signal?.aborted) throw new Error("Run cancelled.");
      if (!record(call.arguments)) throw new Error("Tool arguments must be an object.");
      switch (call.name) {
        case "list_files": {
          const target = await resolveWorkspacePath(root, call.arguments.path, "existing");
          const entries = await fs.readdir(target, { withFileTypes: true });
          if (entries.length > 200) throw new Error("Directory has too many entries.");
          return JSON.stringify(entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file" })));
        }
        case "read_file": {
          const target = await resolveWorkspacePath(root, call.arguments.path, "existing");
          const stat = await fs.stat(target);
          if (!stat.isFile() || stat.size > MAX_READ_BYTES) throw new Error("Workspace file is too large or not a regular file.");
          return await fs.readFile(target, "utf8");
        }
        case "write_file": {
          const target = await resolveWorkspacePath(root, call.arguments.path, "write");
          const content = call.arguments.content;
          if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes("\0")) {
            throw new Error("File content is invalid.");
          }
          const temporary = path.join(path.dirname(target), `.paperclip-write-${randomUUID()}`);
          try {
            await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
            await fs.rename(temporary, target);
          } finally { await fs.rm(temporary, { force: true }); }
          return "File written.";
        }
        case "run_command":
          return await runCommand({ root, args: call.arguments, signal: input.signal, onSpawn: input.onSpawn });
        case "hire_coder": {
          if (!input.ctoAgentId) throw new Error("Only the CTO can hire coders from this local run.");
          const name = textArg(call.arguments.name, "Coder name", 80).trim();
          const capabilities = textArg(call.arguments.capabilities, "Coder capabilities", 1_000).trim();
          const title = call.arguments.title === undefined ? null : textArg(call.arguments.title, "Coder title", 120).trim();
          if (name.length < 2 || capabilities.length < 12) throw new Error("Coder name or capabilities are too short.");
          const route = call.arguments.route;
          if (route !== "splash_local" && route !== "glm_5_3_flash") throw new Error("Coder route is not allowed.");
          const adapterType = route === "splash_local" ? "lmstudio_splash_local" : "opencode_local";
          const agentPath = `/api/companies/${encodeURIComponent(input.companyId)}/agents`;
          const existingRaw = await requestPaperclip("GET", agentPath);
          let existingAgents: unknown;
          try { existingAgents = JSON.parse(existingRaw); }
          catch { throw new Error("Could not confirm existing company agents before hiring."); }
          if (!Array.isArray(existingAgents)) throw new Error("Could not confirm existing company agents before hiring.");
          const existing = existingAgents.find((agent) => record(agent) &&
            typeof agent.name === "string" && agent.name.toLowerCase() === name.toLowerCase());
          if (existing) {
            const found = existing as Record<string, unknown>;
            const metadata = record(found.metadata) ? found.metadata : {};
            const existingConfig = record(found.adapterConfig) ? found.adapterConfig : {};
            if (found.companyId === input.companyId && found.reportsTo === input.ctoAgentId &&
              found.adapterType === adapterType && metadata.localHiringRoute === route && typeof found.id === "string" &&
              found.status !== "terminated" &&
              (route === "splash_local" || existingConfig.model === GLM_FLASH_MODEL)) {
              return JSON.stringify({ id: found.id, name, route, adapterType, reused: true });
            }
            throw new Error("A company agent already has this name; choose a distinct coder name.");
          }
          if (newHireCount >= MAX_CTO_HIRES_PER_RUN) throw new Error("CTO hiring limit for this run reached.");
          if (!input.hireWorkspaceRoot || !path.isAbsolute(input.hireWorkspaceRoot)) {
            throw new Error("CTO agent workspace root is unavailable for hiring.");
          }
          const hireRoot = await fs.realpath(input.hireWorkspaceRoot).catch(() => null);
          if (!hireRoot || path.basename(hireRoot) !== "agent-workspaces") {
            throw new Error("CTO agent workspace root is unavailable for hiring.");
          }
          const opencodeCommand = input.glmOpenCodeCommand ?? path.join(os.homedir(), ".opencode", "bin", "opencode");
          const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          if (!slug) throw new Error("Coder name does not make a valid local workspace name.");
          const hireCwd = path.join(hireRoot, slug);
          const adapterConfig = route === "splash_local" ? { cwd: hireCwd } : {
            cwd: hireCwd,
            model: GLM_FLASH_MODEL,
            command: opencodeCommand,
            timeoutSec: 600,
          };
          if (route === "glm_5_3_flash") {
            if (!path.isAbsolute(opencodeCommand)) throw new Error("Configured OpenCode executable path is invalid.");
            const cli = await fs.stat(opencodeCommand).catch(() => null);
            if (!cli?.isFile()) throw new Error("Configured OpenCode executable for GLM 5.3 Flash is unavailable.");
            await fs.access(opencodeCommand, fsConstants.X_OK).catch(() => {
              throw new Error("Configured OpenCode executable for GLM 5.3 Flash is not executable.");
            });
          }
          try { await fs.mkdir(hireCwd, { mode: 0o700 }); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new Error("A local workspace already exists for this coder name; choose another name.");
            }
            throw error;
          }
          const createdRaw = await requestPaperclip("POST", agentPath, {
            name, title, role: "engineer", capabilities, reportsTo: input.ctoAgentId,
            adapterType, adapterConfig,
            runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
            metadata: { localHiringRoute: route, hiredByAgentId: input.ctoAgentId, hiringRunId: input.runId },
          });
          let created: unknown;
          try { created = JSON.parse(createdRaw); }
          catch { throw new UncertainPaperclipMutationError(); }
          if (!record(created) || typeof created.id !== "string" || created.companyId !== input.companyId ||
              created.adapterType !== adapterType || created.reportsTo !== input.ctoAgentId) {
            throw new UncertainPaperclipMutationError();
          }
          newHireCount += 1;
          return JSON.stringify({ id: created.id, name, route, adapterType,
            model: route === "glm_5_3_flash" ? GLM_FLASH_MODEL : "incoai/Qwen3.8-27B-Splash",
            reused: false, next: "Assign a project-bound task explicitly and record this route decision on the task." });
        }
        case "paperclip_request": {
          const method = call.arguments.method;
          if (method !== "GET" && method !== "POST" && method !== "PATCH" && method !== "PUT") throw new Error("Paperclip method is invalid.");
          const requestPath = allowedPaperclipPath(call.arguments.path, input.companyId, method);
          const body = call.arguments.body;
          if (method !== "GET" && !record(body)) throw new Error("Paperclip mutation body must be an object.");
          if (method === "POST" && requestPath === `/api/companies/${encodeURIComponent(input.companyId)}/issues` &&
              (!record(body) || typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim())) {
            throw new Error("Task creation requires an idempotency key.");
          }
          return requestPaperclip(method, requestPath, record(body) ? body : undefined);
        }
        default:
          throw new Error("Tool is not available for this run.");
      }
    },
  };
}

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLmStudioToolExecutor } from "./tools.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-lmstudio-tools-"));
  roots.push(root);
  return root;
}
const call = (name: string, args: Record<string, unknown>) => ({ id: `call-${name}`, name, arguments: args });

describe("Paperclip-owned LM Studio coding tools", () => {
  it("lists, reads, and atomically writes files inside the selected workspace", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "README.md"), "Before\n");
    const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "run-token", apiUrl: "http://127.0.0.1:3319" });
    expect(tools.definitions.map((tool) => tool.function.name)).toEqual([
      "list_files", "read_file", "write_file", "run_command", "paperclip_request",
    ]);
    expect(await tools.execute(call("list_files", { path: "." }))).toContain("README.md");
    expect(await tools.execute(call("read_file", { path: "README.md" }))).toBe("Before\n");
    await tools.execute(call("write_file", { path: "README.md", content: "After\n" }));
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("After\n");
    await tools.execute(call("write_file", { path: "README.md", content: "" }));
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("");
  });

  it("rejects traversal and symlink escapes before reading or writing", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(outside, path.join(root, "escape"));
    const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "run-token", apiUrl: "http://127.0.0.1:3319" });
    await expect(tools.execute(call("read_file", { path: "../secret.txt" }))).rejects.toThrow("workspace");
    await expect(tools.execute(call("read_file", { path: "escape/secret.txt" }))).rejects.toThrow("workspace");
    await expect(tools.execute(call("write_file", { path: "escape/new.txt", content: "bad" }))).rejects.toThrow("workspace");
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside");
  });

  it("runs argv commands in the selected workspace with a timeout and no inherited paid key", async () => {
    const root = await workspace();
    vi.stubEnv("OPENAI_API_KEY", "paid-fixture-key");
    const spawn = vi.fn(async () => {});
    try {
      const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
        authToken: "run-token", apiUrl: "http://127.0.0.1:3319", onSpawn: spawn });
      const result = await tools.execute(call("run_command", { command: "node", args: ["-e",
        "process.stdout.write(JSON.stringify({cwd:process.cwd(),key:process.env.OPENAI_API_KEY||null,token:process.env.PAPERCLIP_API_KEY||null}))"], timeoutMs: 5_000 }));
      expect(JSON.parse(result)).toEqual({ cwd: await realpath(root), key: null, token: null });
      expect(spawn).toHaveBeenCalledOnce();
      await expect(tools.execute(call("run_command", { command: "node", args: ["-e", "setTimeout(()=>{},1000)"], timeoutMs: 30 }))).rejects.toThrow("timed out");
    } finally { vi.unstubAllEnvs(); }
  });

  it("settles a fast command even when process registration finishes later", async () => {
    const root = await workspace();
    const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "run-token", apiUrl: "http://127.0.0.1:3319",
      onSpawn: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); } });
    const result = await Promise.race([
      tools.execute(call("run_command", { command: "node", args: ["-e", "process.stdout.write('done')"], timeoutMs: 500 })),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("command did not settle")), 300)),
    ]);
    expect(result).toBe("done");
  });

  it("aborts an active command when the run is cancelled", async () => {
    const root = await workspace();
    const controller = new AbortController();
    const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "run-token", apiUrl: "http://127.0.0.1:3319", signal: controller.signal });
    const pending = tools.execute(call("run_command", { command: "node", args: ["-e", "setTimeout(()=>{},1000)"], timeoutMs: 5_000 }));
    setTimeout(() => controller.abort(), 25);
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("reaps a command that ignores the first termination signal", async () => {
    const root = await workspace();
    const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "run-token", apiUrl: "http://127.0.0.1:3319" });
    const started = Date.now();
    await expect(tools.execute(call("run_command", { command: "node", args: ["-e",
      "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),1200));setInterval(()=>{},1000)"], timeoutMs: 200 }))).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("reaps a descendant even when its command parent exits on timeout", async () => {
    const root = await workspace();
    let processGroup = 0;
    const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "run-token", apiUrl: "http://127.0.0.1:3319",
      onSpawn: async ({ processGroupId }) => { processGroup = processGroupId ?? 0; } });
    const code = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`;
    try {
      await expect(tools.execute(call("run_command", { command: "node", args: ["-e", code], timeoutMs: 200 }))).rejects.toThrow("timed out");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(() => process.kill(-processGroup, 0)).toThrow();
    } finally {
      if (processGroup) { try { process.kill(-processGroup, "SIGKILL"); } catch { /* already gone */ } }
    }
  });

  it("sends only allowed company task requests with the run JWT kept out of results", async () => {
    const root = await workspace();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "issue-1" }), { status: 200 }));
    const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "private-run-token", apiUrl: "http://127.0.0.1:3319", fetcher });
    const result = await tools.execute(call("paperclip_request", { method: "GET", path: "/api/companies/company-1/issues" }));
    expect(result).toContain("issue-1");
    expect(result).not.toContain("private-run-token");
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:3319/api/companies/company-1/issues", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer private-run-token" }),
      redirect: "error",
    }));
    await expect(tools.execute(call("paperclip_request", { method: "GET", path: "/api/companies/company-2/issues" }))).rejects.toThrow("company");
    await expect(tools.execute(call("paperclip_request", { method: "GET", path: "http://example.com/api/companies/company-1/issues" }))).rejects.toThrow("path");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("uses Paperclip's actual issue detail and comment routes under run authorization", async () => {
    const root = await workspace();
    const issueId = "11111111-1111-4111-8111-111111111111";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "run-token", apiUrl: "http://127.0.0.1:3319", fetcher });
    await tools.execute(call("paperclip_request", { method: "GET", path: `/api/issues/${issueId}` }));
    await tools.execute(call("paperclip_request", { method: "PATCH", path: `/api/issues/${issueId}`, body: { status: "in_progress" } }));
    await tools.execute(call("paperclip_request", { method: "POST", path: `/api/issues/${issueId}/comments`, body: { body: "Update" } }));
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `http://127.0.0.1:3319/api/issues/${issueId}`,
      `http://127.0.0.1:3319/api/issues/${issueId}`,
      `http://127.0.0.1:3319/api/issues/${issueId}/comments`,
    ]);
    await expect(tools.execute(call("paperclip_request", { method: "GET", path: `/api/issues/${issueId}/documents` }))).rejects.toThrow("allowed");
  });

  it("permits only the issue-watchdog PUT under run authorization", async () => {
    const root = await workspace();
    const issueId = "11111111-1111-4111-8111-111111111111";
    const agentId = "22222222-2222-4222-8222-222222222222";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "private-run-token", apiUrl: "http://127.0.0.1:3319", fetcher });
    await tools.execute(call("paperclip_request", { method: "PUT", path: `/api/issues/${issueId}/watchdog`,
      body: { agentId } }));
    expect(fetcher).toHaveBeenCalledWith(`http://127.0.0.1:3319/api/issues/${issueId}/watchdog`, expect.objectContaining({
      method: "PUT", headers: expect.objectContaining({ Authorization: "Bearer private-run-token", "X-Paperclip-Run-Id": "run-1" }),
    }));
    await expect(tools.execute(call("paperclip_request", { method: "PUT", path: `/api/issues/${issueId}`,
      body: { status: "done" } }))).rejects.toThrow("allowed");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("requires task-create idempotency and never retries an uncertain mutation", async () => {
    const root = await workspace();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection lost"));
    const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "run-token", apiUrl: "http://127.0.0.1:3319", fetcher });
    await expect(tools.execute(call("paperclip_request", { method: "POST", path: "/api/companies/company-1/issues", body: { title: "Child" } }))).rejects.toThrow("idempotency");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(tools.execute(call("paperclip_request", { method: "POST", path: "/api/companies/company-1/issues", body: {
      title: "Child", idempotencyKey: "child-1",
    } }))).rejects.toThrow("uncertain");
    expect(fetcher).toHaveBeenCalledOnce();
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-Paperclip-Run-Id"]).toBe("run-1");
  });

  it("treats a server failure after a mutation as uncertain", async () => {
    const root = await workspace();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("Internal error", { status: 500 }));
    const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "run-token", apiUrl: "http://127.0.0.1:3319", fetcher });
    await expect(tools.execute(call("paperclip_request", { method: "PATCH", path: "/api/issues/11111111-1111-4111-8111-111111111111",
      body: { status: "done" } }))).rejects.toThrow("uncertain");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("treats a lost mutation response body as uncertain", async () => {
    const root = await workspace();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new Error("response lost")); },
    }), { status: 200 }));
    const tools = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "run-token", apiUrl: "http://127.0.0.1:3319", fetcher });
    await expect(tools.execute(call("paperclip_request", { method: "PATCH", path: "/api/issues/11111111-1111-4111-8111-111111111111",
      body: { status: "done" } }))).rejects.toThrow("uncertain");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("offers CTO-only hiring with explicit Splash or GLM 5.3 Flash routes", async () => {
    const root = await workspace();
    const hireWorkspaceRoot = path.join(root, "agent-workspaces");
    await mkdir(hireWorkspaceRoot);
    const opencodeCommand = path.join(root, "opencode-test");
    await writeFile(opencodeCommand, "test executable");
    await chmod(opencodeCommand, 0o700);
    const ctoAgentId = "11111111-1111-4111-8111-111111111111";
    const posts: Record<string, unknown>[] = [];
    const created: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "GET") return new Response(JSON.stringify(created));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push(body);
      const agent = { id: `${posts.length}2222222-2222-4222-8222-222222222222`, companyId: "company-1", ...body };
      created.push(agent);
      return new Response(JSON.stringify(agent));
    });
    const ordinary = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-1",
      authToken: "private-run-token", apiUrl: "http://127.0.0.1:3319", fetcher });
    expect(ordinary.definitions.map((tool) => tool.function.name)).not.toContain("hire_coder");
    await expect(ordinary.execute(call("hire_coder", { name: "Fast QA", route: "glm_5_3_flash",
      capabilities: "Audits browser interactions" }))).rejects.toThrow("Only the CTO");
    expect(fetcher).not.toHaveBeenCalled();

    const cto = await createLmStudioToolExecutor({ workspace: root, companyId: "company-1", runId: "run-cto",
      authToken: "private-run-token", apiUrl: "http://127.0.0.1:3319", fetcher,
      ctoAgentId, hireWorkspaceRoot, glmOpenCodeCommand: opencodeCommand });
    expect(cto.definitions.map((tool) => tool.function.name)).toContain("hire_coder");
    const splash = JSON.parse(await cto.execute(call("hire_coder", {
      name: "Private Coder", route: "splash_local", capabilities: "Private TypeScript code and focused tests",
    }))) as Record<string, unknown>;
    const glm = JSON.parse(await cto.execute(call("hire_coder", {
      name: "Fast QA", route: "glm_5_3_flash", capabilities: "Public browser QA and short research",
    }))) as Record<string, unknown>;
    expect(splash).toMatchObject({ route: "splash_local", adapterType: "lmstudio_splash_local", reused: false });
    expect(glm).toMatchObject({ route: "glm_5_3_flash", adapterType: "opencode_local",
      model: "zai-coding-plan/glm-5.3-flash", reused: false });
    expect(posts).toHaveLength(2);
    const canonicalHireRoot = await realpath(hireWorkspaceRoot);
    expect(posts[0]).toMatchObject({ role: "engineer", reportsTo: ctoAgentId,
      adapterType: "lmstudio_splash_local", adapterConfig: { cwd: path.join(canonicalHireRoot, "private-coder") },
      metadata: { localHiringRoute: "splash_local", hiredByAgentId: ctoAgentId, hiringRunId: "run-cto" } });
    expect(posts[1]).toMatchObject({ role: "engineer", reportsTo: ctoAgentId,
      adapterType: "opencode_local", adapterConfig: { model: "zai-coding-plan/glm-5.3-flash",
        command: opencodeCommand, cwd: path.join(canonicalHireRoot, "fast-qa") } });
    expect(await realpath(path.join(hireWorkspaceRoot, "private-coder"))).toBe(path.join(canonicalHireRoot, "private-coder"));
    expect(JSON.stringify(posts)).not.toContain("private-run-token");
    expect(JSON.stringify(posts)).not.toContain("OPENAI_API_KEY");
    (created[1]!.adapterConfig as Record<string, unknown>).model = "different-model";
    await expect(cto.execute(call("hire_coder", {
      name: "Fast QA", route: "glm_5_3_flash", capabilities: "Public browser QA and short research",
    }))).rejects.toThrow("already has this name");
    const reused = JSON.parse(await cto.execute(call("hire_coder", {
      name: "Private Coder", route: "splash_local", capabilities: "Private TypeScript code and focused tests",
    }))) as Record<string, unknown>;
    expect(reused).toMatchObject({ route: "splash_local", reused: true });
    expect(posts).toHaveLength(2);
    await cto.execute(call("hire_coder", {
      name: "Reef Specialist", route: "splash_local", capabilities: "Private 2D simulation and gameplay tests",
    }));
    await expect(cto.execute(call("hire_coder", {
      name: "Fourth Coder", route: "splash_local", capabilities: "Additional private implementation work",
    }))).rejects.toThrow("hiring limit");
    expect(posts).toHaveLength(3);
    await expect(cto.execute(call("hire_coder", { name: "Wrong route", route: "claude",
      capabilities: "Unsupported provider route" }))).rejects.toThrow("not allowed");
  });
});

import { describe, expect, it, vi } from "vitest";
import { completeLmStudioTurn, probeLmStudioSplash, readSplashDecodeTokens } from "./model.js";

const packageId = "incoai/Qwen3.8-27B-Splash";
const model = { id: "qwen3.8-27b-splash", root: packageId, owned_by: "splash" };
const status = { maximum_context_tokens: 222_822, instance: { model: packageId, host: "127.0.0.1", port: 3321 } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const sizedFetcher = (completion: Response, promptTokens = 100) => vi.fn<typeof fetch>(async (url) =>
  String(url).endsWith("/apply-template") ? response({ prompt: "rendered prompt" })
    : String(url).endsWith("/tokenize") ? response({ tokens: Array(promptTokens).fill(1) })
      : completion);
const splashFetcher = (modelEntry: unknown = model, instance: unknown = status.instance) =>
  vi.fn<typeof fetch>(async (url) => response(String(url).endsWith("/ready") ? { status: "ready" }
    : String(url).endsWith("/status") ? { ...status, instance } : { data: [modelEntry] }));

describe("LM Studio Splash model route", () => {
  it("accepts only the app-owned Splash alias and package", async () => {
    const fetcher = splashFetcher();
    await expect(probeLmStudioSplash(fetcher)).resolves.toEqual({ modelId: "qwen3.8-27b-splash" });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3321/ready", "http://127.0.0.1:3321/status", "http://127.0.0.1:3321/v1/models",
    ]);
  });

  it.each([
    [{ ...model, owned_by: "other" }, "not the app-owned Splash"],
    [{ ...model, root: "other/model" }, "not the app-owned Splash"],
    [{ ...model, id: "another-model" }, "not the app-owned Splash"],
  ] as const)("rejects an impostor model without requesting an alternate route", async (entry, reason) => {
    const fetcher = splashFetcher(entry);
    await expect(probeLmStudioSplash(fetcher)).rejects.toThrow(reason);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the app-owned Splash server is unreachable", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused"));
    await expect(probeLmStudioSplash(fetcher)).rejects.toThrow("Splash");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reads the local decode counter without exposing generated text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ metrics: { decode_output_tokens: 12345 } }));
    await expect(readSplashDecodeTokens(fetcher)).resolves.toBe(12345);
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:3321/status", expect.objectContaining({ method: "GET" }));
  });

  it("parses a bounded tool response from the fixed chat endpoint", async () => {
    const fetcher = sizedFetcher(response({
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
        id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' },
      }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    }));
    const onTokenBudget = vi.fn();
    const result = await completeLmStudioTurn({
      messages: [{ role: "user", content: "Read the project" }],
      tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } }],
      fetcher, onTokenBudget,
    });
    expect(onTokenBudget).toHaveBeenCalledWith({ promptTokens: 100, maxOutputTokens: 222_722 });
    expect(result).toEqual({ content: null, toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
      usage: { inputTokens: 12, outputTokens: 4 } });
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:3321/v1/chat/completions", expect.objectContaining({
      method: "POST", redirect: "error",
    }));
    const sent = JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).endsWith("/v1/chat/completions"))?.[1]?.body));
    expect(sent.model).toBe("qwen3.8-27b-splash");
    expect(sent.max_tokens).toBe(222_722);
    expect(sent.tools).toHaveLength(1);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:3321/apply-template", "http://127.0.0.1:3321/tokenize",
      "http://127.0.0.1:3321/v1/chat/completions",
    ]);
  });

  it("rejects malformed tool calls and oversized responses", async () => {
    const malformed = sizedFetcher(response({ choices: [{ message: { tool_calls: [{
      type: "function", function: { name: "read_file", arguments: "{}" },
    }] } }] }));
    await expect(completeLmStudioTurn({ messages: [], tools: [], fetcher: malformed })).rejects.toThrow("tool call");
    const oversized = sizedFetcher(new Response("x".repeat(1_100_000), { status: 200 }));
    await expect(completeLmStudioTurn({ messages: [], tools: [], fetcher: oversized })).rejects.toThrow("size");
  });

  it.each([
    [{ choices: [{ finish_reason: "unknown", message: { role: "assistant", content: "Partial result" } }] }, "unfinished"],
    [{ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] }, "no content"],
  ] as const)("rejects a non-final or empty model answer", async (body, reason) => {
    const fetcher = sizedFetcher(response(body));
    await expect(completeLmStudioTurn({ messages: [], tools: [], fetcher })).rejects.toThrow(reason);
  });

  it("rejects a length-limited response without dispatching a partial tool call", async () => {
    const fetcher = sizedFetcher(response({
      choices: [{ finish_reason: "length", message: { role: "assistant", content: "partial",
        tool_calls: [{ id: "partial", type: "function", function: { name: "write_file", arguments: "{" } }] } }],
    }));
    await expect(completeLmStudioTurn({ messages: [], tools: [], fetcher })).rejects.toThrow("222,822");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not submit generation when the prompt fills the configured context", async () => {
    const fetcher = sizedFetcher(response({ choices: [] }), 222_822);
    await expect(completeLmStudioTurn({ messages: [], tools: [], fetcher })).rejects.toThrow("fills the configured context");
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:3321/apply-template", "http://127.0.0.1:3321/tokenize",
    ]);
  });

  it("identifies a transport header deadline without trying another provider", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/apply-template")) return response({ prompt: "rendered prompt" });
      if (String(url).endsWith("/tokenize")) return response({ tokens: [1, 2, 3] });
      throw Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    });
    await expect(completeLmStudioTurn({ messages: [], tools: [], fetcher })).rejects.toThrow("response headers exceeded");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

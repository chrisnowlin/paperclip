import { describe, expect, it, vi } from "vitest";
import { completeLmStudioTurn, probeLmStudioSplash } from "./model.js";

const model = { key: "qwen3.8-27b-splash", format: "splash", loaded_instances: [{ id: "loaded-1" }] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("LM Studio Splash model route", () => {
  it("accepts only the exact loaded Splash-format model", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ models: [model] }));
    await expect(probeLmStudioSplash(fetcher)).resolves.toEqual({ modelId: "qwen3.8-27b-splash" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:1234/api/v1/models", expect.objectContaining({
      method: "GET", redirect: "error",
    }));
  });

  it.each([
    [{ ...model, loaded_instances: [] }, "not loaded"],
    [{ ...model, format: "gguf" }, "Splash format"],
    [{ ...model, key: "another-model" }, "not available"],
  ] as const)("rejects an unavailable model without requesting an alternate route", async (entry, reason) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ models: [entry] }));
    await expect(probeLmStudioSplash(fetcher)).rejects.toThrow(reason);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fails closed when LM Studio is unreachable", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused"));
    await expect(probeLmStudioSplash(fetcher)).rejects.toThrow("LM Studio");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("parses a bounded tool response from the fixed chat endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
        id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' },
      }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    }));
    const result = await completeLmStudioTurn({
      messages: [{ role: "user", content: "Read the project" }],
      tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } }],
      fetcher,
    });
    expect(result).toEqual({ content: null, toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
      usage: { inputTokens: 12, outputTokens: 4 } });
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:1234/v1/chat/completions", expect.objectContaining({
      method: "POST", redirect: "error",
    }));
    const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(sent.model).toBe("qwen3.8-27b-splash");
    expect(sent.tools).toHaveLength(1);
  });

  it("rejects malformed tool calls and oversized responses", async () => {
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(response({ choices: [{ message: { tool_calls: [{
      type: "function", function: { name: "read_file", arguments: "{}" },
    }] } }] }));
    await expect(completeLmStudioTurn({ messages: [], tools: [], fetcher: malformed })).rejects.toThrow("tool call");
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(1_100_000), { status: 200 }));
    await expect(completeLmStudioTurn({ messages: [], tools: [], fetcher: oversized })).rejects.toThrow("size");
  });

  it.each([
    [{ choices: [{ finish_reason: "length", message: { role: "assistant", content: "Partial result" } }] }, "unfinished"],
    [{ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] }, "no content"],
  ] as const)("rejects a non-final or empty model answer", async (body, reason) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body));
    await expect(completeLmStudioTurn({ messages: [], tools: [], fetcher })).rejects.toThrow(reason);
  });
});

import { describe, expect, it } from "vitest";
import { parseLmStudioSplashStdoutLine } from "./parse-stdout.js";

describe("LM Studio Splash transcript", () => {
  it("shows assistant text and bounded tool progress", () => {
    expect(parseLmStudioSplashStdoutLine('{"type":"assistant","text":"Done"}', "now")).toEqual([{ kind: "assistant", ts: "now", text: "Done" }]);
    expect(parseLmStudioSplashStdoutLine('{"type":"tool_call","name":"read_file"}', "now")).toMatchObject([{ kind: "tool_call", name: "read_file" }]);
    expect(parseLmStudioSplashStdoutLine('{"type":"tool_result","name":"read_file","isError":false}', "now")).toMatchObject([{ kind: "tool_result", isError: false }]);
  });

  it("keeps malformed provider output as plain stdout", () => {
    expect(parseLmStudioSplashStdoutLine("not-json", "now")).toEqual([{ kind: "stdout", ts: "now", text: "not-json" }]);
  });
});

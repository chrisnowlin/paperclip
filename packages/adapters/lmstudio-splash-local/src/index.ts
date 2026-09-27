export const type = "lmstudio_splash_local";
export const label = "Splash (app-managed)";
export const LMSTUDIO_SPLASH_MODEL = "qwen3.8-27b-splash";
export const SPLASH_PACKAGE_ID = "incoai/Qwen3.8-27B-Splash";
export const SPLASH_NATIVE_MAX_TOKENS = 262_144;
export const SPLASH_CONTEXT_TOKEN_LIMIT = Math.floor(SPLASH_NATIVE_MAX_TOKENS * 0.85);
export const SPLASH_OUTPUT_TOKEN_BUDGET = Math.floor(SPLASH_NATIVE_MAX_TOKENS * 0.85);
export const models = [{ id: LMSTUDIO_SPLASH_MODEL, label: "Qwen3.8 27B Splash" }];

export const agentConfigurationDoc = `# App-managed Splash local agent

Adapter: lmstudio_splash_local

Use when:
- This agent should run the local Qwen3.8 27B Splash model through V2's bundled Splash server at 127.0.0.1:3321.
- Paperclip should own the coding and task tool loop without OpenCode, Codex, or a paid provider account.
- The agent is a local-trusted owner, including delegated child tasks.
- A CTO/CEO role should coordinate broad work into at most three narrow child issues with named local assignees before implementation.

Do not use when:
- The reviewer must run in a sandbox; this adapter is local-only.
- Paperclip has not started its bundled Splash server. Use Start Splash before assigning work.
- The task requires another model, endpoint, provider account, or remote execution environment.

The model and endpoint are fixed. There are no login, API key, alternate provider, or fallback settings.
Paperclip's run JWT remains outside the model prompt and is used only for approved task tools.
Coding commands execute with the local server user's authority in the assigned workspace.
For a project task, register_deliverable can attach a finished file of up to 10 MB from the assigned workspace to that task. The attachment automatically creates an artifact work product and returns a board download path.
Live long-turn status can show a short local reasoning excerpt and approximate token count; the excerpt is not written to the run log. Partial streamed tool calls are never executed.
While Splash prepares a large prompt, live status shows approximate input tokens processed before output token generation begins.
For CEO and CTO coordination turns, one actionless long-reasoning attempt is interrupted and refocused on a concrete task action; a repeated stall stops the run for watchdog review.
`;

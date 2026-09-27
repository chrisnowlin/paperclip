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

Do not use when:
- The reviewer must run in a sandbox; this adapter is local-only.
- Paperclip has not started its bundled Splash server. Use Start Splash before assigning work.
- The task requires another model, endpoint, provider account, or remote execution environment.

The model and endpoint are fixed. There are no login, API key, alternate provider, or fallback settings.
Paperclip's run JWT remains outside the model prompt and is used only for approved task tools.
Coding commands execute with the local server user's authority in the assigned workspace.
`;

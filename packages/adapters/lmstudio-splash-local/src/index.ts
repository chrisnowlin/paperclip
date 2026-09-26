export const type = "lmstudio_splash_local";
export const label = "LM Studio Splash (local)";
export const LMSTUDIO_SPLASH_MODEL = "qwen3.8-27b-splash";
export const models = [{ id: LMSTUDIO_SPLASH_MODEL, label: "Qwen3.8 27B Splash" }];

export const agentConfigurationDoc = `# LM Studio Splash local agent

Adapter: lmstudio_splash_local

Use when:
- This agent should run the local Qwen3.8 27B Splash model through LM Studio at 127.0.0.1:1234.
- Paperclip should own the coding and task tool loop without OpenCode, Codex, or a paid provider account.
- The agent is a local-trusted owner, including delegated child tasks.

Do not use when:
- The reviewer must run in a sandbox; this adapter is local-only.
- LM Studio has merely downloaded the model. Load the exact Splash-format model first.
- The task requires another model, endpoint, provider account, or remote execution environment.

The model and endpoint are fixed. There are no login, API key, alternate provider, or fallback settings.
Paperclip's run JWT remains outside the model prompt and is used only for approved task tools.
Coding commands execute with the local server user's authority in the assigned workspace.
`;

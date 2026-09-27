# Splash 1.1.0 Bonsai 2 qualification (2026-09-27)

## Decision

Keep `incoai/Qwen3.8-27B-Splash` as the app-managed model for current coding pods. Do not silently substitute Bonsai for it. `prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0` is a viable **sequential alternative** on this M4 Max, with much lower resident model memory, but it did not improve throughput on the first matched local coding prompt. A later small simultaneous-load probe succeeded, but it left too little observed memory margin to schedule sustained parallel agent work. Before exposing Bonsai to agents, V2 needs an explicit per-agent model binding, a queue and memory admission policy, and a readiness check against the selected model's exact package ID. A task assigned to the wrong loaded model must wait or fail clearly, never fall back.

## Evidence

- [Splash 1.1.0](https://github.com/incoai/splash/releases/tag/1.1.0) adds Prism Bonsai PQ2_0 support. The app's bundled Splash 1.0.2 accepts only its packed packages and cannot load this GGUF. The 1.1.0 archive was SHA-256 verified against the release checksum and staged separately from V2.
- The [model repository](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) identifies PQ2_0 as a 7.21 GB language weight file. Only this variant and its matching `incoai/Qwen3.8-27B-DFlash2` draft were downloaded; the existing Qwen weights were not fetched again. Splash prepared another 7.9 GiB of weights. Disk free after preparation was 35 GiB.
- Qwen was stopped through Paperclip before Bonsai started. Bonsai ran text-only on `127.0.0.1:3321`, with a 28 GiB Metal cap and 64K context. Its ready status reported 9.4 GiB current Metal memory and 19.4 GiB host available. Qwen had reported about 20.8 GiB current Metal memory; while a coding run was active, host available fell to 5.6 GiB. We did not run both models concurrently.
- The same 230-token coding prompt requested a pure TypeScript turtle-state update function and two tests, with `reasoning_effort: medium`, streamed Chat Completions, and a 4,096-token cap. These are single runs, so timing is directional rather than a quality or throughput distribution.

| Local model | First output | Output tokens | Elapsed | Approx. output tokens/s | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| App Qwen on Splash 1.0.2 | 1.68 s | 2,930 | 28.55 s | 102.6 | Finished; plausible code and tests |
| Bonsai PQ2_0 on Splash 1.1.0 | 1.60 s | 3,322 | 45.36 s | 73.2 | Finished; plausible code and tests |

Bonsai also returned a valid structured `calculate(a=19,b=23)` tool call in 2.55 seconds. This proves API tool-call shape on one small request, not reliable multi-step coding work. The runtimes differ, and output lengths differ; a larger same-runtime task suite is needed before ranking model quality or speed generally.

## Simultaneous-load probe

After the user clarified that the one-model limit applied to two Qwen copies, we loaded Bonsai beside the app-owned Qwen process. Bonsai used its existing prepared weights, separate Splash 1.1.0 process, offline mode, port 3322, a 12 GiB memory cap, and a reduced 16K context for this short feasibility probe. Paperclip continued serving Qwen on port 3321 and its local SPL-49 coding run remained active. No agent was routed to Bonsai and no model weights were downloaded.

- Both `/status` endpoints reported ready simultaneously. Bonsai used 9.44 GiB of Metal memory; Qwen reported 18.53 GiB during the overlap. macOS free-memory percentage fell to about 12–19%, with swap already near 15.3 of 16 GiB used.
- A 48-token public prompt to Bonsai requested exactly `BONSAI_OK`. It returned that answer in 39 output tokens and about 4.7 seconds while Qwen's Paperclip run remained active; that run also continued editing its game file. This proves both services can be loaded and answer requests during an active local task. It does not establish sustained simultaneous decoding throughput or a full Bonsai coding-pod run.
- Qwen's Splash memory pressure changed from `normal` to `warning` after the Bonsai request. We stopped the separate Bonsai process cleanly; port 3322 closed, Qwen remained ready, its pressure returned to `normal`, and macOS free-memory percentage rose to about 38%. This observation is a reason to keep parallel task dispatch disabled pending longer controlled tests and memory admission limits; it does not establish the exact cause of the pressure change.

## Next qualification gate

When the active company wave is complete, run both models sequentially on the same Splash 1.1.0 runtime with short, medium, and tool-heavy tasks. Record time to first token, prompt and completion throughput, correctness, memory, preparation disk, and failure modes. If parallel loading is pursued, first define a combined memory ceiling and repeat under sustained dual inference without a live company task at risk. Include a real Paperclip Bonsai coding-pod run only after V2 has explicit Bonsai selection and queue-safe admission. Preserve Qwen as the named default until that path is implemented and verified.

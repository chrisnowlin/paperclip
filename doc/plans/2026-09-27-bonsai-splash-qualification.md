# Splash 1.1.0 Bonsai 2 qualification (2026-09-27)

## Decision

Keep `incoai/Qwen3.8-27B-Splash` as the app-managed model for current coding pods. Do not silently substitute Bonsai for it. `prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0` is a viable **sequential alternative** on this M4 Max, with much lower resident model memory, but it did not improve throughput on the first matched local coding prompt. Before exposing it to agents, V2 needs an explicit per-agent model binding, a single-model switch that drains the run queue, and a readiness check against the selected model's exact package ID. A task assigned to the wrong loaded model must wait or fail clearly, never fall back.

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

## Next qualification gate

When the active company wave is complete, run both models sequentially on the same Splash 1.1.0 runtime with short, medium, and tool-heavy tasks. Record time to first token, prompt and completion throughput, correctness, memory, preparation disk, and failure modes. Include a real Paperclip coding-pod run only after V2 has explicit Bonsai selection and queue-safe model switching. Preserve Qwen as the named default until that path is implemented and verified.

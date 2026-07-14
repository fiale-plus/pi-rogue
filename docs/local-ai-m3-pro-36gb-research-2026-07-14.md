# Local AI on this M3 Pro 36 GB Mac (research snapshot, 2026-07-14)

## Decision

Keep the existing Qwen3.6-35B-A3B GGUF lineage as the control, but do not declare a new default from published scores or tokens/second alone. The most useful next step is an approval-gated, one-model-at-a-time bake-off:

1. **North Mini Code 1.0 4-bit** as the first new coding worker candidate.
2. **Qwen3.6-35B-A3B OptiQ 4-bit**, first without MTP and then with MTP, as the general-agent challenger to the current Qwen GGUF.
3. **Gemma 4 26B-A4B 4-bit** as the alternate reasoning/vision personality. Test the 15.37 GB uniform MLX conversion before the larger 21.89 GB QAT OptiQ package unless a quality comparison justifies the extra 6.5 GB.
4. **DiffusionGemma** only as an experimental spike after the three autoregressive candidates.

The likely end state is one loaded primary model, not three resident models. On 36 GB unified memory, a second LLM should not be kept loaded merely as a gate. Pi-Rogue's cheap binary gate should remain the fast gate unless a measured workload proves a second local LLM is worth its memory.

## Important correction: this is not an M3 Max

A read-only inspection on 2026-07-14 found:

| Item | Observed value |
|---|---|
| Mac | MacBook Pro `Mac15,6` |
| SoC | **Apple M3 Pro**, 12 CPU cores (6 performance + 6 efficiency) |
| Unified memory | 36 GB (38,654,705,664 bytes) |
| macOS | 26.5.1 (build 25F80) |
| Data-volume free space | 33.7 GB |
| Swap snapshot | 21.1 GB in use; this is a point-in-time observation, not proof that one model caused all of it |
| Active model servers | Qwen3.6 on port 8004 and CPU-only Qwable 3.6 35B on port 8005 |
| `vmmap` snapshot | Qwable writable regions: 19.7 GB swapped out; Qwen writable regions: 4.6 GB swapped out. Per-process figures can overlap and must not be summed as a system total |
| `llama.cpp` | build 9740 (`75f460ac2`); Homebrew stable was 9910 and upstream release was b10011 |
| MLX packages in default Python | not installed |
| Ollama | 0.32.0; no Ollama models installed |
| Hugging Face cache | 49.8 GB across 13 model revisions |

This matters because M3 Pro memory bandwidth and GPU capacity are below an M3 Max. M3 Max throughput claims should not be projected onto this machine.

### Applicability to an M3 Max with the same 36 GB memory

If the intended target is a different **M3 Max 36 GB** Mac, the storage and capacity guidance in this report is a conservative starting point because unified-memory capacity is still 36 GB. The same weight files, runtime overhead, KV cache, context length, other applications, and macOS memory pressure still determine whether a configuration fits without sustained swap.

Throughput, time-to-first-token, thermals, and the best speculative depth do **not** transfer from this host. M3 Max has different memory bandwidth and GPU/CPU resources. This report contains no candidate throughput measurement that should be relabeled as an M3 Max result; all local process and memory observations are explicitly from the M3 Pro host. Run the same pinned benchmark manifest on the M3 Max before using speed or latency to choose a default.

## Existing services: capable but not ready for a safe bake-off

A live `llama-server` was healthy on `127.0.0.1:8004` and exposed:

- Qwen3.6-35B-A3B UD-Q4_K_M;
- 131,072-token configured context;
- Q8_0 K/V cache;
- flash attention;
- MTP draft depth 2;
- one sequence;
- a 22.65 GB model according to `/v1/models`;
- `llama.cpp` build 9740.

The process command points to:

```text
~/.lmstudio/models/unsloth/Qwen3.6-35B-A3B-MTP-GGUF/
  Qwen3.6-35B-A3B-UD-Q4_K_M.gguf
```

That path no longer exists. `lsof +L1` reports that the process still holds the 22,663,387,424-byte GGUF with link count zero. The byte size exactly matches `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf` in `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` at revision `5bc3e238d916f48a861bac2f8a1990a0e9b7e98d`, but the local content hash is not recoverable through the deleted path. Therefore:

> **Do not stop or restart the current Qwen server until a replacement artifact and launcher have been verified.** The current process works only because it retains an open handle to a deleted file.

A second healthy `llama-server` is active on port 8005 with `Mia-AiLab/Qwable-3.6-35b` revision `c6faceabf608fb1e58679ad80d8f4d72d6be9fd0`: 21.17 GB Q4_K_M weights, 8K context, and CPU-only inference. Its backing cache exists and is restartable, but `vmmap` reports 19.7 GB of its writable regions swapped out. The 8004 Qwen process reports 4.6 GB swapped out. These per-process figures overlap with shared mappings and should not be added to infer total swap, but they identify Qwable as the first service to investigate before any benchmark.

The configured Pi model still points at port 8004 and labels it the 128K practical default. Reproducibility and a clean one-model preflight are the first operational fixes; model shopping comes second. Do not stop Qwable or delete its cache without explicit approval and an ownership/restart-policy check.

## Seed assessment

### What the seed got right

- North Mini Code, Qwen3.6 OptiQ, Gemma 4, and DiffusionGemma are real releases with the named broad architectures.
- North Mini Code is a serious coding-agent candidate, not merely a completion model.
- Qwen3.6 remains a relevant and already-integrated baseline.
- MTP must be judged on task completion, parser correctness, and later turns—not only decode speed.
- Nominal 256K context is not a useful default target on 36 GB.
- Gemma 4 is the most differentiated alternate personality because it adds a strong vendor-reported reasoning profile and vision.

### Corrections and qualifications

1. **Machine class:** this Mac is M3 Pro, not M3 Max.
2. **North artifact sizes:** the complete Hub trees are 18.515 GB for 4-bit and 25.902 GB for 6-bit. The latter is too tight to download and run casually with only 33.7 GB currently free.
3. **Qwen OptiQ download size:** the card's 22.1 GB figure describes the core mixed quant. The complete Hub tree is 24.694 GB because it also includes a 1.645 GB MTP head and 0.893 GB vision package.
4. **Gemma MLX support has moved:** `mlx-vlm` 0.6.4 contains Gemma 4 vision, DiffusionGemma, Cohere2-MoE/North, a Gemma 4 tool parser, and OpenAI-compatible tool-call translation paths. It is no longer accurate to describe DiffusionGemma on MLX as only an unimplemented conversion.
5. **Tool calling is improved, not proven:** MLX-LM's original Gemma 4 parser gap was fixed, and 0.31.3 added more parser fixes. MLX-VLM 0.6.4 includes the merged DiffusionGemma marker-token fix. An open report still shows autoregressive Gemma 4 calls failing under a real Pi tool schema, so the exact Pi streaming and non-streaming paths must be tested.
6. **Speculative validation needs two invariants:** MLX-LM issues #1423 and #1470 report deterministic greedy divergence, but follow-up analysis attributes observed dense-model flips to BF16 ties and different GEMM/GEMV rounding rather than broken accept/reject logic. Bit-exact output is therefore not a universal invariant on Apple hardware. A separate Qwen hybrid-cache/MTP rollback fix was still an open PR, so cache-state correctness, teacher-forced logit margins, benchmark invariance, and task equivalence remain mandatory.

## Candidate evidence

For Hub candidates, exact byte totals below are sums of files returned by the Hugging Face expanded repository-tree API on 2026-07-14. For the two live services, they are exact GGUF file sizes from `lsof` and the pinned Hub tree. These are storage-planning figures, not peak unified-memory measurements.

| Candidate | Artifact/tree size | Evidence-backed strengths | Main uncertainty | Disposition |
|---|---:|---|---|---|
| Current Qwen3.6 GGUF Q4_K_M | 22.66 GB open file | Already works with Pi; current server has native llama.cpp MTP enabled; canonical file/revision and byte size identified | Deleted backing file; local content hash unavailable; 128K is aggressive | **Preserve as control; repair reproducibility first** |
| Active Qwable 3.6 35B Q4_K_M | 21.17 GB backed file | Restartable CPU-only 8K service; locally observed | Not a bake-off candidate; 19.7 GB writable memory swapped out in the snapshot | **With approval, deactivate before any benchmark; retain cache until ownership is clear** |
| `mlx-community/North-Mini-Code-1.0-4bit` | 18.515 GB | 30B total/3B active; Apache-2.0; 256K nominal context; agent/tool training; MLX-VLM 0.6.4 has Cohere2-MoE model and parser support | Cohere's benchmark lead is vendor-reported; no local throughput, memory, or Pi parser evidence | **Benchmark first; first new download** |
| `mlx-community/North-Mini-Code-1.0-6bit` | 25.902 GB | Same model with more weight precision | Leaves little runtime/system headroom and only ~7.8 GB disk free before any cleanup | **Defer until 4-bit wins and disk is reclaimed** |
| `mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit` | 24.694 GB | Sensitivity-aware mixed 4/8-bit layers; bundled MTP; documented OpenAI/Anthropic server | +1.12 six-metric score and ~1.4x MTP are publisher claims; complete artifact is about 2.6 GB larger than the 22.1 GB core card figure; speculative correctness risk | **Benchmark first; MTP off/on paired replay** |
| `mlx-community/gemma-4-26b-a4b-it-4bit` | 15.374 GB | Smallest main autoregressive candidate; 25.2B total/3.8B active; Gemma 4 text/vision and parser support in current MLX stacks | Uniform 4-bit quality; exact Pi tool reliability; Apple throughput | **Try before the larger Gemma OptiQ package** |
| `mlx-community/gemma-4-26B-A4B-it-qat-OptiQ-4bit` | 21.887 GB | QAT/OptiQ candidate with vision package | Extra 6.5 GB versus uniform 4-bit needs a measured quality benefit | **Second Gemma quant only if justified** |
| `mlx-community/diffusiongemma-26B-A4B-it-4bit` | 16.575 GB | Current MLX-VLM includes the specialized diffusion path; real parallel-denoising architecture | Google reports lower coding/reasoning quality than Gemma 4; Apple speed unknown; parser fix is recent | **Experimental spike, not daily driver** |

The structured inventory is also recorded in [`benchmark-evidence/local-ai-candidate-inventory-2026-07-14.csv`](benchmark-evidence/local-ai-candidate-inventory-2026-07-14.csv). Its evidence labels distinguish local observation, vendor/publisher documentation, and upstream runtime listings. A published runtime implementation is not a local compatibility test.

## Model findings

### North Mini Code: best first coding challenger

Cohere documents North Mini Code as 30B total/3B active, 256K context, 64K maximum output, text-only, and Apache-2.0. It uses 128 experts with 8 active per token and interleaves sliding and global attention. Cohere says its post-training used more than 70,000 verifiable tasks across about 5,000 repositories, multiple agent harnesses, and explicit penalties for malformed tool calls.

Cohere also reports a 33.4 Artificial Analysis Coding Index and leads over selected peers. Those are vendor-run or vendor-assembled results, not independent local evidence. The recommended `temperature=1.0`, `top_p=0.95`, and three-seed methodology are appropriate for evaluation.

Current `mlx-vlm` 0.6.4 contains a `cohere2_moe` implementation and Cohere2-MoE tool parser, so the MLX conversion has a real runtime path. That still does not establish Pi compatibility. The first smoke tests must verify:

- text-only loading despite the conversion's VLM metadata;
- OpenAI `tool_calls` in streaming and non-streaming modes;
- interleaved reasoning retention across tool-result turns;
- malformed-call and loop rates;
- cold/warm prefix behavior.

**Recommendation:** download 4-bit first after approval. Test 6-bit only if 4-bit wins tasks but has a demonstrated quality defect that the larger quant fixes.

### Qwen3.6 OptiQ + MTP: strong, but not a free upgrade

The OptiQ card documents 392 sensitive layers at 8-bit, 118 at 4-bit, group size 64, and a core text size of 22.1 GB versus 19.0 GB for uniform 4-bit. Its published evaluation improves BFCL and HashHop while slightly regressing MMLU, GSM8K, and IFEval. Calling it better on every benchmark would be incorrect; only the arithmetic mean is higher.

The bundled MTP claim is approximately 1.4x decode with about 70% depth-2 acceptance. llama.cpp's merged MTP implementation contains encouraging non-Apple measurements, but speedups vary by backend and task and can reduce prefill throughput. The current Mac already runs llama.cpp MTP depth 2, so the useful comparison is not “MTP versus nothing”; it is:

1. current Qwen GGUF, MTP off/on;
2. OptiQ MLX, MTP off/on;
3. identical Pi trajectories and cached-prefix later turns.

MLX-LM speculative divergence reports make greedy-equivalence tests mandatory. OptiQ uses its own server path, so upstream MLX-LM bugs do not prove OptiQ is wrong—but they remove any basis for assuming correctness.

**Recommendation:** keep Qwen as the baseline lineage. Treat OptiQ as a benchmark candidate, not an automatic replacement.

### Gemma 4: use MLX-VLM for vision

Google describes Gemma 4 26B-A4B as 25.2B total/3.8B active, 256K nominal context, text+image input, thinking modes, native tools, and Apache-2.0. Google reports 77.1% LiveCodeBench v6 and 88.3% AIME 2026; these are vendor results.

Runtime choice changes capability:

- MLX-LM 0.31.3 has a Gemma 4 text model and tool parser, but its model sanitizer drops vision-tower/projector weights. Use it as text-only.
- MLX-VLM 0.6.4 retains the multimodal path and has OpenAI-compatible tool-call plumbing. Use this path for screenshot/UI/OCR evaluation.
- The older “native call appears in raw text but `tool_calls` is empty” failure was real. Parser and streaming fixes landed, while one real Pi-schema failure remains open. Test both raw output and parsed API fields.

The 15.37 GB uniform 4-bit conversion offers substantially more memory and disk headroom than the 21.89 GB QAT OptiQ tree. Starting with the smaller artifact makes the first comparison cheaper and safer.

**Recommendation:** use as the alternate advisor/vision candidate, not the coding default until local tasks prove otherwise.

### DiffusionGemma: now runnable, still experimental

DiffusionGemma is not ordinary speculative decoding. It denoises 256-token canvases with a specialized block-diffusion generation path. Google reports 15–20 resolved tokens per forward pass and more than 1,100 tok/s on H100 FP8, which says nothing reliable about an M3 Pro.

Google's own table places it below autoregressive Gemma 4 26B-A4B on LiveCodeBench (69.1% versus 77.1%), AIME (69.1% versus 88.3%), Tau2, vision, and long context. MLX-VLM 0.6.4 includes DiffusionGemma and merged PR #1477, which fixes the 0.6.3 bug that stripped tool/channel markers before parsing by demoting those parser markers from special-token metadata.

**Recommendation:** one bounded spike after the main bake-off. Do not wire it into Pi as a daily model based on H100 throughput claims.

## Runtime improvements worth testing

### 1. Reproducible, pinned environments

Do not update the global Python or stop the live baseline during research. After approval, create isolated environments and record:

- `mlx==0.32.0`;
- `mlx-lm==0.31.3`;
- `mlx-vlm==0.6.4`;
- `mlx-optiq==0.3.3`;
- exact model revisions from the inventory CSV;
- one pinned llama.cpp build for the baseline and one candidate build.

The installed llama.cpp build is behind Homebrew stable and upstream, but “newer” is not automatically safer: current MTP regressions and fit/context issues were still being discussed. Upgrade in a parallel executable path and keep rollback possible.

### 2. Prefix caching before larger context

Pi repeatedly sends system, tool, and repository prefixes. Prefix reuse can improve time-to-first-token more than a modest decode-speed gain:

- MLX-LM supports prompt-cache files and rotating/quantized KV caches.
- MLX-VLM supports automatic prefix caching.
- OptiQ documents automatic prefix caching.
- llama.cpp enables prompt caching by default in the installed server.

A cache hit is valid only when the effective tokenized prefix—including tools, template, system/developer content, model/tokenizer revision, and reasoning flags—is identical. Benchmark cold and warm prefixes and deliberately mutate each of those fields.

### 3. Context and KV discipline

Use these tiers:

- **8K:** fresh repository task and smoke tests;
- **16K:** comfortable daily target;
- **32K:** primary multi-turn benchmark;
- **64K:** stress test;
- **128K:** current-baseline comparison only, not a default acceptance target;
- **256K:** out of scope for this machine.

Start with Q8 KV when it fits. Test Q4 KV only when memory pressure or 64K context requires it, then run retrieval and patch-quality checks. Quantized weight files do not imply a quantized KV cache.

### 4. One main model at a time

The machine currently violates this benchmark precondition because both Qwen and Qwable are active. After explicit approval and ownership checks, deactivate the reproducible Qwable service before touching the unlinked Qwen baseline. Every measured run must start with only the model under test active.

Reserve at least 6–8 GB for macOS, Pi, repository tools, allocator peaks, and display workloads. A practical model+KV+runtime target is below roughly 28–30 GB, with lower better. Treat this as an estimate, not proof of fit. Abort on sustained swap growth, repeated memory-pressure warnings, or UI instability.

Do not set `iogpu.wired_limit_mb` near total RAM. It changes allocation policy; it does not create memory.

## Approval-gated benchmark plan

No models were downloaded, packages installed, processes restarted, or intensive generations run for this research snapshot.

### Gate 0 — preserve and recover the baseline

Before stopping port 8004:

1. Inventory every local-model process, launch agent, backing artifact, owner, and restart policy. The current list must include Qwen on 8004 and Qwable on 8005.
2. With explicit approval, deactivate the restartable Qwable service first; do not delete its cache. Confirm system swap has headroom and no auto-restart policy relaunches it.
3. Select the pinned replacement Qwen GGUF, verify its expected size and checksum without loading it, and fix/verify the launcher in its owning repository.
4. Save the current 8004 command line, Pi provider entry, model metadata, and a short baseline transcript.
5. Require enough free disk for the replacement plus download staging and require a clean one-model memory preflight. Reclaim caches only with explicit approval.
6. Perform a planned brief cutover: stop 8004 only after steps 1–5 pass, start the replacement on the intended port, then run health and Pi tool-call smoke tests. Do **not** dual-load another 20+ GB model on this Mac.

### Gate 1 — cheap compatibility smoke test

For each candidate, before a full benchmark:

- load at 8K context;
- issue one plain completion;
- run one required tool call, one parallel-call attempt, one malformed-argument recovery, and one tool-result follow-up;
- compare raw generated text with OpenAI-compatible `message.tool_calls`;
- run a 2K-token generation while recording memory and swap;
- reject candidates that cannot complete the Pi protocol reliably.

### Gate 2 — task bake-off

First commit a versioned task manifest. Every task must pin the repository commit/worktree fixture, exact prompt and tool schema, expected tests/outcome, task-success rubric, timeout, turn/tool budget, context target, sampling settings, and transcript path. Randomize or counterbalance candidate order to reduce warm-cache and thermal bias.

Run the surviving candidates on those fixed fixtures:

1. 8K fresh-context implementation task;
2. 32K multi-turn implementation and test task;
3. bug diagnosis followed by implementation;
4. subtle bad-patch review;
5. tool-call recovery after an intentional error;
6. repeated-prefix long session;
7. one Pi-Rogue advisor/router workflow;
8. Gemma-only screenshot/UI task, reported separately from the common text suite.

Use equal repeated trials for every stochastic candidate. Use at least three seeds for the common suite; for North follow the documented `temperature=1.0`, `top_p=0.95` settings. If another model's documented sampling differs, record a documented-settings lane separately from a common-settings lane rather than silently changing the comparison. Also use a separate temperature-zero diagnostic fixture where the runtime supports it.

### Gate 3 — paired speculation and cache replay

For Qwen MTP and any draft path:

- replay identical sessions with speculation off/on;
- compare final patches and tests, not just token strings;
- require exact greedy equivalence only for controlled fixtures whose teacher-forced target-logit margin rules out numerical ties, and for cache rollback/state tests; for general outputs, investigate divergences with top-two logit gaps and require task/benchmark invariance;
- test second and later turns after shared-prefix cache reuse;
- record drafted, accepted, and predicted tokens plus acceptance ratio;
- retain speculation only when successful-task wall time improves without tool or quality regressions.

### Raw record contract

Write one JSONL record per run and derive CSV summaries. Minimum fields:

```json
{
  "run_id": "...",
  "timestamp": "...",
  "machine": "Mac15,6-M3-Pro-36GB",
  "runtime": {"name": "...", "version": "...", "args": []},
  "model": {"id": "...", "revision": "...", "quant": "..."},
  "task_id": "...",
  "task_manifest_revision": "...",
  "budget": {"timeout_s": 0, "max_turns": 0, "max_tool_calls": 0},
  "run_order": 0,
  "seed": 0,
  "context_target": 32768,
  "speculation": {"kind": "none", "drafted": 0, "accepted": 0},
  "cache": {"mode": "cold", "matched_tokens": 0},
  "tokens": {"input": 0, "output": 0},
  "latency_ms": {"ttft": 0, "total": 0},
  "throughput_tps": {"prefill": 0, "decode": 0},
  "memory_bytes": {"peak": 0, "wired": 0, "swap_before": 0, "swap_after": 0},
  "tools": {"calls": 0, "malformed": 0, "unnecessary": 0, "loops": 0},
  "result": {"tests_passed": false, "task_success": false, "notes": ""},
  "transcript_path": "..."
}
```

Rank by:

1. coding task success;
2. wall time to a successful, tested patch;
3. tool-call validity and recovery;
4. long-session stability;
5. memory/swap headroom;
6. throughput only after the above.

## Recommended action order

1. **Do now without machine changes:** keep port 8004 alive; record this research; identify the owner and restart policy for port 8005; decide which caches may be reclaimed.
2. **First approved operational change:** deactivate Qwable without deleting its cache, verify swap/disk headroom, restore the pinned Qwen artifact, and perform a brief single-model cutover—never a dual-load test.
3. **First new model:** North Mini Code 4-bit in an isolated MLX-VLM 0.6.4 environment, with only that model active.
4. **Second:** Qwen OptiQ; compare MTP off/on against the restored GGUF baseline.
5. **Third:** Gemma 4 uniform 4-bit through MLX-VLM for text, tools, and vision.
6. **Only if justified:** North 6-bit, Gemma QAT OptiQ, then DiffusionGemma.

## Primary sources

### Models

- [Canonical Qwen3.6 MTP GGUF repository](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF)
- [Active Qwable model repository](https://huggingface.co/Mia-AiLab/Qwable-3.6-35b)
- [CohereLabs North Mini Code model card](https://huggingface.co/CohereLabs/North-Mini-Code-1.0)
- [Cohere North Mini Code release and methodology](https://huggingface.co/blog/CohereLabs/introducing-north-mini-code)
- [North Mini Code MLX 4-bit](https://huggingface.co/mlx-community/North-Mini-Code-1.0-4bit) and [6-bit](https://huggingface.co/mlx-community/North-Mini-Code-1.0-6bit)
- [Qwen3.6 OptiQ model card](https://huggingface.co/mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit)
- [Gemma 4 26B-A4B official model card](https://huggingface.co/google/gemma-4-26B-A4B-it)
- [DiffusionGemma official model card](https://huggingface.co/google/diffusiongemma-26B-A4B-it)

### Runtimes and correctness

- [MLX-LM repository and long-prompt guidance](https://github.com/ml-explore/mlx-lm)
- [MLX-VLM repository](https://github.com/Blaizzy/mlx-vlm)
- [OptiQ serving documentation](https://mlx-optiq.com/docs/serve)
- [llama.cpp MTP implementation PR #22673](https://github.com/ggml-org/llama.cpp/pull/22673)
- [MLX-LM speculative divergence #1423](https://github.com/ml-explore/mlx-lm/issues/1423) and [#1470](https://github.com/ml-explore/mlx-lm/issues/1470)
- [MLX-LM hybrid-cache/MTP rollback PR #1456](https://github.com/ml-explore/mlx-lm/pull/1456)
- [MLX-LM Gemma 4 Pi tool-call failure #1125](https://github.com/ml-explore/mlx-lm/issues/1125)
- [MLX-LM Gemma 4 parser fix #1150](https://github.com/ml-explore/mlx-lm/pull/1150)
- [MLX-VLM DiffusionGemma marker bug #1351](https://github.com/Blaizzy/mlx-vlm/issues/1351) and [merged fix #1477](https://github.com/Blaizzy/mlx-vlm/pull/1477)

## Confidence and limits

- **High confidence:** machine inventory, running-server state, complete Hub-tree byte totals, published runtime support, issue/PR status observed on 2026-07-14.
- **Medium confidence:** practical memory tiers and rollout order; they are conservative engineering judgments, not measured peaks for every candidate.
- **Low until benchmarked:** relative coding quality, Apple decode speed, 4-bit versus 6-bit quality, MTP speedup/correctness, and final Pi parser reliability.

Vendor benchmark and speed claims are retained only as hypotheses for local testing. No new model is recommended as the default until it completes the fixed Pi task suite without sustained swap or protocol regressions.

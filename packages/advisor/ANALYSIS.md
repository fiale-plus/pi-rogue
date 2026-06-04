# Advisor Package — Architecture Analysis & Improvement Opportunities

**Date**: 2026-06-04
**Scope**: `packages/advisor/src/` — extension.ts, router.ts, preflight-signals.ts, internal.ts, completions.ts

---

## 1. Architecture Overview

The advisor is a **three-layer routing system** wired into the pi agent lifecycle:

```
┌─────────────────────────────────────────────────┐
│  Event Layer (pi lifecycle hooks)               │
│  session_start, before_agent_start,             │
│  turn_end, agent_end, session_shutdown           │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  Preflight Layer (before_agent_start)           │
│  - Heuristic-only, <1ms, no LLM call            │
│  - Binary gate model (local classifier)         │
│  - Decides: continue / escalate / need_more     │
└────────────────────┬────────────────────────────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
┌──────────────────┐  ┌──────────────────────────┐
│  Post-Review     │  │  Mid-Hour Check-ins       │
│  (turn_end,      │  │  (orchestration-managed)  │
│   agent_end)     │  │                           │
│  - Heuristics    │  │  - Higher-model LLM call   │
│  - Binary gate   │  │  - Goal/loop anchored     │
│  - LLM review    │  │                           │
│    (optional)    │  │                           │
└──────────────────┘  └──────────────────────────┘
```

### Key Components

| File | Lines | Role |
|------|-------|------|
| `extension.ts` | ~1440 | Lifecycle wiring, state management, review orchestration, CLI commands |
| `router.ts` | ~500 | Heuristic routing + binary gate model + display formatting |
| `preflight-signals.ts` | ~25 | Intent/mode classification for signal enrichment |
| `internal.ts` | ~55 | File I/O utilities (read/write/append/atomic) |
| `completions.ts` | ~60 | CLI argument completions |

---

## 2. Strengths

### 2.1 Layered Routing Architecture
The three-stage pipeline (heuristics → binary gate → LLM review) is well-designed:
- **Heuristics** run in <1ms with zero cost — catches obvious cases
- **Binary gate** provides a fast local ML classifier as a second opinion
- **LLM review** is only called when both layers agree something needs attention
- This reduces LLM calls by an estimated 60-80% vs. always-calling

### 2.2 State Management
- Persistent JSON state with versioning (`_v` field)
- Atomic writes prevent corruption
- Review control state tracks material signatures to avoid redundant reviews
- Cache system (64 entries) reduces repeated LLM calls

### 2.3 Safety-First Design
- Safety-sensitive keywords (rm -rf, sudo, etc.) bypass all heuristics and always escalate
- Binary gate model is seeded from a known-good JSON file
- Model validation checks kind, mtime, and size on load

### 2.4 Orchestration Integration
- Check-ins are managed by external orchestration (goal/loop/autoresearch)
- Advisory status is visible in cockpit UI
- Review decisions flow through to follow-up messages

---

## 3. Improvement Opportunities

### 3.1 HIGH PRIORITY

#### 3.1.1 Binary Gate Model Training Pipeline (Medium-High Impact)

**Problem**: The binary gate model is seeded from a static JSON file (`binary-gate-model.json`). There is no documented retraining pipeline or evaluation framework for updating it.

**Current state**:
- Model is loaded from `assets/binary-gate-model.json` and copied to user's state directory
- Model validation checks `kind === "binary-logreg-v1"`
- No evaluation metrics or accuracy tracking for the model itself

**Recommendation**:
```
1. Create scripts/evaluate-binary-gate.sh — evaluate model accuracy on logged router decisions
2. Create scripts/retrain-binary-gate.sh — retrain from router logs (evals/advisor-router.jsonl)
3. Add model version tracking with accuracy metadata
4. Document retraining procedure in docs/
```

**Effort**: 2-3 days
**Risk**: Low — retraining is offline, doesn't affect runtime

---

#### 3.1.2 Review Decision Logic Simplification (High Impact)

**Problem**: The `doReview` function (~200 lines) is a monolithic function with 8+ early returns and deep nesting. It handles:
- Signature deduplication
- Heuristic routing
- Binary gate override
- Config review policy merging
- Cache lookup
- LLM review call
- JSON parsing
- State transitions

This makes it hard to test edge cases and reason about.

**Current structure**:
```
doReview()
  ├─ Skip if running → return
  ├─ Skip if signature matches → mark skipped → return
  ├─ Mark running → persist
  ├─ Binary gate override → potentially return early
  ├─ Config review policy check → potentially return early
  ├─ Material signal check → potentially return early
  ├─ Brief context check → potentially return early
  ├─ Cache lookup → potentially return early
  ├─ LLM call → parse JSON → handle verdicts
  └─ Finally block → always persist
```

**Recommendation**:
```
1. Extract into a ReviewPipeline with stages:
   - Stage 1: Quick-skip (running, signature dedup)
   - Stage 2: Gate check (binary gate override)
   - Stage 3: Policy check (config + route review policy)
   - Stage 4: Material check (file changed, failed, brief)
   - Stage 5: Cache lookup
   - Stage 6: LLM review + parse
   - Stage 7: State transition + persist

2. Each stage returns either "skip" with reason or "proceed"
3. Add unit tests for each stage boundary
```

**Effort**: 1-2 days
**Risk**: Medium — requires careful testing of state transitions

---

#### 3.1.3 State Recovery Robustness (Medium Impact)

**Current state**:
- `loadState()` handles corrupted JSON via `readJson()` which returns fallback
- `recoverReviewControl()` handles stale `running` state on session restart
- State versioning added in PR #85

**Gap**: If `state.json` is corrupted to valid JSON but with missing fields (e.g., deleted `notes` array), the state silently degrades without warning.

**Recommendation**:
```
1. Add state validation in loadState() that checks for required fields
2. Log a warning (not error) when state is degraded
3. Add a "state integrity" command: /advisor state integrity
4. Consider adding state snapshots for rollback
```

**Effort**: 1 day
**Risk**: Low

---

### 3.2 MEDIUM PRIORITY

#### 3.2.1 Feature Overlap Between Heuristics and Binary Gate (Medium Impact)

**Problem**: The heuristic rules in `router.ts` and the binary gate model features in `router.ts` share significant keyword overlap:
- Both check for words like "architecture", "refactor", "design", "tradeoff", "security"
- Both check for safety keywords
- Both check for debug indicators

This means the binary gate model is largely re-encoding what the heuristics already detect, rather than adding orthogonal signal.

**Recommendation**:
```
1. Audit binary gate features against heuristic rules
2. Remove features that are already covered by heuristics (e.g., safety keywords, complexity words)
3. Add features the heuristics DON'T cover:
   - Prompt structure patterns (e.g., multi-part questions)
   - Session context signals (e.g., "based on previous decision")
   - Temporal signals (e.g., "after 5 turns", "after compact")
4. Retrain binary gate on the remaining features
```

**Effort**: 2-3 days
**Risk**: Low — but requires retraining to maintain accuracy

---

#### 3.2.2 Review System Prompt Quality (Medium Impact)

**Current state**:
```
REVIEW_SYSTEM = `You are a senior reviewer. An AI agent just completed work. Assess it. Return ONLY valid JSON:
{
  "verdict": "on_track"|"course_correct"|"not_done",
  ...
}`
```

**Issues**:
- System prompt is only 40 words — very minimal
- No examples of correct/incorrect responses
- No guidance on confidence calibration
- No mention of what "material" changes are vs. cosmetic

**Recommendation**:
```
1. Expand REVIEW_SYSTEM to include:
   - 2-3 examples of correct JSON responses
   - Guidance on when to use each verdict
   - Confidence calibration instructions
2. Add a similar system prompt for preflight classification
3. Add a system prompt for check-in prompts (currently ad-hoc in `buildAdvisorCheckinPrompt`)
4. Add output validation in the LLM call (e.g., reject non-JSON responses)

**Effort**: 1 day
**Risk**: Low — improves LLM output quality without changing architecture

---

#### 3.2.4 Router Log Analysis Tooling (Medium Impact)

**Current state**:
- Router logs are written to `evals/advisor-router.jsonl` in real-time
- Logs contain: phase, label, confidence, reason, source, safety, escalate, preflight, review, prompt, brief
- No tooling to analyze these logs for pattern discovery

**Recommendation**:
```
1. Create scripts/analyze-router-logs.sh — analyze logged decisions
2. Compute statistics: distribution of labels, confidence distribution, safety hit rate
3. Identify under-performing routing paths (e.g., frequent low-confidence decisions)
4. Suggest heuristic rule adjustments based on log analysis
5. Export log summaries for documentation
```

**Effort**: 1-2 days
**Risk**: Low — purely analytical

---

#### 3.2.5 State File Size Growth (Low-Medium Impact)

**Current state**:
- `notes` array is capped at `MAX_NOTES = 12` entries
- `files` array is capped at `MAX_FILES = 8` entries
- `errors` array is capped at `MAX_ERRORS = 5` entries
- `cache` is capped at `MAX_CACHE = 64` entries
- But `state.json` grows without bound in some fields:
  - `router.preflight` and `router.review` are never pruned — they accumulate
  - `checkin` object grows with each check-in (lastAt, lastTurn, lastReason, queued, queuedReason)

**Recommendation**:
```
1. Add size limits to router state (keep only last 2 preflight + 2 review decisions)
2. Add periodic state compaction (e.g., on session_start)
3. Document state file size expectations
```

**Effort**: 1 day
**Risk**: Low

---

### 3.3 LOW PRIORITY

#### 3.3.1 Test Coverage Gaps

**Current test coverage** (from 58 tests):
- ✅ Binary gate edge cases (7 tests)
- ✅ State versioning (5 tests)
- ✅ Loop convergence (7 tests)
- ✅ Router logic (5 tests)
- ✅ Extension config (5 tests)
- ✅ Preflight signals (4 tests)
- ❌ Review system prompt quality
- ❌ Review decision pipeline stages
- ❌ Model resolution fallback chain
- ❌ Cache behavior under load
- ❌ Orchestration integration

**Recommendation**: Add 10-15 more tests focusing on:
1. Review pipeline stage boundaries (extracted from doReview)
2. Model resolution fallback chain
3. Cache eviction behavior
4. Orchestration snapshot parsing edge cases

**Effort**: 2-3 days
**Risk**: Low

---

#### 3.3.2 Configuration Schema Validation (Low Impact)

**Current state**: `normalizeAdvisorConfig()` accepts partial config and fills defaults. No JSON schema validation.

**Recommendation**:
```
1. Add JSON schema validation for config.json
2. Warn on unknown fields (typos in config)
3. Add /advisor config validate command
```

**Effort**: 1 day
**Risk**: Low

---

#### 3.3.3 Documentation Gaps (Low Impact)

**Current state**:
- No README.md in packages/advisor/
- No architecture diagram
- No configuration documentation
- No troubleshooting guide

**Recommendation**:
```
1. Add packages/advisor/README.md with:
   - Architecture overview
   - Configuration options
   - Command reference
   - Troubleshooting
2. Add architecture diagram to ANALYSIS.md (this file)
3. Document the three-stage routing pipeline
```

**Effort**: 1-2 days
**Risk**: Low

---

## 4. Summary of Recommendations

| Priority | Area | Impact | Effort | Risk |
|----------|------|--------|--------|------|
| **High** | Binary gate retraining pipeline | High | 2-3d | Low |
| **High** | Review decision simplification | High | 1-2d | Medium |
| **High** | State recovery robustness | Medium | 1d | Low |
| **Medium** | Feature overlap audit | Medium | 2-3d | Low |
| **Medium** | System prompt quality | Medium | 1d | Low |
| **Medium** | Router log analysis | Medium | 1-2d | Low |
| **Low** | State file size growth | Low | 1d | Low |
| **Low** | Test coverage gaps | Low | 2-3d | Low |
| **Low** | Config schema validation | Low | 1d | Low |
| **Low** | Documentation | Low | 1-2d | Low |

**Total estimated effort**: ~12-18 days

---

## 5. Quick Wins (No Architecture Changes)

These can be done immediately without refactoring:

1. **Add state integrity check** — 1 hour
   - `/advisor state integrity` command that validates state.json
   - Warns about missing fields, stale running state

2. **Add router log statistics** — 1 hour
   - Simple script to count label distributions from router.jsonl
   - Useful for monitoring

3. **Expand REVIEW_SYSTEM prompt** — 1 hour ✅ **IMPLEMENTED**
   - Added 3 examples (on_track, course_correct, not_done)
   - Added confidence calibration guidance (0.80+, 0.60-0.79, <0.60)
   - Added material-vs-cosmetic distinction
   - Also expanded ADVISOR_SYSTEM with actionable guidance

4. **Add /advisor model status** — 30 min
   - Show current binary gate model version, last seed update

5. **Document the state file format** — 1 hour
   - Add state.json schema reference to ANALYSIS.md

---

## 6. Risk Assessment

### High-Risk Changes
- **Review decision simplification**: Requires careful state transition testing. The current code has many edge cases around review control state that would need preservation.
- **Binary gate feature changes**: Requires retraining and evaluation before deployment.

### Low-Risk Changes
- State recovery robustness
- Documentation improvements
- Configuration validation
- Router log analysis
- Quick wins above

---

## 7. Next Steps

1. **Immediate** (this session): Document this analysis, commit to repo
2. **Short-term** (1-2 weeks): Implement quick wins (#1-5 above)
3. **Medium-term** (2-4 weeks): Address high-priority items
4. **Long-term** (1-3 months): Full test coverage, retraining pipeline

---

*This analysis was produced by automated code review of packages/advisor/src/ on 2026-06-04.*
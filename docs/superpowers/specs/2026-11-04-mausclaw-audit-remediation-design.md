# MausClaw Audit Remediation — Design

**Status:** Draft for approval. This document authorizes no product-code changes by itself.  
**Date:** 2026-11-04  
**Audit baseline:** `c24f4a9bc3430501a452416d7e221b4b6e802613`  
**Chosen approach:** Security-first, staged remediation in an isolated worktree.

**Audit inputs:** `/tmp/9e64617e-a857-400a-bed8-6ae870ab6ac3.md` and `/tmp/e4b583c8-ad81-4ae6-a389-34ec26562c96.md`. They contain the same M1–M10 findings and distribution/evidence review; the second records the decision to continue the existing MausClaw project. Any companion probe bundle mentioned by the reports has no supplied path, so regression cases will be reconstructed from the documented observations unless that bundle is found locally.

## Intent

Verify the MausClaw findings in the supplied 2026-11-04 audit against the pinned checkout, correct confirmed root causes, and improve the native engine so its security and completion claims match its behavior. Work is limited to MausClaw. The user explicitly excluded deployment.

The running `mausclaw.service` uses the source checkout at `/root/github_repos/MausClaw`; implementation must stay in the isolated worktree `/root/.local/share/opencode/worktree/81973f/mausclaw-audit-remediation`. Do not edit the active checkout, access `/home/maus/.mausclaw` data, contact live providers, restart services, change VPS configuration, or deploy.

## Goals

- Reproduce or otherwise independently verify each audit finding before changing its implementation. Distinguish reproduced behavior from source-only concerns and from claims disproved by current evidence.
- Close native capability approval, scope, executor-containment, path-boundary, and private-network bypasses.
- Make provider/model selection and protocol normalization conform to the provider-neutral engine contract.
- Stop unsafe retries and further batch effects when an operation's outcome is uncertain; make recovery status and evidence accurate.
- Make configured verification failures prevent a false successful completion, and wire orchestration/routing/budgets only where the production path claims to support them.
- Remove default installation of external agent CLIs from MausClaw distribution paths, and make CI/evaluation evidence meaningful and reproducible.
- Add regression coverage for each confirmed finding and verify only with isolated fixtures.

## Non-goals

- Any deployment, release, VPS or subdomain change, service restart, or mutation of live user data.
- Opening a pull request or publishing/pushing these changes.
- Changes to RootClaw, unrelated UI/features, broad redesign, or a claim that MausClaw is superior to competing agents.
- Automatically replaying an uncertain side effect or claiming exactly-once execution without a defensible mechanism.
- Treating a passing unit test or a checker-only score as proof of end-to-end task quality.

## Approaches considered

1. **Security-first staged remediation — selected.** Verify and fix the highest-risk execution and authority boundaries first, then provider/protocol behavior, uncertainty/recovery, verification/orchestration, and finally distribution/CI/evals. Each slice has a reproducer before its fix and an isolated post-fix check. This lowers exposure early and makes regressions attributable.
2. **Contract-centered refactor.** Replace the capability and model adapter paths with broader new contracts, then migrate all providers. This may improve consistency, but expands the change surface before the current unsafe behaviors are contained.
3. **Minimal patch per finding.** Fix each symptom locally. This keeps individual diffs small but risks duplicating policy and leaving equivalent bypasses in sibling providers.

The user selected approach 1. Small contract changes are acceptable where required to enforce one policy; a wholesale runtime rewrite is not the goal.

## Scope and design decisions

The work covers MausClaw audit findings M1–M10 and the related distribution and evidence gaps in audit sections 8–9. Findings must be tracked separately as reproduced, source-confirmed but not reproduced, not reproduced, or requiring more evidence. Do not silently widen scope when a probe fails to establish a claim.

### 1. Capability authority, approval, and containment (M1)

- Define one authoritative decision path for capability discovery, validation, and dispatch. A model returning a hidden/denied tool name must not bypass the same scope/grant checks applied to the advertised catalog.
- `toolsEnabled: false` must prevent native tools from being mounted/offered/dispatched. `computerUse` must independently govern computer capabilities. MCP and native tools must follow the same grant and safety-floor semantics.
- Reuse MausClaw's existing approval and safety-floor mechanisms for native mutations. In `ask` mode, no effect occurs before approval; deny, expiry, cancellation, malformed calls, or missing authority must stop before execution. Approval must not override the safety floor.
- Replace regex-only read-only command screening with OS-enforced workspace isolation and explicit policy. If a supported platform cannot provide the required isolation, fail closed rather than silently executing on the host. Preserve an intentional, clearly described full-access mode only where existing product policy explicitly permits it; it still cannot bypass the safety floor.
- Test shell, file mutation, git mutation, and computer execution through the actual dispatch path, including guessed tool names and each approval outcome.

### 2. Filesystem and web boundaries (M7, M9)

- Resolve workspace roots canonically and reject traversal through any symlink ancestor, including paths whose leaf or intermediate directories do not yet exist. Apply the same boundary to reads, writes, edits, glob, and grep; recursive search must not follow escaping symlinks. Use no-follow/descriptor-based operations or equivalent race-resistant handling where supported; revalidate around directory creation.
- Normalize IP literals before classification, including IPv4-mapped IPv6, and reject loopback, link-local, private, unspecified, multicast, and reserved/non-global destinations. Resolve and pin the checked destination for the connection to prevent a DNS check/fetch rebinding gap; validate every redirect. Tests use injected DNS/fetch implementations and must not access real private hosts.

### 3. Provider protocol and model identity (M2–M4)

- Keep provider wire formats inside adapters. Normalize valid terminal markers (Anthropic `end_turn`, Gemini `STOP`, Responses `completed`) into a documented engine-level finish-reason set; distinguish tool handoff, normal completion, refusal, and incomplete/error states.
- Aggregate valid protocol tool calls into the engine's canonical batch contract, preserve all calls, and ensure call IDs are unique across calls and rounds, including repeated Gemini function names. The runtime must reject malformed or duplicate IDs without rejecting valid multi-call responses.
- Resolve adapters using the full `ProviderModelRef`. Never send a model ID through another provider's endpoint/key/protocol merely because it is non-default. Unsupported or unavailable provider/model pairs fail before network dispatch. Fallback candidates must identify configured provider/model pairs and respect retry-safety and effect state.

### 4. Uncertain effects, process lifecycle, and durable recovery (M5–M6, M10)

- An outcome marked uncertain, or a post-dispatch failure whose effect cannot be disproved, becomes `recovery_required`; it stops the current mutation batch immediately. Do not invoke a second provider after an uncertain result. Retry/fallback is allowed only for a known pre-dispatch or explicitly retry-safe failure.
- Terminate the complete shell process tree on timeout/interruption using supported OS process-group/job controls. If the system cannot prove termination or the command may have taken effect, report uncertainty rather than an ordinary retryable failure. Test with delayed child-process effects in a disposable directory.
- Persist enough bounded run/capability evidence to inspect what was requested, authorized, dispatched, and settled. Startup reconciliation must distinguish stale owners from live runs; it must not globally mark another active run interrupted. Recovery means explicit inspection/reconciliation, not automatic replay of uncertain work. Retain appropriate redaction and size limits.

### 5. Verification, orchestration, routing, and budgets (M8, M10)

- A configured verifier receives task criteria and relevant result evidence (tool outcomes and/or independently checked artifacts), not merely capability names. A negative verdict or verifier error must not produce a successful terminal receipt when verification is required. An unconfigured optional verifier must be represented as not-run, not as a pass. Model-caller requirements/signals must be validated before starting a request.
- Trace the production request path for explicit multi-step plans. Wire the existing orchestrator where the product exposes planning; normal single-turn chat may remain a direct engine run. Persist and expose plan/step outcomes accurately, and stop a plan on failed or uncertain steps according to policy.
- Remove hard-coded cross-provider/model routes that do not correspond to configured adapters. Tiers and fallbacks must select only available models/providers. Budget accounting must include all model calls made by the engine, verifier, compaction, and orchestration, or clearly identify unmetered categories and prevent them from being represented as covered by a hard cap.

### 6. Distribution, CI, and evaluation evidence

- MausClaw images/Compose defaults must not install Claude Code, Codex, Grok CLI, or other external agent engines. Audit each current build argument/install step; remove default installation paths and keep only supported MausClaw-native API drivers. Inspect `rea-agents` separately before classifying/removing it; the audit did not establish that package as an active agent engine.
- Replace image checks that do not inspect/assert image contents with checks that build and inspect the actual artifact. CI must reach lint, typecheck, build, and runtime/evaluation jobs; resolve current preflight/schema/documentation drift rather than masking it.
- Evaluation runners must return nonzero for failed tasks, retain capped/infra/unrun outcomes in the report, apply budgets before model startup, hash task content/configuration, and use comparable model/revision/environment when scores are compared. Report checker-only and scripted tests as harness checks, not live-agent capability scores.

## Verification and acceptance

- For each finding, add a smallest reliable regression test that fails before the fix and passes after it. State the root cause and evidence; do not substitute static assertions for behavior where a fixture can exercise the real path.
- Use temporary workspaces and the repository's isolated verification surface (`docs/verification/README.md`, including `pnpm control:mausclaw launch` where an end-to-end turn is needed). Never send a turn to the active service or use its data directory. Do not make live provider calls.
- Run focused unit/contract tests after each slice; before completion run the relevant isolated fixtures plus lint, typecheck, build, and the broadest feasible server test suite. Report any unavailable checks, pre-existing failures, and platform limitations explicitly.
- Completion means each in-scope finding has a recorded disposition and regression/evidence; P0 boundaries are enforced at actual dispatch; protocol/provider tests pass; uncertain work is not replayed; required verification cannot fail open; native-only distribution assertions pass; and CI/eval reports do not misstate results. This is not a production deployment approval.

## Remaining implementation choices

The builder may choose the smallest internal API/type changes that satisfy these invariants, follow existing MausClaw patterns, and keep the public contracts additive where practical. If an OS sandbox or DNS-pinning approach cannot meet the stated invariant on a supported platform without a new dependency or a product-policy change, stop and bring that concrete tradeoff back for approval rather than weakening the boundary silently.

# MEKA Repo Operating Rules (AGENTS.md)

This repo is the API implementation of **MEKA**: a semantic operating system / cognitive control architecture.
The goal is not “code that compiles.” The goal is **stable, auditable behavior over time**.

This file is the operating contract for any agent (Codex or otherwise) modifying the repo.

## What MEKA is in code (the actual pipeline)
In this repo, MEKA is not “one model prompt.” It is a pipeline:

1) **Ingress Rails**: validate input shape, size, cancellation/abort behavior.
2) **Tool Gatekeeper**: decide whether function tools may run for this request.
3) **Retriever/Router**: choose vector stores + truth policy overlay (canon/threads/manifest) and cap rules.
4) **Canon Ops Enforcer**: tombstones/supersession/authority overlays (stability + drift control).
5) **Responder**:
   - streaming path (SSE relay), OR
   - local tool-loop path (non-streaming tool loop → then SSE emit)
6) **Writeback Subsystem**:
   - extract/validate writeback envelope from assistantText
   - persist state_pack + append event log
   - **must not leak writeback markers into user-visible assistant text**
7) **Telemetry/Taps**: retrieval_tap + stream tap + event log for auditability.

Any change must respect this pipeline.

## Prime MEKA invariants (non-negotiable)
These are the “semantic OS” translated into testable API behavior:

- **No Silent Tool Execution**: if function tools are requested and not authorized, fail loudly (401), do not “pretend tools are off.”
- **Writeback Separation**: writeback payload exists for durability, but must not appear inside user-visible assistant text stream.
- **Retrieval Trace Integrity**: retrieval_tap format must remain readable by the UI (avoid breaking the panel).
- **Deterministic Debuggability**: if something breaks, harness must tell us *what* broke without manual spelunking.

## PowerShell-first editing protocol (the rule for this repo)
Do not ask a human to “go find” code locations.

Required protocol:
1) Provide PowerShell commands to locate and dump the exact context needed.
2) Human pastes back relevant snippets.
3) Provide PowerShell patch commands that apply minimal diffs.
4) Human runs the harness scripts to verify.

## Hot zones (extra care)
Edits in these areas require minimal diffs + harness updates:
- `app/api/turn_response/route.ts`
- tool gating + tool loop execution
- SSE streaming relay and writeback suppression
- retrieval trace endpoints + tap writers

## Harness rules (how we stop regressions)
- Every bug fix adds/updates a harness check.
- A change is “done” only when smoke harness passes.
- Prefer small fixtures in `meka/fixtures/turn_requests/`.

## How to run the harness
From repo root:

- `pwsh .\scripts\ps\meka.smoke.ps1`
- Optional production bypass check:
  `pwsh .\scripts\ps\meka.smoke.ps1 -ProdCheck`

## Notes for Codex usage
- Always read this file first.
- Always run `scripts/ps/meka.smoke.ps1` before and after changes.
- When proposing a change, state:
  - the invariant being protected
  - what harness check proves it
  - what files you will touch (minimum set)

## Dual-Agent Zero-Trust Fast Loop (Repo Standard)
Role split:
- ChatGPT = Conceptual Lead/QA; produces invariants/tests/stop-conditions + CODEX TASK blocks.
- Codex = Technical Architect/Lead Dev; adversarial audit first for YELLOW/RED; then implement + run proofs.

Risk tiers:
- GREEN: implement immediately.
- YELLOW: 3 failure modes + 3 optimizations then implement.
- RED: same as YELLOW + stricter stop conditions + explicit proofs.

CODE RED handling:
- Freeze changes, output drift audit (ask/now/next/codex-task), no backlog resurrection.

Output format requirements:
- Always show: `git status -sb`, `git diff --stat`, smoke PASS/FAIL line(s), commit message, push result.
- Never ask the user to paste tool output; Codex must obtain needed truth via commands.

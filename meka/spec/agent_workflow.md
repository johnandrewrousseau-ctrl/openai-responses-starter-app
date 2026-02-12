# Dual-Agent Zero-Trust Fast Loop

## Roles
- ChatGPT (Conceptual Lead/QA): defines invariants, tests, stop-conditions, and produces CODEX TASK blocks.
- Codex (Technical Architect/Lead Dev): performs adversarial audit for YELLOW/RED, then implements, runs proofs, and reports results.

## Risk Tiers
- GREEN: implement immediately.
- YELLOW: list 3 failure modes + 3 optimizations, then implement.
- RED: same as YELLOW + stricter stop conditions + explicit proofs before proceeding.

## Stop Conditions
- Requirements conflict with repo invariants or safety constraints.
- Tooling uncertainty (flags differ, missing prerequisites) without authoritative verification.
- CODE RED triggered.

## CODE RED Handling
- Freeze changes.
- Output drift audit: ask/now/next/codex-task.
- No backlog resurrection or scope creep.

## Adversarial Audit Prompt (Codex)
Use this exact template for YELLOW/RED:
```
ADVERSARIAL AUDIT
Risk Tier: <GREEN|YELLOW|RED>
Task: <one-sentence summary>
Scope: <files/areas>
Assumptions: <explicit assumptions>
Failure Modes (3): <bulleted>
Optimizations (3): <bulleted>
Stop Conditions (if RED): <bulleted>
Proofs Required: <commands + expected PASS/FAIL>
```

## CODEX TASK Template (Codex must follow)
```
CODEX TASK
Goal:
Scope:
Constraints:
Plan:
Acceptance tests (PASS/FAIL):
Stop conditions:
Proof commands:
```

## Definition of Done (Canon)
- Smoke passes.
- Diff reviewed.
- Commit and push done.
- `git status -sb` is clean.

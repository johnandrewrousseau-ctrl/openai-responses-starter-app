# MEKA API Invariants (Executable Spec)

This file translates the “semantic operating system” into testable API-level behavior.

## I. Tool Authorization (Gatekeeper)
Invariant:
- If a request asks for function tools (`toolsState.functionsEnabled = true`)
  and the request is NOT authorized, the API must return **401** immediately.

Why:
- Prevent “silent tool-off” drift and confusion.
- Prevent unauthorized local tool execution.

Harness:
- `scripts/ps/meka.smoke.ps1` → `unauthorized_tools_must_401`

## II. Writeback Separation
Invariant:
- User-visible assistant text must never include writeback markers:
  `BEGIN_WRITEBACK_JSON` / `END_WRITEBACK_JSON`

Why:
- Writeback exists for durability/state, not for user display.

Harness:
- `scripts/ps/meka.smoke.ps1` → `authorized_tools_no_writeback_leak`

## III. Baseline Responsiveness
Invariant:
- With tools disabled, `/api/turn_response` must still respond correctly.

Harness:
- `scripts/ps/meka.smoke.ps1` → `baseline_turn_works`

## IV. Production Bypass Impossible
Invariant:
- In production (`NODE_ENV=production` and/or `VERCEL_ENV=production`), any dev bypass must be impossible.

Harness:
- `scripts/ps/meka.smoke.ps1 -ProdCheck` → `prod_bypass_impossible`

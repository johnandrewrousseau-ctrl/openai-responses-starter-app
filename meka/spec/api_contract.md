# MEKA API Contract (Practical)

This doc describes the endpoints the harness expects.

## GET /api/tool_status
Purpose:
- sanity status for local tool registration and auth state

Harness use:
- readiness check (server is up)

## POST /api/turn_response  (SSE)
Request JSON:
- { "messages": [...], "toolsState"?: { "functionsEnabled"?: boolean } }

Behavior:
- returns SSE stream (text/event-stream) on success
- may return JSON error on validation/auth failures

Harness use:
- baseline test
- unauthorized tools test (expects 401)
- authorized tools test (expects visible text OK and no writeback markers)

## GET /api/retrieval_trace, GET /api/state_pack
Not required for the initial bootstrap smoke, but treated as part of system integrity.

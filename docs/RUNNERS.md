# Runners

## Canon Mode
- Headers: `CANON_QUERY_RUNNER`, `CANON_PAK_RUNNER`, `Target: CANON ONLY`
- Uses env `MEKA_VECTOR_STORE_ID_CANON`
- Response header: `x-meka-canon-vs`

## Thread Mode
- Headers: `THREAD_QUERY_RUNNER`, `GOLD_HUNT_RUNNER`, `Target: THREADS ONLY`
- Uses env `MEKA_VECTOR_STORE_ID_THREADS`
- Response header: `x-meka-threads-vs`

## Conflict Guard
- If canon + thread headers appear together, request fails with `400 mode_conflict`.

## Tooling Behavior
- In Canon/Thread/GoldHunt mode, `file_search` is forced first.
- Fixtures keep functions disabled and web search off.

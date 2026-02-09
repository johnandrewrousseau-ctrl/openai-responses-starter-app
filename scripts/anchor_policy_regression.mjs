// scripts/anchor_policy_regression.mjs
// Verifies: anchor queries => truth_policy=ANCHOR_CANON_ONLY, anchor_kind set, canon-only vector store routing.

import fs from "node:fs";
import path from "node:path";

// Optional dotenv support (won't crash if not installed)
try {
  await import("dotenv/config");
} catch {
  // ignore
}

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const BASE = arg("base", "http://localhost:3000");
const CANON_ID =
  arg("canon", null) ||
  (process.env.MEKA_VECTOR_STORE_ID_CANON || "").trim();

const TAP_PATH = path.join(process.cwd(), "state", "retrieval_tap.jsonl");

function fail(msg) {
  console.error(`\n[FAIL] ${msg}\n`);
  process.exit(1);
}

function pass(msg) {
  console.log(`[PASS] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

function findLastRequestMatching(entries, predicate) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.kind === "request" && predicate(e)) return e;
  }
  return null;
}

async function postTurn(lastUserText) {
  const url = `${BASE.replace(/\/$/, "")}/api/turn_response`;

  const body = {
    messages: [{ role: "user", content: lastUserText }],
    toolsState: {},
    googleIntegrationEnabled: false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    fail(`HTTP ${res.status} from /api/turn_response. Body: ${t.slice(0, 500)}`);
  }

  // Consume SSE quickly (we don't need to fully parse content for this test)
  const reader = res.body?.getReader();
  if (!reader) fail("No response body stream (ReadableStream missing).");

  const dec = new TextDecoder();
  let done = false;
  let guard = 0;

  while (!done) {
    const { value, done: dr } = await reader.read();
    done = dr;
    if (value) dec.decode(value);

    // Prevent hanging forever if something goes wrong
    guard++;
    if (guard > 5000) break;
  }
}

function assertRequest(req, expected) {
  const { label, anchorKind, mustContainText } = expected;

  if (!req) fail(`${label}: did not find matching request entry in retrieval_tap.jsonl`);

  if ((req.truth_policy || "") !== "ANCHOR_CANON_ONLY") {
    fail(
      `${label}: truth_policy mismatch. expected ANCHOR_CANON_ONLY, got ${JSON.stringify(
        req.truth_policy
      )}`
    );
  }

  if ((req.anchor_kind || null) !== anchorKind) {
    fail(
      `${label}: anchor_kind mismatch. expected ${anchorKind}, got ${JSON.stringify(req.anchor_kind)}`
    );
  }

  const ids = Array.isArray(req.vector_store_ids_active) ? req.vector_store_ids_active : [];
  if (!CANON_ID) {
    fail(
      `${label}: MEKA_VECTOR_STORE_ID_CANON is not set (and --canon not provided). Cannot verify routing.`
    );
  }

  if (!(ids.length === 1 && ids[0] === CANON_ID)) {
    fail(
      `${label}: vector_store_ids_active mismatch. expected [${CANON_ID}], got ${JSON.stringify(ids)}`
    );
  }

  const lut = (req.last_user_text || "");
  if (!lut.toLowerCase().includes(mustContainText.toLowerCase())) {
    fail(`${label}: last_user_text mismatch. got ${JSON.stringify(lut)}`);
  }

  pass(`${label}: truth_policy + anchor_kind + canon-only routing verified`);
}

async function main() {
  console.log(`MEKA Anchor Policy Regression — base: ${BASE}`);

  if (!fs.existsSync(path.join(process.cwd(), "state"))) {
    fail(`state/ directory not found under cwd: ${process.cwd()}`);
  }
  if (!fs.existsSync(TAP_PATH)) {
    console.log(`[WARN] ${TAP_PATH} not found yet. It will be created after first request.`);
  }

  // Snapshot tap length before running, so we can search only new entries if desired.
  const before = readJsonl(TAP_PATH);
  const beforeLen = before.length;

  const missionQ = "What is MEKA’s Mission Anchor sentence? Quote it exactly and cite the source file.";
  const identityQ = "What is MEKA’s Identity Anchor sentence? Quote it exactly and cite the source file.";

  await postTurn(missionQ);
  await sleep(150); // small delay to allow tap flush

  await postTurn(identityQ);
  await sleep(150);

  const after = readJsonl(TAP_PATH);
  const newEntries = after.slice(Math.max(0, beforeLen - 5)); // small overlap for safety

  const missionReq = findLastRequestMatching(newEntries, (e) =>
    String(e.last_user_text || "").includes("Mission Anchor")
  );
  const identityReq = findLastRequestMatching(newEntries, (e) =>
    String(e.last_user_text || "").includes("Identity Anchor")
  );

  assertRequest(missionReq, {
    label: "Mission Anchor",
    anchorKind: "mission",
    mustContainText: "Mission Anchor",
  });

  assertRequest(identityReq, {
    label: "Identity Anchor",
    anchorKind: "identity",
    mustContainText: "Identity Anchor",
  });

  console.log("\n[PASS] All anchor policy checks passed.\n");
}

main().catch((e) => fail(`Unhandled error: ${e?.stack || String(e)}`));

#!/usr/bin/env node
// MEKA Routing Regression (non-anchor)
// Verifies non-anchor routing behavior by reading the latest `request` line in state/retrieval_tap.jsonl
//
// Note: Do NOT put glob strings like "**/" inside /* */ comments because "**/"
// contains "*/" which terminates the comment early in JS.

import fs from "fs";
import path from "path";

// Load env vars for node-run regression scripts.
// Next.js loads .env* automatically; plain `node` does not.
// We load in this order (do not override existing process.env):
//  - .env.local
//  - .env.development.local
//  - .env.development
//  - .env
function parseEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if (!k) continue;

      // strip surrounding quotes
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }

      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function loadEnvBestEffort() {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, ".env.local"),
    path.join(cwd, ".env.development.local"),
    path.join(cwd, ".env.development"),
    path.join(cwd, ".env"),
  ];

  // Prefer dotenv if installed, but do not require it.
  let dotenv = null;
  try {
    const mod = await import("dotenv");
    dotenv = mod?.default || mod;
  } catch {
    dotenv = null;
  }

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;

    if (dotenv?.config) {
      try {
        dotenv.config({ path: p, override: false });
        continue;
      } catch {
        // fall through to manual parser
      }
    }

    const kv = parseEnvFile(p);
    for (const [k, v] of Object.entries(kv)) {
      if (process.env[k] === undefined) process.env[k] = String(v);
    }
  }
}

const DEFAULT_BASE = "http://localhost:3000";

function parseArgs(argv) {
  const out = { base: DEFAULT_BASE, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base" && argv[i + 1]) out.base = argv[++i];
    else if (a === "--verbose") out.verbose = true;
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureFetch() {
  if (typeof fetch === "function") return fetch;
  const mod = await import("node-fetch");
  return mod.default;
}

// Single local assertion helper to avoid collisions and duplicate declarations.
function mekaAssert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function eqArr(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function readLastRequestTapLine(tapPath) {
  if (!fs.existsSync(tapPath)) return null;
  const raw = fs.readFileSync(tapPath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && obj.kind === "request" && Array.isArray(obj.vector_store_ids_active)) return obj;
    } catch {
      // ignore
    }
  }
  return null;
}

function listRouteFiles(rootDir) {
  const out = [];
  const stack = [rootDir];

  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === ".next" || ent.name === ".git") continue;
        stack.push(full);
      } else if (ent.isFile()) {
        const n = ent.name.toLowerCase();
        if (n === "route.ts" || n === "route.js" || n === "route.tsx" || n === "route.jsx") out.push(full);
      }
    }
  }

  return out;
}

function deriveApiPathFromRouteFile(routeFileAbs, repoRoot) {
  // <repo>/app/api/<segments...>/route.ts -> /api/<segments...>
  const rel = path.relative(repoRoot, routeFileAbs);
  const parts = rel.split(path.sep);

  const appIdx = parts.indexOf("app");
  if (appIdx === -1) return null;

  const apiIdx = parts.indexOf("api");
  if (apiIdx === -1) return null;

  const routeIdx = parts.findIndex((p) => p.toLowerCase().startsWith("route."));
  if (routeIdx === -1) return null;

  const segs = parts.slice(apiIdx + 1, routeIdx);
  if (!segs.length) return "/api";
  return "/api/" + segs.join("/");
}

function scoreRouteFileContents(fileText) {
  const t = (fileText || "").toLowerCase();
  let s = 0;
  if (t.includes("createresponsewithretry")) s += 50;
  if (t.includes("meka_budgets")) s += 25;
  if (t.includes("resolvetruthsourcepolicy")) s += 20;
  if (t.includes("file_search")) s += 20;
  if (t.includes("vector_store")) s += 20;
  if (t.includes("retrieval_tap.jsonl")) s += 15;
  if (t.includes("stream_tap.jsonl")) s += 10;
  if (t.includes("export async function post")) s += 10;
  return s;
}

function discoverApiCandidates(repoRoot, verbose) {
  const apiRoot = path.join(repoRoot, "app", "api");
  if (!fs.existsSync(apiRoot)) return [];

  const routeFiles = listRouteFiles(apiRoot);
  const candidates = [];

  for (const rf of routeFiles) {
    let txt = "";
    try {
      txt = fs.readFileSync(rf, "utf8");
    } catch {
      // ignore
    }

    const apiPath = deriveApiPathFromRouteFile(rf, repoRoot);
    if (!apiPath) continue;

    candidates.push({
      apiPath,
      file: rf,
      score: scoreRouteFileContents(txt),
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const uniq = [];
  for (const c of candidates) {
    if (seen.has(c.apiPath)) continue;
    seen.add(c.apiPath);
    uniq.push(c);
  }

  if (verbose) {
    console.log("Discovered API candidates (ranked):");
    for (const c of uniq.slice(0, 12)) {
      console.log(`  ${c.apiPath}  score=${c.score}  file=${path.relative(repoRoot, c.file)}`);
    }
    if (uniq.length > 12) console.log(`  ... (${uniq.length - 12} more)`);
  }

  return uniq.map((c) => c.apiPath);
}

async function probeEndpoint(fetchFn, base, apiPath) {
  const url = base.replace(/\/$/, "") + apiPath;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "ping" }],
        toolsState: {},
      }),
    });

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const okish =
      ct.includes("text/event-stream") ||
      ct.includes("application/json") ||
      res.status === 400 ||
      res.status === 413 ||
      res.status === 415 ||
      res.status === 500;

    try {
      await res.text();
    } catch {
      // ignore
    }

    return okish ? { ok: true, status: res.status, ct } : { ok: false, status: res.status, ct };
  } catch (e) {
    return { ok: false, err: e };
  }
}

async function detectEndpoint(fetchFn, base, verbose) {
  const repoRoot = process.cwd();

  const derived = discoverApiCandidates(repoRoot, verbose);

  const guessed = [
    "/api/chat",
    "/api/meka",
    "/api/route",
    "/api/assistant",
    "/api/assistant/chat",
    "/api/meka/chat",
    "/api/meka/stream",
    "/api/chat/stream",
    "/api/respond",
    "/api/openai",
  ];

  const candidates = [...derived, ...guessed];

  for (const p of candidates) {
    const r = await probeEndpoint(fetchFn, base, p);
    if (verbose) {
      const msg = r.ok
        ? `OK status=${r.status} ct=${r.ct}`
        : r.err
        ? `ERR ${String(r.err)}`
        : `NO status=${r.status} ct=${r.ct}`;
      console.log(`Probe ${p} -> ${msg}`);
    }
    if (r.ok) return p;
  }

  return null;
}

async function postMessage(fetchFn, base, endpointPath, userText) {
  const url = base.replace(/\/$/, "") + endpointPath;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: userText }],
      toolsState: {},
    }),
  });

  const body = await res.text().catch(() => "");
  return { status: res.status, contentType: res.headers.get("content-type") || "", body };
}

function cap2(ids) {
  return ids.filter(Boolean).slice(0, 2);
}

async function main() {
  await loadEnvBestEffort();

  const args = parseArgs(process.argv);
  const fetchFn = await ensureFetch();

  const cwd = process.cwd();
  const tapPath = path.join(cwd, "state", "retrieval_tap.jsonl");

  console.log(`MEKA Routing Regression (non-anchor) — base: ${args.base}`);

  const endpointPath = await detectEndpoint(fetchFn, args.base, args.verbose);
  mekaAssert(endpointPath, "Could not detect API endpoint. Confirm dev server is running.");
  console.log(`Using endpoint: ${endpointPath}`);

  const canon = (process.env.MEKA_VECTOR_STORE_ID_CANON || "").trim();
  const threads = (process.env.MEKA_VECTOR_STORE_ID_THREADS || "").trim();
  const manifest = (process.env.MEKA_VECTOR_STORE_ID_MANIFEST || "").trim();
  const legacy = (process.env.MEKA_VECTOR_STORE_ID || "").trim();

  const tests = [
    {
      name: "Manifest query routes to [manifest, canon] (cap2)",
      userText: "List the manifest registry inventory and explain governing authority context.",
      required: () => !!manifest && !!canon,
      expectedActive: () => cap2([manifest, canon]),
      assertions: (req) => {
        mekaAssert(req.anchor_kind == null, "Expected anchor_kind=null for non-anchor routing tests.");
        mekaAssert(req.truth_policy !== "ANCHOR_CANON_ONLY", "Expected non-anchor truth policy here.");
      },
    },
    {
      name: "Threads query routes to [threads, manifest] (cap2)",
      userText: "Find where did I say this in the old chat thread (goldpaks).",
      required: () => !!threads && !!manifest,
      expectedActive: () => cap2([threads, manifest]),
      assertions: (req) => {
        mekaAssert(req.anchor_kind == null, "Expected anchor_kind=null for non-anchor routing tests.");
        mekaAssert(req.truth_policy !== "ANCHOR_CANON_ONLY", "Expected non-anchor truth policy here.");
      },
    },
    {
      name: "Canon non-anchor query routes to [canon, manifest] (cap2)",
      userText: "Summarize BPA-1.0 posture guidance and cite sources.",
      required: () => !!canon && !!manifest,
      expectedActive: () => cap2([canon, manifest]),
      assertions: (req) => {
        mekaAssert(req.anchor_kind == null, "Expected anchor_kind=null for non-anchor routing tests.");
      },
    },
    {
      name: "Default query routes to [canon, threads] (cap2)",
      userText: "Explain how the request routing works at a high level.",
      required: () => !!canon && !!threads,
      expectedActive: () => cap2([canon, threads]),
      assertions: (req) => {
        mekaAssert(req.anchor_kind == null, "Expected anchor_kind=null for non-anchor routing tests.");
      },
    },
  ];

  // If none can run, fail loudly (this is C10’s purpose).
  const runnable = tests.filter((t) => t.required());
  mekaAssert(
    runnable.length > 0,
    [
      "No routing regression checks could run because required vector store IDs are missing.",
      "Expected these to be present via .env.local:",
      "  MEKA_VECTOR_STORE_ID_CANON",
      "  MEKA_VECTOR_STORE_ID_THREADS",
      "  MEKA_VECTOR_STORE_ID_MANIFEST",
      "(legacy MEKA_VECTOR_STORE_ID is optional).",
    ].join("\n")
  );

  for (const t of tests) {
    if (!t.required()) {
      console.log(`[SKIP] ${t.name} (missing required env store ids)`);
      continue;
    }

    const before = readLastRequestTapLine(tapPath);

    await postMessage(fetchFn, args.base, endpointPath, t.userText);
    await sleep(175);

    let after = readLastRequestTapLine(tapPath);
    mekaAssert(after, `No request record found in ${tapPath}`);

    // race-safe: if it didn't advance, wait once more
    if (before && after.ts === before.ts && after.last_user_text === before.last_user_text) {
      await sleep(225);
      const after2 = readLastRequestTapLine(tapPath);
      if (after2) after = after2;
    }

    mekaAssert(Array.isArray(after.vector_store_ids_active), `${t.name}: vector_store_ids_active missing.`);
    mekaAssert(typeof after.inv_sha12 === "string" && after.inv_sha12.length === 12, `${t.name}: inv_sha12 missing/invalid.`);
    mekaAssert(typeof after.truth_policy === "string", `${t.name}: truth_policy missing.`);
    mekaAssert("anchor_kind" in after, `${t.name}: anchor_kind field must be present (null allowed).`);

    const expected = t.expectedActive();
    mekaAssert(
      eqArr(after.vector_store_ids_active, expected),
      `${t.name}\nExpected vector_store_ids_active=${JSON.stringify(expected)}\nActual   vector_store_ids_active=${JSON.stringify(after.vector_store_ids_active)}`
    );

    t.assertions(after);

    console.log(`[PASS] ${t.name}`);
  }

  console.log(`\n[PASS] All routing regression checks passed.`);
}

main().catch((e) => {
  console.error(`\n[FAIL] ${e?.message || e}`);
  process.exit(1);
});

// scripts/canon_ops_build.mjs
import fs from "node:fs";
import path from "node:path";

/**
 * Canon Ops Build
 * - Reads: state/CanonManifest.txt (JSON), state/ArtifactRegistry.txt (text registry)
 * - Reads: state/Tombstones.txt, state/Supersedes.txt (optional; defaults to empty)
 * - Writes: state/canon_ops.json, state/canon_ops.collisions.json
 * - Hard-gates (exit 2) on any collisions/validation errors.
 *
 * Determinism rules:
 * - Tombstone wins (artifact is inactive regardless of supersession).
 * - Supersession collapses to terminal successor (A->B->C resolves to C).
 * - No cycles, no unknown IDs, no self-edges.
 * - Default: one successor per artifact (no branching).
 */

function readUtf8(p) {
  const raw = fs.readFileSync(p, "utf8");
  // Strip UTF-8 BOM if present (common on Windows)
  return raw.replace(/^\uFEFF/, "");
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function existsAny(paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function parseArtifactRegistry(text) {
  const lines = text.split(/\r?\n/);

  const artifacts = [];
  let cur = null;

  function commit() {
    if (!cur) return;
    if (cur.artifact_id) artifacts.push(cur);
    cur = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (!line.trim()) continue;
    if (line.trimStart().startsWith("#")) continue;

    if (line.trimStart().startsWith("- artifact_id:")) {
      commit();
      const v = line.split(":").slice(1).join(":").trim();
      cur = { artifact_id: v };
      continue;
    }

    if (!cur) continue;

    const m = line.match(/^\s*([A-Za-z0-9_]+):\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];

    val = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

    cur[key] = val;
  }

  commit();
  return artifacts;
}

/**
 * Tombstones file formats supported:
 * 1) One artifact_id per line: PF-2
 * 2) Registry-like blocks:
 *    - artifact_id: PF-2
 *      reason: ...
 * 3) CSV-ish: PF-2, some reason text
 *
 * Output shape: [{ artifact_id, reason? }]
 */
function parseTombstones(text) {
  const lines = text.split(/\r?\n/);
  const out = [];

  // Try registry-like first (if it contains "- artifact_id:")
  if (lines.some((l) => l.trimStart().startsWith("- artifact_id:"))) {
    const items = [];
    let cur = null;

    function commit() {
      if (!cur) return;
      if (cur.artifact_id) items.push(cur);
      cur = null;
    }

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;
      if (line.trimStart().startsWith("#")) continue;

      if (line.trimStart().startsWith("- artifact_id:")) {
        commit();
        const v = line.split(":").slice(1).join(":").trim();
        cur = { artifact_id: v };
        continue;
      }

      if (!cur) continue;

      const m = line.match(/^\s*([A-Za-z0-9_]+):\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      val = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      cur[key] = val;
    }

    commit();
    for (const it of items) {
      out.push({
        artifact_id: it.artifact_id,
        reason: it.reason ?? it.notes ?? "",
      });
    }
    return out;
  }

  // Line-based
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;

    // allow "ID, reason..."
    const parts = line.split(",");
    const artifact_id = parts[0].trim();
    const reason = parts.slice(1).join(",").trim();

    if (!artifact_id) continue;
    out.push({ artifact_id, reason });
  }

  return out;
}

/**
 * Supersedes file formats supported:
 * 1) One edge per line: OLD -> NEW   (also supports =>, →)
 * 2) CSV-ish: OLD,NEW
 * 3) JSON array of edges: [{ from:"OLD", to:"NEW" }, ...]
 *
 * Output shape: [{ from, to, reason? }]
 */
function parseSupersedes(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // JSON
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (Array.isArray(obj)) {
        return obj
          .map((e) => ({
            from: e.from ?? e.old ?? e.src ?? "",
            to: e.to ?? e.new ?? e.dst ?? "",
            reason: e.reason ?? e.notes ?? "",
          }))
          .filter((e) => e.from && e.to);
      }
      // allow { supersedes:[...] }
      if (obj && Array.isArray(obj.supersedes)) {
        return obj.supersedes
          .map((e) => ({
            from: e.from ?? e.old ?? e.src ?? "",
            to: e.to ?? e.new ?? e.dst ?? "",
            reason: e.reason ?? e.notes ?? "",
          }))
          .filter((e) => e.from && e.to);
      }
    } catch {
      // fall through to line parsing
    }
  }

  const lines = text.split(/\r?\n/);
  const out = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;

    // arrow forms
    const arrowMatch = line.match(/^(.+?)\s*(->|=>|→)\s*(.+?)\s*(?:#\s*(.*))?$/);
    if (arrowMatch) {
      const from = arrowMatch[1].trim();
      const to = arrowMatch[3].trim();
      const reason = (arrowMatch[4] ?? "").trim();
      if (from && to) out.push({ from, to, reason });
      continue;
    }

    // csv OLD,NEW,(reason...)
    const parts = line.split(",");
    if (parts.length >= 2) {
      const from = parts[0].trim();
      const to = parts[1].trim();
      const reason = parts.slice(2).join(",").trim();
      if (from && to) out.push({ from, to, reason });
      continue;
    }
  }

  return out;
}

function buildTerminalMap(edges, collisions) {
  // adjacency: from -> to (hard rule: at most one to per from)
  const next = new Map();

  for (const e of edges) {
    if (!next.has(e.from)) {
      next.set(e.from, e.to);
    } else if (next.get(e.from) !== e.to) {
      collisions.supersedes_multiple_successors.push({
        from: e.from,
        to_first: next.get(e.from),
        to_second: e.to,
      });
    }
  }

  // cycle detection + terminal resolution
  const terminal = new Map();
  const visiting = new Set();
  const visited = new Set();

  function dfs(u) {
    if (terminal.has(u)) return terminal.get(u);
    if (visiting.has(u)) {
      // cycle
      collisions.supersedes_cycle.push({ at: u });
      return null;
    }
    if (visited.has(u)) return terminal.get(u) ?? null;

    visiting.add(u);

    const v = next.get(u);
    let t = null;

    if (!v) {
      t = u;
    } else {
      t = dfs(v);
    }

    visiting.delete(u);
    visited.add(u);

    terminal.set(u, t);
    return t;
  }

  for (const k of next.keys()) dfs(k);

  // Return both the direct map and terminal map.
  return { next, terminal };
}

function summarizeCollisions(collisions) {
  const categories = {};
  let total = 0;
  for (const [k, v] of Object.entries(collisions)) {
    const n = Array.isArray(v) ? v.length : 0;
    categories[k] = n;
    total += n;
  }
  return { total, categories };
}

function main() {
  const root = process.cwd();
  const stateDir = path.join(root, "state");

  const manifestPath = path.join(stateDir, "CanonManifest.txt");
  const registryPath = path.join(stateDir, "ArtifactRegistry.txt");

  if (!fs.existsSync(manifestPath)) throw new Error(`Missing ${manifestPath}`);
  if (!fs.existsSync(registryPath)) throw new Error(`Missing ${registryPath}`);

  // Tombstones + Supersedes default paths (case-tolerant)
  const tombPath = existsAny([
    path.join(stateDir, "Tombstones.txt"),
    path.join(stateDir, "tombstones.txt"),
    path.join(stateDir, "canon_ops.tombstones.txt"),
  ]);
  const superPath = existsAny([
    path.join(stateDir, "Supersedes.txt"),
    path.join(stateDir, "supersedes.txt"),
    path.join(stateDir, "canon_ops.supersedes.txt"),
  ]);

  const manifest = JSON.parse(readUtf8(manifestPath));
  const artifacts = parseArtifactRegistry(readUtf8(registryPath));

  const tombstones = tombPath ? parseTombstones(readUtf8(tombPath)) : [];
  const supersedes = superPath ? parseSupersedes(readUtf8(superPath)) : [];

  // Build indexes from manifest
  const docs = Array.isArray(manifest.documents) ? manifest.documents : [];
  const byFilename = new Map();
  const byTitle = new Map();
  const byDocId = new Map();

  for (const d of docs) {
    if (d.filename) byFilename.set(d.filename, d);
    if (d.title) byTitle.set(d.title, d);
    if (d.doc_id) byDocId.set(d.doc_id, d);
  }

  // Collisions / hygiene checks
  const collisions = {
    duplicate_artifact_id: [],
    duplicate_source_doc: [],
    source_doc_missing_in_manifest: [],
    invalid_authority_tier: [],
    invalid_kind: [],

    // Tombstones / supersedes robustness
    tombstone_unknown_artifact_id: [],
    supersedes_unknown_from: [],
    supersedes_unknown_to: [],
    supersedes_self_edge: [],
    supersedes_multiple_successors: [],
    supersedes_cycle: [],
    supersedes_to_tombstoned: [],
    tombstoned_has_successor: [],
  };

  const seenId = new Map();
  const seenSource = new Map();

  const allowedTiers = new Set(["supreme", "subordinate", "navigation_only"]);
  const allowedKinds = new Set(["canon"]);

  // Artifact ID set for fast validation
  const artifactIdSet = new Set();

  for (const a of artifacts) {
    if (!a.artifact_id) continue;
    artifactIdSet.add(a.artifact_id);

    // dup artifact_id
    if (seenId.has(a.artifact_id)) {
      collisions.duplicate_artifact_id.push({
        artifact_id: a.artifact_id,
        first: seenId.get(a.artifact_id),
        second: a,
      });
    } else {
      seenId.set(a.artifact_id, a);
    }

    // dup source_doc + manifest membership
    if (a.source_doc) {
      if (seenSource.has(a.source_doc)) {
        collisions.duplicate_source_doc.push({
          source_doc: a.source_doc,
          first: seenSource.get(a.source_doc),
          second: a,
        });
      } else {
        seenSource.set(a.source_doc, a);
      }

      if (!byFilename.has(a.source_doc)) {
        collisions.source_doc_missing_in_manifest.push({
          artifact_id: a.artifact_id,
          source_doc: a.source_doc,
        });
      }
    }

    if (a.authority_tier && !allowedTiers.has(a.authority_tier)) {
      collisions.invalid_authority_tier.push({
        artifact_id: a.artifact_id,
        authority_tier: a.authority_tier,
      });
    }

    if (a.kind && !allowedKinds.has(a.kind)) {
      collisions.invalid_kind.push({
        artifact_id: a.artifact_id,
        kind: a.kind,
      });
    }
  }

  // Validate tombstones
  const tombSet = new Set();
  for (const t of tombstones) {
    if (!t.artifact_id) continue;
    if (!artifactIdSet.has(t.artifact_id)) {
      collisions.tombstone_unknown_artifact_id.push({
        artifact_id: t.artifact_id,
      });
      continue;
    }
    tombSet.add(t.artifact_id);
  }

  // Validate supersedes edges
  const cleanedEdges = [];
  for (const e of supersedes) {
    const from = e.from?.trim();
    const to = e.to?.trim();
    if (!from || !to) continue;

    if (from === to) {
      collisions.supersedes_self_edge.push({ from, to });
      continue;
    }
    if (!artifactIdSet.has(from)) {
      collisions.supersedes_unknown_from.push({ from, to });
      continue;
    }
    if (!artifactIdSet.has(to)) {
      collisions.supersedes_unknown_to.push({ from, to });
      continue;
    }
    cleanedEdges.push({ from, to, reason: e.reason ?? "" });
  }

  // Build terminal map + detect cycles/multi-successors
  const { next: nextMap, terminal: terminalMap } = buildTerminalMap(cleanedEdges, collisions);

  // Cross-check tombstones vs supersedes semantics
  for (const [from, to] of nextMap.entries()) {
    if (tombSet.has(to)) {
      collisions.supersedes_to_tombstoned.push({ from, to });
    }
    if (tombSet.has(from)) {
      collisions.tombstoned_has_successor.push({ from, to });
    }
  }

  // Compute effective successor map:
  // - for any artifact, if it has a terminal successor different than itself, map it.
  // - if terminal is null (cycle), leave it out (but cycles already collide).
  const effective_successor_map = {};
  for (const from of nextMap.keys()) {
    const term = terminalMap.get(from);
    if (!term) continue;
    if (term !== from) effective_successor_map[from] = term;
  }

  // Compute effective status for artifacts (canon only)
  const effective_artifacts = artifacts.map((a) => {
    const id = a.artifact_id;
    const tombstoned = id ? tombSet.has(id) : false;
    const terminal = id ? (terminalMap.get(id) ?? id) : null;
    const superseded_by = id && effective_successor_map[id] ? effective_successor_map[id] : null;

    return {
      ...a,
      tombstoned,
      terminal_successor: terminal,
      superseded_by,
      active: Boolean(id) && !tombstoned && !superseded_by, // active means "not tombstoned and not superseded"
    };
  });

  const { total: collisions_total, categories: collisions_categories } = summarizeCollisions(collisions);

  const canonOps = {
    ok: collisions_total === 0,
    generated_at: new Date().toISOString(),

    artifact_count: artifacts.length,
    tombstones_count: tombstones.length,
    supersedes_count: cleanedEdges.length,
    collisions_total,
    collisions_categories,

    inputs: {
      manifest_path: "state/CanonManifest.txt",
      registry_path: "state/ArtifactRegistry.txt",
      tombstones_path: tombPath ? path.relative(root, tombPath).replace(/\\/g, "/") : null,
      supersedes_path: superPath ? path.relative(root, superPath).replace(/\\/g, "/") : null,

      manifest_generated_at: manifest.generated_at ?? null,
      manifest_document_count: manifest.document_count ?? docs.length,
    },

    // raw artifacts (as parsed)
    artifacts,

    // enriched artifacts (effective status)
    artifacts_effective: effective_artifacts,

    manifest: {
      manifest_version: manifest.manifest_version ?? null,
      document_count: manifest.document_count ?? docs.length,
      sources: manifest.sources ?? null,
    },

    // Canon ops directives
    tombstones,
    supersedes: cleanedEdges,

    // Deterministic resolution maps
    tombstone_set: Array.from(tombSet.values()).sort(),
    supersedes_direct_map: Object.fromEntries(
      Array.from(nextMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    ),
    supersedes_terminal_map: Object.fromEntries(
      Array.from(terminalMap.entries())
        .filter(([k, v]) => v !== null && v !== undefined)
        .sort((a, b) => a[0].localeCompare(b[0]))
    ),
    effective_successor_map,

    // Collisions
    collisions,
  };

  const outCanonOps = path.join(stateDir, "canon_ops.json");
  const outCollisions = path.join(stateDir, "canon_ops.collisions.json");

  // collisions sidecar includes metadata too (helps VAL + debugging)
  const collisionsSidecar = {
    ok: collisions_total === 0,
    generated_at: canonOps.generated_at,
    collisions_total,
    collisions_categories,
    collisions,
  };

  writeJson(outCanonOps, canonOps);
  writeJson(outCollisions, collisionsSidecar);

  if (collisions_total > 0) {
    console.error(`CANON OPS FAIL: collisions=${collisions_total}`);
    console.error(`wrote: state/canon_ops.json`);
    console.error(`wrote: state/canon_ops.collisions.json`);
    process.exit(2);
  }

  console.log("CANON OPS PASS");
  console.log(`wrote: state/canon_ops.json`);
  console.log(`wrote: state/canon_ops.collisions.json`);
}

main();

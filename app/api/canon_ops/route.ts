// app/api/canon_ops/route.ts
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

const REQUIRED_CATEGORIES = [
  "duplicate_artifact_id",
  "duplicate_source_doc",
  "source_doc_missing_in_manifest",
  "invalid_authority_tier",
  "invalid_kind",
  "tombstone_unknown_artifact_id",
  "supersedes_unknown_from",
  "supersedes_unknown_to",
  "supersedes_self_edge",
  "supersedes_multiple_successors",
  "supersedes_cycle",
  "supersedes_to_tombstoned",
  "tombstoned_has_successor",
] as const;

function readJson(absPath: string) {
  if (!fs.existsSync(absPath)) return null;
  let raw = fs.readFileSync(absPath, "utf8");
  raw = raw.replace(/^\uFEFF/, ""); // strip UTF-8 BOM if present
  return JSON.parse(raw);
}

function computeCategories(colObj: any): Record<string, number> {
  // Preferred: explicit counts
  if (colObj?.collisions_categories && typeof colObj.collisions_categories === "object") {
    const out: Record<string, number> = {};
    for (const k of REQUIRED_CATEGORIES) out[k] = Number(colObj.collisions_categories?.[k] ?? 0);
    return out;
  }

  // Next: arrays under colObj.collisions
  if (colObj?.collisions && typeof colObj.collisions === "object") {
    const out: Record<string, number> = {};
    for (const k of REQUIRED_CATEGORIES) {
      const v = colObj.collisions?.[k];
      out[k] = Array.isArray(v) ? v.length : 0;
    }
    return out;
  }

  // Fallback: top-level arrays (older format)
  const out: Record<string, number> = {};
  for (const k of REQUIRED_CATEGORIES) {
    const v = colObj?.[k];
    out[k] = Array.isArray(v) ? v.length : 0;
  }
  return out;
}

export async function GET() {
  try {
    const stateDir = path.join(process.cwd(), "state");
    const opsPath = path.join(stateDir, "canon_ops.json");
    const colPath = path.join(stateDir, "canon_ops.collisions.json");

    const ops = readJson(opsPath);
    if (!ops) {
      return NextResponse.json({ error: "missing: state/canon_ops.json" }, { status: 404 });
    }

    const col = readJson(colPath);
    if (!col) {
      return NextResponse.json({ error: "missing: state/canon_ops.collisions.json" }, { status: 404 });
    }

    const collisions_categories = computeCategories(col);

    const collisions_total = Object.values(collisions_categories).reduce((n, x) => n + (Number(x) || 0), 0);

    // Return a stable shape that VAL-22 can validate
    return NextResponse.json(
      {
        ok: true,
        generated_at: ops.generated_at ?? ops?.ops?.generated_at ?? new Date().toISOString(),
        artifact_count: ops.artifact_count ?? ops?.ops?.artifact_count ?? null,
        tombstones_count: ops.tombstones_count ?? ops?.ops?.tombstones_count ?? 0,
        supersedes_count: ops.supersedes_count ?? ops?.ops?.supersedes_count ?? 0,
        collisions_total,
        collisions_categories,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: "canon_ops read failed", detail: String(err?.message ?? err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

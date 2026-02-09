// app/api/canon_ops/collisions/route.ts
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

function readJson(absPath: string) {
  if (!fs.existsSync(absPath)) return null;
  let raw = fs.readFileSync(absPath, "utf8");
  raw = raw.replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

export async function GET() {
  try {
    const stateDir = path.join(process.cwd(), "state");
    const colPath = path.join(stateDir, "canon_ops.collisions.json");

    const col = readJson(colPath);
    if (!col) {
      return NextResponse.json({ error: "missing: state/canon_ops.collisions.json" }, { status: 404 });
    }

    return NextResponse.json(col, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    return NextResponse.json(
      { error: "canon_ops collisions read failed", detail: String(err?.message ?? err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

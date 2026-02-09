export const runtime = "nodejs";

import fs from "fs";
import path from "path";
import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

type ListOk = {
  ok: true;
  root: string;
  path: string;
  abs_path: string;
  entries: Array<{
    name: string;
    type: "file" | "dir" | "other";
    size?: number;
  }>;
};

type ListErr = {
  ok: false;
  error: string;
  status: number;
  message?: string;
  details?: any;
};

function json(body: any, status = 200) {
  return NextResponse.json(body, { status });
}

function safeEq(a: string, b: string) {
  try {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function getBearerToken(req: Request) {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function requireAdmin(req: Request): ListErr | null {
  const expected = (process.env.MEKA_ADMIN_TOKEN || "").trim();
  if (!expected) {
    return { ok: false, error: "admin_token_missing", status: 500, message: "MEKA_ADMIN_TOKEN is not set on server." };
  }
  const got = getBearerToken(req);
  if (!got || !safeEq(got, expected)) {
    return { ok: false, error: "admin_token_invalid", status: 401 };
  }
  return null;
}

function isSafeRelPath(p: string) {
  if (!p) return false;
  if (p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(p)) return false;
  if (p.includes("..")) return false;
  return true;
}

// Repo roots (directory list is read-only)
const ROOTS: Record<string, string> = {
  repo: ".",
  components: "components",
  app: "app",
  lib: "lib",
  config: "config",
  stores: "stores",
  state: "state",
  public: "public",
};

async function handleList(request: Request, input: { root?: string; path?: string; dir?: string }) {
  const authErr = requireAdmin(request);
  if (authErr) return json(authErr, authErr.status);

  const root = String((input.root ?? "")).trim();

  // Accept either "path" or "dir" as the directory argument; default to "."
  const relRaw = String((input.path ?? input.dir ?? "")).trim();
  const rel = relRaw === "" ? "." : relRaw;

  if (!root || !ROOTS[root]) {
    return json(
      { ok: false, error: "invalid_root", status: 400, details: { root, allowed_roots: Object.keys(ROOTS) } } satisfies ListErr,
      400
    );
  }

  // Special-case "." as allowed; otherwise enforce safety rules
  if (rel !== "." && !isSafeRelPath(rel)) {
    return json({ ok: false, error: "invalid_path", status: 400, details: { path: rel } } satisfies ListErr, 400);
  }

  const base = path.resolve(process.cwd(), ROOTS[root]);
  const abs = path.resolve(base, rel);

  // must stay inside base
  if (!abs.startsWith(base + path.sep) && abs !== base) {
    return json({ ok: false, error: "path_escape_blocked", status: 400, details: { root, path: rel } } satisfies ListErr, 400);
  }

  if (!fs.existsSync(abs)) {
    return json({ ok: false, error: "not_found", status: 404, details: { root, path: rel } } satisfies ListErr, 404);
  }

  const st = fs.statSync(abs);
  if (!st.isDirectory()) {
    return json({ ok: false, error: "not_a_directory", status: 400, details: { root, path: rel } } satisfies ListErr, 400);
  }

  const dirents = fs.readdirSync(abs, { withFileTypes: true });

  const entries: ListOk["entries"] = dirents
    .map((d) => {
      const type: "file" | "dir" | "other" = d.isDirectory() ? "dir" : d.isFile() ? "file" : "other";
      const out: any = { name: d.name, type };
      if (type === "file") {
        try {
          const pst = fs.statSync(path.join(abs, d.name));
          out.size = pst.size;
        } catch {}
      }
      return out as { name: string; type: "file" | "dir" | "other"; size?: number };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const out: ListOk = {
    ok: true,
    root,
    path: rel,
    abs_path: abs,
    entries,
  };

  return json(out, 200);
}

export async function GET(request: Request) {
  const u = new URL(request.url);
  const root = (u.searchParams.get("root") || "").trim();
  const relRaw = (u.searchParams.get("path") ?? u.searchParams.get("dir") ?? "").trim();
  return handleList(request, { root, path: relRaw });
}

export async function POST(request: Request) {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  // Accept {root, path} or {root, dir}
  return handleList(request, {
    root: body?.root,
    path: body?.path,
    dir: body?.dir,
  });
}

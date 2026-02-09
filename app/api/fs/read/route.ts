export const runtime = "nodejs";

import { createHash, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";

type ReadOk = {
  ok: true;
  root: string;
  path: string;
  abs_path: string;
  hash: string; // sha256:<hex>
  eol: "CRLF" | "LF" | "MIXED" | "NONE";
  bytes: number;
  text: string;
};

type ReadErr = {
  ok: false;
  error: string;
  status: number;
  details?: any;
};

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getBearerToken(req: Request): string {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)\s*$/i);
  return (m?.[1] || "").trim();
}

function safeEq(a: string, b: string) {
  const aa = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

function requireAdmin(req: Request): ReadErr | null {
  const expected = (process.env.MEKA_ADMIN_TOKEN || "").trim();
  if (!expected) {
    return { ok: false, error: "admin_token_not_configured", status: 500 };
  }
  const got = getBearerToken(req);
  if (!got || !safeEq(got, expected)) {
    return { ok: false, error: "admin_token_invalid", status: 401 };
  }
  return null;
}

function detectEol(s: string): "CRLF" | "LF" | "MIXED" | "NONE" {
  if (!s) return "NONE";
  const hasCRLF = s.includes("\r\n");
  const hasLF = s.includes("\n");
  if (!hasLF) return "NONE";
  if (hasCRLF) {
    const after = s.split("\r\n").join("");
    return after.includes("\n") ? "MIXED" : "CRLF";
  }
  return "LF";
}

function sha256Hex(s: string) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function isSafeRelPath(p: string) {
  if (!p) return false;
  if (p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(p)) return false;
  if (p.includes("..")) return false;
  return true;
}

const ROOTS: Record<string, string> = {
  repo: ".", // repo root (process.cwd())
  components: "components",
  app: "app",
  lib: "lib",
  config: "config",
  stores: "stores",
  state: "state",
  public: "public",
};

const ALLOWED_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".css",
  ".scss",
  ".html",
]);

async function handleRead(request: Request, input: { root?: string; path?: string }) {
  const authErr = requireAdmin(request);
  if (authErr) return json(authErr, authErr.status);

  const root = String((input.root ?? "")).trim();
  const rel = String((input.path ?? "")).trim();

  if (!root || !ROOTS[root]) {
    return json(
      {
        ok: false,
        error: "invalid_root",
        status: 400,
        details: {
          root,
          allowed_roots: Object.keys(ROOTS),
        },
      } satisfies ReadErr,
      400
    );
  }

  if (!isSafeRelPath(rel)) {
    return json(
      {
        ok: false,
        error: "invalid_path",
        status: 400,
        details: { path: rel },
      } satisfies ReadErr,
      400
    );
  }

  const ext = path.extname(rel).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return json(
      {
        ok: false,
        error: "disallowed_extension",
        status: 400,
        details: { path: rel, ext, allowed_ext: Array.from(ALLOWED_EXT) },
      } satisfies ReadErr,
      400
    );
  }

  const base = path.resolve(process.cwd(), ROOTS[root]);
  const abs = path.resolve(base, rel);

  if (!abs.startsWith(base + path.sep) && abs !== base) {
    return json(
      {
        ok: false,
        error: "path_escape_blocked",
        status: 400,
        details: { root, path: rel },
      } satisfies ReadErr,
      400
    );
  }

  if (!fs.existsSync(abs)) {
    return json(
      {
        ok: false,
        error: "not_found",
        status: 404,
        details: { root, path: rel },
      } satisfies ReadErr,
      404
    );
  }

  const st = fs.statSync(abs);
  if (!st.isFile()) {
    return json(
      {
        ok: false,
        error: "not_a_file",
        status: 400,
        details: { root, path: rel },
      } satisfies ReadErr,
      400
    );
  }

  const text = fs.readFileSync(abs, "utf8");
  const out: ReadOk = {
    ok: true,
    root,
    path: rel,
    abs_path: abs,
    hash: `sha256:${sha256Hex(text)}`,
    eol: detectEol(text),
    bytes: Buffer.byteLength(text, "utf8"),
    text,
  };

  return json(out, 200);
}

export async function GET(request: Request) {
  const u = new URL(request.url);
  const root = (u.searchParams.get("root") || "").trim();
  const rel = (u.searchParams.get("path") || "").trim();
  return handleRead(request, { root, path: rel });
}

export async function POST(request: Request) {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  return handleRead(request, { root: body?.root, path: body?.path });
}

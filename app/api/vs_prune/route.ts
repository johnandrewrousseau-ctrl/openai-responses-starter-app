export const runtime = "nodejs";

import OpenAI from "openai";
import { timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";

type Body = {
  store?: "threads" | "canon";
};

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
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

function requireAdmin(req: Request): Response | null {
  const expected = (process.env.MEKA_ADMIN_TOKEN || "").trim();
  if (!expected) return json({ ok: false, error: "admin_token_not_configured", status: 500 }, 500);

  const got = getBearerToken(req);
  if (!got || !safeEq(got, expected)) {
    return json({ ok: false, error: "admin_token_invalid", status: 401 }, 401);
  }
  return null;
}

function getOpenAI() {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing/empty in the server environment.");
  return new OpenAI({ apiKey });
}

function pickVectorStoreId(store: "threads" | "canon"): string {
  if (store === "canon") return (process.env.MEKA_VECTOR_STORE_ID_CANON || "").trim();
  return (process.env.MEKA_VECTOR_STORE_ID_THREADS || "").trim();
}

function pickSourceDir(store: "threads" | "canon"): string {
  if (store === "canon") {
    return (process.env.MEKA_CANON_TXT_DIR || "").trim() || "C:\\meka\\MEKA_CANON_TXT";
  }
  return (process.env.MEKA_THREADS_TXT_DIR || "").trim() || "C:\\meka\\MEKA_THREADS_TXT";
}

function readState(statePath: string): any {
  try {
    if (!fs.existsSync(statePath)) return { version: 1, files: {} };
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { version: 1, files: {} };
    if (!parsed.files || typeof parsed.files !== "object") parsed.files = {};
    return parsed;
  } catch {
    return { version: 1, files: {} };
  }
}

function startsWithPathInsensitive(fullPath: string, root: string): boolean {
  const a = String(fullPath || "").toLowerCase();
  const b = String(root || "").toLowerCase();
  return a.startsWith(b);
}

type FileItem = {
  file_id: string;
  filename: string;
  created_at: number;
};

export async function POST(request: Request) {
  const auth = requireAdmin(request);
  if (auth) return auth;

  let body: Body = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const store = body.store === "canon" ? "canon" : "threads";
  const vectorStoreId = pickVectorStoreId(store);
  if (!vectorStoreId) {
    return json({ ok: false, error: "missing_vector_store_id", store }, 400);
  }

  const sourceDir = pickSourceDir(store);
  if (!sourceDir) {
    return json({ ok: false, error: "source_dir_missing", source_dir: sourceDir }, 400);
  }

  const statePath = path.join(process.cwd(), "state", "vs_ingest_state.json");
  const state = readState(statePath);

  const keepIds = new Set<string>();
  const entries = state?.files && typeof state.files === "object" ? state.files : {};
  for (const p of Object.keys(entries)) {
    if (!startsWithPathInsensitive(p, sourceDir)) continue;
    const fileId = String(entries[p]?.file_id || "").trim();
    if (fileId) keepIds.add(fileId);
  }

  const openai = getOpenAI();
  const allFiles: FileItem[] = [];

  let after: string | undefined = undefined;
  let hasMore = false;

  do {
    const res = await openai.vectorStores.files.list(vectorStoreId, {
      limit: 100,
      ...(after ? { after } : {}),
    } as any);
    const data = Array.isArray((res as any)?.data) ? (res as any).data : [];
    hasMore = Boolean((res as any)?.has_more);

    for (const f of data) {
      const fileId = String(f?.id || "").trim();
      if (!fileId) continue;
      let filename = typeof f?.filename === "string" ? f.filename : "";
      const createdAt = typeof f?.created_at === "number" ? f.created_at : 0;
      if (!filename) {
        try {
          const meta = await openai.files.retrieve(fileId);
          if (meta && typeof (meta as any).filename === "string") {
            filename = (meta as any).filename;
          }
        } catch {
          // best-effort only
        }
      }
      allFiles.push({
        file_id: fileId,
        filename: filename || "",
        created_at: createdAt,
      });
    }

    const last = data[data.length - 1];
    after = last?.id ? String(last.id) : undefined;
    if (!after) hasMore = false;
  } while (hasMore);

  const byName = new Map<string, FileItem[]>();
  for (const f of allFiles) {
    const key = f.filename || "";
    const list = byName.get(key) || [];
    list.push(f);
    byName.set(key, list);
  }

  let groupsWithDupes = 0;
  let detached = 0;
  const failures: Array<{ file_id: string; error: string }> = [];

  for (const [name, group] of byName.entries()) {
    if (!name) continue;
    if (group.length <= 1) continue;
    groupsWithDupes++;

    let keep: FileItem | null = null;
    const keepCandidates = group.filter((g) => keepIds.has(g.file_id));
    if (keepCandidates.length > 0) {
      keep = keepCandidates.sort((a, b) => b.created_at - a.created_at)[0];
    } else {
      keep = group.sort((a, b) => b.created_at - a.created_at)[0];
    }

    for (const f of group) {
      if (keep && f.file_id === keep.file_id) continue;
      try {
        await openai.vectorStores.files.del(vectorStoreId, f.file_id);
        detached++;
      } catch (e: any) {
        failures.push({ file_id: f.file_id, error: String(e?.message ?? e) });
      }
    }
  }

  return json(
    {
      ok: true,
      store,
      vector_store_id: vectorStoreId,
      source_dir: sourceDir,
      groups_with_dupes: groupsWithDupes,
      detached,
      failures,
    },
    200
  );
}

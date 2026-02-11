export const runtime = "nodejs";

import OpenAI from "openai";
import { timingSafeEqual, createHash } from "crypto";
import fs from "fs";
import path from "path";

type Body = {
  store?: "threads" | "canon";
  max_files?: number;
  replace?: boolean;
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

function allowedExt(p: string): boolean {
  const ext = path.extname(p || "").toLowerCase();
  return [".txt", ".md", ".pdf", ".json", ".docx"].includes(ext);
}

function sha256File(fullPath: string): string {
  const h = createHash("sha256");
  const buf = fs.readFileSync(fullPath);
  h.update(buf);
  return h.digest("hex");
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

function writeState(statePath: string, state: any) {
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
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
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    return json({ ok: false, error: "source_dir_missing", source_dir: sourceDir }, 400);
  }

  const maxFiles =
    typeof body.max_files === "number" && Number.isFinite(body.max_files) && body.max_files > 0
      ? Math.floor(body.max_files)
      : 10000;
  const replace =
    typeof body.replace === "boolean" ? body.replace : store === "canon";

  const statePath = path.join(process.cwd(), "state", "vs_ingest_state.json");
  const state = readState(statePath);

  const files = fs
    .readdirSync(sourceDir)
    .map((n) => path.join(sourceDir, n))
    .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile() && allowedExt(p))
    .slice(0, maxFiles);

  const openai = getOpenAI();

  let scanned = 0;
  let uploaded = 0;
  let attached = 0;
  let skipped = 0;
  let replaced = 0;
  const failures: Array<{ file: string; error: string }> = [];

  for (const fullPath of files) {
    scanned++;
    try {
      const st = fs.statSync(fullPath);
      if (!st || st.size === 0) {
        skipped++;
        continue;
      }
      const sha = sha256File(fullPath);
      const prev = state.files?.[fullPath] || {};
      if (prev && prev.sha256 === sha) {
        skipped++;
        continue;
      }

      const buf = fs.readFileSync(fullPath);
      const blob = new Blob([buf], { type: "application/octet-stream" });
      const fileName = path.basename(fullPath);

      const uploadedFile = await openai.files.create({
        file: new File([blob], fileName),
        purpose: "assistants",
      } as any);
      uploaded++;

      const newFileId = String((uploadedFile as any)?.id || "").trim();
      if (!newFileId) {
        throw new Error("upload_missing_file_id");
      }

      await openai.vectorStores.files.create(vectorStoreId, { file_id: newFileId } as any);
      attached++;

      if (replace && prev?.file_id && prev.file_id !== newFileId) {
        try {
          await openai.vectorStores.files.del(vectorStoreId, prev.file_id);
          replaced++;
        } catch (e: any) {
          failures.push({
            file: fullPath,
            error: "detach_failed: " + String(e?.message ?? e),
          });
        }
      }

      state.files[fullPath] = { sha256: sha, file_id: newFileId };
    } catch (e: any) {
      failures.push({ file: fullPath, error: String(e?.message ?? e) });
    }
  }

  writeState(statePath, state);

  return json(
    {
      ok: true,
      store,
      vector_store_id: vectorStoreId,
      source_dir: sourceDir,
      scanned,
      uploaded,
      attached,
      skipped,
      replaced,
      failures,
    },
    200
  );
}

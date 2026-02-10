export const runtime = "nodejs";

import OpenAI from "openai";

/// ADMIN_GATE_V1
import { timingSafeEqual } from "crypto";

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

const openai = new OpenAI();

function safeTruncate(s: string, max = 200) {
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function auditStore(kind: "canon" | "threads", vectorStoreId: string, query: string, limit: number) {
  const filesRes = await openai.vectorStores.files.list(vectorStoreId);
  const filesArr = Array.isArray((filesRes as any)?.data) ? (filesRes as any).data : [];
  const files = filesArr.map((f: any) => ({
    file_id: f?.id ?? null,
    filename: f?.filename ?? f?.name ?? null,
  }));

  const searchRes = await openai.vectorStores.search(vectorStoreId, {
    query,
    max_num_results: limit,
  });
  const searchArr = Array.isArray((searchRes as any)?.data) ? (searchRes as any).data : [];
  const results = searchArr.map((r: any) => ({
    file_id: r?.file_id ?? r?.file?.id ?? null,
    score: typeof r?.score === "number" ? r.score : null,
    chunk: typeof r?.content?.[0]?.text === "string" ? safeTruncate(r.content[0].text, 300) : null,
  }));

  return {
    kind,
    vector_store_id: vectorStoreId,
    files_total: filesArr.length,
    files,
    search_probe: {
      query,
      results,
    },
  };
}

export async function GET(request: Request) {
  const auth = requireAdmin(request);
  if (auth) return auth;

  const { searchParams } = new URL(request.url);
  const storeRaw = (searchParams.get("store") || "all").toLowerCase();
  const q = (searchParams.get("q") || "drift countermeasure").trim();
  const limitRaw = Number(searchParams.get("limit") || "5");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 5;

  const wantCanon = storeRaw === "canon" || storeRaw === "all";
  const wantThreads = storeRaw === "threads" || storeRaw === "all";

  const canonId = (process.env.MEKA_VECTOR_STORE_ID_CANON || "").trim();
  const threadsId = (process.env.MEKA_VECTOR_STORE_ID_THREADS || "").trim();

  if (wantCanon && !canonId) {
    return json(
      { ok: false, error: "canon_vector_store_missing", detail: "MEKA_VECTOR_STORE_ID_CANON is not set." },
      400
    );
  }
  if (wantThreads && !threadsId) {
    return json(
      { ok: false, error: "threads_vector_store_missing", detail: "MEKA_VECTOR_STORE_ID_THREADS is not set." },
      400
    );
  }

  try {
    const out: any = { ok: true, query: q, limit };
    if (wantCanon && canonId) out.canon = await auditStore("canon", canonId, q, limit);
    if (wantThreads && threadsId) out.threads = await auditStore("threads", threadsId, q, limit);
    return json(out, 200);
  } catch (err: any) {
    return json(
      { ok: false, error: "vs_audit_failed", detail: String(err?.message ?? err) },
      500
    );
  }
}

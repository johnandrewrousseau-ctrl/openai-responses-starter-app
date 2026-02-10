export const runtime = "nodejs";

import OpenAI from "openai";

/// ADMIN_GATE_V1
import { createHash, timingSafeEqual } from "crypto";

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

async function auditStore(
  kind: "canon" | "threads",
  vectorStoreId: string,
  queries: string[],
  limit: number,
  maxFiles: number,
  includeFilenames: boolean
) {
  const files: Array<{
    file_id: string | null;
    filename: string | null;
    status: string | null;
    created_at: number | null;
    last_error: string | null;
  }> = [];
  const fileIds: string[] = [];
  const statusCounts: Record<string, number> = {};
  const failedFilesSample: string[] = [];
  let pagesFetched = 0;
  let hasMoreFinal = false;
  let truncated = false;
  let after: string | undefined = undefined;
  const pageLimitDefault = 100;

  while (files.length < maxFiles) {
    const pageLimit = Math.min(pageLimitDefault, Math.max(1, maxFiles - files.length));
    const filesRes = await openai.vectorStores.files.list(vectorStoreId, {
      limit: pageLimit,
      ...(after ? { after } : {}),
    });
    pagesFetched++;

    const filesArr = Array.isArray((filesRes as any)?.data) ? (filesRes as any).data : [];
    for (const f of filesArr) {
      const fileId = f?.id ?? null;
      const filename = f?.filename ?? f?.name ?? null;
      const status = typeof f?.status === "string" ? f.status : null;
      const createdAt = typeof f?.created_at === "number" ? f.created_at : null;
      const lastError = typeof f?.last_error === "string" ? safeTruncate(f.last_error, 200) : null;
      files.push({ file_id: fileId, filename, status, created_at: createdAt, last_error: lastError });
      if (fileId) fileIds.push(String(fileId));
      if (status) statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      if (status === "failed" && fileId && failedFilesSample.length < 5) {
        failedFilesSample.push(String(fileId));
      }
    }

    hasMoreFinal = Boolean((filesRes as any)?.has_more);
    if (!hasMoreFinal || filesArr.length === 0) break;

    const last = filesArr[filesArr.length - 1];
    after = last?.id ? String(last.id) : undefined;
    if (!after) break;
  }
  if (files.length >= maxFiles && hasMoreFinal) truncated = true;

  if (includeFilenames) {
    const cap = Math.min(200, files.length);
    for (let i = 0; i < cap; i++) {
      const f = files[i];
      if (!f || !f.file_id) continue;
      if (f.filename && f.filename.trim()) continue;
      try {
        const fileObj = await openai.files.retrieve(f.file_id);
        const name = (fileObj as any)?.filename ?? (fileObj as any)?.name ?? null;
        if (name) files[i] = { ...f, filename: String(name) };
      } catch {
        // best-effort only
      }
    }
  }

  const sortedFileIds = [...fileIds].filter((x) => x).sort();
  const snapshotSha256 = createHash("sha256").update(sortedFileIds.join("\n")).digest("hex");

  const probeRuns = [];
  for (const q of queries) {
    const searchRes = await openai.vectorStores.search(vectorStoreId, {
      query: q,
      max_num_results: limit,
    });
    const searchArr = Array.isArray((searchRes as any)?.data) ? (searchRes as any).data : [];
    const results = searchArr.map((r: any) => ({
      file_id: r?.file_id ?? r?.file?.id ?? null,
      score: typeof r?.score === "number" ? r.score : null,
      chunk: typeof r?.content?.[0]?.text === "string" ? safeTruncate(r.content[0].text, 300) : null,
    }));
    const topFileIds = results.map((r) => r.file_id).filter((x) => x);
    probeRuns.push({ query: q, top_file_ids: topFileIds, results });
  }

  return {
    kind,
    vector_store_id: vectorStoreId,
    files_total: files.length,
    pages_fetched: pagesFetched,
    has_more_final: hasMoreFinal,
    truncated,
    file_ids: sortedFileIds,
    snapshot_sha256: snapshotSha256,
    status_counts: statusCounts,
    failed_files_sample: failedFilesSample,
    files,
    search_probe: probeRuns,
  };
}

export async function GET(request: Request) {
  const auth = requireAdmin(request);
  if (auth) return auth;

  const { searchParams } = new URL(request.url);
  const storeRaw = (searchParams.get("store") || "all").toLowerCase();
  const q = (searchParams.get("q") || "drift countermeasure").trim();
  const q2 = (searchParams.get("q2") || "governance").trim();
  const q3 = (searchParams.get("q3") || "vector store").trim();
  const limitRaw = Number(searchParams.get("limit") || "5");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 5;
  const maxFilesRaw = Number(searchParams.get("max_files") || "5000");
  const maxFiles = Number.isFinite(maxFilesRaw) && maxFilesRaw > 0 ? Math.floor(maxFilesRaw) : 5000;
  const includeFilenames =
    String(searchParams.get("include_filenames") || "0").trim() === "1";
  const queries = [q, q2, q3].filter((x) => x);

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
    const out: any = {
      ok: true,
      queries,
      limit,
      max_files: maxFiles,
      include_filenames: includeFilenames,
    };
    if (wantCanon && canonId) {
      out.canon = await auditStore("canon", canonId, queries, limit, maxFiles, includeFilenames);
    }
    if (wantThreads && threadsId) {
      out.threads = await auditStore("threads", threadsId, queries, limit, maxFiles, includeFilenames);
    }
    return json(out, 200);
  } catch (err: any) {
    return json(
      { ok: false, error: "vs_audit_failed", detail: String(err?.message ?? err) },
      500
    );
  }
}

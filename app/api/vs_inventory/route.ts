export const runtime = "nodejs";

import OpenAI from "openai";

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function getOpenAI() {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing/empty in the server environment.");
  return new OpenAI({ apiKey });
}

async function listAllFiles(
  openai: OpenAI,
  vectorStoreId: string,
  includeFilenames: boolean
) {
  const files: Array<{
    file_id: string;
    filename?: string;
    status?: string;
    created_at?: number;
  }> = [];

  let after: string | undefined = undefined;
  let pagesFetched = 0;
  let hasMoreFinal = false;

  while (true) {
    const res = await openai.vectorStores.files.list(vectorStoreId, {
      limit: 100,
      ...(after ? { after } : {}),
    } as any);
    pagesFetched++;

    const arr = Array.isArray((res as any)?.data) ? (res as any).data : [];
    for (const f of arr) {
      const id = String(f?.id ?? "").trim();
      if (!id) continue;
      files.push({
        file_id: id,
        filename: typeof f?.filename === "string" ? f.filename : undefined,
        status: typeof f?.status === "string" ? f.status : undefined,
        created_at: typeof f?.created_at === "number" ? f.created_at : undefined,
      });
    }

    hasMoreFinal = Boolean((res as any)?.has_more);
    const last = arr[arr.length - 1];
    after = last?.id ? String(last.id) : undefined;
    if (!hasMoreFinal || !after) break;
  }

  if (includeFilenames) {
    for (const f of files) {
      if (f.filename) continue;
      try {
        const meta = await openai.files.retrieve(f.file_id);
        if (meta && typeof (meta as any).filename === "string") {
          f.filename = (meta as any).filename;
        }
      } catch {
        // best-effort only
      }
    }
  }

  files.sort((a, b) => {
    const fa = String(a.filename ?? "").toLowerCase();
    const fb = String(b.filename ?? "").toLowerCase();
    if (fa < fb) return -1;
    if (fa > fb) return 1;
    return String(a.file_id).localeCompare(String(b.file_id));
  });

  return {
    vector_store_id: vectorStoreId,
    files_total: files.length,
    pages_fetched: pagesFetched,
    has_more_final: hasMoreFinal,
    files,
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const storeRaw = (url.searchParams.get("store") || "all").trim().toLowerCase();
    const includeFilenames =
      String(url.searchParams.get("include_filenames") || "1").trim() === "1";

    const canonStoreId = (process.env.MEKA_VECTOR_STORE_ID_CANON || "").trim();
    const threadsStoreId = (process.env.MEKA_VECTOR_STORE_ID_THREADS || "").trim();

    const wantCanon = storeRaw === "canon" || storeRaw === "all";
    const wantThreads = storeRaw === "threads" || storeRaw === "all";

    if (wantCanon && !canonStoreId) {
      return json(
        { ok: false, error: "missing_canon_vector_store_id" },
        400
      );
    }
    if (wantThreads && !threadsStoreId) {
      return json(
        { ok: false, error: "missing_threads_vector_store_id" },
        400
      );
    }

    const openai = getOpenAI();
    const out: any = { ok: true };

    if (wantCanon && canonStoreId) {
      out.canon = await listAllFiles(openai, canonStoreId, includeFilenames);
    }
    if (wantThreads && threadsStoreId) {
      out.threads = await listAllFiles(openai, threadsStoreId, includeFilenames);
    }

    return json(out, 200);
  } catch (err: any) {
    return json({ ok: false, error: "vs_inventory_failed", detail: String(err?.message ?? err) }, 500);
  }
}

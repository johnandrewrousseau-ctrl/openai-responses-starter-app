// config/functions.ts
// MEKA Functions mapping to tool calls (client + server safe).
//
// Key invariants:
// - Tool names in toolsList MUST exist in functionsMap.
// - Function tool names emitted to the model are SANITIZED (dots => underscores).
// - FS read/list are GET routes (query params).
// - FS prepare/patch/replace are POST routes (JSON body).
// - Server-side calls attach MEKA_ADMIN_TOKEN; browser calls do NOT.

type JsonValue = any;

function sanitizeToolName(name: any): string {
  const raw = String(name ?? "").trim();
  if (!raw) return "unnamed_tool";
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unnamed_tool";
}

function getOrigin(): string {
  // Browser: same-origin calls
  if (typeof window !== "undefined" && (window as any).location?.origin) {
    return (window as any).location.origin;
  }

  // Server (Node): absolute origin
  const envOrigin =
    (process.env.MEKA_ORIGIN || "").trim() ||
    (process.env.NEXT_PUBLIC_MEKA_ORIGIN || "").trim() ||
    (process.env.NEXT_PUBLIC_BASE_URL || "").trim();

  if (envOrigin) return envOrigin.replace(/\/+$/, "");

  const port = String(process.env.PORT || "3000").trim();
  return `http://localhost:${port}`;
}

function getAdminAuthHeader(): Record<string, string> {
  // Only on server. In the browser we do NOT attach admin.
  if (typeof window !== "undefined") return {};
  const token = String(process.env.MEKA_ADMIN_TOKEN || "").trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function fetchJson(url: string, init?: RequestInit): Promise<JsonValue> {
  const res = await fetch(url, init);
  const txt = await res.text();

  let j: any = null;
  try {
    j = txt ? JSON.parse(txt) : null;
  } catch {
    j = { ok: false, error: "invalid_json", _status: res.status, raw: txt };
  }

  // Always attach HTTP status to objects for debugging consistency.
  if (j && typeof j === "object" && !Array.isArray(j) && (j as any)._status === undefined) {
    (j as any)._status = res.status;
  }

  // Preserve non-2xx as structured payload (never throw).
  if (!res.ok) {
    if (j && typeof j === "object") return j;
    return { ok: false, error: "http_error", _status: res.status, raw: txt };
  }

  return j;
}

function makeUrl(path: string): string {
  const origin = getOrigin();
  return `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function getJson(path: string): Promise<JsonValue> {
  const url = makeUrl(path);
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    ...getAdminAuthHeader(),
  };
  return fetchJson(url, { method: "GET", headers, cache: "no-store" as any });
}

async function postJson(path: string, bodyObj: any): Promise<JsonValue> {
  const url = makeUrl(path);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...getAdminAuthHeader(),
  };
  return fetchJson(url, { method: "POST", headers, body: JSON.stringify(bodyObj ?? {}), cache: "no-store" as any });
}

// -------------------- FS tools (match actual routes) --------------------

/** fs_read: GET /api/fs/read?root=...&path=... */
export const fs_read = async ({ root, path }: { root: string; path: string }) => {
  const r = encodeURIComponent(String(root ?? "repo"));
  const p = encodeURIComponent(String(path ?? ""));
  return await getJson(`/api/fs/read?root=${r}&path=${p}`);
};

/** fs_list: GET /api/fs/list?root=...&path=...&dir=... (server expects these query params) */
export const fs_list = async ({ root, path }: { root: string; path: string }) => {
  const r = encodeURIComponent(String(root ?? "repo"));
  const p = encodeURIComponent(String(path ?? "."));
  // keep dir aligned with path (your server routes previously used this convention)
  return await getJson(`/api/fs/list?root=${r}&path=${p}&dir=${p}`);
};

/** fs_prepare: POST /api/fs/prepare { root, path, mode, find, replace } */
export const fs_prepare = async ({
  root,
  path,
  mode,
  find,
  replace,
}: {
  root: string;
  path: string;
  mode: "single" | "first" | "all" | string;
  find: string;
  replace: string;
}) => {
  return await postJson("/api/fs/prepare", { root, path, mode, find, replace });
};

/** fs_patch: POST /api/fs/patch { root, path, patch_unified, expected_hash, approval_id, dry_run } */
export const fs_patch = async ({
  root,
  path,
  patch_unified,
  expected_hash,
  approval_id,
  dry_run,
}: {
  root: string;
  path: string;
  patch_unified: string;
  expected_hash: string;
  approval_id: string;
  dry_run: boolean;
}) => {
  return await postJson("/api/fs/patch", { root, path, patch_unified, expected_hash, approval_id, dry_run });
};

/** fs_replace: POST /api/fs/replace { root, path, mode, find, replace } */
export const fs_replace = async ({
  root,
  path,
  mode,
  find,
  replace,
}: {
  root: string;
  path: string;
  mode: "single" | "first" | "all" | string;
  find: string;
  replace: string;
}) => {
  return await postJson("/api/fs/replace", { root, path, mode, find, replace });
};

/**
 * fs_propose_change: convenience wrapper (NO WRITE).
 * Calls fs_prepare and returns a proposal payload.
 */
export const fs_propose_change = async (args: any) => {
  const root = String(args?.root ?? "repo");
  const path = String(args?.path ?? "");
  const mode = String(args?.mode ?? "single");
  const find = String(args?.find ?? "");
  const replace = String(args?.replace ?? "");

  const prep = await fs_prepare({ root, path, mode, find, replace });

  return {
    ok: true,
    kind: "fs_change_proposal",
    root,
    path,
    mode,
    find,
    replace,
    patch_unified: (prep as any)?.patch_unified ?? null,
    expected_hash: (prep as any)?.expected_hash ?? null,
    approval_id: (prep as any)?.approval_id ?? null,
    explanation: String(args?.explanation ?? "").trim() || "Prepared change proposal via fs_prepare (no write).",
    touched_files: [{ root, path }],
  };
};

// -------------------- functionsMap --------------------
// NOTE: keys MUST match sanitized tool names (dots become underscores).
export const functionsMap = {
  fs_read,
  fs_list,
  fs_prepare,
  fs_patch,
  fs_replace,
  fs_propose_change,
} as const;

// Optional: allow calling dotted names defensively (won't be emitted to OpenAI, but safe if any legacy path calls them)
export const _legacyAliases = {
  [sanitizeToolName("fs.read")]: fs_read,
  [sanitizeToolName("fs.list")]: fs_list,
  [sanitizeToolName("fs.prepare")]: fs_prepare,
  [sanitizeToolName("fs.patch")]: fs_patch,
  [sanitizeToolName("fs.replace")]: fs_replace,
  [sanitizeToolName("fs.propose_change")]: fs_propose_change,
} as const;
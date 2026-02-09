import path from "path";
import fs from "fs/promises";
import crypto from "crypto";

export type FsRootKey =
  | "app"
  | "components"
  | "lib"
  | "config"
  | "state"
  | "docs"
  | "scripts"
  | "tests"
  | "stores";

type GuardConfig = {
  enabled: boolean;
  adminToken: string;
  maxFileBytes: number;
  maxPatchBytes: number;
  maxListEntries: number;
  debug: boolean;
};

export function getGuardConfig(): GuardConfig {
  return {
    enabled: process.env.MEKA_FS_ENABLE === "1",
    adminToken: String(process.env.MEKA_ADMIN_TOKEN || ""),
    maxFileBytes: Number(process.env.MEKA_FS_MAX_FILE_BYTES || "1048576"),
    maxPatchBytes: Number(process.env.MEKA_FS_MAX_PATCH_BYTES || "262144"),
    maxListEntries: Number(process.env.MEKA_FS_MAX_LIST_ENTRIES || "200"),
    debug: process.env.MEKA_FS_DEBUG === "1",
  };
}

function debugLog(cfg: GuardConfig, msg: string) {
  if (cfg.debug) console.log(`[FS] ${msg}`);
}

export function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function safeText(x: unknown): string {
  if (typeof x === "string") return x;
  if (x == null) return "";
  return String(x);
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256HexBuf(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function requireEnabled(cfg: GuardConfig) {
  if (!cfg.enabled) {
    throw Object.assign(new Error("fs_gateway_disabled"), { code: "disabled" });
  }
}

export function requireAdmin(cfg: GuardConfig, req: Request) {
  requireEnabled(cfg);

  const auth = req.headers.get("authorization") || "";
  const want = cfg.adminToken;

  if (!want) {
    throw Object.assign(new Error("missing_server_admin_token"), { code: "misconfig" });
  }

  const ok = auth === `Bearer ${want}`;
  if (!ok) {
    throw Object.assign(new Error("unauthorized"), { code: "unauthorized" });
  }
}

export function requireLocalRequest(cfg: GuardConfig, req: Request) {
  // Lightweight dev-only check: ensure Host looks like localhost
  // (Still gated by token. This is an extra belt.)
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").toLowerCase();
  if (!host) return; // PowerShell sometimes still sends Host; if absent, we don't block.

  const allowed =
    host.startsWith("localhost:") ||
    host.startsWith("127.0.0.1:") ||
    host.startsWith("[::1]:") ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]";

  if (!allowed) {
    debugLog(cfg, `blocked non-local host=${host}`);
    throw Object.assign(new Error("forbidden_non_local_host"), { code: "forbidden_host" });
  }

  // If Origin is present (browser), ensure it matches host.
  const origin = (req.headers.get("origin") || "").toLowerCase();
  if (origin) {
    if (!origin.includes(host.replace("localhost", "localhost"))) {
      debugLog(cfg, `blocked origin=${origin} host=${host}`);
      throw Object.assign(new Error("forbidden_origin"), { code: "forbidden_origin" });
    }
  }
}

export function getRepoRoot(): string {
  // Next.js runs with process.cwd() at the project root in dev.
  return process.cwd();
}

const DENY_SEGMENTS = new Set(["node_modules", ".next", ".git"]);
const DENY_PREFIXES = [".env"]; // blocks .env, .env.local, etc.

const ALLOWED_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".json", ".md", ".txt",
  ".css",
  ".yml", ".yaml", ".toml",
  ".mjs", ".cjs",
]);

export function resolveRootDir(rootKey: FsRootKey): string {
  const root = getRepoRoot();
  const map: Record<FsRootKey, string> = {
    app: path.resolve(root, "app"),
    components: path.resolve(root, "components"),
    lib: path.resolve(root, "lib"),
    config: path.resolve(root, "config"),
    state: path.resolve(root, "state"),
    docs: path.resolve(root, "docs"),
    scripts: path.resolve(root, "scripts"),
    tests: path.resolve(root, "tests"),
    stores: path.resolve(root, "stores"),
  };
  return map[rootKey];
}

export function normalizeRelPath(p: string): string {
  // Allow forward slashes from URL inputs, normalize to platform.
  const s = safeText(p).replace(/\\/g, "/");
  return s.replace(/^\/+/, "");
}

export async function resolveAllowlistedFile(rootKey: FsRootKey, relPath: string) {
  const rootDir = resolveRootDir(rootKey);
  const rel = normalizeRelPath(relPath);

  if (!rel || rel.includes("\0")) {
    throw Object.assign(new Error("invalid_path"), { code: "invalid_path" });
  }

  // Block traversal by resolving and re-checking prefix.
  const candidate = path.resolve(rootDir, rel);

  // Denylist segments anywhere in the rel path
  const segs = rel.split("/").filter(Boolean);
  for (const seg of segs) {
    if (DENY_SEGMENTS.has(seg)) {
      throw Object.assign(new Error("path_denied_segment"), { code: "denied_segment", seg });
    }
    for (const pref of DENY_PREFIXES) {
      if (seg.startsWith(pref)) {
        throw Object.assign(new Error("path_denied_prefix"), { code: "denied_prefix", pref });
      }
    }
  }

  const ext = path.extname(candidate).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw Object.assign(new Error("file_type_not_allowed"), { code: "bad_ext", ext });
  }

  // Symlink escape protection: realpath both sides
  const rootReal = await fs.realpath(rootDir).catch(() => rootDir);
  const candReal = await fs.realpath(candidate).catch(() => candidate);

  const okPrefix =
    candReal === rootReal ||
    candReal.startsWith(rootReal + path.sep);

  if (!okPrefix) {
    throw Object.assign(new Error("path_escapes_allowlist"), { code: "escape" });
  }

  return { rootKey, rootDir: rootReal, relPath: rel, absPath: candReal };
}

export function assertTextBuffer(buf: Buffer) {
  // Binary heuristic: reject NUL bytes
  if (buf.includes(0)) {
    throw Object.assign(new Error("binary_not_allowed"), { code: "binary" });
  }
}

export async function readTextFile(absPath: string, maxBytes: number) {
  const buf = await fs.readFile(absPath);
  if (buf.byteLength > maxBytes) {
    throw Object.assign(new Error("file_too_large"), { code: "too_large", bytes: buf.byteLength, maxBytes });
  }
  assertTextBuffer(buf);

  // Preserve BOM? For code files: remove BOM if present to keep hashes stable.
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const hash = "sha256:" + sha256Hex(text);
  return { text, hash, bytes: Buffer.byteLength(text, "utf8") };
}

export async function writeAtomicTextFile(absPath: string, content: string) {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  const tmp = path.join(dir, `${base}.meka_tmp_${Date.now()}_${Math.random().toString(16).slice(2)}.tmp`);

  await fs.writeFile(tmp, content, "utf8");

  // Best-effort replace
  await fs.rm(absPath, { force: true }).catch(() => {});
  await fs.rename(tmp, absPath);
}

export async function ensureAuditLogLine(obj: any) {
  const root = getRepoRoot();
  const stateDir = path.resolve(root, "state");
  await fs.mkdir(stateDir, { recursive: true });

  const p = path.join(stateDir, "fs_audit.jsonl");
  const line = JSON.stringify(obj) + "\n";
  await fs.appendFile(p, line, "utf8");
}

export function makeApprovalId(pathKey: string, beforeHash: string, patchUnified: string) {
  // Deterministic approval id, no server storage required.
  const raw = `${pathKey}\n${beforeHash}\n${sha256Hex(patchUnified)}`;
  return "appr_" + sha256Hex(raw).slice(0, 16);
}

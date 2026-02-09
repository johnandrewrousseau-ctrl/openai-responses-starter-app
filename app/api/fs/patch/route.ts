import { applyPatch } from "diff";
import {
  getGuardConfig,
  json,
  safeText,
  requireAdmin,
  requireLocalRequest,
  resolveAllowlistedFile,
  readTextFile,
  writeAtomicTextFile,
  ensureAuditLogLine,
  sha256Hex,
  makeApprovalId,
} from "@/lib/fs_guard";

export const runtime = "nodejs";

type PatchBody = {
  root?: string;            // allowlist key
  path?: string;            // relative path under root
  patch_unified?: string;   // unified diff
  dry_run?: boolean;
  expected_hash?: string;   // sha256:...
  approval_id?: string;     // appr_...
};

type Eol = "CRLF" | "LF";

function detectEol(text: string): Eol {
  return text.includes("\r\n") ? "CRLF" : "LF";
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function fromLf(textLf: string, eol: Eol): string {
  return eol === "CRLF" ? textLf.replace(/\n/g, "\r\n") : textLf;
}

export async function POST(req: Request) {
  const cfg = getGuardConfig();
  const t0 = Date.now();

  try {
    requireLocalRequest(cfg, req);
    requireAdmin(cfg, req);

    const rawBody = await req.text();
    if (rawBody.length > cfg.maxPatchBytes) {
      return json({ ok: false, error: "patch_too_large", bytes: rawBody.length, max: cfg.maxPatchBytes }, 413);
    }

    let parsed: PatchBody | null = null;
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as PatchBody) : null;
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const root = safeText(parsed?.root).trim();
    const relPath = safeText(parsed?.path).trim();
    const patchUnifiedRaw = safeText(parsed?.patch_unified);
    const dryRun = Boolean(parsed?.dry_run ?? true);
    const expectedHash = safeText(parsed?.expected_hash).trim();
    const approvalIdIn = safeText(parsed?.approval_id).trim();

    if (!root || !relPath || !patchUnifiedRaw) {
      return json({ ok: false, error: "missing_fields", need: "root, path, patch_unified" }, 400);
    }

    const file = await resolveAllowlistedFile(root as any, relPath);
    const before = await readTextFile(file.absPath, cfg.maxFileBytes);

    const eol: Eol = detectEol(before.text);

    // Normalize BOTH file and patch to LF for deterministic patch application.
    const beforeLf = toLf(before.text);
    const patchUnifiedLf = toLf(patchUnifiedRaw);

    // Apply requires hash match (prevents clobber).
    if (!dryRun) {
      if (!expectedHash) {
        return json({ ok: false, error: "missing_expected_hash", need: "expected_hash for apply" }, 400);
      }
      if (expectedHash !== before.hash) {
        return json({ ok: false, error: "hash_mismatch", status: 409, expected: expectedHash, actual: before.hash, eol }, 409);
      }
    }

    // Apply unified patch in-memory against LF normalized text
    const patchedLf = applyPatch(beforeLf, patchUnifiedLf);

    if (patchedLf === false) {
      await ensureAuditLogLine({
        ts: new Date().toISOString(),
        op: "patch",
        phase: dryRun ? "dry_run" : "apply",
        ok: false,
        root,
        path: file.relPath,
        error: "patch_does_not_apply",
        before_hash: before.hash,
        eol,
        ms: Date.now() - t0,
      });

      return json(
        {
          ok: false,
          error: "patch_does_not_apply",
          hint: "Patch hunks did not match current file. Re-read the file and regenerate patch.",
          before_hash: before.hash,
          eol,
        },
        400
      );
    }

    // Convert back to original file EOL for write + hashing
    const patched = fromLf(String(patchedLf), eol);

    const afterHash = "sha256:" + sha256Hex(patched);

    // Deterministic IDs should be based on normalized patch text to avoid CRLF/LF mismatch.
    const pathKey = `${file.rootKey}/${file.relPath}`;
    const approvalId = makeApprovalId(pathKey, before.hash, patchUnifiedLf);
    const patchHash = "sha256:" + sha256Hex(patchUnifiedLf);

    // For apply, enforce deterministic approval id to prevent accidental mismatch.
    if (!dryRun) {
      if (!approvalIdIn) {
        return json({ ok: false, error: "missing_approval_id", need: "approval_id from dry_run", eol }, 400);
      }
      if (approvalIdIn !== approvalId) {
        return json({ ok: false, error: "approval_id_mismatch", expected: approvalId, received: approvalIdIn, eol }, 409);
      }
      await writeAtomicTextFile(file.absPath, patched);
    }

    await ensureAuditLogLine({
      ts: new Date().toISOString(),
      op: "patch",
      phase: dryRun ? "dry_run" : "apply",
      ok: true,
      root,
      path: file.relPath,
      before_hash: before.hash,
      after_hash: afterHash,
      approval_id: approvalId,
      patch_hash: patchHash,
      eol,
      ms: Date.now() - t0,
    });

    return json(
      {
        ok: true,
        root,
        path: file.relPath,
        dry_run: dryRun,
        before_hash: before.hash,
        after_hash: afterHash,
        patch_hash: patchHash,
        approval_id: approvalId,
        wrote: !dryRun,
        eol,
      },
      200
    );
  } catch (e: any) {
    await ensureAuditLogLine({
      ts: new Date().toISOString(),
      op: "patch",
      ok: false,
      error: String(e?.code || e?.message || e),
      ms: Date.now() - t0,
    }).catch(() => {});

    const code = String(e?.code || "");
    const status =
      code === "unauthorized" ? 401 :
      code.startsWith("forbidden") ? 403 :
      code === "disabled" ? 404 :
      400;

    return json({ ok: false, error: code || "patch_failed", message: String(e?.message || e) }, status);
  }
}

import { applyPatch, createTwoFilesPatch } from "diff";
import {
  getGuardConfig,
  json,
  safeText,
  requireAdmin,
  requireLocalRequest,
  resolveAllowlistedFile,
  readTextFile,
  ensureAuditLogLine,
  sha256Hex,
  makeApprovalId,
} from "@/lib/fs_guard";

export const runtime = "nodejs";

type ReplaceMode = "single" | "first" | "all";

type ReplaceBody = {
  root?: string;
  path?: string;
  find?: string;
  replace?: string;
  mode?: ReplaceMode;
  dry_run?: boolean; // always dry-run here (no writes)
};

function detectEol(text: string): "CRLF" | "LF" {
  return text.includes("\r\n") ? "CRLF" : "LF";
}

function toLF(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const at = haystack.indexOf(needle, idx);
    if (at === -1) break;
    count++;
    idx = at + needle.length;
  }
  return count;
}

function replaceOnce(haystack: string, needle: string, repl: string): string {
  const at = haystack.indexOf(needle);
  if (at === -1) return haystack;
  return haystack.slice(0, at) + repl + haystack.slice(at + needle.length);
}

function replaceAll(haystack: string, needle: string, repl: string): string {
  return haystack.split(needle).join(repl);
}

export async function POST(req: Request) {
  const cfg = getGuardConfig();
  const t0 = Date.now();

  try {
    requireLocalRequest(cfg, req);
    requireAdmin(cfg, req);

    const rawBody = await req.text();
    if (rawBody.length > cfg.maxPatchBytes) {
      return json(
        { ok: false, error: "payload_too_large", bytes: rawBody.length, max: cfg.maxPatchBytes },
        413
      );
    }

    let parsed: ReplaceBody | null = null;
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as ReplaceBody) : null;
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const root = safeText(parsed?.root).trim();
    const relPath = safeText(parsed?.path).trim();
    const find = safeText(parsed?.find);
    const replace = safeText(parsed?.replace);
    const mode: ReplaceMode = (safeText(parsed?.mode).trim() as ReplaceMode) || "single";

    if (!root || !relPath) {
      return json({ ok: false, error: "missing_fields", need: "root, path" }, 400);
    }
    if (!find) {
      return json({ ok: false, error: "missing_fields", need: "find (non-empty string)" }, 400);
    }

    const file = await resolveAllowlistedFile(root as any, relPath);
    const before = await readTextFile(file.absPath, cfg.maxFileBytes);

    const eol = detectEol(before.text);
    const matches = countOccurrences(before.text, find);

    if (matches === 0) {
      await ensureAuditLogLine({
        ts: new Date().toISOString(),
        op: "replace",
        ok: false,
        root,
        path: file.relPath,
        error: "find_not_found",
        matches,
        eol,
        ms: Date.now() - t0,
      });

      return json(
        { ok: false, error: "find_not_found", hint: "Find block did not match current file. Re-read file and retry.", matches, eol },
        409
      );
    }

    if (mode === "single" && matches !== 1) {
      await ensureAuditLogLine({
        ts: new Date().toISOString(),
        op: "replace",
        ok: false,
        root,
        path: file.relPath,
        error: "ambiguous_match",
        matches,
        eol,
        ms: Date.now() - t0,
      });

      return json(
        {
          ok: false,
          error: "ambiguous_match",
          hint: "Default mode requires exactly 1 match. Provide a more specific find block, or set mode=first/all.",
          matches,
          eol,
        },
        409
      );
    }

    let afterText = before.text;
    if (mode === "single" || mode === "first") {
      afterText = replaceOnce(before.text, find, replace);
    } else if (mode === "all") {
      afterText = replaceAll(before.text, find, replace);
    } else {
      return json({ ok: false, error: "invalid_mode", allowed: ["single", "first", "all"] }, 400);
    }

    const beforeHash = before.hash;
    const afterHash = "sha256:" + sha256Hex(afterText);

    if (afterText === before.text) {
      await ensureAuditLogLine({
        ts: new Date().toISOString(),
        op: "replace",
        ok: true,
        root,
        path: file.relPath,
        phase: "no_op",
        before_hash: beforeHash,
        after_hash: afterHash,
        matches,
        eol,
        ms: Date.now() - t0,
      });

      return json(
        {
          ok: true,
          root,
          path: file.relPath,
          matches,
          mode,
          changed: false,
          before_hash: beforeHash,
          after_hash: afterHash,
          patch_unified: "",
          approval_id: "",
          eol,
        },
        200
      );
    }

    // Generate patch in LF form (patch standard) and validate in LF.
    const beforeLF = toLF(before.text);
    const afterLF = toLF(afterText);

    const patchUnified = createTwoFilesPatch(
      `a/${file.relPath}`,
      `b/${file.relPath}`,
      beforeLF,
      afterLF,
      "",
      "",
      { context: 3 }
    );

    if (patchUnified.length > cfg.maxPatchBytes) {
      return json(
        { ok: false, error: "patch_too_large", bytes: patchUnified.length, max: cfg.maxPatchBytes },
        413
      );
    }

    const patchedLF = applyPatch(beforeLF, patchUnified);
    if (patchedLF === false || patchedLF !== afterLF) {
      await ensureAuditLogLine({
        ts: new Date().toISOString(),
        op: "replace",
        ok: false,
        root,
        path: file.relPath,
        error: "patch_generation_failed",
        before_hash: beforeHash,
        after_hash: afterHash,
        matches,
        eol,
        ms: Date.now() - t0,
      });

      return json(
        {
          ok: false,
          error: "patch_generation_failed",
          hint: "Generated patch did not apply cleanly. This indicates a diff/apply mismatch; LF-normalization is required.",
          matches,
          eol,
        },
        500
      );
    }

    const pathKey = `${file.rootKey}/${file.relPath}`;
    const approvalId = makeApprovalId(pathKey, beforeHash, patchUnified);
    const patchHash = "sha256:" + sha256Hex(patchUnified);

    await ensureAuditLogLine({
      ts: new Date().toISOString(),
      op: "replace",
      ok: true,
      root,
      path: file.relPath,
      phase: "generated",
      matches,
      before_hash: beforeHash,
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
        matches,
        mode,
        changed: true,
        before_hash: beforeHash,
        after_hash: afterHash,
        patch_hash: patchHash,
        approval_id: approvalId,
        patch_unified: patchUnified,
        eol,
      },
      200
    );
  } catch (e: any) {
    await ensureAuditLogLine({
      ts: new Date().toISOString(),
      op: "replace",
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

    return json({ ok: false, error: code || "replace_failed", message: String(e?.message || e) }, status);
  }
}

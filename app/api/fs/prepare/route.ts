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
type Eol = "CRLF" | "LF";

type PrepareBody = {
  root?: string;
  path?: string;

  // Replace spec (this endpoint is specifically for replace→patch dry-run)
  find?: string;
  replace?: string;
  mode?: ReplaceMode;
};

function detectEol(text: string): Eol {
  return text.includes("\r\n") ? "CRLF" : "LF";
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function fromLf(textLf: string, eol: Eol): string {
  return eol === "CRLF" ? textLf.replace(/\n/g, "\r\n") : textLf;
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

function diffStats(patchUnifiedLf: string) {
  const lines = patchUnifiedLf.split("\n");
  let add = 0,
    del = 0;
  for (const ln of lines) {
    if (
      ln.startsWith("+++ ") ||
      ln.startsWith("--- ") ||
      ln.startsWith("@@") ||
      ln.startsWith("diff ") ||
      ln.startsWith("index ") ||
      ln.startsWith("===")
    )
      continue;
    if (ln.startsWith("+")) add++;
    else if (ln.startsWith("-")) del++;
  }
  return { added: add, removed: del };
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

    let parsed: PrepareBody | null = null;
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as PrepareBody) : null;
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const root = safeText(parsed?.root).trim();
    const relPath = safeText(parsed?.path).trim();
    const findRaw = safeText(parsed?.find);
    const replaceRaw = safeText(parsed?.replace);
    const mode: ReplaceMode = (safeText(parsed?.mode).trim() as ReplaceMode) || "single";

    if (!root || !relPath) {
      return json({ ok: false, error: "missing_fields", need: "root, path" }, 400);
    }
    if (!findRaw) {
      return json({ ok: false, error: "missing_fields", need: "find (non-empty string)" }, 400);
    }
    if (!["single", "first", "all"].includes(mode)) {
      return json({ ok: false, error: "invalid_mode", allowed: ["single", "first", "all"] }, 400);
    }

    const file = await resolveAllowlistedFile(root as any, relPath);
    const before = await readTextFile(file.absPath, cfg.maxFileBytes);

    const eol: Eol = detectEol(before.text);

    // Normalize to LF for deterministic patch math
    const beforeLf = toLf(before.text);
    const findLf = toLf(findRaw);
    const replaceLf = toLf(replaceRaw);

    const matches = countOccurrences(beforeLf, findLf);

    if (matches === 0) {
      await ensureAuditLogLine({
        ts: new Date().toISOString(),
        op: "prepare",
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
        op: "prepare",
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
          hint: "mode=single requires exactly 1 match. Use a tighter find, or mode=first/all.",
          matches,
          eol,
        },
        409
      );
    }

    let afterLf = beforeLf;
    if (mode === "single" || mode === "first") afterLf = replaceOnce(beforeLf, findLf, replaceLf);
    else afterLf = replaceAll(beforeLf, findLf, replaceLf);

    const beforeHash = before.hash;

    // No-op
    if (afterLf === beforeLf) {
      await ensureAuditLogLine({
        ts: new Date().toISOString(),
        op: "prepare",
        ok: true,
        root,
        path: file.relPath,
        phase: "no_op",
        matches,
        before_hash: beforeHash,
        after_hash: beforeHash,
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
          expected_hash: beforeHash,
          before_hash: beforeHash,
          after_hash: beforeHash,
          patch_unified: "",
          patch_hash: "",
          approval_id: "",
          eol,
          stats: { added: 0, removed: 0 },
        },
        200
      );
    }

    // Create patch against LF-normalized content
    const patchUnifiedLf = createTwoFilesPatch(
      `a/${file.relPath}`,
      `b/${file.relPath}`,
      beforeLf,
      afterLf,
      "",
      "",
      { context: 3 }
    );

    if (patchUnifiedLf.length > cfg.maxPatchBytes) {
      return json(
        { ok: false, error: "patch_too_large", bytes: patchUnifiedLf.length, max: cfg.maxPatchBytes, eol },
        413
      );
    }

    // Validate patch applies cleanly (dry-run guarantee)
    const patchedLf = applyPatch(beforeLf, patchUnifiedLf);
    if (patchedLf === false || String(patchedLf) !== afterLf) {
      await ensureAuditLogLine({
        ts: new Date().toISOString(),
        op: "prepare",
        ok: false,
        root,
        path: file.relPath,
        error: "patch_generation_failed",
        matches,
        before_hash: beforeHash,
        eol,
        ms: Date.now() - t0,
      });

      return json(
        {
          ok: false,
          error: "patch_generation_failed",
          hint: "Generated patch did not apply cleanly. This indicates non-exact find/replace or EOL instability.",
          matches,
          eol,
        },
        500
      );
    }

    // Convert patched text back to original EOL for hashing only (we are NOT writing here)
    const afterText = fromLf(afterLf, eol);
    const afterHash = "sha256:" + sha256Hex(afterText);

    const pathKey = `${file.rootKey}/${file.relPath}`;
    const approvalId = makeApprovalId(pathKey, beforeHash, patchUnifiedLf);
    const patchHash = "sha256:" + sha256Hex(patchUnifiedLf);
    const stats = diffStats(patchUnifiedLf);

    await ensureAuditLogLine({
      ts: new Date().toISOString(),
      op: "prepare",
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
        expected_hash: beforeHash,
        before_hash: beforeHash,
        after_hash: afterHash,
        patch_hash: patchHash,
        approval_id: approvalId,
        patch_unified: patchUnifiedLf,
        eol,
        stats,
      },
      200
    );
  } catch (e: any) {
    await ensureAuditLogLine({
      ts: new Date().toISOString(),
      op: "prepare",
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

    return json({ ok: false, error: code || "prepare_failed", message: String(e?.message || e) }, status);
  }
}

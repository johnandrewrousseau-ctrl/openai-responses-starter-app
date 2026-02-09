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
type RiskLevel = "low" | "medium" | "high";

type ProposeBody = {
  root?: string;
  path?: string;

  // Option A: find/replace proposal
  find?: string;
  replace?: string;
  mode?: ReplaceMode;

  // Option B: provide a patch directly (optional; still validated)
  patch_unified?: string;

  // Optional: brief user intent for audit metadata (not required)
  intent?: string;
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
  let add = 0;
  let del = 0;

  for (const ln of lines) {
    if (
      ln.startsWith("+++ ") ||
      ln.startsWith("--- ") ||
      ln.startsWith("@@") ||
      ln.startsWith("diff ") ||
      ln.startsWith("index ") ||
      ln.startsWith("===")
    ) {
      continue;
    }
    if (ln.startsWith("+")) add++;
    else if (ln.startsWith("-")) del++;
  }

  return { added: add, removed: del };
}

function classifyRisk(args: {
  relPath: string;
  stats: { added: number; removed: number };
  mode: ReplaceMode | "patch";
}): RiskLevel {
  const p = (args.relPath || "").toLowerCase();
  const changeSize = (args.stats.added || 0) + (args.stats.removed || 0);

  // Conservative defaults:
  // - API/server/lib changes are inherently riskier than UI-only
  // - Big diffs are riskier than small diffs
  const isServer =
    p.includes("/app/api/") ||
    p.includes("\\app\\api\\") ||
    p.includes("/lib/") ||
    p.includes("\\lib\\") ||
    p.includes("openai_client") ||
    p.includes("tools.ts");

  const isConfig =
    p.endsWith(".env") ||
    p.endsWith(".env.local") ||
    p.endsWith(".json") ||
    p.endsWith(".yaml") ||
    p.endsWith(".yml");

  if (isConfig) return "high";
  if (isServer && changeSize > 15) return "high";
  if (changeSize > 80) return "high";
  if (isServer) return "medium";
  if (changeSize > 15) return "medium";
  return "low";

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

    let parsed: ProposeBody | null = null;
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as ProposeBody) : null;
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const root = safeText(parsed?.root).trim();
    const relPath = safeText(parsed?.path).trim();
    const intent = safeText(parsed?.intent).trim();

    const mode: ReplaceMode = (safeText(parsed?.mode).trim() as ReplaceMode) || "single";
    const findRaw = safeText(parsed?.find);
    const replaceRaw = safeText(parsed?.replace);
    const patchUnifiedRaw = safeText(parsed?.patch_unified);

    if (!root || !relPath) {
      return json({ ok: false, error: "missing_fields", need: "root, path" }, 400);
    }
    if (!patchUnifiedRaw && !findRaw) {
      return json(
        { ok: false, error: "missing_fields", need: "either patch_unified OR find (non-empty string)" },
        400
      );
    }
    if (patchUnifiedRaw && (findRaw || replaceRaw)) {
      return json(
        { ok: false, error: "invalid_payload", hint: "Provide patch_unified OR find/replace, not both." },
        400
      );
    }
    if (!patchUnifiedRaw && !["single", "first", "all"].includes(mode)) {
      return json({ ok: false, error: "invalid_mode", allowed: ["single", "first", "all"] }, 400);
    }

    const file = await resolveAllowlistedFile(root as any, relPath);
    const before = await readTextFile(file.absPath, cfg.maxFileBytes);

    const eol: Eol = detectEol(before.text);
    const beforeLf = toLf(before.text);

    let patchUnifiedLf = "";
    let afterLf = beforeLf;
    let matches = 0;
    const modeUsed: ReplaceMode | "patch" = patchUnifiedRaw ? "patch" : mode;

    if (patchUnifiedRaw) {
      // Validate provided patch applies cleanly to LF-normalized content
      patchUnifiedLf = toLf(patchUnifiedRaw);

      const patchedLf = applyPatch(beforeLf, patchUnifiedLf);
      if (patchedLf === false) {
        await ensureAuditLogLine({
          ts: new Date().toISOString(),
          op: "propose_change",
          ok: false,
          root,
          path: file.relPath,
          error: "patch_does_not_apply",
          eol,
          ms: Date.now() - t0,
          intent,
        });

        return json(
          { ok: false, error: "patch_does_not_apply", hint: "Patch did not apply to current file.", eol },
          409
        );
      }
      afterLf = String(patchedLf);
    } else {
      // Build patch from find/replace in LF space
      const findLf = toLf(findRaw);
      const replaceLf = toLf(replaceRaw);

      matches = countOccurrences(beforeLf, findLf);

      if (matches === 0) {
        await ensureAuditLogLine({
          ts: new Date().toISOString(),
          op: "propose_change",
          ok: false,
          root,
          path: file.relPath,
          error: "find_not_found",
          matches,
          eol,
          ms: Date.now() - t0,
          intent,
        });

        return json(
          { ok: false, error: "find_not_found", hint: "Find did not match current file.", matches, eol },
          409
        );
      }

      if (mode === "single" && matches !== 1) {
        await ensureAuditLogLine({
          ts: new Date().toISOString(),
          op: "propose_change",
          ok: false,
          root,
          path: file.relPath,
          error: "ambiguous_match",
          matches,
          eol,
          ms: Date.now() - t0,
          intent,
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

      if (mode === "single" || mode === "first") afterLf = replaceOnce(beforeLf, findLf, replaceLf);
      else afterLf = replaceAll(beforeLf, findLf, replaceLf);

      if (afterLf === beforeLf) {
        const riskNoOp: RiskLevel = "low";

        // No-op proposal is allowed, but explicitly returns changed=false
        await ensureAuditLogLine({
          ts: new Date().toISOString(),
          op: "propose_change",
          ok: true,
          root,
          path: file.relPath,
          phase: "no_op",
          matches,
          before_hash: before.hash,
          after_hash: before.hash,
          eol,
          ms: Date.now() - t0,
          intent,
        });

        return json(
          {
            ok: true,
            proposal: {
              kind: "fs.propose_change",
              root,
              path: file.relPath,
              touched_files: [{ root, path: file.relPath }],
              mode: modeUsed,
              changed: false,
              expected_hash: before.hash,
              before_hash: before.hash,
              after_hash: before.hash,
              patch_unified: "",
              patch_hash: "",
              approval_id: "",
              eol,
              stats: { added: 0, removed: 0 },
              risk_level: riskNoOp,
              explanation: "No-op (after == before).",
            },
          },
          200
        );
      }

      patchUnifiedLf = createTwoFilesPatch(
        `a/${file.relPath}`,
        `b/${file.relPath}`,
        beforeLf,
        afterLf,
        "",
        "",
        { context: 3 }
      );

      // Validate patch applies cleanly (dry-run guarantee)
      const patchedLf = applyPatch(beforeLf, patchUnifiedLf);
      if (patchedLf === false || String(patchedLf) !== afterLf) {
        await ensureAuditLogLine({
          ts: new Date().toISOString(),
          op: "propose_change",
          ok: false,
          root,
          path: file.relPath,
          error: "patch_generation_failed",
          matches,
          before_hash: before.hash,
          eol,
          ms: Date.now() - t0,
          intent,
        });

        return json(
          {
            ok: false,
            error: "patch_generation_failed",
            hint: "Generated patch did not apply cleanly. This indicates non-exact find/replace or instability.",
            matches,
            eol,
          },
          500
        );
      }
    }

    if (patchUnifiedLf.length > cfg.maxPatchBytes) {
      return json(
        { ok: false, error: "patch_too_large", bytes: patchUnifiedLf.length, max: cfg.maxPatchBytes, eol },
        413
      );
    }

    const afterText = fromLf(afterLf, eol);
    const beforeHash = before.hash;
    const afterHash = "sha256:" + sha256Hex(afterText);

    const pathKey = `${file.rootKey}/${file.relPath}`;
    const approvalId = makeApprovalId(pathKey, beforeHash, patchUnifiedLf);
    const patchHash = "sha256:" + sha256Hex(patchUnifiedLf);
    const stats = diffStats(patchUnifiedLf);

    const risk: RiskLevel = classifyRisk({ relPath: file.relPath, stats, mode: modeUsed });

    await ensureAuditLogLine({
      ts: new Date().toISOString(),
      op: "propose_change",
      ok: true,
      root,
      path: file.relPath,
      phase: "proposed",
      matches,
      before_hash: beforeHash,
      after_hash: afterHash,
      approval_id: approvalId,
      patch_hash: patchHash,
      eol,
      ms: Date.now() - t0,
      intent,
    });

    return json(
      {
        ok: true,
        proposal: {
          kind: "fs.propose_change",
          root,
          path: file.relPath,
          touched_files: [{ root, path: file.relPath }],
          mode: modeUsed,
          matches,
          changed: true,
          expected_hash: beforeHash,
          before_hash: beforeHash,
          after_hash: afterHash,
          patch_hash: patchHash,
          approval_id: approvalId,
          patch_unified: patchUnifiedLf,
          eol,
          stats,
          risk_level: risk,
          explanation:
            modeUsed === "patch"
              ? "Validated a provided unified patch against the current file."
              : "Generated a unified patch from find/replace and validated it applies cleanly.",
        },
      },
      200
    );
  } catch (e: any) {
    await ensureAuditLogLine({
      ts: new Date().toISOString(),
      op: "propose_change",
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

    return json({ ok: false, error: code || "propose_change_failed", message: String(e?.message || e) }, status);
  }
}

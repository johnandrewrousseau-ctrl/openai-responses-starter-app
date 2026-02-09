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

type ProposeOpIn = {
  root?: string;
  path?: string;

  // Either provide find/replace...
  find?: string;
  replace?: string;
  mode?: ReplaceMode;

  // ...or provide a patch directly (will be validated against the current file).
  patch_unified?: string | null;
};

type ProposeBody = {
  title?: string;
  explanation?: string;
  ops?: ProposeOpIn[];
};

type ProposeOpOut = {
  root: string;
  path: string;
  touched_files: string[];

  mode: ReplaceMode;
  matches: number;

  expected_hash: string; // == before_hash
  before_hash: string;
  after_hash: string;

  patch_unified: string;
  patch_hash: string;
  approval_id: string;

  eol: Eol;
  stats: { added: number; removed: number };
  risk_level: RiskLevel;
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

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const rank: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 };
  return rank[b] > rank[a] ? b : a;
}

function classifyRisk(root: string, relPath: string, stats: { added: number; removed: number }): RiskLevel {
  const p = `${root}/${relPath}`.toLowerCase();
  const churn = (stats.added ?? 0) + (stats.removed ?? 0);

  // High-risk surfaces
  if (
    p.includes("/app/api/") ||
    p.includes("/middleware") ||
    p.endsWith("package.json") ||
    p.endsWith("package-lock.json") ||
    p.endsWith("pnpm-lock.yaml") ||
    p.endsWith("yarn.lock") ||
    p.endsWith(".env") ||
    p.endsWith(".env.local") ||
    p.endsWith("next.config.js") ||
    p.endsWith("next.config.mjs") ||
    p.endsWith("tsconfig.json")
  ) {
    return "high";
  }

  // Churn-based bump
  if (churn >= 800) return "high";
  if (churn >= 200) return "medium";

  // Typical UI code paths
  if (p.startsWith("components/")) return "low";
  if (p.startsWith("app/")) return "medium";

  return "medium";
}

export async function POST(req: Request) {
  const cfg = getGuardConfig();
  const t0 = Date.now();

  try {
    requireLocalRequest(cfg, req);
    requireAdmin(cfg, req);

    const rawBody = await req.text();
    if (rawBody.length > cfg.maxPatchBytes) {
      return json({ ok: false, error: "payload_too_large", bytes: rawBody.length, max: cfg.maxPatchBytes }, 413);
    }

    let parsed: ProposeBody | null = null;
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as ProposeBody) : null;
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const opsIn = Array.isArray(parsed?.ops) ? parsed!.ops! : [];
    if (opsIn.length === 0) {
      return json({ ok: false, error: "missing_fields", need: "ops[0..n]" }, 400);
    }

    const opsOut: ProposeOpOut[] = [];
    let overallRisk: RiskLevel = "low";
    const touchedFilesAll: string[] = [];

    for (let i = 0; i < opsIn.length; i++) {
      const opIn = opsIn[i] || {};
      const root = safeText(opIn.root).trim();
      const relPath = safeText(opIn.path).trim();

      const mode: ReplaceMode = (safeText(opIn.mode).trim() as ReplaceMode) || "single";
      const findRaw = safeText(opIn.find);
      const replaceRaw = safeText(opIn.replace);
      const patchUnifiedRaw = safeText(opIn.patch_unified);

      if (!root || !relPath) {
        return json({ ok: false, error: "missing_fields", need: "root, path", index: i }, 400);
      }

      if (!["single", "first", "all"].includes(mode)) {
        return json({ ok: false, error: "invalid_mode", allowed: ["single", "first", "all"], index: i }, 400);
      }

      const file = await resolveAllowlistedFile(root as any, relPath);
      const before = await readTextFile(file.absPath, cfg.maxFileBytes);
      const eol: Eol = detectEol(before.text);

      const beforeLf = toLf(before.text);

      let afterLf = beforeLf;
      let matches = 0;

      if (patchUnifiedRaw) {
        // FIX: normalize patch to LF before applying to LF-normalized content
        const patchUnifiedLf = toLf(patchUnifiedRaw);

        const patchedLf = applyPatch(beforeLf, patchUnifiedLf);
        if (patchedLf === false) {
          await ensureAuditLogLine({
            ts: new Date().toISOString(),
            op: "propose",
            ok: false,
            root,
            path: file.relPath,
            error: "patch_does_not_apply",
            eol,
            ms: Date.now() - t0,
          });
          return json(
            { ok: false, error: "patch_does_not_apply", hint: "Provided patch_unified did not apply to current file.", index: i, eol },
            409
          );
        }
        afterLf = String(patchedLf);
        matches = 1;
      } else {
        if (!findRaw) {
          return json({ ok: false, error: "missing_fields", need: "find (non-empty) OR patch_unified", index: i }, 400);
        }

        const findLf = toLf(findRaw);
        const replaceLf = toLf(replaceRaw);

        matches = countOccurrences(beforeLf, findLf);

        if (matches === 0) {
          await ensureAuditLogLine({
            ts: new Date().toISOString(),
            op: "propose",
            ok: false,
            root,
            path: file.relPath,
            error: "find_not_found",
            matches,
            eol,
            ms: Date.now() - t0,
          });
          return json(
            { ok: false, error: "find_not_found", hint: "Find block did not match current file. Re-read file and retry.", matches, eol, index: i },
            409
          );
        }

        if (mode === "single" && matches !== 1) {
          await ensureAuditLogLine({
            ts: new Date().toISOString(),
            op: "propose",
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
              index: i,
            },
            409
          );
        }

        if (mode === "single" || mode === "first") afterLf = replaceOnce(beforeLf, findLf, replaceLf);
        else afterLf = replaceAll(beforeLf, findLf, replaceLf);
      }

      const beforeHash = before.hash;
      const touched = [`${root}/${file.relPath}`];
      touchedFilesAll.push(...touched);

      // No-op (afterLf identical)
      if (afterLf === beforeLf) {
        const stats = { added: 0, removed: 0 };
        const risk = classifyRisk(root, file.relPath, stats);
        overallRisk = maxRisk(overallRisk, risk);

        opsOut.push({
          root,
          path: file.relPath,
          touched_files: touched,
          mode,
          matches,
          expected_hash: beforeHash,
          before_hash: beforeHash,
          after_hash: beforeHash,
          patch_unified: "",
          patch_hash: "",
          approval_id: "",
          eol,
          stats,
          risk_level: risk,
        });

        continue;
      }

      // Generate authoritative patch from before→after
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
        return json({ ok: false, error: "patch_too_large", bytes: patchUnifiedLf.length, max: cfg.maxPatchBytes, eol, index: i }, 413);
      }

      // Validate patch applies cleanly (guarantee)
      const patchedLf2 = applyPatch(beforeLf, patchUnifiedLf);
      if (patchedLf2 === false || String(patchedLf2) !== afterLf) {
        await ensureAuditLogLine({
          ts: new Date().toISOString(),
          op: "propose",
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
            hint: "Generated patch did not apply cleanly. This indicates non-exact find/replace or patch instability.",
            matches,
            eol,
            index: i,
          },
          500
        );
      }

      const afterText = fromLf(afterLf, eol);
      const afterHash = "sha256:" + sha256Hex(afterText);

      const pathKey = `${file.rootKey}/${file.relPath}`;
      const approvalId = makeApprovalId(pathKey, beforeHash, patchUnifiedLf);
      const patchHash = "sha256:" + sha256Hex(patchUnifiedLf);
      const stats = diffStats(patchUnifiedLf);

      const risk = classifyRisk(root, file.relPath, stats);
      overallRisk = maxRisk(overallRisk, risk);

      await ensureAuditLogLine({
        ts: new Date().toISOString(),
        op: "propose",
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

      opsOut.push({
        root,
        path: file.relPath,
        touched_files: touched,
        mode,
        matches,
        expected_hash: beforeHash,
        before_hash: beforeHash,
        after_hash: afterHash,
        patch_unified: patchUnifiedLf,
        patch_hash: patchHash,
        approval_id: approvalId,
        eol,
        stats,
        risk_level: risk,
      });
    }

    // Deduplicate touched files
    const touchedFilesUnique = Array.from(new Set(touchedFilesAll));

    return json(
      {
        ok: true,
        kind: "meka.change_proposal_prepared",
        version: 1,
        title: safeText(parsed?.title).trim() || "",
        explanation: safeText(parsed?.explanation).trim() || "",
        risk_level: overallRisk,
        touched_files: touchedFilesUnique,
        ops: opsOut,
        generated_at: new Date().toISOString(),
      },
      200
    );
  } catch (e: any) {
    await ensureAuditLogLine({
      ts: new Date().toISOString(),
      op: "propose",
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

    return json({ ok: false, error: code || "propose_failed", message: String(e?.message || e) }, status);
  }
}

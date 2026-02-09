"use client";

import React from "react";

/**
 * Normalizes newlines to \n, trims trailing whitespace at end of file,
 * and guarantees a final newline.
 */
function mekaNormalizeNewlines(s: string): string {
  const t = (s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return t.replace(/\s+$/g, "") + "\n";
}

/**
 * Detects common shell/log contamination that should never be copied into "runnable" blocks.
 */
function mekaDetectContamination(s: string): string | null {
  const t = s ?? "";

  const checks: Array<[RegExp, string]> = [
    [/^\s*PS\s+[A-Za-z]:\\.*?>\s*/m, "PowerShell prompt detected (PS C:\\...>)"],
    [/^\s*[A-Za-z]:\\.*?>\s*/m, "Drive prompt detected (C:\\...>)"],
    [/^\s*>>\s+/m, "PowerShell continuation prompt detected (>>)"],
    [/^\s*At line:\d+\s+char:\d+/m, "PowerShell error dump detected (At line:...)"],
    [/^\s*\+\s+~+/m, "PowerShell caret block detected (+ ~~~)"],
    [/Cannot find a process with the name/m, "Shell transcript contamination detected"],
    [/^\s*GET\s+\/\s+\d{3}\s+in\s+\d+ms/m, "Server log line detected (GET / ... in ...ms)"],
    [/^\s*POST\s+\/\S+\s+\d{3}\s+in\s+\d+ms/m, "Server log line detected (POST /... in ...ms)"],
  ];

  for (const [re, msg] of checks) {
    if (re.test(t)) return msg;
  }

  return null;
}

/**
 * Extracts the single runnable region, guarded by explicit sentinels.
 * Format:
 * ### RUN:
 * ... content ...
 * ### END RUN
 */
function mekaExtractRunnableRegion(
  raw: string
): { ok: true; text: string } | { ok: false; reason: string } {
  const s = raw ?? "";

  const re = /###\s*RUN:\s*\r?\n([\s\S]*?)\r?\n###\s*END\s*RUN\s*/m;
  const m = s.match(re);
  if (!m) {
    return {
      ok: false,
      reason: "Missing sentinels. Wrap runnable text with: ### RUN: (newline) ... (newline) ### END RUN",
    };
  }

  const body = m[1] ?? "";
  const bad = mekaDetectContamination(body);
  if (bad) return { ok: false, reason: bad };

  return { ok: true, text: mekaNormalizeNewlines(body) };
}

/**
 * Clipboard write with fallback for stricter browsers / permission edge cases.
 */
async function mekaWriteToClipboard(text: string): Promise<void> {
  // Primary path
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Fallback path
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "true");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  document.body.appendChild(ta);

  try {
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("clipboard_fallback_failed");
  } finally {
    document.body.removeChild(ta);
  }
}

/**
 * Copies only the validated runnable region.
 */
async function mekaCopyRunnable(raw: string): Promise<void> {
  const out = mekaExtractRunnableRegion(raw);
  if (!out.ok) {
    window.alert("Copy blocked: " + out.reason);
    return;
  }
  await mekaWriteToClipboard(out.text);
}

function MekaCopyButton({
  raw,
  className,
  label = "Copy",
}: {
  raw: string;
  className?: string;
  label?: string;
}) {
  const eligibility = React.useMemo(() => mekaExtractRunnableRegion(raw), [raw]);
  const disabled = !eligibility.ok;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => mekaCopyRunnable(raw)}
        disabled={disabled}
        aria-disabled={disabled}
        className={[
          "rounded-md border px-2.5 py-1.5 text-xs font-semibold",
          disabled
            ? "cursor-not-allowed opacity-60 border-stone-200 bg-stone-50 text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400"
            : "border-stone-200 bg-white text-stone-900 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-800/60",
          className ?? "",
        ].join(" ")}
        title={disabled ? "Copy blocked: " + (eligibility as any).reason : "Copy runnable block"}
      >
        {label}
      </button>

      {!eligibility.ok ? (
        <div className="text-[11px] text-rose-700 dark:text-rose-200">Blocked: {(eligibility as any).reason}</div>
      ) : (
        <div className="text-[11px] text-stone-500 dark:text-stone-400">Runnable region detected (sentinels OK).</div>
      )}
    </div>
  );
}

type RiskLevel = "low" | "medium" | "high";

type PreparedOp = {
  root: string;
  path: string;
  touched_files: string[];
  mode: "single" | "first" | "all";
  matches: number;

  expected_hash: string;
  before_hash: string;
  after_hash: string;

  patch_unified: string;
  patch_hash: string;
  approval_id: string;

  eol: "CRLF" | "LF";
  stats: { added: number; removed: number };
  risk_level: RiskLevel;
};

type PreparedProposal = {
  ok: boolean;
  kind?: string;
  version?: number;

  title?: string;
  explanation?: string;

  risk_level?: RiskLevel;
  touched_files?: string[];
  ops?: PreparedOp[];
  generated_at?: string;

  error?: string;
  message?: string;
};

type RawProposal = {
  kind?: string;
  version?: number;
  title?: string;
  explanation?: string;
  risk_level?: RiskLevel;
  ops?: any[];
};

function RiskBadge({ risk }: { risk: RiskLevel }) {
  const cls =
    risk === "low"
      ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100"
      : risk === "medium"
      ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
      : "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100";

  return <span className={["inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold", cls].join(" ")}>{risk.toUpperCase()}</span>;
}

function safeJsonParse<T>(s: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(s) as T };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e ?? "invalid_json") };
  }
}

function uniq(list: string[]) {
  return Array.from(new Set(list));
}

export default function ChangeControlPanel() {
  const [adminToken, setAdminToken] = React.useState<string>("");
  const [proposalText, setProposalText] = React.useState<string>("");
  const [proposalObj, setProposalObj] = React.useState<RawProposal | null>(null);

  const [prepared, setPrepared] = React.useState<PreparedProposal | null>(null);
  const [previewing, setPreviewing] = React.useState<boolean>(false);
  const [applying, setApplying] = React.useState<boolean>(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [applyLog, setApplyLog] = React.useState<any[]>([]);
  const [expandedPatchIdx, setExpandedPatchIdx] = React.useState<number | null>(0);

  // One safe retry on hash mismatch
  const [didRetry, setDidRetry] = React.useState<boolean>(false);

  React.useEffect(() => {
    try {
      const t = localStorage.getItem("meka_admin_token") || "";
      const p = localStorage.getItem("meka_change_proposal") || "";
      if (t) setAdminToken(t);
      if (p) setProposalText(p);
    } catch {
      // ignore
    }
  }, []);

  React.useEffect(() => {
    try {
      localStorage.setItem("meka_admin_token", adminToken || "");
    } catch {
      // ignore
    }
  }, [adminToken]);

  React.useEffect(() => {
    try {
      localStorage.setItem("meka_change_proposal", proposalText || "");
    } catch {
      // ignore
    }
  }, [proposalText]);

  const headers = React.useMemo(() => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (adminToken?.trim()) h["Authorization"] = `Bearer ${adminToken.trim()}`;
    return h;
  }, [adminToken]);

  const parseProposal = React.useCallback(() => {
    setErr(null);
    setPrepared(null);
    setApplyLog([]);
    setDidRetry(false);

    const t = proposalText.trim();
    if (!t) {
      setProposalObj(null);
      setErr("Paste a proposal JSON first.");
      return;
    }

    const parsed = safeJsonParse<RawProposal>(t);
    if (!parsed.ok) {
      setProposalObj(null);
      setErr(`Invalid JSON: ${parsed.error}`);
      return;
    }

    const v = parsed.value;
    if (!Array.isArray(v.ops) || v.ops.length === 0) {
      setProposalObj(null);
      setErr("Proposal must include ops[] with at least 1 operation.");
      return;
    }

    setProposalObj(v);
  }, [proposalText]);

  const pasteFromClipboard = React.useCallback(async () => {
    setErr(null);
    try {
      const txt = await navigator.clipboard.readText();
      if (!txt?.trim()) {
        setErr("Clipboard is empty.");
        return;
      }
      setProposalText(txt);
    } catch (e: any) {
      setErr(String(e?.message ?? e ?? "clipboard_read_failed"));
    }
  }, []);

  const preparePreview = React.useCallback(async (): Promise<PreparedProposal | null> => {
    setErr(null);

    if (!proposalObj) {
      setErr("No proposal loaded. Click Parse Proposal first.");
      return null;
    }
    if (!adminToken?.trim()) {
      setErr("Admin token missing. Paste it into the Admin Token box.");
      return null;
    }

    setPreviewing(true);
    try {
      const res = await fetch("/api/fs/propose", {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: proposalObj.title ?? "",
          explanation: proposalObj.explanation ?? "",
          ops: proposalObj.ops,
        }),
      });

      const j = (await res.json()) as PreparedProposal;
      if (!res.ok || !j?.ok) {
        throw new Error(j?.message || j?.error || `/api/fs/propose ${res.status}`);
      }

      setPrepared(j);
      setExpandedPatchIdx(0);
      return j;
    } catch (e: any) {
      setPrepared(null);
      setErr(String(e?.message ?? e ?? "propose_failed"));
      return null;
    } finally {
      setPreviewing(false);
    }
  }, [proposalObj, adminToken, headers]);

  /**
   * Memoized apply function to avoid hook dependency drift and lint warnings.
   */
  const applyPreparedOnce = React.useCallback(
    async (p: PreparedProposal) => {
      if (!p?.ops || p.ops.length === 0) {
        throw new Error("Nothing to apply (ops empty).");
      }

      const outLog: any[] = [];

      for (let i = 0; i < p.ops.length; i++) {
        const op = p.ops[i];

        // No-op: nothing to write
        if (!op.patch_unified || !op.approval_id) {
          outLog.push({ index: i, root: op.root, path: op.path, status: "no_op" });
          continue;
        }

        const res = await fetch("/api/fs/patch", {
          method: "POST",
          headers,
          body: JSON.stringify({
            root: op.root,
            path: op.path,
            patch_unified: op.patch_unified,
            dry_run: false,
            expected_hash: op.expected_hash,
            approval_id: op.approval_id,
          }),
        });

        const j = await res.json();
        if (!res.ok || !j?.ok) {
          const msg = j?.error ? `${j.error}` : `apply_failed_${res.status}`;
          const errObj: any = new Error(msg);
          errObj.httpStatus = res.status;
          errObj.payload = j;
          throw errObj;
        }

        outLog.push({ index: i, root: op.root, path: op.path, result: j });
      }

      return outLog;
    },
    [headers]
  );

  const apply = React.useCallback(async () => {
    setErr(null);
    setApplying(true);

    try {
      // If no prepared proposal yet, do preview first (authoritative).
      const p0 = prepared?.ok ? prepared : await preparePreview();
      if (!p0?.ok) throw new Error("Preview/prepare did not produce an applyable proposal.");

      // Attempt apply
      const log1 = await applyPreparedOnce(p0);
      setApplyLog(log1);
      return;
    } catch (e: any) {
      // One safe retry on hash mismatch
      const payload = e?.payload;
      const isHashMismatch =
        (e?.httpStatus === 409 && payload?.error === "hash_mismatch") || String(e?.message || "").includes("hash_mismatch");

      if (isHashMismatch && !didRetry) {
        setDidRetry(true);
        try {
          const p1 = await preparePreview(); // re-propose against latest file hashes
          if (!p1?.ok) throw new Error("Retry preview failed.");

          const log2 = await applyPreparedOnce(p1);
          setApplyLog(log2);
          return;
        } catch (e2: any) {
          setErr(String(e2?.message ?? e2 ?? "retry_apply_failed"));
          setApplyLog([]);
          return;
        }
      }

      setErr(String(e?.message ?? e ?? "apply_failed"));
      setApplyLog([]);
    } finally {
      setApplying(false);
    }
  }, [prepared, preparePreview, applyPreparedOnce, didRetry]);

  const touched = uniq([...(prepared?.touched_files ?? []), ...(prepared?.ops?.flatMap((o) => o.touched_files ?? []) ?? [])]);
  const risk = (prepared?.risk_level ?? proposalObj?.risk_level ?? "medium") as RiskLevel;

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Change Control</h3>
          <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">Load a structured proposal, Preview (no write), then Apply (guarded write).</p>
        </div>
        <div className="flex items-center gap-2">
          <RiskBadge risk={risk} />
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <label className="block text-xs font-semibold text-stone-700 dark:text-stone-200">Admin Token</label>
          <input
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            placeholder="MEKA_ADMIN_TOKEN (Bearer)"
            className="mt-1 w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-xs text-stone-900 shadow-sm dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
            type="password"
          />
          <div className="mt-1 text-[11px] text-stone-600 dark:text-stone-300">Stored locally in your browser. Required for Preview/Apply.</div>
        </div>

        <div>
          <div className="flex items-center justify-between gap-2">
            <label className="block text-xs font-semibold text-stone-700 dark:text-stone-200">Proposal JSON</label>
            <button
              type="button"
              onClick={pasteFromClipboard}
              className="rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-stone-800 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-800/60"
            >
              Paste from Clipboard
            </button>
          </div>

          <textarea
            value={proposalText}
            onChange={(e) => setProposalText(e.target.value)}
            placeholder='Paste the assistant proposal object here (JSON). Example: {"kind":"meka.change_proposal","version":1,"title":"...","ops":[...]}'
            className="mt-1 h-40 w-full rounded-md border border-stone-200 bg-white p-3 font-mono text-[11px] text-stone-900 shadow-sm dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
          />

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={parseProposal}
              className="rounded-md border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-900 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-800/60"
            >
              Parse Proposal
            </button>

            <button
              type="button"
              disabled={!proposalObj || previewing}
              onClick={() => preparePreview()}
              className={[
                "rounded-md border px-3 py-2 text-xs font-semibold",
                "border-stone-900 bg-stone-900 text-white hover:bg-stone-800 dark:border-stone-200 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200",
                !proposalObj || previewing ? "opacity-60 cursor-not-allowed" : "",
              ].join(" ")}
            >
              {previewing ? "Previewing…" : "Preview (no write)"}
            </button>

            <button
              type="button"
              disabled={applying}
              onClick={apply}
              className={[
                "rounded-md border px-3 py-2 text-xs font-semibold",
                "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800 dark:border-emerald-300 dark:bg-emerald-300 dark:text-emerald-950 dark:hover:bg-emerald-200",
                applying ? "opacity-60 cursor-not-allowed" : "",
              ].join(" ")}
            >
              {applying ? "Applying…" : didRetry ? "Apply (retried)" : "Apply"}
            </button>
          </div>
        </div>

        {err && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-900/60 dark:bg-rose-900/20 dark:text-rose-100">
            <div className="font-semibold">Error</div>
            <div className="mt-1">{err}</div>
          </div>
        )}

        {prepared?.ok && (
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-950">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-semibold text-stone-900 dark:text-stone-100">Prepared Proposal</div>
              <div className="text-[11px] text-stone-600 dark:text-stone-300">{prepared.generated_at || ""}</div>
            </div>

            <div className="mt-2 text-xs text-stone-700 dark:text-stone-200">
              <div>
                <span className="font-semibold">Title:</span> {prepared.title || "—"}
              </div>
              <div className="mt-1">
                <span className="font-semibold">Explanation:</span> {prepared.explanation || "—"}
              </div>
            </div>

            <div className="mt-3">
              <div className="text-[11px] font-semibold text-stone-700 dark:text-stone-200">Touched files</div>
              <ul className="mt-1 space-y-1 text-[11px] text-stone-700 dark:text-stone-200">
                {touched.length ? touched.map((f) => <li key={f} className="font-mono">{f}</li>) : <li>—</li>}
              </ul>
            </div>

            <div className="mt-3">
              <div className="text-[11px] font-semibold text-stone-700 dark:text-stone-200">Patches</div>
              <div className="mt-2 space-y-3">
                {(prepared.ops || []).map((op, idx) => (
                  <div
                    key={`${op.root}/${op.path}/${idx}`}
                    className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-900"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-stone-900 dark:text-stone-100">
                        <span className="font-mono">{op.root}/{op.path}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <RiskBadge risk={op.risk_level} />
                        <button
                          type="button"
                          onClick={() => setExpandedPatchIdx(expandedPatchIdx === idx ? null : idx)}
                          className="rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-stone-800 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-800/60"
                        >
                          {expandedPatchIdx === idx ? "Hide Patch" : "Show Patch"}
                        </button>
                      </div>
                    </div>

                    <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-stone-700 dark:text-stone-200">
                      <div>
                        <span className="font-semibold">Expected hash:</span> <span className="font-mono">{op.expected_hash}</span>
                      </div>
                      <div>
                        <span className="font-semibold">Approval:</span> <span className="font-mono">{op.approval_id || "—"}</span>
                      </div>
                      <div>
                        <span className="font-semibold">Stats:</span> +{op.stats.added} / -{op.stats.removed}
                      </div>
                      <div>
                        <span className="font-semibold">EOL:</span> {op.eol}
                      </div>
                    </div>

                    {expandedPatchIdx === idx && (
                      <div className="mt-3 space-y-3">
                        <pre className="max-h-64 overflow-auto rounded-lg bg-stone-950 p-3 text-[11px] text-stone-100">
                          {op.patch_unified || "(no-op)"}
                        </pre>

                        {/* Optional: copy runnable blocks from patches if you embed sentinels in your explanations */}
                        <div className="flex items-center justify-between">
                          <div className="text-[11px] text-stone-600 dark:text-stone-300">Copy guard requires ### RUN: ... ### END RUN.</div>
                          <MekaCopyButton raw={op.patch_unified || ""} label="Copy Runnable" />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {applyLog.length > 0 && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-900/20 dark:text-emerald-100">
            <div className="font-semibold">Apply results</div>
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-stone-950 p-3 text-[11px] text-stone-100">
              {JSON.stringify(applyLog, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

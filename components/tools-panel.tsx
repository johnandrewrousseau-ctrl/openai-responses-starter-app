"use client";

import React from "react";
import FileSearchSetup from "./file-search-setup";
import WebSearchConfig from "./websearch-config";
import FunctionsView from "./functions-view";
import McpConfig from "./mcp-config";
import PanelConfig from "./panel-config";
import useToolsStore from "@/stores/useToolsStore";
import GoogleIntegrationPanel from "@/components/google-integration";
import ChangeControlPanel from "./change-control-panel";

type CanonOpsSummary = {
  ok: boolean;
  generated_at?: string;
  artifact_count?: number;
  tombstones_count?: number;
  supersedes_count?: number;

  collisions_total?: number;
  collisions_categories?: Record<string, number>;
};

type CanonOpsCollisions = {
  ok: boolean;
  generated_at?: string;
  collisions_total?: number;
  collisions_categories?: Record<string, number>;
  collisions?: Record<string, any[]>;
};

type StatePackSummary = {
  ok: boolean;
  updated_at?: string | null;
  mode?: string | null;
  session_id?: string | null;
  queue_counts?: { now: number; next: number; parked: number };
  events_count?: number;
  notes_tail?: string;
  error?: string;
  message?: string;
};

type RetrievalTraceSummary = {
  ok: boolean;
  present?: boolean;
  message?: string;
  lines_scanned?: number;
  lines_parsed?: number;
  last_request?: {
    ts?: string | null;
    truth_policy?: string | null;
    anchor_kind?: string | null;
    vector_store_ids_active?: string[];
    routing_overlay_applied?: boolean;
    inv_sha12?: string | null;
    last_user_text?: string | null;
  } | null;
  last_request_event_counts?: Record<string, number>;
  last_request_toolish_events?: number;
  error?: string;
};

type ToolStatusResponse = {
    requested_tools_state?: {
    fileSearchEnabled?: boolean;
    webSearchEnabled?: boolean;
    functionsEnabled?: boolean;
    googleIntegrationEnabled?: boolean;
    mcpEnabled?: boolean;
    codeInterpreterEnabled?: boolean;
  };
  effective_tools_state?: {
    fileSearchEnabled?: boolean;
    webSearchEnabled?: boolean;
    functionsEnabled?: boolean;
    googleIntegrationEnabled?: boolean;
    mcpEnabled?: boolean;
    codeInterpreterEnabled?: boolean;
  };
ok: boolean;
  chat_tools_registered?: {
    "fs.propose_change"?: boolean;
    "fs.read"?: boolean;
    "fs.prepare"?: boolean;
    "fs.patch"?: boolean;
    "fs.replace"?: boolean;
  };
  tool_names?: string[];
  tools?: string[]; // fallback for response-shape drift
  admin_token_status?: "OK" | "INVALID";
  server_local_request_status?: "OK" | "BLOCKED";
  functions_enabled?: boolean;
  error?: string;
  message?: string;
};

function getAdminTokenFromStorage(): string {
  try {
    const keys = ["meka_admin_token", "MEKA_ADMIN_TOKEN", "admin_token"];
    for (const k of keys) {
      const v = localStorage.getItem(k);
      if (v && v.trim()) return v.trim();
    }
  } catch {
    // ignore
  }
  return "";
}

function fmtTs(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function nonZeroCategories(map?: Record<string, number>) {
  if (!map) return [];
  return Object.entries(map)
    .filter(([, v]) => typeof v === "number" && v > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
}

function pickTop(map?: Record<string, number>, n = 6) {
  const nz = nonZeroCategories(map);
  return nz.slice(0, n);
}

function SafeBadge({ ok }: { ok: boolean }) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        ok
          ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100"
          : "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100",
      ].join(" ")}
    >
      {ok ? "OK" : "ATTN"}
    </span>
  );
}

function CardShell({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">{title}</h3>
          </div>
          {subtitle ? (
            <div className="mt-1 text-xs text-stone-600 dark:text-stone-300">{subtitle}</div>
          ) : null}
        </div>
        {right ? <div className="flex items-center gap-2">{right}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={[
        "rounded-md border px-2.5 py-1.5 text-xs font-medium",
        "border-stone-200 bg-white text-stone-800 hover:bg-stone-50",
        "dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-800/60",
        disabled ? "opacity-60 cursor-not-allowed" : "",
      ].join(" ")}
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      type="button"
    >
      {children}
    </button>
  );
}

function CanonOpsStatusCard() {
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [ops, setOps] = React.useState<CanonOpsSummary | null>(null);
  const [col, setCol] = React.useState<CanonOpsCollisions | null>(null);
  const [showRaw, setShowRaw] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setErr(null);

    try {
      const r1 = await fetch("/api/canon_ops", { cache: "no-store" });
      if (!r1.ok) throw new Error(`/api/canon_ops ${r1.status}`);
      const j1 = (await r1.json()) as CanonOpsSummary;
      setOps(j1);

      const r2 = await fetch("/api/canon_ops/collisions", { cache: "no-store" });
      if (!r2.ok) throw new Error(`/api/canon_ops/collisions ${r2.status}`);
      const j2 = (await r2.json()) as CanonOpsCollisions;
      setCol(j2);
    } catch (e: any) {
      setErr(String(e?.message ?? e ?? "unknown_error"));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const collisionsTotal = (col?.collisions_total ?? ops?.collisions_total ?? 0) as number;
  const cats = col?.collisions_categories ?? ops?.collisions_categories ?? undefined;
  const topCats = pickTop(cats, 8);

  const ok = Boolean((ops?.ok ?? col?.ok) && collisionsTotal === 0);

  return (
    <CardShell
      title="Canon Ops Status"
      subtitle={
        <>
          Read-only health snapshot from <span className="font-mono">/api/canon_ops</span>.
        </>
      }
      right={
        <>
          <SafeBadge ok={ok} />
          <SmallButton onClick={refresh} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </SmallButton>
          <SmallButton onClick={() => setShowRaw((v) => !v)}>{showRaw ? "Hide Raw" : "Show Raw"}</SmallButton>
        </>
      }
    >
      {err ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 dark:border-rose-900/60 dark:bg-rose-900/20">
          <div className="text-xs font-semibold text-rose-900 dark:text-rose-100">Panel error</div>
          <div className="mt-1 text-xs text-rose-900 dark:text-rose-100">{err}</div>
          <div className="mt-2 text-[11px] text-rose-900/80 dark:text-rose-100/80">
            Confirm the Next server is running and the routes exist.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
            <div className="text-[11px] text-stone-600 dark:text-stone-400">Generated</div>
            <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
              {fmtTs(ops?.generated_at ?? col?.generated_at) || "-"}
            </div>
          </div>

          <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
            <div className="text-[11px] text-stone-600 dark:text-stone-400">Collisions</div>
            <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">{collisionsTotal}</div>
          </div>

          <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
            <div className="text-[11px] text-stone-600 dark:text-stone-400">Artifacts</div>
            <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
              {typeof ops?.artifact_count === "number" ? ops.artifact_count : "-"}
            </div>
          </div>

          <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
            <div className="text-[11px] text-stone-600 dark:text-stone-400">Supersedes / Tombstones</div>
            <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
              {(ops?.supersedes_count ?? 0).toString()} / {(ops?.tombstones_count ?? 0).toString()}
            </div>
          </div>
        </div>
      )}

      {!err && topCats.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-900/20">
          <div className="text-xs font-semibold text-amber-900 dark:text-amber-100">Non-zero collision categories</div>
          <ul className="mt-2 space-y-1 text-xs text-amber-900 dark:text-amber-100">
            {topCats.map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-2">
                <span className="font-mono">{k}</span>
                <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-semibold dark:bg-amber-900/40">
                  {v}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!err && showRaw && (
        <div className="mt-3 space-y-3">
          <div>
            <div className="text-xs font-semibold text-stone-900 dark:text-stone-100">Raw: /api/canon_ops</div>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-stone-950 p-3 text-[11px] text-stone-100">
              {JSON.stringify(ops, null, 2)}
            </pre>
          </div>
          <div>
            <div className="text-xs font-semibold text-stone-900 dark:text-stone-100">
              Raw: /api/canon_ops/collisions
            </div>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-stone-950 p-3 text-[11px] text-stone-100">
              {JSON.stringify(col, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </CardShell>
  );
}

function RuntimeStateCard() {
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [sp, setSp] = React.useState<StatePackSummary | null>(null);
  const [showRaw, setShowRaw] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/state_pack", { cache: "no-store" });
      const j = (await r.json()) as StatePackSummary;
      if (!r.ok || !j?.ok) {
        throw new Error((j as any)?.error || `/api/state_pack ${r.status}`);
      }
      setSp(j);
    } catch (e: any) {
      setErr(String(e?.message ?? e ?? "unknown_error"));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const ok = Boolean(sp?.ok);

  return (
    <CardShell
      title="Runtime State"
      subtitle={
        <>
          Durable continuity snapshot from <span className="font-mono">/api/state_pack</span>.
        </>
      }
      right={
        <>
          <SafeBadge ok={ok} />
          <SmallButton onClick={refresh} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </SmallButton>
          <SmallButton onClick={() => setShowRaw((v) => !v)}>{showRaw ? "Hide Raw" : "Show Raw"}</SmallButton>
        </>
      }
    >
      {err ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 dark:border-rose-900/60 dark:bg-rose-900/20">
          <div className="text-xs font-semibold text-rose-900 dark:text-rose-100">Panel error</div>
          <div className="mt-1 text-xs text-rose-900 dark:text-rose-100">{err}</div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
            <div className="text-[11px] text-stone-600 dark:text-stone-400">Updated</div>
            <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
              {fmtTs(sp?.updated_at ?? undefined) || "-"}
            </div>
          </div>

          <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
            <div className="text-[11px] text-stone-600 dark:text-stone-400">Mode</div>
            <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">{sp?.mode ?? "-"}</div>
          </div>

          <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
            <div className="text-[11px] text-stone-600 dark:text-stone-400">Session</div>
            <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
              <span className="font-mono">{sp?.session_id ?? "-"}</span>
            </div>
          </div>

          <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
            <div className="text-[11px] text-stone-600 dark:text-stone-400">Queue (now/next/parked)</div>
            <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
              {(sp?.queue_counts?.now ?? 0).toString()} / {(sp?.queue_counts?.next ?? 0).toString()} /{" "}
              {(sp?.queue_counts?.parked ?? 0).toString()}
            </div>
          </div>

          <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950 col-span-2">
            <div className="text-[11px] text-stone-600 dark:text-stone-400">Events</div>
            <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
              {(sp?.events_count ?? 0).toString()}
            </div>
          </div>
        </div>
      )}

      {!err && showRaw && (
        <div className="mt-3">
          <div className="text-xs font-semibold text-stone-900 dark:text-stone-100">Raw: /api/state_pack</div>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-stone-950 p-3 text-[11px] text-stone-100">
            {JSON.stringify(sp, null, 2)}
          </pre>
        </div>
      )}
    </CardShell>
  );
}

function RetrievalTraceCard() {
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [rt, setRt] = React.useState<RetrievalTraceSummary | null>(null);
  const [showRaw, setShowRaw] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await (() => {
        const adminToken = getAdminTokenFromStorage();
        const headers: Record<string, string> = {};
        if (adminToken) headers["Authorization"] = "Bearer " + adminToken;

        return fetch("/api/retrieval_trace", {
          cache: "no-store",
          headers,
        });
      })();
      const j = (await r.json()) as RetrievalTraceSummary;
      if (!r.ok || !j?.ok) {
        throw new Error((j as any)?.error || `/api/retrieval_trace ${r.status}`);
      }
      setRt(j);
    } catch (e: any) {
      setErr(String(e?.message ?? e ?? "unknown_error"));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const present = Boolean(rt?.present);
  const ok = Boolean(rt?.ok);

  const req = rt?.last_request ?? null;

  return (
    <CardShell
      title="Retrieval Trace"
      subtitle={
        <>
          Last-request summary from <span className="font-mono">/api/retrieval_trace</span>.
        </>
      }
      right={
        <>
          <SafeBadge ok={ok} />
          <SmallButton onClick={refresh} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </SmallButton>
          <SmallButton onClick={() => setShowRaw((v) => !v)}>{showRaw ? "Hide Raw" : "Show Raw"}</SmallButton>
        </>
      }
    >
      {err ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 dark:border-rose-900/60 dark:bg-rose-900/20">
          <div className="text-xs font-semibold text-rose-900 dark:text-rose-100">Panel error</div>
          <div className="mt-1 text-xs text-rose-900 dark:text-rose-100">{err}</div>
        </div>
      ) : !present ? (
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-stone-700 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-200">
          {rt?.message || "retrieval_tap.jsonl not present. Enable MEKA_RETRIEVAL_TAP=1 to populate."}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
              <div className="text-[11px] text-stone-600 dark:text-stone-400">Last request</div>
              <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
                {fmtTs(req?.ts ?? undefined) || "-"}
              </div>
            </div>

            <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
              <div className="text-[11px] text-stone-600 dark:text-stone-400">Truth policy</div>
              <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
                <span className="font-mono">{req?.truth_policy ?? "-"}</span>
              </div>
            </div>

            <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
              <div className="text-[11px] text-stone-600 dark:text-stone-400">Stores active</div>
              <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
                <span className="font-mono">{(req?.vector_store_ids_active ?? []).join(", ") || "-"}</span>
              </div>
            </div>

            <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
              <div className="text-[11px] text-stone-600 dark:text-stone-400">Overlay applied</div>
              <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
                {req?.routing_overlay_applied ? "true" : "false"}
              </div>
            </div>

            <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950 col-span-2">
              <div className="text-[11px] text-stone-600 dark:text-stone-400">Invocation</div>
              <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
                <span className="font-mono">{req?.inv_sha12 ?? "-"}</span>
              </div>
            </div>
          </div>

          {typeof rt?.last_request_toolish_events === "number" && (
            <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-950">
              <div className="text-[11px] text-stone-600 dark:text-stone-400">Toolish events</div>
              <div className="mt-0.5 text-xs font-medium text-stone-900 dark:text-stone-100">
                {rt.last_request_toolish_events}
              </div>
            </div>
          )}
        </div>
      )}

      {!err && showRaw && (
        <div className="mt-3">
          <div className="text-xs font-semibold text-stone-900 dark:text-stone-100">Raw: /api/retrieval_trace</div>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-stone-950 p-3 text-[11px] text-stone-100">
            {JSON.stringify(rt, null, 2)}
          </pre>
        </div>
      )}
    </CardShell>
  );
}

export default function ToolsPanel() {
  const {
    fileSearchEnabled,
    setFileSearchEnabled,
    webSearchEnabled,
    setWebSearchEnabled,
    functionsEnabled,
    setFunctionsEnabled,
    googleIntegrationEnabled,
    setGoogleIntegrationEnabled,
    mcpEnabled,
    setMcpEnabled,
    codeInterpreterEnabled,
    setCodeInterpreterEnabled,
  } = useToolsStore();

  const [oauthConfigured, setOauthConfigured] = React.useState<boolean>(false);

  const [toolStatusLoading, setToolStatusLoading] = React.useState(false);
  const [toolStatusErr, setToolStatusErr] = React.useState<string | null>(null);
  const [toolStatus, setToolStatus] = React.useState<ToolStatusResponse | null>(null);

  const refreshToolStatus = React.useCallback(async () => {
    setToolStatusLoading(true);
    setToolStatusErr(null);

    try {
      const adminToken = getAdminTokenFromStorage();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (adminToken) headers["Authorization"] = "Bearer " + adminToken;

      // /api/tool_status expects tool flags under `toolsState` (wrapper object).
      const res = await fetch("/api/tool_status", {
        method: "POST",
        headers,
        cache: "no-store",
        body: JSON.stringify({
          toolsState: {
            fileSearchEnabled: Boolean(fileSearchEnabled),
            webSearchEnabled: Boolean(webSearchEnabled),
            functionsEnabled: Boolean(functionsEnabled),
            googleIntegrationEnabled: Boolean(googleIntegrationEnabled),
            mcpEnabled: Boolean(mcpEnabled),
            codeInterpreterEnabled: Boolean(codeInterpreterEnabled),
          },
        }),
      });

      const j = (await res.json()) as ToolStatusResponse;
      if (!res.ok || !j?.ok) {
        throw new Error((j as any)?.error || (j as any)?.message || "/api/tool_status " + res.status);
      }
      setToolStatus(j);
    } catch (e: any) {
      setToolStatusErr(String(e?.message ?? e ?? "unknown_error"));
      setToolStatus(null);
    } finally {
      setToolStatusLoading(false);
    }
  }, [
    fileSearchEnabled,
    webSearchEnabled,
    functionsEnabled,
    googleIntegrationEnabled,
    mcpEnabled,
    codeInterpreterEnabled,
  ]);

  React.useEffect(() => {
    refreshToolStatus();
  }, [refreshToolStatus]);

  const yesNo = (v?: boolean) => (v ? "YES" : "NO");

  // Simple vs Advanced: default Simple for drift control + reduced confusion.
  const [advanced, setAdvanced] = React.useState<boolean>(false);

  React.useEffect(() => {
    try {
      const v = localStorage.getItem("meka_tools_advanced");
      if (v === "1") setAdvanced(true);
    } catch {
      // ignore
    }
  }, []);

  React.useEffect(() => {
    try {
      localStorage.setItem("meka_tools_advanced", advanced ? "1" : "0");
    } catch {
      // ignore
    }
  }, [advanced]);

  React.useEffect(() => {
    fetch("/api/google/status")
      .then((r) => r.json())
      .then((d) => setOauthConfigured(Boolean(d?.oauthConfigured)))
      .catch(() => setOauthConfigured(false));
  }, []);

  const toolNames = toolStatus?.tool_names ?? toolStatus?.tools ?? [];

  return (
    <div className="h-full w-full rounded-t-xl md:rounded-none border-l-1 border-stone-100 p-6 bg-[#f9f9f9] dark:bg-stone-950 dark:border-stone-800">
      <div className="flex h-full flex-col gap-4 overflow-y-auto">
        {/* Header */}
        <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">MEKA Controls</h2>
              <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">
                Simple keeps the interface clean and stable. Advanced exposes power features.
              </p>
              <div className="mt-2 rounded-lg bg-stone-50 p-3 text-[11px] text-stone-700 dark:bg-stone-950 dark:text-stone-200">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold">Tool Status</div>
                  <button
                    type="button"
                    onClick={refreshToolStatus}
                    className="rounded-md border border-stone-200 bg-white px-2 py-1 text-[11px] font-semibold text-stone-900 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800/60"
                    disabled={toolStatusLoading}
                    aria-disabled={toolStatusLoading}
                    title="Refresh tool status"
                  >
                    {toolStatusLoading ? "Refreshing..." : "Refresh"}
                  </button>
                </div>

                {toolStatusErr ? (
                  <div className="mt-2 text-[11px] text-rose-700 dark:text-rose-200">{toolStatusErr}</div>
                ) : toolStatus ? (
                  <div className="mt-2 space-y-1">
                    <div>
                      Chat tools registered:{" "}
                      <span className="font-mono">
                        fs.read={yesNo(toolStatus.chat_tools_registered?.["fs.read"])},{" "}
                        fs.prepare={yesNo(toolStatus.chat_tools_registered?.["fs.prepare"])},{" "}
                        fs.patch={yesNo(toolStatus.chat_tools_registered?.["fs.patch"])},{" "}
                        fs.propose_change={yesNo(toolStatus.chat_tools_registered?.["fs.propose_change"])},{" "}
                        fs.replace={yesNo(toolStatus.chat_tools_registered?.["fs.replace"])}
                      </span>
                    </div>
                    <div>
                      {(() => {
                        const reqV =
                          (toolStatus as any)?.requested_tools_state?.functionsEnabled ??
                          (toolStatus as any)?.requested_tools_state?.functions_enabled ??
                          (toolStatus as any)?.functions_enabled;

                        const effV =
                          (toolStatus as any)?.effective_tools_state?.functionsEnabled ??
                          (toolStatus as any)?.functions_enabled;

                        const drift = typeof reqV === "boolean" && typeof effV === "boolean" && reqV !== effV;

                        return (
                          <div className="space-y-0.5">
                            <div>
                              Functions enabled (requested): <span className="font-mono">{reqV ? "true" : "false"}</span>
                            </div>
                            <div>
                              Functions enabled (effective): <span className="font-mono">{effV ? "true" : "false"}</span>
                              {drift ? <span className="ml-2 font-semibold text-rose-700 dark:text-rose-200">DRIFT</span> : null}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    <div>
                      Tool names: <span className="font-mono">{toolNames.length ? toolNames.join(", ") : "(none)"}</span>
                    </div>
                    <div>
                      Admin token status: <span className="font-mono">{toolStatus.admin_token_status ?? "-"}</span>
                    </div>
                    <div>
                      Server local request status:{" "}
                      <span className="font-mono">{toolStatus.server_local_request_status ?? "-"}</span>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 text-[11px] text-stone-600 dark:text-stone-300">-</div>
                )}
              </div>
            </div>

            <button
              onClick={() => setAdvanced((v) => !v)}
              className={[
                "rounded-md border px-3 py-1.5 text-xs font-semibold",
                advanced
                  ? "border-stone-900 bg-stone-900 text-white hover:bg-stone-800 dark:border-stone-200 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
                  : "border-stone-200 bg-white text-stone-900 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-800/60",
              ].join(" ")}
              type="button"
            >
              {advanced ? "Advanced: ON" : "Advanced: OFF"}
            </button>
          </div>

          {!advanced && (
            <div className="mt-3 rounded-lg bg-stone-50 p-3 text-xs text-stone-700 dark:bg-stone-950 dark:text-stone-200">
              Recommended default for your current phase: build canon safely, minimize accidental tool paths.
            </div>
          )}
        </div>

        {/* Governance snapshot always visible */}
        <CanonOpsStatusCard />

        {/* Observability always visible (read-only) */}
        <RuntimeStateCard />
        <RetrievalTraceCard />

        {/* Change control cockpit */}
        <ChangeControlPanel />

        {/* SIMPLE: Retrieval + core execution */}
        <PanelConfig
          title="File Search"
          tooltip="Vector-store retrieval over your Canon/Threads/Manifest (your durable knowledge substrate)."
          enabled={fileSearchEnabled}
          setEnabled={setFileSearchEnabled}
        >
          <FileSearchSetup />
        </PanelConfig>

        <PanelConfig
          title="Web Search"
          tooltip="Internet retrieval for fresh, volatile info (docs, specs, current events)."
          enabled={webSearchEnabled}
          setEnabled={setWebSearchEnabled}
        >
          <WebSearchConfig />
        </PanelConfig>

        <PanelConfig
          title="Functions"
          tooltip="Allows locally defined function endpoints (your app/api/functions/* routes) to be called by the model."
          enabled={functionsEnabled}
          setEnabled={setFunctionsEnabled}
        >
          <FunctionsView />
        </PanelConfig>

        {/* ADVANCED: Power features */}
        {advanced && (
          <>
            <PanelConfig
              title="Code Interpreter"
              tooltip="Allows the assistant to run code for calculations, transforms, and structured processing."
              enabled={codeInterpreterEnabled}
              setEnabled={setCodeInterpreterEnabled}
            />

            <PanelConfig
              title="MCP"
              tooltip="Remote tool servers via Model Context Protocol (power feature; higher operational risk)."
              enabled={mcpEnabled}
              setEnabled={setMcpEnabled}
            >
              <McpConfig />
            </PanelConfig>

            <PanelConfig
              title="Google Integration"
              tooltip="OAuth connection for Gmail/Calendar workflows (only available when configured)."
              enabled={oauthConfigured && googleIntegrationEnabled}
              setEnabled={setGoogleIntegrationEnabled}
              disabled={!oauthConfigured}
            >
              <GoogleIntegrationPanel />
            </PanelConfig>
          </>
        )}
      </div>
    </div>
  );
}



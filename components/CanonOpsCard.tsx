"use client";

import React, { useEffect, useMemo, useState } from "react";

type CanonOpsSummary = {
  ok: boolean;
  generated_at: string;
  artifact_count: number;
  tombstones_count: number;
  supersedes_count: number;
  collisions_total: number;
  collisions_categories: Record<string, number>;
};

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ok"; data: CanonOpsSummary };

function fmtTs(ts: string) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString();
}

function nonZeroCats(cats: Record<string, number>) {
  const out: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(cats || {})) {
    if ((v ?? 0) > 0) out.push([k, v]);
  }
  out.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return out;
}

export default function CanonOpsCard() {
  const [st, setSt] = useState<LoadState>({ status: "idle" });
  const [expanded, setExpanded] = useState(false);

  async function load() {
    setSt({ status: "loading" });
    try {
      const res = await fetch("/api/canon_ops", { method: "GET" });
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      const body = ct.includes("application/json") ? await res.json() : await res.text();

      if (!res.ok) {
        setSt({
          status: "error",
          error:
            typeof body === "string"
              ? body
              : JSON.stringify(body ?? { error: res.statusText }, null, 2),
        });
        return;
      }

      const data = body as CanonOpsSummary;

      // Defensive shape checks (prevents UI silently rendering nonsense)
      if (!data || typeof data !== "object") {
        setSt({ status: "error", error: "Invalid /api/canon_ops payload (not an object)." });
        return;
      }
      if (typeof data.ok !== "boolean") {
        setSt({ status: "error", error: "Invalid /api/canon_ops payload: missing ok:boolean." });
        return;
      }

      setSt({ status: "ok", data });
    } catch (e: any) {
      setSt({ status: "error", error: String(e?.message ?? e ?? "unknown_error") });
    }
  }

  useEffect(() => {
    load();
  }, []);

  const nz = useMemo(() => {
    if (st.status !== "ok") return [];
    return nonZeroCats(st.data.collisions_categories || {});
  }, [st]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-100">Canon Ops</div>
          <div className="text-xs text-zinc-400">
            Supersession + Tombstones + Collisions (drift-control guardrails)
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-900"
            onClick={() => load()}
            disabled={st.status === "loading"}
          >
            Refresh
          </button>
          <button
            className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-900"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide" : "Details"}
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
          <div className="text-[11px] text-zinc-400">Status</div>
          <div className="text-sm text-zinc-100">
            {st.status === "loading" && "Loading…"}
            {st.status === "error" && "Error"}
            {st.status === "ok" && (st.data.ok ? "OK" : "Not OK")}
            {st.status === "idle" && "Idle"}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
          <div className="text-[11px] text-zinc-400">Generated</div>
          <div className="text-sm text-zinc-100">
            {st.status === "ok" ? fmtTs(st.data.generated_at) : "—"}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
          <div className="text-[11px] text-zinc-400">Artifacts</div>
          <div className="text-sm text-zinc-100">{st.status === "ok" ? st.data.artifact_count : "—"}</div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
          <div className="text-[11px] text-zinc-400">Collisions</div>
          <div className="text-sm text-zinc-100">
            {st.status === "ok" ? st.data.collisions_total : "—"}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
          <div className="text-[11px] text-zinc-400">Tombstones</div>
          <div className="text-sm text-zinc-100">
            {st.status === "ok" ? st.data.tombstones_count : "—"}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
          <div className="text-[11px] text-zinc-400">Supersedes</div>
          <div className="text-sm text-zinc-100">
            {st.status === "ok" ? st.data.supersedes_count : "—"}
          </div>
        </div>
      </div>

      {st.status === "error" && (
        <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-zinc-800 bg-black/40 p-3 text-xs text-zinc-200">
{st.error}
        </pre>
      )}

      {st.status === "ok" && expanded && (
        <div className="mt-3">
          <div className="text-xs font-semibold text-zinc-200">Non-zero collision categories</div>
          {nz.length === 0 ? (
            <div className="mt-1 text-xs text-zinc-400">None</div>
          ) : (
            <ul className="mt-1 space-y-1 text-xs text-zinc-200">
              {nz.map(([k, v]) => (
                <li key={k} className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/20 px-2 py-1">
                  <span className="font-mono">{k}</span>
                  <span className="font-mono">{v}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 text-[11px] text-zinc-500">
            If collisions &gt; 0: open /api/canon_ops/collisions for the full records.
          </div>
        </div>
      )}
    </div>
  );
}

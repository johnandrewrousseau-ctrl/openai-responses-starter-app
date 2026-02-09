export const runtime = "nodejs";

import { getDeveloperPrompt, MODEL } from "@/config/constants";
import { getTools } from "@/lib/tools/tools";
import { createResponseWithRetry, MEKA_BUDGETS } from "@/lib/openai_client";
import { resolveTruthSourcePolicy } from "@/config/truth_sources";
import { createHash, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";
import { stripWritebackBlocks } from "@/lib/sanitize_output";
import { functionsMap } from "@/config/functions";

function getAuthHeader(req: Request): string {
  return String(req.headers.get("authorization") || req.headers.get("Authorization") || "").trim();
}

function getBearerTokenFromHeader(h: string): string {
  const m = h.match(/^Bearer\s+(.+)\s*$/i);
  return (m?.[1] || "").trim();
}

function safeEq(a: string, b: string): boolean {
  try {
    const aa = Buffer.from(a || "", "utf8");
    const bb = Buffer.from(b || "", "utf8");
    if (aa.length !== bb.length) return false;
    return timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function isAdminRequest(req: Request): boolean {
  const expected = String(process.env.MEKA_ADMIN_TOKEN || "").trim();
  if (!expected) return false;
  const got = getBearerTokenFromHeader(getAuthHeader(req));
  return Boolean(got) && safeEq(got, expected);
}

// DEV: allow function tools without Authorization ONLY for loopback dev.
// Production safety: bypass is impossible when NODE_ENV or VERCEL_ENV indicates production.
const IS_PROD =
  String(process.env.VERCEL_ENV || "").trim() === "production" ||
  String(process.env.NODE_ENV || "").trim() === "production";

const DEV_ALLOW_TOOLS_NO_AUTH =
  !IS_PROD && String(process.env.MEKA_DEV_ALLOW_TOOLS_WITHOUT_AUTH || "").trim() === "1";
function isLoopbackRequest(req: Request): boolean {
  try {
    const u = new URL(req.url);
    const h = (u.hostname || "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

/**
 * Tool authorization gate:
 * - Admin header always works
 * - Dev override works only when explicitly enabled + request is loopback
 */
function isToolsAuthorized(req: Request): boolean {
  // Admin header always works.
  if (isAdminRequest(req)) return true;

  // Production safety: bypass is impossible regardless of env vars.
  if (IS_PROD) return false;

  // Dev override only when explicitly enabled AND request is loopback.
  if (!DEV_ALLOW_TOOLS_NO_AUTH) return false;
  return isLoopbackRequest(req);
}
type FunctionCallItem = {
  type: "function_call";
  name: string;
  arguments: string; // JSON string
  call_id: string;
};

type FunctionCallOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: string; // JSON string
};

function safeJsonParse(s: string): any {
  try {
    return JSON.parse(stripBom(s || ""));
  } catch {
    return null;
  }
}

function riskFromPath(root: string, p: string): "LOW" | "MEDIUM" | "HIGH" {
  const full = `${root}/${p}`.toLowerCase();

  // Conservative heuristics:
  if (full.includes("app/api/") || full.includes("lib/openai") || full.includes("auth")) return "HIGH";
  if (full.endsWith(".ts") || full.endsWith(".tsx")) return "MEDIUM";
  return "LOW";
}

async function callLocalApi(
  origin: string,
  method: "GET" | "POST",
  urlPath: string,
  body?: any
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Server-to-server internal calls must pass admin
  const admin = (process.env.MEKA_ADMIN_TOKEN || "").trim();
  if (admin) headers["Authorization"] = `Bearer ${admin}`;

  const res = await fetch(`${origin}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });

  const txt = await res.text();
  let json: any = null;
  try {
    json = txt ? JSON.parse(stripBom(txt)) : null;
  } catch {
    json = { raw: txt };
  }

  /**
   * CRITICAL CHANGE:
   * Do NOT throw on non-2xx.
   * Return the error payload to the model as tool output so the tool loop can continue.
   * This prevents /api/turn_response from returning 500 just because a file is missing (404).
   */
  if (!res.ok) {
    // Preserve the server's structured error if present.
    if (json && typeof json === "object") return json;

    // Fallback when response isn't JSON.
    return {
      ok: false,
      error: "local_api_error",
      status: res.status,
      details: {
        method,
        urlPath,
        body: body ?? null,
        raw: safeTruncate(txt, 800),
      },
    };
  }

  return json;
}

async function executeFunctionTool(origin: string, name: string, args: any) {
  // Normalize tool names so both fs.read and fs_read are accepted.
  const toolNameRaw = String(name ?? "");
  const toolName = toolNameRaw.includes(".") ? toolNameRaw.replace(/\./g, "_") : toolNameRaw;

  const fn = (functionsMap as any)[toolName];

  if (typeof fn !== "function") {
    return {
      ok: false,
      error: "unknown_tool",
      name: toolNameRaw,
      normalized_name: toolName,
      known_tools: Object.keys(functionsMap),
      hint: "Tool not found in functionsMap.",
    };
  }

  try {
    // functionsMap tools are responsible for calling local /api/* routes (and attaching admin on server)
    return await fn(args ?? {});
  } catch (e: any) {
    return {
      ok: false,
      error: "tool_exception",
      name: toolNameRaw,
      normalized_name: toolName,
      message: String(e?.message ?? e ?? "unknown_error"),
    };
  }
}

/**
 * Non-streaming tool loop:
 * - Call model
 * - If function_call items exist, execute them and append function_call_output
 * - Repeat until no more function_call items (or max rounds)
 *
 * This matches OpenAIÃ¢â‚¬â„¢s documented tool calling flow. :contentReference[oaicite:2]{index=2}
 */
async function runWithLocalFunctionTools(params: {
  origin: string;
  model: string;
  instructions: string;
  tools: any[];
  input: any[];
  max_output_tokens: number;
  maxRounds?: number;
}) {
  const maxRounds = params.maxRounds ?? 6;

  // We build an Ã¢â‚¬Å“input listÃ¢â‚¬Â that includes model outputs + tool outputs
  const inputList: any[] = [...params.input];

  let lastResponse: any = null;

  for (let round = 1; round <= maxRounds; round++) {
    const resp = await createResponseWithRetry({
      model: params.model,
      input: inputList,
      instructions: params.instructions,
      tools: params.tools,
      max_output_tokens: params.max_output_tokens,
      stream: false,
      parallel_tool_calls: false,
    });

    lastResponse = resp;

    const outputItems = Array.isArray((resp as any)?.output) ? (resp as any).output : [];
    // Append model output items to the running input list (per docs)
    for (const it of outputItems) inputList.push(it);

    const fnCalls = outputItems.filter((it: any) => it && it.type === "function_call") as FunctionCallItem[];

    if (!fnCalls.length) break;

    for (const call of fnCalls) {
      const argsObj = safeJsonParse(call.arguments) ?? {};
      const toolResult = await executeFunctionTool(params.origin, call.name, argsObj);

      const outItem: FunctionCallOutputItem = {
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(toolResult ?? {}),
      };
      inputList.push(outItem);
    }
  }

  // Best-effort Ã¢â‚¬Å“final textÃ¢â‚¬Â
  const outputText =
    (lastResponse as any)?.output_text ??
    (lastResponse as any)?.output_text?.toString?.() ??
    "";

  // Fallback: try to locate last text content in output if output_text is absent
  let fallbackText = "";
  if (!outputText) {
    const out = Array.isArray((lastResponse as any)?.output) ? (lastResponse as any).output : [];
    const lastText = [...out].reverse().find((x: any) => x && x.type === "output_text" && typeof x.text === "string");
    fallbackText = lastText?.text ?? "";
  }

  return {
    ok: true,
    text: outputText || fallbackText || "",
    lastResponse,
  };
}

const WB_START = "BEGIN_WRITEBACK_JSON";
const WB_END = "END_WRITEBACK_JSON";

/** Remove UTF-8 BOM if present (prevents JSON.parse: Unexpected token 'Ã¯Â»Â¿') */
function stripBom(s: string): string {
  if (!s) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeTruncate(s: string, max = 2000): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "Ã¢â‚¬Â¦(truncated)" : s;
}

/**
 * Rotate file if it grows beyond maxBytes.
 * Keeps a single rollover copy: <file>.1 (overwritten each time).
 * Best-effort only: never throws.
 */
function rotateIfLarge(filePath: string, maxBytes: number) {
  try {
    if (!maxBytes || maxBytes <= 0) return;
    if (!fs.existsSync(filePath)) return;

    const st = fs.statSync(filePath);
    if (!st?.isFile?.()) return;

    if (st.size >= maxBytes) {
      const rotated = `${filePath}.1`;
      try {
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
      } catch {
        // ignore
      }
      fs.renameSync(filePath, rotated);
    }
  } catch {
    // ignore
  }
}

type DeepTruncateOptions = {
  maxString?: number;
  maxArray?: number;
  maxKeys?: number;
  maxDepth?: number;
};

function deepTruncate(
  value: any,
  opts: DeepTruncateOptions = {},
  depth = 0,
  seen?: WeakSet<object>
): any {
  const maxString = opts.maxString ?? 2000;
  const maxArray = opts.maxArray ?? 60;
  const maxKeys = opts.maxKeys ?? 80;
  const maxDepth = opts.maxDepth ?? 8;

  if (value === null || value === undefined) return value;

  const t = typeof value;

  if (t === "string") return safeTruncate(value, maxString);
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t === "function") return "[function]";
  if (t === "symbol") return "[symbol]";

  if (depth >= maxDepth) return "[max-depth]";

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: safeTruncate(value.message ?? "", maxString),
      stack: safeTruncate(value.stack ?? "", maxString),
    };
  }

  if (Array.isArray(value)) {
    const arr = value.slice(0, maxArray);
    return arr.map((v) => deepTruncate(v, opts, depth + 1, seen));
  }

  if (t === "object") {
    const obj = value as object;

    if (!seen) seen = new WeakSet<object>();
    if (seen.has(obj)) return "[circular]";
    seen.add(obj);

    const out: any = {};
    const keys = Object.keys(value).slice(0, maxKeys);
    for (const k of keys) {
      try {
        out[k] = deepTruncate((value as any)[k], opts, depth + 1, seen);
      } catch {
        out[k] = "[unreadable]";
      }
    }

    const totalKeys = Object.keys(value).length;
    if (totalKeys > keys.length) out.__truncated_keys__ = totalKeys - keys.length;

    return out;
  }

  try {
    return String(value);
  } catch {
    return "[unstringifiable]";
  }
}

/**
 * JSONL append that is:
 * - directory-safe
 * - size-rotated
 * - best-effort (never throws)
 */
function appendJsonlBestEffort(filePath: string, obj: any, maxBytes: number) {
  try {
    ensureDir(path.dirname(filePath));
    rotateIfLarge(filePath, maxBytes);
    fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
  } catch {
    // ignore
  }
}

// Tap size defaults: 25MB, override via env if desired
const MEKA_TAP_MAX_BYTES = (() => {
  const raw = (process.env.MEKA_TAP_MAX_BYTES || "").trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 25 * 1024 * 1024;
})();

/**
 * Inbound request safety rail.
 * Default: 1MB. Override with MEKA_INBOUND_MAX_BYTES.
 * (This is NOT a Next.js bodyParser limitÃ¢â‚¬â€it's our own guardrail.)
 */
const MEKA_INBOUND_MAX_BYTES = (() => {
  const raw = (process.env.MEKA_INBOUND_MAX_BYTES || "").trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1 * 1024 * 1024;
})();

function tapStreamLine(obj: any) {
  if (process.env.MEKA_STREAM_TAP !== "1") return;
  const tapPath = path.join(process.cwd(), "state", "stream_tap.jsonl");
  appendJsonlBestEffort(tapPath, obj, MEKA_TAP_MAX_BYTES);
}

/**
 * Retrieval observability tap.
 * Records (when enabled) which vector stores were active per request + any tool/retrieval events.
 */
function tapRetrievalLine(obj: any) {
  if (process.env.MEKA_RETRIEVAL_TAP !== "1") return;
  const tapPath = path.join(process.cwd(), "state", "retrieval_tap.jsonl");
  appendJsonlBestEffort(tapPath, obj, MEKA_TAP_MAX_BYTES);
}

type WriteBack = {
  writeback?: {
    events?: any[];
    state_patch?: any;
    parked?: any[];
    notes?: string;
  };
};

type WriteBackExtractResult =
  | { status: "absent" }
  | { status: "invalid_json"; error: string }
  | { status: "ok"; value: WriteBack };

/**
 * Extract JSON between BEGIN_WRITEBACK_JSON and END_WRITEBACK_JSON.
 * Uses the LAST end-marker and the LAST start-marker before it (more robust).
 */
function extractWriteBackFromText(fullText: string): WriteBackExtractResult {
  if (!fullText) return { status: "absent" };

  const startMarker = "BEGIN_WRITEBACK_JSON";
  const endMarker = "END_WRITEBACK_JSON";

  const end = fullText.lastIndexOf(endMarker);
  if (end === -1) return { status: "absent" };

  const start = fullText.lastIndexOf(startMarker, end);
  if (start === -1) return { status: "absent" };

  const raw = fullText.slice(start + startMarker.length, end).trim();
  if (!raw) return { status: "invalid_json", error: "empty_writeback_payload" };

  try {
    const parsed = JSON.parse(stripBom(raw)) as WriteBack;
    return { status: "ok", value: parsed };
  } catch (e: any) {
    return {
      status: "invalid_json",
      error: safeTruncate(String(e?.message ?? e ?? "json_parse_error"), 300),
    };
  }
}

type WriteBackValidationOk = {
  ok: true;
  writeback: NonNullable<WriteBack["writeback"]>;
  normalizedPatch: any | null;
};

type WriteBackValidationFail = {
  ok: false;
  error: string;
};

function validateWriteBackEnvelope(wb: WriteBack): WriteBackValidationOk | WriteBackValidationFail {
  if (!wb || typeof wb !== "object") return { ok: false, error: "writeback_envelope_not_object" };

  const w = (wb as any).writeback;
  if (!w || typeof w !== "object") return { ok: false, error: "missing_writeback_object" };

  if (w.events !== undefined && !Array.isArray(w.events)) {
    return { ok: false, error: "writeback.events_must_be_array" };
  }

  if (w.parked !== undefined && !Array.isArray(w.parked)) {
    return { ok: false, error: "writeback.parked_must_be_array" };
  }

  if (w.notes !== undefined && typeof w.notes !== "string") {
    return { ok: false, error: "writeback.notes_must_be_string" };
  }

  if (w.state_patch !== undefined && w.state_patch !== null) {
    const sp = w.state_patch;
    const isObj = typeof sp === "object" && sp !== null && !Array.isArray(sp);
    if (!isObj) return { ok: false, error: "writeback.state_patch_must_be_object" };
  }

  let normalizedPatch: any | null = null;
  if (w.state_patch && typeof w.state_patch === "object") {
    normalizedPatch = normalizeStatePatch(w.state_patch);
  }

  return { ok: true, writeback: w, normalizedPatch };
}

/**
 * Deep-merge patch into target with MEKA semantics:
 * - array + array => append
 * - object + object => recurse
 * - otherwise => replace
 */
function applyPatchAppendArrays(target: any, patch: any): any {
  if (patch === null || patch === undefined) return target;

  if (Array.isArray(target) && Array.isArray(patch)) {
    return [...target, ...patch];
  }

  const targetIsObj = typeof target === "object" && target !== null && !Array.isArray(target);
  const patchIsObj = typeof patch === "object" && patch !== null && !Array.isArray(patch);

  if (targetIsObj && patchIsObj) {
    const out: any = { ...target };
    for (const k of Object.keys(patch)) {
      out[k] = applyPatchAppendArrays(out[k], patch[k]);
    }
    return out;
  }

  return patch;
}

/**
 * Normalize "append-style" patch keys into canonical arrays.
 * Example: queue.now_add => queue.now (append), then delete now_add.
 * Also folds legacy/stray queue keys into canonical schema.
 */
function normalizeStatePatch(patch: any): any {
  if (!patch || typeof patch !== "object") return patch;

  const q = (patch as any)?.queue;
  if (q && typeof q === "object") {
    const ensureArr = (k: string) => {
      if (!Array.isArray((q as any)[k])) (q as any)[k] = [];
    };

    const fold = (from: string, to: string) => {
      const add = (q as any)[from];
      if (!Array.isArray(add) || add.length === 0) return;

      ensureArr(to);
      (q as any)[to] = [...(q as any)[to], ...add];

      delete (q as any)[from];
    };

    fold("now_add", "now");
    fold("next_add", "next");
    fold("parked_add", "parked");

    // Legacy/stray: treat as parked, then delete.
    fold("pending_inputs_add", "parked");

    if (Array.isArray((q as any).pending_inputs) && (q as any).pending_inputs.length > 0) {
      ensureArr("parked");
      (q as any).parked = [...(q as any).parked, ...(q as any).pending_inputs];
    }
    delete (q as any).pending_inputs;

    // Non-canonical: enforce strict schema
    delete (q as any).now_remove;
  }

  return patch;
}

/**
 * Normalize persisted state pack in-place:
 * - fold legacy queue.*_add fields into queue arrays and delete *_add.
 * - fold legacy/stray keys into canonical schema and delete them.
 */
function normalizeStatePackInPlace(statePack: any) {
  if (!statePack || typeof statePack !== "object") return statePack;

  const q = (statePack as any).queue;
  if (!q || typeof q !== "object") return statePack;

  const ensureArr = (k: string) => {
    if (!Array.isArray((q as any)[k])) (q as any)[k] = [];
  };

  const fold = (from: string, to: string) => {
    const add = (q as any)[from];
    if (!Array.isArray(add) || add.length === 0) return;

    ensureArr(to);
    (q as any)[to].push(...add);

    delete (q as any)[from];
  };

  fold("now_add", "now");
  fold("next_add", "next");
  fold("parked_add", "parked");

  // Legacy/stray: fold into parked, then delete.
  fold("pending_inputs", "parked");

  // Non-canonical: enforce strict schema
  delete (q as any).now_remove;

  return statePack;
}

function appendEventLogLine(logPath: string, obj: any) {
  appendJsonlBestEffort(logPath, obj, MEKA_TAP_MAX_BYTES);
}

function loadStatePack(statePath: string): any {
  if (!fs.existsSync(statePath)) {
    const now = new Date().toISOString();
    const created = {
      meta: {
        schema_version: "0.1",
        session_id: "local-dev",
        created_at: now,
        updated_at: now,
      },
      bindings: {
        vector_store_id: null,
        invocation_sha: null,
        model: null,
      },
      canon: {
        index: "CI-1",
        active: [],
      },
      queue: { now: [], next: [], parked: [] },
      decisions: [],
      last_turn: null,
      events: [],
      notes: "",
      updated_at: now,
      mode: "NORMAL",
    };
    return normalizeStatePackInPlace(created);
  }

  const raw = stripBom(fs.readFileSync(statePath, "utf8"));
  const parsed = JSON.parse(raw.trimStart());
  return normalizeStatePackInPlace(parsed);
}

function saveStatePack(statePath: string, statePack: any) {
  ensureDir(path.dirname(statePath));

  normalizeStatePackInPlace(statePack);

  const now = new Date().toISOString();
  statePack.meta = statePack.meta ?? {};
  statePack.meta.updated_at = now;
  statePack.updated_at = now;

  fs.writeFileSync(statePath, JSON.stringify(statePack, null, 2), "utf8");
}

function coerceUserText(content: any): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (!p) continue;
      if (typeof p === "string") parts.push(p);
      else if (typeof (p as any).text === "string") parts.push((p as any).text);
      else if (typeof (p as any).content === "string") parts.push((p as any).content);
      else {
        try {
          parts.push(JSON.stringify(p));
        } catch {
          parts.push(String(p));
        }
      }
    }
    return parts.join("\n").trim();
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content ?? "");
  }
}

/**
 * Normalize inbound UI messages to { role, content } expected by Responses API input.
 * - Drops any non standard message roles.
 * - Maps "system" -> "developer" defensively.
 */
function normalizeMessages(
  rawMessages: any[]
): Array<{ role: "developer" | "user" | "assistant"; content: string }> {
  const out: Array<{ role: "developer" | "user" | "assistant"; content: string }> = [];
  if (!Array.isArray(rawMessages)) return out;

  for (const m of rawMessages) {
    if (!m || typeof m !== "object") continue;

    const roleRaw = (m as any).role;

    const role =
      roleRaw === "developer" || roleRaw === "user" || roleRaw === "assistant"
        ? roleRaw
        : roleRaw === "system"
          ? "developer"
          : null;

    if (!role) continue;

    const content = coerceUserText((m as any).content).trim();
    if (!content) continue;

    out.push({ role, content });
  }

  return out;
}

/**
 * Compute a stable "local now" string for a target IANA timezone.
 * Emits:
 *   NOW_LOCAL: YYYY-MM-DDTHH:mm:ss
 *   TZ: <IANA zone>
 * Offset is intentionally omitted; TZ is provided explicitly.
 */
function getNowLocalISO(timeZone: string): { isoLocal: string; tz: string } {
  const d = new Date();

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const yyyy = pick("year");
  const mm = pick("month");
  const dd = pick("day");
  const hh = pick("hour");
  const mi = pick("minute");
  const ss = pick("second");

  return { isoLocal: `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`, tz: timeZone };
}

/**
 * Keep the STATE_PACK small to avoid context_length_exceeded.
 */
function buildPromptStatePack(statePack: any) {
  const queue = statePack?.queue ?? { now: [], next: [], parked: [] };

  const events = Array.isArray(statePack?.events) ? statePack.events : [];
  const recentEvents = events.slice(-30);

  const notes = typeof statePack?.notes === "string" ? statePack.notes : "";
  const notesTail = safeTruncate(notes, 2000);

  return {
    meta: statePack?.meta ?? {},
    bindings: statePack?.bindings ?? {},
    canon: statePack?.canon ?? {},
    updated_at: statePack?.updated_at ?? "",
    mode: statePack?.mode ?? "",
    queue: {
      now: Array.isArray(queue.now) ? queue.now.slice(-50) : [],
      next: Array.isArray(queue.next) ? queue.next.slice(-50) : [],
      parked: Array.isArray(queue.parked) ? queue.parked.slice(-50) : [],
    },
    events: recentEvents,
    notes_tail: notesTail,
  };
}

function jsonError(status: number, code: string, message: string, details?: any) {
  return new Response(
    JSON.stringify({
      error: { code, message, details },
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/* ------------------------- Canon Ops enforcement ------------------------- */

type CanonOpsSupersede = {
  from: string;
  to: string;
  reason?: string;
  at?: string;
};

type CanonOpsTombstone = {
  artifact_id: string;
  reason?: string;
  tombstoned_at?: string;
};

type CanonOpsFile = {
  generated_at?: string;
  artifact_count?: number;
  artifacts?: Array<{ artifact_id?: string }>;
  tombstones?: CanonOpsTombstone[];
  supersedes?: CanonOpsSupersede[];
};

type CanonOpsComputed = {
  ok: boolean;
  source_path: string;
  generated_at: string | null;
  artifact_ids: Set<string>;
  tombstone_set: Set<string>;
  supersedes_direct_map: Record<string, string>;
  supersedes_terminal_map: Record<string, string>;
  effective_successor_map: Record<string, string>;
  counts: {
    artifacts: number;
    tombstones: number;
    supersedes: number;
  };
  warnings: string[];
};

function readJsonBestEffort(p: string): any | null {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = stripBom(fs.readFileSync(p, "utf8"));
    const txt = raw.trimStart();
    if (!txt) return null;
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function computeSupersedesMaps(artifactIds: Set<string>, supersedes: CanonOpsSupersede[]) {
  const direct: Record<string, string> = {};
  for (const e of supersedes || []) {
    const from = (e?.from || "").trim();
    const to = (e?.to || "").trim();
    if (!from || !to) continue;
    direct[from] = to;
  }

  const terminal: Record<string, string> = {};
  const effective: Record<string, string> = {};

  const resolveTerminal = (start: string): string => {
    const seen = new Set<string>();
    let cur = start;
    let next = direct[cur];

    while (next && !seen.has(cur)) {
      seen.add(cur);
      cur = next;
      next = direct[cur];
    }

    return cur;
  };

  for (const from of Object.keys(direct)) {
    const end = resolveTerminal(from);
    terminal[from] = end;

    // Only mark effective successor if the terminal exists as a known artifact_id.
    if (end && artifactIds.has(end)) {
      effective[from] = end;
    }
  }

  return { direct, terminal, effective };
}

function loadCanonOpsComputedBestEffort(stateDir: string): CanonOpsComputed {
  const p = path.join(stateDir, "canon_ops.json");
  const obj = readJsonBestEffort(p) as CanonOpsFile | null;

  const warnings: string[] = [];

  if (!obj) {
    return {
      ok: false,
      source_path: "state/canon_ops.json",
      generated_at: null,
      artifact_ids: new Set<string>(),
      tombstone_set: new Set<string>(),
      supersedes_direct_map: {},
      supersedes_terminal_map: {},
      effective_successor_map: {},
      counts: { artifacts: 0, tombstones: 0, supersedes: 0 },
      warnings: ["canon_ops_missing_or_unparseable"],
    };
  }

  const artifactIds = new Set<string>();
  const artifactsArr = Array.isArray(obj.artifacts) ? obj.artifacts : [];
  for (const a of artifactsArr) {
    const id = (a?.artifact_id || "").trim();
    if (id) artifactIds.add(id);
  }

  const tombstonesArr = Array.isArray(obj.tombstones) ? obj.tombstones : [];
  const tombstoneSet = new Set<string>();
  for (const t of tombstonesArr) {
    const id = (t?.artifact_id || "").trim();
    if (id) tombstoneSet.add(id);
  }

  const supersedesArr = Array.isArray(obj.supersedes) ? obj.supersedes : [];
  const maps = computeSupersedesMaps(artifactIds, supersedesArr);

  // Ensure tombstoned artifacts are never promoted as successors.
  const effectiveFiltered: Record<string, string> = {};
  for (const [from, to] of Object.entries(maps.effective)) {
    if (!tombstoneSet.has(to)) effectiveFiltered[from] = to;
  }

  return {
    ok: true,
    source_path: "state/canon_ops.json",
    generated_at: obj.generated_at ?? null,
    artifact_ids: artifactIds,
    tombstone_set: tombstoneSet,
    supersedes_direct_map: maps.direct,
    supersedes_terminal_map: maps.terminal,
    effective_successor_map: effectiveFiltered,
    counts: {
      artifacts: artifactsArr.length,
      tombstones: tombstonesArr.length,
      supersedes: supersedesArr.length,
    },
    warnings,
  };
}

function detectCanonOpsOverrides(lastUserText: string) {
  const t = (lastUserText || "").toLowerCase();

  // Explicit user intent to see historical/tombstoned content.
  const allowTombstoned =
    t.includes("ignore tombstone") ||
    t.includes("ignore tombstones") ||
    t.includes("include tombstone") ||
    t.includes("include tombstoned") ||
    t.includes("show tombstone") ||
    t.includes("show tombstoned") ||
    t.includes("historical") ||
    t.includes("old version") ||
    t.includes("previous version") ||
    t.includes("original version");

  // Explicit user intent to reason about pre-supersession content.
  const allowSuperseded =
    t.includes("show superseded") ||
    t.includes("include superseded") ||
    t.includes("ignore supersedes") ||
    t.includes("ignore supersession") ||
    t.includes("historical") ||
    t.includes("old version") ||
    t.includes("previous version") ||
    t.includes("original version");

  return { allowTombstoned, allowSuperseded };
}

function buildCanonOpsEnforcementNote(
  canonOps: CanonOpsComputed,
  lastUserText: string
): { note: string; flags: { allowTombstoned: boolean; allowSuperseded: boolean } } {
  const flags = detectCanonOpsOverrides(lastUserText);

  const tombstones = Array.from(canonOps.tombstone_set).slice(0, 50);
  const effPairs = Object.entries(canonOps.effective_successor_map).slice(0, 80);

  const effMapPreview = effPairs.map(([k, v]) => `${k} -> ${v}`).join("\n");

  const noteLines: string[] = [
    `CANON_OPS (drift control; authoritative mapping for supersession + tombstones)`,
    `source: ${canonOps.source_path}`,
    `generated_at: ${canonOps.generated_at ?? "null"}`,
    `counts: artifacts=${canonOps.counts.artifacts} tombstones=${canonOps.counts.tombstones} supersedes=${canonOps.counts.supersedes}`,
    `overrides: allow_tombstoned=${flags.allowTombstoned} allow_superseded=${flags.allowSuperseded}`,
    ``,
    `ENFORCEMENT RULES (must follow):`,
    `1) Tombstones:`,
    flags.allowTombstoned
      ? `- User requested historical access; tombstoned artifacts may be discussed, but must be labeled as tombstoned and not treated as current truth.`
      : `- Do NOT rely on, quote as truth, or cite tombstoned artifacts. Treat them as invalid for current truth and continuity.`,
    `2) Supersession:`,
    flags.allowSuperseded
      ? `- User requested historical/pre-supersession; superseded artifacts may be discussed, but you must also state the current successor if one exists.`
      : `- Treat superseded artifact IDs as aliases. Prefer and cite the effective successor for truth. If user references an older ID, map it to the successor and say you did so.`,
    `3) Citations: If retrieved chunks conflict with tombstone/supersession rules, discard them and retrieve again using the correct effective artifact.`,
    ``,
    `tombstone_set (preview, up to 50): ${tombstones.length ? tombstones.join(", ") : "(empty)"}`,
    `effective_successor_map (preview, up to 80):`,
    effMapPreview ? effMapPreview : "(empty)",
  ];

  return { note: noteLines.join("\n"), flags };
}

/* ----------------------- End Canon Ops enforcement ----------------------- */

/**
 * OpenAI request hard rule:
 * - vector_store_ids must be an array of non-empty strings
 * - never allow null/undefined/"" through
 */
function sanitizeVectorStoreIds(ids: any): string[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((x) => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * Sanitize tool array so we never send invalid vector_store_ids.
 * - For file_search: remove null/empty IDs
 * - Drop file_search tools that end up empty
 */
function sanitizeToolsForOpenAI(tools: any[]): any[] {
  const out: any[] = [];
  for (const t of tools || []) {
    if (!t || typeof t !== "object") continue;

    if ((t as any).type === "file_search") {
      const clean = sanitizeVectorStoreIds((t as any).vector_store_ids);
      if (clean.length === 0) continue; // drop invalid file_search tool entirely
      out.push({ ...(t as any), vector_store_ids: clean });
      continue;
    }

    out.push(t);
  }
  return out;
}

export async function POST(request: Request) {
  try {
    let assistantText = "";

    // ---------- Phase B1: inbound safety rails ----------
    const clRaw = request.headers.get("content-length");
    const contentLength = clRaw ? Number(clRaw) : NaN;
    if (Number.isFinite(contentLength) && contentLength > MEKA_INBOUND_MAX_BYTES) {
      return jsonError(413, "payload_too_large", "Request body exceeds inbound max bytes.", {
        inbound_max_bytes: MEKA_INBOUND_MAX_BYTES,
        content_length: contentLength,
      });
    }

    const rawBody = await request.text();
    const rawBytes = Buffer.byteLength(rawBody || "", "utf8");
    if (rawBytes > MEKA_INBOUND_MAX_BYTES) {
      return jsonError(413, "payload_too_large", "Request body exceeds inbound max bytes.", {
        inbound_max_bytes: MEKA_INBOUND_MAX_BYTES,
        actual_bytes: rawBytes,
      });
    }

    let parsed: any = null;
    try {
      parsed = rawBody ? JSON.parse(stripBom(rawBody)) : null;
    } catch (e: any) {
      return jsonError(400, "invalid_json", "Request body is not valid JSON.", {
        hint: "Send { messages: [...], toolsState?: ... }",
        parse_error: safeTruncate(String(e?.message ?? e ?? "unknown"), 300),
      });
    }

    if (!parsed || typeof parsed !== "object") {
      return jsonError(400, "invalid_payload", "Request JSON must be an object.", {
        hint: "Expected { messages: [...], toolsState?: ... }",
      });
    }

    const messages = (parsed as any).messages;
    const toolsState = (parsed as any).toolsState;

    if (!Array.isArray(messages)) {
      return jsonError(400, "invalid_payload", "Field `messages` must be an array.", {
        received_type: typeof messages,
      });
    }

    if (toolsState !== undefined && toolsState !== null && typeof toolsState !== "object") {
      return jsonError(400, "invalid_payload", "Field `toolsState` must be an object when provided.", {
        received_type: typeof toolsState,
      });
    }

    if (toolsState && typeof toolsState === "object") {
      const allowedKeys = new Set([
        "fileSearchEnabled",
        "webSearchEnabled",
        "functionsEnabled",
        "googleIntegrationEnabled",
        "mcpEnabled",
        "codeInterpreterEnabled",
        "dev_bypass_active",
      ]);
      const unknownKeys = Object.keys(toolsState as any).filter((k) => !allowedKeys.has(k));
      if (unknownKeys.length > 0) {
        return jsonError(400, "invalid_payload", "Field `toolsState` contains unknown keys.", {
          unknown_keys: unknownKeys,
          allowed_keys: Array.from(allowedKeys),
        });
      }
    }
    // ---------- End Phase B1 rails ----------

    // ---------- Phase B1.5: inline tool-call short-circuit (stabilization) ----------
    // Admin-gate inline tool short-circuit to prevent unauthorized local tool execution.
    const adminOkEarly = isToolsAuthorized(request);
    // INLINE_TOOL_SHORTCIRCUIT_V1
    const originEarly = new URL(request.url).origin;

    const normalizedEarly = normalizeMessages(messages);
    const lastUserTextEarly = [...normalizedEarly].reverse().find((m) => m.role === "user")?.content || "";

    type InlineTool = { name: string; args: Record<string, any> } | null;

    function parseInlineToolCall(s: string): InlineTool {
      const raw = String(s ?? "").trim();
      if (!raw) return null;

      // Allow optional leading "use"/"run"/"call"
      const m = raw.match(/^(?:\w+\s*:\s*)?(?:use|run|call)?\s*(fs_[a-z_]+)\b/i);
      if (!m) return null;

      const name = m[1];
      const rest = raw.slice(m[0].length).trim();
      const args: Record<string, any> = {};

      // Parse key=value pairs where value may be "quoted" or 'quoted' or unquoted (no spaces)
      const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(rest))) {
        const key = mm[1];
        const val = mm[2] ?? mm[3] ?? mm[4] ?? "";
        args[key] = val;
      }

      // For read/list tools, require root + path
      const n = name.toLowerCase();
      if (n === "fs_read" || n === "fs_list") {
        if (!args.root) return null;
        if (!args.path) return null;
      }

      return { name, args };
    }

    function sseOnceText(text: string) {
  // INLINE_TOOL_SHORTCIRCUIT_CHUNKED_SSE_V1
  // Chunk large payloads to prevent client stalls on oversized SSE frames.
  const CHUNK = 1600;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const s = String(text ?? "");

        // Emit deltas in chunks
        for (let i = 0; i < s.length; i += CHUNK) {
          const part = s.slice(i, i + CHUNK);
          const payloadDelta = JSON.stringify({
            event: "response.output_text.delta",
            data: { type: "response.output_text.delta", delta: part },
          });
          controller.enqueue("data: " + payloadDelta + "\n\n");
        }

        // Compatibility: include full text on done for small payloads only (avoid duplicating huge content)
        const doneText = s.length <= 20000 ? s : "";
        const payloadDone = JSON.stringify({
          event: "response.output_text.done",
          data: { type: "response.output_text.done", text: doneText },
        });
        controller.enqueue("data: " + payloadDone + "\n\n");
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "Connection": "keep-alive",
    },
  });
}
    const inline = adminOkEarly ? parseInlineToolCall(lastUserTextEarly) : null;
    if (inline) {
      const toolResult = await executeFunctionTool(originEarly, inline.name, inline.args);

      let outText = "";
      if (
        inline.name.toLowerCase() === "fs_read" &&
        toolResult &&
        typeof toolResult === "object" &&
        (toolResult as any).ok === true &&
        typeof (toolResult as any).text === "string"
      ) {
              // INLINE_TOOL_SHORTCIRCUIT_FENCED_V1
      const pth = String((inline.args as any)?.path ?? "");
      const ext = path.extname(pth).toLowerCase();
      const lang =
        ext === ".ts" || ext === ".tsx" ? "ts" :
        ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs" ? "js" :
        ext === ".json" ? "json" :
        ext === ".md" ? "md" :
        ext === ".yml" || ext === ".yaml" ? "yaml" :
        ext === ".css" || ext === ".scss" ? "css" :
        ext === ".html" ? "html" : "";
            // INLINE_TOOL_SHORTCIRCUIT_TRUNCATE_V1
      const MAX = Math.max(10_000, Math.min(2_000_000, Number(process.env.MEKA_INLINE_TOOL_MAX_CHARS || "250000")));
      const fullText = String((toolResult as any).text ?? "");
      const wasTruncated = fullText.length > MAX;
      const shown = wasTruncated ? (fullText.slice(0, MAX) + "\n/* ...(truncated)... */") : fullText;

      outText = "```" + lang + "\n" + shown + "\n```";
      if (wasTruncated) {
        const bytes = (toolResult as any).bytes ?? null;
        const hash = (toolResult as any).hash ?? null;
        outText += `\n\n[truncated: showed ${MAX} of ${fullText.length} chars; bytes=${bytes}; hash=${hash}]`;
      }
      } else {
              // INLINE_TOOL_SHORTCIRCUIT_JSON_FENCE_V1
            // INLINE_TOOL_SHORTCIRCUIT_TRUNCATE_JSON_V1
      const MAXJ = Math.max(10_000, Math.min(2_000_000, Number(process.env.MEKA_INLINE_TOOL_MAX_JSON_CHARS || "200000")));
      const jFull = JSON.stringify(toolResult ?? {}, null, 2);
      const jTrunc = jFull.length > MAXJ;
      const jShown = jTrunc ? (jFull.slice(0, MAXJ) + "\n/* ...(truncated)... */") : jFull;

      outText = "```json\n" + jShown + "\n```";
      if (jTrunc) outText += `\n\n[truncated json: showed ${MAXJ} of ${jFull.length} chars]`;
      }

      return sseOnceText(outText);
    }
    // ---------- End Phase B1.5 ----------
    // ---------- Phase B2: abort/cancel handling ----------
    let clientAborted = false;

    const markAborted = (where: string, reason?: any) => {
      if (clientAborted) return;
      clientAborted = true;

      tapRetrievalLine({
        ts: new Date().toISOString(),
        kind: "abort",
        where,
        reason: safeTruncate(
          typeof reason === "string"
            ? reason
            : (() => {
                try {
                  return JSON.stringify(reason);
                } catch {
                  return String(reason ?? "");
                }
              })(),
          500
        ),
      });
    };

    const onRequestAbort = () => markAborted("request.signal.abort");
    if (request.signal?.aborted) markAborted("request.signal.aborted_at_start");
    request.signal?.addEventListener?.("abort", onRequestAbort, { once: true });
    // ---------- End Phase B2 setup ----------

        // ---------- Phase B2.25: tool-gating (admin-authorized only) ----------
    const toolsStateObj =
      toolsState !== undefined && toolsState !== null && typeof toolsState === "object" ? (toolsState as any) : {};

    const wantsFunctions = Boolean(toolsStateObj?.functionsEnabled);

    // Only allow function tools when the request is authorized (admin token) OR dev loopback bypass is active.
    const toolsOk = isToolsAuthorized(request);

    // HARD FAIL: if caller requests function tools but is not authorized, stop immediately.
    if (wantsFunctions && !toolsOk) {
      return jsonError(401, "unauthorized", "Function tools requested but request is not authorized.", {
        hint: "Send Authorization: Bearer <MEKA_ADMIN_TOKEN> or set MEKA_DEV_ALLOW_TOOLS_WITHOUT_AUTH=1 for loopback dev.",
      });
    }
// If caller did not request functions, tools remain disabled (stable default).
    const gatedToolsState = {
      ...toolsStateObj,
      functionsEnabled: wantsFunctions && toolsOk,
    };

    const extraTools = await getTools(gatedToolsState);
    // ---------- End Phase B2.25 ----------

    const developerPrompt = getDeveloperPrompt();

    const invMarker = "INV_MARKER=INV_2026_01_03_A";
    const invMarkerPresent = developerPrompt.includes(invMarker);

    const invocationSha12 = createHash("sha256").update(developerPrompt).digest("hex").slice(0, 12);

    if (process.env.MEKA_DEBUG === "1") {
      console.log(`[MEKA] inv_marker_present=${invMarkerPresent}`);
      console.log(`[MEKA] inbound_max_bytes=${MEKA_INBOUND_MAX_BYTES} raw_bytes=${rawBytes}`);
    }

    // Vector store routing (canon vs threads vs manifest vs legacy fallback)
    const canonStoreId = (process.env.MEKA_VECTOR_STORE_ID_CANON || "").trim();
    const threadsStoreId = (process.env.MEKA_VECTOR_STORE_ID_THREADS || "").trim();
    const manifestStoreId = (process.env.MEKA_VECTOR_STORE_ID_MANIFEST || "").trim();
    const legacyStoreId = (process.env.MEKA_VECTOR_STORE_ID || "").trim();

    if (!canonStoreId && !threadsStoreId && !manifestStoreId && !legacyStoreId) {
      throw new Error(
        "Missing vector store id(s). Set MEKA_VECTOR_STORE_ID_CANON / MEKA_VECTOR_STORE_ID_THREADS / MEKA_VECTOR_STORE_ID_MANIFEST (or legacy MEKA_VECTOR_STORE_ID)."
      );
    }

    // Helper: stable de-dupe while preserving order
    function uniqOrder(ids: Array<string | undefined>): string[] {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const x of ids) {
        const v = (x || "").trim();
        if (!v) continue;
        if (seen.has(v)) continue;
        seen.add(v);
        out.push(v);
      }
      return out;
    }

    // OpenAI: maximum 2 vector stores per request
    const cap2 = (ids: Array<string | undefined>) => uniqOrder(ids).slice(0, 2);

    /**
     * Base routing: returns the FULL ordered list (uncapped).
     * `vector_store_ids_active` is computed later via truth-policy overlay + cap2.
     */
    function pickVectorStoreIdsBase(lastUserText: string): string[] {
      const t = (lastUserText || "").toLowerCase();

      // If only legacy exists, use it.
      if (!canonStoreId && !threadsStoreId && !manifestStoreId && legacyStoreId) {
        return uniqOrder([legacyStoreId]);
      }

      const wantsManifest =
        t.includes("list") ||
        t.includes("inventory") ||
        t.includes("what files") ||
        t.includes("what documents") ||
        t.includes("what docs") ||
        t.includes("canonmanifest") ||
        t.includes("artifactregistry") ||
        t.includes("manifest") ||
        t.includes("registry") ||
        t.includes("ci-1") ||
        t.includes("supersed") ||
        t.includes("tombstone") ||
        t.includes("governing") ||
        t.includes("authority");

      const wantsCanon =
        t.includes("canon") ||
        t.includes("governing") ||
        t.includes("authority") ||
        t.includes("artifact") ||
        t.includes("identity anchor") ||
        t.includes("mission anchor") ||
        t.includes("cma-0.1") ||
        t.includes("cma") ||
        t.includes("law set") ||
        t.includes("pf-4") ||
        t.includes("bpa-1.0") ||
        t.includes("behavior and posture") ||
        t.includes("mem-1.0") ||
        t.includes("memories & carry-forward");

      const wantsThreads =
        t.includes("thread") ||
        t.includes("old chat") ||
        t.includes("full chat") ||
        t.includes("earlier system") ||
        t.includes("previous version") ||
        t.includes("gold") ||
        t.includes("goldpak") ||
        t.includes("goldpaks") ||
        t.includes("breakthrough") ||
        t.includes("find") ||
        t.includes("locate") ||
        t.includes("where did i say") ||
        t.includes("lost");

      // Anchor questions must be maximally stable: force canon-only retrieval.
      const isAnchorQuery =
        t.includes("identity anchor") ||
        t.includes("mission anchor") ||
        t.includes("cma-0.1") ||
        t.includes("canon mission anchor") ||
        t.includes("canon identity anchor");

      if (isAnchorQuery && canonStoreId) {
        return uniqOrder([canonStoreId]);
      }

      if (wantsManifest && manifestStoreId) {
        // Manifest first; then best secondary; then remaining.
        const preferredSecond = wantsThreads ? threadsStoreId : canonStoreId;
        return uniqOrder([manifestStoreId, preferredSecond, threadsStoreId, canonStoreId, legacyStoreId]);
      }

      if (wantsThreads && threadsStoreId) {
        // Threads first; prefer manifest as secondary; then legacy/canon.
        return uniqOrder([threadsStoreId, manifestStoreId, legacyStoreId, canonStoreId]);
      }

      if (wantsCanon && canonStoreId) {
        // Canon first; prefer manifest as secondary; then legacy/threads.
        return uniqOrder([canonStoreId, manifestStoreId, legacyStoreId, threadsStoreId]);
      }

      // Default: canon + threads, then manifest, then legacy.
      return uniqOrder([canonStoreId, threadsStoreId, manifestStoreId, legacyStoreId]);
    }

    // ---------- Phase C4/C5: truth-policy authoritative routing overlay + fail-fast on anchor misconfig ----------
    function applyTruthPolicyToVectorStoreIds(baseIds: string[], truthPolicyId: string): string[] {
      const id = (truthPolicyId || "").trim();

      // C5: ANCHOR_CANON_ONLY must be strict (no silent fallback).
      if (id === "ANCHOR_CANON_ONLY") {
        if (!canonStoreId) {
          throw new Error("ANCHOR_CANON_ONLY requires MEKA_VECTOR_STORE_ID_CANON to be set (no fallback).");
        }
        return cap2([canonStoreId]);
      }

      // Strong policies (exact matches)
      if (id === "CANON_ONLY") {
        if (canonStoreId) return cap2([canonStoreId]);
        if (legacyStoreId) return cap2([legacyStoreId]);
        return cap2(baseIds);
      }

      // Soft policies (defensive for future policy IDs)
      if (id.includes("CANON_ONLY")) {
        if (canonStoreId) return cap2([canonStoreId]);
        if (legacyStoreId) return cap2([legacyStoreId]);
        return cap2(baseIds);
      }

      if (id.includes("MANIFEST_ONLY")) {
        if (manifestStoreId) return cap2([manifestStoreId]);
        if (legacyStoreId) return cap2([legacyStoreId]);
        return cap2(baseIds);
      }

      if (id.includes("THREADS_ONLY")) {
        if (threadsStoreId) return cap2([threadsStoreId]);
        if (legacyStoreId) return cap2([legacyStoreId]);
        return cap2(baseIds);
      }

      if (id.includes("CANON_PREFERRED")) {
        const merged = uniqOrder([canonStoreId, ...(baseIds || []).filter((x) => x && x !== canonStoreId)]);
        return cap2(merged);
      }

      return cap2(baseIds);
    }
    // ---------- End Phase C4/C5 ----------

    const stateDir = path.join(process.cwd(), "state");
    const statePath = path.join(stateDir, "state_pack.json");
    const eventLogPath = path.join(stateDir, "event_log.jsonl");

    const statePack = loadStatePack(statePath);
    const promptStatePack = buildPromptStatePack(statePack);

    const normalized = normalizeMessages(messages);
    const lastUserText = [...normalized].reverse().find((m) => m.role === "user")?.content || "";

    // ---------- Phase C1: truth-source policy ----------
    const truthPolicy = resolveTruthSourcePolicy(lastUserText);

    // ---------- Phase C1b: Canon Ops enforcement (tombstones + supersession) ----------
    const canonOps = loadCanonOpsComputedBestEffort(stateDir);
    const canonOpsEnforcement = buildCanonOpsEnforcementNote(canonOps, lastUserText);

    // ---------- Phase C2: deterministic anchor selection (prevents Ã¢â‚¬Å“wrong sentenceÃ¢â‚¬Â within canon) ----------
    const lastUserLower = (lastUserText || "").toLowerCase();

    const anchorKind: "mission" | "identity" | null =
      lastUserLower.includes("mission anchor")
        ? "mission"
        : lastUserLower.includes("identity anchor")
          ? "identity"
          : null;

    const ANCHOR_EXPECTED: Record<"mission" | "identity", string> = {
      mission: "MEKAÃ¢â‚¬â„¢s mission is to support a human life in motion.",
      identity:
        "MEKA is a Mechanical Ally, not a generic assistant, not a tool, not a product persona, and not a detached system.",
    };

    const anchorPolicyNote =
      anchorKind
        ? [
            `ANCHOR_POLICY (DET_LOCK): This request is an ${anchorKind.toUpperCase()} ANCHOR request.`,
            `Requirements:`,
            `- Use file_search results.`,
            `- Quote exactly ONE sentence, verbatim.`,
            `- Prefer the sentence matching (or closest to) this target:`,
            `"${ANCHOR_EXPECTED[anchorKind]}"`,
            `- Provide a file citation.`,
            `If not found in canon, respond: Not found in canon.`,
          ].join("\n")
        : "";
    // ---------- End Phase C2 ----------

    // Base (uncapped) + Active (truth-policy overlay + cap2)
    const baseVectorStoreIds = pickVectorStoreIdsBase(lastUserText);
    const cappedVectorStoreIds = applyTruthPolicyToVectorStoreIds(baseVectorStoreIds, truthPolicy.id);

    // Overlay semantics: TRUE only when policy forces canon-only (anchor truth-policy)
    const routingOverlayApplied = truthPolicy.id === "ANCHOR_CANON_ONLY";

    tapRetrievalLine({
      ts: new Date().toISOString(),
      kind: "request",
      base_vector_store_ids: baseVectorStoreIds,
      vector_store_ids_active: cappedVectorStoreIds,
      routing_overlay_applied: routingOverlayApplied,
      last_user_text: safeTruncate(lastUserText, 400),
      inv_sha12: invocationSha12,
      truth_policy: truthPolicy.id,
      anchor_kind: anchorKind,
      canon_ops: {
        ok: canonOps.ok,
        generated_at: canonOps.generated_at,
        artifacts: canonOps.counts.artifacts,
        tombstones: canonOps.counts.tombstones,
        supersedes: canonOps.counts.supersedes,
        overrides: canonOpsEnforcement.flags,
        warnings: canonOps.warnings,
      },
    });

    if (process.env.MEKA_DEBUG === "1") {
      console.log(
        `[MEKA] invocation_sha256_12=${invocationSha12} vector_store_ids_active=${cappedVectorStoreIds.join(",")}`
      );
    }

    const toolsRaw = [
      { type: "file_search" as const, vector_store_ids: cappedVectorStoreIds },
      ...(Array.isArray(extraTools) ? extraTools : []),
    ];

    let tools = sanitizeToolsForOpenAI(toolsRaw);

    // Safety: never allow function tools to exist unless the request is authorized.
    if (!toolsOk) {
      tools = tools.filter((t: any) => !(t && typeof t === "object" && (t as any).type === "function"));
    }
// If we lost all file_search tools due to bad IDs, fail fast with a clear message.
    const hasFileSearch = tools.some((t) => t && typeof t === "object" && (t as any).type === "file_search");
    if (!hasFileSearch) {
      throw new Error(
        "No valid file_search tool available after sanitization. A tool supplied null/empty vector_store_ids. Check env IDs and toolsState-derived tools."
      );
    }

    const USER_TZ = process.env.MEKA_USER_TZ || "America/Halifax";
    const { isoLocal: nowLocal, tz: nowTz } = getNowLocalISO(USER_TZ);

    if (process.env.MEKA_DEBUG === "1") {
      console.log(`[MEKA] NOW_LOCAL=${nowLocal} TZ=${nowTz}`);
    }

    const input: Array<{ role: "developer" | "user" | "assistant"; content: string }> = [
      {
        role: "developer",
        content: `STATE_PACK (durable; authoritative for continuity)\n${JSON.stringify(promptStatePack)}`,
      },
      {
        role: "developer",
        content: truthPolicy.note,
      },
      {
        role: "developer",
        content: canonOpsEnforcement.note,
      },
      ...(anchorPolicyNote
        ? [
            {
              role: "developer" as const,
              content: anchorPolicyNote,
            },
          ]
        : []),
      {
        role: "developer",
        content: `NOW_LOCAL: ${nowLocal}\nTZ: ${nowTz}`,
      },
      ...normalized,
    ];

    const origin = new URL(request.url).origin;

    // If any local function tools are present, run the documented tool loop non-streaming,
    // then we will emit the result as SSE (single delta + done).
    const hasLocalFunctionTools = tools.some(
      (t: any) => t && typeof t === "object" && t.type === "function" && typeof t.name === "string"
    );

    if (hasLocalFunctionTools) {
      const ran = await runWithLocalFunctionTools({
        origin,
        model: MODEL,
        instructions: developerPrompt,
        tools,
        input,
        max_output_tokens: MEKA_BUDGETS.maxOutputTokens,
        maxRounds: 6,
      });

      const finalText = String(ran?.text ?? "");
      const finalVisible = stripWritebackBlocks(finalText).trim();
assistantText = finalText;

      const stream = new ReadableStream({
        async start(controller) {
          try {
            const payloadDelta = JSON.stringify({
              event: "response.output_text.delta",
              data: { type: "response.output_text.delta", delta: finalVisible },
            });
            controller.enqueue(`data: ${payloadDelta}\n\n`);

            const payloadDone = JSON.stringify({
              event: "response.output_text.done",
              data: { type: "response.output_text.done", text: finalVisible },
            });
            controller.enqueue(`data: ${payloadDone}\n\n`);

            controller.close();
          } catch (e) {
            controller.error(e);
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    // Default path: existing streaming behavior (unchanged)
    // Must be declared before any assignment in this scope (prevents TDZ crash)
    const events = await createResponseWithRetry({
      model: MODEL,
      input,
      instructions: developerPrompt,
      tools,
      max_output_tokens: MEKA_BUDGETS.maxOutputTokens,
      stream: true,
      parallel_tool_calls: false,
    });

    // Streaming writeback suppression state (must exist, or takeVisibleFromDelta will crash)
    let wbClientBuf = "";
    let wbClientSuppress = false;

    function deepStripWriteback(v: any): any {
      if (typeof v === "string") return stripWritebackBlocks(v);
      if (Array.isArray(v)) return v.map(deepStripWriteback);
      if (v && typeof v === "object") {
        const out: any = {};
        for (const [k, val] of Object.entries(v)) out[k] = deepStripWriteback(val);
        return out;
      }
      return v;
    }

    function takeVisibleFromDelta(delta: string): string {
      if (!delta) return "";
      wbClientBuf += delta;

      let out = "";
      const KEEP_TAIL = Math.max(WB_START.length, WB_END.length) - 1;

      while (true) {
        if (!wbClientSuppress) {
          const sIdx = wbClientBuf.indexOf(WB_START);
          if (sIdx === -1) break;

          out += stripWritebackBlocks(wbClientBuf.slice(0, sIdx));
          wbClientBuf = wbClientBuf.slice(sIdx + WB_START.length);
          wbClientSuppress = true;
          continue;
        } else {
          const eIdx = wbClientBuf.indexOf(WB_END);
          if (eIdx === -1) break;

          wbClientBuf = wbClientBuf.slice(eIdx + WB_END.length);
          wbClientSuppress = false;
          continue;
        }
      }

      if (!wbClientSuppress && wbClientBuf.length > KEEP_TAIL) {
        out += stripWritebackBlocks(wbClientBuf.slice(0, wbClientBuf.length - KEEP_TAIL));
        wbClientBuf = wbClientBuf.slice(wbClientBuf.length - KEEP_TAIL);
      }

      return out;
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of events as any) {
            if (clientAborted) {
              // Best-effort: tell the async iterator we are done, if supported
              try {
                if (events && typeof (events as any).return === "function") {
                  await (events as any).return();
                }
              } catch {
                // ignore
              }
              break;
            }

            const et = (event as any)?.type;

            const shouldTap =
              typeof et === "string" &&
              (et.includes("file_search") ||
                et.includes("tool") ||
                et.includes("retrieval") ||
                et === "response.output_item.added" ||
                et === "response.output_item.done");

            if (shouldTap) {
              tapRetrievalLine({
                ts: new Date().toISOString(),
                kind: "event",
                type: et,
                event: deepTruncate(event, {
                  maxString: 2000,
                  maxArray: 60,
                  maxKeys: 80,
                  maxDepth: 8,
                }),
              });
            }

            if (
              event &&
              typeof event === "object" &&
              event.type === "response.output_text.delta" &&
              typeof event.delta === "string"
            ) {
              assistantText += event.delta;
            }

            if (
              event &&
              typeof event === "object" &&
              event.type === "response.output_text.done" &&
              typeof event.text === "string"
            ) {
              assistantText = event.text;
            }

            let eventToSend: any = event;

            if (event && typeof event === "object") {
              if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                const visible = takeVisibleFromDelta(event.delta);
                if (visible === "") continue;
                eventToSend = { ...event, delta: visible };
              }

              if (event.type === "response.output_text.done" && typeof event.text === "string") {
                const cleaned = stripWritebackBlocks(event.text).trim();
                eventToSend = { ...event, text: cleaned };
              }
            }

            eventToSend = deepStripWriteback(eventToSend);

            const data = JSON.stringify({
              event: eventToSend?.type,
              data: eventToSend,
            });

            if (eventToSend?.type === "response.output_text.delta") {
              tapStreamLine({ t: "delta", s: eventToSend.delta });
            }
            if (eventToSend?.type === "response.output_text.done") {
              tapStreamLine({ t: "done", s: eventToSend.text });
            }

            try {
              controller.enqueue(`data: ${data}\n\n`);
            } catch (e) {
              // Enqueue failing usually means downstream closed/disconnected.
              markAborted("controller.enqueue_failed", e);
              break;
            }
          }

          if (!clientAborted) {
            const wbRes = extractWriteBackFromText(assistantText);

            if (wbRes.status !== "ok") {
              appendEventLogLine(eventLogPath, {
                ts: new Date().toISOString(),
                inv_sha12: invocationSha12,
                vector_store_id_primary: sanitizeVectorStoreIds(cappedVectorStoreIds)[0] ?? "",
                vector_store_ids_active: sanitizeVectorStoreIds(cappedVectorStoreIds),
                writeback_error: {
                  status: wbRes.status,
                  error: (wbRes as any).error ?? "",
                },
              });
            } else {
              const validated = validateWriteBackEnvelope(wbRes.value);

              if (!validated.ok) {
                appendEventLogLine(eventLogPath, {
                  ts: new Date().toISOString(),
                  inv_sha12: invocationSha12,
                  vector_store_id_primary: sanitizeVectorStoreIds(cappedVectorStoreIds)[0] ?? "",
                  vector_store_ids_active: sanitizeVectorStoreIds(cappedVectorStoreIds),
                  writeback_error: {
                    status: "invalid_schema",
                    error: validated.error,
                  },
                });
              } else {
                const w = validated.writeback;

                // Apply: events
                if (Array.isArray(w.events)) {
                  statePack.events = Array.isArray(statePack.events) ? statePack.events : [];
                  statePack.events.push(...w.events);
                }

                // Apply: state_patch (after normalizing now_add/next_add/parked_add)
                if (validated.normalizedPatch) {
                  const merged = applyPatchAppendArrays(statePack, validated.normalizedPatch);
                  Object.assign(statePack, merged);
                }

                // Apply: parked (explicit list)
                if (Array.isArray(w.parked)) {
                  statePack.queue = statePack.queue || {};
                  statePack.queue.parked = Array.isArray(statePack.queue.parked)
                    ? statePack.queue.parked
                    : [];
                  statePack.queue.parked.push(...w.parked);
                }

                // Apply: notes (append)
                if (typeof w.notes === "string" && w.notes.trim()) {
                  statePack.notes = (statePack.notes ? statePack.notes + "\n" : "") + w.notes.trim();
                }

                // Persist (saveStatePack stamps meta.updated_at + updated_at)
                saveStatePack(statePath, statePack);

                appendEventLogLine(eventLogPath, {
                  ts: new Date().toISOString(),
                  inv_sha12: invocationSha12,
                  vector_store_id_primary: sanitizeVectorStoreIds(cappedVectorStoreIds)[0] ?? "",
                  vector_store_ids_active: sanitizeVectorStoreIds(cappedVectorStoreIds),
                  writeback: {
                    events_count: Array.isArray(w.events) ? w.events.length : 0,
                    patch_keys: validated.normalizedPatch ? Object.keys(validated.normalizedPatch) : [],
                    parked_count: Array.isArray(w.parked) ? w.parked.length : 0,
                    notes: safeTruncate(w.notes ?? "", 800),
                  },
                });
              }
            }
          }

          try {
            controller.close();
          } catch {
            // ignore
          }
        } catch (error) {
          // If we were aborted, do not surface error noise.
          if (clientAborted) {
            try {
              controller.close();
            } catch {
              // ignore
            }
            return;
          }

          console.error("Error in streaming loop:", error);
          controller.error(error);
        } finally {
          try {
            request.signal?.removeEventListener?.("abort", onRequestAbort as any);
          } catch {
            // ignore
          }
        }
      },
      cancel(reason) {
        markAborted("ReadableStream.cancel", reason);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("Error in POST handler:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}















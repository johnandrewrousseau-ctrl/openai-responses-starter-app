import { parse } from "partial-json";
import { handleTool } from "@/lib/tools/tools-handling";
import useConversationStore from "@/stores/useConversationStore";
import useToolsStore, { ToolsState } from "@/stores/useToolsStore";
import { Annotation } from "@/components/annotations";
import { functionsMap } from "@/config/functions";

const normalizeAnnotation = (annotation: any): Annotation => ({
  ...annotation,
  fileId: annotation.file_id ?? annotation.fileId,
  containerId: annotation.container_id ?? annotation.containerId,
});

export interface ContentItem {
  type: "input_text" | "output_text" | "refusal" | "output_audio";
  annotations?: Annotation[];
  text?: string;
}

// Message items for storing conversation history matching API shape
export interface MessageItem {
  type: "message";
  role: "user" | "assistant" | "system";
  id?: string;
  content: ContentItem[];
}

// Custom items to display in chat
export interface ToolCallItem {
  type: "tool_call";
  tool_type:
    | "file_search_call"
    | "web_search_call"
    | "function_call"
    | "mcp_call"
    | "code_interpreter_call";
  status: "in_progress" | "completed" | "failed" | "searching";
  id: string;
  name?: string | null;
  call_id?: string;
  arguments?: string;
  parsedArguments?: any;
  output?: string | null;
  code?: string;
  files?: {
    file_id: string;
    mime_type: string;
    container_id?: string;
    filename?: string;
  }[];
}

export interface McpListToolsItem {
  type: "mcp_list_tools";
  id: string;
  server_label: string;
  tools: { name: string; description?: string }[];
}

export interface McpApprovalRequestItem {
  type: "mcp_approval_request";
  id: string;
  server_label: string;
  name: string;
  arguments?: string;
}

export type Item =
  | MessageItem
  | ToolCallItem
  | McpListToolsItem
  | McpApprovalRequestItem;

// --- UI-only: hide WriteBack blocks from rendered assistant text ---
// Server still receives + parses WriteBack; this only prevents rendering it in the UI.
const WRITEBACK_START = "BEGIN_WRITEBACK_JSON";
const WRITEBACK_END = "END_WRITEBACK_JSON";

function stripWriteBackBlock(fullText: string): string {
  if (!fullText) return "";
  const s = fullText.lastIndexOf(WRITEBACK_START);
  if (s === -1) return fullText;
  const e = fullText.indexOf(WRITEBACK_END, s);
  if (e === -1) return fullText.slice(0, s).trimEnd();
  return (fullText.slice(0, s) + fullText.slice(e + WRITEBACK_END.length)).trimEnd();
}

/**
 * Sanitizes *any* message-like item in-place so WriteBack blocks never enter:
 * - chatMessages
 * - conversationItems (critical for VAL-11)
 */
function sanitizeWritebackOnMessageLike(item: any) {
  if (!item || typeof item !== "object") return;

  // Shape: { type:"message", content:{ text:"..." } }
  if (item.type === "message" && item.content && typeof item.content.text === "string") {
    item.content.text = stripWriteBackBlock(item.content.text);
  }

  // Shape: { type:"message", content:[{ text:"..." }, ...] }
  if (item.type === "message" && Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part && typeof part.text === "string") {
        part.text = stripWriteBackBlock(part.text);
      }
    }
  }

  // Shape: { role:"assistant", content:[{ type:"output_text", text:"..." }] } (what you push into conversationItems)
  if (typeof item.role === "string" && Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part && typeof part.text === "string") {
        part.text = stripWriteBackBlock(part.text);
      }
    }
  }
}

function extractTextAndAnnotationsFromMessageItem(item: any): {
  text: string;
  annotations: Annotation[];
} {
  if (!item || typeof item !== "object") return { text: "", annotations: [] };

  // Prefer array shape
  if (Array.isArray(item.content) && item.content.length > 0) {
    const p0 = item.content[0];
    const rawText = typeof p0?.text === "string" ? p0.text : "";
    const anns = Array.isArray(p0?.annotations) ? p0.annotations.map(normalizeAnnotation) : [];
    return { text: stripWriteBackBlock(rawText), annotations: anns };
  }

  // Fallback legacy-ish shape
  const rawText = typeof item.content?.text === "string" ? item.content.text : "";
  const anns = Array.isArray(item.content?.annotations)
    ? item.content.annotations.map(normalizeAnnotation)
    : [];
  return { text: stripWriteBackBlock(rawText), annotations: anns };
}

// ---------- Phase B3 helpers: predictable UI error surfaces ----------
function buildUiErrorMarkdown(title: string, details: unknown) {
  const s =
    typeof details === "string"
      ? details
      : details && typeof details === "object"
      ? JSON.stringify(details, null, 2)
      : String(details ?? "");

  return `### ${title}\n\n\`\`\`\n${s}\n\`\`\``;
}

async function readAnyBody(res: Response): Promise<any> {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) return await res.json();
  } catch {
    // ignore
  }
  try {
    return await res.text();
  } catch {
    // ignore
  }
  return null;
}
// ---------- End B3 helpers ----------

/* ---------------------- Canon Ops (UI visibility layer) ---------------------- */

type CanonOpsUiCache = {
  ok: boolean;
  loadedAt: number;
  generatedAt: string | null;
  tombstoneSet: Set<string>;
  effectiveSuccessorMap: Record<string, string>;
};

let canonOpsCache: CanonOpsUiCache | null = null;
let canonOpsInflight: Promise<CanonOpsUiCache | null> | null = null;

function safeToString(v: any): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function normalizeStringArray(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => safeToString(x)).filter(Boolean);
  return [];
}

function normalizeStringRecord(v: any): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    const kk = (k || "").toString().trim();
    const vv = safeToString(val).trim();
    if (!kk || !vv) continue;
    out[kk] = vv;
  }
  return out;
}

/**
 * Best-effort cache loader for Canon Ops.
 * Never throws. Never blocks a turn if it fails.
 */
async function getCanonOpsUiCacheBestEffort(): Promise<CanonOpsUiCache | null> {
  const now = Date.now();

  // 10s TTL is enough for UI; avoids spam.
  const TTL_MS = 10_000;

  if (canonOpsCache && now - canonOpsCache.loadedAt < TTL_MS) {
    return canonOpsCache;
  }

  if (canonOpsInflight) return canonOpsInflight;

  canonOpsInflight = (async () => {
    try {
      const res = await fetch("/api/canon_ops", { method: "GET" });
      if (!res.ok) {
        canonOpsCache = {
          ok: false,
          loadedAt: now,
          generatedAt: null,
          tombstoneSet: new Set<string>(),
          effectiveSuccessorMap: {},
        };
        return canonOpsCache;
      }

      const j = await res.json();

      // Server shape (observed):
      // { ok, generated_at, ... , ops: { tombstone_set: [], effective_successor_map: {...}, generated_at } }
      const ops = (j && typeof j === "object" ? (j as any).ops : null) ?? null;

      const generatedAt =
        (ops && typeof ops.generated_at === "string" ? ops.generated_at : null) ??
        (j && typeof (j as any).generated_at === "string" ? (j as any).generated_at : null);

      const tombstoneSetArr =
        normalizeStringArray(ops?.tombstone_set) ||
        normalizeStringArray((j as any)?.tombstone_set) ||
        [];

      const effectiveMap =
        normalizeStringRecord(ops?.effective_successor_map) ||
        normalizeStringRecord((j as any)?.effective_successor_map) ||
        {};

      canonOpsCache = {
        ok: true,
        loadedAt: now,
        generatedAt,
        tombstoneSet: new Set<string>(tombstoneSetArr.map((x) => x.trim()).filter(Boolean)),
        effectiveSuccessorMap: effectiveMap,
      };

      return canonOpsCache;
    } catch {
      canonOpsCache = {
        ok: false,
        loadedAt: now,
        generatedAt: null,
        tombstoneSet: new Set<string>(),
        effectiveSuccessorMap: {},
      };
      return canonOpsCache;
    } finally {
      canonOpsInflight = null;
    }
  })();

  return canonOpsInflight;
}

/**
 * Conservative artifact-id detector:
 * - requires at least one dash or dot to reduce false positives.
 * - captures forms like PF-2, MEM-1.0, CMA-0.1, TEACHING-ARM, PF-2.A, PF-2.A.1
 */
function extractArtifactIdsFromText(text: string): string[] {
  if (!text) return [];
  const re = /\b[A-Z][A-Z0-9]*(?:[-.][A-Z0-9]+)+\b/g;
  const m = text.match(re);
  if (!m) return [];
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const raw of m) {
    const id = raw.trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    uniq.push(id);
  }
  return uniq;
}

function buildCanonOpsUiNotice(assistantText: string, canonOps: CanonOpsUiCache): string | null {
  if (!assistantText) return null;
  if (!canonOps || !canonOps.ok) return null;

  const ids = extractArtifactIdsFromText(assistantText);
  if (ids.length === 0) return null;

  const supersededPairs: Array<{ from: string; to: string }> = [];
  const tombstoned: string[] = [];

  for (const id of ids) {
    const to = canonOps.effectiveSuccessorMap[id];
    if (to && to !== id) {
      supersededPairs.push({ from: id, to });
    }
    if (canonOps.tombstoneSet.has(id)) {
      tombstoned.push(id);
    }
  }

  if (supersededPairs.length === 0 && tombstoned.length === 0) return null;

  const lines: string[] = [];
  lines.push("");
  lines.push("---");
  lines.push("### Canon Ops (UI notice)");
  if (canonOps.generatedAt) lines.push(`- canon_ops.generated_at: \`${canonOps.generatedAt}\``);

  if (supersededPairs.length > 0) {
    lines.push("");
    lines.push("**Supersession mappings detected in the assistant text:**");
    for (const p of supersededPairs.slice(0, 30)) {
      lines.push(`- \`${p.from}\` → \`${p.to}\``);
    }
    if (supersededPairs.length > 30) lines.push(`- …and ${supersededPairs.length - 30} more`);
  }

  if (tombstoned.length > 0) {
    lines.push("");
    lines.push(
      "**Tombstoned artifact IDs detected (should not be treated as current truth unless explicitly requested):**"
    );
    for (const t of tombstoned.slice(0, 30)) {
      lines.push(`- \`${t}\``);
    }
    if (tombstoned.length > 30) lines.push(`- …and ${tombstoned.length - 30} more`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Strict preflight notice:
 * - runs BEFORE calling /api/turn_response
 * - scans the latest user text
 * - warns if user referenced tombstoned IDs or superseded IDs
 * - does not block; warns + proceeds
 */
function buildPreflightCanonOpsNotice(userText: string, canonOps: CanonOpsUiCache): string | null {
  if (!userText) return null;
  if (!canonOps || !canonOps.ok) return null;

  const ids = extractArtifactIdsFromText(userText);
  if (ids.length === 0) return null;

  const supersededPairs: Array<{ from: string; to: string }> = [];
  const tombstoned: string[] = [];

  for (const id of ids) {
    const to = canonOps.effectiveSuccessorMap[id];
    if (to && to !== id) supersededPairs.push({ from: id, to });
    if (canonOps.tombstoneSet.has(id)) tombstoned.push(id);
  }

  if (supersededPairs.length === 0 && tombstoned.length === 0) return null;

  const lines: string[] = [];
  lines.push("### Preflight Canon Ops Notice");
  if (canonOps.generatedAt) lines.push(`- canon_ops.generated_at: \`${canonOps.generatedAt}\``);
  lines.push("- This is a UI-only warning. The request will proceed.");

  if (supersededPairs.length > 0) {
    lines.push("");
    lines.push("**You referenced superseded artifact IDs:**");
    for (const p of supersededPairs.slice(0, 30)) lines.push(`- \`${p.from}\` → \`${p.to}\``);
    if (supersededPairs.length > 30) lines.push(`- …and ${supersededPairs.length - 30} more`);
  }

  if (tombstoned.length > 0) {
    lines.push("");
    lines.push("**You referenced tombstoned artifact IDs:**");
    for (const t of tombstoned.slice(0, 30)) lines.push(`- \`${t}\``);
    if (tombstoned.length > 30) lines.push(`- …and ${tombstoned.length - 30} more`);
  }

  lines.push("");
  return lines.join("\n");
}

function extractLatestUserText(messages: any[]): string {
  if (!Array.isArray(messages)) return "";

  // Walk from the end; accept a few common shapes defensively.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;

    // Shape A: { type:"message", role:"user", content:[{text:"..."}] }
    if ((m as any).type === "message" && (m as any).role === "user") {
      const c = (m as any).content;
      if (Array.isArray(c)) {
        const parts: string[] = [];
        for (const it of c) {
          if (!it) continue;
          if (typeof it.text === "string") parts.push(it.text);
        }
        const joined = parts.join("\n").trim();
        if (joined) return joined;
      }
    }

    // Shape B: { role:"user", content:"..." }
    if ((m as any).role === "user" && typeof (m as any).content === "string") {
      const s = ((m as any).content as string).trim();
      if (s) return s;
    }

    // Shape C: { role:"user", content:[{type:"input_text", text:"..."}] }
    if ((m as any).role === "user" && Array.isArray((m as any).content)) {
      const parts: string[] = [];
      for (const it of (m as any).content) {
        if (!it) continue;
        if (typeof it.text === "string") parts.push(it.text);
      }
      const joined = parts.join("\n").trim();
      if (joined) return joined;
    }
  }

  return "";
}

/* -------------------- End Canon Ops (UI visibility layer) ------------------- */

export const handleTurn = async (
  messages: any[],
  toolsState: ToolsState,
  onMessage: (data: any) => void
) => {
  // Emits an assistant message using the existing pipeline (no new event types).
  const emitUiError = (title: string, details: unknown) => {
    const md = buildUiErrorMarkdown(title, details);
    onMessage({
      event: "response.output_text.delta",
      data: { type: "response.output_text.delta", delta: md },
    });
  };

  // Lightweight “notice” emitter (not an error).
  const emitUiNotice = (md: string) => {
    if (!md) return;
    onMessage({
      event: "response.output_text.delta",
      data: { type: "response.output_text.delta", delta: md + "\n\n" },
    });
  };

  try {
    const { googleIntegrationEnabled } = useToolsStore.getState();

    // Preload Canon Ops cache (best-effort).
    const canonOps = await getCanonOpsUiCacheBestEffort();

    // STRICTER: preflight warn on user-referenced tombstoned/superseded IDs.
    if (canonOps && canonOps.ok) {
      const lastUserText = extractLatestUserText(messages);
      const preflight = buildPreflightCanonOpsNotice(lastUserText, canonOps);
      if (preflight) emitUiNotice(preflight);
    }

        // Get response from the API (defined in app/api/turn_response/route.ts)
    // CLIENT_SSE_STALL_TIMEOUT_RETRY_V1
    const STALL_MS = 45_000; // abort if no bytes arrive for this long
    const MAX_RETRIES = 1;

    const streamOnce = async () => { // ASSISTANT_STREAMONCE_NO_ATTEMPT_V1
      const controller = new AbortController();
      let stallTimer: any = null;

      const bump = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          try { controller.abort(); } catch {}
        }, STALL_MS);
      };

      try {
        bump();

        const toolsStateForServer = {
          fileSearchEnabled: toolsState.fileSearchEnabled,
          webSearchEnabled: toolsState.webSearchEnabled,
          functionsEnabled: toolsState.functionsEnabled,
          googleIntegrationEnabled:
            toolsState.googleIntegrationEnabled ?? googleIntegrationEnabled,
          mcpEnabled: toolsState.mcpEnabled,
          codeInterpreterEnabled: toolsState.codeInterpreterEnabled,
          ...(typeof (toolsState as any).dev_bypass_active === "boolean"
            ? { dev_bypass_active: (toolsState as any).dev_bypass_active }
            : {}),
        };

        const response = await fetch("/api/turn_response", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            messages: messages,
            toolsState: toolsStateForServer,
          }),
        });

        // B3: stop immediately on non-OK and surface clean UI error.
        if (!response.ok) {
          const body = await readAnyBody(response);
          emitUiError(`API Error (${response.status})`, body ?? response.statusText);
          return;
        }

        // B3: ensure server returned SSE; otherwise show error (prevents “jumbled” parsing).
        const ct = (response.headers.get("content-type") || "").toLowerCase();
        if (!ct.includes("text/event-stream")) {
          const body = await readAnyBody(response);
          emitUiError("Unexpected response (not SSE)", body ?? ct);
          return;
        }

        if (!response.body) {
          emitUiError("Streaming error", "Response body was empty (no stream).");
          return;
        }

        // Reader for streaming data
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let done = false;
        let buffer = "";

        // UI-only filter state:
        // We delay emitting the last N chars so we never leak a partial "BEGIN_WRITEBACK_JSON".
        let wbSuppressed = false;
        let pending = "";
        const keep = Math.max(0, WRITEBACK_START.length - 1);

        // Accumulate visible assistant text (for post-pass Canon Ops UI notice).
        let assistantVisibleText = "";

        const emitDelta = (deltaText: string) => {
          if (!deltaText) return;
          assistantVisibleText += deltaText;
          onMessage({
            event: "response.output_text.delta",
            data: { type: "response.output_text.delta", delta: deltaText },
          });
        };

        const processPayload = (payload: any) => {
          const eventType = payload?.event;
          const ev = payload?.data;

          // CRITICAL: prevent WriteBack from entering stored conversation items via output_item events.
          if (
            (eventType === "response.output_item.added" || eventType === "response.output_item.done") &&
            ev?.item
          ) {
            sanitizeWritebackOnMessageLike(ev.item);
          }

          // Streamed assistant text deltas: suppress anything from BEGIN_WRITEBACK_JSON onward.
          if (eventType === "response.output_text.delta" && typeof ev?.delta === "string") {
            if (wbSuppressed) return;

            pending += ev.delta;

            const idx = pending.indexOf(WRITEBACK_START);
            if (idx !== -1) {
              const emit = pending.slice(0, idx);
              pending = "";
              wbSuppressed = true;
              if (emit) emitDelta(emit);
              return;
            }

            if (pending.length > keep) {
              const emit = pending.slice(0, pending.length - keep);
              pending = pending.slice(-keep);
              if (emit) emitDelta(emit);
            }

            return; // do not forward the raw payload; we emitted a cleaned delta
          }

          // "done" event sometimes includes full text; sanitize it to ensure WriteBack never reappears.
          if (eventType === "response.output_text.done" && typeof ev?.text === "string") {
            const cleaned = stripWriteBackBlock(ev.text);
            payload.data.text = cleaned;
            onMessage(payload);
            return;
          }

          // Pass through all non-text events unchanged (tool calls, etc.)
          onMessage(payload);
        };

        while (!done) {
          const { value, done: doneReading } = await reader.read();
          bump(); // we received bytes (or EOF)

          done = doneReading;

          const chunkValue = value ? decoder.decode(value) : "";
          if (chunkValue) buffer += chunkValue;

          const lines = buffer.split("\n\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const dataStr = line.slice(6);
            if (dataStr === "[DONE]") {
              done = true;
              break;
            }

            // B3: guard parsing. If JSON parse fails, surface clean UI error and stop.
            let payload: any = null;
            try {
              payload = JSON.parse(dataStr);
            } catch (e: any) {
              emitUiError("Stream parse error (invalid JSON)", {
                parse_error: String(e?.message ?? e ?? "unknown"),
                sample: dataStr.slice(0, 300),
              });
              done = true;
              break;
            }

            processPayload(payload);
          }
        }

        // Flush any pending tail (the withheld last N chars) if we never hit WriteBack.
        if (!wbSuppressed && pending) {
          emitDelta(pending);
          pending = "";
        }

        // Handle any remaining data in buffer
        if (buffer && buffer.startsWith("data: ")) {
          const dataStr = buffer.slice(6);
          if (dataStr !== "[DONE]") {
            try {
              const payload = JSON.parse(dataStr);
              processPayload(payload);
            } catch (e: any) {
              emitUiError("Stream parse error (tail)", {
                parse_error: String(e?.message ?? e ?? "unknown"),
                sample: dataStr.slice(0, 300),
              });
            }
          }
        }

        // Post-pass: Canon Ops UI notice based on assistant visible text.
        const canonOps2 = await getCanonOpsUiCacheBestEffort();
        if (canonOps2 && canonOps2.ok) {
          const notice = buildCanonOpsUiNotice(assistantVisibleText, canonOps2);
          if (notice) {
            emitDelta(notice);
          }
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await streamOnce();
        break;
      } catch (e: any) {
        const msg = String(e?.message ?? e ?? "unknown");
        const isAbort = msg.toLowerCase().includes("abort");
        if (attempt < MAX_RETRIES && isAbort) {
          emitUiNotice("Stream stalled; retrying once...");
          continue;
        }
        throw e;
      }
    }
} catch (error: any) {
    // B3: show a clean assistant-visible error instead of silent console-only failure.
    const md = buildUiErrorMarkdown("Client error (handleTurn)", {
      message: String(error?.message ?? error ?? "unknown"),
    });
    onMessage({
      event: "response.output_text.delta",
      data: { type: "response.output_text.delta", delta: md },
    });
  }
};

export const processMessages = async () => {
  const {
    chatMessages,
    conversationItems,
    setChatMessages,
    setConversationItems,
    setAssistantLoading,
    runMode,
  } = useConversationStore.getState();

  const store = useToolsStore.getState() as any;
  const toolsState: ToolsState = {
    fileSearchEnabled: Boolean(store?.fileSearchEnabled),
    webSearchEnabled: Boolean(store?.webSearchEnabled),
    functionsEnabled: Boolean(store?.functionsEnabled),
    googleIntegrationEnabled: Boolean(store?.googleIntegrationEnabled),
    mcpEnabled: Boolean(store?.mcpEnabled),
    codeInterpreterEnabled: Boolean(store?.codeInterpreterEnabled),
    ...(typeof store?.dev_bypass_active === "boolean"
      ? { dev_bypass_active: store.dev_bypass_active }
      : {}),
  };
  const runnerModeActive = runMode && runMode !== "normal";
  const toolsStateForRunner: ToolsState = runnerModeActive
    ? {
        ...toolsState,
        fileSearchEnabled: true,
        webSearchEnabled: false,
        functionsEnabled: false,
      }
    : toolsState;

  const allConversationItems = conversationItems;

  let assistantMessageContent = "";
  let functionArguments = "";
  // For streaming MCP tool call arguments
  let mcpArguments = "";

  await handleTurn(allConversationItems, toolsStateForRunner, async ({ event, data }) => {
    switch (event) {
      case "response.output_text.delta":
      case "response.output_text.annotation.added": {
        const { delta, item_id, annotation } = data;

        let partial = "";
        if (typeof delta === "string") {
          partial = delta;
        }
        assistantMessageContent += partial;

        // If the last message isn't an assistant message, create a new one
        const lastItem = chatMessages[chatMessages.length - 1];
        if (
          !lastItem ||
          lastItem.type !== "message" ||
          lastItem.role !== "assistant" ||
          (lastItem.id && lastItem.id !== item_id)
        ) {
          chatMessages.push({
            type: "message",
            role: "assistant",
            id: item_id,
            content: [
              {
                type: "output_text",
                text: assistantMessageContent,
              },
            ],
          } as MessageItem);
        } else {
          const contentItem = lastItem.content[0];
          if (contentItem && contentItem.type === "output_text") {
            contentItem.text = assistantMessageContent;
            if (annotation) {
              contentItem.annotations = [
                ...(contentItem.annotations ?? []),
                normalizeAnnotation(annotation),
              ];
            }
          }
        }

        setChatMessages([...chatMessages]);
        setAssistantLoading(false);
        break;
      }

      case "response.output_item.added": {
        const { item } = data || {};
        if (!item || !item.type) {
          break;
        }

        // Extra belt-and-suspenders: sanitize WriteBack on any message item immediately.
        sanitizeWritebackOnMessageLike(item);

        setAssistantLoading(false);

        switch (item.type) {
          case "message": {
            const { text, annotations } = extractTextAndAnnotationsFromMessageItem(item);

            chatMessages.push({
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text,
                  ...(annotations.length > 0 ? { annotations } : {}),
                },
              ],
            });

            // Critical: store sanitized text into durable conversationItems to avoid VAL-11 loops.
            const stored = {
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text,
                  ...(annotations.length > 0 ? { annotations } : {}),
                },
              ],
            };
            sanitizeWritebackOnMessageLike(stored);

            conversationItems.push(stored);

            setChatMessages([...chatMessages]);
            setConversationItems([...conversationItems]);
            break;
          }

          case "function_call": {
            functionArguments += item.arguments || "";
            chatMessages.push({
              type: "tool_call",
              tool_type: "function_call",
              status: "in_progress",
              id: item.id,
              name: item.name,
              arguments: item.arguments || "",
              parsedArguments: {},
              output: null,
            });
            setChatMessages([...chatMessages]);
            break;
          }

          case "web_search_call": {
            chatMessages.push({
              type: "tool_call",
              tool_type: "web_search_call",
              status: item.status || "in_progress",
              id: item.id,
            });
            setChatMessages([...chatMessages]);
            break;
          }

          case "file_search_call": {
            chatMessages.push({
              type: "tool_call",
              tool_type: "file_search_call",
              status: item.status || "in_progress",
              id: item.id,
            });
            setChatMessages([...chatMessages]);
            break;
          }

          case "mcp_call": {
            mcpArguments = item.arguments || "";
            chatMessages.push({
              type: "tool_call",
              tool_type: "mcp_call",
              status: "in_progress",
              id: item.id,
              name: item.name,
              arguments: item.arguments || "",
              parsedArguments: item.arguments ? parse(item.arguments) : {},
              output: null,
            });
            setChatMessages([...chatMessages]);
            break;
          }

          case "code_interpreter_call": {
            chatMessages.push({
              type: "tool_call",
              tool_type: "code_interpreter_call",
              status: item.status || "in_progress",
              id: item.id,
              code: "",
              files: [],
            });
            setChatMessages([...chatMessages]);
            break;
          }
        }
        break;
      }

      case "response.output_item.done": {
        const { item } = data || {};
        if (item) sanitizeWritebackOnMessageLike(item);

        const toolCallMessage = chatMessages.find((m) => m.id === item.id);
        if (toolCallMessage && toolCallMessage.type === "tool_call") {
          toolCallMessage.call_id = item.call_id;
          setChatMessages([...chatMessages]);
        }

        // Critical: prevent WriteBack content from being persisted into conversationItems.
        if (item && item.type === "message") {
          // Ensure content text is clean before persisting
          sanitizeWritebackOnMessageLike(item);
        }

        conversationItems.push(item);
        setConversationItems([...conversationItems]);

        if (
          toolCallMessage &&
          toolCallMessage.type === "tool_call" &&
          toolCallMessage.tool_type === "function_call"
        ) {
          const toolResult = await handleTool(
            toolCallMessage.name as keyof typeof functionsMap,
            toolCallMessage.parsedArguments
          );

          toolCallMessage.output = JSON.stringify(toolResult);
          setChatMessages([...chatMessages]);
          conversationItems.push({
            type: "function_call_output",
            call_id: toolCallMessage.call_id,
            status: "completed",
            output: JSON.stringify(toolResult),
          });
          setConversationItems([...conversationItems]);

          await processMessages();
        }

        if (
          toolCallMessage &&
          toolCallMessage.type === "tool_call" &&
          toolCallMessage.tool_type === "mcp_call"
        ) {
          toolCallMessage.output = item.output;
          toolCallMessage.status = "completed";
          setChatMessages([...chatMessages]);
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        functionArguments += data.delta || "";
        let parsedFunctionArguments = {};

        const toolCallMessage = chatMessages.find((m) => m.id === data.item_id);
        if (toolCallMessage && toolCallMessage.type === "tool_call") {
          toolCallMessage.arguments = functionArguments;
          try {
            if (functionArguments.length > 0) {
              parsedFunctionArguments = parse(functionArguments);
            }
            toolCallMessage.parsedArguments = parsedFunctionArguments;
          } catch {
            // ignore
          }
          setChatMessages([...chatMessages]);
        }
        break;
      }

      case "response.function_call_arguments.done": {
        const { item_id, arguments: finalArgs } = data;

        functionArguments = finalArgs;

        const toolCallMessage = chatMessages.find((m) => m.id === item_id);
        if (toolCallMessage && toolCallMessage.type === "tool_call") {
          toolCallMessage.arguments = finalArgs;
          toolCallMessage.parsedArguments = parse(finalArgs);
          toolCallMessage.status = "completed";
          setChatMessages([...chatMessages]);
        }
        break;
      }

      case "response.mcp_call_arguments.delta": {
        mcpArguments += data.delta || "";
        let parsedMcpArguments: any = {};
        const toolCallMessage = chatMessages.find((m) => m.id === data.item_id);
        if (toolCallMessage && toolCallMessage.type === "tool_call") {
          toolCallMessage.arguments = mcpArguments;
          try {
            if (mcpArguments.length > 0) {
              parsedMcpArguments = parse(mcpArguments);
            }
            toolCallMessage.parsedArguments = parsedMcpArguments;
          } catch {
            // ignore
          }
          setChatMessages([...chatMessages]);
        }
        break;
      }

      case "response.mcp_call_arguments.done": {
        const { item_id, arguments: finalArgs } = data;
        mcpArguments = finalArgs;
        const toolCallMessage = chatMessages.find((m) => m.id === item_id);
        if (toolCallMessage && toolCallMessage.type === "tool_call") {
          toolCallMessage.arguments = finalArgs;
          toolCallMessage.parsedArguments = parse(finalArgs);
          toolCallMessage.status = "completed";
          setChatMessages([...chatMessages]);
        }
        break;
      }

      case "response.web_search_call.completed": {
        const { item_id, output } = data;
        const toolCallMessage = chatMessages.find((m) => m.id === item_id);
        if (toolCallMessage && toolCallMessage.type === "tool_call") {
          toolCallMessage.output = output;
          toolCallMessage.status = "completed";
          setChatMessages([...chatMessages]);
        }
        break;
      }

      case "response.file_search_call.completed": {
        const { item_id, output } = data;
        const toolCallMessage = chatMessages.find((m) => m.id === item_id);
        if (toolCallMessage && toolCallMessage.type === "tool_call") {
          toolCallMessage.output = output;
          toolCallMessage.status = "completed";
          setChatMessages([...chatMessages]);
        }
        break;
      }

      case "response.code_interpreter_call_code.delta": {
        const { delta, item_id } = data;
        const toolCallMessage = [...chatMessages]
          .reverse()
          .find(
            (m) =>
              m.type === "tool_call" &&
              m.tool_type === "code_interpreter_call" &&
              m.status !== "completed" &&
              m.id === item_id
          ) as ToolCallItem | undefined;

        if (toolCallMessage) {
          toolCallMessage.code = (toolCallMessage.code || "") + delta;
          setChatMessages([...chatMessages]);
        }
        break;
      }

      case "response.code_interpreter_call_code.done": {
        const { code, item_id } = data;
        const toolCallMessage = [...chatMessages]
          .reverse()
          .find(
            (m) =>
              m.type === "tool_call" &&
              m.tool_type === "code_interpreter_call" &&
              m.status !== "completed" &&
              m.id === item_id
          ) as ToolCallItem | undefined;

        if (toolCallMessage) {
          toolCallMessage.code = code;
          toolCallMessage.status = "completed";
          setChatMessages([...chatMessages]);
        }
        break;
      }

      case "response.code_interpreter_call.completed": {
        const { item_id } = data;
        const toolCallMessage = chatMessages.find(
          (m) => m.type === "tool_call" && m.id === item_id
        ) as ToolCallItem | undefined;
        if (toolCallMessage) {
          toolCallMessage.status = "completed";
          setChatMessages([...chatMessages]);
        }
        break;
      }

      case "response.completed": {
        console.log("response completed", data);
        const { response } = data;

        const mcpListToolsMessages = response.output.filter(
          (m: Item) => m.type === "mcp_list_tools"
        ) as McpListToolsItem[];

        if (mcpListToolsMessages && mcpListToolsMessages.length > 0) {
          for (const msg of mcpListToolsMessages) {
            chatMessages.push({
              type: "mcp_list_tools",
              id: msg.id,
              server_label: msg.server_label,
              tools: msg.tools || [],
            });
          }
          setChatMessages([...chatMessages]);
        }

        const mcpApprovalRequestMessage = response.output.find(
          (m: Item) => m.type === "mcp_approval_request"
        );

        if (mcpApprovalRequestMessage) {
          chatMessages.push({
            type: "mcp_approval_request",
            id: mcpApprovalRequestMessage.id,
            server_label: mcpApprovalRequestMessage.server_label,
            name: mcpApprovalRequestMessage.name,
            arguments: mcpApprovalRequestMessage.arguments,
          });
          setChatMessages([...chatMessages]);
        }

        break;
      }

      // other events as needed
    }
  });
};

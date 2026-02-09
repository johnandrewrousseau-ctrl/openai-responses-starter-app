export const runtime = "nodejs";

import fs from "node:fs";
import path from "node:path";

/// ADMIN_GATE_V1
import { timingSafeEqual } from "crypto";

const DEV_ALLOW_TOOLS_NO_AUTH =
  String(process.env.MEKA_DEV_ALLOW_TOOLS_WITHOUT_AUTH || "").trim() === "1";

function isLoopbackRequest(req: Request): boolean {
  try {
    const u = new URL(req.url);
    const h = (u.hostname || "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

function isDevLoopbackAllowed(req: Request): boolean {
  return DEV_ALLOW_TOOLS_NO_AUTH && isLoopbackRequest(req);
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getBearerToken(req: Request): string {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)\s*$/i);
  return (m?.[1] || "").trim();
}

function safeEq(a: string, b: string) {
  const aa = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

function requireAdmin(req: Request): Response | null {
  const expected = (process.env.MEKA_ADMIN_TOKEN || "").trim();
  if (!expected) return json({ ok: false, error: "admin_token_not_configured", status: 500 }, 500);

  const got = getBearerToken(req);
  if ((!got || !safeEq(got, expected)) && !isDevLoopbackAllowed(req)) {
    return json({ ok: false, error: "admin_token_invalid", status: 401 }, 401);
  }
  return null;
}

function stripBom(s: string): string {
  if (!s) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

const WB_BLOCK_RE = /BEGIN_WRITEBACK_JSON[\s\S]*?END_WRITEBACK_JSON/g;

function stripWritebackBlocks(s: string): string {
  if (!s) return "";
  return s.replace(WB_BLOCK_RE, "");
}

function clampTail(s: string, maxChars: number): string {
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return s.slice(Math.max(0, s.length - maxChars));
}

function readLastLines(filePath: string, maxLines = 200): string[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = stripBom(raw).split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(Math.max(0, lines.length - maxLines));
}

async function handle(req: Request) {
  // RETRIEVAL_TRACE_ADMIN_V1
  const auth = requireAdmin(req);
  if (auth) return auth;

  const tapPath = path.join(process.cwd(), "state", "retrieval_tap.jsonl");

  if (!fs.existsSync(tapPath)) {
    return new Response(
      JSON.stringify({
        ok: true,
        present: false,
        message: "state/retrieval_tap.jsonl not found (enable MEKA_RETRIEVAL_TAP=1 to populate).",
      }),
      { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
    );
  }

  try {
    const lines = readLastLines(tapPath, 250);

    let parsed = 0;
    let lastRequest: any = null;
    let lastEventTypeCounts: Record<string, number> = {};
    let lastToolishEvents = 0;

    for (const line of lines) {
      try {
        const obj = JSON.parse(stripBom(line));
        parsed++;

        if (obj?.kind === "request") {
          lastRequest = obj;
          lastEventTypeCounts = {};
          lastToolishEvents = 0;
        }

        if (obj?.kind === "event" && typeof obj?.type === "string") {
          lastEventTypeCounts[obj.type] = (lastEventTypeCounts[obj.type] ?? 0) + 1;

          const t = obj.type;
          const toolish =
            t.includes("file_search") ||
            t.includes("tool") ||
            t.includes("retrieval") ||
            t === "response.output_item.added" ||
            t === "response.output_item.done";

          if (toolish) lastToolishEvents++;
        }
      } catch {
        // ignore invalid JSON lines
      }
    }

    const lastUserText = typeof lastRequest?.last_user_text === "string" ? lastRequest.last_user_text : null;

    const summary = {
      ok: true,
      present: true,
      lines_scanned: lines.length,
      lines_parsed: parsed,
      last_request: lastRequest
        ? {
            ts: lastRequest.ts ?? null,
            truth_policy: lastRequest.truth_policy ?? null,
            anchor_kind: lastRequest.anchor_kind ?? null,
            vector_store_ids_active: lastRequest.vector_store_ids_active ?? [],
            routing_overlay_applied: Boolean(lastRequest.routing_overlay_applied),
            inv_sha12: lastRequest.inv_sha12 ?? null,
            // Hygiene: never expose writeback markers via trace surfaces
            last_user_text: lastUserText ? clampTail(stripWritebackBlocks(lastUserText), 800) : null,
          }
        : null,
      last_request_event_counts: lastRequest ? lastEventTypeCounts : {},
      last_request_toolish_events: lastRequest ? lastToolishEvents : 0,
    };

    return new Response(JSON.stringify(summary), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "trace_read_error",
        message: String(e?.message ?? e ?? "unknown_error"),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}

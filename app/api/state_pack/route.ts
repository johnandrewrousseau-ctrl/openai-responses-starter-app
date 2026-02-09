export const runtime = "nodejs";

import fs from "node:fs";
import path from "node:path";

function stripBom(s: string): string {
  if (!s) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function safeJsonParse(raw: string) {
  return JSON.parse(stripBom(raw).trimStart());
}

// Hygiene: never expose or persist WriteBack blocks in *human-facing* state surfaces
const WB_BLOCK_RE = /BEGIN_WRITEBACK_JSON[\s\S]*?END_WRITEBACK_JSON/g;

function stripWritebackBlocks(s: string): string {
  if (!s) return "";
  return s.replace(WB_BLOCK_RE, "");
}

// Clamp tails so hygiene tests never see runaway state
function clampTail(s: string, maxChars: number): string {
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return s.slice(Math.max(0, s.length - maxChars));
}

export async function GET() {
  const statePath = path.join(process.cwd(), "state", "state_pack.json");

  if (!fs.existsSync(statePath)) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "missing_state_pack",
        path: "state/state_pack.json",
      }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const sp = safeJsonParse(raw);

    const q = sp?.queue ?? {};

    // Notes hygiene: strip writeback blocks, then clamp tail
    const rawNotes = typeof sp?.notes === "string" ? sp.notes : "";
    const notesSanitized = clampTail(stripWritebackBlocks(rawNotes), 1200);

    const summary = {
      ok: true,
      updated_at: sp?.updated_at ?? null,
      mode: sp?.mode ?? null,
      session_id: sp?.meta?.session_id ?? null,
      queue_counts: {
        now: Array.isArray(q?.now) ? q.now.length : 0,
        next: Array.isArray(q?.next) ? q.next.length : 0,
        parked: Array.isArray(q?.parked) ? q.parked.length : 0,
      },
      events_count: Array.isArray(sp?.events) ? sp.events.length : 0,
      notes_tail: notesSanitized,
    };

    return new Response(JSON.stringify(summary), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "parse_error",
        message: String(e?.message ?? e ?? "unknown_error"),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/* TOOL_STATUS_REMOVE_UNUSED_DISABLE_V1 */
import { getTools } from "../../../lib/tools/tools";
import { timingSafeEqual } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function isDevLoopbackAllowed(req: Request): boolean {
  return DEV_ALLOW_TOOLS_NO_AUTH && isLoopbackRequest(req);
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function extractFunctionToolNames(tools: any[]): string[] {
  const names: string[] = [];

  for (const t of tools) {
    if (!t || typeof t !== "object") continue;

    // Only function tools participate in Tool Status.
    if ((t as any).type !== "function") continue;

    // Responses API shape: { type:"function", name:"..." }
    const topName =
      typeof (t as any).name === "string" ? String((t as any).name).trim() : "";

    // Legacy/chat-style shape: { type:"function", function:{ name:"..." } }
    const nestedName =
      (t as any).function && typeof (t as any).function.name === "string"
        ? String((t as any).function.name).trim()
        : "";

    const fnName = topName || nestedName;
    if (fnName) names.push(fnName);
  }

  return names;
}

function getBearerToken(req: Request): string | null {
  const raw = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)\s*$/i);
  return m ? m[1] : null;
}

function checkAdmin(req: Request): { ok: boolean; status: "OK" | "NOT_CONFIGURED" | "NO_HEADER" | "INVALID" } {
  const expected = process.env.MEKA_ADMIN_TOKEN || "";
  if (!expected) return { ok: false, status: "NOT_CONFIGURED" };
  const got = getBearerToken(req);
  if (!got) return { ok: false, status: "NO_HEADER" };
  // TOOL_STATUS_TIMINGSAFE_V1
  const aa = Buffer.from(got || "", "utf8");
  const bb = Buffer.from(expected || "", "utf8");
  if (aa.length !== bb.length || !timingSafeEqual(aa, bb)) return { ok: false, status: "INVALID" };
  return { ok: true, status: "OK" };
}

function localRequestStatus(req: Request): "OK" | "UNKNOWN" {
  try {
    const host = req.headers.get("host") || "";
    if (host.includes("localhost") || host.includes("127.0.0.1")) return "OK";
    return "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

async function parseToolsStateFromBodyBestEffort(req: Request): Promise<any> {
  try {
    const raw = await req.text();
    if (!raw || !raw.trim()) return {};
    const parsed = JSON.parse(raw);

    // Accept either:
    //  - { toolsState: {...} }
    //  - { state: {...} }
    //  - {...} (already looks like state)
    if (parsed && typeof parsed === "object") {
      if ((parsed as any).toolsState && typeof (parsed as any).toolsState === "object") return (parsed as any).toolsState;
      if ((parsed as any).state && typeof (parsed as any).state === "object") return (parsed as any).state;
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

function buildChatToolsRegistered(toolNames: string[]) {
  const hasAny = (...names: string[]) => names.some((n) => toolNames.includes(n));
  return {
    "fs.propose_change": hasAny("fs_propose_change", "fs.propose_change"),
    "fs.read": hasAny("fs_read", "fs.read"),
    "fs.prepare": hasAny("fs_prepare", "fs.prepare"),
    "fs.patch": hasAny("fs_patch", "fs.patch"),
    "fs.replace": hasAny("fs_replace", "fs.replace"),
  };
}

async function computeToolNames(toolsState: any): Promise<string[]> {
  try {
    const extraTools = await getTools(toolsState ?? {});
    return extractFunctionToolNames(Array.isArray(extraTools) ? extraTools : []).sort();
  } catch {
    return [];
  }
}

export async function POST(req: Request) {
  const admin = checkAdmin(req);
  if (!admin.ok && !isDevLoopbackAllowed(req)) return json({ ok: false, error: "admin_token_invalid", status: 401 }, 401);

  const toolsState = await parseToolsStateFromBodyBestEffort(req);

  const requested_tools_state = {
    fileSearchEnabled: Boolean((toolsState as any)?.fileSearchEnabled),
    webSearchEnabled: Boolean((toolsState as any)?.webSearchEnabled),
    functionsEnabled: Boolean((toolsState as any)?.functionsEnabled),
    googleIntegrationEnabled: Boolean((toolsState as any)?.googleIntegrationEnabled),
    mcpEnabled: Boolean((toolsState as any)?.mcpEnabled),
    codeInterpreterEnabled: Boolean((toolsState as any)?.codeInterpreterEnabled),
  };

  // Effective = requested, but function tools are always admin-gated.
  const effective_tools_state = {
    ...requested_tools_state,
    functionsEnabled: Boolean(requested_tools_state.functionsEnabled) && (Boolean(admin.ok) || Boolean(isDevLoopbackAllowed(req))),
  };
  const toolNames = await computeToolNames(effective_tools_state);
  return json({
    ok: true,
    chat_tools_registered: buildChatToolsRegistered(toolNames),
    tool_names: toolNames,
    admin_token_status: admin.status,
    dev_bypass_active: Boolean(isDevLoopbackAllowed(req)),
    server_local_request_status: localRequestStatus(req),
    requested_tools_state,
    effective_tools_state,
    functions_enabled: Boolean(effective_tools_state.functionsEnabled),
  });
}

export async function GET(req: Request) {
  const admin = checkAdmin(req);

  // Public readiness endpoint: always 200.
  // Do not expose function tool names unless authorized (admin or dev loopback allowed).
  const allowDetails = admin.ok || isDevLoopbackAllowed(req);

  if (!allowDetails) {
    return json({
      ok: true,
      admin_token_status: admin.status,
    dev_bypass_active: Boolean(isDevLoopbackAllowed(req)),
      server_local_request_status: localRequestStatus(req),
      tool_names: [],
      chat_tools_registered: buildChatToolsRegistered([]),
      functions_enabled: false,
    });
  }

  const toolNames = await computeToolNames({ functionsEnabled: true });
  return json({
    ok: true,
    chat_tools_registered: buildChatToolsRegistered(toolNames),
    tool_names: toolNames,
    admin_token_status: admin.status,
    dev_bypass_active: Boolean(isDevLoopbackAllowed(req)),
    server_local_request_status: localRequestStatus(req),
    functions_enabled: Boolean(admin.ok),
  });
}



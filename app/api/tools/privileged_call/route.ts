// app/api/tools/privileged_call/route.ts
export const runtime = "nodejs";

import { functionsMap } from "@/config/functions";

type Body = {
  name?: string;
  arguments?: any;
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  let body: Body = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const name = String(body.name ?? "").trim();
  const args = body.arguments ?? {};

  // Hard gate: only privileged FS tools go through this endpoint.
  if (!name.startsWith("fs_")) {
    return json({ ok: false, error: "forbidden_tool", name }, 403);
  }

  const fn: any = (functionsMap as any)[name];
  if (typeof fn !== "function") {
    return json({ ok: false, error: "unknown_tool", name }, 404);
  }

  try {
    const result = await fn(args);
    return json({ ok: true, name, result }, 200);
  } catch (e: any) {
    return json(
      {
        ok: false,
        error: "tool_execution_failed",
        name,
        message: String(e?.message ?? e),
      },
      500
    );
  }
}

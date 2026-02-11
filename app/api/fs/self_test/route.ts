// app/api/fs/self_test/route.ts
export const runtime = "nodejs";

import { getGuardConfig } from "@/lib/fs_guard";

function boolEnv(name: string) {
  const v = String(process.env[name] ?? "");
  return { present: v.length > 0, value_is_1: v === "1" };
}

export async function GET() {
  try {
    const cfg = getGuardConfig();

    // No secrets: only booleans and numeric limits.
    const out = {
      ok: true,
      ts_utc: new Date().toISOString(),
      node_env: process.env.NODE_ENV ?? null,
      cwd: process.cwd(),

      // Guard config (sanitized)
      fs_guard: {
        enabled: cfg.enabled,
        admin_token_present: Boolean(cfg.adminToken && cfg.adminToken.length > 0),
        maxFileBytes: cfg.maxFileBytes,
        maxPatchBytes: cfg.maxPatchBytes,
        maxListEntries: cfg.maxListEntries,
        debug: cfg.debug,
      },

      // Raw env presence (sanitized)
      env: {
        MEKA_FS_ENABLE: boolEnv("MEKA_FS_ENABLE"),
        MEKA_ADMIN_TOKEN: { present: Boolean(String(process.env.MEKA_ADMIN_TOKEN ?? "").length > 0) },
        MEKA_ORIGIN: { present: Boolean(String(process.env.MEKA_ORIGIN ?? "").length > 0) },
        NEXT_PUBLIC_MEKA_ORIGIN: { present: Boolean(String(process.env.NEXT_PUBLIC_MEKA_ORIGIN ?? "").length > 0) },
        NEXT_PUBLIC_BASE_URL: { present: Boolean(String(process.env.NEXT_PUBLIC_BASE_URL ?? "").length > 0) },
      },
    };

    return new Response(JSON.stringify(out, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify(
        {
          ok: false,
          error: "self_test_failed",
          message: String(e?.message ?? e),
        },
        null,
        2
      ),
      { status: 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
    );
  }
}

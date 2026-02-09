import OpenAI from "openai";

const openai = new OpenAI();

/**
 * Minimal retry wrapper for transient server faults.
 * - Retries only on server_error / 5xx-style failures
 * - Does NOT retry on invalid_request_error (your code must fix those)
 */
export async function createResponseWithRetry(
  args: Parameters<typeof openai.responses.create>[0]
) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastErr: any = null;

  // Default max output tokens if caller didn't supply one.
  // Env override is optional; if unset, we use a conservative default.
  const defaultMaxOutputTokens = Number(
    process.env.MEKA_MAX_OUTPUT_TOKENS || 1200
  );

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const max_output_tokens =
        (args as any)?.max_output_tokens ?? defaultMaxOutputTokens;

      return await openai.responses.create({
        ...(args as any),
        max_output_tokens,
      });
    } catch (err: any) {
      lastErr = err;
      const code = err?.code || err?.error?.code;
      const type = err?.type || err?.error?.type;
      const status = err?.status;

      const isServerFault =
        type === "server_error" ||
        code === "server_error" ||
        (typeof status === "number" && status >= 500);

      if (!isServerFault) throw err;

      // small linear backoff
      await new Promise((r) => setTimeout(r, 250 * attempt));
      continue;
    }
  }

  throw lastErr;
}

/**
 * Central place to define per-turn guardrails.
 * Keep conservative until you have telemetry.
 */
export const MEKA_BUDGETS = {
  maxOutputTokens: 6000,
};

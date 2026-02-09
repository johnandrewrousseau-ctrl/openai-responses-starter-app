import { functionsMap } from "../../config/functions";

type AnyFn = (args: any) => Promise<any>;

function sanitizeToolName(name: any): string {
  const raw = String(name ?? "").trim();
  if (!raw) return "unnamed_tool";
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unnamed_tool";
}

export const handleTool = async (toolName: string, parameters: any) => {
  const safeName = sanitizeToolName(toolName);
  const fn = (functionsMap as any)[safeName] as AnyFn | undefined;

  if (!fn) {
    return {
      ok: false,
      error: "unknown_tool",
      tool_name: String(toolName ?? ""),
      sanitized_name: safeName,
      known_tools: Object.keys(functionsMap),
    };
  }

  try {
    return await fn(parameters);
  } catch (e: any) {
    return {
      ok: false,
      error: "tool_exception",
      tool_name: String(toolName ?? ""),
      sanitized_name: safeName,
      message: String(e?.message ?? e ?? "unknown_error"),
    };
  }
};
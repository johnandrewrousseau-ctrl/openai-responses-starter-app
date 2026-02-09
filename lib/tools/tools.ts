import { toolsList } from "../../config/tools-list";
import type { ToolsState, WebSearchConfig } from "@/stores/useToolsStore";
import { getFreshAccessToken } from "@/lib/connectors-auth";
import { getGoogleConnectorTools } from "./connectors";

interface WebSearchTool extends WebSearchConfig {
  type: "web_search";
}

type ToolDef = any;

/**
 * OpenAI constraint:
 * function tool name must match ^[a-zA-Z0-9_-]+$
 */
function sanitizeToolName(name: any): string {
  const raw = String(name ?? "").trim();
  if (!raw) return "unnamed_tool";
  // Replace illegal chars with underscore, collapse repeats, trim underscores.
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unnamed_tool";
}

/**
 * Normalize a "parameters" value into a strict JSON Schema object:
 * { type:"object", properties:{...}, required:[...], additionalProperties:false }
 *
 * If caller provides an already-wrapped schema, we enforce:
 * - required exists
 * - required contains EVERY key in properties
 * - additionalProperties=false
 */
function normalizeParametersSchema(params: any) {
  // If it already looks like a schema object with properties, normalize in-place.
  if (params && typeof params === "object" && params.type === "object" && params.properties) {
    const p = params as any;
    const props = p.properties && typeof p.properties === "object" ? p.properties : {};
    const keys = Object.keys(props);

    const required = Array.isArray(p.required) ? p.required : [];
    const requiredSet = new Set<string>(required.map((x: any) => String(x)));

    // Strict rule: required must include every property key.
    for (const k of keys) requiredSet.add(k);

    return {
      type: "object",
      properties: props,
      required: Array.from(requiredSet),
      additionalProperties: false,
    };
  }

  // Otherwise treat params as "properties map" (legacy style).
  const props = params && typeof params === "object" ? params : {};
  const keys = Object.keys(props);

  return {
    type: "object",
    properties: props,
    required: keys, // include every key in properties
    additionalProperties: false,
  };
}

/**
 * Responses API expects function tools to have a TOP-LEVEL name.
 * Normalize any function tool shape into:
 * { type:"function", name, description, parameters, strict:true }
 */
function sanitizeFunctionTool(t: any): any {
  const fnObj = t?.function && typeof t.function === "object" ? t.function : null;

  const rawName = t?.name ?? fnObj?.name;
  const safeName = sanitizeToolName(rawName);

  const rawDesc = t?.description ?? fnObj?.description ?? "";
  const rawParams = t?.parameters ?? fnObj?.parameters;
  const rawStrict = t?.strict ?? fnObj?.strict;

  const normalizedParams = normalizeParametersSchema(
    rawParams ?? { type: "object", properties: {}, required: [], additionalProperties: false }
  );

  const out: any = {
    // IMPORTANT: do NOT spread `t` (it may contain nested `function` objects that we want to drop)
    type: "function",
    name: safeName,
    description: String(rawDesc ?? ""),
    parameters: normalizedParams,
    strict: typeof rawStrict === "boolean" ? rawStrict : true,
  };

  return out;
}

/**
 * Final pass to sanitize any tool objects before sending to OpenAI.
 * - Sanitizes function tool names and normalizes parameters schema.
 * - Ensures function tools are in Responses API-compatible shape.
 */
function sanitizeToolsForOpenAI(tools: ToolDef[]) {
  const out: ToolDef[] = [];

  for (const t of tools || []) {
    if (!t || typeof t !== "object") continue;

    if (t.type === "function") {
      out.push(sanitizeFunctionTool(t));
      continue;
    }

    // pass-through for other tool types (file_search/web_search/code_interpreter/mcp etc.)
    out.push(t);
  }

  return out;
}

export const getTools = async (toolsState: ToolsState) => {
  const {
    webSearchEnabled,
    fileSearchEnabled,
    functionsEnabled,
    codeInterpreterEnabled,
    vectorStore,
    webSearchConfig,
    mcpEnabled,
    mcpConfig,
    googleIntegrationEnabled,
  } = toolsState;

  const tools: ToolDef[] = [];

  // IMPORTANT: toolsState coming from /api/tool_status may be "flags-only"
  // (no webSearchConfig). This must never throw.
  if (webSearchEnabled) {
    const webSearchTool: WebSearchTool = { type: "web_search" } as any;

    const loc = (webSearchConfig as any)?.user_location;
    if (loc && (loc.country !== "" || loc.region !== "" || loc.city !== "")) {
      (webSearchTool as any).user_location = loc;
    }

    tools.push(webSearchTool);
  }

  if (fileSearchEnabled) {
    const vsId = vectorStore?.id;

    // Avoid emitting [undefined] which can trip downstream validators.
    if (vsId) {
      tools.push({ type: "file_search", vector_store_ids: [vsId] });
    } else {
      tools.push({ type: "file_search", vector_store_ids: [] });
    }
  }

  if (codeInterpreterEnabled) {
    tools.push({
      type: "code_interpreter",
      container: { type: "auto" },
    });
  }

  if (functionsEnabled) {
    const list: any[] = Array.isArray(toolsList) ? (toolsList as any) : [];

    for (const tool of list) {
      const name = sanitizeToolName(tool?.name);
      if (!name) continue;

      tools.push({
        type: "function",
        name,
        description: String(tool?.description ?? ""),
        parameters: normalizeParametersSchema(
          tool?.parameters ?? { type: "object", properties: {}, required: [], additionalProperties: false }
        ),
        strict: true,
      });
    }
  }

  if (mcpEnabled && mcpConfig.server_url && mcpConfig.server_label) {
    const mcpTool: any = {
      type: "mcp",
      server_label: mcpConfig.server_label,
      server_url: mcpConfig.server_url,
    };
    if (mcpConfig.skip_approval) {
      mcpTool.require_approval = "never";
    }
    if (mcpConfig.allowed_tools.trim()) {
      mcpTool.allowed_tools = mcpConfig.allowed_tools
        .split(",")
        .map((t: string) => t.trim())
        .filter((t: string) => t);
    }
    tools.push(mcpTool);
  }

  if (googleIntegrationEnabled) {
    const { accessToken } = await getFreshAccessToken();

    // accessToken can be undefined; only emit Google tools when we have a token.
    if (accessToken && accessToken.trim()) {
      const googleTools = getGoogleConnectorTools(accessToken);
      tools.push(...googleTools);
    }
  }

  // Final pass sanitizes everything (including connector tools).
  return sanitizeToolsForOpenAI(tools);
};

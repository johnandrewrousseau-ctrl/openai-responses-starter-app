"use client";

import React from "react";
import { toolsList } from "@/config/tools-list";

type JsonSchema = {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
  enum?: any[];
  items?: any;
};

type ToolDef = {
  name: string;
  description?: string;
  parameters?: any; // legacy map OR full JSON Schema object
};

function asString(v: any): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function isObject(v: any): v is Record<string, any> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function normalizeParamEntries(params: any): Array<{ key: string; schema: any; required: boolean }> {
  if (!params) return [];

  // Preferred: JSON Schema object with properties
  if (isObject(params) && (params as JsonSchema).type === "object" && isObject((params as JsonSchema).properties)) {
    const schema = params as JsonSchema;
    const props = schema.properties || {};
    const req = new Set<string>(Array.isArray(schema.required) ? schema.required.map((x) => String(x)) : []);
    return Object.keys(props).map((k) => ({ key: k, schema: props[k], required: req.has(k) }));
  }

  // Legacy: treat as "properties map"
  if (isObject(params)) {
    return Object.keys(params).map((k) => ({ key: k, schema: (params as any)[k], required: false }));
  }

  return [];
}

function summarizeType(schema: any): string {
  if (!schema) return "unknown";
  if (typeof schema === "string") return schema;
  if (Array.isArray(schema)) return "array";
  if (typeof schema.type === "string") return schema.type;
  if (schema.enum) return "enum";
  if (schema.properties) return "object";
  return "unknown";
}

function ToolArgs({ parameters }: { parameters: any }) {
  const entries = normalizeParamEntries(parameters);
  if (!entries.length) {
    return <div className="text-xs text-stone-600 dark:text-stone-400 mt-1">No parameters</div>;
  }

  return (
    <div className="mt-2 space-y-1">
      {entries.map((p) => {
        const t = summarizeType(p.schema);
        const desc = asString(p.schema?.description);
        const isReq = Boolean(p.required);

        return (
          <div
            key={p.key}
            className="flex flex-col gap-0.5 rounded-md border border-stone-200 bg-white px-2 py-1 dark:border-stone-800 dark:bg-stone-950"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-stone-900 dark:text-stone-100">{p.key}</span>
              <span className="font-mono text-[10px] text-stone-600 dark:text-stone-300">
                {t}{isReq ? " (required)" : ""}
              </span>
            </div>
            {desc ? (
              <div className="text-[11px] text-stone-600 dark:text-stone-300">{desc}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function FunctionsView() {
  const list = (Array.isArray(toolsList) ? toolsList : []) as ToolDef[];

  return (
    <div className="space-y-3">
      {list.map((tool) => (
        <div
          key={tool.name}
          className="rounded-xl border border-stone-200 bg-white p-3 shadow-sm dark:border-stone-800 dark:bg-stone-900"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-stone-900 dark:text-stone-100">
                <span className="font-mono">{tool.name}</span>
              </div>
              {tool.description ? (
                <div className="mt-1 text-xs text-stone-600 dark:text-stone-300">{tool.description}</div>
              ) : null}
            </div>
          </div>

          <ToolArgs parameters={tool.parameters} />
        </div>
      ))}
    </div>
  );
}
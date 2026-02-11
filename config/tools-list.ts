/**
 * List of tools available to the assistant.
 * NOTE: Function tool names MUST match ^[a-zA-Z0-9_-]+$ (no dots).
 *
 * Keep this list minimal; add tools deliberately.
 */

export const toolsList = [
  // ---------- FS toolchain (read -> prepare -> patch) ----------
  {
    name: "fs_read",
    description: "Read a file from the repo via local /api/fs/read. Args: root, path.",
    parameters: {
      type: "object",
      properties: {
        root: { type: "string", description: "Repo root key (e.g., repo, app, components, lib, config, state, public)" },
        path: { type: "string", description: "Path within the root (e.g., api/tool_status/route.ts)" },
      },
      required: ["root", "path"],
      additionalProperties: false,
    },
  },

  {
    name: "fs_list",
    description:
      "List directory entries under a repo root via local /api/fs/list. Args: root, path (directory path, or empty for root).",
    parameters: {
      type: "object",
      properties: {
        root: { type: "string", description: "Repo root key (e.g., repo, app, components, lib, config, stores, state, public)" },
        path: { type: "string", description: "Directory path within the root (e.g., app/api). Use empty string for the root directory." },
      },
      required: ["root", "path"],
      additionalProperties: false,
    },
  },

  {
    name: "fs_prepare",
    description:
      "Prepare a safe single-file change via local /api/fs/prepare (hash-safe). Returns patch_unified, expected_hash, approval_id.",
    parameters: {
      type: "object",
      properties: {
        root: { type: "string" },
        path: { type: "string" },
        mode: { type: "string", description: 'Allowed: "single" | "first" | "all"' },
        find: { type: "string", description: "Exact current file text (non-empty)." },
        replace: { type: "string", description: "New file text to write." },
      },
      required: ["root", "path", "mode", "find", "replace"],
      additionalProperties: false,
    },
  },

  {
    name: "fs_patch",
    description:
      "Apply a unified diff patch to a file with hash-safety. Requires expected_hash and approval_id from fs_prepare.",
    parameters: {
      type: "object",
      properties: {
        root: { type: "string" },
        path: { type: "string" },
        patch_unified: { type: "string" },
        expected_hash: { type: "string" },
        approval_id: { type: "string" },
        dry_run: { type: "boolean" },
      },
      required: ["root", "path", "patch_unified", "expected_hash", "approval_id", "dry_run"],
      additionalProperties: false,
    },
  },

  // ---------- Convenience (optional): direct replace route ----------
  {
    name: "fs_replace",
    description:
      "Replace text in a file via local /api/fs/replace. Use fs_prepare + fs_patch for hash-safe edits when possible.",
    parameters: {
      type: "object",
      properties: {
        root: { type: "string" },
        path: { type: "string" },
        mode: { type: "string", description: 'Allowed: "single" | "first" | "all"' },
        find: { type: "string", description: "Exact text to match (or old file text, depending on route implementation)." },
        replace: { type: "string", description: "Replacement text." },
      },
      required: ["root", "path", "mode", "find", "replace"],
      additionalProperties: false,
    },
  },

  // ---------- Proposal-only (Change Control): prepares a proposal (no writes) ----------
  {
    name: "fs_propose_change",
    description:
      "Prepare a structured single-file change proposal (no writes). Internally calls fs_prepare. Args: root, path, mode, find, replace, explanation (optional). Returns patch_unified, expected_hash, approval_id.",
    parameters: {
      type: "object",
      properties: {
        root: { type: "string" },
        path: { type: "string" },
        mode: { type: "string", description: 'Allowed: "single" | "first" | "all"' },
        find: { type: "string" },
        replace: { type: "string" },
        explanation: { type: "string" },
      },
      required: ["root", "path", "mode", "find", "replace"],
      additionalProperties: false,
    },
  },

  // ---------- Vector store inventory (read-only) ----------
  {
    name: "vs_inventory",
    description:
      "List files in vector stores via /api/vs_inventory. Args: store (canon|threads|all), include_filenames (boolean).",
    parameters: {
      type: "object",
      properties: {
        store: { type: "string", description: 'One of: "canon" | "threads" | "all".' },
        include_filenames: { type: "boolean", description: "Whether to resolve filenames (default true)." },
      },
      required: ["store", "include_filenames"],
      additionalProperties: false,
    },
  },
];

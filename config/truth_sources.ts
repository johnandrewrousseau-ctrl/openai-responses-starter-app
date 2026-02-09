export type TruthSourcePolicyId =
  | "ANCHOR_CANON_ONLY"
  | "CANON_OPS_MANIFEST_FIRST"
  | "THREAD_ARCHAEOLOGY_THREADS_FIRST"
  | "DEFAULT";

export type TruthSourcePolicy = {
  id: TruthSourcePolicyId;
  // Human-readable note injected into the prompt so the model follows it deterministically.
  note: string;
};

/**
 * Resolve a truth-source policy from the last user text.
 * This does NOT hard-filter by filename (tool limitation); it:
 * - steers store selection via route.ts (canon vs threads vs manifest), and
 * - tells the model which class of source is authoritative.
 */
export function resolveTruthSourcePolicy(lastUserText: string): TruthSourcePolicy {
  const t = (lastUserText || "").toLowerCase();

  // Anchor questions: force canon-first behavior. (Stable citations come from stable substrate.)
  const isAnchor =
    t.includes("identity anchor") ||
    t.includes("mission anchor") ||
    t.includes("canon mission anchor") ||
    t.includes("cma-0.1");

  if (isAnchor) {
    return {
      id: "ANCHOR_CANON_ONLY",
      note:
        [
          "TRUTH SOURCE POLICY — ANCHORS",
          "- For Identity Anchor / Mission Anchor questions: treat CANON as authoritative.",
          "- Use CANON vector store first; do not use threads unless canon cannot answer.",
          "- If multiple canon files match: cite the most authoritative canon artifact (per your authority tiering).",
          "- If you cannot find the anchor in canon: say 'Not found in canon' and stop; do not guess.",
        ].join("\n"),
    };
  }

  const isCanonOps =
    t.includes("canonmanifest") ||
    t.includes("artifactregistry") ||
    t.includes("manifest") ||
    t.includes("registry") ||
    t.includes("tombstone") ||
    t.includes("supersed") ||
    t.includes("governing") ||
    t.includes("authority");

  if (isCanonOps) {
    return {
      id: "CANON_OPS_MANIFEST_FIRST",
      note:
        [
          "TRUTH SOURCE POLICY — CANON OPS",
          "- For manifest/registry/tombstone/supersession questions: treat MANIFEST as authoritative navigation.",
          "- Use MANIFEST first; use CANON second for content.",
          "- Threads are non-authoritative unless explicitly requested as historical evidence.",
        ].join("\n"),
    };
  }

  const isThreadArchaeology =
    t.includes("where did i say") ||
    t.includes("full chat") ||
    t.includes("old chat") ||
    t.includes("previous version") ||
    t.includes("find") ||
    t.includes("locate") ||
    t.includes("lost") ||
    t.includes("breakthrough") ||
    t.includes("goldpak") ||
    t.includes("thread");

  if (isThreadArchaeology) {
    return {
      id: "THREAD_ARCHAEOLOGY_THREADS_FIRST",
      note:
        [
          "TRUTH SOURCE POLICY — THREAD ARCHAEOLOGY",
          "- For 'where did I say' / old thread lookup: treat THREADS as the primary evidence store.",
          "- Prefer THREADS; optionally use MANIFEST for navigation if available.",
          "- Canon still outranks threads for governance claims.",
        ].join("\n"),
    };
  }

  return {
    id: "DEFAULT",
    note:
      [
        "TRUTH SOURCE POLICY — DEFAULT",
        "- Use your normal store routing (canon/threads/manifest) based on intent.",
        "- Canon outranks threads for governance claims.",
      ].join("\n"),
  };
}

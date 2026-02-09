// lib/sanitize_output.ts
// Shared output sanitizer usable in both server (route.ts) and client (React UI).

const WB_BLOCK_RE = /BEGIN_WRITEBACK_JSON[\s\S]*?END_WRITEBACK_JSON/g;

// Rich UI marker glyphs that sometimes leak into plain text:
// \uE200 = 
const RICH_UI_BLOCK_RE = /\uE200[\s\S]*?\uE201/g;
const RICH_UI_GLYPHS_RE = /[\uE200\uE201\uE202]/g;

export function stripWritebackBlocks(full: string): string {
  if (!full) return "";
  return full
    .replace(WB_BLOCK_RE, "")
    .replace(RICH_UI_BLOCK_RE, "")
    .replace(RICH_UI_GLYPHS_RE, "");
}

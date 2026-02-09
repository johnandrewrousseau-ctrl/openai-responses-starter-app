import fs from "fs";
import path from "path";
import crypto from "crypto";

function walk(dir) {
  const out = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function normalizeSlashes(p) {
  return p.replace(/\\/g, "/");
}

function isTxt(filePath) {
  return filePath.toLowerCase().endsWith(".txt");
}

function fileMeta(filePath) {
  const stat = fs.statSync(filePath);
  const buf = fs.readFileSync(filePath);
  return {
    size_bytes: stat.size,
    last_modified: stat.mtime.toISOString(),
    sha256: sha256(buf),
  };
}

function kindFor(filePath, canonRoot, threadsRoot) {
  const p = filePath.toLowerCase();
  if (canonRoot && p.startsWith(canonRoot.toLowerCase())) return "canon";
  if (threadsRoot && p.startsWith(threadsRoot.toLowerCase())) return "thread";
  return "unknown";
}

function titleFromFilename(filePath) {
  return path.basename(filePath).replace(/\.[^.]+$/, "");
}

function buildManifest({ canonRoot, threadsRoot, outPath }) {
  const docs = [];

  const roots = [
    { root: canonRoot, label: "canon" },
    { root: threadsRoot, label: "thread" },
  ].filter(r => r.root);

  for (const { root } of roots) {
    const files = walk(root).filter(isTxt);
    for (const f of files) {
      const meta = fileMeta(f);
      const rel = normalizeSlashes(path.relative(root, f));
      docs.push({
        doc_id: meta.sha256,              // content-hash ID (truth)
        title: titleFromFilename(f),
        kind: kindFor(f, canonRoot, threadsRoot),
        sha256: meta.sha256,
        filename: path.basename(f),
        relative_path: rel,
        absolute_path: normalizeSlashes(f),
        size_bytes: meta.size_bytes,
        last_modified: meta.last_modified,
      });
    }
  }

  const manifest = {
    manifest_version: "canon_manifest_v1",
    generated_at: new Date().toISOString(),
    sources: {
      canon_root: canonRoot ? normalizeSlashes(canonRoot) : "",
      threads_root: threadsRoot ? normalizeSlashes(threadsRoot) : "",
    },
    scope_rule: "txt_only",
    document_count: docs.length,
    documents: docs,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log("Wrote:", outPath);
  console.log("Documents:", docs.length);
}

const canonRoot = process.argv[2];     // e.g. C:\meka\MEKA_CANON_TXT
const threadsRoot = process.argv[3];   // e.g. C:\meka\MEKA_THREADS_TXT
const outPath = process.argv[4];       // e.g. C:\meka\meka-ui\state\CanonManifest.txt

if (!canonRoot && !threadsRoot) {
  console.error("Usage: node meka_build_manifest.mjs <canonRoot> <threadsRoot> <outPath>");
  process.exit(1);
}

buildManifest({ canonRoot, threadsRoot, outPath });

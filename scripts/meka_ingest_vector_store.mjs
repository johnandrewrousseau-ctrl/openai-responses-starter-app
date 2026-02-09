import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI();

const ROOT = process.argv[2];
if (!ROOT) {
  console.error('Usage: node scripts/meka_ingest_vector_store.mjs "G:\\path\\to\\docs"');
  process.exit(1);
}

const ALLOWED_EXT = new Set([
  ".md", ".txt", ".pdf", ".docx", ".rtf", ".json", ".yaml", ".yml"
]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function isAllowed(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_EXT.has(ext);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("Root:", ROOT);

  // 1) Create vector store
  const vs = await openai.vectorStores.create({
    name: `MEKA Canon (${new Date().toISOString().slice(0, 10)})`,
  });
  console.log("vector_store_id:", vs.id);

  // 2) Collect files
  const all = walk(ROOT).filter(isAllowed);
  console.log("Files found (allowed types):", all.length);

  if (all.length === 0) {
    console.log("No allowed files found. Exiting.");
    return;
  }

  // 3) Upload to Files API, collect file_ids
  const fileIds = [];
  for (let i = 0; i < all.length; i++) {
    const fp = all[i];
    try {
      const up = await openai.files.create({
        file: fs.createReadStream(fp),
        purpose: "assistants",
      });
      fileIds.push(up.id);
      if ((i + 1) % 10 === 0 || i === all.length - 1) {
        console.log(`Uploaded ${i + 1}/${all.length}`);
      }
    } catch (e) {
      console.error("Upload failed:", fp);
      console.error(e?.message ?? e);
    }
  }

  // 4) Add to vector store via file batch (chunking auto)
  const batch = await openai.vectorStores.fileBatches.create(vs.id, {
    file_ids: fileIds,
  });
  console.log("file_batch_id:", batch.id);
  console.log("Batch status:", batch.status);

  // 5) Poll until complete
  while (true) {
   const cur = await openai.vectorStores.fileBatches.retrieve(vs.id, batch.id);
    
    const fc = cur.file_counts ?? {};
    console.log(
      `Status: ${cur.status} | completed=${fc.completed ?? 0} in_progress=${fc.in_progress ?? 0} failed=${fc.failed ?? 0} total=${fc.total ?? 0}`
    );

    if (cur.status === "completed") break;
    if (cur.status === "failed" || cur.status === "cancelled") {
      console.log("Batch ended early:", cur.status);
      break;
    }
    await sleep(2000);
  }

  console.log("DONE. Keep this:");
  console.log("MEKA_VECTOR_STORE_ID =", vs.id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

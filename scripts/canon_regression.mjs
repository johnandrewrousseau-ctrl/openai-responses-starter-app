const BASE_URL = process.env.MEKA_BASE_URL || "http://localhost:3000";

const TESTS = [
  {
    name: "Mission Anchor should cite CMA",
    user: "What is MEKA’s Mission Anchor sentence? Quote it exactly and cite the source file.",
    expectFilenameIncludes: ["Canon Mission Anchor", "CMA-0.1"],
  },
  {
    name: "Identity Anchor should cite canon-class (or at least be stable)",
    user: "What is MEKA’s Identity Anchor sentence? Quote it exactly and cite the source file.",
    // This is intentionally broad because your canon set is still evolving.
    // Once you finalize the canon source, tighten this to the exact filename.
    expectFilenameIncludesAnyOf: ["Canon Mission Anchor", "ALLY", "FULL CHAT", "CMA-0.1"],
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readSseAndCollect(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("text/event-stream")) {
    const text = await res.text().catch(() => "");
    throw new Error(`Not SSE. content-type=${ct} body=${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let assistantText = "";
  const filenames = new Set();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value || new Uint8Array(), { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      const dataStr = part.slice(6);
      if (dataStr === "[DONE]") return { assistantText, filenames: [...filenames] };

      let payload;
      try {
        payload = JSON.parse(dataStr);
      } catch {
        continue;
      }

      const ev = payload?.event;
      const d = payload?.data;

      if (ev === "response.output_text.delta" && typeof d?.delta === "string") {
        assistantText += d.delta;
      }

      if (ev === "response.output_text.done" && typeof d?.text === "string") {
        assistantText = d.text;
      }

      // Your UI receives annotations via response.output_text.annotation.added
      if (ev === "response.output_text.annotation.added") {
        const a = d?.annotation;
        if (a?.filename) filenames.add(a.filename);
      }

      // Some implementations include annotations on the output_text content; handle defensively
      const ann = d?.annotation || null;
      if (ann?.filename) filenames.add(ann.filename);
    }
  }

  return { assistantText, filenames: [...filenames] };
}

function passFail(test, filenames) {
  const f = filenames.join(" | ");

  if (test.expectFilenameIncludes) {
    for (const must of test.expectFilenameIncludes) {
      if (!f.includes(must)) {
        return { ok: false, why: `Missing required substring: ${must}`, f };
      }
    }
    return { ok: true, why: "All required substrings present", f };
  }

  if (test.expectFilenameIncludesAnyOf) {
    for (const any of test.expectFilenameIncludesAnyOf) {
      if (f.includes(any)) return { ok: true, why: `Matched: ${any}`, f };
    }
    return { ok: false, why: `No expected substrings matched`, f };
  }

  return { ok: true, why: "No expectations configured", f };
}

async function main() {
  console.log(`MEKA Canon Regression — base: ${BASE_URL}`);

  let allOk = true;

  for (const t of TESTS) {
    // Small delay so dev console stays readable
    await sleep(50);

    const body = {
      messages: [{ role: "user", content: t.user }],
      toolsState: {},
    };

    let result;
    try {
      result = await readSseAndCollect(`${BASE_URL}/api/turn_response`, body);
    } catch (e) {
      allOk = false;
      console.log(`\n[FAIL] ${t.name}`);
      console.log(String(e?.message || e));
      continue;
    }

    const verdict = passFail(t, result.filenames);

    console.log(`\n[${verdict.ok ? "PASS" : "FAIL"}] ${t.name}`);
    console.log(`Filenames: ${verdict.f}`);
    console.log(`Why: ${verdict.why}`);

    if (!verdict.ok) allOk = false;
  }

  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

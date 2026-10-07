import { fetchAndCacheCoverArt } from "../lib/cover-art.ts";
import { countPendingCoverArtRecordings, getPendingCoverArtRecordings } from "../lib/db.ts";

const BATCH = Number.parseInt(process.argv.find((a) => /^\d+$/.test(a)) ?? "", 10) || 50;
const LOOP = process.argv.includes("--loop");
const LOOP_DELAY_MS = 15_000;

async function processBatch(): Promise<number> {
  const pending = countPendingCoverArtRecordings();
  console.log(`[cover-art-worker] ${pending} pending cover-art recordings; processing up to ${BATCH}.`);
  const ids = getPendingCoverArtRecordings(BATCH);
  let fetched = 0;
  for (const id of ids) {
    try {
      const url = await fetchAndCacheCoverArt(id);
      if (url) fetched++;
      console.log(`[cover-art-worker] ${url ? "cached" : "missing"}: ${id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[cover-art-worker] failed ${id}: ${message}`);
    }
  }
  console.log(`[cover-art-worker] done: ${fetched}/${ids.length} cover-art URLs stored.`);
  return ids.length;
}

async function main() {
  if (!LOOP) {
    await processBatch();
    return;
  }
  console.log(`[cover-art-worker] loop mode: batch=${BATCH}, delay=${LOOP_DELAY_MS}ms. Ctrl+C to stop.`);
  for (;;) {
    const n = await processBatch();
    if (n === 0) console.log("[cover-art-worker] queue empty, sleeping…");
    await new Promise((resolve) => setTimeout(resolve, LOOP_DELAY_MS));
  }
}

main().catch((error) => {
  console.error("[cover-art-worker] fatal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

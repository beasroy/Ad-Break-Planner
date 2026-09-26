// A catalogue import runs in the background so the Brands page can show progress: brand names are
// checked, then ads are made one brand at a time (the slow part), then the catalogue is written.
// Nothing is saved until every brand is ready, so a failed import changes nothing.
import { randomUUID } from "node:crypto";
import type { ImportCatalogueResponse, ImportProgress } from "shared";
import { mapLimit } from "../lib/pool";
import type { RawBrandData } from "./loader";
import { assertSyntheticName, ensureCreativeFiles } from "./creatives";

const MAX_KEPT = 20;
const tasks = new Map<string, ImportProgress>();

export const getImportProgress = (id: string) => tasks.get(id);
export const importRunning = () => [...tasks.values()].some((t) => t.status === "running");

export function startImport(o: {
  /** The whole catalogue after the import. */
  next: RawBrandData[];
  /** Ids of the brands this file adds or updates: the units of progress. */
  changed: Set<string>;
  /** Whether a brand's name has to be checked to be synthetic (new or renamed). */
  needsNameCheck: (b: RawBrandData) => boolean;
  catalogueDir: string;
  /** Writes the catalogue and re-queues videos; gets the number of ads made. Throws if the catalogue is invalid. */
  finish: (generatedCreatives: number) => ImportCatalogueResponse;
}): string {
  const id = randomUUID();
  const units = o.next.filter((b) => o.changed.has(b.brand_id));
  const rest = o.next.filter((b) => !o.changed.has(b.brand_id));
  const progress: ImportProgress = { status: "running", phase: "checking", total: units.length, ready: [] };
  tasks.set(id, progress);
  for (const [k, t] of tasks) if (tasks.size > MAX_KEPT && t.status !== "running") tasks.delete(k);

  void (async () => {
    try {
      let failed = false;
      await mapLimit(units.filter(o.needsNameCheck), 4, async (b) => {
        if (failed) return;
        try {
          await assertSyntheticName(b.display_name, b.category ?? "");
        } catch (err) {
          failed = true;
          throw err;
        }
      });
      progress.phase = "brands";
      let generated = 0;
      for (const b of units) {
        progress.working = b.display_name;
        generated += await ensureCreativeFiles([b], o.catalogueDir);
        progress.ready.push(b.display_name);
      }
      progress.working = undefined;
      progress.phase = "saving";
      generated += await ensureCreativeFiles(rest, o.catalogueDir);
      progress.result = o.finish(generated);
      progress.status = "done";
    } catch (err) {
      progress.working = undefined;
      progress.error = err instanceof Error ? err.message : String(err);
      progress.status = "error";
    }
  })();
  return id;
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawBrandData } from "../src/catalogue/loader";

const creatives = vi.hoisted(() => ({ assertSyntheticName: vi.fn(), ensureCreativeFiles: vi.fn() }));
vi.mock("../src/catalogue/creatives", () => creatives);

const { getImportProgress, importRunning, startImport } = await import("../src/catalogue/importTask");

const brand = (id: string): RawBrandData => ({ brand_id: id, display_name: id.toUpperCase(), creatives: [] }) as unknown as RawBrandData;
const until = async (id: string, ok: (s: string) => boolean) => {
  for (let i = 0; i < 200 && !ok(getImportProgress(id)!.status); i++) await new Promise((r) => setTimeout(r, 5));
  return getImportProgress(id)!;
};
const start = (o: Partial<Parameters<typeof startImport>[0]> = {}) =>
  startImport({
    next: [brand("a"), brand("b"), brand("old")],
    changed: new Set(["a", "b"]),
    needsNameCheck: () => true,
    catalogueDir: "/x",
    finish: (generatedCreatives) => ({ added: ["a", "b"], updated: [], removed: [], generatedCreatives, requeuedJobs: [] }),
    ...o,
  });

beforeEach(() => {
  creatives.assertSyntheticName.mockReset().mockResolvedValue(undefined);
  creatives.ensureCreativeFiles.mockReset().mockResolvedValue(1);
});

describe("startImport", () => {
  it("makes ads one brand at a time, reports each brand as ready, then saves", async () => {
    const seen: string[] = [];
    creatives.ensureCreativeFiles.mockImplementation(async (brands: RawBrandData[]) => {
      const p = getImportProgress(id)!;
      seen.push(`${brands[0].brand_id}:${p.phase}:${p.working ?? "-"}:${p.ready.join("")}`);
      return 1;
    });
    const id = start();
    const p = await until(id, (s) => s !== "running");
    expect(p).toMatchObject({ status: "done", total: 2, ready: ["A", "B"], result: { generatedCreatives: 3 } });
    // a, then b (with a already ready), then the unchanged brand while saving
    expect(seen).toEqual(["a:brands:A:", "b:brands:B:A", "old:saving:-:AB"]);
    expect(importRunning()).toBe(false);
  });

  it("only checks the names that are new or renamed", async () => {
    const id = start({ needsNameCheck: (b) => b.brand_id === "b" });
    await until(id, (s) => s !== "running");
    expect(creatives.assertSyntheticName).toHaveBeenCalledTimes(1);
    expect(creatives.assertSyntheticName).toHaveBeenCalledWith("B", "");
  });

  it("fails with the reason and makes nothing when a name looks real", async () => {
    creatives.assertSyntheticName.mockRejectedValue(new Error('"Coca Cola" looks like a real brand'));
    const finish = vi.fn();
    const id = start({ finish });
    const p = await until(id, (s) => s !== "running");
    expect(p).toMatchObject({ status: "error", error: expect.stringMatching(/real brand/) });
    expect(creatives.ensureCreativeFiles).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("reports an error from saving, and a failed ad", async () => {
    const id = start({
      finish: () => {
        throw new Error("Not a valid catalogue: brands.0: required");
      },
    });
    expect(await until(id, (s) => s !== "running")).toMatchObject({ status: "error", error: /Not a valid catalogue/ });
    creatives.ensureCreativeFiles.mockRejectedValue(new Error("ffmpeg was killed by SIGKILL (usually out of memory)"));
    const id2 = start();
    expect(await until(id2, (s) => s !== "running")).toMatchObject({ status: "error", error: /SIGKILL/ });
  });
});

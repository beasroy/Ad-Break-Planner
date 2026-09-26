import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addBrand, brandIdFor, loadCatalogue, removeBrand } from "../src/catalogue/loader";
import { currentCatalogueHash, withStaleFlag } from "../src/catalogue/current";
import { createRepo, openDb } from "../src/db/repo";
import { buildVast } from "../src/xml/vast";

const base = (id: string) => ({
  brand_id: id,
  display_name: id.toUpperCase(),
  category: "test",
  target_contexts: ["cooking"],
  negative_contexts: ["grief"],
  creatives: [{ id: `${id}_15`, duration_sec: 15, language: "bn", url: `ads/${id}/${id}_15.mp4` }],
});

async function tempCatalogue(brands: unknown[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cat-"));
  const file = path.join(dir, "brands.json");
  await fs.writeFile(file, JSON.stringify(brands));
  return file;
}

describe("brandIdFor", () => {
  it("slugs the name and stays unique", () => {
    expect(brandIdFor("Synth Ninth Paints!", new Set())).toBe("brand_synth_ninth_paints");
    expect(brandIdFor("Golden Spoon", new Set(["brand_golden_spoon"]))).toBe("brand_golden_spoon_2");
    expect(brandIdFor("মশলা", new Set())).toBe("brand_custom");
  });
});

describe("catalogue editing", () => {
  it("adds a brand whose new negative context enters the vocab, and removes it again", async () => {
    const file = await tempCatalogue([base("brand_a")]);
    const before = await loadCatalogue(file);
    await addBrand(file, { ...base("brand_ninth"), negative_contexts: ["flood"], headline: "রঙে রঙে নতুন ঘর", tagline: "t" });
    const after = await loadCatalogue(file);
    expect(after.brands.map((b) => b.id)).toEqual(["brand_a", "brand_ninth"]);
    expect(after.negativeVocab).toContain("flood");
    expect(after.brands[1].headline).toBe("রঙে রঙে নতুন ঘর");
    expect(after.hash).not.toBe(before.hash);

    expect(await removeBrand(file, "brand_ninth")).toBe(true);
    expect((await loadCatalogue(file)).hash).toBe(before.hash);
    expect(await removeBrand(file, "nope")).toBe(false);
  });

  it("refuses duplicates, invalid brands and removing the last brand, leaving the file untouched", async () => {
    const file = await tempCatalogue([base("brand_a")]);
    const original = await fs.readFile(file, "utf8");
    await expect(addBrand(file, base("brand_a"))).rejects.toThrow(/already exists/);
    await expect(addBrand(file, { ...base("brand_x"), creatives: [] })).rejects.toThrow();
    await expect(removeBrand(file, "brand_a")).rejects.toThrow(/at least one brand/);
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it("serialises concurrent additions", async () => {
    const file = await tempCatalogue([base("brand_a")]);
    await Promise.all(["b", "c", "d"].map((x) => addBrand(file, base(`brand_${x}`))));
    expect((await loadCatalogue(file)).brands).toHaveLength(4);
  });
});

describe("stale flag", () => {
  it("marks a finished job processed with another catalogue", async () => {
    const file = await tempCatalogue([base("brand_a")]);
    const now = currentCatalogueHash(file)!;
    expect(now).toMatch(/^[0-9a-f]{16}$/);
    // withStaleFlag compares with the app's real catalogue; a foreign hash is stale, a missing one is not judged.
    const job = { id: "j", fileHash: "h", originalName: "x", createdAt: "", status: "done" as const, stages: {} as never };
    expect(withStaleFlag({ ...job, catalogueHash: "0000000000000000" }).catalogueStale).toBe(true);
    expect(withStaleFlag({ ...job, catalogueHash: undefined }).catalogueStale).toBe(false);
  });
});

describe("VAST ad copy", () => {
  it("carries the tagline in Description and the headline in an extension, escaped", () => {
    const xml = buildVast(
      {
        id: "brand_x",
        name: "X & Co",
        category: "",
        targetContexts: [],
        negativeContexts: [],
        headline: "Fresh <taste>",
        tagline: "নতুন স্বাদ",
        creatives: [],
      },
      { id: "x_15", durationSec: 15, language: "bn", file: "/x.mp4" },
      "http://h",
    );
    expect(xml).toContain("<AdTitle>X &amp; Co</AdTitle>");
    expect(xml).toContain("<Description>নতুন স্বাদ</Description>");
    expect(xml).toContain("<Headline>Fresh &lt;taste&gt;</Headline>");
  });
});

describe("repo.rerun", () => {
  it("re-queues finished jobs only, with an audit reason", () => {
    const repo = createRepo(openDb(":memory:"));
    const hash = "e".repeat(64);
    repo.enqueueUpload({ fileHash: hash, originalName: "a.mp4", maxAttempts: 3 });
    const id = hash.slice(0, 16);
    expect(repo.rerun(id, 3, "brand added")).toBe(false); // still queued
    repo.claimNext("w");
    repo.succeed(id, "w", 1, { breakCount: 1, catalogueHash: "abc" });
    expect(repo.getJob(id)!.catalogueHash).toBe("abc");
    expect(repo.rerun(id, 3, "brand added: X")).toBe(true);
    expect(repo.getJob(id)).toMatchObject({ status: "queued", maxAttempts: 4 });
    expect(repo.getAudit(id)!.events.at(-1)).toMatchObject({ type: "job.requeued", detail: { reason: "brand added: X" } });
  });
});

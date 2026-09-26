import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config";
import { brandIdFor, loadCatalogueFile } from "../src/catalogue/loader";
import {
  addBrand,
  applyImport,
  assertSafeUrl,
  currentCatalogueHash,
  exportCatalogue,
  loadCatalogue,
  planImport,
  removeBrand,
  seedCatalogueIfEmpty,
  setBrandCopy,
  withStaleFlag,
} from "../src/catalogue/store";
import { getRepo, initDb } from "../src/db";
import { createRepo, openDb } from "../src/db/repo";
import { buildVast } from "../src/xml/vast";

const base = (id: string, extra: Record<string, unknown> = {}) => ({
  brand_id: id,
  display_name: id.toUpperCase(),
  category: "test",
  target_contexts: ["cooking"],
  negative_contexts: ["grief"],
  creatives: [{ id: `${id}_15`, duration_sec: 15, language: "bn", url: `ads/${id}/${id}_15.mp4` }],
  ...extra,
});

// A fresh in-memory database per test, seeded from the real catalogue/brands.json.
beforeEach(async () => {
  initDb(":memory:");
  await seedCatalogueIfEmpty();
});

describe("seeding", () => {
  it("fills an empty database from brands.json with the same catalogue hash as the file", async () => {
    const fromFile = await loadCatalogueFile(config.cataloguePath);
    const fromDb = await loadCatalogue();
    expect(fromDb.brands.map((b) => b.id)).toEqual(fromFile.brands.map((b) => b.id));
    expect(fromDb.hash).toBe(fromFile.hash);
    expect(await seedCatalogueIfEmpty()).toBe(0); // only when empty
    expect(getRepo().listCatalogueEvents()[0]).toMatchObject({ actor: "system", type: "catalogue.seeded" });
  });
});

describe("brandIdFor", () => {
  it("slugs the name and stays unique", () => {
    expect(brandIdFor("Synth Ninth Paints!", new Set())).toBe("brand_synth_ninth_paints");
    expect(brandIdFor("Golden Spoon", new Set(["brand_golden_spoon"]))).toBe("brand_golden_spoon_2");
    expect(brandIdFor("মশলা", new Set())).toBe("brand_custom");
  });
});

describe("editing", () => {
  it("adds a brand whose new negative context enters the vocab, updates copy, removes it again", async () => {
    const before = await loadCatalogue();
    addBrand(base("brand_ninth", { negative_contexts: ["flood"] }), { ip: "1.2.3.4" });
    const after = await loadCatalogue();
    expect(after.brands.at(-1)!.id).toBe("brand_ninth");
    expect(after.negativeVocab).toContain("flood");
    expect(after.hash).not.toBe(before.hash);

    setBrandCopy("brand_ninth", { headline: "রঙে রঙে নতুন ঘর", tagline: "t" });
    expect((await loadCatalogue()).brands.at(-1)!.headline).toBe("রঙে রঙে নতুন ঘর");

    expect(removeBrand("brand_ninth")).toBe(true);
    expect((await loadCatalogue()).hash).toBe(before.hash);
    expect(removeBrand("nope")).toBe(false);
    expect(getRepo().listCatalogueEvents().map((e) => e.type).slice(0, 3)).toEqual(["brand.deleted", "brand.copy_updated", "brand.created"]);
  });

  it("refuses duplicates and invalid brands, saving nothing", async () => {
    const before = exportCatalogue();
    expect(() => addBrand(base("brand_a"))).toThrow(/already exists/);
    expect(() => addBrand(base("brand_x", { creatives: [] }))).toThrow();
    expect(exportCatalogue()).toEqual(before);
  });

  it("never removes the last brand", () => {
    for (const b of exportCatalogue().slice(1)) removeBrand(b.brand_id);
    expect(() => removeBrand(exportCatalogue()[0].brand_id)).toThrow(/at least one brand/);
  });
});

describe("import", () => {
  it("merge adds new brands and replaces same-id ones in place", () => {
    const plan = planImport([base("brand_a", { display_name: "Brand A2" }), base("brand_ninth")], "merge");
    expect(plan).toMatchObject({ added: ["brand_ninth"], updated: ["brand_a"], removed: [] });
    applyImport(plan, "merge");
    const ids = exportCatalogue().map((b) => b.brand_id);
    expect(ids[0]).toBe("brand_a");
    expect(ids.at(-1)).toBe("brand_ninth");
    expect(exportCatalogue()[0].display_name).toBe("Brand A2");
  });

  it("replace makes the file the whole catalogue and accepts the { brands: [...] } shape", () => {
    const plan = planImport({ brands: [base("brand_x"), base("brand_y")] }, "replace");
    expect(plan.removed.length).toBe(8);
    applyImport(plan, "replace");
    expect(exportCatalogue().map((b) => b.brand_id)).toEqual(["brand_x", "brand_y"]);
    expect(getRepo().listCatalogueEvents()[0]).toMatchObject({ type: "catalogue.imported", detail: { mode: "replace" } });
  });

  it("rejects invalid files, duplicates and creative paths outside the catalogue folder", () => {
    expect(() => planImport({ nope: 1 }, "merge")).toThrow();
    expect(() => planImport([base("brand_x"), base("brand_x")], "merge")).toThrow(/Duplicate/);
    expect(() => planImport([base("brand_x", { creatives: [{ id: "c", duration_sec: 5, url: "../../etc/passwd.mp4" }] })], "merge")).toThrow(
      /inside the catalogue folder/,
    );
    expect(() => assertSafeUrl("/abs/x.mp4")).toThrow();
    expect(() => assertSafeUrl("ads/x/notavideo.txt")).toThrow();
    expect(() => assertSafeUrl("ads/brand_a/a_15s_bn.mp4")).not.toThrow();
  });
});

describe("stale flag", () => {
  it("marks a finished job processed with another catalogue", () => {
    expect(currentCatalogueHash()).toMatch(/^[0-9a-f]{16}$/);
    const job = { id: "j", fileHash: "h", originalName: "x", createdAt: "", status: "done" as const, stages: {} as never };
    expect(withStaleFlag({ ...job, catalogueHash: "0000000000000000" }).catalogueStale).toBe(true);
    expect(withStaleFlag({ ...job, catalogueHash: currentCatalogueHash() }).catalogueStale).toBe(false);
    expect(withStaleFlag({ ...job, catalogueHash: undefined }).catalogueStale).toBe(false);
  });
});

describe("catalogue audit trail is append-only", () => {
  it("rejects updates and deletes at the database level", () => {
    const db = openDb(":memory:");
    createRepo(db).catalogueEvent({ actor: "system", type: "x" });
    expect(() => db.exec("UPDATE catalogue_events SET type = 'y'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM catalogue_events")).toThrow(/append-only/);
  });
});

describe("VAST ad copy", () => {
  it("carries the tagline in Description and the headline in an extension, escaped", () => {
    const xml = buildVast(
      { id: "brand_x", name: "X & Co", category: "", targetContexts: [], negativeContexts: [], headline: "Fresh <taste>", tagline: "নতুন স্বাদ", creatives: [] },
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
    expect(repo.rerun(id, 3, "brand added")).toBe(false);
    repo.claimNext("w");
    repo.succeed(id, "w", 1, { breakCount: 1, catalogueHash: "abc" });
    expect(repo.getJob(id)!.catalogueHash).toBe("abc");
    expect(repo.rerun(id, 3, "brand added: X")).toBe(true);
    expect(repo.getJob(id)).toMatchObject({ status: "queued", maxAttempts: 4 });
  });
});

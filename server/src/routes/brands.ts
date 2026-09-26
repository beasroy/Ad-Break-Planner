// Brands page: list, add (uploaded and/or generated creatives), delete. brands.json stays the
// single source of truth; every change re-queues processed videos so no saved ad break was
// chosen with an outdated catalogue (negative contexts included).
import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request } from "express";
import multer from "multer";
import type { BrandChangeResponse, BrandSummary, ListBrandsResponse } from "shared";
import { config } from "../config";
import { addBrand, brandIdFor, catalogueBrandIds, loadCatalogue, removeBrand } from "../catalogue/loader";
import { assertSyntheticName, brandAdsDir, generateCreatives, normaliseUpload, writeCopy } from "../catalogue/creatives";
import { PermanentError } from "../lib/errors";
import { creativeUrl } from "../xml/vast";
import { rerunAllJobs } from "./jobs";

export const brandsRouter = Router();

const upload = multer({ dest: path.join(config.dataDir, "_uploads"), limits: { fileSize: 500 * 1024 ** 2, files: 3 } });
const DEFAULT_DURATIONS = [15, 30];

const list = (v: unknown) =>
  String(v ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const requester = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });

async function summaries(): Promise<ListBrandsResponse> {
  const cat = await loadCatalogue(config.cataloguePath);
  const brands: BrandSummary[] = cat.brands.map((b) => ({
    id: b.id,
    name: b.name,
    category: b.category,
    targetContexts: b.targetContexts,
    negativeContexts: b.negativeContexts,
    headline: b.headline,
    tagline: b.tagline,
    creatives: b.creatives.map((c) => ({
      id: c.id,
      durationSec: c.durationSec,
      language: c.language,
      url: creativeUrl(config.publicBaseUrl, b.id, c.id),
    })),
  }));
  return { brands, catalogueHash: cat.hash };
}

// PROVISIONAL
brandsRouter.get("/api/brands", async (_req, res, next) => {
  try {
    res.json(await summaries());
  } catch (err) {
    next(err);
  }
});

// PROVISIONAL: multipart. Fields: name, category, targetContexts, negativeContexts (comma or
// newline separated), language (bn|en), generate ("true"), durations ("15,30"); files: creatives.
brandsRouter.post("/api/brands", upload.array("creatives", 3), async (req, res, next) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  let dir: string | undefined;
  try {
    const name = String(req.body.name ?? "").trim();
    const category = String(req.body.category ?? "").trim();
    const targetContexts = list(req.body.targetContexts);
    const negativeContexts = list(req.body.negativeContexts);
    const language = req.body.language === "en" ? "en" : "bn";
    const generate = req.body.generate === "true";
    const durations = list(req.body.durations).map(Number).filter((d) => [10, 15, 20, 30].includes(d));

    if (name.length < 2 || name.length > 60) throw new PermanentError("Name must be 2–60 characters");
    if (!targetContexts.length) throw new PermanentError("Add at least one target context (what scenes the brand fits)");
    if (!files.length && !generate) throw new PermanentError("Upload at least one ad video or choose to generate one");

    await assertSyntheticName(name, category);
    const id = brandIdFor(name, await catalogueBrandIds(config.cataloguePath));
    dir = brandAdsDir(id);
    await fs.mkdir(dir, { recursive: true });

    const short = id.replace(/^brand_/, "").slice(0, 24);
    const creatives: { id: string; durationSec: number; language: string; file: string }[] = [];
    for (const [i, f] of files.entries()) {
      const tmp = path.join(dir, `upload_${i + 1}.mp4`);
      const durationSec = await normaliseUpload(f.path, tmp);
      const cid = `${short}_${Math.round(durationSec)}s_${language}_up${i + 1}`;
      const file = path.join(dir, `${cid}.mp4`);
      await fs.rename(tmp, file);
      creatives.push({ id: cid, durationSec, language, file });
    }

    let copy: { headline?: string; tagline?: string } = {};
    let warning: string | undefined;
    if (generate) {
      const gen = await generateCreatives({ id, category, targetContexts }, dir, durations.length ? durations : DEFAULT_DURATIONS, language);
      creatives.push(...gen.creatives);
      warning = gen.warning;
    }
    try {
      copy = await writeCopy({ name, category, targetContexts, language });
    } catch (err) {
      warning = [warning, `Ad copy could not be written (${(err as Error).message.slice(0, 80)}); the ad shows the brand name only`]
        .filter(Boolean)
        .join(". ");
    }

    const catalogueDir = path.dirname(config.cataloguePath);
    await addBrand(config.cataloguePath, {
      brand_id: id,
      display_name: name,
      category,
      target_contexts: targetContexts,
      negative_contexts: negativeContexts,
      ...copy,
      creatives: creatives.map((c) => ({
        id: c.id,
        duration_sec: c.durationSec,
        language: c.language,
        url: path.relative(catalogueDir, c.file).split(path.sep).join("/"),
      })),
    });
    dir = undefined; // saved: keep the files
    const requeuedJobs = rerunAllJobs(`brand added: ${name}`, requester(req));
    const brand = (await summaries()).brands.find((b) => b.id === id);
    res.status(201).json({ brand, requeuedJobs, warning } satisfies BrandChangeResponse);
  } catch (err) {
    if (err instanceof PermanentError) res.status(422).json({ error: err.message });
    else next(err);
  } finally {
    await Promise.all(files.map((f) => fs.rm(f.path, { force: true })));
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

// PROVISIONAL: removes the brand from brands.json and its creatives folder.
brandsRouter.delete("/api/brands/:id", async (req, res, next) => {
  try {
    const removed = await removeBrand(config.cataloguePath, req.params.id);
    if (!removed) return res.status(404).json({ error: "brand not found" });
    await fs.rm(brandAdsDir(req.params.id), { recursive: true, force: true });
    const requeuedJobs = rerunAllJobs(`brand removed: ${req.params.id}`, requester(req));
    res.json({ requeuedJobs } satisfies BrandChangeResponse);
  } catch (err) {
    if (err instanceof Error && /at least one brand/.test(err.message)) res.status(409).json({ error: err.message });
    else next(err);
  }
});

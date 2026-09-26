import { Router } from "express";
import { config } from "../config";
import { loadCatalogue } from "../catalogue/loader";
import { exists } from "../lib/artifacts";
import { buildVast } from "../xml/vast";

export const adsRouter = Router();

async function findCreative(brandId: string, creativeId?: string) {
  const catalogue = await loadCatalogue(config.cataloguePath);
  const brand = catalogue.brands.find((b) => b.id === brandId);
  const creative = brand && (creativeId ? brand.creatives.find((c) => c.id === creativeId) : brand.creatives[0]);
  return brand && creative ? { brand, creative } : undefined;
}

// PROVISIONAL: one VAST doc per brand (creative chosen via ?creative=).
adsRouter.get("/vast/:file", async (req, res, next) => {
  try {
    const brandId = req.params.file.replace(/\.xml$/, "");
    const found = await findCreative(brandId, typeof req.query.creative === "string" ? req.query.creative : undefined);
    if (!found) return res.status(404).type("application/xml").send("<VAST version=\"3.0\"/>");
    res.type("application/xml").send(buildVast(found.brand, found.creative, config.publicBaseUrl));
  } catch (err) {
    next(err);
  }
});

// PROVISIONAL
adsRouter.get("/creatives/:brandId/:file", async (req, res, next) => {
  try {
    const found = await findCreative(req.params.brandId, req.params.file.replace(/\.mp4$/, ""));
    if (!found || !(await exists(found.creative.file))) return res.status(404).json({ error: "creative not found" });
    res.sendFile(found.creative.file, { acceptRanges: true });
  } catch (err) {
    next(err);
  }
});

// VAST requires an Impression URL; we just acknowledge it.
adsRouter.get("/api/impression", (_req, res) => res.status(204).end());

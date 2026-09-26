// Renders title-card ads (brand name, category, contexts; no image API) for catalogue creatives
// whose files are missing, e.g. on a fresh machine where catalogue/ads/ is not in git.
//   npm run creatives -w server              only missing files
//   npm run creatives -w server -- --force   re-render every brand's ads
import { ensureCreativeFiles } from "../src/catalogue/creatives";
import { catalogueDir, exportCatalogue, openCatalogue } from "../src/catalogue/store";

await openCatalogue();
const t0 = Date.now();
const made = await ensureCreativeFiles(exportCatalogue(), catalogueDir(), { force: process.argv.includes("--force") });
console.log(`${made} creative${made === 1 ? "" : "s"} rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

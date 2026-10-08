// Which of a brand's catalogue clips plays, given what is left of the ad-load budget.
import type { Brand, Creative } from "shared";

/** Longest creative that fits the remaining ad-load budget, preferring the content language. */
export function pickCreative(brand: Brand, budgetSec: number, language: string): Creative | undefined {
  const fits = brand.creatives.filter((c) => c.durationSec <= budgetSec + 1e-9).sort((a, b) => b.durationSec - a.durationSec);
  return fits.find((c) => c.language === language) ?? fits[0];
}

/** Shortest creative (content language first): used while searching, so ad load never rules out a schedule early. */
export function shortestCreative(brand: Brand, language: string): Creative | undefined {
  const byLen = [...brand.creatives].sort((a, b) => a.durationSec - b.durationSec);
  return byLen.find((c) => c.language === language) ?? byLen[0];
}

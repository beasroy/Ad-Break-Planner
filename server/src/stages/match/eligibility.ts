// HARD RULES: negative-context blocking and "when unsure, don't place".
// Pure and deterministic; the LLM only ever sees brands that pass this.
import type { BlockReason, Brand, BrandDecision, Scene, Thresholds } from "shared";

export type EligibilityThresholds = Pick<Thresholds, "sceneMinConfidence" | "negativeTagMinConfidence" | "consensusNegativeShare">;

/**
 * Negative contexts listed by more than `share` of the catalogue's brands. When most
 * brands consider a context unsafe (e.g. grief, accident), it blocks every brand, so one
 * brand's shorter list can't put an ad next to a clearly sensitive scene. Computed from
 * the catalogue at runtime: adding brands shifts it with no code change.
 */
export function consensusContexts(brands: Brand[], share: number): Set<string> {
  const counts = new Map<string, number>();
  for (const b of brands) for (const c of b.negativeContexts) counts.set(c, (counts.get(c) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n / brands.length > share).map(([c]) => c));
}

export function decideEligibility(brands: Brand[], before: Scene, after: Scene, t: EligibilityThresholds): BrandDecision[] {
  const unclassified = before.confidence < t.sceneMinConfidence || after.confidence < t.sceneMinConfidence;
  if (unclassified) return brands.map((b) => ({ brandId: b.id, eligible: false, unclassified: true }));

  const consensus = consensusContexts(brands, t.consensusNegativeShare);
  const sides = [
    ["before", before],
    ["after", after],
  ] as const;

  return brands.map((b) => {
    const own = new Set(b.negativeContexts);
    const blockedBy: BlockReason[] = [];
    for (const [side, scene] of sides) {
      for (const tag of scene.negativeTags) {
        if (tag.confidence < t.negativeTagMinConfidence) continue;
        const rule = own.has(tag.context) ? "brand" : consensus.has(tag.context) ? "consensus" : undefined;
        if (rule) blockedBy.push({ context: tag.context, rule, scene: side, confidence: tag.confidence, source: tag.source });
      }
    }
    return blockedBy.length ? { brandId: b.id, eligible: false, blockedBy } : { brandId: b.id, eligible: true };
  });
}

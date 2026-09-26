// HARD RULE: negative-context blocking and "when unsure, don't place".
// Pure and deterministic; the LLM only ever sees brands that pass this.
import type { BlockReason, Brand, BrandDecision, Scene, Thresholds } from "shared";

export function decideEligibility(
  brands: Brand[],
  before: Scene,
  after: Scene,
  t: Pick<Thresholds, "sceneMinConfidence" | "negativeTagMinConfidence">,
): BrandDecision[] {
  const unclassified = before.confidence < t.sceneMinConfidence || after.confidence < t.sceneMinConfidence;
  if (unclassified) return brands.map((b) => ({ brandId: b.id, eligible: false, unclassified: true }));

  const sides = [
    ["before", before],
    ["after", after],
  ] as const;

  return brands.map((b) => {
    const neg = new Set(b.negativeContexts);
    const blockedBy: BlockReason[] = [];
    for (const [side, scene] of sides) {
      for (const tag of scene.negativeTags) {
        if (neg.has(tag.context) && tag.confidence >= t.negativeTagMinConfidence) {
          blockedBy.push({ context: tag.context, scene: side, confidence: tag.confidence, source: tag.source });
        }
      }
    }
    return blockedBy.length ? { brandId: b.id, eligible: false, blockedBy } : { brandId: b.id, eligible: true };
  });
}

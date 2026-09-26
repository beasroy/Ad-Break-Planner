// Stage 7 ("Whether"): deterministic pacing selector over eligible, ranked candidates.
import type { Brand, Break, Candidate, Creative, MatchedCandidate, PacingConfig, ScoreWeights, SelectionLog } from "shared";
import { ARTIFACTS, readKeyed, writeKeyed } from "../lib/artifacts";
import { hashJson } from "../lib/hash";
import { artifactPath, type StageContext } from "./context";

const isMatched = (c: Candidate | MatchedCandidate): c is MatchedCandidate =>
  !c.rejected && "ranked" in c && c.ranked.length > 0 && c.cutTime !== undefined && !!c.where;

/** Longest creative that fits the remaining ad-load budget, preferring the content language. */
export function pickCreative(brand: Brand, budgetSec: number, language: string): Creative | undefined {
  const fits = brand.creatives.filter((c) => c.durationSec <= budgetSec + 1e-9).sort((a, b) => b.durationSec - a.durationSec);
  return fits.find((c) => c.language === language) ?? fits[0];
}

export interface SelectInputs {
  candidates: (Candidate | MatchedCandidate)[];
  brands: Brand[];
  durationSec: number;
  pacing: PacingConfig;
  weights: ScoreWeights["combined"];
  language: string;
}

export function selectBreaks(inp: SelectInputs): { breaks: Break[]; log: SelectionLog[] } {
  const { pacing: p, durationSec: dur, weights: w } = inp;
  const brandById = new Map(inp.brands.map((b) => [b.id, b]));
  const combined = (c: MatchedCandidate, fit: number) => c.where!.total * w.where + fit * w.brandFit;
  const maxAdSec = p.maxAdLoadPct * dur;
  const cap = Math.floor((p.maxBreaksPerHour * dur) / 3600);

  const pool = inp.candidates.filter(isMatched).sort((a, b) => combined(b, b.ranked[0].fit) - combined(a, a.ranked[0].fit));
  const log = new Map<string, SelectionLog>();
  const reject = (id: string, reason: string) => log.set(id, { candidateId: id, outcome: "rejected", reason });

  type Sel = { c: MatchedCandidate; brandId: string; creative: Creative; fit: number; reason: string };
  const selected: Sel[] = [];
  const adTime = (except?: Sel) => selected.reduce((t, s) => (s === except ? t : t + s.creative.durationSec), 0);

  let capped = false;
  for (const c of pool) {
    const t = c.cutTime!;
    if (capped) { reject(c.id, `break cap reached (${cap} for this duration)`); continue; }
    if (t < p.noBreakFirstSec) { reject(c.id, `inside first ${p.noBreakFirstSec}s`); continue; }
    if (t > dur - p.noBreakLastSec) { reject(c.id, `inside last ${p.noBreakLastSec}s`); continue; }
    const near = selected.find((s) => Math.abs(s.c.cutTime! - t) < p.minGapSec);
    if (near) { reject(c.id, `within ${p.minGapSec}s of selected break ${near.c.id}`); continue; }
    if (selected.length + 1 > cap) { capped = true; reject(c.id, `break cap reached (${cap} for this duration)`); continue; }

    const top = c.ranked[0];
    const creative = pickCreative(brandById.get(top.brandId)!, maxAdSec - adTime(), inp.language);
    if (!creative) { reject(c.id, `ad load would exceed ${Math.round(p.maxAdLoadPct * 100)}%`); continue; }
    selected.push({ c, brandId: top.brandId, creative, fit: top.fit, reason: top.reason });
  }

  // No back-to-back same brand: swap the weaker break of a repeated pair to its next-best
  // eligible brand that differs from both neighbours; drop it if no alternative fits.
  selected.sort((a, b) => a.c.cutTime! - b.c.cutTime!);
  for (let i = 1; i < selected.length; i++) {
    const prev = selected[i - 1];
    const cur = selected[i];
    if (prev.brandId !== cur.brandId) continue;
    const weakIdx = combined(prev.c, prev.fit) < combined(cur.c, cur.fit) ? i - 1 : i;
    const weak = selected[weakIdx];
    const neighbours = new Set([selected[weakIdx - 1]?.brandId, selected[weakIdx + 1]?.brandId]);
    const budget = maxAdSec - adTime(weak);
    let swapped = false;
    for (const alt of weak.c.ranked) {
      if (alt.brandId === weak.brandId || neighbours.has(alt.brandId)) continue;
      const creative = pickCreative(brandById.get(alt.brandId)!, budget, inp.language);
      if (!creative) continue;
      Object.assign(weak, { brandId: alt.brandId, creative, fit: alt.fit, reason: `${alt.reason} (swapped: avoid back-to-back ${prev.brandId})` });
      swapped = true;
      break;
    }
    if (!swapped) {
      reject(weak.c.id, `same brand as adjacent break and no alternative eligible brand`);
      selected.splice(weakIdx, 1);
    }
    i = 0; // re-scan after any change
  }

  const breaks: Break[] = selected.map((s) => ({
    candidateId: s.c.id,
    timeSec: s.c.cutTime!,
    brandId: s.brandId,
    creativeId: s.creative.id,
    adDurationSec: s.creative.durationSec,
    whereScore: s.c.where!.total,
    fit: s.fit,
    combinedScore: combined(s.c, s.fit),
    reason: s.reason,
  }));
  for (const b of breaks) log.set(b.candidateId, { candidateId: b.candidateId, outcome: "selected", reason: b.reason });
  for (const c of inp.candidates) {
    if (!log.has(c.id) && c.rejected) log.set(c.id, { candidateId: c.id, outcome: "rejected", reason: `${c.rejected.stage}: ${c.rejected.reason}` });
  }
  return { breaks, log: inp.candidates.map((c) => log.get(c.id)!).filter(Boolean) };
}

export async function runSelect(ctx: StageContext, matched: (Candidate | MatchedCandidate)[], durationSec: number) {
  const out = artifactPath(ctx, ARTIFACTS.breaks);
  const inputs = {
    pacing: ctx.config.pacing,
    weights: ctx.config.scoring.combined,
    language: ctx.config.openrouter.transcribeLanguage,
    durationSec,
  };
  const key = hashJson({ inputs, catalogue: ctx.catalogue.hash, matched: hashJson(matched) });
  const cached = ctx.force ? undefined : await readKeyed<ReturnType<typeof selectBreaks>>(out, key);
  if (cached) return cached;

  const result = selectBreaks({ candidates: matched, brands: ctx.catalogue.brands, ...inputs });
  await writeKeyed(out, key, result);
  ctx.log(`select: ${result.breaks.length} breaks selected`);
  return result;
}

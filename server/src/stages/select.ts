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
  // Rounded to nearest: a 25 min episode (4/h × 0.43h = 1.7) gets 2 breaks, not 1.
  const cap = Math.round((p.maxBreaksPerHour * dur) / 3600);

  const pool = inp.candidates.filter(isMatched).sort((a, b) => combined(b, b.ranked[0].fit) - combined(a, a.ranked[0].fit));
  const log = new Map<string, SelectionLog>();
  const reject = (id: string, reason: string) => log.set(id, { candidateId: id, outcome: "rejected", reason });

  type Sel = { c: MatchedCandidate; brandId: string; creative: Creative; fit: number; reason: string };
  const selected: Sel[] = [];
  const adTime = () => selected.reduce((t, s) => t + s.creative.durationSec, 0);

  let capped = false;
  for (const c of pool) {
    const t = c.cutTime!;
    if (capped) { reject(c.id, `break cap reached (${cap} for this duration)`); continue; }
    if (t < p.noBreakFirstSec) { reject(c.id, `inside first ${p.noBreakFirstSec}s`); continue; }
    if (t > dur - p.noBreakLastSec) { reject(c.id, `inside last ${p.noBreakLastSec}s`); continue; }
    const near = selected.find((s) => Math.abs(s.c.cutTime! - t) < p.minGapSec);
    if (near) { reject(c.id, `within ${p.minGapSec}s of selected break ${near.c.id}`); continue; }
    if (selected.length + 1 > cap) { capped = true; reject(c.id, `break cap reached (${cap} for this duration)`); continue; }

    // No back-to-back same brand: take the best-ranked brand that differs from the
    // breaks immediately before and after this one in time, and whose creative fits.
    const before = selected.filter((s) => s.c.cutTime! < t).sort((a, b) => b.c.cutTime! - a.c.cutTime!)[0];
    const after = selected.filter((s) => s.c.cutTime! > t).sort((a, b) => a.c.cutTime! - b.c.cutTime!)[0];
    const neighbours = new Set([before?.brandId, after?.brandId]);
    const budget = maxAdSec - adTime();

    let pick: Sel | undefined;
    let blockedByRepeat = false;
    for (const r of c.ranked) {
      if (neighbours.has(r.brandId)) { blockedByRepeat = true; continue; }
      const creative = pickCreative(brandById.get(r.brandId)!, budget, inp.language);
      if (!creative) continue;
      const swapped = r !== c.ranked[0] && neighbours.has(c.ranked[0].brandId);
      pick = { c, brandId: r.brandId, creative, fit: r.fit, reason: swapped ? `${r.reason} (swapped: avoid back-to-back ${c.ranked[0].brandId})` : r.reason };
      break;
    }
    if (!pick) {
      reject(c.id, blockedByRepeat ? "same brand as adjacent break and no alternative eligible brand" : `ad load would exceed ${Math.round(p.maxAdLoadPct * 100)}%`);
      continue;
    }
    selected.push(pick);
  }
  selected.sort((a, b) => a.c.cutTime! - b.c.cutTime!);

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
    language: ctx.config.contentLanguage,
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

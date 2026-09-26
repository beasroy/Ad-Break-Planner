// Browser-side VMAP + VAST parsing. The player schedules ads from these documents only,
// exactly as a real ad-enabled player would.

export interface VmapBreak {
  breakId: string;
  timeSec: number;
  vastUrl: string;
}

export interface VastAd {
  title: string;
  mediaUrl: string;
  durationSec: number;
  /** Ad copy the player draws over the creative (VAST Description / adCopy extension). */
  headline?: string;
  tagline?: string;
}

/** "HH:MM:SS.mmm" → seconds. Non-time offsets (start/end/percent) aren't used by our VMAP. */
export function parseTimeOffset(v: string): number | undefined {
  const m = v.trim().match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!m) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
}

const byLocalName = (root: Document | Element, name: string) =>
  Array.from(root.getElementsByTagName("*")).filter((el) => el.localName === name);

export function parseVmap(xml: string): VmapBreak[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("VMAP is not valid XML");
  return byLocalName(doc, "AdBreak")
    .map((el) => {
      const timeSec = parseTimeOffset(el.getAttribute("timeOffset") ?? "");
      const vastUrl = byLocalName(el, "AdTagURI")[0]?.textContent?.trim() ?? "";
      return { breakId: el.getAttribute("breakId") ?? "", timeSec: timeSec ?? NaN, vastUrl };
    })
    .filter((b) => Number.isFinite(b.timeSec) && b.vastUrl)
    .sort((a, b) => a.timeSec - b.timeSec);
}

export function parseVast(xml: string): VastAd {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("VAST is not valid XML");
  const text = (name: string) => byLocalName(doc, name)[0]?.textContent?.trim() ?? "";
  const mediaUrl = text("MediaFile");
  if (!mediaUrl) throw new Error("VAST has no MediaFile");
  return {
    title: text("AdTitle"),
    mediaUrl,
    durationSec: parseTimeOffset(text("Duration")) ?? 0,
    headline: text("Headline") || undefined,
    tagline: text("Description") || undefined,
  };
}

export async function loadAdSchedule(vmapUrl: string): Promise<(VmapBreak & { ad: VastAd })[]> {
  const vmap = parseVmap(await (await fetch(vmapUrl, { cache: "no-store" })).text());
  return Promise.all(
    vmap.map(async (b) => ({ ...b, ad: parseVast(await (await fetch(b.vastUrl, { cache: "no-store" })).text()) })),
  );
}

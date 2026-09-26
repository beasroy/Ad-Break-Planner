import type { Break } from "shared";

export const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** HH:MM:SS.mmm as VMAP timeOffset requires. */
export function toTimeOffset(sec: number): string {
  const ms = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

export const vastUrl = (baseUrl: string, b: Pick<Break, "brandId" | "creativeId">) =>
  `${baseUrl}/vast/${encodeURIComponent(b.brandId)}.xml?creative=${encodeURIComponent(b.creativeId)}`;

export function buildVmap(breaks: Break[], baseUrl: string): string {
  const adBreaks = [...breaks]
    .sort((a, b) => a.timeSec - b.timeSec)
    .map(
      (b, i) => `  <vmap:AdBreak timeOffset="${toTimeOffset(b.timeSec)}" breakType="linear" breakId="break-${i + 1}">
    <vmap:AdSource id="ad-${i + 1}" allowMultipleAds="false" followRedirects="true">
      <vmap:AdTagURI templateType="vast3"><![CDATA[${vastUrl(baseUrl, b)}]]></vmap:AdTagURI>
    </vmap:AdSource>
  </vmap:AdBreak>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0">
${adBreaks}
</vmap:VMAP>
`;
}

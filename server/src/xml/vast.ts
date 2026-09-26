import type { Brand, Creative } from "shared";
import { escapeXml, toTimeOffset } from "./vmap";

export const creativeUrl = (baseUrl: string, brandId: string, creativeId: string) =>
  `${baseUrl}/creatives/${encodeURIComponent(brandId)}/${encodeURIComponent(creativeId)}.mp4`;

export function buildVast(brand: Brand, creative: Creative, baseUrl: string): string {
  const dur = toTimeOffset(creative.durationSec).replace(/\.\d+$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="3.0">
  <Ad id="${escapeXml(brand.id)}">
    <InLine>
      <AdSystem>AdBreakPlanner</AdSystem>
      <AdTitle>${escapeXml(brand.name)}</AdTitle>${brand.tagline ? `\n      <Description>${escapeXml(brand.tagline)}</Description>` : ""}
      <Impression><![CDATA[${baseUrl}/api/impression?brand=${encodeURIComponent(brand.id)}]]></Impression>
      <Creatives>
        <Creative id="${escapeXml(creative.id)}" sequence="1">
          <Linear>
            <Duration>${dur}</Duration>
            <MediaFiles>
              <MediaFile delivery="progressive" type="video/mp4" width="1280" height="720"><![CDATA[${creativeUrl(baseUrl, brand.id, creative.id)}]]></MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>${
        brand.headline
          ? `\n      <Extensions>\n        <Extension type="adCopy"><Headline>${escapeXml(brand.headline)}</Headline></Extension>\n      </Extensions>`
          : ""
      }
    </InLine>
  </Ad>
</VAST>
`;
}

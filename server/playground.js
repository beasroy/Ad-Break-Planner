// Prompt playground: one plain OpenRouter call for ONE chunk of an episode — the real prompt from
// src/prompts/placement.ts, copied here so it can be tried without touching the app or the database.
// Keep this in sync with that file: it is a copy, not an import, so it goes stale silently otherwise.
// The transcript below has real measured silences and shot cuts (from signals.json) written
// straight into it, next to where they actually happen. They are plain lines, not numbered,
// and not turned into any "CUT OK" flag — the model reads them and judges for itself.
// There is no "previous brand" or "brands already shown" here: in the real pipeline every chunk is
// called independently and in parallel, so no chunk can be told what any other chunk decided — that
// choice is made afterwards, across every chunk's answer, by scheduleBreaks in stages/placement.ts.
//   node server/playground.js
// Prints the full input and the model's output. Not used by the app.
import dotenv from "dotenv";

dotenv.config({ path: new URL("../.env", import.meta.url).pathname, quiet: true });

const MODEL = "openai/gpt-5.6-luna";
const REASONING_EFFORT = "medium"; // low | medium | high

/** Minimum fit for a placement to be accepted (placement.minBrandFit in src/config.ts). */
const MIN_FIT = 0.7;
/** A context listed by more than this share of brands blocks every brand. */
const BLOCK_ALL_SHARE = 0.5;

// ---- Input 1: the story so far (the episode summary, cached in programme.json)
const storySoFar =
  "A gritty Bengali drama follows rival workers, businessmen, police figures and families as a murder, workplace unrest, money disputes and threatening personal relationships fuel escalating conflict.";

// ---- Input 2: the brands (all 8 in the catalogue, from catalogue/brands.json). Every brand is
// always selectable here — nothing is excluded for being "the previous brand", because at the point
// any one chunk is called, no ad has been scheduled yet, so there is no previous brand to exclude.
const brands = [
  {
    brand_id: "brand_a",
    name: "Brand A",
    category: "food/spices/cooking",
    fits_scenes_about: ["cooking", "kitchen", "eating", "family meal", "recipe", "food preparation", "spices", "seasoning", "frying", "boiling", "homemade food", "lunch", "dinner", "festival food"],
    never_next_to: ["funeral", "hospital", "violence", "illness", "bathroom", "accident", "grief"],
  },
  {
    brand_id: "brand_b",
    name: "Brand B",
    category: "personal care/skincare",
    fits_scenes_about: ["face wash", "skincare", "bathroom", "morning routine", "hair care", "sweating", "heat", "shower", "washing face", "moisturizer", "cream", "personal hygiene", "self care", "getting ready"],
    never_next_to: ["funeral", "violence", "eating", "accident", "hospital", "grief"],
  },
  {
    brand_id: "brand_c",
    name: "Brand C",
    category: "beauty/cosmetics",
    fits_scenes_about: ["make-up", "getting ready", "wedding", "party", "mirror", "fashion", "salon", "lipstick", "foundation", "eyeliner", "beauty", "dressing", "celebration", "special occasion"],
    never_next_to: ["funeral", "violence", "illness", "accident", "hospital", "grief"],
  },
  {
    brand_id: "brand_d",
    name: "Brand D",
    category: "telecom/connectivity",
    fits_scenes_about: ["phone", "mobile", "calling", "video call", "messaging", "internet", "wifi", "streaming", "social media", "working remotely", "online meeting", "travel", "communication", "family conversation"],
    never_next_to: ["funeral", "hospital", "medical emergency", "violence"],
  },
  {
    brand_id: "brand_e",
    name: "Brand E",
    category: "automotive/mobility",
    fits_scenes_about: ["car", "automobile", "driving", "road trip", "commuting", "traffic", "parking", "highway", "motorcycle", "vehicle", "road", "journey", "travel by car", "family trip"],
    never_next_to: ["funeral", "hospital", "violence", "accident", "injury", "grief"],
  },
  {
    brand_id: "brand_f",
    name: "Brand F",
    category: "fintech/digital payments",
    fits_scenes_about: ["shopping", "payment", "mobile payment", "digital wallet", "banking", "money transfer", "bill payment", "online shopping", "checkout", "merchant", "salary", "personal finance", "transaction"],
    never_next_to: ["funeral", "hospital", "violence", "financial distress", "grief"],
  },
  {
    brand_id: "brand_g",
    name: "Brand G",
    category: "travel/hospitality",
    fits_scenes_about: ["travel", "vacation", "holiday", "hotel", "resort", "tourism", "train journey", "airport", "beach", "mountains", "sightseeing", "road trip", "weekend trip", "family vacation"],
    never_next_to: ["funeral", "hospital", "violence", "accident", "illness", "grief"],
  },
  {
    brand_id: "brand_h",
    name: "Brand H",
    category: "e-commerce/online shopping",
    fits_scenes_about: ["online shopping", "shopping", "delivery", "package", "parcel", "e-commerce", "mobile shopping", "product browsing", "checkout", "fashion shopping", "home shopping", "electronics shopping", "gift", "purchase"],
    never_next_to: ["funeral", "hospital", "violence", "accident", "grief"],
  },
];

// ---- Input 3: the transcript, with real measured silences and shot cuts from signals.json
// written in directly, next to where they happen. Lines are "[start–end] text"; markers are
// "· silence Xs [start–end]" and "· shot cut [time]" — plain lines, no numbers of their own.
// (sample: mandaar.mp4, data/7226c8b3c2b53fd65bf94059906bdb0c15513a93319d41856a0219cd5bfec4e2)
const previousLines = `
[1078.7–1080.0] হাঁ। দারুণ ম্যানেজ করছে।
[1080.4–1082.2] পুলিশবাবু কই কথা কইছেন?
[1082.4–1084.5] হাঁ ওই তো মাছভাজা দিয়ে বসে রাখছি।
    · shot cut [1084.5]
    · shot cut [1089.4]
    · shot cut [1091.6]
[1092.4–1094.8] থোড়া চলে গেছে বোধ হয়।
[1096.0–1099.3] দেখুন কত তাড়াতাড়ি সামলাতে পারেন।
[1100.3–1102.3] তুই ঘঁজা কাল থেকে কিন্তু।
[1102.4–1104.6] হাঁ। চল।
    · shot cut [1106.6]
[1110.7–1112.7] কোথায় গেলো রে মালটা?
    · shot cut [1113.9]
    · shot cut [1118.0]
`;

const currentLines = `
[1136.4–1137.3] ক।
[1137.5–1140.0] কাল থেকে চোরাবেড়ির দায়িত্ব আমার।
[1140.2–1140.9] কি?
    · silence 1.5s [1141.0–1142.5]
    · shot cut [1141.0]
[1141.9–1145.0] বাবলু ভাই আজ কয়ে দিয়েছে কাল থেকে আমি দেখাশোনা করবো।
    · shot cut [1145.2]
[1145.3–1146.4] কখন কইলো?
[1146.9–1147.9] দুপুরবেলা।
    · shot cut [1147.8]
[1148.3–1151.3] মঞ্চে বসতো এই চোরাবেড়ির সব লোকের হেব্বি ঝামেলা হলো।
    · shot cut [1151.0]
[1151.3–1153.9] থামিয়ে দিলাম। তারপর বাবলু ভাই ডাকসি কইলো।
    · shot cut [1153.7]
[1155.3–1157.1] কাল সকাল থেকে আস্তে কইছে।
[1157.3–1158.5] তুই কি কইলু?
[1158.9–1160.5] রাজী হয়ে গেছি।
    · silence 0.6s [1160.1–1160.7]
    · shot cut [1160.1]
[1160.7–1162.9] কাজ ভালো করলে আরো কাজ পওয়া গ্যাছে।
    · shot cut [1162.8]
[1163.6–1164.8] আর কেউ ছিলো?
[1165.1–1166.4] মদন হালদার ছিল।
    · shot cut [1167.0]
[1166.8–1168.1] আর তোকে জানাইছো?
[1168.4–1168.9] না।
[1171.8–1173.4] ঠিক আছে ভালোভাবে কাজ কর।
    · silence 1.0s [1173.1–1174.1]
    · shot cut [1173.2]
[1174.0–1175.4] তুমি কবে আসবে?
    · silence 0.6s [1175.2–1175.8]
[1175.6–1177.4] কাল পরশুর মধ্যে চলে আসবো। রাখ।
    · shot cut [1177.7]
[1177.7–1178.7] এই।
[1178.7–1179.1] শুন।
[1179.3–1179.9] হাঁ।
[1180.4–1182.2] সাবধানে রবি ফুন্টোস।
[1182.3–1182.9] হাঁ।
[1183.5–1184.4] রাখ।
`;

const nextLines = `
    · shot cut [1196.1]
[1193.1–1194.8] বঙ্কদা বাইস।
[1195.0–1195.8] বাস।
[1215.7–1216.7] ক
    · shot cut [1208.8]
    · shot cut [1211.2]
    · shot cut [1216.4]
[1217.6–1219.0] ফন্টুস ফোন করছিল।
    · shot cut [1218.7]
[1220.3–1221.0] কি হইছে?
[1221.6–1223.5] ঐ জোড়া বেড়িতে ক্যাচাল হইছিল আজ বনতের সাথে।
[1224.3–1225.6] ফন্টুস দা সামাল দিছে।
    · shot cut [1227.2]
[1226.6–1227.6] মিটিছে?
[1228.6–1229.6] হও।
[1230.6–1232.4] হ ওখানে এরকম চলবে এখন।
[1233.2–1234.8] হ কদিন তো চলবেই।
`;

// ---- Code: number the dialogue lines only (P1, P2… / 1, 2… / N1, N2…). The silence/shot-cut
// lines are left exactly as written above — untouched, unnumbered.
function number(text, prefix) {
  let n = 0;
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t.startsWith("[")) return line; // a "· silence …" / "· shot cut …" marker: pass through as-is
      n++;
      return `${prefix}${n}. ${t}`;
    })
    .join("\n");
}
const currentLineCount = currentLines.trim().split("\n").filter((l) => l.trim().startsWith("[")).length;

const allNegative = [...new Set(brands.flatMap((b) => b.never_next_to))].sort();
const blockAll = allNegative.filter((c) => brands.filter((b) => b.never_next_to.includes(c)).length / brands.length > BLOCK_ALL_SHARE);
const brandName = (id) => brands.find((b) => b.brand_id === id)?.name ?? id;
const selectableBrands = brands.map((b) => b.brand_id); // every brand: nothing is excluded here (see note above)

// ---- The prompt (system) — kept word-for-word with prompts/placement.ts's placementSystemPrompt
const rules = `
You are the ad-break planner for a Bengali TV drama on a streaming service. You look at one stretch of the episode and decide whether one mid-roll ad should play in it, after which line, and for which brand. Pick the single best moment in the whole stretch.

You are one of several separate calls, one per stretch of the episode, each looking only at its own stretch. You are not told what any other stretch decided, and code will not necessarily use your pick even if it is good: it picks the best combination across every stretch afterwards, keeping ads apart and never repeating a brand back to back. Judge only your own stretch on its own merits.

WHAT YOU RECEIVE
- STORY SO FAR: a short summary of the episode, for background only.
- BRANDS: each with "fits_scenes_about" (scenes it suits) and "never_next_to" (scenes it must never appear next to).
- PREVIOUS LINES (P1, P2, …) and NEXT LINES (N1, N2, …): dialogue just before and after. Context only. You cannot place an ad after these lines.
- CURRENT LINES (1, 2, 3, …): the stretch you are planning. Ads can only go after one of these.
- Mixed in between the dialogue lines, you will also see plain lines measured directly from the audio and picture, with no line number of their own:
  "· silence 1.5s [1141.0–1142.5]": nothing at all is audible in that window (no speech, no music).
  "· shot cut [1141.0]": the picture changes to a new shot at that moment.
  These tell you where a real pause or a scene change actually is. A big gap in the timestamps between two lines with no silence marker there usually means music or background sound is still playing, not silence.

HOW TO WORK
1. Read all the lines first: previous, current and next, together with the silence and shot-cut markers. Work out who is talking, where, about what, and the mood.
2. Split the current lines into conversations. A conversation ends when it is clearly finished and the next line starts something new: the topic, the place or the people change.
3. Use the next lines to check the end of the current lines. If a conversation carries on into the next lines, it has not ended.
4. Use the silence and shot-cut markers as evidence, not as a rule by themselves: a silence at the point you are considering means it is safe to cut there; a shot cut nearby often, but not always, means the scene is changing. A shot cut in the middle of a conversation (the camera switching between two speakers) does not end it.

RULES
Placement
1. An ad plays after a line, at a point backed by a measured silence (or, if there truly is none nearby, the quietest, most conversation-ending point you can find).
2. That line must be the LAST line of a finished conversation. Never place an ad in the middle of a conversation, between a question and its answer, or after a line that calls someone over or starts something ("come here", "listen", "wait").
3. Never interrupt suspense, an argument, a threat, a revelation or a cliffhanger, even if the argument is only verbal.
Suitability
4. The brand must fit what the viewer just watched or is about to watch, using its "fits_scenes_about". A brand that only fits the episode's general theme, and nothing in the scenes around this line, does not fit.
5. Never pick a brand when the scenes around the line involve anything in that brand's "never_next_to".
6. If the scenes around the line involve any of these, place no ad at all: ${blockAll.join(", ") || "(none)"}.
7. You do not know which brand played before or after your stretch, so do not try to avoid repeats yourself. Instead, whenever two or more brands fit about equally well, make your alternatives different brands from your main pick and from each other: that gives code real choices to keep brands from repeating back to back.
Honesty
8. You only have dialogue and the measurements described above, not the picture itself. Judge the scene from what is said and measured. Do not assume things that are not there.
9. If nothing in the current lines passes every rule, place no ad. A missing ad is better than a bad one.

EXAMPLE (made up; its brands are not in your list)
Brands: Brand X (travel/rail; fits "train journey", "station"; never next to "hospital"), Brand Y (snacks; fits "tea", "snacks"; never next to "hospital", "illness").
Current lines:
1. [410.0–412.1] The train leaves at six, don't be late.
2. [412.4–414.0] I've packed the tiffin and the tickets.
3. [414.3–416.8] Finally, our seats. Wake me up at Howrah.
    · silence 5.9s [417.0–422.9]
    · shot cut [421.4]
4. [423.5–425.9] Doctor, how is my father now?
5. [426.2–428.0] We need to operate tonight.
Output:
{"placement": {"line_id": 3, "brand_id": "brand_x", "fit": 0.9, "reason": "The train-journey conversation ends at line 3, followed by a 5.9 s measured silence and a shot cut into a new scene, and Brand X fits the journey.", "contexts_nearby": ["hospital", "illness"]}, "alternatives": [], "why_not_others": "Line 5 is inside a hospital emergency, which blocks every brand."}
Note that line 3 still sits right before a hospital scene, so its own contexts_nearby names it. Every choice carries its own list, judged at its own line: a choice further back, with no sensitive scene before or after it, has an empty list even though this one does not. Code checks each choice's list against that choice's brand, which is why you must report them honestly.

OUTPUT
Return JSON only, in exactly this shape:
{
  "placement": {"line_id": 0, "brand_id": "...", "fit": 0.0, "reason": "...", "contexts_nearby": ["..."]} or null,
  "alternatives": [{"line_id": 0, "brand_id": "...", "fit": 0.0, "reason": "...", "contexts_nearby": ["..."]}],
  "why_not_others": "..."
}
- placement: your best choice, or null if no ad should play in this stretch.
- line_id: a current-line number (1 to ${currentLineCount}).
- brand_id: a brand_id from BRANDS.
- fit (0–1): 0 = unrelated to the scenes around the line, 0.5 = loosely related, 1 = directly matches what they show.
- reason: one English sentence: which conversation ends at that line, what silence or shot cut is there, and why this brand fits.
- alternatives: 2 other valid choices, best first, preferably after different lines AND a different brand each (code checks every choice, and uses the next one if yours fails or if code needs a different brand here to avoid repeating one). Fewer only if fewer points pass the rules.
- contexts_nearby: on EACH choice, every item from any brand's "never_next_to" that appears in the scene before OR after THAT choice's own line. Judge each choice at its own line and nowhere else: a sensitive scene next to one choice does not belong on another choice 90 seconds away, and one next to an alternative must be listed on that alternative even if your main pick is clear of it. Use the exact strings. Empty only if you are sure there is none for that line.
- why_not_others: one or two sentences on why other points were not chosen.
`.trim();

// ---- The input message (user) — kept word-for-word with placementUserPrompt (minus the "brands
// already shown" / "previous ad break brand" lines, which no longer exist there either)
const userMessage = `
STORY SO FAR
${storySoFar}

BRANDS
${JSON.stringify(brands, null, 2)}

PREVIOUS LINES (context only, no ads here)
${number(previousLines, "P")}

CURRENT LINES (ads only after one of these)
${number(currentLines, "")}

NEXT LINES (context only, no ads here)
${number(nextLines, "N")}
`.trim();

// ---- Answer schema
const choice = {
  type: "object",
  additionalProperties: false,
  required: ["line_id", "brand_id", "fit", "reason", "contexts_nearby"],
  properties: {
    line_id: { type: "integer", enum: Array.from({ length: currentLineCount }, (_, i) => i + 1) },
    brand_id: { type: "string", enum: selectableBrands },
    fit: { type: "number" },
    reason: { type: "string" },
    contexts_nearby: { type: "array", items: { type: "string", enum: allNegative } },
  },
};
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["placement", "alternatives", "why_not_others"],
  properties: {
    placement: { anyOf: [choice, { type: "null" }] },
    alternatives: { type: "array", items: choice },
    why_not_others: { type: "string" },
  },
};

// ---- The call
const input = {
  model: MODEL,
  reasoning: { effort: REASONING_EFFORT },
  response_format: { type: "json_schema", json_schema: { name: "ad_slot_plan", strict: true, schema } },
  usage: { include: true },
  messages: [
    { role: "system", content: rules },
    { role: "user", content: userMessage },
  ],
};

console.log("==================== INPUT ====================");
console.log(`model: ${MODEL} · reasoning effort: ${REASONING_EFFORT} · block-all contexts: ${blockAll.join(", ")}\n`);
console.log("--- system ---");
console.log(rules);
console.log("\n--- user ---");
console.log(userMessage);

if (!process.env.OPENROUTER_API_KEY) {
  console.error("\nOPENROUTER_API_KEY is not set (expected in the repo's .env).");
  process.exit(1);
}

const t0 = Date.now();
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify(input),
});
const body = await res.json();

console.log("\n==================== OUTPUT ====================");
if (!res.ok) {
  console.error(`HTTP ${res.status}:`, JSON.stringify(body, null, 2));
  process.exit(1);
}
const message = body.choices?.[0]?.message ?? {};
console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s · cost $${body.usage?.cost ?? "?"} · tokens in ${body.usage?.prompt_tokens} / out ${body.usage?.completion_tokens}\n`);
if (message.reasoning) {
  console.log("--- reasoning ---");
  console.log(message.reasoning);
  console.log();
}
console.log("--- answer ---");
let answer;
try {
  answer = JSON.parse(message.content);
  console.log(JSON.stringify(answer, null, 2));
} catch {
  console.log(message.content);
  process.exit(1);
}

// ---- A few sanity checks code would run on the answer (the content-only ones: see checkOption in
// stages/placement.ts. Not shown here: the same-brand-adjacent, repeat-cap and gap/budget checks —
// those depend on every chunk's answer and the chosen schedule, which don't exist at this scale.)
console.log("\n==================== CODE CHECKS ====================");
const options = [answer.placement, ...(answer.alternatives ?? [])].filter(Boolean);
if (!options.length) console.log("No placement proposed: nothing to check.");
for (const [i, o] of options.entries()) {
  const nearby = new Set(o.contexts_nearby ?? []);
  const brand = brands.find((b) => b.brand_id === o.brand_id);
  const problems = [];
  if (!brand) problems.push(`unknown brand ${o.brand_id}`);
  const ownBlock = brand ? brand.never_next_to.filter((c) => nearby.has(c)) : [];
  if (ownBlock.length) problems.push(`brand's never_next_to reported nearby: ${ownBlock.join(", ")}`);
  const allBlock = blockAll.filter((c) => nearby.has(c));
  if (allBlock.length) problems.push(`block-all context reported nearby: ${allBlock.join(", ")}`);
  if (o.fit < MIN_FIT) problems.push(`fit ${o.fit} < ${MIN_FIT}`);
  const label = `${i === 0 ? "placement" : `alternative ${i}`}: line ${o.line_id} · ${brand?.name ?? o.brand_id} · fit ${o.fit}`;
  console.log(`${problems.length ? "✗" : "✓"} ${label}${problems.length ? `\n    rejected: ${problems.join("; ")}` : ""}`);
}

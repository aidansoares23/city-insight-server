// node src/scripts/generateCityLines.js
//
// One-time script — generates AI-based city profiles (base ratings + review lines)
// for all 107 cities and writes to src/scripts/data/cityProfiles.json.
// Run once, commit the output; seedUtils.js reads it automatically.
//
// Flags:
//   --dry-run    Log prompts without calling the API
//   --force      Re-generate cities that already have an entry in the output file
//                (default: skip cities already present — safe to re-run)

require("dotenv").config();

const fs   = require("fs");
const path = require("path");

const { anthropicClient, AI_MODEL } = require("../config/anthropic");

// ---------------------------------------------------------------------------
// City list — 5 hardcoded + 102 from batch file (deduped)
// ---------------------------------------------------------------------------

const HARDCODED_CITIES = [
  { slug: "san-francisco-ca", name: "San Francisco" },
  { slug: "san-jose-ca",      name: "San Jose"      },
  { slug: "los-angeles-ca",   name: "Los Angeles"   },
  { slug: "san-diego-ca",     name: "San Diego"     },
  { slug: "sacramento-ca",    name: "Sacramento"    },
];

const BATCH_CITIES = require("../data/cities-ca-batch.json").map((c) => ({
  slug: c.slug,
  name: c.name,
}));

const HARDCODED_SLUGS = new Set(HARDCODED_CITIES.map((c) => c.slug));
const ALL_CITIES = [
  ...HARDCODED_CITIES,
  ...BATCH_CITIES.filter((c) => !HARDCODED_SLUGS.has(c.slug)),
];

// ---------------------------------------------------------------------------
// Output file
// ---------------------------------------------------------------------------

const OUT_DIR  = path.join(__dirname, "data");
const OUT_FILE = path.join(OUT_DIR, "cityProfiles.json");

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveProfiles(profiles) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(profiles, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasFlag(name) { return process.argv.includes(name); }

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// AI generation
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are generating seed data for a city review app. For each California city provided, output honest, realistic ratings and short review snippets that reflect that city's real character — not generic filler.

Ratings use a 1–10 integer scale:
- safety: perceived day-to-day safety (10 = very safe)
- affordability: cost of living / housing value (10 = very affordable)
- walkability: ease of getting around without a car (10 = very walkable)
- cleanliness: streets and public spaces (10 = very clean)

reviewLines: exactly 6 short, distinct first-person snippets (1–2 sentences each). They should:
- Feel authentic, not promotional
- Reflect that city's actual strengths and weaknesses
- Vary in tone: some positive, some cautionary, some neutral
- Avoid generic phrases like "great place to live" or "something for everyone"
- Be specific to that city's real character (geography, economy, vibe, quirks)

Return ONLY a valid JSON array — no markdown fences, no explanation. Schema:
[
  {
    "slug": "city-slug",
    "baseRatings": { "safety": 7, "affordability": 5, "walkability": 4, "cleanliness": 7 },
    "reviewLines": ["...", "...", "...", "...", "...", "..."]
  }
]`;

async function generateBatch(cities, dryRun) {
  const cityList = cities.map((c) => `- ${c.name} (slug: ${c.slug})`).join("\n");
  const userMsg  = `Generate profiles for these ${cities.length} California cities:\n${cityList}`;

  if (dryRun) {
    console.log(`\n--- DRY RUN batch (${cities.length} cities) ---`);
    console.log(cities.map((c) => c.name).join(", "));
    return null;
  }

  const response = await anthropicClient.messages.create({
    model: AI_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  const raw     = response.content[0]?.text ?? "";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("  Failed to parse response:", raw.slice(0, 400));
    throw new Error("JSON parse failed");
  }

  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array from Claude");
  return parsed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = hasFlag("--dry-run");
  const force  = hasFlag("--force");

  const existing = loadExisting();

  const toProcess = force
    ? ALL_CITIES
    : ALL_CITIES.filter((c) => !existing[c.slug]);

  if (toProcess.length === 0) {
    console.log("✅ All cities already have profiles. Use --force to regenerate.");
    return;
  }

  console.log(
    `Generating profiles for ${toProcess.length}/${ALL_CITIES.length} cities` +
    (dryRun ? " (DRY RUN)" : "") +
    "...",
  );

  const batches  = chunk(toProcess, 12);
  const profiles = { ...existing };
  let successCount = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`\nBatch ${i + 1}/${batches.length}: ${batch.map((c) => c.name).join(", ")}`);

    try {
      const results = await generateBatch(batch, dryRun);

      if (results) {
        for (const item of results) {
          if (
            !item.slug ||
            !item.baseRatings ||
            typeof item.baseRatings !== "object" ||
            !Array.isArray(item.reviewLines) ||
            item.reviewLines.length < 6
          ) {
            console.warn(`  ⚠️  Skipping malformed entry for "${item.slug}"`);
            continue;
          }
          profiles[item.slug] = {
            baseRatings: {
              safety:       Number(item.baseRatings.safety),
              affordability: Number(item.baseRatings.affordability),
              walkability:  Number(item.baseRatings.walkability),
              cleanliness:  Number(item.baseRatings.cleanliness),
            },
            reviewLines: item.reviewLines.slice(0, 6),
          };
          successCount++;
        }

        saveProfiles(profiles);
        console.log(`  ✅ Saved ${successCount} profiles so far.`);
      }
    } catch (e) {
      console.error(`  ❌ Batch ${i + 1} failed: ${e.message}`);
    }

    if (!dryRun && i < batches.length - 1) await sleep(600);
  }

  if (!dryRun) {
    const missing = ALL_CITIES.filter((c) => !profiles[c.slug]);
    console.log(`\n🎉 Done. Generated ${successCount} new profiles → ${OUT_FILE}`);
    if (missing.length > 0) {
      console.warn(`⚠️  ${missing.length} cities still missing profiles:`);
      missing.forEach((c) => console.warn(`   - ${c.slug}`));
      console.warn("   Re-run (without --force) to fill gaps.");
    }
  }
}

main().catch((e) => {
  console.error("❌ generateCityLines failed:", e);
  process.exitCode = 1;
});

import type { AnalysisInput, AnalysisResult, Review, Theme } from "../types";
import { getProduct } from "../data/products";
import { reviews as allReviews } from "../data/reviews";

/**
 * Analyze product reviews for a given product and date range.
 *
 * This is the single boundary between the UI and "the analysis engine".
 * Today it returns deterministic mock insight derived from local sample data;
 * swapping in a real Claude API call later means changing only this file — the
 * async signature and `AnalysisResult` contract stay the same.
 */
export async function analyzeReviews(input: AnalysisInput): Promise<AnalysisResult> {
  const { productId, from, to } = input;

  const product = getProduct(productId);
  if (!product) {
    throw new AnalysisError(`Unknown product: ${productId}`);
  }
  if (from > to) {
    throw new AnalysisError("The start date must be on or before the end date.");
  }

  // Simulate network / model latency so loading states are exercised.
  await delay(900);

  const matching = allReviews
    .filter((r) => r.productId === productId && r.date >= from && r.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));

  const insight = INSIGHTS[productId];
  if (!insight) {
    // Data-integrity guard: every catalog product should have canned insight.
    throw new AnalysisError(`No analysis profile configured for ${product.name}.`);
  }

  const reviewCount = matching.length;
  const averageRating =
    reviewCount === 0 ? 0 : round1(matching.reduce((sum, r) => sum + r.rating, 0) / reviewCount);

  return {
    productName: product.name,
    from,
    to,
    reviewCount,
    averageRating,
    // Summary is derived from real filtered figures so it reflects the range.
    summary:
      reviewCount === 0
        ? `No reviews found for ${product.name} in the selected date range.`
        : `Across ${reviewCount} review${reviewCount === 1 ? "" : "s"} of ${product.name} ` +
          `(average rating ${averageRating.toFixed(1)}★), ${insight.summaryTail}`,
    loves: insight.loves,
    dislikes: insight.dislikes,
    themes: buildThemes(insight.themes, matching),
    recommendations: insight.recommendations,
  };
}

/** Error type the UI can distinguish from unexpected runtime failures. */
export class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisError";
  }
}

// --- internal helpers -------------------------------------------------------

interface ThemeSeed {
  label: string;
  /** Lowercase keywords; a review counts toward the theme if it matches any. */
  keywords: string[];
}

interface ProductInsight {
  summaryTail: string;
  loves: string[];
  dislikes: string[];
  themes: ThemeSeed[];
  recommendations: string[];
}

/** Count how many of the matched reviews mention each theme's keywords. */
function buildThemes(seeds: ThemeSeed[], matching: Review[]): Theme[] {
  return seeds
    .map((seed) => {
      const mentions = matching.filter((r) => {
        const text = r.text.toLowerCase();
        return seed.keywords.some((kw) => text.includes(kw));
      }).length;
      return { label: seed.label, mentions };
    })
    .filter((theme) => theme.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Canned per-product analysis. In production this is what the model would
// generate; keeping it here makes the mock deterministic and testable.
const INSIGHTS: Record<string, ProductInsight> = {
  "aurora-earbuds": {
    summaryTail:
      "customers consistently praise the sound quality and battery life, while a recurring minority report Bluetooth connection drops and overly sensitive touch controls.",
    loves: [
      "Sound quality that punches well above the price point",
      "All-day battery life that survives long commutes and flights",
      "Effective noise cancellation and a comfortable, secure fit",
    ],
    dislikes: [
      "Bluetooth connection drops, especially on calls",
      "Touch controls are too sensitive and trigger accidental pauses",
      "Charging case feels cheap and can fail to charge a bud",
    ],
    themes: [
      { label: "Sound quality", keywords: ["sound", "bass", "crisp", "audio", "crema"] },
      { label: "Battery life", keywords: ["battery", "charge", "charging"] },
      { label: "Connectivity", keywords: ["connection", "bluetooth", "dropping", "stutter"] },
      { label: "Noise cancellation", keywords: ["noise cancellation", "noise"] },
      { label: "Controls", keywords: ["controls", "touch", "pausing", "pause"] },
    ],
    recommendations: [
      "Investigate the Bluetooth stack for pocket/occlusion signal drops reported on calls.",
      "Add an option to reduce touch sensitivity or disable tap-to-pause.",
      "Review charging-case contact reliability with the manufacturer.",
    ],
  },
  "trailpeak-backpack": {
    summaryTail:
      "reviewers love the carrying comfort, durability, and storage, but zipper reliability and limited rain resistance are recurring pain points.",
    loves: [
      "Excellent carrying comfort from the padded straps and hip belt",
      "Durable, tough fabric that holds up on the trail",
      "Generous, well-organized storage with plenty of pockets",
    ],
    dislikes: [
      "Zippers snag and occasionally break under use",
      "Not fully waterproof; gear can get damp without a separate cover",
      "Rain cover is sold separately rather than included",
    ],
    themes: [
      { label: "Comfort", keywords: ["comfortable", "comfort", "straps", "hip belt"] },
      { label: "Durability", keywords: ["durable", "tough", "durability"] },
      { label: "Storage", keywords: ["storage", "pockets", "roomy", "spacious", "capacity"] },
      { label: "Zippers", keywords: ["zipper", "zippers"] },
      { label: "Water resistance", keywords: ["rain", "waterproof", "damp", "storm"] },
    ],
    recommendations: [
      "Source higher-grade zippers or offer a warranty-backed zipper replacement.",
      "Bundle the rain cover or improve out-of-the-box water resistance.",
      "Highlight the hip-belt comfort in marketing — it is the top praised feature.",
    ],
  },
  "brewmaster-espresso": {
    summaryTail:
      "customers rave about espresso quality and the milk frother, but cleaning effort and unit reliability are the most common complaints.",
    loves: [
      "Cafe-quality espresso with rich crema and fast heat-up",
      "A milk frother that produces restaurant-grade lattes",
      "Consistent shot quality once the grind is dialed in",
    ],
    dislikes: [
      "Cleaning and maintenance are tedious and time-consuming",
      "Reliability issues: pressure loss and leaking reported after weeks",
      "Steep learning curve and noticeable operating noise",
    ],
    themes: [
      { label: "Espresso quality", keywords: ["espresso", "crema", "shots", "shot"] },
      { label: "Milk frother", keywords: ["frother", "froth", "latte", "lattes"] },
      { label: "Cleaning", keywords: ["cleaning", "clean", "maintain", "maintenance", "tedious"] },
      { label: "Reliability", keywords: ["pressure", "leaking", "leak", "stopped", "reliability"] },
      { label: "Ease of use", keywords: ["learning curve", "loud", "dial"] },
    ],
    recommendations: [
      "Simplify cleaning — a removable, dishwasher-safe drip tray and portafilter would help most.",
      "Investigate pressure-loss and leaking failures reported within the first few months.",
      "Ship a quick-start grind guide to shorten the learning curve.",
    ],
  },
};

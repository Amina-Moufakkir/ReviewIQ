import { describe, it, expect } from "vitest";
import type { AnalysisResult, Finding } from "../types";
import { formatDate } from "./date";
import { generateMarkdownReport } from "./generateMarkdownReport";
import { PRODUCT_RECORD, REVIEW } from "./datasetInfo";

const GENERATED_ON = "July 22, 2026";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    label: "Comfort",
    sentiment: "positive",
    mentions: 8,
    percent: 32,
    quote: "Very comfortable for long work sessions.",
    quoteAuthor: "Taylor",
    ...overrides,
  };
}

function result(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    productName: "Ergo Desk Chair",
    from: "2026-01-01",
    to: "2026-03-31",
    reviewCount: 25,
    averageRating: 4.2,
    summary: "Reviewers value the comfort but struggle with assembly.",
    praise: [finding()],
    faults: [
      finding({
        label: "Assembly",
        sentiment: "negative",
        mentions: 5,
        percent: 20,
        quote: "The instructions were difficult to follow.",
        quoteAuthor: "",
      }),
    ],
    recommendations: ["Improve the assembly instructions.", "Clarify the required tools."],
    ...overrides,
  };
}

describe("generateMarkdownReport", () => {
  it("includes the product name as the title", () => {
    const md = generateMarkdownReport(result(), GENERATED_ON);
    expect(md).toContain("# ReviewIQ Report: Ergo Desk Chair");
  });

  it("includes the formatted analysis window dates", () => {
    const md = generateMarkdownReport(result(), GENERATED_ON);
    expect(md).toContain(
      `**Analysis window:** ${formatDate("2026-01-01")} – ${formatDate("2026-03-31")}`,
    );
  });

  it("includes the review count and average rating", () => {
    const md = generateMarkdownReport(result(), GENERATED_ON);
    expect(md).toContain("**Reviews analyzed:** 25");
    expect(md).toContain("**Average rating:** 4.2/5");
  });

  it("includes the summary", () => {
    const md = generateMarkdownReport(result(), GENERATED_ON);
    expect(md).toContain("## Summary");
    expect(md).toContain("Reviewers value the comfort but struggle with assembly.");
  });

  it("includes complete praise finding evidence", () => {
    const md = generateMarkdownReport(result(), GENERATED_ON);
    expect(md).toContain("## Top Strengths");
    expect(md).toContain("### Comfort");
    expect(md).toContain("- **Evidence:** 8 of 25 selected reviews (32%)");
  });

  it("includes complete fault finding evidence", () => {
    const md = generateMarkdownReport(result(), GENERATED_ON);
    expect(md).toContain("## Top Issues");
    expect(md).toContain("### Assembly");
    expect(md).toContain("- **Evidence:** 5 of 25 selected reviews (20%)");
  });

  it("includes representative quotes and authors", () => {
    const md = generateMarkdownReport(result(), GENERATED_ON);
    expect(md).toContain(
      '- **Representative quote:** "Very comfortable for long work sessions." — Taylor',
    );
  });

  it("uses Anonymous when the quote author is absent", () => {
    const md = generateMarkdownReport(result(), GENERATED_ON);
    expect(md).toContain(
      '- **Representative quote:** "The instructions were difficult to follow." — Anonymous',
    );
  });

  it("formats recommendations as a numbered list", () => {
    const md = generateMarkdownReport(result(), GENERATED_ON);
    expect(md).toContain("## Recommendations");
    expect(md).toContain("1. Improve the assembly instructions.");
    expect(md).toContain("2. Clarify the required tools.");
  });

  it("handles empty praise with a fallback line", () => {
    const md = generateMarkdownReport(result({ praise: [] }), GENERATED_ON);
    expect(md).toContain("## Top Strengths");
    expect(md).toContain("No strengths met the evidence threshold in this analysis.");
  });

  it("handles empty faults with a fallback line", () => {
    const md = generateMarkdownReport(result({ faults: [] }), GENERATED_ON);
    expect(md).toContain("## Top Issues");
    expect(md).toContain("No issues met the evidence threshold in this analysis.");
  });

  it("handles empty recommendations with a fallback line", () => {
    const md = generateMarkdownReport(result({ recommendations: [] }), GENERATED_ON);
    expect(md).toContain("## Recommendations");
    expect(md).toContain(
      "No actions were recommended because no recurring issues met the evidence threshold.",
    );
  });

  it("does not repeat a quote shared by multiple findings", () => {
    const shared = {
      quote: "Incredible sound quality for the price.",
      quoteAuthor: "Priya N.",
    };
    const md = generateMarkdownReport(
      result({
        praise: [
          finding({ label: "Sound quality", mentions: 5, percent: 45, ...shared }),
          finding({ label: "Value for money", mentions: 3, percent: 27, ...shared }),
        ],
      }),
      GENERATED_ON,
    );

    // Both findings and their evidence are present...
    expect(md).toContain("### Sound quality");
    expect(md).toContain("- **Evidence:** 5 of 25 selected reviews (45%)");
    expect(md).toContain("### Value for money");
    expect(md).toContain("- **Evidence:** 3 of 25 selected reviews (27%)");
    // ...but the shared quote appears exactly once.
    const occurrences = md.split(shared.quote).length - 1;
    expect(occurrences).toBe(1);
  });

  it("still shows distinct quotes for each finding", () => {
    const md = generateMarkdownReport(
      result({
        praise: [
          finding({ label: "Sound quality", quote: "Great sound.", quoteAuthor: "A" }),
          finding({ label: "Comfort", quote: "Very comfy.", quoteAuthor: "B" }),
        ],
      }),
      GENERATED_ON,
    );
    expect(md).toContain('"Great sound." — A');
    expect(md).toContain('"Very comfy." — B');
  });

  it("omits the promotions section when there is no promotion insight", () => {
    const md = generateMarkdownReport(result(), GENERATED_ON);
    expect(md).not.toContain("## Discounts & Promotions");
  });

  it("includes a promotions section with evidence when present", () => {
    const md = generateMarkdownReport(
      result({
        promotion: {
          promoCount: 5,
          fullPriceCount: 6,
          promoAverageRating: 3.4,
          fullPriceAverageRating: 3.8,
          ratingDelta: -0.4,
          promotions: ["Launch Offer", "Spring Sale"],
          comparable: true,
          note: "Promoted purchases rated 3.4★ on average — 0.4★ lower than full-price reviews (3.8★).",
        },
      }),
      GENERATED_ON,
    );
    expect(md).toContain("## Discounts & Promotions");
    expect(md).toContain("Promoted purchases rated 3.4★ on average");
    expect(md).toContain("- **Promoted purchases:** 5 reviews, 3.4/5 average");
    expect(md).toContain("- **Full price:** 6 reviews, 3.8/5 average");
    expect(md).toContain("- **Promotions seen:** Launch Offer, Spring Sale");
  });

  it("uses the provided deterministic generated date", () => {
    const md = generateMarkdownReport(result(), GENERATED_ON);
    expect(md).toContain(`_Generated by ReviewIQ on ${GENERATED_ON}._`);
  });

  it("falls back to a formatted current date when none is provided", () => {
    const md = generateMarkdownReport(result());
    expect(md).toMatch(/_Generated by ReviewIQ on .+\._/);
  });
});

describe("markdown report — wording follows the dataset unit", () => {
  const noFindings: AnalysisResult = {
    productName: "Test Widget",
    from: "",
    to: "",
    reviewCount: 1,
    averageRating: 4,
    summary: "Based on a single product record of Test Widget (rated 4.0\u2605).",
    praise: [],
    faults: [],
    recommendations: [],
  };

  it('drops "recurring" from the no-recommendations line for product records', () => {
    const asRecords = generateMarkdownReport(noFindings, GENERATED_ON, PRODUCT_RECORD);
    expect(asRecords).toContain("no issues met the evidence threshold");
    expect(asRecords).not.toMatch(/recurring/i);
  });

  it("keeps it for review data", () => {
    const asReviews = generateMarkdownReport(noFindings, GENERATED_ON, REVIEW);
    expect(asReviews).toContain("no recurring issues met the evidence threshold");
  });
});

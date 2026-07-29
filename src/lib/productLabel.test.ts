import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { shortProductLabel } from "./productLabel";
import { adaptAmazonCsv } from "./amazonAdapter";

const MAX_LABEL = 64;

describe("shortProductLabel — short titles are left alone", () => {
  it("returns a title that is already scannable unchanged", () => {
    for (const name of [
      "Firestick Remote",
      "Tata Sky Universal Remote",
      "AuroraSound Wireless Earbuds",
      "Brightwell 12-Cup Programmable Coffee Maker",
      "Nokia 150 (2020) (Cyan)",
    ]) {
      expect(shortProductLabel(name)).toBe(name);
    }
  });

  it("does not shorten at a separator when the title is short enough", () => {
    // The separators are only a shortening strategy, never a rewrite.
    const name = "MI Usb Type-C Cable Smartphone (Black)";
    expect(shortProductLabel(name)).toBe(name);
  });

  it("collapses runs of whitespace", () => {
    expect(shortProductLabel("  Sony   WH-1000XM4  ")).toBe("Sony WH-1000XM4");
  });
});

describe("shortProductLabel — cutting at a clause separator", () => {
  it("cuts at a comma", () => {
    expect(
      shortProductLabel(
        "ZEBRONICS Zeb-Comfort Wired USB Mouse, 3-Button, 1000 DPI Optical Sensor, Plug & Play, for Windows/Mac, Black",
      ),
    ).toBe("ZEBRONICS Zeb-Comfort Wired USB Mouse");
  });

  it("cuts at a pipe", () => {
    expect(
      shortProductLabel(
        "Lifelong LLMG93 500 Watt Duos Mixer Grinder | ABS Body, Stainless Steel Blades, 3 Speed Options",
      ),
    ).toBe("Lifelong LLMG93 500 Watt Duos Mixer Grinder");
  });

  it("cuts at an opening parenthesis", () => {
    expect(
      shortProductLabel(
        "Crompton Arno Neo 15-L 5 Star Rated Storage Water Heater (Geyser) with Advanced 3 Level Safety (Grey)",
      ),
    ).toBe("Crompton Arno Neo 15-L 5 Star Rated Storage Water Heater");
  });

  it("cuts at ' with '", () => {
    expect(
      shortProductLabel(
        "Logitech C270 Digital HD Webcam with Widescreen HD Video Calling, HD Light Correction, Noise-Reducing Mic",
      ),
    ).toBe("Logitech C270 Digital HD Webcam");
  });

  it("cuts at ' for '", () => {
    expect(
      shortProductLabel(
        "SanDisk Extreme SD UHS I 64GB Card for 4K Video for DSLR and Mirrorless Cameras 170MB/s Read & 80MB/s Write",
      ),
    ).toBe("SanDisk Extreme SD UHS I 64GB Card");
  });

  it("leaves no trailing separator punctuation", () => {
    const label = shortProductLabel(
      "Amazon Brand - Solimo 65W Fast Charging Braided Type C to C Data Cable | Suitable For All Supported Mobile Phones (1 Meter, Black)",
    );
    // The head ("…Type C to C Data Cable") is 70 chars, so it is truncated
    // back to a word boundary rather than kept over budget.
    expect(label).toBe("Amazon Brand - Solimo 65W Fast Charging Braided Type C to C…");
    expect(label).not.toMatch(/[\s,\-–—|]…?$/);
  });
});

describe("shortProductLabel — guards", () => {
  it("skips a separator that would leave too little of the title", () => {
    // " - " comes first, but "Smashtronics®" alone is not a product.
    expect(
      shortProductLabel(
        "Smashtronics® - Case for Firetv Remote, Fire Stick Remote Cover Case, Shockproof Silicone Cover",
      ),
    ).toBe("Smashtronics® - Case for Firetv Remote");

    // The first pipe leaves 27 characters — one short of the minimum — so the
    // label keeps going to the next one rather than stopping at a bare model.
    expect(
      shortProductLabel(
        "RESONATE RouterUPS CRU12V2A | Zero Drop | UPS for WiFi Router | Mini UPS | Up to 4 Hours PowerBackup",
      ),
    ).toBe("RESONATE RouterUPS CRU12V2A | Zero Drop");
  });

  it("never cuts inside a parenthetical group", () => {
    // The commas here sit inside "(...)"; cutting at one would leave an
    // unbalanced fragment like "Redmi A1 (Light Blue".
    expect(
      shortProductLabel(
        "Redmi A1 (Light Blue, 2GB RAM, 32GB Storage) | Segment Best AI Dual Cam | 5000mAh Battery",
      ),
    ).toBe("Redmi A1 (Light Blue, 2GB RAM, 32GB Storage)");

    expect(
      shortProductLabel(
        "Tecno Spark 9 (Sky Mirror, 6GB RAM,128GB Storage) | 11GB Expandable RAM | Helio G37 Gaming Processor",
      ),
    ).toBe("Tecno Spark 9 (Sky Mirror, 6GB RAM,128GB Storage)");
  });

  it("falls back to word-boundary truncation when no separator qualifies", () => {
    const label = shortProductLabel(
      "ACTIVA 1200 MM HIGH SPEED 390 RPM BEE APPROVED 5 STAR RATED APSRA CEILING FAN BROWN 2 Years Warranty",
    );
    expect(label).toBe("ACTIVA 1200 MM HIGH SPEED 390 RPM BEE APPROVED 5 STAR RATED…");
    expect(label.endsWith("…")).toBe(true);
    // Cut on a word boundary, not mid-word.
    expect(label.slice(0, -1)).toMatch(/\S$/);
  });

  it("truncates a head that is itself still too long", () => {
    const label = shortProductLabel(
      "Wayona Nylon Braided USB to Lightning Fast Charging and Data Sync Cable Compatible for iPhone 13, 12, 11",
    );
    expect(label.length).toBeLessThanOrEqual(MAX_LABEL);
    expect(label.endsWith("…")).toBe(true);
  });

  it("handles an empty or blank name without throwing", () => {
    expect(shortProductLabel("")).toBe("");
    expect(shortProductLabel("   ")).toBe("");
  });
});

// The real dataset is developer-supplied; see amazonDataset.test.ts.
const REAL_PATH = new URL("../../public/amazon-products.csv", import.meta.url);

describe.skipIf(!existsSync(REAL_PATH))("shortProductLabel — real dataset", () => {
  const { dataset } = existsSync(REAL_PATH)
    ? adaptAmazonCsv(readFileSync(REAL_PATH, "utf8"), "Amazon product records")
    : { dataset: { products: [] } as never };

  it("keeps every label within the display budget", () => {
    for (const product of dataset.products) {
      expect(shortProductLabel(product.name).length).toBeLessThanOrEqual(MAX_LABEL);
    }
  });

  it("never lengthens a title, and never invents characters", () => {
    for (const product of dataset.products) {
      const label = shortProductLabel(product.name);
      expect(label.length).toBeLessThanOrEqual(product.name.length + 1); // +1 for "…"
      // Everything before the ellipsis is a verbatim prefix of the original,
      // modulo collapsed whitespace — the label never rewrites the title.
      const body = label.endsWith("…") ? label.slice(0, -1) : label;
      expect(product.name.replace(/\s+/g, " ").trim().startsWith(body)).toBe(true);
    }
  });

  it("leaves the product's own name untouched", () => {
    // The shortening is presentation-only: nothing writes back to the dataset.
    const before = dataset.products.map((p) => p.name);
    dataset.products.forEach((p) => shortProductLabel(p.name));
    expect(dataset.products.map((p) => p.name)).toEqual(before);
  });
});

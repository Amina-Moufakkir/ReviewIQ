import { describe, it, expect } from "vitest";
import { lowerFirst } from "./themeLabel";

describe("lowerFirst", () => {
  it("lowercases an ordinary Title Case label so it reads mid-sentence", () => {
    expect(lowerFirst("Sound quality")).toBe("sound quality");
    expect(lowerFirst("Battery life")).toBe("battery life");
    expect(lowerFirst("Ease of setup")).toBe("ease of setup");
  });

  // The bug this exists for: character zero was lowercased unconditionally, so
  // an acronym-leading label rendered as "Investigate uSB port not working."
  // Amazon electronics make these labels likely, not hypothetical.
  it("leaves an acronym-leading label alone", () => {
    expect(lowerFirst("USB port not working")).toBe("USB port not working");
    expect(lowerFirst("TV compatibility")).toBe("TV compatibility");
    expect(lowerFirst("LED brightness")).toBe("LED brightness");
    expect(lowerFirst("HDMI handshake fails")).toBe("HDMI handshake fails");
  });

  it("treats a digit as part of the acronym run", () => {
    expect(lowerFirst("5G coverage")).toBe("5G coverage");
    expect(lowerFirst("4K playback stutters")).toBe("4K playback stutters");
  });

  // "GaN" is a real spelling in this dataset ("65W GaN Fast Charger"): capital,
  // lowercase, capital. A "two leading capitals" rule would miss it, which is
  // why the check looks for any internal capital in the first word.
  it("keeps mixed-case technical spellings intact", () => {
    expect(lowerFirst("GaN charger runs hot")).toBe("GaN charger runs hot");
    expect(lowerFirst("eSIM activation")).toBe("eSIM activation");
  });

  it("leaves an already-lowercase label unchanged", () => {
    expect(lowerFirst("defective / not working with TV")).toBe("defective / not working with TV");
    expect(lowerFirst("voice recognition not working")).toBe("voice recognition not working");
  });

  it("does not mistake a single leading capital word for an acronym", () => {
    // "A" then a space is one capital, not two — this must still lowercase.
    expect(lowerFirst("Assembly")).toBe("assembly");
    expect(lowerFirst("A loose hinge")).toBe("a loose hinge");
  });

  it("handles empty and single-character labels without throwing", () => {
    expect(lowerFirst("")).toBe("");
    expect(lowerFirst("X")).toBe("x");
  });
});

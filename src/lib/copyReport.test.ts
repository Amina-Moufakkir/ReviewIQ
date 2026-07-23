import { describe, it, expect, vi, afterEach } from "vitest";
import { copyReportToClipboard } from "./copyReport";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyReportToClipboard", () => {
  it("writes the given markdown to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const markdown = "# ReviewIQ Report: Ergo Desk Chair\n";
    await copyReportToClipboard(markdown);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(markdown);
  });

  it("resolves on a successful write", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyReportToClipboard("report")).resolves.toBeUndefined();
  });

  it("rejects when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyReportToClipboard("report")).rejects.toThrow();
  });

  it("rejects when the Clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", {});

    await expect(copyReportToClipboard("report")).rejects.toThrow(/unavailable/i);
  });
});

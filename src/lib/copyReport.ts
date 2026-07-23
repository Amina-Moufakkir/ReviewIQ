/**
 * Copy report Markdown to the clipboard. Kept separate from UI so the
 * availability check and the write can be tested without a DOM. Rejects when
 * the Clipboard API is unavailable so callers can surface failure feedback.
 */
export async function copyReportToClipboard(markdown: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable.");
  }
  await navigator.clipboard.writeText(markdown);
}

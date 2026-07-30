/**
 * Presentation rules for a theme label.
 *
 * A label is authored in two very different ways — picked from THEME_LIBRARY by
 * the heuristic engine, or written by Claude for the batch it just read — but it
 * is rendered the same way everywhere, so the rule lives here once rather than
 * in each engine. Both previously carried their own copy of this logic, which
 * meant a fix had to be made twice or the two would drift.
 */

/**
 * Lowercase a label's first letter so it reads naturally mid-sentence, e.g.
 * "Sound quality" → "…sound quality draws the most praise".
 *
 * ACRONYMS AND TECHNICAL SPELLINGS ARE LEFT ALONE. Blindly lowercasing
 * character zero turns "USB port not working" into "uSB port not working" — and
 * on a dataset of Amazon electronics, USB / TV / LED / HDMI / GaN are exactly
 * the words a theme label opens with.
 *
 * The signal is an internal capital in the FIRST WORD. Ordinary prose does not
 * have one ("Sound", "Assembly"), while acronyms and technical spellings do:
 * "USB", "TV", "5G", "4K", and "GaN" — which matters here, since the dataset
 * ships a "65W GaN Fast Charger". Counting leading capitals instead would miss
 * "GaN", whose second character is lowercase.
 *
 * This is deliberately a rendering rule rather than an instruction to the model.
 * Telling Claude to write lowercase labels would fix nothing when the heuristic
 * engine supplies the label, and would still break the first time a model
 * legitimately opens one with an acronym.
 */
export function lowerFirst(label: string): string {
  const firstWord = label.split(/\s/, 1)[0] ?? "";
  if (/[A-Z]/.test(firstWord.slice(1))) return label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

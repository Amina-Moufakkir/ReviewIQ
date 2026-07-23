/**
 * Shared, product-agnostic theme vocabulary.
 *
 * The engine detects a theme when a review's text contains one of its
 * keywords, matched case-insensitively as a whole word (single tokens) or a
 * bounded phrase (multi-word), via matchKeyword.ts — deterministic and
 * explainable. Whether a mention is praise or a fault is decided separately,
 * from the review's star rating (see analysisEngine.ts), not from the theme.
 *
 * `recommendation` is a generic, product-agnostic action used when a theme
 * surfaces as a recurring fault. It is a heuristic prompt for an analyst, not
 * a model-generated insight.
 */
export interface ThemeDef {
  key: string;
  label: string;
  /** Lowercase keywords; single tokens match whole words, phrases match bounded. */
  keywords: string[];
  recommendation: string;
}

export const THEME_LIBRARY: ThemeDef[] = [
  // --- Audio / electronics ---
  {
    key: "sound-quality",
    label: "Sound quality",
    keywords: ["sound", "sounds", "audio", "bass", "treble", "mids", "clarity", "crisp"],
    recommendation: "Dig into the reviews mentioning sound quality to confirm what is driving sentiment.",
  },
  {
    key: "noise-cancellation",
    label: "Noise cancellation",
    keywords: ["noise cancellation", "noise-canceling", "noise cancelling", "active noise", "ambient sound", "ambient mode", "block out", "blocks out"],
    recommendation: "Review the noise-cancellation feedback to see whether it meets expectations.",
  },
  {
    key: "connectivity",
    label: "Connectivity",
    keywords: ["bluetooth", "connection", "pairing", "disconnect", "disconnecting", "signal", "cut out", "cuts out", "dropping", "drops"],
    recommendation: "Investigate the connection and pairing complaints for a reproducible failure mode.",
  },
  {
    key: "microphone",
    label: "Microphone quality",
    keywords: ["microphone", "the mic", "mic quality", "mic is", "call quality", "my voice", "voice sounds"],
    recommendation: "Check the microphone and call-quality reports across devices and environments.",
  },
  // --- Battery / power ---
  {
    key: "battery",
    label: "Battery life",
    keywords: ["battery", "recharge", "playback", "charge lasts", "hours on a charge"],
    recommendation: "Compare battery-life reports against the advertised runtime.",
  },
  {
    key: "power",
    label: "Power",
    keywords: ["powerful", "motor", "wattage", "suction", "airflow", "underpowered"],
    recommendation: "Assess whether the reported power/output matches customer expectations.",
  },
  // --- Comfort / fit ---
  {
    key: "comfort",
    label: "Comfort",
    keywords: ["comfortable", "comfort", "cushion", "padded", "ergonomic", "clamp", "headband", "wristband", "the band", "the strap", "on my wrist", "good fit", "fits well", "snug"],
    recommendation: "Read the comfort feedback to identify who finds the fit uncomfortable and why.",
  },
  // --- Build / durability ---
  {
    key: "build-quality",
    label: "Build quality",
    // Bare "build" is dropped: it collides with "hard to build" (a verb). Use
    // explicit noun-context phrases instead.
    keywords: ["build quality", "solid build", "sturdy build", "build feels", "well built", "poorly built", "cheaply built", "hinge", "crack", "cracks", "cracked", "creak", "creaks", "flimsy", "sturdy", "well made", "well-made"],
    recommendation: "Examine build-quality complaints for a common failure point.",
  },
  {
    key: "durability",
    label: "Durability",
    keywords: ["durable", "durability", "broke", "broken", "stopped working", "lasted", "wore out", "fell apart"],
    recommendation: "Trace durability failures to how long the product lasted before failing.",
  },
  // --- Kitchen / coffee ---
  {
    key: "coffee-quality",
    label: "Coffee quality",
    keywords: ["coffee", "espresso", "the taste", "tastes", "flavor", "flavour", "brew", "bitter"],
    recommendation: "Read the coffee-quality reviews to confirm what affects taste.",
  },
  {
    key: "setup",
    label: "Ease of setup",
    // "instructions"/"timer"/"clock" are dropped: they collide with chair
    // assembly instructions and toothbrush brushing timers across categories.
    keywords: ["setup", "set up", "program the", "programming", "easy to program"],
    recommendation: "Review setup feedback to see where first-time users get stuck.",
  },
  {
    key: "cleaning",
    label: "Cleaning",
    keywords: ["cleaning", "clean", "descale", "descaling", "carafe", "maintenance"],
    recommendation: "Look at the cleaning complaints to find the most tedious steps.",
  },
  {
    key: "leaking",
    label: "Leaking",
    keywords: ["leak", "leaks", "leaking", "drip", "dripping", "puddle", "spill", "spills"],
    recommendation: "Investigate the leaking reports for a batch or seal defect.",
  },
  {
    key: "brewing-speed",
    label: "Brewing speed",
    keywords: ["brew time", "brewing speed", "brews fast", "brews slowly", "takes forever to brew"],
    recommendation: "Compare reported brew times against expectations.",
  },
  {
    key: "temperature",
    label: "Temperature",
    keywords: ["lukewarm", "temperature", "not hot", "stays hot", "too cold", "heats"],
    recommendation: "Review temperature complaints to confirm the product brews/holds heat well.",
  },
  // --- Wearables ---
  {
    key: "activity-tracking",
    label: "Activity tracking",
    keywords: ["step count", "daily steps", "step tracking", "activity tracking", "fitness tracking", "sleep tracking", "heart rate", "gps", "workout", "tracks my"],
    recommendation: "Validate tracking-accuracy reports against a known reference.",
  },
  {
    key: "syncing",
    label: "Phone syncing",
    keywords: ["sync", "syncing", "synced", "won't pair", "pairing with my phone", "connect to my phone"],
    recommendation: "Reproduce the sync/pairing failures across phone models and OS versions.",
  },
  {
    key: "notifications",
    label: "Notifications",
    keywords: ["notification", "notifications", "alerts", "missed message", "buzz on my wrist"],
    recommendation: "Check notification-delivery complaints for missed or delayed alerts.",
  },
  {
    key: "display",
    label: "Display quality",
    keywords: ["display", "screen", "brightness", "too dim", "readable", "sunlight", "touchscreen"],
    recommendation: "Review display feedback, especially outdoor readability.",
  },
  {
    key: "app-reliability",
    label: "App reliability",
    keywords: ["the app", "app crash", "app crashes", "app freezes", "app keeps", "app is", "companion app", "mobile app", "app update", "firmware", "software update", "glitch", "buggy"],
    recommendation: "Prioritize the app crashes and bugs customers report most often.",
  },
  // --- Home office ---
  {
    key: "assembly",
    label: "Assembly",
    keywords: ["assembly", "assemble", "put together", "instructions were", "missing screws", "hard to build"],
    recommendation: "Improve the assembly instructions and part labeling based on the complaints.",
  },
  {
    key: "back-support",
    label: "Back support",
    keywords: ["lumbar", "back support", "supports my back", "posture", "back pain", "lower back"],
    recommendation: "Confirm the lumbar/back-support claims against long-sitting feedback.",
  },
  {
    key: "adjustability",
    label: "Adjustability",
    keywords: ["adjust", "adjustable", "armrest", "recline", "tilt", "height adjustment"],
    recommendation: "Review adjustability feedback for controls that fail or feel limited.",
  },
  {
    key: "material",
    label: "Material quality",
    keywords: ["material", "materials", "fabric", "mesh", "foam", "leather", "stitching", "upholstery"],
    recommendation: "Examine material feedback for wear, pilling, or quality concerns.",
  },
  {
    key: "value",
    label: "Value for money",
    keywords: ["value", "worth the money", "worth the price", "overpriced", "for the price", "great deal", "not worth"],
    recommendation: "Weigh the value complaints against the product's price positioning.",
  },
  // --- Personal care ---
  {
    key: "performance",
    label: "Performance",
    keywords: ["plaque", "my teeth", "cleaner teeth", "gums", "whiten", "dries my hair", "drying my hair", "frizz"],
    recommendation: "Read the performance reviews to confirm the core job is done well.",
  },
  {
    key: "attachments",
    label: "Attachments",
    keywords: ["attachment", "attachments", "brush head", "brush heads", "replacement head", "nozzle", "diffuser", "concentrator"],
    recommendation: "Check feedback on the included attachments and replacement availability.",
  },
  {
    key: "noise-level",
    label: "Noise level",
    keywords: ["too loud", "very loud", "so loud", "noisy", "quiet enough", "loud whine", "loud hum", "rattling noise"],
    recommendation: "Investigate noise complaints against comparable products.",
  },
  {
    key: "ease-of-use",
    label: "Ease of use",
    keywords: ["easy to use", "intuitive", "simple to use", "straightforward", "confusing to use", "hard to use"],
    recommendation: "Review ease-of-use feedback to smooth the most confusing interactions.",
  },
];

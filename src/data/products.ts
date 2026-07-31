import type { Product } from "../types";

/**
 * Mock catalog. Three products across distinct categories.
 *
 * These categories are flat, so each product's `topCategory` is its `category` —
 * the same identity the loader derives for any flat source.
 */
export const products: Product[] = [
  { id: "aurora-earbuds", name: "AuroraSound Wireless Earbuds", category: "Audio", topCategory: "Audio" },
  { id: "trailpeak-backpack", name: "TrailPeak 40L Hiking Backpack", category: "Outdoor", topCategory: "Outdoor" },
  { id: "brewmaster-espresso", name: "BrewMaster Pro Espresso Machine", category: "Kitchen", topCategory: "Kitchen" },
];

export function getProduct(productId: string): Product | undefined {
  return products.find((p) => p.id === productId);
}

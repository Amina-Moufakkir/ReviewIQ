import type { Product } from "../types";

/** Mock catalog. Three products across distinct categories. */
export const products: Product[] = [
  { id: "aurora-earbuds", name: "AuroraSound Wireless Earbuds", category: "Audio" },
  { id: "trailpeak-backpack", name: "TrailPeak 40L Hiking Backpack", category: "Outdoor" },
  { id: "brewmaster-espresso", name: "BrewMaster Pro Espresso Machine", category: "Kitchen" },
];

export function getProduct(productId: string): Product | undefined {
  return products.find((p) => p.id === productId);
}

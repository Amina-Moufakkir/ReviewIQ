import type { Dataset } from "../types";
import { products } from "./products";
import { reviews } from "./reviews";

/** The built-in sample dataset shown by default. */
export const sampleDataset: Dataset = {
  products,
  reviews,
  source: "sample",
  label: "Built-in sample",
};

# Test fixtures

## `amazon-mini.csv`

**Synthetic. Not real customer data.** Twelve invented product records in the
exact column shape of the generated Amazon fixture
(`public/amazon-products.csv`), so the adapter's behaviour can be tested and
demonstrated without the real dataset — which is not redistributed here (see
"Amazon dataset" in the root README).

Every product name, id and sentence in it was written for this repository. It
carries no reviewer ids or names, because the generator never writes those
columns.

It deliberately reproduces the real data's awkward parts:

| Row | What it exercises |
| --- | --- |
| 1–2 | The same `product_id` on two rows, with different prices and text |
| 1 | `₹`, thousands separators, `%`, and commas inside `review_content` |
| 4, 6 | Ratings below the 3.5 threshold, including one that rounds to 2 |
| 6 | Escaped `""` quotes inside a quoted field |
| 7 | A `3.5` rating, which rounds up to 4 |
| 9 | A blank `rating` → skipped as `invalid_rating` |
| 10 | A `\|` in the `rating` cell, the real dataset's one corrupt row → skipped |
| 11 | A blank `review_content` → skipped as `missing_review_text` |
| 12 | A blank `product_id` → skipped as `missing_product_id` |
| all | 3–5 level `\|` category hierarchies, decimal product-average ratings |

To run the app against it instead of the real dataset, copy it over the
generated fixture path:

```bash
cp src/test/fixtures/amazon-mini.csv public/amazon-products.csv
```

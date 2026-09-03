import { describe, expect, test } from "bun:test";
import { priceWithTariff, type Tier } from "./tariff";

describe("priceWithTariff", () => {
  const tiers: Tier[] = [
    { tier_order: 1, upper_bound: 10, rate_per_m3: 5 },
    { tier_order: 2, upper_bound: 20, rate_per_m3: 10 },
    { tier_order: 3, upper_bound: null, rate_per_m3: 20 },
  ];

  test("applies progressive slabs instead of one rate to all consumption", () => {
    expect(priceWithTariff(0, tiers, 25)).toBe(250);
  });

  test("includes the fixed fee", () => {
    expect(priceWithTariff(100, tiers, 5)).toBe(125);
  });

  test("never charges negative consumption", () => {
    expect(priceWithTariff(0, tiers, -5)).toBe(0);
  });
});

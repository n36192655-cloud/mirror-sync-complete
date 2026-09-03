import { expect, test } from "bun:test";
import { requiresStrongVisionEvidence } from "./meter-technology";

test("black-red registers always require strong visual evidence", () => {
  expect(requiresStrongVisionEvidence("mechanical_multi_jet", "black_red_register")).toBe(true);
  expect(requiresStrongVisionEvidence("mechanical_single_jet", "black_red_register")).toBe(true);
});

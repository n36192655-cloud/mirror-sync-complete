import { describe, expect, it } from "bun:test";
import { normalizeMeterTechnologyType, requiresStrongVisionEvidence } from "./meter-technology";

describe("meter technology", () => {
  it("normalizes common technology aliases", () => {
    expect(normalizeMeterTechnologyType("multi-jet")).toBe("mechanical_multi_jet");
    expect(normalizeMeterTechnologyType("Woltman")).toBe("mechanical_propeller_bulk");
    expect(normalizeMeterTechnologyType("prepaid smart")).toBe("prepaid_smart");
    expect(normalizeMeterTechnologyType("AMI")).toBe("smart_ami");
    expect(normalizeMeterTechnologyType("ultrasonic meter")).toBe("ultrasonic");
  });

  it("does not treat unknown model labels as proof of technology", () => {
    expect(normalizeMeterTechnologyType("R160")).toBe("unknown");
    expect(normalizeMeterTechnologyType("DN50")).toBe("unknown");
    expect(normalizeMeterTechnologyType("garbage")).toBe("unknown");
  });

  it("requires strong evidence for electronic and ambiguous display paths", () => {
    expect(requiresStrongVisionEvidence("prepaid_smart", "digital_lcd")).toBe(true);
    expect(requiresStrongVisionEvidence("ultrasonic", "digital_lcd")).toBe(true);
    expect(requiresStrongVisionEvidence("mechanical_multi_jet", "analog_dial")).toBe(true);
    expect(requiresStrongVisionEvidence("mechanical_single_jet", "mechanical_roller")).toBe(false);
  });
});

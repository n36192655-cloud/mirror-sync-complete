export type MeterTechnologyType =
  | "mechanical_multi_jet"
  | "mechanical_single_jet"
  | "mechanical_positive_displacement"
  | "mechanical_propeller_bulk"
  | "prepaid_smart"
  | "ultrasonic"
  | "electromagnetic"
  | "smart_ami"
  | "unknown";

const TECHNOLOGY_TYPES = new Set<MeterTechnologyType>([
  "mechanical_multi_jet",
  "mechanical_single_jet",
  "mechanical_positive_displacement",
  "mechanical_propeller_bulk",
  "prepaid_smart",
  "ultrasonic",
  "electromagnetic",
  "smart_ami",
  "unknown",
]);

export function normalizeMeterTechnologyType(value: unknown): MeterTechnologyType {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (TECHNOLOGY_TYPES.has(normalized as MeterTechnologyType)) {
    return normalized as MeterTechnologyType;
  }
  const aliases: Record<string, MeterTechnologyType> = {
    multi_jet: "mechanical_multi_jet",
    single_jet: "mechanical_single_jet",
    positive_displacement: "mechanical_positive_displacement",
    piston: "mechanical_positive_displacement",
    propeller: "mechanical_propeller_bulk",
    woltman: "mechanical_propeller_bulk",
    prepaid: "prepaid_smart",
    smart_prepaid: "prepaid_smart",
    ami: "smart_ami",
    amr: "smart_ami",
    electromagnetic_meter: "electromagnetic",
    ultrasonic_meter: "ultrasonic",
  };
  return aliases[normalized] ?? "unknown";
}

export function requiresStrongVisionEvidence(
  technology: MeterTechnologyType,
  displayType: string,
): boolean {
  return technology === "prepaid_smart"
    || technology === "ultrasonic"
    || technology === "electromagnetic"
    || technology === "smart_ami"
    || displayType === "analog_dial"
    || displayType === "multi_register"
    || displayType === "black_red_register"
    || displayType === "smart_display";
}

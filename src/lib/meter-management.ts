import { supabase } from "@/integrations/supabase/client";
import { mappedUuid } from "./id-map";
import type { MeterType } from "./pricing";

export async function assignMeter(input: {
  customerId: number;
  serial: string;
  meterType: MeterType;
  initialIndex: number;
}): Promise<void> {
  const { error } = await supabase.rpc("assign_meter", {
    _customer_id: mappedUuid("customer", input.customerId),
    _serial: input.serial,
    _meter_type: input.meterType,
    _initial_index: input.initialIndex,
  });
  if (error) throw new Error(error.message);
}

export async function replaceMeter(input: {
  customerId: number;
  serial: string;
  initialIndex: number;
}): Promise<void> {
  const { error } = await supabase.rpc("replace_meter", {
    _customer_id: mappedUuid("customer", input.customerId),
    _new_serial: input.serial,
    _new_initial_index: input.initialIndex,
    _reason: "استبدال العداد من إدارة المشتركين",
  });
  if (error) throw new Error(error.message);
}

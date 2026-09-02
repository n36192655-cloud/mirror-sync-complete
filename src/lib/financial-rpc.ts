import { supabase } from "@/integrations/supabase/client";
import type { PaymentMethod } from "./store";

export async function recordPayment(input: {
  billId: string;
  amount: number;
  method: PaymentMethod;
  clientUuid?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("record_payment", {
    _bill_id: input.billId,
    _amount: input.amount,
    _method: input.method,
    _client_uuid: input.clientUuid ?? null,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("تعذّر تسجيل الدفعة في قاعدة البيانات");
  return data as string;
}

export async function approvePayment(paymentId: string): Promise<void> {
  const { error } = await supabase.rpc("approve_payment", {
    _payment_id: paymentId,
  });
  if (error) throw new Error(error.message);
}

export async function rejectPayment(paymentId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc("reject_payment", {
    _payment_id: paymentId,
    _reason: reason ?? null,
  });
  if (error) throw new Error(error.message);
}

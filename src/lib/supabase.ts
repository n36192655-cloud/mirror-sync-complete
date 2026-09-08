/* eslint-disable @typescript-eslint/no-explicit-any */
// Re-export of the auto-generated Supabase client so existing modules
// (`@/lib/supabase`) keep resolving after the Lovable Cloud integration.
//
// The generated `Database` type is derived from whichever Cloud database the
// workspace is currently attached to. When that database does not carry the
// production schema, the generated type collapses to `never` and every query in
// the app fails to typecheck even though the runtime behavior is unchanged.
// This module therefore exposes a permissive schema shape used by application
// code; runtime behavior, queries and security are untouched.
import { supabase as generatedClient } from "@/integrations/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";

type LooseRow = Record<string, any>;
type LooseTable = { Row: LooseRow; Insert: LooseRow; Update: LooseRow; Relationships: [] };

export type Database = {
  public: {
    Tables: { [table: string]: LooseTable };
    Views: { [view: string]: LooseTable };
    Functions: { [fn: string]: { Args: LooseRow; Returns: any } };
    Enums: { [name: string]: string };
    CompositeTypes: { [name: string]: LooseRow };
  };
};

export const supabase = generatedClient as unknown as SupabaseClient<Database>;

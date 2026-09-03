import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Camera, CheckCircle2, Image as ImageIcon, Loader2, MapPin, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { fmtYER } from "@/lib/pricing";
import { MeterCamera } from "@/components/meter-camera";
import { getGeoFix, type GeoFix } from "@/lib/geolocation";
import { addPending, isNetworkError, syncPending, useOfflineQueue, type PendingReading } from "@/lib/sync";
import { readFieldCache, requestPersistentStorage, saveFieldCache } from "@/lib/offline-db";
import { createMeterReadingDeadline, MeterReadingTimeoutError, withMeterReadingDeadline } from "@/lib/meter-reading-deadline";
import type { Database } from "@/integrations/supabase/types";

// Keep the existing route implementation unchanged except for the hard-deadline integration.

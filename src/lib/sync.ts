import { useCallback, useEffect, useState } from "react";
import { useStore } from "./store";
import { supabase } from "./supabase";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";
import { STORE_BLOBS, STORE_QUEUE, idbDelete, idbGet, idbGetAll, idbPut, idbPutQueueWithPhoto, requestPersistentStorage } from "./offline-db";

type ReadingInsert = Database["public"]["Tables"]["water_readings"]["Insert"];
const PHOTO_BUCKET = "meter-readings";
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
export type QueueStatus = "pending" | "syncing" | "synced" | "failed";

export interface PendingReading {
  clientId: string; customerId: string; meterId: string; meterNumber: string; current: number;
  readingDate?: string; createdAt: string; by?: string; latitude?: number; longitude?: number;
  accuracy?: number; tenantId?: string; hasPhoto?: boolean; photoType?: string; photoPath?: string;
  status: QueueStatus; attempts: number; lastError?: string; lastAttemptAt?: string; syncedAt?: string;
}

const LEGACY_KEY = "mizan-pending-readings-v3";
const EVENT = "mizan-pending-updated";
function notify() { if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT)); }

async function migrateLegacy(): Promise<void> {
  if (typeof window === "undefined") return;
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(LEGACY_KEY); } catch { return; }
  if (!raw) return;
  try {
    const old = JSON.parse(raw) as Partial<PendingReading>[];
    for (const p of old) {
      if (!p?.clientId) continue;
      if (await idbGet<PendingReading>(STORE_QUEUE, p.clientId)) continue;
      await idbPut(STORE_QUEUE, { ...p, status: "pending", attempts: 0, createdAt: p.createdAt ?? new Date().toISOString() } as PendingReading);
    }
  } catch { /* ignore corrupt legacy data */ }
  try { window.localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
  notify();
}
let migrated: Promise<void> | null = null;
function ensureMigrated() { if (!migrated) migrated = migrateLegacy(); return migrated; }
export async function getPending() { await ensureMigrated(); const all = await idbGetAll<PendingReading>(STORE_QUEUE); return all.sort((a,b) => a.createdAt < b.createdAt ? -1 : 1); }
export function isUnsynced(p: PendingReading) { return p.status !== "synced"; }

function validatePhoto(blob: Blob) {
  if (!ALLOWED_IMAGE_TYPES.has(blob.type)) throw new Error("صيغة صورة العداد غير مدعومة. استخدم JPG أو PNG أو WebP.");
  if (blob.size <= 0 || blob.size > MAX_PHOTO_BYTES) throw new Error("حجم صورة العداد غير صالح أو كبير جداً.");
}
function extensionForType(type?: string) { return type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg"; }
function isUniqueViolation(error: { code?: string; message?: string } | null) { return error?.code === "23505"; }
function isClientUuidConflict(error: { code?: string; message?: string } | null) {
  if (!isUniqueViolation(error)) return false;
  const msg = (error?.message ?? "").toLowerCase();
  return msg.includes("client_uuid") || msg.includes("water_readings_client_uuid_uidx");
}
function isDailyMeterConflict(error: { code?: string; message?: string } | null) {
  if (!isUniqueViolation(error)) return false;
  const msg = (error?.message ?? "").toLowerCase();
  return msg.includes("one_per_meter_day") || msg.includes("tenant_id, meter_id, reading_date") || msg.includes("water_readings_one_per_meter_day_uidx");
}

export async function addPending(p: Omit<PendingReading,"clientId"|"createdAt"|"status"|"attempts"> & {clientId?: string}, photo: Blob) {
  await ensureMigrated(); void requestPersistentStorage();
  const clientId = p.clientId ?? crypto.randomUUID();
  validatePhoto(photo);
  const item: PendingReading = { ...p, clientId, createdAt: new Date().toISOString(), status: "pending", attempts: 0, hasPhoto: true, photoType: photo.type };
  await idbPutQueueWithPhoto(item, photo);
  notify(); return item;
}
export async function removePending(clientId: string) { await idbDelete(STORE_QUEUE, clientId); await idbDelete(STORE_BLOBS, clientId); notify(); }
export async function retryPending(clientId: string) { const item = await idbGet<PendingReading>(STORE_QUEUE, clientId); if (!item || item.status === "synced") return; await idbPut(STORE_QUEUE,{...item,status:"pending",lastError:undefined,lastAttemptAt:undefined}); notify(); await syncPending(true); }
export async function getPendingPhoto(clientId: string) { return idbGet<Blob>(STORE_BLOBS, clientId); }
async function setStatus(item: PendingReading, patch: Partial<PendingReading>) { await idbPut(STORE_QUEUE,{...item,...patch}); notify(); }
function readyForRetry(p: PendingReading) { if (p.status === "synced") return false; if (p.status !== "failed" || !p.lastAttemptAt) return true; const wait=Math.min(15*60_000,30_000*2**Math.min(p.attempts,5)); return Date.now()-+new Date(p.lastAttemptAt)>=wait; }
export function isNetworkError(e: unknown) { if (typeof navigator!=="undefined"&&!navigator.onLine) return true; const msg=(e instanceof Error?e.message:String(e??"")).toLowerCase(); return e instanceof TypeError||msg.includes("failed to fetch")||msg.includes("network")||msg.includes("networkerror")||msg.includes("load failed")||msg.includes("timeout")||msg.includes("aborted"); }

let syncing = false;
export async function syncPending(force=false): Promise<{synced:number;failed:number}> {
  if (syncing) return {synced:0,failed:0};
  if (typeof navigator!=="undefined"&&!navigator.onLine) return {synced:0,failed:0};
  syncing=true;
  try {
    const list=(await getPending()).filter(p=>isUnsynced(p)&&(force||readyForRetry(p))); if(!list.length)return{synced:0,failed:0};
    let synced=0,failed=0;
    for(const p of list){
      await setStatus(p,{status:"syncing"}); let photoPath=p.photoPath??null;
      try{
        const {data:tenantRow,error:tenantError}=await supabase.rpc("current_tenant_id");
        if(tenantError)throw new Error(`تعذّر تحديد المؤسسة الحالية: ${tenantError.message}`);
        const tenantId=p.tenantId??(tenantRow as unknown as string|null); if(!tenantId)throw new Error("تعذّر تحديد المؤسسة الحالية");
        if(!photoPath){
          if(!p.hasPhoto)throw new Error("هذه القراءة المحلية لا تحتوي على صورة أصلية؛ لا يمكن مزامنتها بأمان.");
          const blob=await getPendingPhoto(p.clientId); if(!blob)throw new Error("صورة القراءة غير موجودة في التخزين المحلي؛ لا يمكن مزامنة القراءة بأمان.");
          validatePhoto(blob);
          const path=`tenants/${tenantId}/readings/${p.clientId}.${extensionForType(blob.type)}`;
          const up=await supabase.storage.from(PHOTO_BUCKET).upload(path,blob,{contentType:blob.type,upsert:true,cacheControl:"31536000"});
          if(up.error)throw new Error(`رفع الصورة فشل: ${up.error.message}`);
          photoPath=path; await setStatus(p,{status:"syncing",photoPath});
        }
        const {error}=await supabase.from("water_readings").insert({tenant_id:tenantId,customer_id:p.customerId,meter_id:p.meterId,current_reading:p.current,reading_date:p.readingDate,client_uuid:p.clientId,reader_id:p.by,photo_url:photoPath,lat:p.latitude??null,lng:p.longitude??null,accuracy:p.accuracy??null,gps_verified:p.latitude!=null} as ReadingInsert);
        if(error&&isDailyMeterConflict(error)&&!isClientUuidConflict(error)){
          if(photoPath) await supabase.storage.from(PHOTO_BUCKET).remove([photoPath]).catch(()=>undefined);
          throw new Error("هذه القراءة لم تُزامن: يوجد بالفعل تسجيل ناجح لهذا العداد في نفس اليوم.");
        }
        if(error&&!isClientUuidConflict(error)){
          if(photoPath) await supabase.storage.from(PHOTO_BUCKET).remove([photoPath]).catch(()=>undefined);
          throw new Error(error.message);
        }
        await setStatus(p,{status:"synced",photoPath:photoPath??undefined,syncedAt:new Date().toISOString(),lastError:undefined});
        await idbDelete(STORE_BLOBS,p.clientId); synced++;
        void broadcastTenantEvent(tenantId,"reading",{customerId:p.customerId,meterNumber:p.meterNumber,current:p.current,by:p.by,at:new Date().toISOString()});
      }catch(e){ failed++; const message=e instanceof Error?e.message:String(e); await setStatus(p,{status:"failed",attempts:p.attempts+1,lastAttemptAt:new Date().toISOString(),lastError:message,photoPath:photoPath??p.photoPath}); }
    }
    await pruneSynced();
    if(synced>0)void useStore.getState().hydrateFromSupabase().catch(err=>console.warn("[Mizan] hydrate after sync failed (offline data kept):",err));
    return{synced,failed};
  }finally{syncing=false;}
}
async function pruneSynced(){const all=await idbGetAll<PendingReading>(STORE_QUEUE);const cutoff=Date.now()-24*60*60_000;for(const p of all)if(p.status==="synced"&&p.syncedAt&&+new Date(p.syncedAt)<cutoff)await removePending(p.clientId);}

export type TenantEventType="reading"|"bill"|"payment";
export async function broadcastTenantEvent(tenantId:string,type:TenantEventType,payload:Record<string,unknown>){try{const channel=supabase.channel(`tenant:${tenantId}`);await channel.subscribe();await channel.send({type:"broadcast",event:type,payload});await supabase.removeChannel(channel);}catch(err){console.warn("[Mizan] broadcast failed:",err);}}
export function subscribeToTenantEvents(tenantId:string,onEvent:(type:TenantEventType,payload:Record<string,unknown>)=>void){const channel=supabase.channel(`tenant:${tenantId}`);(["reading","bill","payment"] as const).forEach(event=>channel.on("broadcast",{event},msg=>onEvent(event,(msg.payload??{}) as Record<string,unknown>)));channel.subscribe();return()=>{void supabase.removeChannel(channel);};}

export function useOnlineStatus(){
  const[online,setOnline]=useState(typeof navigator!=="undefined"?navigator.onLine:true);
  useEffect(()=>{
    const on=()=>{setOnline(true);setTimeout(()=>{void syncPending(true).then(r=>{if(r.synced>0)toast.success(`تمت مزامنة ${r.synced} قراءة مؤجلة`);});},1000);};
    const off=()=>setOnline(false);
    const retry=()=>{if(!navigator.onLine)return;setOnline(true);void syncPending().then(r=>{if(r.synced>0)toast.success(`تمت مزامنة ${r.synced} قراءة مؤجلة`);});};
    const onVisible=()=>{if(document.visibilityState==="visible")retry();};
    window.addEventListener("online",on);window.addEventListener("offline",off);document.addEventListener("visibilitychange",onVisible);window.addEventListener("focus",retry);const timer=setInterval(retry,60_000);
    return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);document.removeEventListener("visibilitychange",onVisible);window.removeEventListener("focus",retry);clearInterval(timer);};
  },[]);return online;
}
export function useOfflineQueue(){const[items,setItems]=useState<PendingReading[]>([]);const refresh=useCallback(()=>{void getPending().then(setItems);},[]);useEffect(()=>{refresh();window.addEventListener(EVENT,refresh);window.addEventListener("storage",refresh);const t=setInterval(refresh,5000);return()=>{window.removeEventListener(EVENT,refresh);window.removeEventListener("storage",refresh);clearInterval(t);};},[refresh]);return{items,refresh};}
export function usePendingCount(){const{items}=useOfflineQueue();return items.filter(isUnsynced).length;}

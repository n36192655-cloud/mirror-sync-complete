import { useCallback, useEffect, useState } from "react";
import { useStore } from "./store";
import { supabase } from "./supabase";
import { toast } from "sonner";
import { STORE_BLOBS, STORE_QUEUE, idbDelete, idbGet, idbGetAll, idbPut, idbPutQueueWithPhoto, requestPersistentStorage } from "./offline-db";
import { verifyMeterImage, saveVerifiedMeterReading } from "./meter-vision.functions";
import { fileToDataUrl } from "./meter-ocr";

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
function localDateFromCreatedAt(createdAt: string) { return /^\d{4}-\d{2}-\d{2}T/.test(createdAt) ? createdAt.slice(0, 10) : ""; }
function numericEqual(a: number, b: number) { return Number.isFinite(a) && Number.isFinite(b) && Object.is(a, b); }

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
        if(!p.hasPhoto)throw new Error("هذه القراءة المحلية لا تحتوي على صورة أصلية؛ لا يمكن مزامنتها بأمان.");
        const blob=await getPendingPhoto(p.clientId); if(!blob)throw new Error("صورة القراءة غير موجودة في التخزين المحلي؛ لا يمكن مزامنة القراءة بأمان.");
        validatePhoto(blob);
        const readingDate=p.readingDate??localDateFromCreatedAt(p.createdAt); if(!readingDate)throw new Error("تاريخ القراءة المحلي غير صالح؛ لا يمكن مزامنة القراءة بأمان.");
        const originalImageDataUrl=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error??new Error("تعذر قراءة الصورة الأصلية"));reader.readAsDataURL(blob);});
        const imageDataUrl=await fileToDataUrl(blob);
        const verified=await verifyMeterImage({data:{imageDataUrl,originalImageDataUrl,meterId:p.meterId,customerId:p.customerId,readingDate,clientUuid:p.clientId}});
        if(verified.serialMatch!=="match"||verified.meterNumber==null)throw new Error("رفضت المزامنة: هوية العداد في الصورة لا تطابق العداد المرتبط.");
        if(verified.readingValue==null||verified.ambiguous)throw new Error("رفضت المزامنة: تعذر استخراج قراءة واضحة من الصورة الأصلية.");
        if(!numericEqual(verified.readingValue,p.current))throw new Error(`رفضت المزامنة: القراءة المحلية (${p.current}) لا تطابق القراءة التي تحقق منها الخادم (${verified.readingValue}).`);
        if(!verified.verificationToken)throw new Error("رفضت المزامنة: لم يصدر إثبات تحقق صالح.");
        const saved=await saveVerifiedMeterReading({data:{originalImageDataUrl,verificationToken:verified.verificationToken,latitude:p.latitude??null,longitude:p.longitude??null,gpsVerified:p.latitude!=null}});
        if(!saved.saved||!saved.readingId)throw new Error("لم يؤكد الخادم حفظ القراءة.");
        photoPath=saved.evidencePath;
        await setStatus(p,{status:"synced",photoPath:photoPath??undefined,syncedAt:new Date().toISOString(),lastError:undefined});
        await idbDelete(STORE_BLOBS,p.clientId); synced++;
        const tenantId=p.tenantId; if(tenantId)void broadcastTenantEvent(tenantId,"reading",{customerId:p.customerId,meterNumber:p.meterNumber,current:saved.readingValue,by:p.by,at:new Date().toISOString()});
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

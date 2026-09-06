// ============================================================
// Supabase Edge Function: chat-notify
// ยิง Web Push แจ้งข้อความแชทสาขาไปยัง "อีกฝ่าย" (เด้งแม้ปิดแอป)
//   ข้อความจาก HR/นิดา → เครื่องของ ผจก. สาขานั้น (push_subscriptions.branch_id = สาขา)
//   ข้อความจาก ผจก.    → เครื่อง HR ส่วนกลาง (branch_id IS NULL)
// กันส่งซ้ำด้วย mgr_chat.notified · เรียกแบบ fire-and-forget หลังส่งข้อความ (ไม่ต้องใส่ id)
// Deploy: supabase functions deploy chat-notify --no-verify-jwt
// ใช้ VAPID เดิม (VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:hr@7eleven.local";
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // ข้อความที่ยังไม่ได้แจ้ง (รวมกรณีบรอดแคสต์หลายแถว)
    const { data: msgsRaw } = await sb.from("mgr_chat").select("id,branch_id,sender_role,sender_name,text,photos,created_at")
      .eq("notified", false).order("created_at", { ascending: true }).limit(30);
    const msgs = msgsRaw ?? [];

    const [subsR, brR] = await Promise.all([
      sb.from("push_subscriptions").select("*"),
      sb.from("branches").select("branch_id,name"),
    ]);
    const subs = subsR.data ?? [];
    const brName: Record<string, string> = {}; (brR.data ?? []).forEach((b: any) => (brName[b.branch_id] = b.name));
    // เครื่องที่ล็อกอินหน้า HR/ผจก. (ไม่มี emp_id)
    const hrDevices  = subs.filter((s: any) => !s.emp_id && !s.branch_id);                      // ส่วนกลาง
    const brDevices  = (br: string) => subs.filter((s: any) => !s.emp_id && s.branch_id === br); // เครื่อง ผจก.สาขานั้น

    const gone: string[] = [];
    let sent = 0;
    for (const m of msgs) {
      const fromBranch = m.sender_role === "mgr";
      const targets = fromBranch ? hrDevices : brDevices(m.branch_id);
      const bName = brName[m.branch_id] || m.branch_id || "สาขา";
      const title = fromBranch
        ? ("💬 " + bName + " · " + (m.sender_name || "ผจก."))
        : (m.sender_role === "nida" ? "💬 นิดา · ผู้ช่วยฝ่ายบริหาร / HR" : "💬 ข้อความจาก HR");
      const body = (m.text || "").slice(0, 120) || (Array.isArray(m.photos) && m.photos.length ? "ส่งรูป " + m.photos.length + " รูป" : "ข้อความใหม่");
      const payload = JSON.stringify({ title, body, url: "./hr/", tag: "mgrchat:" + (fromBranch ? "hr" : m.branch_id) });

      await Promise.all(targets.map(async (s: any) => {
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); sent++; }
        catch (err: any) { const c = err?.statusCode; if (c === 404 || c === 410) gone.push(s.endpoint); }
      }));
      await sb.from("mgr_chat").update({ notified: true }).eq("id", m.id);
    }
    // ---- แชท ผจก. ↔ ผจก. (1:1 ข้ามสาขา) → push เข้าเครื่อง ผจก.สาขาปลายทาง ----
    let peerSent = 0;
    const { data: pmsgs } = await sb.from("mgr_peer_chat").select("id,from_branch,to_branch,sender_name,text,photos")
      .eq("notified", false).order("created_at", { ascending: true }).limit(30);
    for (const m of (pmsgs ?? [])) {
      const targets = brDevices(m.to_branch);
      const title = "💬 " + (m.sender_name || ("ผจก. " + (brName[m.from_branch] || m.from_branch)));
      const body = (m.text || "").slice(0, 120) || (Array.isArray(m.photos) && m.photos.length ? "ส่งรูป " + m.photos.length + " รูป" : "ข้อความใหม่");
      const payload = JSON.stringify({ title, body, url: "./hr/", tag: "peerchat:" + m.from_branch });
      await Promise.all(targets.map(async (s: any) => {
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); peerSent++; }
        catch (err: any) { const c = err?.statusCode; if (c === 404 || c === 410) gone.push(s.endpoint); }
      }));
      await sb.from("mgr_peer_chat").update({ notified: true }).eq("id", m.id);
    }

    if (gone.length) { try { await sb.from("push_subscriptions").delete().in("endpoint", gone); } catch (_e) { /* ข้าม */ } }
    return json({ ok: true, sent, peer_sent: peerSent, messages: msgs.length });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});

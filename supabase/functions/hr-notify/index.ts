// ============================================================
// Supabase Edge Function: hr-notify
// คำนวณเหตุการณ์ที่ HR ควรรู้ (ขาด/สาย/ลืมเช็กเอาต์/ใบลา/ข้อมูลรอตรวจ)
// แล้วส่ง Web Push ไปยังอุปกรณ์ HR ทุกเครื่องที่สมัครไว้ — กันส่งซ้ำด้วยตาราง notify_sent
// เรียกโดย cron ทุก ~15 นาที (ดู supabase/push_cron.sql)
// Deploy: supabase functions deploy hr-notify --no-verify-jwt
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// ค่าที่ Supabase ใส่ให้อัตโนมัติใน Edge runtime
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// ค่าที่ต้องตั้งเอง (supabase secrets set ...)
const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:hr@7eleven.local";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const bkk = () => new Date(Date.now() + 7 * 3600 * 1000);          // เวลาไทย
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

Deno.serve(async () => {
  try {
    const today = isoDate(bkk());
    const nowHM = bkk().toISOString().slice(11, 16);

    const [subsR, empR, leavesR, attR, schR, shR, lvApprR, profR, hoR] = await Promise.all([
      sb.from("push_subscriptions").select("*"),
      sb.from("employees").select("emp_id,name").eq("active", true),
      sb.from("leaves").select("leave_id,emp_id,type,start_date,end_date").eq("status", "pending"),
      sb.from("attendance").select("emp_id,check_in,check_out,late_min").eq("work_date", today),
      sb.from("schedules").select("emp_id,shift_id").eq("work_date", today),
      sb.from("shifts").select("shift_id,name,start_time"),
      sb.from("leaves").select("emp_id,start_date,end_date").eq("status", "approved").lte("start_date", today),
      sb.from("profile_submissions").select("id,emp_id,name").eq("status", "pending"),
      sb.from("handovers").select("id,branch_id,from_name,to_name,status,receiver_note").eq("work_date", today).in("status", ["no_handover", "rejected"]),
    ]);

    const subs = subsR.data ?? [];
    if (!subs.length) return json({ ok: true, note: "no subscriptions" });

    const empName: Record<string, string> = {};
    (empR.data ?? []).forEach((e: any) => (empName[e.emp_id] = e.name));
    const att = attR.data ?? [];
    const checkedIn = new Set(att.filter((a: any) => a.check_in).map((a: any) => a.emp_id));
    const onleave = new Set((lvApprR.data ?? []).filter((l: any) => today <= (l.end_date || l.start_date)).map((l: any) => l.emp_id));
    const shiftStart: Record<string, string> = {}, shiftName: Record<string, string> = {};
    (shR.data ?? []).forEach((s: any) => { shiftStart[s.shift_id] = String(s.start_time || "").slice(0, 5); shiftName[s.shift_id] = s.name; });

    const events: { key: string; text: string }[] = [];
    (leavesR.data ?? []).forEach((l: any) => events.push({ key: `leave:${l.leave_id}`, text: `ใบลาใหม่: ${empName[l.emp_id] || l.emp_id} (${l.type || "ลา"})` }));
    (profR.data ?? []).forEach((p: any) => events.push({ key: `profile:${p.id}`, text: `ข้อมูลรอตรวจ: ${p.name || empName[p.emp_id] || p.emp_id}` }));
    (hoR?.data ?? []).forEach((h: any) => {
      if (h.status === "no_handover") events.push({ key: `ho:${h.id}`, text: `ไม่มีการส่งผลัด สาขา ${h.branch_id || "?"} (แจ้งโดย ${h.to_name || "-"})` });
      else if (h.status === "rejected") events.push({ key: `ho:${h.id}`, text: `รับผลัดไม่เรียบร้อย สาขา ${h.branch_id || "?"}: ${h.receiver_note || ""}` });
    });
    att.filter((a: any) => a.check_in && !a.check_out).forEach((a: any) => events.push({ key: `nocheckout:${a.emp_id}:${today}`, text: `ยังไม่เช็กเอาต์: ${empName[a.emp_id] || a.emp_id}` }));
    att.filter((a: any) => a.late_min > 0).forEach((a: any) => events.push({ key: `late:${a.emp_id}:${today}`, text: `มาสาย ${a.late_min} นาที: ${empName[a.emp_id] || a.emp_id}` }));
    (schR.data ?? []).forEach((s: any) => {
      if (checkedIn.has(s.emp_id) || onleave.has(s.emp_id)) return;
      const st = shiftStart[s.shift_id];
      if (!st || nowHM < st) return;                 // เตือนเฉพาะกะที่ถึงเวลาเข้างานแล้ว
      events.push({ key: `absent:${s.emp_id}:${today}:${s.shift_id}`, text: `ขาด/ยังไม่มา: ${empName[s.emp_id] || s.emp_id} (${shiftName[s.shift_id] || s.shift_id})` });
    });

    if (!events.length) return json({ ok: true, new: 0 });

    // กรองเหตุการณ์ที่เคยส่งแล้ว
    const keys = events.map((e) => e.key);
    const sentR = await sb.from("notify_sent").select("event_key").in("event_key", keys);
    const sent = new Set((sentR.data ?? []).map((r: any) => r.event_key));
    const fresh = events.filter((e) => !sent.has(e.key));
    if (!fresh.length) return json({ ok: true, new: 0 });

    // รวมเป็นแจ้งเตือนเดียว (ไม่รก)
    const top = fresh.slice(0, 6).map((e) => "• " + e.text).join("\n");
    const more = fresh.length > 6 ? `\n…และอีก ${fresh.length - 6} รายการ` : "";
    const payload = JSON.stringify({ title: `แจ้งเตือน HR (${fresh.length})`, body: top + more, url: "./hr/", tag: "hr-notify" });

    let okCount = 0; const gone: string[] = [];
    await Promise.all(subs.map(async (s: any) => {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); okCount++; }
      catch (err: any) { const c = err?.statusCode; if (c === 404 || c === 410) gone.push(s.endpoint); }
    }));
    if (gone.length) await sb.from("push_subscriptions").delete().in("endpoint", gone);

    await sb.from("notify_sent").upsert(fresh.map((e) => ({ event_key: e.key })), { onConflict: "event_key" });
    const cutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    await sb.from("notify_sent").delete().lt("sent_at", cutoff);   // ล้างของเก่า > 7 วัน

    return json({ ok: true, new: fresh.length, sent: okCount, removed: gone.length });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

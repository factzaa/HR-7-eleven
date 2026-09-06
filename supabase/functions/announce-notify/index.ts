// ============================================================
// Supabase Edge Function: announce-notify
// ระบบ "ตามให้พนักงานรับทราบประกาศ"
//
//   ด่านที่ 0 (ทันทีที่ประกาศ) → Web Push ถึงเครื่องพนักงานทุกคนที่เข้าข่าย
//   ด่านที่ 1 (ครึ่งหนึ่งของกำหนด) → push ซ้ำเฉพาะคนที่ยังไม่รับทราบ
//   ด่านที่ 2 (ครบกำหนด)        → แจ้ง ผจก.สาขา (emp_notifications + push เครื่องสาขา) พร้อมรายชื่อ
//   ด่านที่ 3 (2 เท่าของกำหนด)  → ส่งข้อความระบุชื่อเข้ากลุ่ม LINE ของสาขา
//   กำหนดต่อประกาศ = announcements.ack_deadline_h (ค่าเริ่มต้น 24 ชม. → 12/24/48 เหมือนเดิม)
//
// กันส่งซ้ำด้วยตาราง announcement_reminders (unique: ann_id + emp_id + stage)
// เรียกได้ 2 ทาง: (1) HR กดประกาศ → ยิงทันที  (2) cron ทุก 1-2 ชม.
// Deploy: supabase functions deploy announce-notify --no-verify-jwt
// secrets: VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT / LINE_CHANNEL_TOKEN
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:hr@7eleven.local";
const LINE_TOKEN    = Deno.env.get("LINE_CHANNEL_TOKEN") ?? "";
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const bkkToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const hoursSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3600000;

async function linePush(groupId: string, text: string) {
  if (!LINE_TOKEN || !groupId) return false;
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + LINE_TOKEN },
      body: JSON.stringify({ to: groupId, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
    });
    return r.ok;
  } catch (_e) { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const today = bkkToday();

    // ประกาศที่ยังต้องรับทราบ (important / mandatory) และยังไม่หมดอายุ
    const { data: annsRaw } = await sb.from("announcements")
      .select("id,title,message,priority,branch_ids,created_at,expire_date,active,ack_deadline_h")
      .eq("active", true).in("priority", ["important", "mandatory"]);
    const anns = (annsRaw ?? []).filter((a: any) => !a.expire_date || String(a.expire_date) >= today);
    if (!anns.length) return json({ ok: true, note: "no announcements pending ack" });

    const [{ data: empsRaw }, { data: brs }, { data: subs }] = await Promise.all([
      sb.from("employees").select("emp_id,name,nickname,branch_id,active,end_date,is_manager").eq("active", true),
      sb.from("branches").select("branch_id,name,line_group_id"),
      sb.from("push_subscriptions").select("*"),
    ]);
    const emps = (empsRaw ?? []).filter((e: any) => !(e.end_date && String(e.end_date) < today));
    const bMap: Record<string, any> = {}; (brs ?? []).forEach((b: any) => (bMap[String(b.branch_id)] = b));

    const subsByEmp: Record<string, any[]> = {};
    const subsByBranch: Record<string, any[]> = {};              // เครื่องประจำสาขา (kind='branch') + เครื่อง ผจก.
    (subs ?? []).forEach((s: any) => {
      if (s.emp_id) (subsByEmp[String(s.emp_id)] = subsByEmp[String(s.emp_id)] || []).push(s);
      else if (s.branch_id) (subsByBranch[String(s.branch_id)] = subsByBranch[String(s.branch_id)] || []).push(s);
    });

    const gone: string[] = [];
    let pushed = 0, notified = 0, lined = 0;
    const push = async (list: any[], title: string, body: string, tag: string, url = "./handover/") => {
      if (!list || !list.length) return;
      const payload = JSON.stringify({ title, body, url, tag });
      await Promise.all(list.map(async (s: any) => {
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); pushed++; }
        catch (err: any) { const c = err?.statusCode; if (c === 404 || c === 410) gone.push(s.endpoint); }
      }));
    };

    // กันส่งซ้ำ — โหลดสิ่งที่เตือนไปแล้วทั้งหมดของประกาศชุดนี้
    const annIds = anns.map((a: any) => a.id);
    const [{ data: acks }, { data: rems }] = await Promise.all([
      sb.from("announcement_acks").select("ann_id,emp_id,acked_at").in("ann_id", annIds),
      sb.from("announcement_reminders").select("ann_id,emp_id,stage").in("ann_id", annIds),
    ]);
    const ackedKey = new Set((acks ?? []).filter((a: any) => a.acked_at).map((a: any) => a.ann_id + "|" + a.emp_id));
    const remKey   = new Set((rems ?? []).map((r: any) => r.ann_id + "|" + (r.emp_id ?? "-") + "|" + r.stage));
    const newRems: any[] = [];
    const mark = (ann_id: number, emp_id: string | null, branch_id: string | null, stage: number, channel: string) => {
      const k = ann_id + "|" + (emp_id ?? "-") + "|" + stage;
      if (remKey.has(k)) return false;
      remKey.add(k);
      newRems.push({ ann_id, emp_id, branch_id, stage, channel });
      return true;
    };

    for (const a of anns) {
      const scope: string[] = Array.isArray(a.branch_ids) ? a.branch_ids.map(String) : [];
      const targets = scope.length ? emps.filter((e: any) => scope.includes(String(e.branch_id))) : emps;
      const pending = targets.filter((e: any) => !ackedKey.has(a.id + "|" + e.emp_id));
      if (!pending.length) continue;

      const age = hoursSince(a.created_at);
      // ★ ตารางเร่งเตือนอิง ack_deadline_h ที่ตั้งไว้จริง — เดิมฝัง 12/24/48 ตายตัว ค่าที่ตั้งไม่มีผลเลยสักนิด
      //   ค่าเริ่มต้น 24 ชม. → ได้ 12/24/48 เท่าพฤติกรรมเดิมเป๊ะ · ตั้ง 4 ชม. → ได้ 2/4/8
      const _dl = Number(a.ack_deadline_h) > 0 ? Number(a.ack_deadline_h) : 24;
      const _st1 = _dl / 2, _st2 = _dl, _st3 = _dl * 2;
      const head = a.priority === "mandatory" ? "🔴 ประกาศบังคับ" : "🟠 ประกาศสำคัญ";
      const label = a.title || String(a.message || "").slice(0, 60);

      // ---------- ด่าน 0: push ครั้งแรก (ทันทีที่ประกาศ) ----------
      for (const e of pending) {
        if (mark(a.id, String(e.emp_id), e.branch_id ? String(e.branch_id) : null, 0, "push")) {
          await push(subsByEmp[String(e.emp_id)], head, label + " — เปิดหน้ารับส่งผลัดเพื่อกดรับทราบ", "ann:" + a.id + ":0");
        }
      }

      // ---------- ด่าน 1: ครบ 12 ชม. → push ซ้ำ ----------
      if (age >= _st1) {
        for (const e of pending) {
          if (mark(a.id, String(e.emp_id), e.branch_id ? String(e.branch_id) : null, 1, "push")) {
            await push(subsByEmp[String(e.emp_id)], "⏰ ยังไม่ได้กดรับทราบ", label + " — กรุณากดรับทราบในหน้ารับส่งผลัด", "ann:" + a.id + ":1");
          }
        }
      }

      // ---------- ด่าน 2: ครบ 24 ชม. → แจ้ง ผจก.สาขา ----------
      if (age >= _st2) {
        const byBranch: Record<string, any[]> = {};
        pending.forEach((e: any) => { const k = String(e.branch_id || "-"); (byBranch[k] = byBranch[k] || []).push(e); });
        for (const bid of Object.keys(byBranch)) {
          const list = byBranch[bid];
          const names = list.map((e: any) => e.nickname || e.name).join(", ");
          const brName = bMap[bid]?.name || bid;
          // แจ้ง ผจก.สาขานั้นเป็นรายบุคคล (กล่องแจ้งเตือน + push)
          const mgrs = emps.filter((e: any) => e.is_manager && String(e.branch_id) === bid);
          for (const m of mgrs) {
            if (mark(a.id, "MGR:" + m.emp_id, bid, 2, "notif")) {
              await sb.from("emp_notifications").insert({
                emp_id: m.emp_id, kind: "info",
                title: "ยังไม่รับทราบประกาศ (" + list.length + " คน)",
                body: label + "\nสาขา " + brName + ": " + names,
                ref: "ann:" + a.id, created_by: "ระบบ",
              });
              notified++;
              await push(subsByEmp[String(m.emp_id)], "⚠️ ลูกน้องยังไม่รับทราบประกาศ", brName + ": " + names, "ann:" + a.id + ":2", "./hr/");
            }
          }
          // push เข้าเครื่องประจำสาขาด้วย
          if (mark(a.id, "BR:" + bid, bid, 2, "push")) {
            await push(subsByBranch[bid], "⚠️ ยังไม่รับทราบประกาศ " + list.length + " คน", label + " — " + names, "ann:" + a.id + ":2b", "./hr/");
          }
        }
      }

      // ---------- ด่าน 3: ครบ 48 ชม. → เข้ากลุ่ม LINE สาขา ----------
      if (age >= _st3) {
        const byBranch: Record<string, any[]> = {};
        pending.forEach((e: any) => { const k = String(e.branch_id || "-"); (byBranch[k] = byBranch[k] || []).push(e); });
        for (const bid of Object.keys(byBranch)) {
          const br = bMap[bid];
          if (!br?.line_group_id) continue;
          if (!mark(a.id, "LINE:" + bid, bid, 3, "line")) continue;
          const list = byBranch[bid];
          const txt = "⚠️ ยังไม่ได้กดรับทราบประกาศ (เกิน " + Math.round(_st3) + " ชม.)\n"
            + "📢 " + label + "\n"
            + "สาขา " + (br.name || bid) + " · ค้าง " + list.length + " คน\n"
            + list.map((e: any, i: number) => (i + 1) + ". " + (e.nickname || e.name) + " (" + e.emp_id + ")").join("\n")
            + "\n\nกรุณาเปิดหน้ารับส่งผลัดแล้วกดรับทราบ";
          if (await linePush(br.line_group_id, txt)) lined++;
        }
      }
    }

    if (newRems.length) await sb.from("announcement_reminders").upsert(newRems, { onConflict: "ann_id,emp_id,stage", ignoreDuplicates: true });
    if (gone.length) { try { await sb.from("push_subscriptions").delete().in("endpoint", gone); } catch (_e) { /* ข้าม */ } }

    return json({ ok: true, announcements: anns.length, pushed, notified, lined, reminders: newRems.length });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});

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
const fmtThai = (dt: string) => { try { return new Date(dt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " น."; } catch { return String(dt); } };
const fmtThaiDate = (d: string) => { try { return new Date(d + "T00:00:00Z").toLocaleDateString("th-TH", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }); } catch { return String(d); } };

Deno.serve(async () => {
  try {
    const today = isoDate(bkk());
    const nowHM = bkk().toISOString().slice(11, 16);

    const [subsR, empR, leavesR, attR, schR, shR, lvApprR, profR, hoR, annR, setR] = await Promise.all([
      sb.from("push_subscriptions").select("*"),
      sb.from("employees").select("emp_id,name,end_date").eq("active", true),
      sb.from("leaves").select("leave_id,emp_id,type,start_date,end_date").eq("status", "pending"),
      sb.from("attendance").select("emp_id,check_in,check_out,late_min,shift_id,branch_id,extend_until").eq("work_date", today),
      sb.from("schedules").select("emp_id,shift_id,branch_id").eq("work_date", today),
      sb.from("shifts").select("shift_id,name,start_time,end_time"),
      sb.from("leaves").select("emp_id,start_date,end_date").eq("status", "approved").lte("start_date", today),
      sb.from("profile_submissions").select("id,emp_id,name").eq("status", "pending"),
      sb.from("handovers").select("id,branch_id,from_name,to_name,status,receiver_note").eq("work_date", today).in("status", ["no_handover", "rejected"]),
      sb.from("announcements").select("id,message,active,expire_date").eq("active", true),
      sb.from("app_settings").select("key,value"),
    ]);

    const subs = subsR.data ?? [];
    if (!subs.length) return json({ ok: true, note: "no subscriptions" });

    const empName: Record<string, string> = {};
    (empR.data ?? []).forEach((e: any) => (empName[e.emp_id] = e.name));
    const activeSet = new Set((empR.data ?? []).filter((e: any) => !(e.end_date && String(e.end_date) < today)).map((e: any) => e.emp_id));   // active และยังไม่สิ้นสุดการทำงาน
    const att = attR.data ?? [];
    const checkedIn = new Set(att.filter((a: any) => a.check_in).map((a: any) => a.emp_id));
    const onleave = new Set((lvApprR.data ?? []).filter((l: any) => today <= (l.end_date || l.start_date)).map((l: any) => l.emp_id));
    const shiftStart: Record<string, string> = {}, shiftEnd: Record<string, string> = {}, shiftName: Record<string, string> = {};
    (shR.data ?? []).forEach((s: any) => { shiftStart[s.shift_id] = String(s.start_time || "").slice(0, 5); shiftEnd[s.shift_id] = String(s.end_time || "").slice(0, 5); shiftName[s.shift_id] = s.name; });
    const settings: Record<string, string> = {}; (setR?.data ?? []).forEach((s: any) => { settings[s.key] = s.value; });
    const coGrace = isNaN(Number(settings["checkout_grace_min"])) ? 15 : Number(settings["checkout_grace_min"]);
    const hmToMin = (hm: string) => { const p = String(hm || "").split(":"); return (parseInt(p[0]) || 0) * 60 + (parseInt(p[1]) || 0); };
    const nowMin = hmToMin(nowHM);
    const addDaysStr = (s: string, n: number) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    // "ลืมกดออก" แล้วหรือยัง — รองรับกะข้ามคืน (deadline ของกะดึกตกวันถัดไป)
    const coOverdue = (workDate: string, st: string, en: string) => {
      if (!en) return false;
      const overnight = !!st && en <= st;
      const deadlineDate = overnight ? addDaysStr(workDate, 1) : workDate;
      if (deadlineDate < today) return true;
      if (deadlineDate === today) { const thr = hmToMin(en) + coGrace; return thr < 1440 && nowMin >= thr; }
      return false;
    };
    // แถวที่ยังเปิดค้างจากเมื่อวาน (กะดึกยังไม่จบ)
    const { data: yestOpenData } = await sb.from("attendance").select("emp_id,shift_id,branch_id,check_in,check_out,extend_until")
      .eq("work_date", addDaysStr(today, -1)).not("check_in", "is", null).is("check_out", null);

    const events: { key: string; text: string; branch?: string }[] = [];
    (leavesR.data ?? []).forEach((l: any) => events.push({ key: `leave:${l.leave_id}`, text: `ใบลาใหม่: ${empName[l.emp_id] || l.emp_id} (${l.type || "ลา"})` }));
    (profR.data ?? []).forEach((p: any) => events.push({ key: `profile:${p.id}`, text: `ข้อมูลรอตรวจ: ${p.name || empName[p.emp_id] || p.emp_id}` }));
    (hoR?.data ?? []).forEach((h: any) => {
      if (h.status === "no_handover") events.push({ key: `ho:${h.id}`, text: `ไม่มีการส่งผลัด สาขา ${h.branch_id || "?"} (แจ้งโดย ${h.to_name || "-"})`, branch: h.branch_id });
      else if (h.status === "rejected") events.push({ key: `ho:${h.id}`, text: `รับผลัดไม่เรียบร้อย สาขา ${h.branch_id || "?"}: ${h.receiver_note || ""}`, branch: h.branch_id });
    });
    // เตือน "ยังไม่เช็กเอาต์" เลยเวลาเลิกกะ + ผ่อนผัน (รวมกะข้ามคืนที่เลิกเช้าวันถัดไป)
    // *** ยึด "กะปัจจุบันจากตารางเวร" (รองรับ HR เปลี่ยนกะหลังเช็กอิน + ควบกะ) — ไม่ใช้กะที่ค้างในแถวลงเวลา ***
    const { data: schNco } = await sb.from("schedules").select("emp_id,shift_id,work_date").in("work_date", [today, addDaysStr(today, -1)]);
    const schByED: Record<string, string[]> = {};
    (schNco ?? []).forEach((s: any) => { if (s.shift_id) (schByED[s.emp_id + "|" + s.work_date] = schByED[s.emp_id + "|" + s.work_date] || []).push(s.shift_id); });
    // เกินเวลาเลิก "กะสุดท้ายของวัน" (ตามตารางเวร; ถ้าไม่มีเวรใช้กะที่เช็กอิน) + ผ่อนผันหรือยัง
    const overdueBySched = (empId: string, wd: string, snapShift: string) => {
      const sids = (schByED[empId + "|" + wd] && schByED[empId + "|" + wd].length) ? schByED[empId + "|" + wd] : [snapShift];
      let latest: { en: string; endDate: string } | null = null, latestMs = -Infinity;
      for (const sid of sids) {
        const en = shiftEnd[sid]; if (!en) continue;
        const st = shiftStart[sid];
        const overnight = !!st && en <= st;                    // กะข้ามคืน → เลิกวันถัดไป
        const endDate = overnight ? addDaysStr(wd, 1) : wd;
        const ms = new Date(`${endDate}T${en}:00+07:00`).getTime();
        if (ms > latestMs) { latestMs = ms; latest = { en, endDate }; }   // เลือกกะที่เลิกช้าสุด
      }
      if (!latest) return false;
      if (latest.endDate < today) return true;
      if (latest.endDate === today) { const thr = hmToMin(latest.en) + coGrace; return thr < 1440 && nowMin >= thr; }
      return false;
    };
    const ncoRows = (att as any[]).filter((a) => a.check_in && !a.check_out).map((a) => ({ ...a, _wd: today }))
      .concat(((yestOpenData ?? []) as any[]).map((a) => ({ ...a, _wd: addDaysStr(today, -1) })));
    ncoRows.filter((a: any) => {
      if (a.extend_until && new Date(a.extend_until).getTime() > Date.now()) return false;   // ประกาศควบกะต่อ → ยังไม่เตือน
      return overdueBySched(a.emp_id, a._wd, a.shift_id);
    })
      .forEach((a: any) => events.push({ key: `nocheckout:${a.emp_id}:${a._wd}`, text: `ลืมเช็กเอาต์ (เลยเวลาเลิกกะ): ${empName[a.emp_id] || a.emp_id}`, branch: a.branch_id }));
    att.filter((a: any) => a.late_min > 0).forEach((a: any) => events.push({ key: `late:${a.emp_id}:${today}`, text: `มาสาย ${a.late_min} นาที: ${empName[a.emp_id] || a.emp_id}`, branch: a.branch_id }));
    (schR.data ?? []).forEach((s: any) => {
      if (!activeSet.has(s.emp_id)) return;          // ข้ามพนักงานที่ปิดใช้งาน (แม้ยังมีกะค้างในตาราง)
      if (checkedIn.has(s.emp_id) || onleave.has(s.emp_id)) return;
      const st = shiftStart[s.shift_id];
      if (!st || nowHM < st) return;                 // เตือนเฉพาะกะที่ถึงเวลาเข้างานแล้ว
      events.push({ key: `absent:${s.emp_id}:${today}:${s.shift_id}`, text: `ขาด/ยังไม่มา: ${empName[s.emp_id] || s.emp_id} (${shiftName[s.shift_id] || s.shift_id})`, branch: s.branch_id });
    });
    // เตือน "งานค้างก่อนหมดกะ" — ช่วงใกล้เลิกกะ (ภายใน warnBefore นาที) ถ้ายังมีงานที่ยังไม่ทำ (todo/sent_back)
    const warnBefore = isNaN(Number(settings["task_warn_before_min"])) ? 30 : Number(settings["task_warn_before_min"]);
    const { data: pendTasks } = await sb.from("task_assignments")
      .select("branch_id,shift_id,work_date,status")
      .in("work_date", [today, addDaysStr(today, -1)]).in("status", ["todo", "sent_back"]);
    const pg: Record<string, { branch: string; shift: string; wd: string; n: number }> = {};
    (pendTasks ?? []).forEach((t: any) => {
      const k = `${t.branch_id}|${t.shift_id}|${t.work_date}`;
      if (!pg[k]) pg[k] = { branch: t.branch_id, shift: t.shift_id, wd: t.work_date, n: 0 };
      pg[k].n++;
    });
    for (const k in pg) {
      const gr = pg[k]; const st = shiftStart[gr.shift], en = shiftEnd[gr.shift];
      if (!en) continue;
      const overnight = !!st && en <= st;
      const endDate = overnight ? addDaysStr(gr.wd, 1) : gr.wd;
      if (endDate !== today) continue;                 // เตือนเฉพาะกะที่กำลังจะหมดวันนี้
      const endMin = hmToMin(en);
      if (nowMin >= endMin - warnBefore && nowMin <= endMin) {
        events.push({ key: `taskpending:${gr.branch}:${gr.shift}:${gr.wd}`, text: `⏰ ใกล้หมดกะ${shiftName[gr.shift] ? " " + shiftName[gr.shift] : ""} สาขา ${gr.branch || "?"}: ยังมีงานค้าง ${gr.n} รายการ`, branch: gr.branch });
      }
    }
    // ประกาศที่ HR เขียนเอง (ยัง active + ไม่หมดอายุ) → ส่ง push ครั้งเดียวต่อประกาศ
    (annR?.data ?? []).filter((a: any) => !a.expire_date || a.expire_date >= today)
      .forEach((a: any) => events.push({ key: `announce:${a.id}`, text: `📢 ประกาศ: ${a.message}` }));

    // ===== ข้อเสนอแนะการลา: พนักงานตอบแล้ว → แจ้ง HR =====
    const { data: lrData } = await sb.from("leaves").select("leave_id,emp_id,type,response,response_msg,start_date,end_date").eq("status", "proposed").not("response", "is", null);
    (lrData ?? []).forEach((l: any) => {
      const rtxt = l.response === "accepted" ? "ยอมรับ" : "ไม่ยอมรับ";
      const range = l.start_date + (l.end_date && l.end_date !== l.start_date ? ("–" + l.end_date) : "");
      events.push({ key: `leaveresp:${l.leave_id}:${l.response}`, text: `${empName[l.emp_id] || l.emp_id} ${rtxt}ข้อเสนอแนะการลา (${l.type || "ลา"} ${range})${l.response_msg ? (": " + l.response_msg) : ""}` });
    });

    // ===== ใบสมัครงานใหม่ → แจ้ง HR (dedup ด้วย notify_sent) =====
    try {
      const { data: appData } = await sb.from("applicants").select("id,full_name,position,branch_id").eq("status", "new");
      (appData ?? []).forEach((a: any) => events.push({ key: `applicant:${a.id}`, text: `🧑‍💼 ใบสมัครใหม่: ${a.full_name}${a.position ? ` (${a.position})` : ""}`, branch: a.branch_id }));
    } catch (_e) { /* ตาราง applicants ยังไม่มี */ }

    // ===== คำขอเบิกเงินล่วงหน้า (รออนุมัติ) → แจ้ง HR · เตือนซ้ำทุก 2 ชม.จนกว่าจะอนุมัติ =====
    // ฉุกเฉิน = แยก push เด่น (ส่งด้านล่าง) · ปกติ = รวมในชุดแจ้งเตือน HR
    const advEmergency: { id: any; text: string; branch?: string; key: string }[] = [];
    try {
      const nowMs = Date.now();
      const { data: advData } = await sb.from("advance_requests").select("id,emp_id,emp_name,nickname,amount,kind,branch_id,created_at").eq("status", "submitted");
      (advData ?? []).forEach((a: any) => {
        const createdMs = a.created_at ? new Date(a.created_at).getTime() : nowMs;
        const bucket = Math.max(0, Math.floor((nowMs - createdMs) / (2 * 3600 * 1000)));   // เปลี่ยนทุก 2 ชม. → คีย์ใหม่ = เตือนซ้ำ
        const who = a.nickname || a.emp_name || empName[a.emp_id] || a.emp_id;
        const amt = Number(a.amount || 0).toLocaleString();
        if (a.kind === "emergency") {
          advEmergency.push({ id: a.id, branch: a.branch_id, key: `advemg:${a.id}:b${bucket}`, text: `${who} ${amt} บาท` });
        } else {
          events.push({ key: `advance:${a.id}:b${bucket}`, text: `💰 ขอเบิกเงินล่วงหน้า: ${who} ${amt} บาท — รออนุมัติ`, branch: a.branch_id });
        }
      });
    } catch (_e) { /* ตาราง advance_requests ยังไม่มี */ }

    // ===== งานใหม่ที่ HR มอบให้ ผจก. → แจ้งเครื่องสาขานั้น (ปิดได้ด้วย push_mgr_task_off) =====
    if (settings["push_mgr_task_off"] !== "1") {
      try {
        const { data: mtData } = await sb.from("mgr_tasks").select("id,title,branch_id,priority,status").in("status", ["todo", "review"]);
        (mtData ?? []).forEach((t: any) => {
          // ★ เดิมแจ้งแค่ตอนสร้างงาน · ตอน ผจก.ทำเสร็จรอ HR เซ็นรับ เงียบสนิท (badge ขึ้นแต่ไม่มีใครรู้)
          if (t.status === "review") events.push({ key: `mtaskrev:${t.id}`, text: `✅ ผจก.ทำงานเสร็จ รอเซ็นรับ: ${t.title}`, branch: t.branch_id });
          else events.push({ key: `mtask:${t.id}`, text: `${t.priority === "urgent" ? "🔴 งานด่วน" : "📌 งานใหม่"}จาก HR: ${t.title}`, branch: t.branch_id });
        });
      } catch (_e) { /* ตาราง mgr_tasks ยังไม่มี */ }
    }

    // ===== งานประจำวัน ผจก.: ส่งแล้ว → แจ้ง HR (รอตรวจ) =====
    try {
      const [mdlR, mddR] = await Promise.all([
        sb.from("mgr_daily_logs").select("id,branch_id,def_id,done_name").eq("work_date", today).eq("status", "submitted"),
        sb.from("mgr_daily_defs").select("id,title"),
      ]);
      const defTitle: Record<string, string> = {}; (mddR.data ?? []).forEach((d: any) => (defTitle[d.id] = d.title));
      (mdlR.data ?? []).forEach((l: any) => events.push({ key: `mdaily:${l.id}`, text: `📋 งานประจำวันรอตรวจ (สาขา ${l.branch_id || "?"}): ${defTitle[l.def_id] || ""}`, branch: l.branch_id }));

      // เตือน ผจก. "งานประจำวันค้าง" หลังเวลา cutoff (ตั้งค่า mdaily_remind_hour, ค่าเริ่ม 20:00)
      const remindHour = isNaN(Number(settings["mdaily_remind_hour"])) ? 20 : Number(settings["mdaily_remind_hour"]);
      const bkkHour = Number(nowHM.slice(0, 2));   // ชั่วโมงปัจจุบัน (Asia/Bangkok)
      if (bkkHour >= remindHour) {
        const { data: actDefs } = await sb.from("mgr_daily_defs").select("id").eq("active", true);
        const defCount = (actDefs ?? []).length;
        if (defCount) {
          const [brs, allLogs] = await Promise.all([
            sb.from("branches").select("branch_id"),
            sb.from("mgr_daily_logs").select("branch_id,def_id").eq("work_date", today),
          ]);
          const doneBy: Record<string, Set<string>> = {};
          (allLogs.data ?? []).forEach((l: any) => { (doneBy[l.branch_id] = doneBy[l.branch_id] || new Set()).add(l.def_id); });
          (brs.data ?? []).forEach((b: any) => {
            const remain = defCount - ((doneBy[b.branch_id] || new Set()).size);
            if (remain > 0) events.push({ key: `mdailyremind:${b.branch_id}:${today}`, text: `📋 เหลืองานประจำวันยังไม่ทำ ${remain} รายการ (กรุณาทำก่อนสิ้นวัน)`, branch: b.branch_id });
          });
        }
      }
    } catch (_e) { /* ตารางงานประจำวันยังไม่มี */ }

    // ===== นิดาตามงานอัตโนมัติ → โพสต์เข้าห้องแชทของสาขา (กันซ้ำ: เรื่องละครั้ง/สาขา/วัน) =====
    try {
      const NIDA = "นิดา · ผู้ช่วยฝ่ายบริหาร / HR";
      const chatMsgs: { key: string; branch: string; text: string }[] = [];

      // 1) งานในกะรอตรวจ ค้างเกิน 2 ชม.
      const twoHrAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      const { data: pendRows } = await sb.from("task_assignments").select("branch_id").eq("status", "submitted").lt("submitted_at", twoHrAgo);
      const pendBy: Record<string, number> = {}; (pendRows ?? []).forEach((t: any) => { if (t.branch_id) pendBy[t.branch_id] = (pendBy[t.branch_id] || 0) + 1; });
      Object.keys(pendBy).forEach((b) => chatMsgs.push({ key: `nidachat:pending:${b}:${today}`, branch: b, text: `📋 มีงานในกะ ${pendBy[b]} รายการ รอตรวจค้างเกิน 2 ชม.แล้วค่ะ รบกวนเข้าไปตรวจให้ด้วยนะคะ` }));

      // 2) งานถูกตีกลับวันนี้ ยังไม่แก้
      const { data: rejRows } = await sb.from("task_assignments").select("branch_id").eq("status", "sent_back").eq("work_date", today);
      const rejBy: Record<string, number> = {}; (rejRows ?? []).forEach((t: any) => { if (t.branch_id) rejBy[t.branch_id] = (rejBy[t.branch_id] || 0) + 1; });
      Object.keys(rejBy).forEach((b) => chatMsgs.push({ key: `nidachat:sentback:${b}:${today}`, branch: b, text: `⤴ มีงาน ${rejBy[b]} รายการ ถูกตีกลับให้แก้ไข แต่ยังไม่ได้แก้ค่ะ รบกวนติดตามพนักงานด้วยนะคะ` }));

      // 3) งานที่ HR มอบหมายให้ ผจก. ยังไม่เริ่ม
      const { data: mtRows } = await sb.from("mgr_tasks").select("branch_id").eq("status", "todo");
      const mtBy: Record<string, number> = {}; (mtRows ?? []).forEach((t: any) => { if (t.branch_id) mtBy[t.branch_id] = (mtBy[t.branch_id] || 0) + 1; });
      Object.keys(mtBy).forEach((b) => chatMsgs.push({ key: `nidachat:mtask:${b}:${today}`, branch: b, text: `📌 มีงานที่ HR มอบหมาย ${mtBy[b]} รายการ ยังไม่เริ่มค่ะ รบกวนเข้าไปดูในหน้า "งาน ผจก." นะคะ` }));

      if (chatMsgs.length) {
        const ckeys = chatMsgs.map((m) => m.key);
        const seenR = await sb.from("notify_sent").select("event_key").in("event_key", ckeys);
        const seenSet = new Set((seenR.data ?? []).map((r: any) => r.event_key));
        const fresh = chatMsgs.filter((m) => !seenSet.has(m.key));
        if (fresh.length) {
          await sb.from("mgr_chat").insert(fresh.map((m) => ({ branch_id: m.branch, sender_role: "nida", sender_name: NIDA, text: m.text })));
          await sb.from("notify_sent").upsert(fresh.map((m) => ({ event_key: m.key })), { onConflict: "event_key" });
          try { await fetch(SUPABASE_URL + "/functions/v1/chat-notify", { method: "POST", headers: { "Content-Type": "application/json" } }); } catch (_e) { /* ข้าม */ }
        }
      }
    } catch (_e) { /* ตารางแชทยังไม่มี */ }

    let okCount = 0; const gone: string[] = [];

    // แยกเครื่อง HR (ไม่มี emp_id) กับเครื่องพนักงาน (มี emp_id)
    const hrSubs  = subs.filter((s: any) => !s.emp_id);
    const empSubs = subs.filter((s: any) => s.emp_id);
    const subsByEmp: Record<string, any[]> = {};
    empSubs.forEach((s: any) => { (subsByEmp[s.emp_id] = subsByEmp[s.emp_id] || []).push(s); });
    // ส่ง push ไปเครื่องพนักงานคนหนึ่ง (ใช้ร่วมกันหลายฟีเจอร์)
    const sendToEmp = async (empId: string, title: string, body: string, tag: string, url = "./handover/") => {
      const list = subsByEmp[empId]; if (!list || !list.length) return;
      const payload = JSON.stringify({ title, body, url, tag });
      await Promise.all(list.map(async (s: any) => {
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); okCount++; }
        catch (err: any) { const c = err?.statusCode; if (c === 404 || c === 410) gone.push(s.endpoint); }
      }));
    };

    // ===== HR events → เครื่อง HR (กันส่งซ้ำด้วย notify_sent) =====
    if (events.length && hrSubs.length) {
      const keys = events.map((e) => e.key);
      const sentR = await sb.from("notify_sent").select("event_key").in("event_key", keys);
      const sent = new Set((sentR.data ?? []).map((r: any) => r.event_key));
      const fresh = events.filter((e) => !sent.has(e.key));
      if (fresh.length) {
        await Promise.all(hrSubs.map(async (s: any) => {
          const my = fresh.filter((e) => !s.branch_id || !e.branch || e.branch === s.branch_id);
          if (!my.length) return;
          const top = my.slice(0, 6).map((e) => "• " + e.text).join("\n");
          const more = my.length > 6 ? `\n…และอีก ${my.length - 6} รายการ` : "";
          const payload = JSON.stringify({ title: `แจ้งเตือน HR (${my.length})`, body: top + more, url: "./hr/", tag: "hr-notify" });
          try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); okCount++; }
          catch (err: any) { const c = err?.statusCode; if (c === 404 || c === 410) gone.push(s.endpoint); }
        }));
        await sb.from("notify_sent").upsert(fresh.map((e) => ({ event_key: e.key })), { onConflict: "event_key" });
      }
    }

    // ===== เบิกเงิน "ฉุกเฉิน" → push เด่นแยกต่างหาก (เตือนซ้ำทุก 2 ชม.) =====
    if (advEmergency.length && hrSubs.length) {
      const ekeys = advEmergency.map((e) => e.key);
      const seenR = await sb.from("notify_sent").select("event_key").in("event_key", ekeys);
      const seen = new Set((seenR.data ?? []).map((r: any) => r.event_key));
      const fresh = advEmergency.filter((e) => !seen.has(e.key));
      if (fresh.length) {
        await Promise.all(hrSubs.map(async (s: any) => {
          const my = fresh.filter((e) => !s.branch_id || !e.branch || e.branch === s.branch_id);
          for (const e of my) {
            // tag = ต่อคำขอ (ไม่รวม bucket) → เตือนซ้ำจะแทนที่อันเดิม ไม่กองซ้อน · คนละคำขอ = คนละแจ้งเตือน
            const payload = JSON.stringify({ title: "🚨 เบิกเงินฉุกเฉิน — รออนุมัติด่วน", body: `${e.text}\nรบกวนอนุมัติโดยเร็วที่สุด`, url: "./hr/", tag: `advemg:${e.id}`, renotify: true, requireInteraction: true, vibrate: [300, 120, 300, 120, 300] });
            try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); okCount++; }
            catch (err: any) { const c = err?.statusCode; if (c === 404 || c === 410) gone.push(s.endpoint); }
          }
        }));
        await sb.from("notify_sent").upsert(fresh.map((e) => ({ event_key: e.key })), { onConflict: "event_key" });
      }
    }

    // ===== ข้อเสนอแนะการลา: HR เสนอ → แจ้งพนักงาน (ครั้งเดียวต่อใบ) =====
    try {
      const { data: propData } = await sb.from("leaves").select("leave_id,emp_id,type,start_date,end_date").eq("status", "proposed").is("response", null);
      for (const l of (propData ?? [])) {
        const key = `leaveprop:${l.leave_id}`;
        const seen = await sb.from("notify_sent").select("event_key").eq("event_key", key).maybeSingle();
        if (seen.data) continue;
        const range = l.start_date + (l.end_date && l.end_date !== l.start_date ? ("–" + l.end_date) : "");
        await sendToEmp(l.emp_id, "📩 ข้อเสนอแนะเพิ่มเติมจากผู้จัดการ", `เรื่องคำขอลา ${l.type || ""} ${range} — เปิดแอปเพื่อตอบรับ/ปฏิเสธค่ะ`, "leaveprop-" + l.leave_id, "./");
        await sb.from("notify_sent").upsert({ event_key: key });
      }
    } catch (lpErr) { console.error("leave-proposal notify", lpErr); }

    // ===== งานพิเศษ: แจ้งพนักงาน (งานใหม่/ตีกลับ/ใกล้เดดไลน์) + แจ้ง HR (พนักงานส่งงาน) =====
    try {
      const { data: staAll } = await sb.from("special_task_assignees").select("*");
      const asg = staAll ?? [];
      if (asg.length) {
        const taskIds = [...new Set(asg.map((a: any) => a.task_id))];
        const { data: tasksData } = await sb.from("special_tasks").select("id,title,deadline,active").in("id", taskIds);
        const taskById: Record<string, any> = {}; (tasksData ?? []).forEach((t: any) => { taskById[t.id] = t; });
        const nowMs = Date.now(); const dueSoonMs = 24 * 3600 * 1000;
        for (const a of asg) {
          const t = taskById[a.task_id]; if (!t || t.active === false) continue;
          // (1) งานใหม่ / ถูกตีกลับ → แจ้งพนักงาน
          if (!a.assigned_notified && (a.status === "todo" || a.status === "sent_back")) {
            const redo = a.status === "sent_back";
            await sendToEmp(a.emp_id, redo ? "⤴ งานพิเศษถูกตีกลับ ต้องแก้ไข" : "⭐ มีงานพิเศษใหม่",
              t.title + (t.deadline ? ("\nครบกำหนด: " + fmtThai(t.deadline)) : ""), "sp-new-" + a.id + (redo ? "-r" : "-n"));
            await sb.from("special_task_assignees").update({ assigned_notified: true }).eq("id", a.id);
          }
          // (2) ใกล้ครบกำหนด (ภายใน 24 ชม.) → แจ้งพนักงาน
          if (!a.deadline_notified && t.deadline && (a.status === "todo" || a.status === "sent_back")) {
            const dlMs = new Date(t.deadline).getTime();
            if (dlMs - nowMs <= dueSoonMs && dlMs - nowMs > -6 * 3600 * 1000) {
              await sendToEmp(a.emp_id, "⏰ ใกล้ครบกำหนดงานพิเศษ", t.title + "\nครบกำหนด: " + fmtThai(t.deadline), "sp-dl-" + a.id);
              await sb.from("special_task_assignees").update({ deadline_notified: true }).eq("id", a.id);
            }
          }
          // (3) พนักงานส่งงาน → แจ้ง HR (ตามสาขา)
          if (!a.submit_notified && a.status === "submitted") {
            const my = hrSubs.filter((s: any) => !s.branch_id || !a.branch_id || s.branch_id === a.branch_id);
            const payload = JSON.stringify({ title: "⭐ พนักงานส่งงานพิเศษ", body: (empName[a.emp_id] || a.emp_id) + ": " + t.title, url: "./hr/", tag: "sp-submit-" + a.id });
            await Promise.all(my.map(async (s: any) => {
              try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); okCount++; }
              catch (err: any) { const c = err?.statusCode; if (c === 404 || c === 410) gone.push(s.endpoint); }
            }));
            await sb.from("special_task_assignees").update({ submit_notified: true }).eq("id", a.id);
          }
        }
      }
    } catch (spErr) { console.error("special notify", spErr); }

    // ===== QA สินค้าใกล้หมดอายุ → แจ้งพนักงานที่รับผิดชอบโฟลเดอร์ (30/14/7/3 วัน) =====
    try {
      const { data: qaData } = await sb.from("qa_items")
        .select("id,folder_id,name,expiry_date,status,notified_30,notified_14,notified_7,notified_3")
        .eq("status", "on_shelf").not("expiry_date", "is", null);
      const items = qaData ?? [];
      if (items.length) {
        const folderIds = [...new Set(items.map((i: any) => i.folder_id))];
        const { data: faData } = await sb.from("qa_folder_assignees").select("folder_id,emp_id").in("folder_id", folderIds);
        const empsByFolder: Record<string, string[]> = {};
        (faData ?? []).forEach((a: any) => { (empsByFolder[a.folder_id] = empsByFolder[a.folder_id] || []).push(a.emp_id); });
        const todayMs = new Date(today + "T00:00:00Z").getTime();
        // เรียงจากช่วงเล็กไปใหญ่ → เลือกชั้นที่ครอบคลุมวันคงเหลือปัจจุบัน
        const tiers = [{ d: 3, col: "notified_3" }, { d: 7, col: "notified_7" }, { d: 14, col: "notified_14" }, { d: 30, col: "notified_30" }];
        for (const it of items) {
          const dl = Math.round((new Date(it.expiry_date + "T00:00:00Z").getTime() - todayMs) / 86400000);
          let tier: any = null;
          for (const t of tiers) { if (dl <= t.d) { tier = t; break; } }
          if (!tier) continue;              // ยังเกิน 30 วัน
          if (it[tier.col]) continue;       // ชั้นนี้แจ้งไปแล้ว
          const emps = empsByFolder[it.folder_id] || [];
          const body = it.name + "\nหมดอายุ " + fmtThaiDate(it.expiry_date) + (dl < 0 ? ` (เลยมาแล้ว ${-dl} วัน)` : ` (เหลือ ${dl} วัน)`);
          for (const empId of emps) { await sendToEmp(empId, "🗓️ สินค้าใกล้หมดอายุ", body, "qa-" + it.id + "-" + tier.d, "./qa/"); }
          await sb.from("qa_items").update({ [tier.col]: true }).eq("id", it.id);
        }
      }
    } catch (qaErr) { console.error("qa notify", qaErr); }

    // ===== งานรับส่งผลัด: เตือน "ส่งแล้วยังไม่ถูกตรวจ" (→ หัวหน้าผลัดถัดไป + HR) + สรุปงานค้างสิ้นวัน (→ HR) =====
    try {
      const reviewGraceMin = isNaN(Number(settings["task_review_grace_min"])) ? 30 : Number(settings["task_review_grace_min"]);
      const eodHour = isNaN(Number(settings["task_eod_hour"])) ? 22 : Number(settings["task_eod_hour"]);
      const nowMs = Date.now();
      // ส่ง push ตรงไปเครื่อง HR (block HR events ด้านบนรันไปแล้ว) — กันซ้ำด้วย notify_sent
      const hrPush = async (title: string, body: string, tag: string, branch?: string) => {
        const my = hrSubs.filter((s: any) => !s.branch_id || !branch || s.branch_id === branch);
        const payload = JSON.stringify({ title, body, url: "./hr/", tag });
        await Promise.all(my.map(async (s: any) => {
          try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); okCount++; }
          catch (err: any) { const c = err?.statusCode; if (c === 404 || c === 410) gone.push(s.endpoint); }
        }));
      };
      const { data: openTasks } = await sb.from("task_assignments")
        .select("branch_id,shift_id,work_date,status,task_def_id,needs_mgr,mgr_checked_at").in("work_date", [today, addDaysStr(today, -1)]).neq("status", "approved");
      // ★ กติกา "งานรอตรวจ" ต้องเป็นชุดเดียวกับคิวที่เปิดเข้าไปเห็นในหน้าเว็บ (hr-api.js · hrMgrIntaskList)
      //   เดิมนับทุกแถวที่ status=submitted → ไลน์บอกเลขหนึ่ง เปิดเข้าไปเจออีกเลข
      const [{ data: _tdefs }, { data: _shRev }] = await Promise.all([
        sb.from("task_defs").select("id,mgr_review"),
        sb.from("shifts").select("shift_id,mgr_review"),
      ]);
      const _defMgr: Record<string, boolean> = {}; (_tdefs ?? []).forEach((d: any) => { _defMgr[d.id] = !!d.mgr_review; });
      const _shOff: Record<string, boolean> = {}; (_shRev ?? []).forEach((x: any) => { _shOff[x.shift_id] = (x.mgr_review === false); });
      const _needsReview = (t: any) => !t.mgr_checked_at && (t.needs_mgr === true || (!!_defMgr[t.task_def_id] && !_shOff[t.shift_id]));
      const groups: Record<string, { branch: string; shift: string; wd: string; todo: number; submitted: number; sentback: number; needrev: number }> = {};
      (openTasks ?? []).forEach((t: any) => {
        const k = `${t.branch_id}|${t.shift_id}|${t.work_date}`;
        if (!groups[k]) groups[k] = { branch: t.branch_id, shift: t.shift_id, wd: t.work_date, todo: 0, submitted: 0, sentback: 0, needrev: 0 };
        if (t.status === "submitted") { groups[k].submitted++; if (_needsReview(t)) groups[k].needrev++; }
        else if (t.status === "sent_back") groups[k].sentback++;
        else groups[k].todo++;
      });
      // เชนผลัดหลัก + หัวหน้าผลัดวันนี้ (ไว้หาผลัดถัดไปที่ควรตรวจ)
      const { data: shiftsAll } = await sb.from("shifts").select("shift_id,main_shift,start_time").order("start_time");
      const chain = (shiftsAll ?? []).filter((s: any) => s.main_shift && s.main_shift === s.shift_id).map((s: any) => s.shift_id);
      const { data: leadsToday } = await sb.from("shift_leads").select("branch_id,shift_id,emp_id").eq("work_date", today);
      const nextMainOf = (shift: string, wd: string) => {
        const idx = chain.indexOf(shift); if (idx < 0) return null;
        if (idx === chain.length - 1) return { shift: chain[0], date: addDaysStr(wd, 1) };
        return { shift: chain[idx + 1], date: wd };
      };
      const eodLines: string[] = [];
      for (const k in groups) {
        const g = groups[k]; const st = shiftStart[g.shift], en = shiftEnd[g.shift];
        if (!en) continue;
        const overnight = !!st && en <= st;
        const endMs = new Date((overnight ? addDaysStr(g.wd, 1) : g.wd) + "T" + en + ":00+07:00").getTime();
        const ended = nowMs >= endMs + reviewGraceMin * 60000;
        const total = g.todo + g.submitted + g.sentback;
        // (A) กะจบแล้ว + มีงานส่งแล้วรอตรวจ → เตือนหัวหน้าผลัดถัดไป + HR (ครั้งเดียว)
        if (ended && g.needrev > 0) {
          // ★ ใส่จำนวนไว้ในคีย์ด้วย — เดิมส่งครั้งเดียวต่อวัน พองานเพิ่มทีหลังไลน์ค้างที่เลขเดิมแต่ badge วิ่งขึ้นเรื่อย ๆ
          const key = `taskunrev:${g.branch}:${g.shift}:${g.wd}:${g.needrev}`;
          const seen = await sb.from("notify_sent").select("event_key").eq("event_key", key).maybeSingle();
          if (!seen.data) {
            const nm = nextMainOf(g.shift, g.wd);
            if (nm && String(nm.date) === today) {
              const ld = (leadsToday ?? []).find((l: any) => (l.branch_id || "") === (g.branch || "") && l.shift_id === nm.shift);
              if (ld) await sendToEmp(ld.emp_id, "🧾 มีงานผลัดก่อนรอตรวจ", `กะ${shiftName[g.shift] ? " " + shiftName[g.shift] : ""} สาขา ${g.branch || "?"} รอตรวจ ${g.needrev} รายการ — ตรวจในเมนู "ตรวจผลัดก่อนหน้า"`, "taskunrev-" + g.branch + "-" + g.shift + "-" + g.wd);
            }
            await hrPush("🧾 งานรอตรวจค้าง", `กะ${shiftName[g.shift] ? " " + shiftName[g.shift] : ""} สาขา ${g.branch || "?"}: รอ ผจก.ตรวจ ${g.needrev} รายการ`, "taskunrev-hr-" + g.branch + "-" + g.shift + "-" + g.wd, g.branch);
            await sb.from("notify_sent").upsert({ event_key: key });
          }
        }
        // เก็บบรรทัดสำหรับสรุปสิ้นวัน (ทุกกลุ่มที่ยังค้าง)
        if (total > 0) eodLines.push(`สาขา ${g.branch || "?"} กะ${shiftName[g.shift] ? " " + shiftName[g.shift] : ""} (${g.wd}): ค้าง ${total}${g.needrev ? ` · รอตรวจ ${g.needrev}` : ""}`);
      }
      // (B) สรุปงานค้างสิ้นวัน → HR ครั้งเดียวต่อวัน (เมื่อถึงชั่วโมงที่ตั้ง)
      if (eodLines.length && nowMin >= eodHour * 60) {
        const key = `taskeod:${today}`;
        const seen = await sb.from("notify_sent").select("event_key").eq("event_key", key).maybeSingle();
        if (!seen.data) {
          const body = eodLines.slice(0, 8).join("\n") + (eodLines.length > 8 ? `\n…และอีก ${eodLines.length - 8} กลุ่ม` : "");
          await hrPush(`📋 สรุปงานค้างสิ้นวัน (${eodLines.length} กลุ่ม)`, body, "taskeod-" + today);
          await sb.from("notify_sent").upsert({ event_key: key });
        }
      }
    } catch (hoTaskErr) { console.error("handover task notify", hoTaskErr); }

    // ===== งานในกะถูกตีกลับ → แจ้งพนักงานเจ้าของงาน + หัวหน้าผลัด (ยิงใหม่ทุกครั้งที่ตีกลับรอบใหม่) =====
    try {
      const { data: rbTasks } = await sb.from("task_assignments")
        .select("id,emp_id,title,shift_id,branch_id,work_date,review_note,reviewer,sent_back_count")
        .eq("status", "sent_back").gte("work_date", addDaysStr(today, -3));
      if ((rbTasks ?? []).length) {
        const wds = [...new Set((rbTasks ?? []).map((t: any) => t.work_date))];
        const { data: leadRows } = await sb.from("shift_leads").select("work_date,branch_id,shift_id,emp_id").in("work_date", wds);
        const leadMap: Record<string, string> = {};
        (leadRows ?? []).forEach((l: any) => { leadMap[`${l.work_date}|${l.branch_id || ""}|${l.shift_id}`] = l.emp_id; });
        for (const t of (rbTasks ?? [])) {
          const key = `taskrb:${t.id}:${t.sent_back_count || 0}`;
          const seen = await sb.from("notify_sent").select("event_key").eq("event_key", key).maybeSingle();
          if (seen.data) continue;
          const body = `${t.title}${t.review_note ? `\nสิ่งที่ต้องแก้: ${t.review_note}` : ""}${t.reviewer ? `\n(โดย ${t.reviewer})` : ""}`;
          if (t.emp_id) await sendToEmp(t.emp_id, "⤴ งานถูกตีกลับ ต้องแก้ไข", body, "taskrb-" + t.id + "-" + (t.sent_back_count || 0));
          const leadId = leadMap[`${t.work_date}|${t.branch_id || ""}|${t.shift_id}`];
          if (leadId && leadId !== t.emp_id) await sendToEmp(leadId, "⤴ งานในผลัดถูกตีกลับ", `${empName[t.emp_id] || t.emp_id}: ${t.title}${t.review_note ? `\n${t.review_note}` : ""}`, "taskrb-lead-" + t.id + "-" + (t.sent_back_count || 0));
          await sb.from("notify_sent").upsert({ event_key: key });
        }
      }
    } catch (rbErr) { console.error("task sent-back notify", rbErr); }

    // ===== ปิดงานอัตโนมัติเมื่อลืมกดออก (OT=0) + เตือนพนักงานให้กดออก/ควบกะ =====
    try {
      const autoCloseMin = isNaN(Number(settings["checkout_autoclose_min"])) ? 60 : Number(settings["checkout_autoclose_min"]);
      const nowMs = Date.now();
      // ตารางเวรวันนี้+เมื่อวาน → รองรับควบกะ (ปิดที่เวลาเลิก "กะสุดท้าย")
      const { data: schBoth } = await sb.from("schedules").select("emp_id,shift_id,work_date").in("work_date", [today, addDaysStr(today, -1)]);
      const schByEmpDate: Record<string, string[]> = {};
      (schBoth ?? []).forEach((s: any) => { if (s.shift_id) { (schByEmpDate[s.emp_id + "|" + s.work_date] = schByEmpDate[s.emp_id + "|" + s.work_date] || []).push(s.shift_id); } });
      const effEndOf = (wd: string, sid: string) => {
        const st = shiftStart[sid], en = shiftEnd[sid]; if (!en) return null;
        const overnight = !!st && en <= st;
        const endDate = overnight ? addDaysStr(wd, 1) : wd;
        return { iso: `${endDate}T${en}:00+07:00`, en };
      };
      const openRows = (att as any[]).filter((a) => a.check_in && !a.check_out).map((a) => ({ ...a, _wd: today }))
        .concat(((yestOpenData ?? []) as any[]).map((a) => ({ ...a, _wd: addDaysStr(today, -1) })));
      const _acClosed: string[] = [];   // ★ เก็บคนที่ระบบปิดกะให้ ไว้แจ้ง HR ท้ายบล็อก
      for (const a of openRows) {
        // หา "กะสุดท้าย" ของวันจากตารางเวร (ถ้าไม่มีใช้กะที่เช็กอิน)
        const sids = (schByEmpDate[a.emp_id + "|" + a._wd] && schByEmpDate[a.emp_id + "|" + a._wd].length) ? schByEmpDate[a.emp_id + "|" + a._wd] : [a.shift_id];
        let effEndIso: string | null = null, effEndMs = -Infinity, en = "";
        for (const sid of sids) { const r = effEndOf(a._wd, sid); if (!r) continue; const ms = new Date(r.iso).getTime(); if (ms > effEndMs) { effEndMs = ms; effEndIso = r.iso; en = r.en; } }
        if (!effEndIso) continue;
        if (a.extend_until && new Date(a.extend_until).getTime() > nowMs) continue;   // ประกาศควบกะต่อ → ยังไม่ปิด
        const graceMs = effEndMs + coGrace * 60000;
        const closeMs = effEndMs + autoCloseMin * 60000;
        // เตือนพนักงาน (หลังผ่อนผัน แต่ยังไม่ถึงเวลาปิด) — กันซ้ำด้วย notify_sent
        if (nowMs >= graceMs && nowMs < closeMs) {
          const key = `coremind:${a.emp_id}:${a._wd}`;
          const seen = await sb.from("notify_sent").select("event_key").eq("event_key", key).maybeSingle();
          if (!seen.data) {
            await sendToEmp(a.emp_id, "⏰ อย่าลืมกดออกงาน", `กะ${shiftName[a.shift_id] ? " " + shiftName[a.shift_id] : ""} เลิก ${en} แล้ว — กดออกงาน หรือกดควบกะต่อในแอป`, "coremind-" + a.emp_id + "-" + a._wd, "./employee/");
            await sb.from("notify_sent").upsert({ event_key: key });
          }
        }
        // ถึงเวลาปิด → ปิดงานให้ที่เวลาเลิกกะ, OT=0
        if (nowMs >= closeMs) {
          await sb.from("attendance").update({ check_out: new Date(effEndIso).toISOString(), ot_hours: 0, status: "AUTO_CLOSED", auto_closed: true })
            .eq("emp_id", a.emp_id).eq("work_date", a._wd);
          _acClosed.push(a.emp_id + "|" + a._wd + "|" + en);
        }
      }
      // ★ เดิมปิดกะให้เงียบ ๆ ไม่มีใครรู้ — แถวหน้าตาเหมือนคนกดออกเองปกติ และ OT ถูกตัดเป็น 0
      if (_acClosed.length) {
        const _ids = [...new Set(_acClosed.map((x) => x.split("|")[0]))];
        const { data: _acE } = await sb.from("employees").select("emp_id,name").in("emp_id", _ids);
        const _acNm: Record<string, string> = {}; (_acE || []).forEach((x: any) => { _acNm[x.emp_id] = x.name || x.emp_id; });
        for (const item of _acClosed) {
          const p = item.split("|"); const eid = p[0], wd = p[1], endT = p[2];
          const key = `autoclose:${eid}:${wd}`;
          const seen = await sb.from("notify_sent").select("event_key").eq("event_key", key).maybeSingle();
          if (seen.data) continue;
          const payload = JSON.stringify({
            title: "🔒 ระบบปิดกะให้อัตโนมัติ",
            body: `${_acNm[eid] || eid} · ${fmtThaiDate(wd)} — ลืมกดออกงาน ระบบลงเวลาออกให้ที่ ${endT} และตัด OT เป็น 0\nตรวจ/แก้ได้ในแท็บ "แก้ไขบันทึกเวลา"`,
            url: "./hr/", tag: "autoclose-" + eid + "-" + wd,
          });
          await Promise.all(hrSubs.map(async (sub: any) => {
            try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload); okCount++; }
            catch (err: any) { const c = err?.statusCode; if (c === 404 || c === 410) gone.push(sub.endpoint); }
          }));
          await sb.from("notify_sent").upsert({ event_key: key });
        }
      }
    } catch (acErr) { console.error("auto-checkout", acErr); }

    // ===== งานดูแลเชลฟ์ประจำเดือน: เตือนผู้รับผิดชอบทุกวันที่มีกะ (ถ้ายังไม่ตรวจวันนี้) =====
    try {
      const month = today.slice(0, 7);
      const { data: saData } = await sb.from("shelf_assignments").select("emp_id,shelf_id").eq("month", month);
      const asg = saData ?? [];
      if (asg.length) {
        const shIds = [...new Set(asg.map((a: any) => a.shelf_id))];
        const [shR2, ckR2] = await Promise.all([
          sb.from("shelves").select("id,name").in("id", shIds),
          sb.from("shelf_checks").select("shelf_id,emp_id").eq("check_date", today),
        ]);
        const shName: Record<string, string> = {}; (shR2.data ?? []).forEach((s: any) => { shName[s.id] = s.name || ("#" + s.id); });
        const doneToday = new Set((ckR2.data ?? []).map((c: any) => c.shelf_id + "|" + c.emp_id));
        // พนักงานที่ "มีกะวันนี้" + เวลาเข้ากะที่เร็วที่สุด
        const shiftStartOfEmp: Record<string, string> = {};
        (schR.data ?? []).forEach((s: any) => { const st = shiftStart[s.shift_id]; if (st && (!shiftStartOfEmp[s.emp_id] || st < shiftStartOfEmp[s.emp_id])) shiftStartOfEmp[s.emp_id] = st; });
        // รวมเชลฟ์ที่ยังไม่ตรวจวันนี้ ต่อพนักงาน
        const byEmp: Record<string, string[]> = {};
        asg.forEach((a: any) => { if (doneToday.has(a.shelf_id + "|" + a.emp_id)) return; (byEmp[a.emp_id] = byEmp[a.emp_id] || []).push(shName[a.shelf_id] || ("#" + a.shelf_id)); });
        for (const empId in byEmp) {
          const st = shiftStartOfEmp[empId];
          if (!st) continue;                 // ไม่มีกะวันนี้ → ไม่เตือน
          if (onleave.has(empId)) continue;   // ลา → ไม่เตือน
          if (nowHM < st) continue;           // ยังไม่ถึงเวลาเข้ากะ
          const key = `shelfremind:${empId}:${today}`;
          const seen = await sb.from("notify_sent").select("event_key").eq("event_key", key).maybeSingle();
          if (seen.data) continue;
          const shelves = byEmp[empId];
          const body = "เชลฟ์ที่ต้องดูแลวันนี้: " + shelves.slice(0, 5).join(", ") + (shelves.length > 5 ? ` และอีก ${shelves.length - 5}` : "") + "\nอย่าลืมทำเช็กลิสต์ + ถ่ายรูปในแอป";
          await sendToEmp(empId, "🗄️ ดูแลเชลฟ์ประจำเดือน", body, "shelfremind-" + empId + "-" + today, "./shelf/");
          await sb.from("notify_sent").upsert({ event_key: key });
        }
      }
    } catch (shErr) { console.error("shelf remind", shErr); }

    // ===== น้องนิดา (พนักงาน): เตือน "งานค้างของสาขา" → อุปกรณ์ประจำสาขา (kind='branch') =====
    try {
      const brSubs = subs.filter((s: any) => s.kind === "branch" && s.branch_id);
      const hour = Number(nowHM.slice(0, 2));
      if (brSubs.length) {                       // ร้านเปิด 24 ชม. — เตือนได้ทุกชั่วโมง
        const bucket = Math.floor(hour / 3);   // แต่คุมความถี่ไว้สูงสุดทุก ~3 ชม.
        const branchIds = [...new Set(brSubs.map((s: any) => s.branch_id))];
        const yst = addDaysStr(today, -1); const month = today.slice(0, 7);
        const [btR, bspR, saR] = await Promise.all([
          sb.from("task_assignments").select("branch_id,status,work_date").in("branch_id", branchIds).in("work_date", [today, yst]).neq("status", "approved"),
          sb.from("special_task_assignees").select("branch_id,status").in("branch_id", branchIds).in("status", ["todo", "sent_back"]),
          sb.from("shelf_assignments").select("shelf_id,emp_id,branch_id").in("branch_id", branchIds).eq("month", month),
        ]);
        const taskCnt: Record<string, number> = {}; (btR.data ?? []).forEach((t: any) => { taskCnt[t.branch_id] = (taskCnt[t.branch_id] || 0) + 1; });
        const spCnt: Record<string, number> = {}; (bspR.data ?? []).forEach((s: any) => { spCnt[s.branch_id] = (spCnt[s.branch_id] || 0) + 1; });
        const sa = saR.data ?? []; const shIds = [...new Set(sa.map((x: any) => x.shelf_id))];
        const scR = shIds.length ? await sb.from("shelf_checks").select("shelf_id,emp_id").eq("check_date", today).in("shelf_id", shIds) : { data: [] as any[] };
        const doneSet = new Set((scR.data ?? []).map((c: any) => c.shelf_id + "|" + c.emp_id));
        const shelfCnt: Record<string, number> = {}; sa.forEach((a: any) => { if (!doneSet.has(a.shelf_id + "|" + a.emp_id)) shelfCnt[a.branch_id] = (shelfCnt[a.branch_id] || 0) + 1; });
        const subsByBranch: Record<string, any[]> = {}; brSubs.forEach((s: any) => { (subsByBranch[s.branch_id] = subsByBranch[s.branch_id] || []).push(s); });
        for (const br of branchIds) {
          const tot = (taskCnt[br] || 0) + (spCnt[br] || 0) + (shelfCnt[br] || 0);
          if (!tot) continue;
          const key = `branchremind:${br}:${today}:${bucket}`;
          const seen = await sb.from("notify_sent").select("event_key").eq("event_key", key).maybeSingle();
          if (seen.data) continue;
          const parts: string[] = [];
          if (taskCnt[br]) parts.push("งานในกะ " + taskCnt[br]);
          if (shelfCnt[br]) parts.push("เชลฟ์ยังไม่ตรวจ " + shelfCnt[br]);
          if (spCnt[br]) parts.push("งานพิเศษ " + spCnt[br]);
          const payload = JSON.stringify({ title: `🤖 น้องนิดา · งานค้างของสาขา (${tot})`, body: parts.join(" · ") + "\nแตะเพื่อดูและจัดการ", url: "./", tag: "branchremind-" + br });
          await Promise.all((subsByBranch[br] || []).map(async (s: any) => {
            try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); okCount++; }
            catch (err: any) { const c = err?.statusCode; if (c === 404 || c === 410) gone.push(s.endpoint); }
          }));
          await sb.from("notify_sent").upsert({ event_key: key });
        }
      }
    } catch (brErr) { console.error("branch remind", brErr); }

    // ===== ★ ชั้นที่ 4: ตรวจจับ "ลงเวลาผิดวัน" ของกะข้ามคืน (เพิ่ม 27 ส.ค. 2569) =====
    //   อาการ: คนกะดึกสายจนข้ามเที่ยงคืน → เดิมระบบลง work_date เป็นวันถัดไป
    //          ผลคือวันจริงกลายเป็น "ขาดงาน" · สายบันทึกเป็น 0 · คืนถัดไปกดเข้างานไม่ได้
    //   ต้นเหตุแก้แล้วที่ shared/supabase.js (checkIn หาวันที่ของกะเอง)
    //   บล็อกนี้เป็น "ตาข่ายรับ" กรณีมีแถวเก่าค้าง หรือเคสที่คิดไม่ถึงหลุดมา
    //   เงื่อนไข: เมื่อวานมีเวรกะข้ามคืน + เมื่อวานไม่มีลงเวลา + วันนี้มีแถวที่สแกนก่อน 08:00
    try {
      const _yd = addDaysStr(today, -1);
      const { data: _allSh } = await sb.from("shifts").select("shift_id,name,start_time,end_time");
      const _ovSet = new Set((_allSh || [])
        .filter((s: any) => s.start_time && s.end_time
          && String(s.end_time).slice(0, 5) <= String(s.start_time).slice(0, 5))
        .map((s: any) => s.shift_id));
      const _shNm: Record<string, string> = {};
      (_allSh || []).forEach((s: any) => { _shNm[s.shift_id] = s.name || s.shift_id; });
      if (_ovSet.size) {
        const { data: _ydSch } = await sb.from("schedules").select("emp_id,shift_id").eq("work_date", _yd);
        const _susp = (_ydSch || []).filter((s: any) => _ovSet.has(s.shift_id));
        if (_susp.length) {
          const _ids = [...new Set(_susp.map((s: any) => s.emp_id))];
          const { data: _att } = await sb.from("attendance")
            .select("emp_id,work_date,check_in").in("emp_id", _ids).in("work_date", [_yd, today]);
          const _hasYd = new Set((_att || [])
            .filter((a: any) => a.work_date === _yd && a.check_in).map((a: any) => a.emp_id));
          const _todayRow: Record<string, any> = {};
          (_att || []).forEach((a: any) => { if (a.work_date === today && a.check_in) _todayRow[a.emp_id] = a; });
          const { data: _emps } = await sb.from("employees").select("emp_id,name").in("emp_id", _ids);
          const _nm: Record<string, string> = {};
          (_emps || []).forEach((e: any) => { _nm[e.emp_id] = e.name || e.emp_id; });
          const _bad: string[] = [];
          for (const s of _susp) {
            if (_hasYd.has(s.emp_id)) continue;                       // เมื่อวานมีลงเวลาแล้ว = ปกติ
            const r = _todayRow[s.emp_id]; if (!r) continue;          // วันนี้ไม่มีแถว = ขาดจริง ไม่ใช่เคสนี้
            const hh = new Date(new Date(r.check_in).getTime() + 7 * 3600 * 1000).getUTCHours();
            if (hh >= 8) continue;                                    // สแกนหลัง 08:00 = กะปกติของวันนี้
            _bad.push(`${_nm[s.emp_id] || s.emp_id} · กะ${_shNm[s.shift_id] || s.shift_id} ของ ${fmtThaiDate(_yd)} · สแกน ${fmtThai(r.check_in)}`);
          }
          if (_bad.length) {
            const key = `xnight:${today}`;
            const seen = await sb.from("notify_sent").select("event_key").eq("event_key", key).maybeSingle();
            if (!seen.data) {
              const body = _bad.slice(0, 6).join("\n")
                + (_bad.length > 6 ? `\n…และอีก ${_bad.length - 6} คน` : "")
                + '\n\nอาจลงเวลาผิดวัน — ตรวจในแท็บ "แก้ไขบันทึกเวลา"';
              const payload = JSON.stringify({
                title: `⚠️ สงสัยลงเวลาผิดวัน (${_bad.length})`, body, url: "./hr/", tag: "xnight-" + today,
              });
              await Promise.all(hrSubs.map(async (s: any) => {
                try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); okCount++; }
                catch (err: any) { const c = err?.statusCode; if (c === 404 || c === 410) gone.push(s.endpoint); }
              }));
              await sb.from("notify_sent").upsert({ event_key: key });
            }
          }
        }
      }
    } catch (xnErr) { console.error("cross-night date check", xnErr); }

    if (gone.length) await sb.from("push_subscriptions").delete().in("endpoint", gone);
    const cutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    await sb.from("notify_sent").delete().lt("sent_at", cutoff);   // ล้างของเก่า > 7 วัน

    return json({ ok: true, sent: okCount, removed: gone.length });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

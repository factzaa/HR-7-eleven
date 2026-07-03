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
      sb.from("employees").select("emp_id,name").eq("active", true),
      sb.from("leaves").select("leave_id,emp_id,type,start_date,end_date").eq("status", "pending"),
      sb.from("attendance").select("emp_id,check_in,check_out,late_min,shift_id,branch_id").eq("work_date", today),
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
    const { data: yestOpenData } = await sb.from("attendance").select("emp_id,shift_id,branch_id,check_in,check_out")
      .eq("work_date", addDaysStr(today, -1)).not("check_in", "is", null).is("check_out", null);

    const events: { key: string; text: string; branch?: string }[] = [];
    (leavesR.data ?? []).forEach((l: any) => events.push({ key: `leave:${l.leave_id}`, text: `ใบลาใหม่: ${empName[l.emp_id] || l.emp_id} (${l.type || "ลา"})` }));
    (profR.data ?? []).forEach((p: any) => events.push({ key: `profile:${p.id}`, text: `ข้อมูลรอตรวจ: ${p.name || empName[p.emp_id] || p.emp_id}` }));
    (hoR?.data ?? []).forEach((h: any) => {
      if (h.status === "no_handover") events.push({ key: `ho:${h.id}`, text: `ไม่มีการส่งผลัด สาขา ${h.branch_id || "?"} (แจ้งโดย ${h.to_name || "-"})`, branch: h.branch_id });
      else if (h.status === "rejected") events.push({ key: `ho:${h.id}`, text: `รับผลัดไม่เรียบร้อย สาขา ${h.branch_id || "?"}: ${h.receiver_note || ""}`, branch: h.branch_id });
    });
    // เตือน "ยังไม่เช็กเอาต์" เลยเวลาเลิกกะ + ผ่อนผัน (รวมกะข้ามคืนที่เลิกเช้าวันถัดไป)
    const ncoRows = (att as any[]).filter((a) => a.check_in && !a.check_out).map((a) => ({ ...a, _wd: today }))
      .concat(((yestOpenData ?? []) as any[]).map((a) => ({ ...a, _wd: addDaysStr(today, -1) })));
    ncoRows.filter((a: any) => coOverdue(a._wd, shiftStart[a.shift_id], shiftEnd[a.shift_id]))
      .forEach((a: any) => events.push({ key: `nocheckout:${a.emp_id}:${a._wd}`, text: `ลืมเช็กเอาต์ (เลยเวลาเลิกกะ): ${empName[a.emp_id] || a.emp_id}`, branch: a.branch_id }));
    att.filter((a: any) => a.late_min > 0).forEach((a: any) => events.push({ key: `late:${a.emp_id}:${today}`, text: `มาสาย ${a.late_min} นาที: ${empName[a.emp_id] || a.emp_id}`, branch: a.branch_id }));
    (schR.data ?? []).forEach((s: any) => {
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
        .select("branch_id,shift_id,work_date,status").in("work_date", [today, addDaysStr(today, -1)]).neq("status", "approved");
      const groups: Record<string, { branch: string; shift: string; wd: string; todo: number; submitted: number; sentback: number }> = {};
      (openTasks ?? []).forEach((t: any) => {
        const k = `${t.branch_id}|${t.shift_id}|${t.work_date}`;
        if (!groups[k]) groups[k] = { branch: t.branch_id, shift: t.shift_id, wd: t.work_date, todo: 0, submitted: 0, sentback: 0 };
        if (t.status === "submitted") groups[k].submitted++;
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
        if (ended && g.submitted > 0) {
          const key = `taskunrev:${g.branch}:${g.shift}:${g.wd}`;
          const seen = await sb.from("notify_sent").select("event_key").eq("event_key", key).maybeSingle();
          if (!seen.data) {
            const nm = nextMainOf(g.shift, g.wd);
            if (nm && String(nm.date) === today) {
              const ld = (leadsToday ?? []).find((l: any) => (l.branch_id || "") === (g.branch || "") && l.shift_id === nm.shift);
              if (ld) await sendToEmp(ld.emp_id, "🧾 มีงานผลัดก่อนรอตรวจ", `กะ${shiftName[g.shift] ? " " + shiftName[g.shift] : ""} สาขา ${g.branch || "?"} ส่งงานแล้ว ${g.submitted} รายการ — ตรวจในเมนู "ตรวจผลัดก่อนหน้า"`, "taskunrev-" + g.branch + "-" + g.shift + "-" + g.wd);
            }
            await hrPush("🧾 งานรอตรวจค้าง", `กะ${shiftName[g.shift] ? " " + shiftName[g.shift] : ""} สาขา ${g.branch || "?"}: ส่งแล้ว ${g.submitted} รายการ ยังไม่ถูกตรวจ`, "taskunrev-hr-" + g.branch + "-" + g.shift + "-" + g.wd, g.branch);
            await sb.from("notify_sent").upsert({ event_key: key });
          }
        }
        // เก็บบรรทัดสำหรับสรุปสิ้นวัน (ทุกกลุ่มที่ยังค้าง)
        if (total > 0) eodLines.push(`สาขา ${g.branch || "?"} กะ${shiftName[g.shift] ? " " + shiftName[g.shift] : ""} (${g.wd}): ค้าง ${total}${g.submitted ? ` · รอตรวจ ${g.submitted}` : ""}`);
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
        }
      }
    } catch (acErr) { console.error("auto-checkout", acErr); }

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

// ============================================================
// emp-assistant — "น้องนิดา (พนักงาน)" ผู้ช่วย/เจ้าหน้าที่ส่วนกลางฝั่งพนักงาน
//   2 โหมด:
//   (1) ระดับสาขา (body.branch)          → งานค้างของสาขา (เดิม)
//   (2) รายบุคคล  (body.emp_id เพิ่มเข้ามา) → ข้อมูล "ของตัวเอง": ลา/โควตา, ลงเวลา,
//        สถานะวินัย (พูดกว้าง ๆ), ตารางเวร, งานของฉัน, การรับทราบระเบียบ
//   ขอบเขต: อ่านอย่างเดียว + แนะนำ + นำทาง (ไม่ยื่น/ไม่เขียน/ไม่ลบ) · เห็นเฉพาะข้อมูลของผู้ที่คุยเท่านั้น
//   ไม่แตะข้อมูล PDPA (บัตร/บัญชี/ที่อยู่) · ไม่เห็นข้อมูลคนอื่น/รายงานรวม HR
//   auth: body.branch = รหัสสาขา · body.emp_id = รหัสพนักงาน (ถ้ามี = ปลดล็อกโหมดรายบุคคล)
//   secret: GEMINI_API_KEY · ใช้ SERVICE_ROLE
//   deploy: supabase functions deploy emp-assistant --no-verify-jwt
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GKEY   = Deno.env.get("GEMINI_API_KEY")!;
const MODEL  = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });
const bkkToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const incDays = (a: string, b: string) => { const s = new Date(a + "T00:00:00Z").getTime(), e = new Date((b || a) + "T00:00:00Z").getTime(); return Math.round((e - s) / 86400000) + 1; };
// รอบประเมิน 21–20
function cycle21() {
  const [y, m, d] = bkkToday().split("-").map(Number);
  let endY = y, endM = m;
  if (d > 20) { endM = m + 1; if (endM > 12) { endM = 1; endY++; } }
  const end = `${endY}-${String(endM).padStart(2, "0")}-20`;
  let sM = endM - 1, sY = endY; if (sM < 1) { sM = 12; sY--; }
  const start = `${sY}-${String(sM).padStart(2, "0")}-21`;
  return { start, end };
}

type Ctx = { branch: string; emp_id: string; emp: any; emp_name: string; rules_version: string };

// ปลายทาง deep-link (client เติม origin ให้เอง)
const LINK = { handover: "./handover/", shelf: "./shelf/", qa: "./qa/", checkin: "./employee/", leave: "./", rules: "./rules/", staff: "./staff/", home: "./" };

// ============ เครื่องมือระดับสาขา (อ่านอย่างเดียว) — เดิม ============
async function shift_tasks(branch: string) {
  const today = bkkToday(), yday = addDays(today, -1);
  const { data } = await sb.from("task_assignments")
    .select("work_date,shift_id,title,status,emp_name,photos,photo_url,review_note")
    .eq("branch_id", branch).in("work_date", [today, yday]).neq("status", "approved").order("shift_id").limit(200);
  const tasks = (data ?? []).map((t: any) => ({ date: t.work_date, shift: t.shift_id, title: t.title, status: t.status, emp: t.emp_name, review_note: t.review_note, images: t.photos || (t.photo_url ? [t.photo_url] : []) }));
  return { count: tasks.length, tasks };
}
async function shelf_todo(branch: string) {
  const today = bkkToday(), month = today.slice(0, 7);
  const { data: asg } = await sb.from("shelf_assignments").select("shelf_id,emp_id").eq("branch_id", branch).eq("month", month);
  const rows = asg ?? []; if (!rows.length) return { count: 0, shelves: [] };
  const shIds = [...new Set(rows.map((r: any) => r.shelf_id))];
  const [shR, ckR, empR] = await Promise.all([
    sb.from("shelves").select("id,shelf_code,name").in("id", shIds),
    sb.from("shelf_checks").select("shelf_id,emp_id").eq("check_date", today).in("shelf_id", shIds),
    sb.from("employees").select("emp_id,name,nickname"),
  ]);
  const shBy: any = {}; (shR.data ?? []).forEach((s: any) => shBy[s.id] = s);
  const empBy: any = {}; (empR.data ?? []).forEach((e: any) => empBy[e.emp_id] = e.nickname || e.name);
  const done = new Set((ckR.data ?? []).map((c: any) => c.shelf_id + "|" + c.emp_id));
  const todo = rows.filter((r: any) => !done.has(r.shelf_id + "|" + r.emp_id))
    .map((r: any) => ({ shelf: (shBy[r.shelf_id] || {}).name || ("#" + r.shelf_id), code: (shBy[r.shelf_id] || {}).shelf_code || "", responsible: empBy[r.emp_id] || r.emp_id }));
  return { count: todo.length, shelves: todo };
}
async function qa_expiring(a: any, branch: string) {
  const days = Number(a.days) > 0 ? Number(a.days) : 14; const today = bkkToday(); const limit = addDays(today, days);
  const { data } = await sb.from("qa_items").select("name,expiry_date,qty,zone,status")
    .eq("branch_id", branch).eq("status", "on_shelf").not("expiry_date", "is", null).lte("expiry_date", limit).order("expiry_date").limit(80);
  return { within_days: days, count: (data ?? []).length, items: (data ?? []).map((i: any) => ({ name: i.name, expiry: i.expiry_date, qty: i.qty, zone: i.zone })) };
}
async function special_open(branch: string) {
  const { data: asg } = await sb.from("special_task_assignees").select("task_id,emp_id,status").eq("branch_id", branch).in("status", ["todo", "sent_back"]);
  const rows = asg ?? []; if (!rows.length) return { count: 0, items: [] };
  const ids = [...new Set(rows.map((r: any) => r.task_id))];
  const [tR, eR] = await Promise.all([
    sb.from("special_tasks").select("id,title,deadline,active").in("id", ids),
    sb.from("employees").select("emp_id,name,nickname"),
  ]);
  const tBy: any = {}; (tR.data ?? []).forEach((t: any) => tBy[t.id] = t);
  const eBy: any = {}; (eR.data ?? []).forEach((e: any) => eBy[e.emp_id] = e.nickname || e.name);
  const items = rows.filter((r: any) => tBy[r.task_id] && tBy[r.task_id].active !== false)
    .map((r: any) => ({ title: tBy[r.task_id].title, deadline: tBy[r.task_id].deadline, status: r.status, emp: eBy[r.emp_id] || r.emp_id }));
  return { count: items.length, items };
}
async function branch_summary(branch: string) {
  const [t, s, q, sp] = await Promise.all([shift_tasks(branch), shelf_todo(branch), qa_expiring({ days: 7 }, branch), special_open(branch)]);
  return { งานในกะค้าง: t.count, เชลฟ์ยังไม่ตรวจ: s.count, สินค้าใกล้หมดอายุ7วัน: q.count, งานพิเศษค้าง: sp.count };
}

// ============ เครื่องมือรายบุคคล (อ่านเฉพาะข้อมูลของผู้ที่คุย) — ใหม่ ============
function needEmp(ctx: Ctx) { return !ctx.emp_id ? { error: "ยังไม่ทราบว่าคุณคือใครค่ะ — กรุณากรอกรหัสพนักงานในช่องด้านบนของหน้าต่างแชทก่อนนะคะ" } : null; }

// โควตาลาที่เหลือ + ประวัติลาล่าสุดของฉัน
async function my_leave(ctx: Ctx) {
  const e = needEmp(ctx); if (e) return e; const emp = ctx.emp_id;
  const ym = bkkToday().slice(0, 7);
  const [rulesR, usageR, histR] = await Promise.all([
    sb.from("leave_types").select("*").eq("active", true).order("sort"),
    sb.from("leaves").select("type,start_date,end_date,status").eq("emp_id", emp).in("status", ["approved", "pending"]).gte("start_date", ym + "-01").lte("start_date", ym + "-31"),
    sb.from("leaves").select("start_date,end_date,type,status,hr_note").eq("emp_id", emp).order("start_date", { ascending: false }).limit(6),
  ]);
  const used: Record<string, number> = {};
  (usageR.data ?? []).forEach((l: any) => { used[l.type] = (used[l.type] || 0) + incDays(l.start_date, l.end_date || l.start_date); });
  const quota = (rulesR.data ?? []).map((r: any) => ({
    type: r.type, advance_days: r.advance_days, require_doc: r.require_doc, allow_backdate: r.allow_backdate,
    quota_per_month: r.quota_per_year, used: used[r.type] || 0,
    left: r.quota_per_year == null ? null : Math.max(0, r.quota_per_year - (used[r.type] || 0)),
  }));
  const recent = (histR.data ?? []).map((l: any) => ({ start: l.start_date, end: l.end_date, type: l.type, status: l.status, hr_note: l.hr_note }));
  return { month: ym, quota, recent };
}

// ข้อเสนอแนะเพิ่มเติมการลา (จาก HR) ที่ยังไม่ตอบ — เตือนให้พนักงานไปตอบ
async function my_leave_proposals(ctx: Ctx) {
  const e = needEmp(ctx); if (e) return e; const emp = ctx.emp_id;
  const { data } = await sb.from("leaves").select("leave_id,start_date,end_date,type,proposal_msg")
    .eq("emp_id", emp).eq("status", "proposed").is("response", null).order("proposal_at", { ascending: false });
  const pending = (data ?? []).map((l: any) => ({ start: l.start_date, end: l.end_date, type: l.type, message: l.proposal_msg }));
  return { count: pending.length, pending };
}

// สรุปการลงเวลารอบนี้ของฉัน (ข้อเท็จจริง: มา/สาย/ขาด/OT/ออกก่อน)
async function my_attendance(ctx: Ctx) {
  const er = needEmp(ctx); if (er) return er; const emp = ctx.emp_id;
  const c = cycle21(); const today = bkkToday(); const endEff = c.end < today ? c.end : today;
  const [attR, schR, lvR] = await Promise.all([
    sb.from("attendance").select("work_date,check_in,late_min,ot_hours,early_out_min").eq("emp_id", emp).gte("work_date", c.start).lte("work_date", endEff),
    sb.from("schedules").select("work_date,shift_id").eq("emp_id", emp).gte("work_date", c.start).lte("work_date", endEff),
    sb.from("leaves").select("start_date,end_date").eq("emp_id", emp).eq("status", "approved").lte("start_date", c.end).gte("end_date", c.start),
  ]);
  const att = attR.data ?? [], sch = schR.data ?? [], lv = lvR.data ?? [];
  const worked = new Set(att.filter((a: any) => a.check_in).map((a: any) => a.work_date));
  const onLeave = (d: string) => lv.some((l: any) => d >= l.start_date && d <= (l.end_date || l.start_date));
  const late = att.filter((a: any) => (a.late_min || 0) > 0);
  const schedPast = [...new Set(sch.filter((s: any) => s.shift_id).map((s: any) => s.work_date))].filter((d: string) => d < today);
  const absent = schedPast.filter((d: string) => !worked.has(d) && !onLeave(d)).length;
  const ot = Math.round(att.reduce((s: number, a: any) => s + (Number(a.ot_hours) || 0), 0) * 10) / 10;
  const early = att.filter((a: any) => (a.early_out_min || 0) > 0).length;
  return { cycle: c, days_worked: worked.size, late_count: late.length, late_total: late.reduce((s: number, a: any) => s + (a.late_min || 0), 0), absent, ot_hours: ot, early_out_days: early };
}

// สถานะวินัยแบบ "กว้าง ๆ" (ไม่บอกคะแนน/ระดับใบเตือนตรง ๆ) — ชี้ไปดูรายละเอียดที่หน้า "สถานะของฉัน"
async function my_standing(ctx: Ctx) {
  const er = needEmp(ctx); if (er) return er;
  const a: any = await my_attendance(ctx);
  const { data: rules } = await sb.from("discipline_rules").select("*").order("level");
  const rs = (rules ?? []).filter((r: any) => r.enabled !== false).sort((x: any, y: any) => y.level - x.level);
  let level = 0;
  for (const r of rs) {
    const hitL = r.late_min != null && a.late_count >= r.late_min;
    const hitA = r.absent_min != null && a.absent >= r.absent_min;
    if (hitL || hitA) { level = r.level; break; }
  }
  const standing = level === 0 ? "อยู่ในเกณฑ์ดี" : level <= 2 ? "เริ่มมีจุดที่ควรระวัง" : "อยู่ในจุดที่ควรรีบปรับ";
  const advice = level === 0 ? "รักษาแบบนี้ไว้นะคะ"
    : level <= 2 ? "มีสัญญาณเรื่องการมาสาย/ขาดในรอบนี้ ระวังในช่วงที่เหลือหน่อยนะคะ"
    : "แนะนำให้ปรับพฤติกรรมและปรึกษาหัวหน้า/ผู้จัดการ เพื่อไม่ให้กระทบสิทธิ์ค่ะ";
  // ไม่คืนคะแนน/ระดับเป็นตัวเลข — พูดกว้าง ๆ ตามนโยบาย
  return { standing, advice, detail_hint: "ดูรายละเอียด (คะแนน/ใบเตือนที่แน่นอน) ได้ที่หน้า 'สถานะของฉัน' ค่ะ" };
}

// ตารางเวรของฉัน วันนี้ + 7 วันข้างหน้า
async function my_schedule(ctx: Ctx) {
  const er = needEmp(ctx); if (er) return er; const emp = ctx.emp_id;
  const today = bkkToday(), to = addDays(today, 7);
  const [schR, shR, brR] = await Promise.all([
    sb.from("schedules").select("work_date,shift_id,branch_id,is_cover").eq("emp_id", emp).gte("work_date", today).lte("work_date", to).order("work_date"),
    sb.from("shifts").select("shift_id,name,start_time,end_time"),
    sb.from("branches").select("branch_id,name"),
  ]);
  const shBy: any = {}; (shR.data ?? []).forEach((s: any) => shBy[s.shift_id] = s);
  const brBy: any = {}; (brR.data ?? []).forEach((b: any) => brBy[b.branch_id] = b.name);
  const days = (schR.data ?? []).map((s: any) => ({
    date: s.work_date,
    shift: (shBy[s.shift_id] && shBy[s.shift_id].name) || s.shift_id || "-",
    time: shBy[s.shift_id] ? (String(shBy[s.shift_id].start_time || "").slice(0, 5) + "-" + String(shBy[s.shift_id].end_time || "").slice(0, 5)) : "",
    branch: brBy[s.branch_id] || s.branch_id || "", cover: !!s.is_cover,
  }));
  return { from: today, to, count: days.length, days };
}

// งานของฉันที่ค้าง (งานในกะ todo/ถูกตีกลับ + เชลฟ์ที่ยังไม่ตรวจวันนี้)
async function my_tasks(ctx: Ctx) {
  const er = needEmp(ctx); if (er) return er; const emp = ctx.emp_id;
  const today = bkkToday(), yday = addDays(today, -1), month = today.slice(0, 7);
  const [taskR, shAsgR, shCkR, shR] = await Promise.all([
    sb.from("task_assignments").select("work_date,shift_id,title,status,review_note").eq("emp_id", emp).in("work_date", [today, yday]).in("status", ["todo", "sent_back"]).limit(50),
    sb.from("shelf_assignments").select("shelf_id").eq("emp_id", emp).eq("month", month),
    sb.from("shelf_checks").select("shelf_id").eq("emp_id", emp).eq("check_date", today),
    sb.from("shelves").select("id,name,shelf_code"),
  ]);
  const pending = (taskR.data ?? []).map((t: any) => ({ date: t.work_date, shift: t.shift_id, title: t.title, status: t.status, review_note: t.review_note }));
  const shBy: any = {}; (shR.data ?? []).forEach((s: any) => shBy[s.id] = s);
  const doneToday = new Set((shCkR.data ?? []).map((c: any) => c.shelf_id));
  const shelvesTodo = (shAsgR.data ?? []).filter((a: any) => !doneToday.has(a.shelf_id))
    .map((a: any) => ({ shelf: (shBy[a.shelf_id] && shBy[a.shelf_id].name) || ("#" + a.shelf_id), code: (shBy[a.shelf_id] && shBy[a.shelf_id].shelf_code) || "" }));
  return { pending_tasks: pending, shelves_todo: shelvesTodo, pending_count: pending.length + shelvesTodo.length };
}

// สถานะการรับทราบระเบียบล่าสุด
async function rules_status(ctx: Ctx) {
  const er = needEmp(ctx); if (er) return er; const emp = ctx.emp_id;
  const ver = ctx.rules_version;
  const { data } = await sb.from("rule_acks").select("version,accepted_at").eq("emp_id", emp).order("accepted_at", { ascending: false }).limit(1);
  const last = (data ?? [])[0] || null;
  const accepted_latest = ver ? !!(last && last.version === ver) : null;
  return { current_version: ver || null, last_accepted_version: last ? last.version : null, accepted_latest };
}

// คู่มือพนักงาน (how-to + ระเบียบย่อ)
const HANDBOOK = `[คู่มือพนักงาน — สรุปตอบคำถามหน้างาน]
- ลงเวลา: เปิดกล้องให้เห็นใบหน้า + อยู่ในพื้นที่สาขา ปุ่มถึงกดได้ · กดเข้างานเมื่อเริ่มกะ กดออกเมื่อเลิก · อย่าลืมกดออก ไม่งั้นระบบปิดงานให้ OT=0 · ห้ามลงเวลาแทนกัน (ผิดวินัยร้ายแรง).
- ควบกะ: ถ้าทำต่อให้กด "ควบกะต่อ +2/+4 ชม." ในหน้าลงเวลา.
- งานในกะ: ทำแล้วกด "ส่งงาน" แนบรูปหลักฐาน · ถ้าถูกตีกลับจะขึ้นแถบแดง ให้แก้แล้วส่งใหม่.
- รับส่งผลัด 3 ส่วน: คุมผลัด(หัวหน้า)/งานที่ได้รับ/ตรวจผลัดก่อนหน้า.
- ดูแลเชลฟ์: ทำเช็กลิสต์ + ถ่ายรูปทุกวัน · เจอสินค้าใกล้หมดอายุ 1-2 เดือนให้เก็บออก(ถ่ายรูป+จำนวน) · ~4 เดือนเฝ้าระวัง บันทึกเข้า QA.
- จัดเรียงสินค้า: FIFO(มาก่อนขายก่อน) · หันหน้าสินค้า(Facing) · ดึงของหลังมาหน้า(Fronting) · ห้ามวางเกินเส้น Load Line ในตู้แช่.
- มาตรฐานบริการ 6 ขั้นตอน: ทัก-คิด-บอก-ถาม-แจ้ง-ขอบคุณ · SAVE Q: บริการ/สินค้าครบ/คุ้มค่า/สภาพแวดล้อม/คุณภาพ.
- ลา: ยื่นผ่านแอปและรออนุมัติก่อน จึงไม่นับขาด · ลาต้องดูโควตา/แจ้งล่วงหน้าตามประเภท · ลาป่วยควรมีใบรับรองแพทย์.`;
async function staff_handbook() { return { handbook: HANDBOOK }; }

const TOOLS: Record<string, (a: any, c: Ctx) => Promise<any>> = {
  shift_tasks: (_a, c) => shift_tasks(c.branch),
  shelf_todo: (_a, c) => shelf_todo(c.branch),
  qa_expiring: (a, c) => qa_expiring(a, c.branch),
  special_open: (_a, c) => special_open(c.branch),
  branch_summary: (_a, c) => branch_summary(c.branch),
  staff_handbook: () => staff_handbook(),
  my_leave: (_a, c) => my_leave(c),
  my_leave_proposals: (_a, c) => my_leave_proposals(c),
  my_attendance: (_a, c) => my_attendance(c),
  my_standing: (_a, c) => my_standing(c),
  my_schedule: (_a, c) => my_schedule(c),
  my_tasks: (_a, c) => my_tasks(c),
  rules_status: (_a, c) => rules_status(c),
};
const DECLS = [
  { name: "shift_tasks", description: "งานในกะของสาขาที่ยังไม่ผ่าน (วันนี้+เมื่อวาน) — ระบบแสดงเป็นการ์ดแยกกะ + ปุ่มไปหน้าส่งงานให้เอง", parameters: { type: "object", properties: {} } },
  { name: "shelf_todo", description: "เชลฟ์ในสาขาที่ยังไม่ได้ทำเช็กลิสต์วันนี้", parameters: { type: "object", properties: {} } },
  { name: "qa_expiring", description: "สินค้าใกล้หมดอายุในสาขาภายใน N วัน (ดีฟอลต์ 14)", parameters: { type: "object", properties: { days: { type: "number" } } } },
  { name: "special_open", description: "งานพิเศษของสาขาที่ยังไม่เสร็จ (todo/ถูกตีกลับ)", parameters: { type: "object", properties: {} } },
  { name: "branch_summary", description: "สรุปจำนวนงานค้างทั้งหมดของสาขา (งานในกะ/เชลฟ์/สินค้าใกล้หมดอายุ/งานพิเศษ)", parameters: { type: "object", properties: {} } },
  { name: "staff_handbook", description: "คู่มือ/วิธีทำงาน/ระเบียบย่อสำหรับพนักงาน (ลงเวลา, ควบกะ, ส่งงาน, เชลฟ์, FIFO, มาตรฐานบริการ, การลา)", parameters: { type: "object", properties: {} } },
  { name: "my_leave", description: "ข้อมูลการลา 'ของฉัน': โควตาที่เหลือแต่ละประเภทเดือนนี้ + กฎ (ต้องล่วงหน้ากี่วัน/ต้องมีเอกสารไหม) + ประวัติลาล่าสุดและสถานะ", parameters: { type: "object", properties: {} } },
  { name: "my_leave_proposals", description: "ข้อเสนอแนะเพิ่มเติมการลา 'ของฉัน' ที่ HR ส่งมาและยังไม่ได้ตอบ — ใช้เตือนพนักงานให้ไปตอบรับ/ปฏิเสธ", parameters: { type: "object", properties: {} } },
  { name: "my_attendance", description: "สรุปการลงเวลา 'ของฉัน' รอบนี้ (จำนวนวันทำงาน/มาสาย/ขาด/OT/ออกก่อน) — ข้อเท็จจริง", parameters: { type: "object", properties: {} } },
  { name: "my_standing", description: "สถานะวินัย 'ของฉัน' แบบภาพรวมกว้าง ๆ (ดี/ควรระวัง/ควรรีบปรับ) + คำแนะนำ — ไม่บอกคะแนน/ระดับใบเตือนเป็นตัวเลข", parameters: { type: "object", properties: {} } },
  { name: "my_schedule", description: "ตารางเวร 'ของฉัน' วันนี้ถึง 7 วันข้างหน้า (กะ/เวลา/สาขา/ไปทำแทน)", parameters: { type: "object", properties: {} } },
  { name: "my_tasks", description: "งาน 'ของฉัน' ที่ยังค้าง (งานในกะที่ยังไม่ทำ/ถูกตีกลับ + เชลฟ์ที่ยังไม่ตรวจวันนี้)", parameters: { type: "object", properties: {} } },
  { name: "rules_status", description: "สถานะการรับทราบระเบียบล่าสุดของฉัน (รับทราบฉบับปัจจุบันแล้วหรือยัง)", parameters: { type: "object", properties: {} } },
];

function sysFor(ctx: Ctx) {
  const who = ctx.emp_id ? `กำลังคุยกับพนักงาน: ${ctx.emp_name || ctx.emp_id} (รหัส ${ctx.emp_id})${ctx.branch ? ` · สาขา ${ctx.branch}` : ""}` : `ยังไม่ทราบรหัสพนักงาน (โหมดสาขาอย่างเดียว)`;
  return `คุณคือ "น้องนิดา" ผู้ช่วยฝั่งพนักงานของ 7-Eleven — เป็นด่านหน้าก่อนถึงหัวหน้า/ผู้จัดการ
กติกาการเรียกชื่อ: เวลาคุยกับพนักงาน ให้เรียกผู้มีอำนาจอนุมัติ/ตรวจงานว่า "ผู้จัดการ" เสมอ — ห้ามใช้คำว่า "HR" หรือ "ฝ่ายบุคคล" ในคำตอบ
${who} · วันนี้ ${bkkToday()} (เวลาไทย)

บุคลิก: "เข้มงวดกับกฎ อบอุ่นกับคน" — หนักแน่นด้วยข้อเท็จจริง+ระเบียบ ปฏิบัติเท่ากันทุกคน ไม่ยอมให้ต่อรอง/เลี่ยงกฎ แต่พูดสุภาพ ให้เกียรติ เสนอทางออกเสมอ ตอบไทยสั้นกระชับ ลงท้าย "ค่ะ"

หน้าที่ (เฉพาะข้อมูล "ของผู้ที่กำลังคุย"):
- การลา: ใช้ my_leave บอกโควตาที่เหลือ/กฎ/ประวัติ · ถ้าจะลาให้เช็กเงื่อนไขแล้ว "พาไปหน้าขอลา" (ระบบแนบปุ่มให้) — คุณไม่ยื่นใบลาแทน
- ข้อเสนอแนะเพิ่มเติมการลา: ใช้ my_leave_proposals เช็กว่ามีข้อเสนอจากผู้จัดการที่ยังไม่ตอบไหม ถ้ามีให้เตือนพนักงานสรุปสั้น ๆ แล้วพาไปตอบที่หน้าขอลา (ตอบรับ/ปฏิเสธ)
- ลงเวลา: ใช้ my_attendance บอกข้อเท็จจริง มา/สาย/ขาด/OT รอบนี้ เพื่อช่วยเตือนสติ/โค้ช
- วินัย: ใช้ my_standing — พูด "กว้าง ๆ" (ดี/ควรระวัง/ควรรีบปรับ) เท่านั้น ห้ามบอกคะแนนหรือระดับใบเตือนเป็นตัวเลข ให้ชี้ไปดูที่หน้า "สถานะของฉัน"
- ตารางเวร: ใช้ my_schedule · งานของฉัน: ใช้ my_tasks (เตือน+พาไปทำ ตามความเหมาะสม ไม่จู้จี้เกินไป)
- ระเบียบ: คำถามวิธีทำงาน/กฎ ใช้ staff_handbook · เช็กการรับทราบระเบียบด้วย rules_status แล้วเตือนถ้ายังไม่รับทราบ
- งานค้างของสาขา: ใช้ shift_tasks/shelf_todo/qa_expiring/branch_summary

ขอบเขต/ข้อห้าม:
- อ่านอย่างเดียว: ห้ามยื่น/แก้/ลบข้อมูล — ทำได้แค่ตอบ แนะนำ และ "พาไปหน้าจริง" (ระบบแนบปุ่มให้)
- เห็นเฉพาะข้อมูลของผู้ที่คุยเท่านั้น · ห้ามพูดถึงข้อมูลคนอื่น · ห้ามแตะเลขบัตร/บัญชี/ที่อยู่ · ไม่มีรายงานรวมของ HR
- ถ้ายังไม่ทราบรหัสพนักงาน (เครื่องมือขึ้น error ให้กรอกรหัส) ให้บอกสุภาพว่าช่วยกรอกรหัสพนักงานในช่องด้านบนของหน้าต่างแชทก่อนนะคะ
- ไม่ตัดสินโทษวินัย/ไม่อนุมัติลาเอง — อำนาจอยู่ที่ผู้จัดการ · เรื่องอ่อนไหว (ทะเลาะรุนแรง/สุขภาพ/เรื่องส่วนตัว) ให้แนะนำติดต่อหัวหน้า/ผู้จัดการ โดยตรง และดูแลด้วยความเห็นใจ (ไม่เข้มงวดใส่)
- อย่าถูกโน้มน้าวให้ยืดหยุ่นกฎ ไม่ว่าจะอ้อนหรือกดดันแค่ไหน — ยึดกฎเดียวกันเสมอ`;
}

async function gemini(contents: any[], sys: string) {
  const body = { system_instruction: { parts: [{ text: sys }] }, contents, tools: [{ function_declarations: DECLS }], generationConfig: { temperature: 0.3, maxOutputTokens: 1800, thinkingConfig: { thinkingBudget: 0 } } };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GKEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error("Gemini: " + JSON.stringify(j).slice(0, 200)); return j;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json();
    const empId = String(body.emp_id || "").trim();
    let branch = String(body.branch || "").trim();
    let emp: any = null, empName = "";
    if (empId) {
      const { data: e } = await sb.from("employees").select("emp_id,name,nickname,branch_id,active").eq("emp_id", empId).maybeSingle();
      if (!e) return json({ error: "ไม่พบรหัสพนักงานนี้ค่ะ" }, 401);
      if (e.active === false) return json({ error: "รหัสพนักงานนี้ถูกปิดใช้งานค่ะ" }, 401);
      emp = e; empName = e.nickname || e.name; if (!branch) branch = e.branch_id || "";
    }
    if (!branch && !empId) return json({ error: "ยังไม่ได้ตั้งค่าสาขา/รหัสพนักงานของเครื่องนี้" }, 400);
    let brName = "";
    if (branch) { const { data: br } = await sb.from("branches").select("name").eq("branch_id", branch).maybeSingle(); brName = (br && br.name) || ""; }
    const ctx: Ctx = { branch, emp_id: empId, emp, emp_name: empName, rules_version: String(body.rules_version || "") };
    const SYS = sysFor(ctx);

    const contents: any[] = (body.messages || []).slice(-10).map((m: any) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.text || "") }] }));
    let cards: any = null; const links: any[] = []; const seen = new Set<string>();
    const addLink = (label: string, url: string) => { if (!seen.has(url)) { seen.add(url); links.push({ label, url }); } };

    for (let i = 0; i < 5; i++) {
      const j = await gemini(contents, SYS);
      const cand = j.candidates?.[0]?.content;
      if (!cand) return json({ reply: "ขออภัยค่ะ ตอนนี้ประมวลผลไม่ได้" });
      const calls = (cand.parts || []).filter((p: any) => p.functionCall);
      if (calls.length === 0) {
        const text = (cand.parts || []).map((p: any) => p.text || "").join("").trim();
        return json({ reply: text || "ไม่มีข้อมูลค่ะ", cards, links, branch_name: brName, emp_name: empName });
      }
      contents.push({ role: "model", parts: cand.parts });
      const respParts: any[] = [];
      for (const c of calls) {
        const nm = c.functionCall.name, args = c.functionCall.args || {};
        const fn = TOOLS[nm]; let result: any;
        try { result = fn ? await fn(args, ctx) : { error: "ไม่มีเครื่องมือนี้" }; } catch (e) { result = { error: String(e) }; }
        // สร้างการ์ด + ปุ่ม deep-link (พังไม่ให้กระทบคำตอบ)
        try {
          if (nm === "shift_tasks" && Array.isArray(result.tasks) && result.tasks.length) {
            const g: Record<string, any> = {};
            for (const t of result.tasks) { const k = `${t.shift || "-"}|${t.date || ""}`; (g[k] ??= { shift: t.shift || "-", branch: "", date: t.date || "", items: [] }).items.push({ title: t.title, status: t.status, emp: t.emp, review_note: t.review_note, images: t.images || [] }); }
            cards = { type: "tasks", groups: Object.values(g) };
            addLink("➜ ไปหน้าส่งงาน", LINK.handover);
          } else if (nm === "shelf_todo" && result.count > 0) addLink("➜ ไปหน้าดูแลเชลฟ์", LINK.shelf);
          else if (nm === "qa_expiring" && result.count > 0) addLink("➜ ไปหน้า QA สินค้า", LINK.qa);
          else if (nm === "special_open" && result.count > 0) addLink("➜ ไปหน้างานพิเศษ", LINK.handover);
          else if (nm === "branch_summary") { if (result["งานในกะค้าง"]) addLink("➜ งานในกะ", LINK.handover); if (result["เชลฟ์ยังไม่ตรวจ"]) addLink("➜ ดูแลเชลฟ์", LINK.shelf); if (result["สินค้าใกล้หมดอายุ7วัน"]) addLink("➜ QA สินค้า", LINK.qa); }
          else if (nm === "my_leave") addLink("➜ ไปหน้าขอลา", LINK.leave);
          else if (nm === "my_leave_proposals" && result.count > 0) addLink("➜ ไปตอบข้อเสนอแนะ (หน้าขอลา)", LINK.leave);
          else if (nm === "my_standing" || nm === "my_attendance") addLink("➜ ดูสถานะของฉัน", LINK.home);
          else if (nm === "my_tasks") { if ((result.pending_tasks || []).length) addLink("➜ ไปหน้าส่งงาน", LINK.handover); if ((result.shelves_todo || []).length) addLink("➜ ไปหน้าดูแลเชลฟ์", LINK.shelf); }
          else if (nm === "rules_status" && result.accepted_latest === false) addLink("➜ ไปหน้ารับทราบระเบียบ", LINK.rules);
        } catch (_e) { /* การ์ดพัง ไม่ให้กระทบคำตอบ */ }
        respParts.push({ functionResponse: { name: nm, response: { result } } });
      }
      contents.push({ role: "user", parts: respParts });
    }
    return json({ reply: "ลองถามใหม่สั้น ๆ อีกครั้งนะคะ", cards, links, branch_name: brName, emp_name: empName });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

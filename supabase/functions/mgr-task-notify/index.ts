// ============================================================
// Supabase Edge Function: mgr-task-notify
// ยิง Flex แจ้ง "งาน ผจก. ใหม่" เข้ากลุ่ม ผจก. (LINE) + ปุ่มเปิดหน้างานในแอป
// - { task_id }  → การ์ดงานเดี่ยว (ปุ่มเปิดงานนั้นตรง ๆ)
// - { batch_id } → การ์ดสรุปใบเดียวสำหรับงานที่สั่ง "ทุกสาขา" (ปุ่มเปิดงานของสาขาตัวเอง)
// - { test:true }→ ยิงข้อความทดสอบเข้ากลุ่ม ผจก.
// กลุ่ม ผจก.: app_settings key='mgr_group_id' ถ้าไม่มี → line_groups.label LIKE '%ผจก%' (ไม่ ignored)
// เปิดงานในแอปยังต้องล็อกอิน ผจก. (PIN) เสมอ — task id เป็นแค่ตัวชี้ ไม่ใช่สิทธิ์
// Deploy: supabase functions deploy mgr-task-notify --no-verify-jwt
// Secret: LINE_CHANNEL_TOKEN (มีอยู่แล้ว) · optional APP_URL
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LINE_TOKEN   = Deno.env.get("LINE_CHANNEL_TOKEN") ?? "";
const APP_URL      = (Deno.env.get("APP_URL") ?? "https://factzaa.github.io/HR-7-eleven").replace(/\/+$/, "");
const MGR_LOGIN    = APP_URL + "/hr/?mtasks=1";    // ★ การ์ดสรุป (ไม่เจาะจงงานเดียว) → หน้าเลือกบทบาท (เจ้าของร้าน/ผจก.) แล้วเปิดบอร์ดงาน ผจก.
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const fmtDate = (d: string) => { try { return new Date(d + "T00:00:00Z").toLocaleDateString("th-TH", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }); } catch { return String(d); } };

async function pushLine(to: string, messages: unknown[]): Promise<boolean> {
  if (!LINE_TOKEN || !to) return false;
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
      body: JSON.stringify({ to, messages }),
    });
    if (!res.ok) { console.warn("LINE push failed", res.status, await res.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.warn("LINE push error", e); return false; }
}

// หากลุ่ม ผจก.
async function mgrGroupId(): Promise<string | null> {
  try {
    const { data: st } = await sb.from("app_settings").select("value").eq("key", "mgr_group_id").maybeSingle();
    if (st?.value) return String(st.value);
  } catch { /* ignore */ }
  try {
    const { data } = await sb.from("line_groups").select("group_id,label,ignored,last_message_at").ilike("label", "%ผจก%").order("last_message_at", { ascending: false });
    const hit = (data || []).find((g: any) => !g.ignored);
    return hit ? hit.group_id : null;
  } catch { return null; }
}

// รูปงานที่ ผจก./พนักงานส่ง — ส่วนใหญ่เก็บใน mgr_task_feed.photos (emp_photos มักว่าง)
async function taskWorkPhotos(taskId: any): Promise<string[]> {
  try {
    const { data } = await sb.from("mgr_task_feed").select("photos,created_at").eq("task_id", taskId).order("created_at", { ascending: false }).limit(30);
    const urls: string[] = [];
    for (const f of (data || [])) { if (Array.isArray(f.photos)) for (const u of f.photos) if (typeof u === "string" && u && !urls.includes(u)) urls.push(u); if (urls.length >= 8) break; }
    return urls.slice(0, 8);
  } catch { return []; }
}
// LINE ดึงรูปจาก URL เองโดยไม่มี token — รับเฉพาะ https + JPEG/PNG ที่โหลดได้จริง (กันการ์ดเสีย)
async function usablePhotos(arr: any, max = 6): Promise<string[]> {
  const https = (Array.isArray(arr) ? arr : []).filter((u: any) => typeof u === "string" && /^https:\/\//i.test(u)).slice(0, max);
  const checks = await Promise.all(https.map(async (u) => {
    try {
      let res = await fetch(u, { method: "HEAD" });
      if (res.status === 405 || res.status === 501) res = await fetch(u, { method: "GET" });
      const type = res.headers.get("content-type") || "";
      return res.ok && /^image\/(jpeg|jpg|png)/i.test(type) ? u : null;
    } catch { return null; }
  }));
  return checks.filter((u): u is string => !!u);
}
// กริดรูป 3 คอลัมน์ — กดที่รูปเด้งเข้าแอป (uri = ลิงก์งาน)
function photoGrid(urls: string[], uri: string) {
  const rows: any[] = [];
  for (let i = 0; i < urls.length; i += 3) {
    const cells: any[] = urls.slice(i, i + 3).map((u) => ({ type: "image", url: u, size: "full", aspectMode: "cover", aspectRatio: "1:1", action: { type: "uri", uri } }));
    while (cells.length < 3) cells.push({ type: "filler" });
    rows.push({ type: "box", layout: "horizontal", spacing: "sm", contents: cells });
  }
  return { type: "box", layout: "vertical", spacing: "sm", margin: "sm", contents: rows };
}
// นับ "งานในกะที่พนักงานส่ง รอ ผจก.ตรวจ" ต่อสาขา (task_assignments: submitted + ต้องให้ ผจก.ตรวจ + ยังไม่ตรวจ)
type RevItem = { title: string; emp: string };
async function reviewPending(): Promise<{ branch_id: string; name: string; count: number; oldest: string | null; items: RevItem[]; photos: string[] }[]> {
  const now = new Date();
  const today = new Date(now.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const prev = new Date(new Date(today + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
  const [{ data: ta }, { data: defs }, { data: shifts }, { data: brs }] = await Promise.all([
    sb.from("task_assignments").select("branch_id,task_def_id,shift_id,needs_mgr,status,mgr_checked_at,fix_done_at,work_date,submitted_at,title,emp_name,photos,photo_url").eq("status", "submitted").is("mgr_checked_at", null).in("work_date", [today, prev]).limit(3000),
    sb.from("task_defs").select("id,mgr_review"),
    sb.from("shifts").select("shift_id,mgr_review,start_time,end_time"),
    sb.from("branches").select("branch_id,name"),
  ]);
  const defMgr: Record<string, boolean> = {}; (defs || []).forEach((d: any) => (defMgr[d.id] = !!d.mgr_review));
  const shOff: Record<string, boolean> = {}, overnight: Record<string, boolean> = {};
  (shifts || []).forEach((s: any) => { shOff[s.shift_id] = (s.mgr_review === false); overnight[s.shift_id] = !!(s.start_time && s.end_time && String(s.end_time) <= String(s.start_time)); });
  const brName: Record<string, string> = {}; (brs || []).forEach((b: any) => (brName[b.branch_id] = b.name));
  const cnt: Record<string, number> = {}; const oldest: Record<string, string> = {};
  const items: Record<string, RevItem[]> = {}; const photos: Record<string, string[]> = {};
  (ta || []).forEach((t: any) => {
    const isResubmit = !!t.fix_done_at;
    if (!isResubmit && String(t.work_date) !== today && !overnight[t.shift_id]) return;   // ของเมื่อวานเก็บเฉพาะกะข้ามคืน
    const needs = t.needs_mgr === true || (!!defMgr[t.task_def_id] && !shOff[t.shift_id]);
    if (!needs || !t.branch_id) return;
    cnt[t.branch_id] = (cnt[t.branch_id] || 0) + 1;
    if (t.submitted_at && (!oldest[t.branch_id] || String(t.submitted_at) < oldest[t.branch_id])) oldest[t.branch_id] = String(t.submitted_at);
    (items[t.branch_id] = items[t.branch_id] || []).push({ title: String(t.title || "งาน").slice(0, 40), emp: String(t.emp_name || "") });
    const ph = Array.isArray(t.photos) ? t.photos : (t.photo_url ? [t.photo_url] : []);
    (photos[t.branch_id] = photos[t.branch_id] || []).push(...ph.filter((u: any) => typeof u === "string"));
  });
  return Object.keys(cnt).map((b) => ({ branch_id: b, name: brName[b] || b, count: cnt[b], oldest: oldest[b] || null, items: (items[b] || []).slice(0, 8), photos: (photos[b] || []).slice(0, 12) })).sort((a, b) => b.count - a.count);
}
// สถานะงานประจำวันวันนี้ ต่อสาขา (ส่งครบ/ยังขาดอะไรบ้าง)
async function dailyStatus(): Promise<Record<string, { name: string; total: number; done: number; missing: string[] }>> {
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const [{ data: defs }, { data: logs }, { data: brs }] = await Promise.all([
    sb.from("mgr_daily_defs").select("id,title,active,sort").eq("active", true).order("sort"),
    sb.from("mgr_daily_logs").select("branch_id,def_id,status").eq("work_date", today),
    sb.from("branches").select("branch_id,name"),
  ]);
  const defList = defs || [];
  const st: Record<string, Record<string, string>> = {};
  (logs || []).forEach((l: any) => { (st[l.branch_id] = st[l.branch_id] || {})[l.def_id] = l.status; });
  const out: Record<string, any> = {};
  (brs || []).forEach((b: any) => {
    const mine = st[b.branch_id] || {};
    let done = 0; const missing: string[] = [];
    defList.forEach((d: any) => { const s = mine[d.id]; if (s === "submitted" || s === "approved") done++; else missing.push(d.title); });
    out[b.branch_id] = { name: b.name, total: defList.length, done, missing };
  });
  return out;
}
function bubbleDailyIncomplete(name: string, done: number, total: number, cutoff: string, missing: string[], url: string) {
  const rows = missing.slice(0, 8).map((t) => ({ type: "box", layout: "baseline", spacing: "sm", contents: [
    { type: "text", text: "•", color: "#c2410c", size: "sm", flex: 0 },
    { type: "text", text: t, wrap: true, size: "sm", color: "#111111", flex: 9 },
  ] }));
  const body: any[] = [
    { type: "text", text: "🗓️ งานประจำวันยังไม่ครบ", weight: "bold", size: "lg", color: "#c2410c" },
    { type: "text", text: name + " · เลยเวลาตัด " + cutoff, size: "sm", color: "#8c8c8c" },
    { type: "separator", margin: "md" },
    { type: "box", layout: "baseline", margin: "md", contents: [
      { type: "text", text: "ส่งแล้ว", color: "#8c8c8c", size: "sm", flex: 3 },
      { type: "text", text: done + " / " + total + " รายการ", color: "#c2410c", size: "sm", flex: 6, weight: "bold" },
    ] },
    { type: "text", text: "ยังขาด:", size: "xs", color: "#8c8c8c", margin: "md" },
    { type: "box", layout: "vertical", margin: "sm", spacing: "sm", contents: rows },
  ];
  if (missing.length > 8) body.push({ type: "text", text: "…และอีก " + (missing.length - 8) + " รายการ", size: "xs", color: "#8c8c8c" });
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: body },
    footer: { type: "box", layout: "vertical", contents: [
      { type: "button", style: "primary", color: "#c2410c", action: { type: "uri", label: "เปิดส่งงานประจำวัน", uri: url } },
    ] },
  };
}
function digestRow(icon: string, label: string, value: string, color: string) {
  return { type: "box", layout: "baseline", spacing: "sm", contents: [
    { type: "text", text: icon + " " + label, size: "sm", color: "#333333", flex: 6 },
    { type: "text", text: value, size: "sm", color, flex: 3, align: "end", weight: "bold" },
  ] };
}
function bubbleDigest(name: string, dateStr: string, d: { dailyMiss: number; dailyTotal: number; dueToday: number; overdue: number; review: number }, url: string) {
  const rows: any[] = [
    digestRow("🗓️", "งานประจำวันยังไม่ส่ง", d.dailyTotal ? (d.dailyMiss + "/" + d.dailyTotal) : "-", d.dailyMiss ? "#c2410c" : "#15803d"),
    digestRow("📋", "งานมอบหมายครบวันนี้", d.dueToday + " งาน", d.dueToday ? "#c2410c" : "#8c8c8c"),
    digestRow("🔴", "เลยกำหนดค้างอยู่", d.overdue + " งาน", d.overdue ? "#dc2626" : "#8c8c8c"),
    digestRow("🔎", "รอตรวจ", d.review + " รายการ", d.review ? "#185FA5" : "#8c8c8c"),
  ];
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: [
      { type: "text", text: "☀️ สรุปงาน ผจก. วันนี้", weight: "bold", size: "lg", color: "#0F6E56" },
      { type: "text", text: name + " · " + dateStr, size: "sm", color: "#8c8c8c" },
      { type: "separator", margin: "md" },
      { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: rows },
    ] },
    footer: { type: "box", layout: "vertical", contents: [
      { type: "button", style: "primary", color: "#0F6E56", action: { type: "uri", label: "เปิดหน้างาน ผจก.", uri: url } },
    ] },
  };
}
// แถวรายการงาน (ชื่องาน + ผู้ส่ง) สำหรับการ์ดรอตรวจ
function revItemRows(items: RevItem[]) {
  return (items || []).slice(0, 6).map((it) => ({ type: "box", layout: "baseline", spacing: "sm", contents: [
    { type: "text", text: "•", color: "#185FA5", size: "sm", flex: 0 },
    { type: "text", text: it.title, wrap: true, size: "sm", color: "#111111", flex: 8 },
    ...(it.emp ? [{ type: "text", text: it.emp, size: "xs", color: "#8c8c8c", flex: 4, align: "end" }] : []),
  ] }));
}
// การ์ดงานรอตรวจของ "สาขาเดียว" (ใช้ตอนเตือนหลังจบกะ/ตามเงื่อนไข รายสาขา) — โชว์ชื่องาน + รูป
function bubbleReviewOne(name: string, count: number, reason: string, url: string, items: RevItem[] = [], photos: string[] = []) {
  const body: any[] = [
    { type: "text", text: "🔎 งานรอ ผจก.ตรวจ", weight: "bold", size: "lg", color: "#185FA5" },
    { type: "text", text: name + " · " + count + " รายการ", size: "sm", color: "#8c8c8c", wrap: true },
    { type: "separator", margin: "md" },
    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: revItemRows(items) },
  ];
  if (count > 6) body.push({ type: "text", text: "… และอีก " + (count - 6) + " รายการ", size: "xs", color: "#8c8c8c", margin: "sm" });
  if (reason) body.push({ type: "text", text: reason, wrap: true, size: "xs", color: "#8c8c8c", margin: "md" });
  if (photos.length) { body.push({ type: "text", text: "📷 รูปงานที่ส่ง " + photos.length + " รูป (แตะดู)", size: "xs", color: "#8c8c8c", margin: "md" }); body.push(photoGrid(photos, url)); }
  return {
    type: "bubble",
    ...(photos.length ? { hero: { type: "image", url: photos[0], size: "full", aspectRatio: "20:9", aspectMode: "cover", action: { type: "uri", uri: url } } } : {}),
    body: { type: "box", layout: "vertical", contents: body },
    footer: { type: "box", layout: "vertical", contents: [
      { type: "button", style: "primary", color: "#185FA5", action: { type: "uri", label: "เปิดตรวจงาน", uri: url } },
    ] },
  };
}
function bubbleReviewQueue(list: { name: string; count: number; items?: RevItem[]; photos?: string[] }[], url: string, photos: string[] = []) {
  const total = list.reduce((s, x) => s + x.count, 0);
  const rows: any[] = [];
  list.forEach((x) => {
    rows.push({ type: "box", layout: "baseline", spacing: "sm", contents: [
      { type: "text", text: "▪", color: "#185FA5", size: "sm", flex: 0 },
      { type: "text", text: x.name, wrap: true, size: "sm", color: "#111111", flex: 8, weight: "bold" },
      { type: "text", text: x.count + " รายการ", size: "xs", color: "#185FA5", flex: 3, align: "end" },
    ] });
    (x.items || []).slice(0, 4).forEach((it) => rows.push({ type: "text", text: "   • " + it.title + (it.emp ? (" — " + it.emp) : ""), wrap: true, size: "xs", color: "#8c8c8c" }));
  });
  const body: any[] = [
    { type: "text", text: "🔎 งานรอ ผจก.ตรวจ", weight: "bold", size: "lg", color: "#185FA5" },
    { type: "text", text: "พนักงานส่งงานในกะ รอ ผจก.กดผ่าน/ตีกลับ รวม " + total + " รายการ", wrap: true, size: "sm", color: "#8c8c8c" },
    { type: "separator", margin: "md" },
    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: rows },
  ];
  if (photos.length) { body.push({ type: "text", text: "📷 รูปงานที่ส่ง " + photos.length + " รูป (แตะดู)", size: "xs", color: "#8c8c8c", margin: "md" }); body.push(photoGrid(photos, url)); }
  return {
    type: "bubble",
    ...(photos.length ? { hero: { type: "image", url: photos[0], size: "full", aspectRatio: "20:9", aspectMode: "cover", action: { type: "uri", uri: url } } } : {}),
    body: { type: "box", layout: "vertical", contents: body },
    footer: { type: "box", layout: "vertical", contents: [
      { type: "button", style: "primary", color: "#185FA5", action: { type: "uri", label: "เปิดตรวจงาน", uri: url } },
    ] },
  };
}
function row2(label: string, value: string, color = "#111111") {
  return { type: "box", layout: "baseline", spacing: "sm", contents: [
    { type: "text", text: label, color: "#8c8c8c", size: "sm", flex: 4 },
    { type: "text", text: value, wrap: true, color, size: "sm", flex: 6, weight: "bold" },
  ] };
}

function penaltyText(t: any): string | null {
  const modes = String(t.penalty_mode || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!modes.length) return null;
  const parts: string[] = [];
  if (modes.includes("score") && Number(t.penalty_points) > 0) parts.push("หัก " + t.penalty_points + " แต้ม");
  if (modes.includes("warning")) parts.push("ตั้งต้นใบเตือน");
  if (modes.includes("note") && t.penalty_note) parts.push(String(t.penalty_note).slice(0, 60));
  else if (modes.includes("note")) parts.push("มีบทลงโทษ");
  return parts.length ? parts.join(" · ") : null;
}

function bubbleSingle(t: any, branchName: string, url: string, hero?: string) {
  const urgent = t.priority === "urgent";
  const body: any[] = [
    { type: "text", text: urgent ? "🔴 งาน ผจก. ใหม่ (ด่วน)" : "📋 งาน ผจก. ใหม่", weight: "bold", size: "lg", color: urgent ? "#dc2626" : "#15803d" },
    { type: "text", text: branchName, size: "sm", color: "#8c8c8c" },
    { type: "separator", margin: "md" },
    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: [
      row2("งาน", t.title || "-"),
      ...(t.assignee_name ? [row2("ผู้รับผิดชอบ", String(t.assignee_name))] : []),
      ...(t.due_date ? [row2("กำหนดส่ง", fmtDate(t.due_date), "#c2410c")] : []),
      ...(t.require_photo ? [row2("ต้องแนบรูป", "ใช่ (บังคับ)", "#c2410c")] : []),
      ...(penaltyText(t) ? [row2("บทลงโทษ", penaltyText(t)!, "#dc2626")] : []),
    ] },
  ];
  if (t.detail) body.push({ type: "text", text: "📝 " + String(t.detail).slice(0, 200), wrap: true, size: "xs", color: "#8c8c8c", margin: "md" });
  const bubble: any = {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: body },
    footer: { type: "box", layout: "vertical", contents: [
      { type: "button", style: "primary", color: urgent ? "#dc2626" : "#15803d", action: { type: "uri", label: "เปิดดูงาน", uri: url } },
    ] },
  };
  if (hero) bubble.hero = { type: "image", url: hero, size: "full", aspectRatio: "20:13", aspectMode: "cover", action: { type: "uri", uri: url } };   // รูปตัวอย่างจากเจ้าของร้าน
  return bubble;
}

function bubbleDone(t: any, branchName: string, url: string, workPhotos: string[] = []) {
  const doneAt = t.done_at ? new Date(t.done_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const body: any[] = [
    { type: "text", text: "✅ งาน ผจก. เสร็จแล้ว", weight: "bold", size: "lg", color: "#15803d" },
    { type: "text", text: branchName, size: "sm", color: "#8c8c8c" },
    { type: "separator", margin: "md" },
    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: [
      row2("งาน", t.title || "-"),
      ...(t.assignee_name ? [row2("ผู้รับผิดชอบ", String(t.assignee_name))] : []),
      ...(doneAt ? [row2("ปิดงานเมื่อ", doneAt, "#15803d")] : []),
    ] },
  ];
  if (workPhotos.length) {
    body.push({ type: "text", text: "📷 รูปส่งงาน " + workPhotos.length + " รูป (แตะเพื่อดูในแอป)", size: "xs", color: "#8c8c8c", margin: "md" });
    body.push(photoGrid(workPhotos, url));
  }
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: body },
    footer: { type: "box", layout: "vertical", contents: [
      { type: "button", style: "primary", color: "#15803d", action: { type: "uri", label: "เปิดดูงาน", uri: url } },
    ] },
  };
}
function remindRow(t: any, overdue: boolean) {
  const tail = overdue ? ("เลย " + t.days + " วัน") : (t.days === 0 ? "ครบวันนี้" : "อีก " + t.days + " วัน");
  const col = overdue ? "#dc2626" : "#c2410c";
  return { type: "box", layout: "baseline", spacing: "sm", contents: [
    { type: "text", text: "•", color: col, size: "sm", flex: 0 },
    { type: "text", text: (t.title || "-") + (t.branch ? (" (" + t.branch + ")") : ""), wrap: true, size: "sm", color: "#111111", flex: 8 },
    { type: "text", text: tail, size: "xs", color: col, flex: 3, align: "end" },
  ] };
}
function bubbleReview(t: any, branchName: string, url: string, workPhotos: string[] = []) {
  const at = t.updated_at ? new Date(t.updated_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const body: any[] = [
    { type: "text", text: "🔎 งาน ผจก. รอตรวจ", weight: "bold", size: "lg", color: "#185FA5" },
    { type: "text", text: branchName, size: "sm", color: "#8c8c8c" },
    { type: "separator", margin: "md" },
    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: [
      row2("งาน", t.title || "-"),
      ...(t.assignee_name ? [row2("ผู้รับผิดชอบ", String(t.assignee_name))] : []),
      ...(at ? [row2("ส่งเมื่อ", at)] : []),
    ] },
  ];
  if (workPhotos.length) {
    body.push({ type: "text", text: "📷 รูปส่งงาน " + workPhotos.length + " รูป (แตะเพื่อดูในแอป)", size: "xs", color: "#8c8c8c", margin: "md" });
    body.push(photoGrid(workPhotos, url));
  }
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: body },
    footer: { type: "box", layout: "vertical", contents: [
      { type: "button", style: "primary", color: "#185FA5", action: { type: "uri", label: "เปิดตรวจงาน", uri: url } },
    ] },
  };
}
function bubbleReject(t: any, branchName: string, url: string, note: string) {
  const body: any[] = [
    { type: "text", text: "↩️ งานถูกตีกลับให้แก้ไข", weight: "bold", size: "lg", color: "#dc2626" },
    { type: "text", text: branchName, size: "sm", color: "#8c8c8c" },
    { type: "separator", margin: "md" },
    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: [
      row2("งาน", t.title || "-"),
      ...(t.assignee_name ? [row2("ผู้รับผิดชอบ", String(t.assignee_name))] : []),
    ] },
  ];
  if (note) body.push({ type: "box", layout: "vertical", margin: "md", backgroundColor: "#FCEBEB", cornerRadius: "8px", paddingAll: "10px", contents: [
    { type: "text", text: "💬 เหตุผลที่ตีกลับ", size: "xs", color: "#A32D2D", weight: "bold" },
    { type: "text", text: note, wrap: true, size: "sm", color: "#A32D2D", margin: "xs" },
  ] });
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: body },
    footer: { type: "box", layout: "vertical", contents: [
      { type: "button", style: "primary", color: "#dc2626", action: { type: "uri", label: "เปิดแก้งาน", uri: url } },
    ] },
  };
}
function bubbleRemind(overdue: any[], soon: any[], url: string) {
  const total = overdue.length + soon.length;
  const body: any[] = [
    { type: "text", text: "⏰ เตือนงาน ผจก.", weight: "bold", size: "lg", color: "#c2410c" },
    { type: "text", text: "ยังไม่เสร็จรวม " + total + " งาน", size: "sm", color: "#8c8c8c" },
  ];
  if (overdue.length) {
    body.push({ type: "separator", margin: "md" });
    body.push({ type: "text", text: "🔴 เลยกำหนดแล้ว (" + overdue.length + ")", weight: "bold", size: "sm", color: "#dc2626", margin: "md" });
    body.push({ type: "box", layout: "vertical", margin: "sm", spacing: "sm", contents: overdue.slice(0, 10).map((t) => remindRow(t, true)) });
    if (overdue.length > 10) body.push({ type: "text", text: "…และอีก " + (overdue.length - 10) + " งาน", size: "xs", color: "#8c8c8c" });
  }
  if (soon.length) {
    body.push({ type: "separator", margin: "md" });
    body.push({ type: "text", text: "🟠 ใกล้ครบกำหนด (" + soon.length + ")", weight: "bold", size: "sm", color: "#c2410c", margin: "md" });
    body.push({ type: "box", layout: "vertical", margin: "sm", spacing: "sm", contents: soon.slice(0, 10).map((t) => remindRow(t, false)) });
    if (soon.length > 10) body.push({ type: "text", text: "…และอีก " + (soon.length - 10) + " งาน", size: "xs", color: "#8c8c8c" });
  }
  body.push({ type: "text", text: "กรุณาดำเนินการและปิดงานให้เรียบร้อยค่ะ", wrap: true, size: "xs", color: "#8c8c8c", margin: "md" });
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: body },
    footer: { type: "box", layout: "vertical", contents: [
      { type: "button", style: "primary", color: overdue.length ? "#dc2626" : "#c2410c", action: { type: "uri", label: "เปิดรายการงาน", uri: url } },
    ] },
  };
}
function bubbleBatch(t: any, count: number, url: string, hero?: string) {
  const urgent = t.priority === "urgent";
  const body: any[] = [
    { type: "text", text: urgent ? "🔴 งาน ผจก. ใหม่ (ด่วน)" : "📋 งาน ผจก. ใหม่", weight: "bold", size: "lg", color: urgent ? "#dc2626" : "#15803d" },
    { type: "text", text: "ทุกสาขา (" + count + " สาขา)", size: "sm", color: "#8c8c8c" },
    { type: "separator", margin: "md" },
    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: [
      row2("งาน", t.title || "-"),
      ...(t.due_date ? [row2("กำหนดส่ง", fmtDate(t.due_date), "#c2410c")] : []),
      ...(t.require_photo ? [row2("ต้องแนบรูป", "ใช่ (บังคับ)", "#c2410c")] : []),
      ...(penaltyText(t) ? [row2("บทลงโทษ", penaltyText(t)!, "#dc2626")] : []),
    ] },
    { type: "text", text: "แต่ละสาขากดปุ่มเพื่อเปิดงานของสาขาตัวเอง", wrap: true, size: "xs", color: "#8c8c8c", margin: "md" },
  ];
  if (t.detail) body.push({ type: "text", text: "📝 " + String(t.detail).slice(0, 200), wrap: true, size: "xs", color: "#8c8c8c", margin: "sm" });
  const bubble: any = {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: body },
    footer: { type: "box", layout: "vertical", contents: [
      { type: "button", style: "primary", color: urgent ? "#dc2626" : "#15803d", action: { type: "uri", label: "เปิดงานของสาขาฉัน", uri: url } },
    ] },
  };
  if (hero) bubble.hero = { type: "image", url: hero, size: "full", aspectRatio: "20:13", aspectMode: "cover", action: { type: "uri", uri: url } };
  return bubble;
}
// การ์ด "เสร็จครบทุกงาน" (สรุปใบเดียว/สาขา · เชิงบวก)
function bubbleAllDone(title: string, branchName: string, sub: string, url: string) {
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: [
      { type: "text", text: title, weight: "bold", size: "lg", color: "#15803d" },
      { type: "text", text: "สาขา" + branchName, size: "sm", color: "#8c8c8c" },
      { type: "separator", margin: "md" },
      { type: "text", text: sub, wrap: true, size: "sm", color: "#111111", margin: "md" },
    ] },
    footer: { type: "box", layout: "vertical", contents: [
      { type: "button", style: "primary", color: "#15803d", action: { type: "uri", label: "เปิดดูงาน", uri: url } },
    ] },
  };
}
// นับงาน ผจก. ที่ยัง "ค้าง" ต่อสาขา (mgr_tasks ถึงกำหนด + งานประจำวันขาด + งานรอตรวจ) — 0 ทั้งหมด = ครบ
async function mgrBranchRemaining(bid: string, today: string): Promise<{ mgr: number; daily: number; review: number; total: number }> {
  const [{ data: mt }, dstat, rev] = await Promise.all([
    sb.from("mgr_tasks").select("id").eq("branch_id", bid).neq("status", "done").not("due_date", "is", null).lte("due_date", today),
    dailyStatus(), reviewPending(),
  ]);
  const mgr = (mt || []).length;
  const ds = (dstat as any)[bid] || { missing: [] }; const daily = (ds.missing || []).length;
  const rv = rev.find((r) => r.branch_id === bid); const review = rv ? rv.count : 0;
  return { mgr, daily, review, total: mgr + daily + review };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));

    // ----- B1: สร้างงานประจำ (recurring) ตามรอบ · ไม่ขึ้นกับกลุ่มไลน์ (สร้างงานได้เสมอ) -----
    if (body.scan === "recurring") {
      const gid2 = await mgrGroupId();
      const bkkNow = new Date(Date.now() + 7 * 3600 * 1000);
      const today = bkkNow.toISOString().slice(0, 10);
      const weekday = bkkNow.getUTCDay();
      const dom = bkkNow.getUTCDate();
      const daysInMonth = new Date(Date.UTC(bkkNow.getUTCFullYear(), bkkNow.getUTCMonth() + 1, 0)).getUTCDate();
      let tq = sb.from("mgr_task_recurring").select("*").eq("active", true);
      if (body.id) tq = tq.eq("id", body.id);                                  // ทดสอบสร้างเฉพาะแม่แบบนี้
      else tq = tq.or(`last_run.is.null,last_run.neq.${today}`);               // รอบปกติ: ยังไม่สร้างวันนี้
      const { data: tmpls } = await tq;
      const list = tmpls || [];
      if (!list.length) return json({ ok: true, created: 0, note: "ไม่มีงานประจำที่ถึงรอบ" });
      const { data: allBr } = await sb.from("branches").select("branch_id,name");
      const brName: Record<string, string> = {}; (allBr || []).forEach((b: any) => (brName[b.branch_id] = b.name));
      let created = 0;
      for (const t of list) {
        let due = false;
        if (body.force) due = true;                                            // ทดสอบ: สร้างทันทีไม่สนรอบ
        else if (t.freq === "daily") due = true;
        else if (t.freq === "weekly") due = (Array.isArray(t.weekdays) ? t.weekdays.map(Number) : []).includes(weekday);
        else if (t.freq === "monthly") { let md = Number(t.monthday) || 1; if (md > daysInMonth) md = daysInMonth; due = (dom === md); }
        if (due) {
          const branches: string[] = t.all_branches ? (allBr || []).map((b: any) => b.branch_id) : (Array.isArray(t.branch_ids) ? t.branch_ids.map(String) : []);
          if (branches.length) {
            const dueDate = t.due_offset ? new Date(new Date(today + "T00:00:00Z").getTime() + Number(t.due_offset) * 86400000).toISOString().slice(0, 10) : today;
            const base = { title: t.title, detail: t.detail || null, priority: t.priority === "urgent" ? "urgent" : "normal", source: body.force ? "recurring-test" : "recurring", due_date: dueDate, status: "todo", created_by: body.force ? "ระบบ (ทดสอบงานประจำ)" : "ระบบ (งานประจำ)", require_photo: !!t.require_photo, penalty_mode: t.penalty_mode || null, penalty_points: t.penalty_points || null, penalty_note: t.penalty_note || null, penalty_warn_auto: !!t.penalty_warn_auto, task_type: t.task_type || "general", source_link: t.source_link || null };
            const batch_id = branches.length > 1 ? ("B" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)) : null;
            const rows = branches.map((b) => ({ ...base, branch_id: b, ...(batch_id ? { batch_id } : {}) }));
            const ins = await sb.from("mgr_tasks").insert(rows).select("id,branch_id");
            if (!ins.error && ins.data) {
              created += ins.data.length;
              try { await sb.from("mgr_task_feed").insert(ins.data.map((x: any) => ({ task_id: x.id, role: "system", sender_name: "ระบบ", kind: "assign", message: "งานประจำ: " + t.title }))); } catch (_e) { /* ignore */ }
              if (gid2 && LINE_TOKEN) {                              // แจ้งเข้ากลุ่ม (ถ้าตั้งกลุ่มไว้)
                const card = { title: t.title, detail: t.detail, priority: base.priority, due_date: dueDate, require_photo: t.require_photo, penalty_mode: t.penalty_mode, penalty_points: t.penalty_points, assignee_name: null };
                if (batch_id) { const burl = APP_URL + "/hr/?mtask_batch=" + encodeURIComponent(batch_id); await pushLine(gid2, [{ type: "flex", altText: "งาน ผจก. ใหม่ (ทุกสาขา): " + t.title, contents: bubbleBatch(card, rows.length, burl) }]); }
                else { const one = ins.data[0]; const surl = APP_URL + "/hr/?task=" + encodeURIComponent(String(one.id)); await pushLine(gid2, [{ type: "flex", altText: "งาน ผจก. ใหม่: " + t.title, contents: bubbleSingle(card, brName[one.branch_id] || one.branch_id, surl) }]); }
              }
            }
          }
        }
        try { await sb.from("mgr_task_recurring").update({ last_run: today }).eq("id", t.id); } catch (_e) { /* ignore */ }
      }
      return json({ ok: true, created });
    }

    if (!LINE_TOKEN) return json({ ok: false, error: "ยังไม่ได้ตั้ง LINE_CHANNEL_TOKEN" }, 400);
    const gid = await mgrGroupId();
    if (!gid) return json({ ok: true, sent: 0, note: "ยังไม่มีกลุ่ม ผจก. (ตั้งชื่อกลุ่มให้มีคำว่า 'ผจก.' หรือกำหนด app_settings.mgr_group_id)" });

    // ★ เช็ก "งาน ผจก. ครบทุกงาน" ต่อสาขา (เรียกจากการอนุมัติงานรอตรวจ/งานประจำวัน) → การ์ดสรุปใบเดียว กันซ้ำ/วัน
    if (body.event === "alldone_check" && body.branch_id) {
      const bkkT = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
      const rem = await mgrBranchRemaining(String(body.branch_id), bkkT);
      if (rem.total > 0) return json({ ok: true, sent: 0, note: "ยังทำไม่ครบ" });
      const rkey = "alldone_mgr:" + bkkT;
      let dup = false; try { const { data: lg } = await sb.from("mgr_review_log").select("branch_id").eq("branch_id", String(body.branch_id)).eq("log_date", bkkT).eq("rkey", rkey).maybeSingle(); dup = !!lg; } catch { /* */ }
      if (dup) return json({ ok: true, sent: 0, note: "แจ้งครบแล้ว" });
      let bn = String(body.branch_id); try { const { data: br } = await sb.from("branches").select("name").eq("branch_id", String(body.branch_id)).maybeSingle(); if (br?.name) bn = br.name; } catch { /* */ }
      const okA = await pushLine(gid, [{ type: "flex", altText: "เสร็จครบทุกงาน — สาขา" + bn, contents: bubbleAllDone("👔 งาน ผจก. เสร็จครบแล้ว", bn, "งาน ผจก. · งานประจำวัน · งานรอตรวจ ครบทั้งหมดวันนี้ 🎉", MGR_LOGIN) }]);
      if (okA) { try { await sb.from("mgr_review_log").upsert({ branch_id: String(body.branch_id), log_date: bkkT, rkey }, { onConflict: "branch_id,log_date,rkey" }); } catch { /* */ } }
      return json({ ok: okA, sent: okA ? 1 : 0, allDone: true });
    }

    if (body.test) {
      const ok = await pushLine(gid, [{ type: "text", text: "✅ ทดสอบแจ้งงาน ผจก. — กลุ่ม ผจก. เชื่อมต่อสำเร็จ" }]);
      return json({ ok, sent: ok ? 1 : 0 });
    }

    // ----- สรุปเช้า (Morning digest) รายสาขา -----
    if (body.scan === "digest") {
      let master = true;
      try { const { data: st } = await sb.from("app_settings").select("value").eq("key", "mgr_notify_on").maybeSingle(); if (st) master = st.value !== "0"; } catch { /* ignore */ }
      if (!master && !body.force) return json({ ok: true, sent: 0, note: "ปิดการแจ้งเตือน" });
      const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
      const dateStr = new Date(today + "T00:00:00Z").toLocaleDateString("th-TH", { timeZone: "UTC", day: "2-digit", month: "short" });
      const prev = new Date(new Date(today + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
      const [rev, dstat, { data: mt }, { data: brs }] = await Promise.all([
        reviewPending(), dailyStatus(),
        sb.from("mgr_tasks").select("branch_id,due_date,status").neq("status", "done").not("branch_id", "is", null).limit(3000),
        sb.from("branches").select("branch_id,name").order("branch_id"),
      ]);
      const revMap: Record<string, number> = {}; rev.forEach((r) => (revMap[r.branch_id] = r.count));
      const dueToday: Record<string, number> = {}, overdue: Record<string, number> = {};
      (mt || []).forEach((t: any) => { if (!t.due_date) return; const dd = String(t.due_date); if (dd === today) dueToday[t.branch_id] = (dueToday[t.branch_id] || 0) + 1; else if (dd < today) overdue[t.branch_id] = (overdue[t.branch_id] || 0) + 1; });
      const url = MGR_LOGIN;
      const msgs: any[] = [];
      // ★ การ์ดสรุป "งานรอ ผจก.ตรวจ" ใบเดียว/ทุกสาขา — ส่งครั้งเดียวตอนเช้า (แทนการเตือนถี่ ๆ)
      if (rev.length) { const rvPh = await usablePhotos(rev.flatMap((x) => (x as any).photos || [])); msgs.push({ type: "flex", altText: "งานรอ ผจก.ตรวจ รวม " + rev.reduce((s, x) => s + x.count, 0) + " รายการ", contents: bubbleReviewQueue(rev, url, rvPh) }); }
      for (const b of (brs || [])) {
        const ds = dstat[b.branch_id] || { total: 0, missing: [] };
        const d = { dailyMiss: (ds.missing || []).length, dailyTotal: ds.total || 0, dueToday: dueToday[b.branch_id] || 0, overdue: overdue[b.branch_id] || 0, review: revMap[b.branch_id] || 0 };
        if (!d.dailyMiss && !d.dueToday && !d.overdue && !d.review) continue;   // สาขาที่ไม่มีอะไรค้าง ข้าม
        msgs.push({ type: "flex", altText: "สรุปงาน ผจก. " + b.name, contents: bubbleDigest(b.name, dateStr, d, url) });
      }
      if (!msgs.length) return json({ ok: true, sent: 0, note: "ทุกสาขาไม่มีงานค้าง — ไม่ส่ง digest" });
      const ok = await pushLine(gid, msgs.slice(0, 5));
      return json({ ok, sent: ok ? msgs.length : 0 });
    }

    // ----- เตือน "งานรอ ผจก.ตรวจ" รายสาขา (หลังจบกะ + ตามเงื่อนไข) · cron เรียกถี่ ๆ -----
    if (body.scan === "review") {
      let master = true, perShift = false;
      try { const { data: st } = await sb.from("app_settings").select("key,value").in("key", ["mgr_notify_on", "mgr_review_pershift"]); (st || []).forEach((r: any) => { if (r.key === "mgr_notify_on") master = r.value !== "0"; if (r.key === "mgr_review_pershift") perShift = r.value === "1"; }); } catch { /* ignore */ }
      if (!master && !body.force) return json({ ok: true, sent: 0, note: "ปิดการแจ้งเตือน (mgr_notify_on=0)" });
      // ★ ดีฟอลต์: ไม่เตือน "งานรอตรวจ" รายกะ/ถี่ ๆ — ให้สรุปใบเดียวตอนเช้า (digest) แทน
      //   เปิดโหมดเตือนก่อน/หลังเลิกกะได้ด้วย mgr_review_pershift=1
      const bkkNow = new Date(Date.now() + 7 * 3600 * 1000);
      const today = bkkNow.toISOString().slice(0, 10);
      const nowMin = bkkNow.getUTCHours() * 60 + bkkNow.getUTCMinutes();
      const hourBucket = Math.floor(bkkNow.getUTCHours() / 4);
      const windowMin = Math.min(Math.max(Number(body.window) || 40, 10), 180);
      const [detail, { data: cfgs }, { data: shifts }, { data: logs }] = await Promise.all([
        reviewPending(),
        sb.from("mgr_branch_config").select("*"),
        sb.from("shifts").select("shift_id,end_time,mgr_review"),
        sb.from("mgr_review_log").select("branch_id,rkey").eq("log_date", today),
      ]);
      const cfgMap: Record<string, any> = {}; (cfgs || []).forEach((c: any) => (cfgMap[c.branch_id] = c));
      const shiftEnds = (shifts || []).filter((s: any) => s.end_time && s.mgr_review !== false);
      const logSet = new Set((logs || []).map((l: any) => l.branch_id + "|" + l.rkey));
      const parseMin = (t: string) => { const m = String(t).split(":"); return (+m[0]) * 60 + (+(m[1] || 0)); };
      const url = MGR_LOGIN;
      const msgs: any[] = []; const newLogs: any[] = [];
      for (const d of detail) {
        if (d.count <= 0) continue;
        const cfg = cfgMap[d.branch_id] || {};
        if (cfg.review_notify_on === false) continue;
        const offset = (cfg.review_after_shift != null ? Number(cfg.review_after_shift) : 30);
        const before = Number(cfg.review_before_shift) || 0;
        const minCount = Number(cfg.review_min_count) || 0;
        const minHours = Number(cfg.review_min_hours) || 0;
        let reason = ""; const keys: string[] = [];
        for (const sh of shiftEnds) {
          const endMin = parseMin(sh.end_time);
          if (before > 0) {                                          // โหมด: ก่อนจบกะ (เร่งตรวจก่อนหมดผลัด)
            const trig = endMin - before;
            if (nowMin >= trig && nowMin < trig + windowMin) {
              const k = "before:" + sh.shift_id;
              if (!logSet.has(d.branch_id + "|" + k)) { keys.push(k); reason = "ใกล้จบกะ — เร่งตรวจก่อนหมดผลัด"; }
            }
          }
          if (offset > 0) {                                          // โหมด: หลังจบกะ
            const trig = endMin + offset;
            if (nowMin >= trig && nowMin < trig + windowMin) {
              const k = "shift:" + sh.shift_id;
              if (!logSet.has(d.branch_id + "|" + k)) { keys.push(k); reason = reason || "ถึงรอบตรวจหลังจบกะ"; }
            }
          }
        }
        let condHit = false, oldHours = 0;                          // โหมด: ตามเงื่อนไข
        if (minCount > 0 && d.count >= minCount) condHit = true;
        if (minHours > 0 && d.oldest) { oldHours = (Date.now() - new Date(d.oldest).getTime()) / 3600000; if (oldHours >= minHours) condHit = true; }
        if (condHit) {
          const k = "cond:" + hourBucket;
          if (!logSet.has(d.branch_id + "|" + k)) { keys.push(k); reason = reason || ("งานค้างตรวจ" + (minCount && d.count >= minCount ? (" ≥ " + minCount + " รายการ") : "") + (minHours && oldHours >= minHours ? (" นานเกิน " + minHours + " ชม.") : "")); }
        }
        if (keys.length && perShift) {   // ส่งการ์ดรายกะเฉพาะเมื่อเปิดโหมด mgr_review_pershift=1
          const revPhotos = await usablePhotos((d as any).photos || []);   // รูปงานจริง (มีก็โชว์ ไม่มีก็ไม่โชว์)
          msgs.push({ type: "flex", altText: "งานรอ ผจก.ตรวจ " + d.name + " " + d.count + " รายการ", contents: bubbleReviewOne(d.name, d.count, reason, url, (d as any).items || [], revPhotos) });
          keys.forEach((k) => newLogs.push({ branch_id: d.branch_id, log_date: today, rkey: k }));
        }
      }
      // ★ A2: เตือน "งานประจำวันยังไม่ครบ" เมื่อเลยเวลาตัด (daily_cutoff รายสาขา)
      const parseM = (t: string) => { const m = String(t).split(":"); return (+m[0]) * 60 + (+(m[1] || 0)); };
      const anyCutoff = Object.values(cfgMap).some((c: any) => (c.daily_cutoff || "").trim());
      const dstat = anyCutoff ? await dailyStatus() : {};
      for (const bid of anyCutoff ? Object.keys(cfgMap) : []) {
        const cfg = cfgMap[bid]; const cut = (cfg.daily_cutoff || "").trim();
        if (cfg.review_notify_on === false || !cut) continue;
        const cutMin = parseM(cut);
        if (!(nowMin >= cutMin && nowMin < cutMin + windowMin)) continue;   // ยิงในหน้าต่างหลังเวลาตัด
        const ds = dstat[bid]; if (!ds || ds.total === 0 || ds.missing.length === 0) continue;   // ครบแล้ว/ไม่มีนิยามงาน
        const k = "daily";
        if (logSet.has(bid + "|" + k)) continue;
        msgs.push({ type: "flex", altText: "งานประจำวันยังไม่ครบ " + ds.name + " " + ds.done + "/" + ds.total, contents: bubbleDailyIncomplete(ds.name, ds.done, ds.total, cut, ds.missing, url) });
        newLogs.push({ branch_id: bid, log_date: today, rkey: k });
      }
      if (!msgs.length) return json({ ok: true, sent: 0, note: "ยังไม่ถึงรอบเตือนของสาขาใด" });
      const ok = await pushLine(gid, msgs.slice(0, 5));
      if (ok && newLogs.length) { try { await sb.from("mgr_review_log").upsert(newLogs, { onConflict: "branch_id,log_date,rkey" }); } catch (_e) { /* ตารางอาจยังไม่มี */ } }
      return json({ ok, sent: ok ? msgs.length : 0, branches: msgs.length });
    }

    // ----- ทวงงานค้าง (สแกนเลยกำหนด+ยังไม่เสร็จ · ทวงวันละครั้ง) -----
    if (body.scan === "remind") {
      const now = new Date();
      const dayMs = 86400000;
      // อ่านค่าตั้งจากหน้า "ตั้งค่างาน ผจก." (เปิด-ปิด / จำนวนวันใกล้ครบ)
      let cfgNotifyOn = true, cfgSoon = 0;
      try { const { data: st } = await sb.from("app_settings").select("key,value").in("key", ["mgr_notify_on", "mgr_soon_days"]);
        (st || []).forEach((r: any) => { if (r.key === "mgr_notify_on") cfgNotifyOn = r.value !== "0"; if (r.key === "mgr_soon_days") cfgSoon = Number(r.value) || 0; }); } catch { /* ignore */ }
      if (!cfgNotifyOn && !body.force) return json({ ok: true, sent: 0, note: "ปิดการแจ้งเตือนงาน ผจก. เข้ากลุ่ม (mgr_notify_on=0)" });
      const soonDays = Math.min(Math.max(Number(body.soon_days) || cfgSoon || 1, 1), 7);     // นับ "ใกล้ครบกำหนด" ล่วงหน้ากี่วัน (ดีฟอลต์ 1 = วันนี้+พรุ่งนี้)
      const today = new Date(now.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);   // วันที่ไทย
      const soonMax = new Date(new Date(today + "T00:00:00Z").getTime() + soonDays * dayMs).toISOString().slice(0, 10);
      const cutoff = new Date(now.getTime() - 20 * 3600 * 1000).toISOString();               // เตือนซ้ำได้หลังผ่าน 20 ชม.
      const { data: tasks } = await sb.from("mgr_tasks")
        .select("id,title,branch_id,due_date,status,last_remind_at")
        .neq("status", "done").not("due_date", "is", null).lte("due_date", soonMax)
        .or(`last_remind_at.is.null,last_remind_at.lt.${cutoff}`).limit(200);
      const list = tasks || [];   // อาจว่างได้ — ยังต้องเช็ค "งานรอ ผจก.ตรวจ" ต่อ
      const brIds = [...new Set(list.map((t: any) => t.branch_id).filter(Boolean))];
      const brMap: Record<string, string> = {};
      if (brIds.length) { const { data: brs } = await sb.from("branches").select("branch_id,name").in("branch_id", brIds); (brs || []).forEach((b: any) => (brMap[b.branch_id] = b.name)); }
      const t0 = new Date(today + "T00:00:00Z").getTime();
      const overdue: any[] = [], soon: any[] = [];
      for (const t of list) {
        const diff = Math.round((new Date(String(t.due_date) + "T00:00:00Z").getTime() - t0) / dayMs);   // <0 = เลยกำหนด, >=0 = ใกล้ครบ
        const item = { title: t.title, branch: t.branch_id ? (brMap[t.branch_id] || t.branch_id) : "", days: Math.abs(diff) };
        if (diff < 0) overdue.push(item); else soon.push(item);
      }
      overdue.sort((a, b) => b.days - a.days); soon.sort((a, b) => a.days - b.days);
      const url = MGR_LOGIN;
      const messages: any[] = [];
      if (overdue.length || soon.length) messages.push({ type: "flex", altText: "เตือนงาน ผจก. — เลยกำหนด " + overdue.length + " · ใกล้ครบ " + soon.length, contents: bubbleRemind(overdue, soon, url) });
      // ★ ไม่แนบการ์ด "งานรอ ผจก.ตรวจ" ในโหมด remind แล้ว — ย้ายไปสรุปใบเดียวตอนเช้า (digest)
      //   เดิม client ยิง scan:remind ทุกครั้งที่เปิดหน้า ผจก. → การ์ดรอตรวจเด้งถี่รัว ๆ
      if (!messages.length) return json({ ok: true, sent: 0, note: "ไม่มีงานที่ต้องเตือน" });
      const ok = await pushLine(gid, messages.slice(0, 5));
      if (ok && list.length) { try { await sb.from("mgr_tasks").update({ last_remind_at: now.toISOString() }).in("id", list.map((t: any) => t.id)); } catch (_e) { /* คอลัมน์อาจยังไม่มี */ } }
      // ★ เดิมบรรทัดนี้อ้าง rv ซึ่งประกาศไว้ในฟังก์ชันอื่น (mgrBranchRemaining) → ReferenceError ทุกครั้งที่มีงานต้องเตือน
      //   ข้อความส่งออกไปแล้วจริง แต่ฟังก์ชันคืน 500 ทุกครั้ง ทำให้ log เต็มไปด้วย error ปลอม
      //   โหมด remind ไม่แนบการ์ด "งานรอ ผจก.ตรวจ" แล้ว จึงไม่มี review_branches ให้รายงาน
      return json({ ok, sent: ok ? messages.length : 0, overdue: overdue.length, soon: soon.length });
    }

    // ----- การ์ดสรุปทุกสาขา -----
    if (body.batch_id) {
      const { data: rows } = await sb.from("mgr_tasks").select("*").eq("batch_id", String(body.batch_id));
      if (!rows || !rows.length) return json({ ok: true, sent: 0, note: "ไม่พบงานใน batch นี้" });
      const url = APP_URL + "/hr/?mtask_batch=" + encodeURIComponent(String(body.batch_id));
      const hero = (await usablePhotos(rows[0].hr_photos, 1))[0];            // รูปตัวอย่างเจ้าของร้าน (งานทุกสาขาใช้รูปเดียวกัน)
      const flex = { type: "flex", altText: "งาน ผจก. ใหม่ (ทุกสาขา): " + (rows[0].title || ""), contents: bubbleBatch(rows[0], rows.length, url, hero) };
      const ok = await pushLine(gid, [flex]);
      return json({ ok, sent: ok ? 1 : 0, count: rows.length });
    }

    // ----- การ์ดงานเดี่ยว -----
    if (body.task_id) {
      const { data: t } = await sb.from("mgr_tasks").select("*").eq("id", body.task_id).maybeSingle();
      if (!t) return json({ ok: true, sent: 0, note: "ไม่พบงาน" });
      let branchName = t.branch_id || "";
      if (t.branch_id) { const { data: br } = await sb.from("branches").select("name").eq("branch_id", t.branch_id).maybeSingle(); if (br?.name) branchName = br.name; }
      const url = APP_URL + "/hr/?task=" + encodeURIComponent(String(t.id));
      const done = body.event === "done";
      const review = body.event === "review";
      const reject = body.event === "reject";
      let flex: any;
      if (reject) {
        flex = { type: "flex", altText: "งาน ผจก. ถูกตีกลับ: " + (t.title || ""), contents: bubbleReject(t, branchName, url, String(body.note || "").slice(0, 300)) };
      } else if (review) {
        const work = await usablePhotos([...(Array.isArray(t.emp_photos) ? t.emp_photos : []), ...(await taskWorkPhotos(t.id))]);   // emp_photos + feed
        flex = { type: "flex", altText: "งาน ผจก. รอตรวจ: " + (t.title || ""), contents: bubbleReview(t, branchName, url, work) };
      } else if (done) {
        // ★ ไม่ส่งการ์ดรายชิ้นแล้ว — เช็กว่าสาขานี้ทำ "ครบทุกงาน" หรือยัง ถ้าครบ 100% → ส่งการ์ดสรุปใบเดียว (กันซ้ำ/วัน)
        const bkkT = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
        if (!t.branch_id) return json({ ok: true, sent: 0 });
        const rem = await mgrBranchRemaining(String(t.branch_id), bkkT);
        if (rem.total > 0) return json({ ok: true, sent: 0, note: "ยังทำไม่ครบ (mgr " + rem.mgr + " · daily " + rem.daily + " · review " + rem.review + ")" });
        const rkey = "alldone_mgr:" + bkkT;
        let dup = false; try { const { data: lg } = await sb.from("mgr_review_log").select("branch_id").eq("branch_id", String(t.branch_id)).eq("log_date", bkkT).eq("rkey", rkey).maybeSingle(); dup = !!lg; } catch { /* ตารางอาจยังไม่มี */ }
        if (dup) return json({ ok: true, sent: 0, note: "แจ้งครบแล้ววันนี้" });
        const okD = await pushLine(gid, [{ type: "flex", altText: "เสร็จครบทุกงาน — สาขา" + branchName, contents: bubbleAllDone("👔 งาน ผจก. เสร็จครบแล้ว", branchName, "งาน ผจก. · งานประจำวัน · งานรอตรวจ ครบทั้งหมดวันนี้ 🎉", MGR_LOGIN) }]);
        if (okD) { try { await sb.from("mgr_review_log").upsert({ branch_id: String(t.branch_id), log_date: bkkT, rkey }, { onConflict: "branch_id,log_date,rkey" }); } catch { /* */ } }
        return json({ ok: okD, sent: okD ? 1 : 0, allDone: true });
      } else {
        const hero = (await usablePhotos(t.hr_photos, 1))[0];                 // รูปตัวอย่างเจ้าของร้าน → hero (ถ้ามี)
        flex = { type: "flex", altText: "งาน ผจก. ใหม่: " + (t.title || ""), contents: bubbleSingle(t, branchName, url, hero) };
      }
      const ok = await pushLine(gid, [flex]);
      return json({ ok, sent: ok ? 1 : 0 });
    }

    return json({ ok: false, error: "ต้องระบุ task_id หรือ batch_id" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e && (e as any).message) || e) }, 500);
  }
});

// ============================================================
// Supabase Edge Function: staff-notify
// แจ้งเตือนเข้า "กลุ่มพนักงานสาขา" (branches.line_group_id) — แยกจากกลุ่ม ผจก.
// รองรับ: มอบหมายเชลฟ์ (shelf_assign) · มอบหมาย QA (qa_assign) · ปุ่มตามงาน HR
//   (expiry / shelf_due / qa_due = cron จะต่อในเฟสถัดไป)
// รูปประกอบ: ใช้รูปจริงถ้ามี (photos[0]=hero, ที่เหลือกริดล่าง) · ไม่มี → แบนเนอร์กลางตามประเภท
// Deploy: supabase functions deploy staff-notify --no-verify-jwt
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LINE_TOKEN   = Deno.env.get("LINE_CHANNEL_TOKEN") ?? "";
const APP_URL      = (Deno.env.get("APP_URL") ?? "https://factzaa.github.io/HR-7-eleven").replace(/\/+$/, "");
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const BANNER: Record<string, string> = {
  expiry: APP_URL + "/assets/notify/banner-expiry.png",
  shelf:  APP_URL + "/assets/notify/banner-shelf.png",
  warn:   APP_URL + "/assets/notify/banner-warn.png",
  qa:     APP_URL + "/assets/notify/banner-qa.png",
};

async function pushLine(to: string, messages: unknown[]): Promise<boolean> {
  if (!LINE_TOKEN || !to) return false;
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN }, body: JSON.stringify({ to, messages }) });
    if (!res.ok) { console.warn("LINE push", res.status, await res.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.warn("push err", e); return false; }
}
async function branchGroup(branchId: string): Promise<{ gid: string | null; name: string }> {
  try { const { data } = await sb.from("branches").select("name,line_group_id").eq("branch_id", branchId).maybeSingle(); return { gid: data?.line_group_id || null, name: data?.name || branchId }; } catch { return { gid: null, name: branchId }; }
}
// ดึงรูปสินค้าจริงของโฟลเดอร์ QA ในสาขานั้น (qa_items.photos = URL public) — เอาที่ใกล้หมดอายุก่อน
async function qaFolderPhotos(folderId: any, branchId: string): Promise<string[]> {
  if (!folderId) return [];
  try {
    const { data } = await sb.from("qa_items").select("photos,expiry_date").eq("folder_id", folderId).eq("branch_id", branchId).eq("status", "on_shelf").order("expiry_date", { ascending: true }).limit(60);
    const urls: string[] = [];
    for (const it of (data || [])) for (const u of (Array.isArray((it as any).photos) ? (it as any).photos : [])) { if (typeof u === "string" && /^https:\/\//i.test(u) && !urls.includes(u)) urls.push(u); }
    return urls.slice(0, 16);
  } catch { return []; }
}
// รับเฉพาะ https + JPEG/PNG ที่ LINE โหลดได้จริง
async function usablePhotos(arr: any, max = 8): Promise<string[]> {
  const https = (Array.isArray(arr) ? arr : []).filter((u: any) => typeof u === "string" && /^https:\/\//i.test(u)).slice(0, max);
  const checks = await Promise.all(https.map(async (u) => { try { let r = await fetch(u, { method: "HEAD" }); if (r.status === 405 || r.status === 501) r = await fetch(u, { method: "GET" }); const t = r.headers.get("content-type") || ""; return r.ok && /^image\/(jpeg|jpg|png)/i.test(t) ? u : null; } catch { return null; } }));
  return checks.filter((u): u is string => !!u);
}
function photoGrid(urls: string[], uri: string) {
  const rows: any[] = [];
  for (let i = 0; i < urls.length; i += 4) {
    const cells: any[] = urls.slice(i, i + 4).map((u) => ({ type: "image", url: u, size: "full", aspectMode: "cover", aspectRatio: "1:1", action: { type: "uri", uri } }));
    while (cells.length < 4) cells.push({ type: "filler" });
    rows.push({ type: "box", layout: "horizontal", spacing: "sm", contents: cells });
  }
  return { type: "box", layout: "vertical", spacing: "sm", margin: "sm", contents: rows };
}
// ★ ชื่อสาขาบางแห่งมีคำว่า "สาขา" อยู่ในชื่อแล้ว (เช่น "สาขา หน้า รพ.หล่มสัก") — เติมซ้ำจะได้ "สาขาสาขา"
const brLabel = (n: any) => "สาขา" + String(n || "").replace(/^\s*สาขา\s*/, "");
function row2(label: string, value: string, color = "#111111") {
  return { type: "box", layout: "baseline", spacing: "sm", contents: [
    { type: "text", text: label, color: "#8c8c8c", size: "sm", flex: 4 },
    { type: "text", text: value, wrap: true, color, size: "sm", flex: 7, weight: "bold" },
  ] };
}
function card(opts: { color: string; heroKind: string; hero?: string; title: string; sub: string; rows: any[]; note?: { text: string; color: string; bg: string }; photos: string[]; btn: string; url: string }) {
  const body: any[] = [
    { type: "text", text: opts.title, weight: "bold", size: "lg", color: opts.color },
    { type: "text", text: opts.sub, size: "sm", color: "#8c8c8c", wrap: true },
    { type: "separator", margin: "md" },
    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: opts.rows },
  ];
  if (opts.note) body.push({ type: "box", layout: "vertical", margin: "md", backgroundColor: opts.note.bg, cornerRadius: "8px", paddingAll: "10px", contents: [{ type: "text", text: opts.note.text, wrap: true, size: "xs", color: opts.note.color }] });
  // ★ ตัดแถบหัวรูป/แบนเนอร์ออกทั้งหมด — แบนเนอร์สีทึบกินพื้นที่ครึ่งการ์ดโดยไม่ให้ข้อมูลอะไรเลย
  //   รูปจริงที่เคยถูกใช้เป็นหัวการ์ด (opts.hero) ย้ายลงมารวมในตารางรูปด้านล่าง ไม่มีรูปไหนหาย
  const pics = opts.hero ? [opts.hero].concat(opts.photos) : opts.photos;
  if (pics.length) { body.push({ type: "text", text: "📷 รูป " + pics.length + " รูป (แตะเพื่อดู/สไลด์)", size: "xs", color: "#8c8c8c", margin: "md" }); body.push(photoGrid(pics, opts.url)); }
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: body },
    footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: opts.color, action: { type: "uri", label: opts.btn, uri: opts.url } }] },
  };
}

// ---------- ตัวช่วยวัน/เวลา (Bangkok = UTC+7) ----------
const TZ = 7 * 3600 * 1000;
function bkkDateStr(d = new Date(Date.now() + TZ)): string { return d.toISOString().slice(0, 10); }
function addDaysStr(s: string, n: number): string { return new Date(new Date(s + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10); }
// กะหลักของพนักงาน = เช้า/บ่าย/ดึก เท่านั้น (ข้ามกะพิเศษ เช่น 8.00-18.00, ผจก.)
function isMainStaffShift(s: any): boolean {
  // ★ กะหลัก = แถวที่ main_shift ชี้กลับมาที่ตัวเอง (กติกาเดียวกับหน้าเว็บ hr-api.js/index.html)
  //   เดิมเดาจากชื่อกะ/รหัส M,A,N ที่ฝังไว้ → พอ HR เปลี่ยนชื่อกะหรือเพิ่มกะหลักรหัสใหม่ แจ้งเตือนจะเงียบไปเฉย ๆ
  if (s && s.main_shift != null && String(s.main_shift) !== "") return String(s.main_shift) === String(s.shift_id);
  const nm = String(s?.name || ""); const id = String(s?.shift_id || "");   // สำรอง: ฐานยังไม่ได้ตั้ง main_shift
  return /เช้า|บ่าย|ดึก/.test(nm) || ["M", "A", "N"].includes(id);
}
// วันที่แบบไทย 26/08/2569 — ใส่ในการ์ดทุกใบ กันคนอ่านสับสนว่าเป็นงานของวันไหน
const fmtThaiDate = (d: string) => { try { return new Date(String(d) + "T00:00:00Z").toLocaleDateString("th-TH", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }); } catch { return String(d); } };
function daysBetween(a: string, b: string): number { return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000); }
function weekMondayStr(s = bkkDateStr()): string { const d = new Date(s + "T00:00:00Z"); const dow = (d.getUTCDay() + 6) % 7; return addDaysStr(s, -dow); }

// ---------- กันซ้ำ (staff_notify_log) ----------
async function already(rkey: string): Promise<boolean> { try { const { data, error } = await sb.from("staff_notify_log").select("id").eq("rkey", rkey).maybeSingle(); if (error) { console.warn("dedup already() error (ตาราง staff_notify_log อาจยังไม่ถูกสร้าง — รัน staff_notify_log.sql):", error.message); return false; } return !!data; } catch (e) { console.warn("dedup already() throw:", e); return false; } }
async function mark(rkey: string, branchId: string): Promise<boolean> { try { const { error } = await sb.from("staff_notify_log").upsert({ rkey, branch_id: branchId }, { onConflict: "rkey" }); if (error) { console.warn("dedup mark() FAILED (การกันซ้ำจะไม่ทำงาน — รัน staff_notify_log.sql):", error.message); return false; } return true; } catch (e) { console.warn("dedup mark() throw:", e); return false; } }
// จองคีย์ "ก่อนส่ง" แบบอะตอมมิก: 'new'=ยังไม่เคยส่ง (ส่งได้) · 'dup'=เคยส่งแล้ว (ข้าม) · 'error'=ตารางมีปัญหา
async function reserve(rkey: string, branchId: string): Promise<"new" | "dup" | "error"> {
  try {
    const { error } = await sb.from("staff_notify_log").insert({ rkey, branch_id: branchId });
    if (!error) return "new";
    if (String((error as any).code) === "23505" || /duplicate|unique/i.test(error.message || "")) return "dup";
    console.warn("reserve() error (รัน staff_notify_log.sql?):", error.message); return "error";
  } catch (e) { console.warn("reserve() throw:", e); return "error"; }
}
async function unreserve(rkey: string): Promise<void> { try { await sb.from("staff_notify_log").delete().eq("rkey", rkey); } catch { /* */ } }

// ---------- แผนที่ สาขา → กลุ่มพนักงาน ----------
async function branchGroups(): Promise<Record<string, { gid: string; name: string }>> {
  const m: Record<string, { gid: string; name: string }> = {};
  try { const { data } = await sb.from("branches").select("branch_id,name,line_group_id"); (data || []).forEach((b: any) => { if (b.line_group_id) m[String(b.branch_id)] = { gid: b.line_group_id, name: b.name || b.branch_id }; }); } catch { /* */ }
  return m;
}

// ---------- ตั้งค่าแจ้งเตือนต่อสาขา (staff_notify_cfg) — ไม่มีแถว = ค่าดีฟอลต์ ----------
type Cfg = { enabled: boolean; shelf_min: number; qa_due_days: number; expiry_days: number[] };
const DEF_CFG: Cfg = { enabled: true, shelf_min: 3, qa_due_days: 2, expiry_days: [30, 14, 7, 3] };
async function loadCfg(): Promise<Record<string, Cfg>> {
  const m: Record<string, Cfg> = {};
  try {
    const { data } = await sb.from("staff_notify_cfg").select("*");
    (data || []).forEach((c: any) => {
      const exp = String(c.expiry_days || "30,14,7,3").split(/[, ]+/).map((x: string) => parseInt(x, 10)).filter((n: number) => n > 0).sort((a: number, b: number) => b - a);
      m[String(c.branch_id)] = { enabled: c.enabled !== false, shelf_min: c.shelf_min != null ? c.shelf_min : 3, qa_due_days: c.qa_due_days != null ? c.qa_due_days : 2, expiry_days: exp.length ? exp : DEF_CFG.expiry_days };
    });
  } catch { /* */ }
  return m;
}
function cfgOf(map: Record<string, Cfg>, bid: string): Cfg { return map[bid] || DEF_CFG; }

// ===== scan:expiry — สินค้าใกล้หมดอายุ 30/14/7/3 วัน (รายสาขา) =====
async function scanExpiry(): Promise<number> {
  const today = bkkDateStr(); const horizon = addDaysStr(today, 30);
  const groups = await branchGroups(); const cfg = await loadCfg();
  const { data: items } = await sb.from("qa_items").select("id,name,expiry_date,branch_id,photos").eq("status", "on_shelf").gte("expiry_date", today).lte("expiry_date", horizon).order("expiry_date", { ascending: true });
  const perBranch: Record<string, any[]> = {};
  for (const it of (items || [])) {
    const bid = String((it as any).branch_id || ""); if (!bid || !groups[bid]) continue;
    const c = cfgOf(cfg, bid); if (!c.enabled) continue;
    const dl = daysBetween(today, (it as any).expiry_date); if (dl < 0) continue;
    const th = c.expiry_days.filter((t) => dl <= t).sort((a, b) => a - b)[0]; if (th === undefined) continue;
    const rkey = "exp:" + (it as any).id + ":" + th;
    if (await already(rkey)) continue;
    (perBranch[bid] = perBranch[bid] || []).push({ it, dl, rkey });
  }
  let sent = 0;
  for (const bid of Object.keys(perBranch)) {
    const g = groups[bid]; const list = perBranch[bid]; if (!list.length) continue;
    list.sort((a, b) => a.dl - b.dl);
    const url = APP_URL + "/qa/";
    const photos = await usablePhotos(list.flatMap((x) => Array.isArray(x.it.photos) ? x.it.photos : []));
    const rows = list.slice(0, 10).map((x) => { const col = x.dl <= 3 ? "#dc2626" : x.dl <= 7 ? "#b45309" : "#a06515"; return row2(String(x.it.name || "สินค้า").slice(0, 22), "เหลือ " + x.dl + " วัน · " + x.it.expiry_date, col); });
    const more = list.length > 10 ? ("… และอีก " + (list.length - 10) + " รายการ — เปิดแอปดูทั้งหมด") : "กรุณาตรวจ FIFO / ลดราคา / เก็บออก ตามระเบียบ";
    const flex = { type: "flex", altText: "สินค้าใกล้หมดอายุ " + list.length + " รายการ (" + brLabel(g.name) + ")", contents: card({
      color: "#dc2626", heroKind: "expiry", hero: photos[0], title: "⏰ สินค้าใกล้หมดอายุ", sub: brLabel(g.name) + " · " + list.length + " รายการต้องจัดการ",
      rows, note: { text: more, color: "#991b1b", bg: "#fef2f2" }, photos: photos.slice(1), btn: "เปิดรายการ QA", url }) };
    const ok = await pushLine(g.gid, [flex]);
    if (ok) { sent++; for (const x of list) await mark(x.rkey, bid); }
  }
  return sent;
}

// ===== scan:shelf_due — เชลฟ์ยังไม่ครบเกณฑ์รายสัปดาห์ (จ.–อา.) =====
async function scanShelfDue(): Promise<number> {
  const today = bkkDateStr(); const monday = weekMondayStr(today); const month = today.slice(0, 7);
  const groups = await branchGroups(); const cfg = await loadCfg();
  const { data: asg } = await sb.from("shelf_assignments").select("emp_id,shelf_id,branch_id,month").eq("month", month);
  if (!asg || !asg.length) return 0;
  const shIds = [...new Set(asg.map((a: any) => a.shelf_id))];
  const { data: shelves } = await sb.from("shelves").select("id,name,shelf_code,branch_id").in("id", shIds);
  const shBy: Record<string, any> = {}; (shelves || []).forEach((s: any) => shBy[s.id] = s);
  const empIds = [...new Set(asg.map((a: any) => a.emp_id))];
  const { data: emps } = await sb.from("employees").select("emp_id,name,nickname").in("emp_id", empIds);
  const nmBy: Record<string, string> = {}; (emps || []).forEach((e: any) => nmBy[e.emp_id] = e.nickname || e.name || e.emp_id);
  const { data: checks } = await sb.from("shelf_checks").select("emp_id,shelf_id,check_date").gte("check_date", monday).lte("check_date", today);
  const cnt: Record<string, number> = {}; (checks || []).forEach((c: any) => { const k = c.emp_id + "|" + c.shelf_id; cnt[k] = (cnt[k] || 0) + 1; });
  const perBranch: Record<string, Record<string, any[]>> = {};
  for (const a of asg as any[]) {
    const bid = String(a.branch_id || (shBy[a.shelf_id] && shBy[a.shelf_id].branch_id) || ""); if (!bid || !groups[bid]) continue;
    const c = cfgOf(cfg, bid); if (!c.enabled) continue;
    const done = cnt[a.emp_id + "|" + a.shelf_id] || 0; if (done >= c.shelf_min) continue;
    const rkey = "shelfdue:" + a.emp_id + ":" + a.shelf_id + ":" + today; if (await already(rkey)) continue;
    const bb = perBranch[bid] = perBranch[bid] || {}; (bb[a.emp_id] = bb[a.emp_id] || []).push({ a, done, rkey });
  }
  let sent = 0;
  for (const bid of Object.keys(perBranch)) {
    const g = groups[bid]; const url = APP_URL + "/shelf/"; const TH = cfgOf(cfg, bid).shelf_min;
    for (const emp of Object.keys(perBranch[bid])) {
      const list = perBranch[bid][emp]; if (!list.length) continue;
      const rows = list.map((x) => { const s = shBy[x.a.shelf_id] || {}; const nm = (s.shelf_code ? ("[" + s.shelf_code + "] ") : "") + (s.name || ("#" + x.a.shelf_id)); return row2(nm.slice(0, 22), "ทำ " + x.done + "/" + TH + " ครั้ง", "#b45309"); });
      const flex = { type: "flex", altText: "เชลฟ์ยังไม่ครบเกณฑ์ (" + (nmBy[emp] || emp) + ")", contents: card({
        color: "#d97706", heroKind: "warn", title: "⚠️ เชลฟ์ยังดูแลไม่ครบสัปดาห์นี้", sub: brLabel(g.name) + " · " + (nmBy[emp] || emp),
        rows, note: { text: "ระเบียบ: ดูแล ≥ " + TH + " ครั้ง/สัปดาห์ · ไม่ครบถูกหัก 5 คะแนน/สัปดาห์ (แจ้งเตือน — HR พิจารณาหักเอง)", color: "#92400e", bg: "#fffbeb" },
        photos: [], btn: "เปิดงานเชลฟ์", url }) };
      const ok = await pushLine(g.gid, [flex]);
      if (ok) { sent++; for (const x of list) await mark(x.rkey, bid); }
    }
  }
  return sent;
}

// ===== scan:qa_due — QA มอบหมายแล้วแต่ยังไม่บันทึกสินค้า ≥ 2 วัน =====
async function scanQaDue(): Promise<number> {
  const today = bkkDateStr(); const groups = await branchGroups(); const cfg = await loadCfg();
  const { data: folders } = await sb.from("qa_folders").select("id,title,created_at,active").eq("active", true);
  if (!folders || !folders.length) return 0;
  const fids = folders.map((f: any) => f.id);
  const [{ data: asg }, { data: items }] = await Promise.all([
    sb.from("qa_folder_assignees").select("folder_id,emp_id,branch_id").in("folder_id", fids),
    sb.from("qa_items").select("folder_id,branch_id").in("folder_id", fids),
  ]);
  const has = new Set<string>(); (items || []).forEach((i: any) => has.add(i.folder_id + "|" + String(i.branch_id || "")));
  const empIds = [...new Set((asg || []).map((a: any) => a.emp_id))];
  const { data: emps } = await sb.from("employees").select("emp_id,name,nickname").in("emp_id", empIds);
  const nmBy: Record<string, string> = {}; (emps || []).forEach((e: any) => nmBy[e.emp_id] = e.nickname || e.name || e.emp_id);
  const fBy: Record<string, any> = {}; folders.forEach((f: any) => fBy[f.id] = f);
  const whoBy: Record<string, string[]> = {}; const keyBy: Record<string, { fid: any; bid: string }> = {};
  for (const a of (asg || []) as any[]) { const bid = String(a.branch_id || ""); if (!bid) continue; const key = a.folder_id + "|" + bid; (whoBy[key] = whoBy[key] || []).push(nmBy[a.emp_id] || a.emp_id); keyBy[key] = { fid: a.folder_id, bid }; }
  let sent = 0;
  for (const key of Object.keys(keyBy)) {
    if (has.has(key)) continue;
    const { fid, bid } = keyBy[key]; const f = fBy[fid]; if (!f || !groups[bid]) continue;
    const c = cfgOf(cfg, bid); if (!c.enabled) continue;
    const ageDays = f.created_at ? Math.floor((Date.now() - new Date(f.created_at).getTime()) / 86400000) : 99; if (ageDays < c.qa_due_days) continue;
    const rkey = "qadue:" + fid + ":" + bid + ":" + today; if (await already(rkey)) continue;
    const g = groups[bid]; const url = APP_URL + "/qa/?folder=" + encodeURIComponent(String(fid));
    const who = [...new Set(whoBy[key] || [])].join(", ");
    const flex = { type: "flex", altText: "งาน QA ยังไม่เริ่ม: " + (f.title || ""), contents: card({
      color: "#185FA5", heroKind: "qa", title: "📋 งาน QA ยังไม่เริ่มบันทึก", sub: brLabel(g.name),
      rows: [row2("โฟลเดอร์", String(f.title || "-")), ...(who ? [row2("ผู้รับผิดชอบ", who)] : []), row2("ค้างมาแล้ว", ageDays + " วัน", "#b45309")],
      note: { text: "ยังไม่มีการบันทึกสินค้าในโฟลเดอร์นี้ — โปรดเริ่มดำเนินการ ไม่ดำเนินการมีโทษทางวินัย", color: "#1e40af", bg: "#eff6ff" },
      photos: [], btn: "เปิดงาน QA", url }) };
    const ok = await pushLine(g.gid, [flex]);
    if (ok) { sent++; await mark(rkey, bid); }
  }
  return sent;
}


// ---------- กลุ่ม ผจก. (app_settings.mgr_group_id → สำรอง: line_groups ที่ชื่อมี "ผจก") ----------
let _MGR_GID: string | null | undefined;
async function mgrGroupId(): Promise<string | null> {
  if (_MGR_GID !== undefined) return _MGR_GID;
  try {
    const { data: st } = await sb.from("app_settings").select("value").eq("key", "mgr_group_id").maybeSingle();
    const raw = st && (st as any).value;
    const v = (typeof raw === "string" ? raw : (raw == null ? "" : String(raw))).replace(/^"|"$/g, "").trim();
    if (v) { _MGR_GID = v; return _MGR_GID; }
  } catch { /* ignore */ }
  try {
    const { data } = await sb.from("line_groups").select("group_id,label,ignored,last_message_at").ilike("label", "%ผจก%").order("last_message_at", { ascending: false });
    const hit = (data || []).find((g: any) => !g.ignored);
    _MGR_GID = hit ? String((hit as any).group_id) : null;
  } catch { _MGR_GID = null; }
  return _MGR_GID ?? null;
}
// ชื่อสาขาทุกสาขา (ไม่สนว่ามีกลุ่มไลน์ไหม — การ์ดพวกนี้ส่งเข้ากลุ่ม ผจก.)
async function branchNames(): Promise<Record<string, string>> {
  const m: Record<string, string> = {};
  try { const { data } = await sb.from("branches").select("branch_id,name"); (data || []).forEach((b: any) => { m[String(b.branch_id)] = b.name || String(b.branch_id); }); } catch { /* */ }
  return m;
}

// ===== scan:qa_removed — เก็บสินค้าหมดอายุลงจากเชลฟ์ → รวมเป็นใบเดียวต่อสาขา เข้ากลุ่ม ผจก. =====
async function scanQaRemoved(): Promise<number> {
  const gid = await mgrGroupId();
  if (!gid) return 0;
  // ย้อนหลัง 90 นาที เผื่อ cron หลุดรอบ · กันซ้ำรายชิ้นด้วย qarm:<id> จึงไม่มีทางส่งซ้ำ
  const since = new Date(Date.now() - 90 * 60000).toISOString();
  const { data: items } = await sb.from("qa_items")
    .select("id,name,size,qty,zone,expiry_date,branch_id,photos,action_name,action_at")
    .eq("status", "removed").gte("action_at", since)
    .order("action_at", { ascending: true }).limit(300);
  if (!items || !items.length) return 0;
  const bn = await branchNames();
  const perBranch: Record<string, any[]> = {};
  for (const it of items) {
    const rkey = "qarm:" + (it as any).id;
    if (await already(rkey)) continue;
    const bid = String((it as any).branch_id || "-");
    (perBranch[bid] = perBranch[bid] || []).push({ it, rkey });
  }
  let sent = 0;
  for (const bid of Object.keys(perBranch)) {
    const list = perBranch[bid]; if (!list.length) continue;
    const who = [...new Set(list.map((x) => String(x.it.action_name || "").trim()).filter(Boolean))];
    const qty = list.reduce((n, x) => n + (Number(x.it.qty) || 1), 0);
    const photos = await usablePhotos(list.flatMap((x) => Array.isArray(x.it.photos) ? x.it.photos : []));
    const rows = list.slice(0, 10).map((x) =>
      row2(String(x.it.name || "สินค้า").slice(0, 22),
           (Number(x.it.qty) || 1) + " ชิ้น · หมดอายุ " + fmtThaiDate(x.it.expiry_date) + (x.it.zone ? (" · โซน " + x.it.zone) : ""),
           "#b45309"));
    const more = list.length > 10
      ? ("… และอีก " + (list.length - 10) + " รายการ — เปิดแอปดูทั้งหมด")
      : (photos.length ? "มีรูปหลักฐานแนบครบทุกรายการ" : "⚠️ ไม่มีรูปหลักฐานแนบมา — ตรวจสอบกับผู้ปฏิบัติ");
    const flex = { type: "flex", altText: "เก็บสินค้าหมดอายุลง " + list.length + " รายการ (" + brLabel(bn[bid] || bid) + ")", contents: card({
      color: "#b45309", heroKind: "expiry", hero: photos[0],
      title: "🧹 เก็บสินค้าหมดอายุลงจากเชลฟ์",
      sub: brLabel(bn[bid] || bid) + " · " + list.length + " รายการ · รวม " + qty + " ชิ้น",
      rows: [row2("ผู้ปฏิบัติ", who.join(", ") || "—", "#b45309"), ...rows],
      note: { text: more, color: "#92400e", bg: "#fffbeb" },
      photos: photos.slice(1), btn: "เปิดรายการ QA", url: APP_URL + "/qa/" }) };
    const ok = await pushLine(gid, [flex]);
    if (ok) { sent++; for (const x of list) await mark(x.rkey, bid); }
  }
  return sent;
}

// ===== scan:shift_open — สรุปเปิดกะ (หลังเวลาเข้ากะ 30 นาที) รวมใบเดียวต่อสาขา/ผลัด เข้ากลุ่ม ผจก. =====
const SHIFT_OPEN_DELAY = 30;   // นาทีหลังเวลาเข้ากะ
const SHIFT_OPEN_WINDOW = 20;  // ความกว้างหน้าต่าง (ต้องรัน cron ทุก ≤ 15 นาที)
async function scanShiftOpen(): Promise<number> {
  const gid = await mgrGroupId();
  if (!gid) return 0;
  const now = new Date(Date.now() + TZ);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = bkkDateStr();
  const hm = (t: any) => { const m = String(t || "").match(/(\d{1,2}):(\d{2})/); return m ? (+m[1] * 60 + +m[2]) : null; };
  const { data: shifts } = await sb.from("shifts").select("shift_id,name,start_time");
  const due = (shifts || []).filter((x: any) => {
    const st = hm(x.start_time); if (st == null) return false;
    const t = st + SHIFT_OPEN_DELAY;
    return nowMin >= t && nowMin < t + SHIFT_OPEN_WINDOW;
  });
  if (!due.length) return 0;
  const sids = due.map((x: any) => String(x.shift_id));
  const shName: Record<string, string> = {}; due.forEach((x: any) => { shName[String(x.shift_id)] = x.name || String(x.shift_id); });
  const [{ data: sch }, { data: att }] = await Promise.all([
    sb.from("schedules").select("emp_id,branch_id,shift_id").eq("work_date", today).in("shift_id", sids),
    sb.from("attendance").select("emp_id,shift_id,check_in,late_min,status").eq("work_date", today).in("shift_id", sids),
  ]);
  if (!sch || !sch.length) return 0;
  const ids = [...new Set((sch as any[]).map((x) => String(x.emp_id)))];
  const { data: emps } = await sb.from("employees").select("emp_id,name,nickname").in("emp_id", ids);
  const nm: Record<string, string> = {}; (emps || []).forEach((e: any) => { nm[e.emp_id] = e.nickname || e.name || e.emp_id; });
  const attBy: Record<string, any> = {}; (att || []).forEach((a: any) => { attBy[String(a.emp_id) + "|" + String(a.shift_id)] = a; });
  const bn = await branchNames();
  // จัดกลุ่ม สาขา|ผลัด
  const G: Record<string, any[]> = {};
  (sch as any[]).forEach((x) => { const k = String(x.branch_id || "-") + "|" + String(x.shift_id); (G[k] = G[k] || []).push(x); });
  let sent = 0;
  for (const k of Object.keys(G)) {
    const p = k.split("|"); const bid = p[0], sid = p[1];
    const list = G[k]; if (!list.length) continue;
    const rkey = "shiftopen:" + bid + ":" + sid + ":" + today;
    const rv = await reserve(rkey, bid);
    if (rv === "dup") continue;
    const inOnTime: string[] = [], inLate: string[] = [], notYet: string[] = [];
    for (const x of list) {
      const a = attBy[String(x.emp_id) + "|" + sid];
      const who = nm[String(x.emp_id)] || String(x.emp_id);
      if (a && a.check_in) {
        if (a.status === "TRAINING") { inOnTime.push(who + " (อบรม)"); continue; }
        const lm = Number(a.late_min) || 0;
        if (lm > 0) inLate.push(who + " " + lm + " น."); else inOnTime.push(who);
      } else notYet.push(who);
    }
    const total = list.length, came = inOnTime.length + inLate.length;
    const allIn = notYet.length === 0;
    const color = notYet.length ? "#dc2626" : (inLate.length ? "#b45309" : "#15803d");
    const rows = [
      row2("เข้าแล้ว", came + " / " + total + " คน", allIn ? "#15803d" : "#b45309"),
      ...(inOnTime.length ? [row2("ตรงเวลา", inOnTime.join(", ").slice(0, 60), "#15803d")] : []),
      ...(inLate.length ? [row2("สาย", inLate.join(", ").slice(0, 60), "#b45309")] : []),
      ...(notYet.length ? [row2("ยังไม่มา", notYet.join(", ").slice(0, 60), "#dc2626")] : []),
    ];
    const note = notYet.length
      ? { text: "ผ่านเวลาเข้ากะมา " + SHIFT_OPEN_DELAY + " นาทีแล้ว ยังไม่ลงเวลา " + notYet.length + " คน — ตรวจสอบด้วยค่ะ", color: "#991b1b", bg: "#fef2f2" }
      : (inLate.length
          ? { text: "เข้าครบแล้ว แต่มีคนสาย " + inLate.length + " คน", color: "#92400e", bg: "#fffbeb" }
          : { text: "เปิดกะเรียบร้อย เข้างานครบตรงเวลาทุกคน 💚", color: "#15803d", bg: "#f0fdf4" });
    const flex = { type: "flex", altText: "เปิดกะ " + (shName[sid] || sid) + " " + brLabel(bn[bid] || bid) + " — เข้าแล้ว " + came + "/" + total, contents: card({
      color, heroKind: "shelf",
      title: allIn ? "🕐 เปิดกะเรียบร้อย" : "🕐 สรุปเปิดกะ — ยังไม่ครบ",
      sub: brLabel(bn[bid] || bid) + " · ผลัด" + (shName[sid] || sid) + " · " + fmtThaiDate(today),
      rows, note, photos: [], btn: "เปิดหน้าลงเวลา", url: APP_URL + "/hr/" }) };
    const ok = await pushLine(gid, [flex]);
    if (ok) sent++; else if (rv === "new") await unreserve(rkey);
  }
  return sent;
}

// ===== scan:shift_incomplete — สิ้นผลัดแล้วยังส่งงานไม่ครบ → เตือน "ยังเหลือ X งาน" =====
async function scanShiftIncomplete(): Promise<number> {
  const groups = await branchGroups(); const cfg = await loadCfg();
  const now = new Date(Date.now() + TZ);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const todayStr = bkkDateStr();
  const { data: shifts } = await sb.from("shifts").select("shift_id,name,start_time,end_time,main_shift");
  if (!shifts || !shifts.length) return 0;
  const WINDOW = 45;   // ต้องรัน cron ทุก ≤ 30 นาที เพื่อไม่พลาดหน้าต่างนี้
  const hm = (t: any) => { const m = String(t || "").match(/(\d{1,2}):(\d{2})/); return m ? (+m[1] * 60 + +m[2]) : null; };
  const due: { sid: string; name: string; workDate: string }[] = [];
  for (const s of (shifts as any[])) {
    if (!isMainStaffShift(s)) continue;                              // ★ เฉพาะกะหลัก เช้า/บ่าย/ดึก (ข้ามกะพิเศษ เช่น 8.00-18.00, ผจก.)
    const st = hm(s.start_time), en = hm(s.end_time); if (en == null) continue;
    const overnight = st != null && en <= st;                       // ผลัดข้ามคืน → งานอยู่ workDate ของวันเริ่ม (เมื่อวาน)
    if (nowMin >= en && nowMin < en + WINDOW) due.push({ sid: s.shift_id, name: s.name || s.shift_id, workDate: overnight ? addDaysStr(todayStr, -1) : todayStr });
  }
  if (!due.length) return 0;
  const { data: defsData } = await sb.from("task_defs").select("id,shift_id,active").eq("active", true);
  const defs = defsData || [];
  let sent = 0;
  for (const d of due) {
    // งานที่ "ต้องทำ" ในผลัดนี้ (จาก task_defs — ไม่ระบุกะ=ทุกกะ หรือ ตรงกะนี้)
    const expected = defs.filter((x: any) => !x.shift_id || String(x.shift_id) === d.sid).map((x: any) => x.id);
    if (!expected.length) continue;
    const [{ data: asg }, { data: sch }] = await Promise.all([
      sb.from("task_assignments").select("branch_id,task_def_id,status").eq("shift_id", d.sid).eq("work_date", d.workDate),
      sb.from("schedules").select("branch_id").eq("shift_id", d.sid).eq("work_date", d.workDate),
    ]);
    // สาขาที่อยู่ในขอบเขต = มีตารางเวร หรือ มีการส่งงานในผลัดนี้
    const branchesSet = new Set<string>();
    (asg || []).forEach((a: any) => { if (a.branch_id) branchesSet.add(String(a.branch_id)); });
    (sch || []).forEach((s: any) => { if (s.branch_id) branchesSet.add(String(s.branch_id)); });
    for (const bid of branchesSet) {
      const g = groups[bid]; if (!g) continue;
      const c = cfgOf(cfg, bid); if (!c.enabled) continue;
      const doneSet = new Set((asg || []).filter((a: any) => String(a.branch_id) === bid && a.status !== "sent_back" && a.status !== "todo").map((a: any) => a.task_def_id));
      const remaining = expected.filter((id: any) => !doneSet.has(id)).length;
      if (remaining <= 0) continue;
      const rkey = "shift_incomplete:" + bid + ":" + d.sid + ":" + d.workDate;
      const rv = await reserve(rkey, bid); if (rv === "dup") continue;
      const url = APP_URL + "/handover/";   // ★ หน้างานจริง (รับ-ส่งผลัด/งานในกะ)
      const flex = { type: "flex", altText: "ยังเหลือ " + remaining + " งาน (ผลัด" + d.name + ") " + fmtThaiDate(d.workDate) + " — " + brLabel(g.name), contents: card({
        color: "#b45309", heroKind: "shelf", title: "⚠️ สิ้นผลัดแล้วงานยังไม่ครบ", sub: brLabel(g.name) + " · ผลัด" + d.name + " · " + fmtThaiDate(d.workDate),
        rows: [row2("วันที่งาน", fmtThaiDate(d.workDate), "#b45309"), row2("ยังเหลือ", remaining + " / " + expected.length + " งาน", "#dc2626"), row2("ผลัด", d.name, "#b45309")],
        note: { text: "สิ้นผลัดแล้วแต่ยังส่งงานไม่ครบ โปรดเร่งส่งให้ครบ — ไม่ดำเนินการอาจมีผลทางวินัยค่ะ", color: "#b45309", bg: "#fff7ed" },
        photos: [], btn: "เปิดงานของฉัน", url }) };
      const ok = await pushLine(g.gid, [flex]);
      if (ok) sent++; else if (rv === "new") await unreserve(rkey);
    }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    if (!LINE_TOKEN) return json({ ok: false, error: "ยังไม่ได้ตั้ง LINE_CHANNEL_TOKEN" }, 400);

    // ---- cron scans (ไม่ผูกกับสาขาเดียว — วนทุกสาขา) ----
    if (b.scan === "expiry")   return json({ ok: true, scan: "expiry",   sent: await scanExpiry() });
    if (b.scan === "shelf_due") return json({ ok: true, scan: "shelf_due", sent: await scanShelfDue() });
    if (b.scan === "qa_due")   return json({ ok: true, scan: "qa_due",   sent: await scanQaDue() });
    if (b.scan === "shift_incomplete") return json({ ok: true, scan: "shift_incomplete", sent: await scanShiftIncomplete() });
    if (b.scan === "qa_removed") return json({ ok: true, scan: "qa_removed", sent: await scanQaRemoved() });
    if (b.scan === "shift_open") return json({ ok: true, scan: "shift_open", sent: await scanShiftOpen() });

    if (!b.branch_id) return json({ ok: false, error: "ไม่ระบุสาขา" }, 400);
    const { gid, name } = await branchGroup(String(b.branch_id));
    if (!gid) return json({ ok: true, sent: 0, note: "สาขานี้ยังไม่ได้ตั้ง LINE Group ID (กลุ่มพนักงาน)" });

    if (b.test) { const ok = await pushLine(gid, [{ type: "text", text: "✅ ทดสอบแจ้งเตือนกลุ่มพนักงาน — สาขา " + name + " เชื่อมต่อสำเร็จ" }]); return json({ ok, sent: ok ? 1 : 0 }); }

    // ★ พนักงานทำงานในกะ "ครบทุกงาน" วันนี้ → ส่งการ์ดสรุปใบเดียวเข้ากลุ่มพนักงาน (กันซ้ำ/วัน)
    if (b.kind === "staff_done_check") {
      // ปิดแจ้งเตือนรายสาขา = ไม่ส่ง
      try { const { data: cf } = await sb.from("staff_notify_cfg").select("enabled").eq("branch_id", String(b.branch_id)).maybeSingle(); if (cf && cf.enabled === false) return json({ ok: true, sent: 0 }); } catch { /* */ }
      const today = bkkDateStr();
      const _yest = addDaysStr(today, -1);   // ★ กะข้ามคืน: คนกะดึกส่งงานหลังเที่ยงคืน แถวจะถูกบันทึกเป็น work_date ของเมื่อวาน
      // ★ "งานทั้งหมดของผลัด" นับจาก task_defs ที่ active (ไม่ระบุกะ=ทุกกะ · หรือ ตรงกะนั้น)
      //   ‼ ห้ามนับแค่แถว task_assignments — เพราะแถวถูกสร้างตอนส่งงานเท่านั้น งานที่ยังไม่ทำจะไม่มีแถว
      const [{ data: ta }, { data: defsData }] = await Promise.all([
        sb.from("task_assignments").select("task_def_id,status,title,photos,photo_url,shift_id,work_date").eq("branch_id", String(b.branch_id)).in("work_date", [today, _yest]),
        sb.from("task_defs").select("id,shift_id,active").eq("active", true),
      ]);
      const rows = ta || []; const defs = defsData || [];
      if (!rows.length) return json({ ok: true, sent: 0, note: "ยังไม่มีการส่งงานวันนี้" });
      // ผลัดที่ต้องพิจารณา = ผลัดที่มีการส่งงานแล้ว (มี assignment) — เช็กทุกผลัดในครั้งเดียว
      const asgByShift: Record<string, any[]> = {};
      rows.forEach((a: any) => { const sid = a.shift_id ? String(a.shift_id) : "_none"; const k = sid + "|" + String(a.work_date || today); (asgByShift[k] = asgByShift[k] || []).push(a); });
      const realSids = [...new Set(Object.keys(asgByShift).map((k) => k.split("|")[0]).filter((x) => x !== "_none"))];
      const shNm: Record<string, string> = {}; const mainSet = new Set<string>(); const ovnSet = new Set<string>();
      const endMin: Record<string, number> = {};   // นาทีของเวลาเลิกกะ (ใช้ตัดสินว่ากะเมื่อวานยังคาบเกี่ยวถึงตอนนี้ไหม)
      const _nowB = new Date(Date.now() + TZ); const _nowMin = _nowB.getUTCHours() * 60 + _nowB.getUTCMinutes();
      if (realSids.length) { try { const { data: sh } = await sb.from("shifts").select("shift_id,name,main_shift,start_time,end_time").in("shift_id", realSids); (sh || []).forEach((s: any) => { shNm[s.shift_id] = s.name || s.shift_id; if (isMainStaffShift(s)) mainSet.add(String(s.shift_id)); if (s.start_time && s.end_time && String(s.end_time).slice(0, 5) <= String(s.start_time).slice(0, 5)) ovnSet.add(String(s.shift_id));
        const _em = String(s.end_time || "").match(/(\d{1,2}):(\d{2})/); if (_em) endMin[String(s.shift_id)] = (+_em[1]) * 60 + (+_em[2]); }); } catch { /* */ } }
      const url = APP_URL + "/handover/";   // ★ หน้างานจริงของพนักงาน (รับ-ส่งผลัด/งานในกะ) ไม่ใช่หน้าลงเวลา
      let sent = 0; const status: any[] = [];
      for (const _k of Object.keys(asgByShift)) {
        const _p = _k.split("|"); const sid = _p[0]; const wd = _p[1] || today;
        const isNone = sid === "_none";
        if (isNone || !mainSet.has(sid)) { status.push({ shift: sid, skip: "not_main_shift" }); continue; }   // ★ เฉพาะกะหลัก เช้า/บ่าย/ดึก
        // ★ ของเมื่อวานเก็บไว้เฉพาะ "กะข้ามคืนที่ยังไม่เลิก ณ ตอนนี้"
        //   ‼ สำคัญมาก: ถ้าไม่เช็กเวลา กะดึกเมื่อวานที่ทำครบไปแล้วจะเด้งการ์ด "เสร็จครบ" ตอนดึกของวันถัดไป
        //   (เกิดขึ้นจริง 27 ส.ค. 23:57 — การ์ดของผลัดดึก 26 ส.ค. (17/17) ไปโผล่ตอนผลัดดึก 27 ส.ค. ยังทำไม่เสร็จ)
        if (wd !== today) {
          const _en = endMin[sid];
          if (!ovnSet.has(sid) || _en == null || _nowMin > _en + 60) { status.push({ shift: sid, wd, skip: "old_day" }); continue; }
        }
        // งานที่ "ต้องทำ" ในผลัดนี้ (id ของ task_defs)
        const expected = defs.filter((d: any) => (!d.shift_id || String(d.shift_id) === sid)).map((d: any) => d.id);
        if (!expected.length) { status.push({ shift: sid, skip: "no_defs" }); continue; }   // ไม่รู้ว่ามีงานอะไร → ไม่ฟันธงว่าครบ
        const list = asgByShift[_k];
        // งานที่ "ทำแล้วจริง" = มี assignment สถานะ submitted/approved (ไม่ใช่ sent_back/todo)
        const doneSet = new Set(list.filter((a: any) => a.status !== "sent_back" && a.status !== "todo").map((a: any) => a.task_def_id));
        const remaining = expected.filter((id: any) => !doneSet.has(id)).length;
        if (remaining > 0) { status.push({ shift: sid, expected: expected.length, done: doneSet.size, remaining }); continue; }   // ยังไม่ครบจริง → ไม่ส่ง
        // ครบจริง → จองคีย์ + ส่ง
        const rkey = (isNone ? "alldone_staff:" : "alldone_staff_shift:" + sid + ":") + wd;
        const fullKey = String(b.branch_id) + "|" + rkey;
        const rv = await reserve(fullKey, String(b.branch_id));
        if (rv === "dup") { status.push({ shift: sid, sent: "dup" }); continue; }
        const shiftLabel = isNone ? "" : (shNm[sid] || sid);
        const doneAsg = list.filter((a: any) => expected.includes(a.task_def_id) && a.status !== "sent_back" && a.status !== "todo");
        const firstPerTask = doneAsg.map((t: any) => (Array.isArray(t.photos) && t.photos.length) ? t.photos[0] : (t.photo_url || null)).filter(Boolean);
        const photos = await usablePhotos(firstPerTask);
        const title = isNone ? "🎉 งานประจำวันเสร็จครบแล้ว" : "🎉 งานผลัดนี้เสร็จครบแล้ว";
        const flex = { type: "flex", altText: "งานเสร็จครบ" + (shiftLabel ? " (ผลัด" + shiftLabel + ")" : "") + " " + fmtThaiDate(wd) + " — " + brLabel(name), contents: card({
          color: "#15803d", heroKind: "shelf", hero: photos[0], title, sub: brLabel(name) + (shiftLabel ? " · ผลัด" + shiftLabel : "") + " · " + fmtThaiDate(wd) + " · ครบ " + expected.length + " งาน",
          rows: [row2("วันที่งาน", fmtThaiDate(wd), "#15803d"), ...(shiftLabel ? [row2("ผลัด", shiftLabel, "#15803d")] : []), row2("สถานะ", "ส่งครบทุกงาน" + (isNone ? "วันนี้" : "ในผลัดนี้") + " (" + expected.length + "/" + expected.length + ") ✓", "#15803d")],
          note: { text: "ขอบคุณที่ช่วยกันทำงานให้ครบนะคะ 💚", color: "#15803d", bg: "#f0fdf4" },
          photos: photos.slice(1), btn: "เปิดแอป", url }) };
        const ok = await pushLine(gid, [flex]);
        if (ok) { sent++; status.push({ shift: sid, sent: true, tasks: expected.length }); } else if (rv === "new") { await unreserve(fullKey); status.push({ shift: sid, sent: "push_failed" }); }
      }
      return json({ ok: true, sent, allDone: sent > 0, shifts: status });
    }

    // ปิดแจ้งเตือนรายสาขา (ยกเว้นปุ่ม "ส่งเข้ากลุ่ม" แบบสั่งมือของ HR = b.manual → ยังส่งได้)
    if (!b.manual) { try { const { data: cf } = await sb.from("staff_notify_cfg").select("enabled").eq("branch_id", String(b.branch_id)).maybeSingle(); if (cf && cf.enabled === false) return json({ ok: true, sent: 0, note: "สาขานี้ปิดแจ้งเตือนพนักงานไว้" }); } catch { /* */ } }

    const photos = await usablePhotos(b.photos);

    if (b.kind === "shelf_assign") {
      const url = APP_URL + "/shelf/";                       // ★ หน้าพนักงานเชลฟ์ (ล็อกอินด้วยรหัสพนักงาน)
      const flex = { type: "flex", altText: "มอบหมายเชลฟ์: " + (b.shelf || ""), contents: card({
        color: "#15803d", heroKind: "shelf", hero: photos[0], title: "🗂️ ได้รับมอบหมายดูแลเชลฟ์", sub: brLabel(name),
        rows: [row2("เชลฟ์", String(b.shelf || "-")), ...(b.assignee ? [row2("ผู้รับผิดชอบ", String(b.assignee))] : []), ...(b.month ? [row2("รอบเดือน", String(b.month))] : [])],
        note: { text: "📌 ระเบียบ: ดูแลเชลฟ์ไม่ต่ำกว่า 3–4 ครั้ง/สัปดาห์", color: "#15803d", bg: "#f0fdf4" },
        photos: photos.slice(1), btn: "เปิดงานเชลฟ์", url }) };
      const ok = await pushLine(gid, [flex]); return json({ ok, sent: ok ? 1 : 0 });
    }
    if (b.kind === "qa_assign") {
      // ★ หน้าพนักงาน QA (ล็อกอินด้วยรหัสพนักงาน) + เปิดโฟลเดอร์อัตโนมัติ
      const url = APP_URL + "/qa/" + (b.folder_id ? ("?folder=" + encodeURIComponent(String(b.folder_id))) : "");
      const who = Array.isArray(b.assignees) ? b.assignees.join(", ") : String(b.assignees || "");
      // รูปสินค้าจริง: จาก payload ถ้ามี · ไม่มี → ดึงจาก qa_items ของโฟลเดอร์+สาขานี้
      let qp = photos;
      if (!qp.length && b.folder_id) qp = await usablePhotos(await qaFolderPhotos(b.folder_id, String(b.branch_id)));
      const flex = { type: "flex", altText: "มอบหมายงาน QA: " + (b.folder || ""), contents: card({
        color: "#185FA5", heroKind: "qa", hero: qp[0], title: "📋 งาน QA ที่ได้รับมอบหมาย", sub: brLabel(name),
        rows: [row2("โฟลเดอร์", String(b.folder || "-")), ...(who ? [row2("ผู้รับผิดชอบ", who)] : []), ...(b.target_month ? [row2("เดือนเป้าหมาย", String(b.target_month))] : []), ...(qp.length ? [row2("สินค้าในโฟลเดอร์", qp.length + " รายการ (มีรูป)")] : [])],
        note: { text: "โปรดเริ่มบันทึกสินค้าตามที่ได้รับมอบหมาย — ไม่ดำเนินการมีโทษทางวินัย", color: "#1e40af", bg: "#eff6ff" },
        photos: qp.slice(1), btn: "เปิดงาน QA", url }) };
      const ok = await pushLine(gid, [flex]); return json({ ok, sent: ok ? 1 : 0 });
    }
    return json({ ok: false, error: "ไม่รู้จักประเภทการแจ้งเตือน (kind)" }, 400);
  } catch (e) { return json({ ok: false, error: String((e && (e as any).message) || e) }, 500); }
});

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
// ★ หัวสีกะทัดรัด + แถบความคืบหน้า — ใช้กล่องซ้อนกล่องแล้วกำหนดความกว้างเป็น % (วิธีมาตรฐานของ Flex)
//   สูงราว 65px แทนแบนเนอร์เดิม 135px และ "บอกข้อมูลจริง" ไม่ใช่แค่ตกแต่ง
function capHead(color: string, label: string, pct: number | null, pctText?: string) {
  const c: any[] = [{ type: "text", text: label, color: "#ffffff", size: "sm", weight: "bold", wrap: true }];
  if (pct != null && isFinite(pct)) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    c.push({ type: "text", text: pctText || (p + "%"), color: "#ffffff", size: "xs", weight: "bold", margin: "sm" });
    // รางจาง ๆ + แถบขาวทับตามสัดส่วน · p = 0 ไม่ต้องวาดแถบ (Flex ไม่รับ width "0%")
    c.push({
      type: "box", layout: "horizontal", height: "7px", backgroundColor: "#ffffff55", cornerRadius: "4px", margin: "sm",
      contents: p > 0
        ? [{ type: "box", layout: "vertical", width: p + "%", backgroundColor: "#ffffff", cornerRadius: "4px", contents: [{ type: "filler" }] }, { type: "filler" }]
        : [{ type: "filler" }],
    });
  }
  return { type: "box", layout: "vertical", backgroundColor: color, paddingAll: "14px", contents: c };
}
function card(opts: { color: string; heroKind?: string; hero?: string; title: string; sub: string; rows: any[]; note?: { text: string; color: string; bg: string }; photos: string[]; btn: string; url: string; headLabel?: string; headPct?: number | null; headPctText?: string }) {
  const body: any[] = [
    { type: "text", text: opts.title, weight: "bold", size: "lg", color: opts.headLabel ? "#18181b" : opts.color, wrap: true },
    { type: "text", text: opts.sub, size: "sm", color: "#8c8c8c", wrap: true },
    { type: "separator", margin: "md" },
    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: opts.rows },
  ];
  if (opts.note) body.push({ type: "box", layout: "vertical", margin: "md", backgroundColor: opts.note.bg, cornerRadius: "8px", paddingAll: "10px", contents: [{ type: "text", text: opts.note.text, wrap: true, size: "xs", color: opts.note.color }] });
  // ★ ตัดแถบหัวรูป/แบนเนอร์ออกทั้งหมด — แบนเนอร์สีทึบกินพื้นที่ครึ่งการ์ดโดยไม่ให้ข้อมูลอะไรเลย
  //   รูปจริงที่เคยถูกใช้เป็นหัวการ์ด (opts.hero) ย้ายลงมารวมในตารางรูปด้านล่าง ไม่มีรูปไหนหาย
  const pics = opts.hero ? [opts.hero].concat(opts.photos) : opts.photos;
  if (pics.length) { body.push({ type: "text", text: "📷 รูป " + pics.length + " รูป · หัวข้อละ 1 รูป (แตะเพื่อดู)", size: "xs", color: "#8c8c8c", margin: "md" }); body.push(photoGrid(pics, opts.url)); }
  const bubble: any = {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: body },
    footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: opts.color, action: { type: "uri", label: opts.btn, uri: opts.url } }] },
  };
  if (opts.headLabel) bubble.header = capHead(opts.color, opts.headLabel, opts.headPct ?? null, opts.headPctText);
  return bubble;
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
// ★ ผลัดที่ให้ส่งรายงานเข้า LINE — ตั้งที่คอลัมน์ shifts.report_shift (ปกติเปิดเฉพาะ เช้า/บ่าย/ดึก)
//   ถ้ายังไม่มีสาขาไหนตั้งค่าเลย (ทุกแถว false/null) ให้ถอยไปใช้กติกา "กะหลัก" แบบเดิม กันแจ้งเตือนเงียบทั้งระบบ
function reportFilter(shifts: any[]): (s: any) => boolean {
  const anyFlag = (shifts || []).some((x: any) => x && x.report_shift === true);
  return (s: any) => anyFlag ? (s && s.report_shift === true) : isMainStaffShift(s);
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
      color: "#dc2626", hero: photos[0], headLabel: "ใกล้หมดอายุ · " + list.length + " รายการ",
      title: "⏰ สินค้าใกล้หมดอายุ", sub: brLabel(g.name) + " · ด่วนสุดเหลือ " + list[0].dl + " วัน",
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
        color: "#d97706",
        headLabel: "เชลฟ์ยังไม่ครบ · " + list.length + " เชลฟ์",
        headPct: TH > 0 ? (list.reduce((n: number, x: any) => n + x.done, 0) / (TH * list.length)) * 100 : null,
        headPctText: "ทำไปแล้ว " + list.reduce((n: number, x: any) => n + x.done, 0) + " / " + (TH * list.length) + " ครั้ง",
        title: "⚠️ เชลฟ์ยังดูแลไม่ครบสัปดาห์นี้", sub: brLabel(g.name) + " · " + (nmBy[emp] || emp),
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
      color: "#185FA5", headLabel: "ค้างมาแล้ว " + ageDays + " วัน",
      title: "📋 งาน QA ยังไม่เริ่มบันทึก", sub: brLabel(g.name),
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

// ===== scan:qa_removed — เก็บสินค้าหมดอายุลงจากเชลฟ์ → รวมเป็นใบเดียวต่อสาขา เข้ากลุ่มพนักงานสาขา =====
// ★ 17 ก.ย. 69 — เปลี่ยนปลายทางจาก "กลุ่ม ผจก." เป็น "กลุ่มพนักงานของสาขานั้น"
//   ของเดิมส่งเข้ากลุ่ม ผจก. อย่างเดียว คนที่ทำงานจริงจึงไม่เห็นว่าระบบรับเรื่องแล้ว
//   สาขาไหนยังไม่ได้ผูก LINE Group ID ให้ตกไปที่กลุ่ม ผจก. แทน จะได้ไม่หายเงียบ
async function scanQaRemoved(): Promise<number> {
  const groups = await branchGroups();
  const mgid = await mgrGroupId();
  const cfg = await loadCfg();
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
    // ปลายทาง: กลุ่มพนักงานของสาขานั้น → ไม่มีค่อยตกไปกลุ่ม ผจก.
    const gid = (groups[bid] && groups[bid].gid) || mgid;
    if (!gid) continue;
    // เคารพสวิตช์ปิดแจ้งเตือนรายสาขาเหมือน scan อื่น ๆ (ไม่มีแถว = เปิด)
    if (!cfgOf(cfg, bid).enabled) continue;
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
      color: "#b45309", hero: photos[0], headLabel: "เก็บออก " + list.length + " รายการ · รวม " + qty + " ชิ้น",
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

// ===== kind:sched_change — ตารางเวรถูกแก้โดย ผจก. → ยิงเข้ากลุ่ม ผจก. ทันที =====
// ★ 17 ก.ย. 69 — ไว้ให้สำนักงานตรวจย้อนได้ว่าใครแก้เวรของใคร เป็นอะไร เมื่อไร
//   ยิงทันทีต่อการแก้ 1 ครั้ง (ตามที่สั่ง) · คำสั่งเหมา เช่น จัดทั้งสัปดาห์/คัดลอก จะมาเป็นหลายรายการในใบเดียว
//   ยิงเฉพาะที่ ผจก. แก้ — สำนักงานแก้เองไม่ต้องแจ้ง (ฝั่ง hr-api เป็นคนกรองให้ก่อนเรียกมา)
type SchedItem = { emp_id?: string; work_date?: string; from?: string | null; to?: string | null };
async function sendSchedChange(b: any): Promise<number> {
  const gid = await mgrGroupId();
  if (!gid) return 0;
  const items: SchedItem[] = Array.isArray(b.items) ? b.items.slice(0, 60) : [];
  if (!items.length) return 0;
  const bid = String(b.branch_id || "");
  const actor = String(b.actor || "ผจก.").trim();

  // ชื่อเล่นพนักงาน + ชื่อกะ — ดึงจากฐานข้อมูล ไม่ให้ฝั่งเรียกส่งชื่อมาเอง (กันข้อมูลไม่ตรงกัน)
  const ids = [...new Set(items.map((x) => String(x.emp_id || "")).filter(Boolean))];
  const nm: Record<string, string> = {};
  if (ids.length) {
    const { data } = await sb.from("employees").select("emp_id,name,nickname").in("emp_id", ids);
    (data || []).forEach((e: any) => { nm[e.emp_id] = e.nickname || e.name || e.emp_id; });
  }
  const { data: shs } = await sb.from("shifts").select("shift_id,name,code,start_time");
  const shName: Record<string, string> = {}; const shStart: Record<string, string> = {};
  (shs || []).forEach((s: any) => { shName[s.shift_id] = s.name || s.shift_id; shStart[s.shift_id] = String(s.start_time || ""); });
  const lbl = (v: string | null | undefined) => {
    const s = String(v == null ? "" : v).trim();
    if (!s) return "หยุด";
    return s.split("+").map((x) => shName[x.trim()] || x.trim()).join(" + ");
  };
  const bn = await branchNames();

  // เหลือเวลาอีกกี่ชั่วโมงก่อนเข้าเวรของรายการที่ใกล้ที่สุด — ใช้ตัดสินว่าเป็นการแก้กระชั้นชิดไหม
  const nowMs = Date.now() + TZ;
  let minAhead = Infinity;
  for (const it of items) {
    const d = String(it.work_date || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const sid = String(it.to || it.from || "");
    const hm = (shStart[sid] || "06:00").slice(0, 5).split(":");
    const start = Date.parse(d + "T00:00:00Z") + ((parseInt(hm[0]) || 0) * 60 + (parseInt(hm[1]) || 0)) * 60000;
    const ahead = (start - nowMs) / 3600000;
    if (ahead < minAhead) minAhead = ahead;
  }
  const removed = items.filter((x) => x.to == null).length;
  const urgent = removed > 0 || (isFinite(minAhead) && minAhead < 12);
  const color = urgent ? "#dc2626" : "#185FA5";

  const dow = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
  const dLbl = (d: string) => { try { const x = new Date(d + "T00:00:00Z"); return dow[x.getUTCDay()] + " " + x.getUTCDate(); } catch { return d; } };
  // แถว: วัน | ชื่อ | จาก → เป็น  (ทุกแถวมี 3 ช่อง flex เท่ากันเสมอ ไม่งั้นคอลัมน์เลื่อน)
  const chRow = (it: SchedItem) => {
    const gone = it.to == null;
    const to = gone ? "ถูกปลดออก" : lbl(it.to);
    return { type: "box", layout: "baseline", spacing: "sm", margin: "xs", contents: [
      { type: "text", text: dLbl(String(it.work_date || "")), size: "xxs", color: "#8c8c8c", flex: 3 },
      { type: "text", text: nm[String(it.emp_id || "")] || String(it.emp_id || "—"), size: "xs", weight: "bold", flex: 5 },
      { type: "text", text: lbl(it.from) + " → " + to, size: "xxs", weight: "bold", align: "end", flex: 9,
        color: gone ? "#dc2626" : "#18181b" },
    ] };
  };
  const dates = [...new Set(items.map((x) => String(x.work_date || "")).filter(Boolean))].sort();
  const people = [...new Set(items.map((x) => String(x.emp_id || "")).filter(Boolean))].length;
  const spanTxt = dates.length === 1 ? fmtThaiDate(dates[0])
    : (fmtThaiDate(dates[0]) + " – " + fmtThaiDate(dates[dates.length - 1]));
  const aheadTxt = !isFinite(minAhead) ? "—"
    : minAhead < 0 ? "ย้อนหลัง (ผ่านไปแล้ว)"
    : minAhead < 24 ? (Math.floor(minAhead) + " ชม. " + Math.round((minAhead % 1) * 60) + " นาที")
    : (Math.round(minAhead / 24) + " วัน");

  // ★ เหตุผลที่ ผจก. กรอกตอนเปลี่ยนแปลง (มีเฉพาะการเปลี่ยนครั้งที่ 2 เป็นต้นไปของสัปดาห์)
  const reason = String(b.reason || "").trim();
  const base = removed > 0
    ? "ปลดคนออกจากเวร " + removed + " รายการ — ตรวจว่าแจ้งพนักงานแล้วหรือยัง และผลัดยังมีคนพอ"
    : (isFinite(minAhead) && minAhead < 12)
      ? "แก้ก่อนเข้าเวรไม่ถึง 12 ชม. — พนักงานอาจยังไม่รู้ตัว ควรแจ้งให้ชัด"
      : "แก้ล่วงหน้า " + aheadTxt + " — พนักงานที่ถูกเปลี่ยนกะควรได้รับแจ้งก่อนเข้าเวร";
  const hot = removed > 0 || (isFinite(minAhead) && minAhead < 12);
  const note = reason
    ? { text: "เหตุผลที่ ผจก. ระบุ:\n" + reason + "\n\n" + base, color: hot ? "#991b1b" : "#1e40af", bg: hot ? "#fef2f2" : "#eff6ff" }
    : { text: base, color: hot ? "#991b1b" : "#1e40af", bg: hot ? "#fef2f2" : "#eff6ff" };

  const flex = { type: "flex", altText: "ตารางเวรถูกแก้ " + items.length + " รายการ (" + brLabel(bn[bid] || bid) + ") โดย " + actor, contents: card({
    color,
    headLabel: (urgent ? "⚠️ แก้เวรต้องตรวจ · " : "ตารางเวรถูกแก้ไข · ") + brLabel(bn[bid] || bid),
    title: "🗓️ " + items.length + " รายการ",
    sub: "โดย " + actor + " · " + spanTxt,
    rows: [
      ...items.slice(0, 10).map(chRow),
      ...(items.length > 10 ? [{ type: "text", text: "… และอีก " + (items.length - 10) + " รายการ — เปิดแอปดูทั้งหมด", size: "xxs", color: "#8c8c8c", margin: "sm" }] : []),
      { type: "separator", margin: "md" },
      row2("คนที่ถูกแก้", people + " คน"),
      row2("ช่วงวันที่กระทบ", spanTxt),
      row2("เหลือเวลาก่อนเข้าเวร", aheadTxt, (isFinite(minAhead) && minAhead < 12) ? "#dc2626" : "#111111"),
      row2("ระบุเหตุผล", reason ? "มี" : "ไม่ต้องระบุ (ครั้งแรกของสัปดาห์)", reason ? "#15803d" : "#8c8c8c"),
    ],
    note, photos: [], btn: "เปิดตารางเวรสาขานี้", url: APP_URL + "/hr/" }) };
  const ok = await pushLine(gid, [flex]);
  return ok ? 1 : 0;
}

// ===== scan:shift_open — สรุปเปิดกะ (หลังเวลาเข้ากะ 30 นาที) รวมใบเดียวต่อสาขา/ผลัด เข้ากลุ่ม ผจก. =====
// ★ 17 ก.ย. 69 — เอา scanShiftOpen() ออก (แจ้งเตือนเปิดกะแบบเดิม)
//   เดิมยิงแยก "สาขา × ผลัด" = สูงสุด 9 ข้อความ/วัน และกรองเฉพาะผลัดหลัก
//   คนที่ลงกะย่อย (M8/M9/M10/M16/N17) จึงไม่เคยถูกนับเลย
//   แทนที่ด้วย scanAttendSummary() — 1 ผลัด = 1 ข้อความ รวมกะย่อยครบ


// ===== scan:shift_incomplete — สิ้นผลัดแล้วยังส่งงานไม่ครบ → เตือน "ยังเหลือ X งาน" =====
async function scanShiftIncomplete(): Promise<number> {
  const groups = await branchGroups(); const cfg = await loadCfg();
  const now = new Date(Date.now() + TZ);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const todayStr = bkkDateStr();
  const { data: shifts } = await sb.from("shifts").select("shift_id,name,start_time,end_time,main_shift,report_shift");
  const okShift = reportFilter(shifts || []);
  if (!shifts || !shifts.length) return 0;
  const WINDOW = 45;   // ต้องรัน cron ทุก ≤ 30 นาที เพื่อไม่พลาดหน้าต่างนี้
  const hm = (t: any) => { const m = String(t || "").match(/(\d{1,2}):(\d{2})/); return m ? (+m[1] * 60 + +m[2]) : null; };
  const due: { sid: string; name: string; workDate: string }[] = [];
  for (const s of (shifts as any[])) {
    if (!okShift(s)) continue;                                        // ★ เฉพาะผลัดหลัก เช้า/บ่าย/ดึก                              // ★ เฉพาะกะหลัก เช้า/บ่าย/ดึก (ข้ามกะพิเศษ เช่น 8.00-18.00, ผจก.)
    const st = hm(s.start_time), en = hm(s.end_time); if (en == null) continue;
    const overnight = st != null && en <= st;                       // ผลัดข้ามคืน → งานอยู่ workDate ของวันเริ่ม (เมื่อวาน)
    if (nowMin >= en && nowMin < en + WINDOW) due.push({ sid: s.shift_id, name: s.name || s.shift_id, workDate: overnight ? addDaysStr(todayStr, -1) : todayStr });
  }
  if (!due.length) return 0;
  // ★ แก้ 14 ก.ย. 69: เดิมนับ "งานที่ต้องทำ" จาก task_defs ทั้งตารางแบบเก่า
  //   (active + shift_id ว่าง/ตรงกะ) ทำให้นับงานรายสัปดาห์/รายเดือนที่ยังไม่ถึงรอบ
  //   งานที่สาขานี้ปิดไว้ และงานที่ยกเว้นรายวัน เข้าไปด้วย → ตัวเลขเกินความจริงมาก
  //   ตอนนี้ใช้ expectedForBranch() ชุดเดียวกับรายงานสิ้นผลัด (รู้จัก v2 ครบ)
  const [{ data: defsData }, { data: ovsData }, { data: brData }] = await Promise.all([
    sb.from("task_defs").select("*"),
    sb.from("task_def_branches").select("*"),
    sb.from("branches").select("branch_id,task_v2"),
  ]);
  const defs = defsData || [];
  const v2 = new Set<string>((brData || []).filter((b: any) => b.task_v2).map((b: any) => String(b.branch_id)));
  let sent = 0;
  for (const d of due) {
    const { data: dtsData } = await sb.from("task_def_dates").select("*").eq("work_date", d.workDate);
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
      // งานที่สาขานี้ต้องทำจริงในผลัด/วันนี้ (ตัดงานที่ยังไม่ถึงรอบ/ปิดไว้/ยกเว้นออกแล้ว)
      //   - auto_day = งานที่ระบบสุ่มวันให้พนักงานรายคน ไม่ใช่งานระดับสาขา → ไม่นับ
      //   - per_employee = งานผูกกับตัวพนักงาน นับเป็นงานสาขาไม่ได้ → ไม่นับ
      const expAll = expectedForBranch(bid, d.workDate, d.sid, defs, ovsData || [], dtsData || [], v2)
        .filter((x: any) => !x.auto_day && !x.per_employee);
      // ★ 15 ก.ย. 69 — งาน ผจก. นับแยกจากยอดของผลัด
      //   งาน ผจก. ค้างอย่างเดียว ไม่เตือนว่าผลัดทำงานไม่ครบ
      const expected = expAll.filter((x: any) => !x.mgr_owner).map((x: any) => x.id);
      const expMgr   = expAll.filter((x: any) =>  x.mgr_owner).map((x: any) => x.id);
      if (!expected.length) continue;
      const doneSet = new Set((asg || []).filter((a: any) => String(a.branch_id) === bid && a.status !== "sent_back" && a.status !== "todo").map((a: any) => a.task_def_id));
      const remaining = expected.filter((id: any) => !doneSet.has(id)).length;
      const mgrRemain = expMgr.filter((id: any) => !doneSet.has(id)).length;
      if (remaining <= 0) continue;
      const rkey = "shift_incomplete:" + bid + ":" + d.sid + ":" + d.workDate;
      const rv = await reserve(rkey, bid); if (rv === "dup") continue;
      const url = APP_URL + "/handover/";   // ★ หน้างานจริง (รับ-ส่งผลัด/งานในกะ)
      const flex = { type: "flex", altText: "ยังเหลือ " + remaining + " งาน (ผลัด" + d.name + ") " + fmtThaiDate(d.workDate) + " — " + brLabel(g.name), contents: card({
        color: "#b45309",
        headLabel: "งานค้าง · เหลือ " + remaining + " / " + expected.length + " งาน",
        headPct: expected.length > 0 ? ((expected.length - remaining) / expected.length) * 100 : null,
        headPctText: expected.length > 0 ? "ส่งแล้ว " + (expected.length - remaining) + " / " + expected.length + " งาน" : undefined,
        title: "⚠️ สิ้นผลัดแล้วงานยังไม่ครบ", sub: brLabel(g.name) + " · ผลัด" + d.name + " · " + fmtThaiDate(d.workDate),
        rows: [row2("วันที่งาน", fmtThaiDate(d.workDate), "#b45309"), row2("ยังเหลือ", remaining + " / " + expected.length + " งาน", "#dc2626"), row2("ผลัด", d.name, "#b45309")]
          .concat(expMgr.length ? [row2("งาน ผจก. (แยกต่างหาก)", (expMgr.length - mgrRemain) + " / " + expMgr.length + " งาน", mgrRemain ? "#b45309" : "#15803d")] : []),
        note: { text: "สิ้นผลัดแล้วแต่ยังส่งงานไม่ครบ โปรดเร่งส่งให้ครบ — ไม่ดำเนินการอาจมีผลทางวินัยค่ะ", color: "#b45309", bg: "#fff7ed" },
        photos: [], btn: "เปิดงานของฉัน", url }) };
      const ok = await pushLine(g.gid, [flex]);
      if (ok) sent++; else if (rv === "new") await unreserve(rkey);
    }
  }
  return sent;
}

// ===== scan:shift_close — "รายงานสิ้นผลัด" (Flex) เข้ากลุ่ม LINE ของสาขา =====
//   ยิงหลังเวลาเลิกกะ SHIFT_CLOSE_DELAY นาที · 1 ใบต่อ สาขา|ผลัด|วัน
//   หัวข้อที่แสดงรูป = งานที่ HR ติ๊ก task_defs.flex_report = true เท่านั้น
// ============================================================
// ★ 17 ก.ย. 69 — สรุปการเข้างานรายผลัด (แทน scanShiftOpen เดิม)
//   1 ผลัด = 1 ข้อความ (3 ข้อความ/วัน) · ม้วนกะย่อยเข้าผลัดหลักตาม main_shift
//   เงื่อนไขเวลายิง:
//     • ยิงทันทีที่ทุกคนในผลัดนั้น (รวมกะย่อย) สแกนหน้าเข้างานครบ
//     • ถ้ายังไม่ครบ → ยิงเมื่อพ้น 1 ชม. จากเวลาเข้างานของกะย่อยที่เริ่มช้าที่สุดของวันนั้น
//   กะที่ไม่สังกัดผลัดหลัก (Delivery, ผจก.) ต่อท้ายการ์ดผลัดแรกของวัน
// ============================================================
// ★ 17 ก.ย. 69 — สีการ์ดแยกตาม "ช่วงเวลาของผลัด" ให้จำได้ทันทีว่าใบไหนคือผลัดอะไร
//   อิงเวลาเริ่มกะจริง ไม่ผูกกับรหัสผลัด (เปลี่ยนชื่อ/เพิ่มผลัดใหม่ก็ยังทำงาน)
//   สถานะ (ครบ/สาย/ขาด) ไม่ได้อยู่ที่สีหัวการ์ดแล้ว — ไปอยู่ที่ตัวเลข 3 ช่องกับข้อความหัวเรื่องแทน
function shiftColor(startMin: number | null): string {
  if (startMin == null) return "#52525b";
  if (startMin < 11 * 60) return "#0369a1";       // เช้า — ฟ้า
  if (startMin < 18 * 60) return "#ea8c00";       // บ่าย — ส้ม
  return "#6d28d9";                                // ดึก — ม่วง
}
const ATTEND_GRACE = 60;          // นาทีหลังกะย่อยสุดท้ายเริ่ม → ยิงแม้คนยังไม่ครบ
const ATTEND_STALE = 180;         // เลยกำหนดเกินเท่านี้ ไม่ยิงย้อน — รายงานเข้างานที่ช้า 3 ชม.
                                  // ไม่มีประโยชน์แล้ว เหลือไว้พอกัน cron ล่มสั้น ๆ

async function scanAttendSummary(): Promise<number> {
  const gid = await mgrGroupId();
  if (!gid) return 0;
  const now = new Date(Date.now() + TZ);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const hm = (t: any) => { const m = String(t || "").match(/(\d{1,2}):(\d{2})/); return m ? (+m[1] * 60 + +m[2]) : null; };
  const today = bkkDateStr();
  const yest = addDaysStr(today, -1);

  const { data: shifts } = await sb.from("shifts").select("shift_id,name,main_shift,start_time,report_shift");
  if (!shifts || !shifts.length) return 0;
  const shBy: Record<string, any> = {}; (shifts as any[]).forEach((x) => shBy[String(x.shift_id)] = x);
  const grpOf = (sid: string) => { const x = shBy[sid]; const m = x && x.main_shift ? String(x.main_shift).trim() : ""; return m || sid; };
  const mains = (shifts as any[]).filter((x) => grpOf(String(x.shift_id)) === String(x.shift_id) && x.report_shift === true)
    .sort((a, b) => (hm(a.start_time) ?? 0) - (hm(b.start_time) ?? 0));
  if (!mains.length) return 0;
  const mainIds = new Set(mains.map((x) => String(x.shift_id)));
  const earliest = String(mains[0].shift_id);
  const bn = await branchNames();
  let sent = 0;

  for (const day of [today, yest]) {
    const dayOff = day === today ? 0 : 1440;      // ของเมื่อวาน = เลื่อนแกนเวลาไป 1 วัน
    const nowRel = nowMin + dayOff;
    const [{ data: sch }, { data: att }] = await Promise.all([
      sb.from("schedules").select("emp_id,branch_id,shift_id").eq("work_date", day),
      sb.from("attendance").select("emp_id,check_in,late_min").eq("work_date", day),
    ]);
    if (!sch || !sch.length) continue;
    const ids = [...new Set((sch as any[]).map((x) => String(x.emp_id)))];
    const { data: emps } = await sb.from("employees").select("emp_id,name,nickname").in("emp_id", ids);
    const nm: Record<string, string> = {}; (emps || []).forEach((e: any) => { nm[e.emp_id] = e.nickname || e.name || e.emp_id; });
    const attBy: Record<string, any> = {}; (att || []).forEach((a: any) => { attBy[String(a.emp_id)] = a; });

    const G: Record<string, any[]> = {}; const extra: any[] = [];
    for (const x of (sch as any[])) {
      const sid = String(x.shift_id); const g = grpOf(sid);
      const rec = { emp_id: String(x.emp_id), bid: String(x.branch_id || "-"), sid, grp: g };
      if (mainIds.has(g)) (G[g] = G[g] || []).push(rec); else extra.push(rec);
    }

    for (const mn of mains) {
      const g = String(mn.shift_id);
      const list = (G[g] || []).concat(g === earliest ? extra : []);
      if (!list.length) continue;

      let lastStart = -1;
      for (const r of list) { const st = hm(shBy[r.sid]?.start_time); if (st != null && st > lastStart) lastStart = st; }
      if (lastStart < 0) continue;
      const allIn = list.every((r) => !!attBy[r.emp_id]?.check_in);
      const deadline = lastStart + ATTEND_GRACE;
      // ★ แก้ 17 ก.ย. 69 — ด่านกันข้อมูลเก่าต้องทำงาน "เสมอ" ไม่ใช่เฉพาะตอนมีคนขาด
      //   ของเดิมเขียน (!allIn && เก่าเกิน) ทำให้ผลัดเมื่อวานที่ทุกคนเข้าครบรอดด่านไปยิงซ้ำ
      if ((nowRel - deadline) > ATTEND_STALE) continue;       // เลยเวลามานานแล้ว ไม่ต้องยิงย้อน
      if (!allIn && nowRel < deadline) continue;              // ยังไม่ครบ และยังไม่ถึงเส้นตาย

      const rkey = "attend:" + g + ":" + day;
      const rv = await reserve(rkey, "");
      if (rv === "dup") continue;

      // ★ แก้ 17 ก.ย. 69 — ป้ายกะย่อยต้องสั้น ไม่งั้นโดนตัดกลางคำ ("Delivery (วิ...")
      const tagOf = (sid: string) => {
        if (sid === g) return "";                       // กะหลักของการ์ดนี้ ไม่ต้องติดป้าย
        const x = shBy[sid] || {};
        const mm = x.main_shift ? String(x.main_shift).trim() : "";
        if (!mm) return sid === "D" ? "ไรเดอร์" : (x.code ? String(x.code) : sid);
        if (mm === sid) return String(x.name || sid);   // กลุ่มยืนเดี่ยว เช่น ผจก.
        return x.code ? ("กะ " + x.code) : sid;         // กะย่อย → "กะ 8", "กะ 16"
      };
      const stOf = (r: any) => { const a = attBy[r.emp_id]; if (!a?.check_in) return "none"; return Number(a.late_min || 0) > 0 ? "late" : "ok"; };
      const lateMin = (r: any) => Number(attBy[r.emp_id]?.late_min || 0);
      const okN = list.filter((r) => stOf(r) === "ok").length;
      const lateN = list.filter((r) => stOf(r) === "late").length;
      const noN = list.filter((r) => stOf(r) === "none").length;
      const color = shiftColor(hm(mn.start_time));
      const hhmm = (iso: string) => { try { const d2 = new Date(new Date(iso).getTime() + TZ); return String(d2.getUTCHours()).padStart(2, "0") + ":" + String(d2.getUTCMinutes()).padStart(2, "0"); } catch { return "—"; } };
      const tile = (n: number, lb: string, c: string) => ({ type: "box", layout: "vertical", backgroundColor: "#f4f4f5", cornerRadius: "8px", paddingAll: "8px", contents: [
        { type: "text", text: String(n), size: "xl", weight: "bold", align: "center", color: n ? c : "#a1a1aa" },
        { type: "text", text: lb, size: "xxs", align: "center", color: "#8c8c8c" }] });

      const rows: any[] = [{ type: "box", layout: "horizontal", spacing: "sm", contents: [
        tile(okN, "ตรงเวลา", "#16a34a"), tile(lateN, "สาย", "#d97706"), tile(noN, "ไม่มา", "#dc2626")] }];

      // ★ ทุกแถวต้องมีครบ 4 ช่อง flex เท่ากันเสมอ (ช่องว่างใส่ " ")
      //   ของเดิมใส่ช่องป้ายเฉพาะคนที่มีกะย่อย ทำให้คอลัมน์เวลาของแต่ละแถวเลื่อนไม่ตรงกัน
      const personRow = (r: any) => {
        const a = attBy[r.emp_id]; const st = stOf(r);
        return { type: "box", layout: "baseline", spacing: "sm", contents: [
          // ★ 17 ก.ย. 69 — ชื่อทุกคนน้ำหนักเท่ากัน ไม่ตัวหนาเฉพาะบางคน อ่านเป็นคอลัมน์เดียวกัน
          //   สถานะสาย/ขาด บอกด้วยสีตัวอักษร + ช่องขวาสุดแทน
          { type: "text", text: nm[r.emp_id] || r.emp_id, size: "sm", flex: 6,
            weight: "regular", color: st === "none" ? "#dc2626" : "#18181b" },
          { type: "text", text: tagOf(r.sid) || " ", size: "xxs", color: "#8c8c8c", flex: 3 },
          { type: "text", text: a?.check_in ? hhmm(a.check_in) : "—", size: "xs", color: "#8c8c8c", flex: 3, align: "end" },
          { type: "text", text: st === "none" ? "ไม่มา" : st === "late" ? ("สาย " + lateMin(r) + "′") : " ",
            size: "xxs", weight: "bold", flex: 4, align: "end", color: st === "none" ? "#dc2626" : "#d97706" },
        ] };
      };
      const rank = (r: any) => stOf(r) === "none" ? 0 : stOf(r) === "late" ? 1 : 2;
      const inMain = list.filter((r) => mainIds.has(r.grp));
      const inExtra = list.filter((r) => !mainIds.has(r.grp));
      const byBr: Record<string, any[]> = {};
      inMain.forEach((r) => { (byBr[r.bid] = byBr[r.bid] || []).push(r); });
      const brLbl = (b2: string) => String(bn[b2] || b2).replace(/^\s*สาขา\s*/, "");
      for (const bid of Object.keys(byBr).sort((x, y) => brLbl(x) < brLbl(y) ? -1 : 1)) {
        rows.push({ type: "text", text: brLbl(bid), size: "xxs", weight: "bold", color: "#8c8c8c", margin: "md" });
        byBr[bid].sort((x, y) => rank(x) - rank(y) || lateMin(y) - lateMin(x)).forEach((r) => rows.push(personRow(r)));
      }
      if (inExtra.length) {
        rows.push({ type: "separator", margin: "md" });
        rows.push({ type: "text", text: "นอกผลัดหลัก", size: "xxs", weight: "bold", color: "#8c8c8c", margin: "md" });
        inExtra.sort((x, y) => rank(x) - rank(y) || lateMin(y) - lateMin(x)).forEach((r) => rows.push(personRow(r)));
      }

      const subNames = [...new Set(inMain.filter((r) => r.sid !== g).map((r) => tagOf(r.sid)).filter(Boolean))];
      const head = noN ? ("ไม่มา " + noN + (lateN ? " · สาย " + lateN : "")) : lateN ? ("มีสาย " + lateN + " คน") : "เข้างานครบตรงเวลา";
      const flex = { type: "flex", altText: "เข้างานผลัด" + (mn.name || g) + " · " + head, contents: card({
        color, headLabel: "ผลัด" + (mn.name || g) + " · " + head,
        title: "สรุปการเข้างาน",
        sub: (subNames.length ? "รวมกะย่อย " + subNames.join(", ") + " · " : "") + Object.keys(byBr).length + " สาขา · " + fmtThaiDate(day),
        rows,
        note: noN
          ? { text: "ยังไม่ลงเวลา " + noN + " คน: " + list.filter((r) => stOf(r) === "none").map((r) => nm[r.emp_id] || r.emp_id).join(", ")
                  + "\nยิงอัตโนมัติเมื่อพ้น 1 ชม. หลังกะย่อยสุดท้ายเริ่มงาน", color: "#991b1b", bg: "#fef2f2" }
          : (allIn ? undefined : { text: "ยิงอัตโนมัติเมื่อพ้น 1 ชม. หลังกะย่อยสุดท้ายเริ่มงาน", color: "#92400e", bg: "#fef3c7" }),
        photos: [], btn: "ดูรายละเอียดการลงเวลา", url: APP_URL + "/hr/",
      }) };
      const ok = await pushLine(gid, [flex]);
      if (ok) sent++; else if (rv === "new") await unreserve(rkey);
    }
  }
  return sent;
}

const SHIFT_CLOSE_DELAY = 20;
const SHIFT_CLOSE_WINDOW = 45;   // ต้องรัน cron ทุก ≤ 30 นาที
function _tsPick(o: any, d: any, k: string) { return (o && o[k] != null) ? o[k] : d[k]; }
function expectedForBranch(bid: string, workDate: string, sid: string, defs: any[], ovs: any[], dts: any[], v2: Set<string>): any[] {
  if (!v2.has(bid)) return defs.filter((d: any) => d.active !== false && (!d.shift_id || String(d.shift_id) === sid));
  const ov: Record<string, any> = {}; ovs.forEach((o: any) => { if (String(o.branch_id) === bid) ov[o.task_def_id] = o; });
  const dt: Record<string, any> = {}; dts.forEach((x: any) => { if (String(x.branch_id) === bid && String(x.work_date) === workDate) dt[x.task_def_id] = x; });
  const d0 = new Date(workDate + "T00:00:00Z");
  const dayNum = d0.getUTCDate(), dow = d0.getUTCDay();
  const lastDay = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 0)).getUTCDate();
  return defs.filter((d: any) => {
    const o = ov[d.id] || null;
    const act = (o && o.active != null) ? !!o.active : (d.active !== false);
    if (!act) return false;
    const shifts = _tsPick(o, d, "shift_ids");
    if (Array.isArray(shifts) && shifts.length) { if (shifts.indexOf(sid) < 0) return false; }
    else if (d.shift_id && String(d.shift_id) !== sid) return false;
    const ex = dt[d.id];
    if (ex) return ex.mode !== "skip";
    const f = String(d.freq || "daily");
    if (f === "weekly") { const w = _tsPick(o, d, "days_of_week") || []; return w.length ? w.indexOf(dow) >= 0 : false; }
    if (f === "monthly") { const m = _tsPick(o, d, "day_of_month") || []; return m.length ? (m.indexOf(dayNum) >= 0 || (m.indexOf(0) >= 0 && dayNum === lastDay)) : false; }
    return true;
  });
}
// ★ หมวดงานตามมาตรฐานร้าน — SAVEQ (S A V E Q) · C ความสะอาด · QMS เอกสาร · Process
const QCAT_ORDER = ["S", "A", "V", "E", "Q", "C", "QMS", "PR", "-"];
const QCAT_NAME: Record<string, string> = {
  S: "S · บริการ", A: "A · สินค้า", V: "V · ป้าย/สื่อ", E: "E · สะดวกปลอดภัย",
  Q: "Q · คุณภาพ", C: "C · ความสะอาด", QMS: "QMS · เอกสาร", PR: "Process · ขั้นตอนงาน",
  "-": "อื่นๆ (ยังไม่จัดหมวด)",
};
function catHead(txt: string) {
  return { type: "text", text: "— " + txt + " —", size: "xxs", color: "#9ca3af", weight: "bold", margin: "md" };
}
function topicLine(icon: string, label: string, color: string, sub?: string) {
  return { type: "box", layout: "baseline", spacing: "sm", contents: [
    { type: "text", text: icon, size: "sm", flex: 0 },
    { type: "text", text: label + (sub ? ("  " + sub) : ""), size: "sm", color, wrap: true, flex: 9 },
  ] };
}
// only = ยิงรายงานเจาะจง สาขา/ผลัด/วัน ทันที (หัวหน้าผลัดกดปุ่ม "ส่งผลัด")
//        ไม่ระบุ = สแกนตามรอบเวลาสิ้นผลัดเหมือนเดิม
async function scanShiftClose(only?: { bid: string; sid: string; workDate: string }): Promise<number> {
  const groups = await branchGroups(); const cfg = await loadCfg();
  const now = new Date(Date.now() + TZ);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const todayStr = bkkDateStr();
  const hm = (t: any) => { const m = String(t || "").match(/(\d{1,2}):(\d{2})/); return m ? (+m[1] * 60 + +m[2]) : null; };
  const { data: shifts } = await sb.from("shifts").select("shift_id,name,start_time,end_time,main_shift,report_shift");
  const okShift = reportFilter(shifts || []);
  if (!shifts || !shifts.length) return 0;
  const due: { sid: string; name: string; workDate: string }[] = [];
  if (only) {
    const sh0 = (shifts as any[]).find((x: any) => String(x.shift_id) === String(only.sid));
    due.push({ sid: String(only.sid), name: (sh0 && sh0.name) || String(only.sid), workDate: only.workDate });
  } else {
    for (const s of (shifts as any[])) {
      if (!okShift(s)) continue;                                      // ★ เฉพาะผลัดหลัก เช้า/บ่าย/ดึก
      const st = hm(s.start_time), en = hm(s.end_time); if (en == null) continue;
      const t = en + SHIFT_CLOSE_DELAY;
      const overnight = st != null && en <= st;
      if (nowMin >= t && nowMin < t + SHIFT_CLOSE_WINDOW) due.push({ sid: String(s.shift_id), name: s.name || String(s.shift_id), workDate: overnight ? addDaysStr(todayStr, -1) : todayStr });
    }
  }
  if (!due.length) return 0;
  // ★ 16 ก.ย. 69 — รอบ cron: ข้ามกะที่หัวหน้าผลัดกดส่งผลัดไปแล้ว (ยิงรายงานไปตอนนั้นแล้ว)
  //   กันชั้นที่สองเผื่อแถว reserve หาย/พลาด — cron จะส่งเฉพาะผลัดที่ "ไม่มีใครกดส่งผลัดเลย"
  const submittedKeys = new Set<string>();
  if (!only) {
    try {
      const wds = [...new Set(due.map((d) => d.workDate))];
      const { data: subs } = await sb.from("shift_submits").select("branch_id,shift_id,work_date").in("work_date", wds);
      for (const r of ((subs || []) as any[])) submittedKeys.add(String(r.branch_id) + ":" + String(r.shift_id) + ":" + String(r.work_date));
    } catch (_e) { /* อ่านไม่ได้ — ปล่อยให้ rkey กันซ้ำแทน */ }
  }

  const [{ data: defsData }, { data: ovsData }, { data: brData }] = await Promise.all([
    sb.from("task_defs").select("*"),
    sb.from("task_def_branches").select("*"),
    sb.from("branches").select("branch_id,task_v2"),
  ]);
  const defs = (defsData || []).slice().sort((a: any, b: any) => ((a.sort || 0) - (b.sort || 0)) || (a.id - b.id));
  const v2 = new Set<string>((brData || []).filter((b: any) => b.task_v2).map((b: any) => String(b.branch_id)));
  let sent = 0;

  for (const d of due) {
    const { data: dtsData } = await sb.from("task_def_dates").select("*").eq("work_date", d.workDate);
    const [{ data: asg }, { data: sch }, { data: leads }, { data: gds }] = await Promise.all([
      sb.from("task_assignments").select("*").eq("shift_id", d.sid).eq("work_date", d.workDate),
      sb.from("schedules").select("branch_id").eq("shift_id", d.sid).eq("work_date", d.workDate),
      sb.from("shift_leads").select("branch_id,emp_name").eq("shift_id", d.sid).eq("work_date", d.workDate),
      // ★ 15 ก.ย. 69 — ผลรับสินค้าของผลัดนี้ เข้ารายงานสิ้นผลัด
      sb.from("goods_receipts").select("branch_id,shift_id,no_delivery,crates_in,crates_return,warehouse_name")
        .eq("shift_id", d.sid).eq("work_date", d.workDate),
    ]);
    const gdBy: Record<string, any[]> = {};
    (gds || []).forEach((r: any) => { const b = String(r.branch_id || ""); (gdBy[b] = gdBy[b] || []).push(r); });
    const leadBy: Record<string, string> = {}; (leads || []).forEach((l: any) => { leadBy[String(l.branch_id)] = l.emp_name || ""; });
    const bset = new Set<string>();
    (asg || []).forEach((a: any) => { if (a.branch_id) bset.add(String(a.branch_id)); });
    (sch || []).forEach((x: any) => { if (x.branch_id) bset.add(String(x.branch_id)); });

    if (only) { bset.clear(); bset.add(String(only.bid)); }
    for (const bid of bset) {
      const g = groups[bid]; if (!g) continue;
      const c = cfgOf(cfg, bid); if (!c.enabled) continue;
      const expAll = expectedForBranch(bid, d.workDate, d.sid, defs, ovsData || [], dtsData || [], v2)
        .filter((x: any) => !x.auto_day && !x.per_employee);   // ★ งานสุ่มวัน/งานรายบุคคล ไม่ใช่งานระดับสาขา
      // ★ 15 ก.ย. 69 — งาน ผจก. นับแยกจากยอดของผลัด
      const expected = expAll.filter((x: any) => !x.mgr_owner);
      const expMgr   = expAll.filter((x: any) =>  x.mgr_owner);
      if (!expected.length && !expMgr.length) continue;
      const rows0 = (asg || []).filter((a: any) => String(a.branch_id) === bid);
      const byDef: Record<string, any> = {}; rows0.forEach((a: any) => { byDef[a.task_def_id] = a; });

      let done = 0, pending = 0, back = 0;
      const missing: string[] = [];
      // ★ 15 ก.ย. 69 — งานที่หัวหน้าผลัดปิดเพราะทำไม่ได้จริง (พร้อมเหตุผล) นับแยก ไม่ใช่งานค้าง
      const closedList: { title: string; why: string; who: string }[] = [];
      for (const df of expected) {
        const a = byDef[df.id];
        const st = a ? String(a.status || "todo") : "todo";
        if (st === "approved") done++;
        else if (st === "submitted") { done++; pending++; }
        else if (st === "sent_back") back++;
        else if (st === "closed") closedList.push({ title: String(df.title || ""),
          why: String((a && a.closed_reason) || ""), who: String((a && a.closed_by_name) || "") });
        else missing.push(String(df.title || "").slice(0, 24));
      }
      const total = expected.length;
      // ★ 15 ก.ย. 69 — งาน ผจก. นับแยกจากยอดของผลัด
      let mgrDone = 0, mgrBack = 0; const mgrMissing: string[] = [];
      for (const df of expMgr) {
        const a = byDef[df.id];
        const st = a ? String(a.status || "todo") : "todo";
        if (st === "approved" || st === "submitted") mgrDone++;
        else if (st === "sent_back") mgrBack++;
        else if (st === "closed") closedList.push({ title: String(df.title || ""),
          why: String((a && a.closed_reason) || ""), who: String((a && a.closed_by_name) || "") });
        else mgrMissing.push(String(df.title || "").slice(0, 24));
      }
      const mgrTotal = expMgr.length;
      const pct = total > 0 ? (done / total) * 100 : null;
      const allOk = missing.length === 0 && back === 0;
      const color = missing.length ? "#dc2626" : (back ? "#b45309" : (pending ? "#0369a1" : "#15803d"));

      // ---- หัวข้อที่ตั้งค่าให้เข้ารายงาน + รูป ----
      //   ★ จัดกลุ่มตามหมวด SAVEQ / C / QMS / Process
      //   ★ ท้ายบรรทัดแสดง "ชื่อผู้รับผิดชอบ" (คนที่ทำงานนั้น) ไม่ใช่ชื่อผู้ตรวจ
      //   ★ รูปเอาหัวข้อละ 1 รูปพอ
      const picked = expected.filter((df: any) => !!df.flex_report);
      const byCat: Record<string, any[]> = {};
      const photoPick: string[][] = [];
      for (const df of picked) {
        const a = byDef[df.id];
        const st = a ? String(a.status || "todo") : "todo";
        const label = String(df.flex_label || df.title || "");
        const who = a ? String(a.emp_name || a.emp_id || "").slice(0, 14) : "";
        let ln: any;
        if (st === "approved") ln = topicLine("✅", label, "#15803d", who ? ("· " + who) : "");
        else if (st === "submitted") ln = topicLine("🟡", label, "#0369a1", (who ? ("· " + who + " ") : "") + "· รอตรวจ");
        else if (st === "sent_back") ln = topicLine("🔴", label, "#dc2626", (who ? ("· " + who + " ") : "") + "· ถูกตีกลับ");
        else ln = topicLine("⬜", label, "#8c8c8c", "· ยังไม่ส่ง");
        const cat = QCAT_ORDER.indexOf(String(df.qssi_cat || "-")) >= 0 ? String(df.qssi_cat || "-") : "-";
        (byCat[cat] = byCat[cat] || []).push(ln);
        if (a && Array.isArray(a.photos) && a.photos.length) photoPick.push(a.photos.filter((u: any) => typeof u === "string"));
      }
      const lines: any[] = [];
      let nTopic = 0;
      for (const c of QCAT_ORDER) {
        const g = byCat[c]; if (!g || !g.length) continue;
        lines.push(catHead(QCAT_NAME[c] || c));
        for (const l of g) { lines.push(l); nTopic++; }
      }
      // ★ 15 ก.ย. 69 — งาน ผจก. นับแยกจากยอดของผลัด
      let mgrHead = false;
      for (const df of expMgr.filter((x: any) => !!x.flex_report)) {
        const a = byDef[df.id];
        const st = a ? String(a.status || "todo") : "todo";
        const label = String(df.flex_label || df.title || "");
        const who = a ? String(a.emp_name || a.emp_id || "").slice(0, 14) : "";
        let ln: any;
        if (st === "approved") ln = topicLine("✅", label, "#15803d", who ? ("· " + who) : "");
        else if (st === "submitted") ln = topicLine("🟡", label, "#0369a1", (who ? ("· " + who + " ") : "") + "· รอตรวจ");
        else if (st === "sent_back") ln = topicLine("🔴", label, "#dc2626", (who ? ("· " + who + " ") : "") + "· ถูกตีกลับ");
        else ln = topicLine("⬜", label, "#8c8c8c", "· ยังไม่ส่ง");
        if (!mgrHead) { lines.push(catHead("งาน ผจก.")); mgrHead = true; }
        lines.push(ln); nTopic++;
      }
      // หัวข้อละ 1 รูป (เลือกรูปแรกที่เปิดได้จริง) รวมไม่เกิน 8 รูป
      let photoUrls: string[] = [];
      for (const list of photoPick) {
        if (photoUrls.length >= 8) break;
        const ok = await usablePhotos(list.slice(0, 3), 3);
        if (ok.length && photoUrls.indexOf(ok[0]) < 0) photoUrls.push(ok[0]);
      }

      const rows: any[] = [
        row2("ผลัด", d.name + " · " + fmtThaiDate(d.workDate)),
        row2("หัวหน้าผลัด", leadBy[bid] || "— ไม่มีใครกดรับ —", leadBy[bid] ? "#111111" : "#dc2626"),
        row2("ส่งงาน", done + " / " + total + " งาน", allOk ? "#15803d" : "#b45309"),
      ];
      // ★ รับสินค้าผลัดนี้
      {
        const gl = gdBy[bid] || [];
        const nod = gl.some((r: any) => !!r.no_delivery);
        const real = gl.filter((r: any) => !r.no_delivery);
        if (nod) rows.push(row2("รับสินค้า", "ผลัดนี้ไม่มีสินค้าจัดส่ง", "#64748b"));
        else if (real.length) {
          const cin = real.reduce((s: number, r: any) => s + (r.crates_in || 0), 0);
          const cret = real.reduce((s: number, r: any) => s + (r.crates_return || 0), 0);
          rows.push(row2("รับสินค้า", real.length + " ใบ · ลังเข้า " + cin + " · ลังคืน " + cret, "#15803d"));
        }
      }
      if (mgrTotal) rows.push(row2("งาน ผจก. (แยกต่างหาก)", mgrDone + " / " + mgrTotal + " งาน" + (mgrBack ? (" · ตีกลับ " + mgrBack) : ""), (mgrMissing.length || mgrBack) ? "#b45309" : "#15803d"));
      if (pending) rows.push(row2("รอผลัดถัดไปตรวจ", pending + " งาน", "#0369a1"));
      if (back) rows.push(row2("ถูกตีกลับ", back + " งาน", "#dc2626"));
      if (missing.length) rows.push(row2("ยังไม่ส่ง", missing.slice(0, 4).join(", ").slice(0, 70) + (missing.length > 4 ? (" +" + (missing.length - 4)) : ""), "#dc2626"));
      if (closedList.length) rows.push(row2("ปิดงาน (ทำไม่ได้)", closedList.length + " งาน", "#b45309"));
      // ★ เหตุผลของงานที่ปิดเพราะทำไม่ได้ — ให้ ผจก. เห็นในรายงานเลย
      if (closedList.length) {
        rows.push({ type: "separator", margin: "md" });
        rows.push({ type: "text", text: "ปิดงานเพราะทำไม่ได้ (" + closedList.length + ")", size: "xs", color: "#b45309", margin: "md" });
        for (const c of closedList.slice(0, 5)) {
          rows.push({ type: "text", text: "• " + c.title, size: "xs", color: "#111111", weight: "bold", wrap: true, margin: "sm" });
          rows.push({ type: "text", text: c.why.slice(0, 160) + (c.who ? ("  — " + c.who) : ""), size: "xxs", color: "#6b7280", wrap: true });
        }
        if (closedList.length > 5) rows.push({ type: "text", text: "…อีก " + (closedList.length - 5) + " งาน ดูในแอป", size: "xxs", color: "#8c8c8c" });
      }
      if (lines.length) {
        rows.push({ type: "separator", margin: "md" });
        rows.push({ type: "text", text: "หัวข้อที่ต้องรายงาน (" + nTopic + ")", size: "xs", color: "#8c8c8c", margin: "md" });
        const CAP = 22;   // นับรวมหัวหมวดด้วย
        for (const l of lines.slice(0, CAP)) rows.push(l);
        if (lines.length > CAP) rows.push({ type: "text", text: "…ดูหัวข้อที่เหลือในแอป", size: "xs", color: "#8c8c8c" });
      }

      const note = missing.length
        ? { text: "สิ้นผลัดแล้วยังมีงานไม่ได้ส่ง " + missing.length + " รายการ — ผลัดถัดไปรับงานต่อพร้อมงานค้างนี้", color: "#991b1b", bg: "#fef2f2" }
        : (back ? { text: "มีงานถูกตีกลับ " + back + " รายการ ต้องแก้ให้จบก่อนปิดวัน", color: "#92400e", bg: "#fffbeb" }
          : (pending ? { text: "ส่งงานครบแล้ว รอผลัดถัดไปตรวจ " + pending + " รายการ", color: "#075985", bg: "#f0f9ff" }
            : { text: "ปิดผลัดเรียบร้อย งานครบและตรวจผ่านทั้งหมด 💚", color: "#15803d", bg: "#f0fdf4" }));

      // ★ 16 ก.ย. 69 — เดิมใช้คนละกุญแจ (shift_submit: / shift_close:) ทำให้รายงานเข้าไลน์ 2 รอบ
      //   (รอบแรกตอนหัวหน้าผลัดกดส่งผลัด อีกรอบตอน cron กวาดตามเวลาเลิกกะ)
      //   ใหม่: กุญแจเดียว — ใครส่งก่อนได้ไป อีกทางจะเจอ dup แล้วข้าม
      const rkey = "shift_close:" + bid + ":" + d.sid + ":" + d.workDate;
      if (!only && submittedKeys.has(bid + ":" + d.sid + ":" + d.workDate)) continue;   // ★ ส่งผลัดไปแล้ว ไม่ต้องยิงซ้ำ
      const rv = await reserve(rkey, bid); if (rv === "dup") continue;
      const url = APP_URL + "/handover/?go=review";   // ★ เปิดหน้า "ตรวจรับผลัด" ให้เลย
      const flex = { type: "flex", altText: "รายงานสิ้นผลัด" + d.name + " " + brLabel(g.name) + " — ส่งงาน " + done + "/" + total, contents: card({
        color,
        headLabel: (allOk ? "ปิดผลัดครบ" : (missing.length ? "มีงานค้าง" : "มีงานต้องแก้")) + " · ส่งแล้ว " + done + " / " + total + " งาน",
        headPct: pct, headPctText: pct != null ? Math.round(pct) + "% ของงานในผลัดนี้" : undefined,
        title: only ? "📋 หัวหน้าผลัดส่งผลัดแล้ว — ตรวจงานได้เลย" : (allOk ? "📋 รายงานสิ้นผลัด" : "📋 รายงานสิ้นผลัด — ยังไม่เรียบร้อย"),
        sub: brLabel(g.name) + " · ผลัด" + d.name + " · " + fmtThaiDate(d.workDate),
        rows, note, photos: photoUrls, btn: "ตรวจรับผลัด", url }) };
      const ok = await pushLine(g.gid, [flex]);
      if (ok) sent++; else if (rv === "new") await unreserve(rkey);
    }
  }
  return sent;
}

// ★ 9 ก.ย. 2569 — QSSI: เตือนซ้ำเมื่อ "มอบหมายแล้วเงียบเกิน 1 วัน"
//   กติกา: ยังมีข้อค้าง + ไม่มีความเคลื่อนไหว (มอบหมายล่าสุด/ส่งงานล่าสุด) มาแล้ว ≥ 1 วัน
//   กันซ้ำวันละครั้งต่อสาขาด้วย staff_notify_log · สาขาที่ส่งครบแล้วไม่ยิงเลย
const QSSI_CAT_LABEL: Record<string, string> = { S: "S · บริการ", A: "A · สินค้า", V: "V · สื่อ/ป้าย", E: "E · สภาพแวดล้อม", Q: "Q · คุณภาพ", C: "C · ความสะอาด", QMS: "QMS · เอกสาร/ประชุม", Process: "Process · ความรู้พนักงาน" };

async function scanQssiDue(): Promise<number> {
  const today = bkkDateStr();
  const cycle = today.slice(0, 7);
  const cutoff = Date.now() - 24 * 3600 * 1000;   // "เงียบเกิน 1 วัน"
  let sent = 0;

  const { data: asgAll } = await sb.from("qssi_assignments").select("branch_id,emp_id,emp_name,item_id,due_date,created_at").eq("cycle", cycle);
  if (!asgAll || !asgAll.length) return 0;
  const { data: items } = await sb.from("qssi_check_items").select("id,cat,code,title").eq("active", true);
  const itById: Record<string, any> = {}; for (const it of (items || [])) itById[String(it.id)] = it;

  const byBranch: Record<string, any[]> = {};
  for (const a of asgAll) (byBranch[String(a.branch_id)] = byBranch[String(a.branch_id)] || []).push(a);

  for (const bid of Object.keys(byBranch)) {
    try {
      // เคารพสวิตช์ปิดแจ้งเตือนรายสาขา
      const { data: cf } = await sb.from("staff_notify_cfg").select("enabled").eq("branch_id", bid).maybeSingle();
      if (cf && cf.enabled === false) continue;

      const asg = byBranch[bid];
      const ids = Array.from(new Set(asg.map((a: any) => Number(a.item_id))));
      const { data: lg } = await sb.from("qssi_check_logs").select("item_id,created_at").eq("branch_id", bid).eq("cycle", cycle).in("item_id", ids);
      const doneSet = new Set((lg || []).map((x: any) => Number(x.item_id)));
      const pendingIds = ids.filter((id) => !doneSet.has(id));
      if (!pendingIds.length) continue;                       // ส่งครบแล้ว ไม่ต้องรบกวน

      // ความเคลื่อนไหวล่าสุด = มอบหมายล่าสุด หรือ ส่งงานล่าสุด อันไหนใหม่กว่า
      let last = 0;
      for (const a of asg) { const t = Date.parse(String(a.created_at || "")); if (t > last) last = t; }
      for (const x of (lg || [])) { const t = Date.parse(String((x as any).created_at || "")); if (t > last) last = t; }
      if (!last || last > cutoff) continue;                   // ยังไม่เงียบครบ 1 วัน

      const rkey = "qssi_due|" + bid + "|" + cycle + "|" + today;
      const rv = await reserve(rkey, bid); if (rv === "dup") continue;

      const { gid, name } = await branchGroup(bid);
      if (!gid) { if (rv === "new") await unreserve(rkey); continue; }

      // ค้างรายคน
      const per: Record<string, { name: string; cats: Record<string, number>; n: number }> = {};
      for (const a of asg) {
        if (doneSet.has(Number(a.item_id))) continue;
        const it = itById[String(a.item_id)]; if (!it) continue;
        const k = String(a.emp_id);
        per[k] = per[k] || { name: String(a.emp_name || a.emp_id), cats: {}, n: 0 };
        per[k].cats[it.cat] = (per[k].cats[it.cat] || 0) + 1;
        per[k].n++;
      }
      const late = Object.values(per).sort((x, y) => y.n - x.n);
      const doneNames = Array.from(new Set(asg.filter((a: any) => doneSet.has(Number(a.item_id))).map((a: any) => String(a.emp_name || a.emp_id))))
        .filter((n2) => !late.some((p2) => p2.name === n2));

      const pct = Math.round((doneSet.size * 100) / ids.length);
      const days = Math.max(1, Math.floor((Date.now() - last) / 86400000));
      const dueRaw = (asg.find((a: any) => a.due_date) || {}).due_date || "";
      const overdue = dueRaw && dueRaw < today;

      const whoRows: any[] = [{ type: "text", text: "ใครยังค้าง", size: "xs", color: "#8c8c8c", weight: "bold", margin: "md" }];
      for (const p2 of late) {
        const catTxt = Object.keys(p2.cats).map((c) => (QSSI_CAT_LABEL[c] || c) + " " + p2.cats[c] + " ข้อ").join(" · ");
        whoRows.push({ type: "box", layout: "baseline", spacing: "sm", margin: "sm", contents: [
          { type: "text", text: p2.name, size: "sm", weight: "bold", flex: 3, wrap: true },
          { type: "text", text: catTxt, size: "xs", color: "#334155", flex: 8, wrap: true },
        ] });
      }

      // ข้อค้างที่คะแนนสูงสุด 3 อันดับ (ให้เห็นว่าอะไรสำคัญก่อน)
      const { data: crit } = await sb.from("qssi_criteria").select("cat,item_no,max_score").eq("active", true);
      const scoreOf: Record<string, number> = {};
      for (const c of (crit || [])) scoreOf[String(c.cat) + "-" + String(c.item_no)] = Number(c.max_score) || 0;
      const sc = (it: any) => { const m = String(it?.code || "").match(/^([A-Za-z]+)-0*(\d+)$/); return m ? (scoreOf[m[1] + "-" + m[2]] || 0) : 0; };
      const hot = pendingIds.map((id) => itById[String(id)]).filter(Boolean)
        .sort((x: any, y: any) => sc(y) - sc(x)).slice(0, 3);
      const hotRows: any[] = hot.length ? [{ type: "separator", margin: "md" },
        { type: "text", text: "ข้อค้างที่คะแนนสูงสุด", size: "xs", color: "#8c8c8c", weight: "bold", margin: "md" },
        ...hot.map((it: any) => ({ type: "box", layout: "baseline", spacing: "sm", margin: "sm", contents: [
          { type: "text", text: String(it.code || ""), size: "xs", weight: "bold", color: "#b91c1c", flex: 2 },
          { type: "text", text: String(it.title || "").replace(/^ข้อ \d+ · /, ""), size: "xs", color: "#334155", flex: 9, wrap: true },
        ] }))] : [];

      const body: any[] = [
        { type: "text", text: "⏰ งาน QSSI ค้าง — เร่งให้เสร็จวันนี้", weight: "bold", size: "lg", color: "#18181b", wrap: true },
        { type: "text", text: brLabel(name), size: "sm", color: "#8c8c8c", wrap: true },
        { type: "separator", margin: "md" },
        { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: [
          row2("ค้างอยู่", pendingIds.length + " ข้อ จาก " + ids.length + " ข้อที่มอบหมาย", "#b91c1c"),
          row2("เงียบมาแล้ว", days + " วัน (ไม่มีใครส่งงานเพิ่ม)", "#b91c1c"),
          ...(dueRaw ? [row2("กำหนดส่ง", dueRaw + (overdue ? " — เลยกำหนดแล้ว" : ""), overdue ? "#b91c1c" : "#111111")] : []),
          ...(doneNames.length ? [row2("เสร็จแล้ว", doneNames.join(" · ") + " ✅", "#15803d")] : []),
        ] },
        { type: "separator", margin: "md" },
        { type: "box", layout: "vertical", contents: whoRows },
        ...hotRows,
        { type: "box", layout: "vertical", margin: "md", backgroundColor: "#fef2f2", cornerRadius: "8px", paddingAll: "10px", contents: [
          { type: "text", text: "🔴 ผู้ตรวจเข้าได้ทุกวัน ไม่มีใครรู้ล่วงหน้า — ทำให้เสร็จก่อนเลิกกะวันนี้\n📷 แนบรูปได้ไม่จำกัด · ข้อที่ถ่ายรูปไม่ได้ให้พิมพ์รายงานแทน", wrap: true, size: "xs", color: "#991b1b" } ] },
      ];
      const url = APP_URL + "/qssi/";
      const bubble: any = {
        type: "bubble",
        header: capHead("#B91C1C", "งาน QSSI ค้าง " + pendingIds.length + " ข้อ · รอบ " + cycle, pct, "ส่งแล้ว " + pct + "% (" + doneSet.size + "/" + ids.length + " ข้อ)"),
        body: { type: "box", layout: "vertical", contents: body },
        footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#B91C1C", action: { type: "uri", label: "เปิดงานที่ค้าง", uri: url } }] },
      };
      const ok = await pushLine(gid, [{ type: "flex", altText: "งาน QSSI ค้าง " + pendingIds.length + " ข้อ · เงียบมา " + days + " วัน — เร่งให้เสร็จวันนี้", contents: bubble }]);
      if (ok) sent++; else if (rv === "new") await unreserve(rkey);
    } catch (e) { console.warn("scanQssiDue branch " + bid, e); }
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
    // ★ ตารางเวรถูกแก้โดย ผจก. → ยิงทันที (ไม่ผ่าน cron)
    if (b.kind === "sched_change") return json({ ok: true, kind: "sched_change", sent: await sendSchedChange(b) });
    if (b.scan === "shift_open" || b.scan === "attend_summary") return json({ ok: true, scan: "attend_summary", sent: await scanAttendSummary() });
    if (b.scan === "shift_close") return json({ ok: true, scan: "shift_close", sent: await scanShiftClose() });
    if (b.scan === "qssi_due")  return json({ ok: true, scan: "qssi_due",  sent: await scanQssiDue() });
    // ★ หัวหน้าผลัดกด "ส่งผลัด" → ยิงรายงานผลัดนั้นเข้ากลุ่มทันที ไม่ต้องรอรอบเวลา
    if (b.kind === "shift_report") {
      const bid = String(b.branch_id || ""), sid = String(b.shift_id || "");
      const wd = String(b.work_date || "") || bkkDateStr();
      if (!bid || !sid) return json({ ok: false, error: "ต้องระบุสาขาและผลัด" }, 400);
      return json({ ok: true, kind: "shift_report", sent: await scanShiftClose({ bid, sid, workDate: wd }) });
    }

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
          color: "#15803d", hero: photos[0],
          headLabel: "เสร็จครบ · ส่งงาน " + expected.length + " / " + expected.length,
          headPct: 100, headPctText: "100% ของงานในผลัดนี้",
          title, sub: brLabel(name) + (shiftLabel ? " · ผลัด" + shiftLabel : "") + " · " + fmtThaiDate(wd),
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
    // ★ 9 ก.ย. 2569 — QSSI: การ์ดสรุปการมอบหมายงานเตรียมรับตรวจ (สั่งมือเท่านั้น)
    //   ตั้งใจให้ "ยิงตามสั่ง" ก่อน ยังไม่ผูกกับปุ่มบันทึกการมอบหมาย และยังไม่มีเตือนซ้ำอัตโนมัติ
    //   body: { kind:"qssi_assign", branch_id, cycle?:"YYYY-MM", due?:"today"|"tomorrow"|"YYYY-MM-DD", manual:true }
    if (b.kind === "qssi_assign") {
      const cycle = String(b.cycle || bkkDateStr().slice(0, 7));
      const [asgR, itR, crR] = await Promise.all([
        sb.from("qssi_assignments").select("emp_id,emp_name,item_id,due_date").eq("branch_id", String(b.branch_id)).eq("cycle", cycle),
        sb.from("qssi_check_items").select("id,cat,code,title,sort").eq("active", true).order("sort"),
        sb.from("qssi_criteria").select("cat,item_no,max_score").eq("active", true),
      ]);
      const asg = asgR.data || [], items = itR.data || [], crit = crR.data || [];
      if (!asg.length) return json({ ok: false, error: "ยังไม่มีการมอบหมายงาน QSSI ของสาขานี้ในรอบ " + cycle }, 400);

      const itById: Record<string, any> = {}; for (const it of items) itById[String(it.id)] = it;
      // คะแนนเต็มรายข้อ: จับคู่ code "C-31" กับ qssi_criteria (cat + item_no)
      const scoreOf: Record<string, number> = {};
      for (const c of crit) scoreOf[String(c.cat) + "-" + String(c.item_no)] = Number(c.max_score) || 0;
      const itemScore = (it: any) => {
        const m = String(it?.code || "").match(/^([A-Za-z]+)-0*(\d+)$/);
        return m ? (scoreOf[m[1] + "-" + m[2]] || 0) : 0;
      };
      const CAT_TH: Record<string, string> = { S: "S · บริการ", A: "A · สินค้า", V: "V · สื่อ/ป้าย", E: "E · สภาพแวดล้อม", Q: "Q · คุณภาพ", C: "C · ความสะอาด", QMS: "QMS · เอกสาร/ประชุม" };

      // รวมรายคน → หมวดที่รับผิดชอบ + จำนวนข้อ + คะแนนเต็มที่ถืออยู่
      const per: Record<string, { name: string; cats: Record<string, number>; n: number; max: number }> = {};
      let dueRaw = "";
      for (const a of asg) {
        const it = itById[String(a.item_id)]; if (!it) continue;
        const k = String(a.emp_id);
        per[k] = per[k] || { name: String(a.emp_name || a.emp_id), cats: {}, n: 0, max: 0 };
        per[k].cats[it.cat] = (per[k].cats[it.cat] || 0) + 1;
        per[k].n++; per[k].max += itemScore(it);
        if (!dueRaw && a.due_date) dueRaw = String(a.due_date);
      }
      const people = Object.values(per).sort((x, y) => y.max - x.max);

      // กำหนดส่ง: ใช้ค่าที่สั่งมา > ค่าในตาราง > ค่าเริ่มต้น = วันนี้
      const today = bkkDateStr(), tomorrow = addDaysStr(today, 1);
      const dueArg = String(b.due || "");
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dueArg) ? dueArg
        : dueArg === "tomorrow" ? tomorrow
        : dueArg === "today" ? today
        : (dueRaw || today);
      const dueTxt = dueDate === today ? "ภายในวันนี้ — ก่อนเลิกกะ"
        : dueDate === tomorrow ? "ภายในพรุ่งนี้ — ก่อนเลิกกะ"
        : "ภายใน " + dueDate;

      // ความคืบหน้าจริง (นับเฉพาะข้อที่ถูกมอบหมาย)
      const asgIds = Array.from(new Set(asg.map((a: any) => Number(a.item_id))));
      let doneN = 0;
      try {
        const { data: lg } = await sb.from("qssi_check_logs").select("item_id").eq("branch_id", String(b.branch_id)).eq("cycle", cycle).in("item_id", asgIds);
        doneN = new Set((lg || []).map((x: any) => Number(x.item_id))).size;
      } catch { /* */ }
      const pct = asgIds.length ? Math.round((doneN * 100) / asgIds.length) : 0;

      // ข้อ 100 คะแนนที่ยังไม่มีคนรับผิดชอบ — เตือนไว้ ไม่ให้หลุด
      const HOT = ["A-12", "Q-28"];
      const assignedCodes = new Set(asgIds.map((id) => String(itById[String(id)]?.code || "")));
      const hotMissing = HOT.filter((c) => !assignedCodes.has(c));
      const restN = items.length - asgIds.length;

      const rows: any[] = [
        row2("กำหนดส่ง", dueTxt, "#b91c1c"),
        row2("งานที่มอบหมาย", asgIds.length + " ข้อ · " + people.length + " คน (จากทั้งหมด " + items.length + " ข้อ)"),
      ];

      const whoRows: any[] = [{ type: "text", text: "ใครรับผิดชอบหมวดอะไร", size: "xs", color: "#8c8c8c", weight: "bold", margin: "md" }];
      for (const p2 of people) {
        const catTxt = Object.keys(p2.cats).map((c) => (CAT_TH[c] || c) + " " + p2.cats[c] + " ข้อ").join(" · ");
        whoRows.push({ type: "box", layout: "baseline", spacing: "sm", margin: "sm", contents: [
          { type: "text", text: p2.name, size: "sm", weight: "bold", flex: 3, wrap: true },
          { type: "text", text: catTxt + (p2.max ? ("  (เต็ม " + p2.max + ")") : ""), size: "xs", color: "#334155", flex: 8, wrap: true },
        ] });
      }

      const notes: any[] = [
        { type: "box", layout: "vertical", margin: "md", backgroundColor: "#fef2f2", cornerRadius: "8px", paddingAll: "10px", contents: [
          { type: "text", text: "⏱️ ทำให้เร็วที่สุด — ไม่มีใครรู้ว่าผู้ตรวจจะเข้าวันไหน ร้านต้องพร้อมทุกวัน\nส่งงานให้ครบตามกำหนด ระบบบันทึกชื่อผู้ส่งทุกครั้ง", wrap: true, size: "xs", color: "#991b1b" } ] },
        { type: "box", layout: "vertical", margin: "sm", backgroundColor: "#fff7ed", cornerRadius: "8px", paddingAll: "10px", contents: [
          { type: "text", text: "📷 ถ่ายรูปแนบได้ไม่จำกัดจำนวน · ข้อที่ถ่ายรูปไม่ได้ให้พิมพ์รายงานสั้น ๆ ว่าทำอะไรไป\nแต่ละข้อมี 🔎 สิ่งที่ต้องตรวจ และ ⚠ เกณฑ์การหักคะแนน ยกจากใบตรวจจริง — อ่านก่อนลงมือ", wrap: true, size: "xs", color: "#9a3412" } ] },
      ];
      if (hotMissing.length) notes.push({ type: "box", layout: "vertical", margin: "sm", backgroundColor: "#fef2f2", cornerRadius: "8px", paddingAll: "10px", contents: [
        { type: "text", text: "🔴 ยังไม่มอบหมายอีก " + restN + " ข้อ — รวม " + hotMissing.join(" และ ") + " ที่เป็นข้อ 100 คะแนน (10% ของใบตรวจ)\nA-12 สินค้า TOP 1-550 ขาด 5 SKU = 0 · Q-28 เจอสินค้าหมดอายุ 1 ชิ้น = 0 ทันที", wrap: true, size: "xs", color: "#991b1b" } ] });

      const body: any[] = [
        { type: "text", text: "🚨 มอบหมายงานเตรียมตรวจ QSSI", weight: "bold", size: "lg", color: "#18181b", wrap: true },
        { type: "text", text: brLabel(name), size: "sm", color: "#8c8c8c", wrap: true },
        { type: "separator", margin: "md" },
        { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: rows },
        { type: "separator", margin: "md" },
        { type: "box", layout: "vertical", contents: whoRows },
        ...notes,
      ];
      const url = APP_URL + "/qssi/";
      const bubble: any = {
        type: "bubble",
        header: capHead("#C2410C", "เตรียมรับตรวจ QSSI · รอบ " + cycle, pct, "ส่งงานแล้ว " + pct + "% (" + doneN + "/" + asgIds.length + " ข้อ)"),
        body: { type: "box", layout: "vertical", contents: body },
        footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#C2410C", action: { type: "uri", label: "เปิดเช็คลิสต์ QSSI", uri: url } }] },
      };
      const flex = { type: "flex", altText: "มอบหมายงาน QSSI " + asgIds.length + " ข้อ · ส่ง" + dueTxt + " — เริ่มทำทันที", contents: bubble };
      const ok = await pushLine(gid, [flex]);
      return json({ ok, sent: ok ? 1 : 0, cycle, items: asgIds.length, people: people.length, due: dueDate });
    }

    return json({ ok: false, error: "ไม่รู้จักประเภทการแจ้งเตือน (kind)" }, 400);
  } catch (e) { return json({ ok: false, error: String((e && (e as any).message) || e) }, 500); }
});

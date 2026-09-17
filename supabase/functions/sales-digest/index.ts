// ============================================================
// sales-digest — สรุปยอดขาย "เมื่อวาน" ทุกสาขา + บทวิเคราะห์จากนิดา
//   ส่งเข้ากลุ่ม ผจก. ทาง LINE ทุกเช้า (ตั้ง cron 10:00 ไทย ใน sales_digest_cron.sql)
// Secrets: LINE_CHANNEL_TOKEN, GEMINI_API_KEY (+ optional GEMINI_MODEL, APP_URL)
// deploy: supabase functions deploy sales-digest --no-verify-jwt
// ทดสอบ: POST body ว่าง {} หรือ {"date":"2026-08-21"} เพื่อระบุวันเอง
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LINE_TOKEN   = Deno.env.get("LINE_CHANNEL_TOKEN") ?? "";
const GKEY         = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL        = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const APP_URL      = (Deno.env.get("APP_URL") ?? "https://factzaa.github.io/HR-7-eleven").replace(/\/+$/, "");

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// ---- helpers ----
const baht = (n: number) => "฿" + Math.round(n || 0).toLocaleString("en-US");
const pct  = (n: number) => (n >= 0 ? "+" : "") + Math.round(n) + "%";
function bkkDate(offsetDays = 0): string {
  const now = new Date(Date.now() + 7 * 3600 * 1000); // → เวลาไทย
  now.setUTCDate(now.getUTCDate() + offsetDays);
  return now.toISOString().slice(0, 10);
}
// ★ 17 ก.ย. 69 — ตาข่ายกัน "ข้อความว่าง" ทำทั้งใบตกทั้งชุด
//   LINE ปฏิเสธทั้ง request (400) ถ้ามี text ใด text:"" แม้แต่ช่องเดียว
//   ผลคือรายงานยอดขายไม่เข้าไลน์เลยแบบเงียบ ๆ (17 ก.ย. เจอจริง — ใบแรก big:"" )
//   ตัดโหนดว่างทิ้งก่อนส่ง แล้วค่อยส่ง ดีกว่าปล่อยให้ทั้งชุดหาย
function stripEmptyText(n: any): any {
  if (Array.isArray(n)) {
    const out = n.map(stripEmptyText).filter((x: any) => x !== null);
    return out;
  }
  if (!n || typeof n !== "object") return n;
  if (n.type === "text" && (typeof n.text !== "string" || n.text.length === 0)) return null;
  const o: any = {};
  for (const k of Object.keys(n)) o[k] = stripEmptyText(n[k]);
  // กล่องที่ลูกหายหมดต้องมี filler ไม่งั้น LINE ตีกลับ contents ว่าง
  if (o.type === "box" && Array.isArray(o.contents) && o.contents.length === 0) o.contents = [{ type: "filler" }];
  return o;
}
async function pushLine(to: string, messages: unknown[]): Promise<boolean> {
  if (!LINE_TOKEN || !to) return false;
  try {
    const safe = stripEmptyText(messages);
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
      body: JSON.stringify({ to, messages: safe }),
    });
    if (!res.ok) { console.warn("LINE push failed", res.status, await res.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.warn("LINE push error", e); return false; }
}
// กลุ่ม ผจก.: app_settings key='mgr_group_id' ก่อน → ไม่มีก็หา line_groups.label LIKE '%ผจก%'
async function mgrGroupId(): Promise<string | null> {
  try {
    const { data: st } = await sb.from("app_settings").select("value").eq("key", "mgr_group_id").maybeSingle();
    if (st?.value) return String(st.value);
  } catch { /* */ }
  try {
    const { data } = await sb.from("line_groups").select("group_id,label,ignored,last_message_at").ilike("label", "%ผจก%").order("last_message_at", { ascending: false });
    const hit = (data || []).find((g: any) => !g.ignored);
    return hit ? hit.group_id : null;
  } catch { /* */ }
  return null;
}

type Agg = {
  branch_id: string; name: string;
  total: number; product: number; card: number;
  target_total: number; customers: number;
  allcafe: number; delivery: number;
  shifts: number; reported: boolean;
  shiftRows: number; hasClosing: boolean; complete: boolean; gotShifts: string[];   // ★ ยอดครบทุกผลัดหรือยัง
};
function newAgg(id: string, name: string): Agg {
  return { branch_id: id, name, total: 0, product: 0, card: 0, target_total: 0, customers: 0, allcafe: 0, delivery: 0, shifts: 0, reported: false, shiftRows: 0, hasClosing: false, complete: false, gotShifts: [] };
}
// แถว "ปิดยอด/สิ้นวัน" = ยอดรวมทั้งวัน (= เช้า+บ่าย+ดึก) — ห้ามเอาไปบวกกับรายผลัดอีก จะนับซ้ำ 2 เท่า
function isClosingShift(s: any): boolean { return /สิ้นวัน|สิ้นสุด|ปิดยอด|ทั้งวัน|รวมวัน|รวมทั้งวัน/.test(String(s || "")); }
// ชื่อผลัดมาตรฐาน — ตรงกับ shiftOrder ในหน้า hr/index.html · ใช้บอกว่าขาดผลัดไหน
const SHIFT_NAMES = ["เช้า", "บ่าย", "ดึก"];
const SHIFTS_PER_DAY = SHIFT_NAMES.length;
// เลือกแถวที่ใช้ต่อ (สาขา,วัน): ถ้ามีแถวปิดยอด → ใช้แถวปิดยอดอย่างเดียว · ไม่มี → ใช้รายผลัดรวมกัน
function dayUseRows(list: any[]): any[] { const c = list.filter(r => isClosingShift(r.shift)); return c.length ? c : list; }
function aggregate(rows: any[], branches: any[]): Agg[] {
  const brName: Record<string, string> = {};
  (branches || []).forEach((b: any) => brName[b.branch_id] = b.name);
  const by: Record<string, Agg> = {};
  (branches || []).forEach((b: any) => { by[b.branch_id] = newAgg(b.branch_id, b.name || b.branch_id); });
  // จัดกลุ่มตาม (สาขา + วันที่) ก่อน แล้วค่อยเลือกแถว กันนับซ้ำจากแถวปิดยอด
  const g: Record<string, any[]> = {};
  (rows || []).forEach((r: any) => { if (!r.branch_id) return; const k = r.branch_id + "|" + (r.sale_date || "_"); (g[k] = g[k] || []).push(r); });
  // ★ แก้ 26 ส.ค. 2569 — ให้ตรงกับแดชบอร์ด/นิดา
  //   1) กรองเลขเพี้ยน (>2 ล้าน/แถว) ออกเหมือนหน้าเว็บ ไม่งั้นสองที่ตัวเลขต่างกัน
  //   2) ยอด/ลูกค้า → แถวปิดยอดถ้ามี ไม่มีก็บวกรายผลัด
  //   3) ยอดบัตร/คาเฟ่/เดลิเวอรี → บวกจากรายผลัดเสมอ (แถวปิดยอดเว้นว่าง 69% ของวัน)
  const SANE = 2000000;
  for (const k of Object.keys(g)) {
    const list = g[k].filter((r: any) => Number(r.sales_total || 0) <= SANE && Number(r.target_total || 0) <= SANE);
    if (!list.length) continue;
    const bid = list[0].branch_id;
    const a = by[bid] || (by[bid] = newAgg(bid, brName[bid] || bid));
    const closing = list.filter((r: any) => isClosingShift(r.shift));
    const shifts = list.filter((r: any) => !isClosingShift(r.shift));
    const head = closing[0] || null;
    const sum = (arr: any[], f: string) => arr.reduce((s: number, r: any) => s + Number(r[f] || 0), 0);
    a.total     += head ? Number(head.sales_total || 0)   : sum(shifts, "sales_total");
    a.product   += head ? Number(head.sales_product || 0) : sum(shifts, "sales_product");
    a.customers += head ? Number(head.customers || 0)     : sum(shifts, "customers");
    a.card      += sum(shifts, "sales_card")    || Number(head?.sales_card || 0);
    a.allcafe   += sum(shifts, "allcafe_baht")  || Number(head?.allcafe_baht || 0);
    a.delivery  += sum(shifts, "delivery_baht") || Number(head?.delivery_baht || 0);
    a.shifts += (head ? closing.length : shifts.length); a.reported = true;
    // ★ 7 ก.ย. 2569 — ยอดครบทุกผลัดหรือยัง
    //   มีแถว "สิ้นวัน" = ปิดยอดของวันแล้ว · ถ้าไม่มี ต้องได้ครบ 3 ผลัด (เช้า/บ่าย/ดึก)
    //   ผลัดดึกส่งยอดตอนเช้าอีกวัน ถ้าเรียกดูก่อนหน้านั้น ยอดจะขาดไปทั้งผลัด
    //   แล้วอ่านเหมือนยอดตกฮวบ ทั้งที่แค่ยังส่งไม่ครบ
    if (head) a.hasClosing = true;
    a.shiftRows += shifts.length;
    shifts.forEach((r: any) => { const nm = String(r.shift || "").trim(); if (nm && !a.gotShifts.includes(nm)) a.gotShifts.push(nm); });
    a.complete = a.hasClosing || a.shiftRows >= SHIFTS_PER_DAY;
    let dayTarget = head ? Number(head.target_total || 0) : sum(shifts, "target_total");
    if (dayTarget <= 0) dayTarget = Math.max(0, ...list.map((r: any) => Number(r.target_total || 0)));
    a.target_total += dayTarget;
  }
  return Object.values(by).sort((x, y) => y.total - x.total);
}
// ผลัดที่ยังไม่ส่งยอด — ถ้ามีแถว "สิ้นวัน" แล้วถือว่าปิดยอดครบ ไม่ต้องไล่
function missShifts(a: Agg): string[] { return a.hasClosing ? [] : SHIFT_NAMES.filter((n) => !a.gotShifts.includes(n)); }
// %บรรลุเป้า (ทศนิยม 1) · null ถ้าไม่มีเป้า
function achievePct(a: Agg): number | null { return a.target_total > 0 ? Math.round(a.total / a.target_total * 1000) / 10 : null; }
// ยอดต่อหัวเฉลี่ย (ทศนิยม 2)
function perHead(a: Agg): number { return a.customers > 0 ? Math.round(a.total / a.customers * 100) / 100 : 0; }
const th = (n: number) => Math.round(n).toLocaleString("en-US");
// ตัดคำว่า "สาขา" ที่นำหน้าชื่อออก (กันซ้ำเป็น "สาขา สาขา ...")
const bareName = (s: string) => String(s || "").replace(/^\s*สาขา\s*/, "").trim();

// ★ ข้อความที่ 1: ภาพรวมยอดขาย + ข้อสังเกต (rule-based)
function buildOverviewText(day: string, aggs: Agg[]): string {
  const L: string[] = [];
  L.push(`ภาพรวมยอดขายเมื่อวาน (${day}):`);
  for (const a of aggs) {
    L.push("");
    L.push(` • สาขา ${bareName(a.name)}:`);
    if (!a.reported) { L.push("    • (ยังไม่ส่งยอดขายของวันนี้)"); continue; }
    const tp = achievePct(a);
    L.push(`    • ยอดขายรวม: ${th(a.total)} บาท`);
    L.push(`    • บรรลุเป้าหมาย: ${tp !== null ? tp.toFixed(1) + "% (เป้าหมาย " + th(a.target_total) + " บาท)" : "— (ยังไม่ตั้งเป้า)"}`);
    L.push(`    • ยอดขาย All Cafe: ${th(a.allcafe)} บาท`);
    L.push(`    • ยอดขาย Delivery: ${th(a.delivery)} บาท`);
    L.push(`    • ลูกค้า: ${th(a.customers)} คน`);
    L.push(`    • ยอดต่อหัวเฉลี่ย: ${perHead(a).toFixed(2)} บาท`);
  }
  // ข้อสังเกตแบบกฎ
  const notes: string[] = [];
  for (const a of aggs) {
    const nm = bareName(a.name);
    if (!a.reported) { notes.push(`สาขา${nm}ยังไม่ส่งยอดขายค่ะ`); continue; }
    const tp = achievePct(a);
    if (tp === null) { notes.push(`สาขา${nm}ยังไม่ได้ตั้งเป้าหมายค่ะ`); continue; }
    if (tp >= 110)      notes.push(`สาขา${nm}ทำยอดได้ดีเกินเป้าหมายไปมากค่ะ`);
    else if (tp >= 100) notes.push(`สาขา${nm}ทำยอดได้เกินเป้าหมายค่ะ`);
    else if (tp >= 95)  notes.push(`สาขา${nm}ทำยอดได้ใกล้เคียงเป้าหมาย`);
    else if (tp >= 90)  notes.push(`สาขา${nm}ทำยอดได้ต่ำกว่าเป้าหมายเล็กน้อย`);
    else                notes.push(`สาขา${nm}ยังทำยอดได้ต่ำกว่าเป้าหมายพอสมควรค่ะ`);
  }
  L.push("");
  L.push("ข้อสังเกต:");
  notes.forEach(n => L.push(` • ${n}`));
  return L.join("\n");
}

// แนวการเขียนบทวิเคราะห์ — "โค้ชปฏิบัติการหน้าร้าน" ไม่ใช่นักวิเคราะห์หุ้น/การเงิน
const COACH_STYLE = `แนวการเขียน (สำคัญมาก): คุณเป็น "โค้ชปฏิบัติการหน้าร้าน 7-Eleven" ที่คุยกับผู้จัดการสาขา ไม่ใช่นักวิเคราะห์หุ้น/การเงิน
- ใช้ภาษาปฏิบัติจริงในร้าน เข้าใจง่าย ตรงประเด็น
- ห้ามเด็ดขาด: ศัพท์เชิงตลาด/การลงทุน/มหภาค เช่น "ภาวะตลาด" "ตลาดชะลอตัว/ซบเซา" "พฤติกรรมผู้บริโภค" "ฐานลูกค้าแข็งแกร่ง" "เศรษฐกิจ" "ปัจจัยภายนอก" "อย่างมีนัยสำคัญ" "สะท้อนถึง"
- เน้น "สิ่งที่ ผจก./พนักงานลงมือทำได้จริงในร้าน" เช่น เชียร์ All Cafe และ Delivery, การเสนอขายเพิ่ม (upselling/cross-selling) พร้อมตัวอย่างประโยคพูดกับลูกค้า, จัดเรียงสินค้า/โปรโมชั่นใกล้จุดชำระเงิน, เช็กสต็อกสินค้าขายดี+FIFO, ความสะอาด/ป้ายโปรฯ
รูปแบบผลลัพธ์:
บรรทัดแรก: 1-2 ประโยคสรุปสถานการณ์แบบสั้น ชี้สาขาที่ต้องโฟกัสวันนี้ + เหตุผลจากตัวเลขจริง (เช่น ยอดต่อหัวต่ำ = เสนอขายพ่วงน้อย, ลูกค้าน้อย = ต้องดึงคนเข้าร้าน)
จากนั้นหัวข้อ "สิ่งที่ควรทำ:" แล้วลิสต์เป็นข้อ 2-4 ข้อ เจาะจงสาขาและการกระทำที่ทำได้ทันที (ใส่ตัวอย่างประโยคเสนอขายได้ เช่น "รับขนมปังเพิ่มไหมคะ")
ลงท้ายสุภาพด้วย "ค่ะ" ตอบเป็นข้อความล้วน (ใช้ตัวเลขข้อ 1. 2. 3. ได้)`;

// ---------- โปรโมชั่นที่ใช้ได้จริงตอนนี้ (จากตาราง promo_sheets/promo_items) ----------
//  เดิมบทวิเคราะห์อ้างโปรฯ จาก nida_knowledge ซึ่งเป็นข้อความที่คนพิมพ์เอง — เก่าง่ายและไม่มีตัวเลขให้เชียร์
//  ตอนนี้มีตารางโปรฯ ที่อ่านจากใบจริงแล้ว จึงป้อนของจริงเข้าไปแทน และให้ตารางชนะข้อความเสมอ
function promoLine(r: any): string {
  const t = String(r.promo_type || "stamp");
  const nm = String(r.product || "") + (r.size ? (" " + r.size) : "");
  if (t === "discount" || t === "bundle") {
    if (r.price_before != null && r.price_after != null) {
      return nm + " ปกติ " + r.price_before + " เหลือ " + r.price_after + " บาท (ประหยัด " + (Math.round((Number(r.price_before) - Number(r.price_after)) * 100) / 100) + " บาท)";
    }
    return nm + (r.price_after != null ? (" ราคาโปรฯ " + r.price_after + " บาท") : "");
  }
  if (t === "stamp") {
    const got: string[] = [];
    if (r.stamp_pieces != null) got.push(r.stamp_pieces + " ดวง");
    if (r.stamp_baht != null) got.push("มูลค่า " + r.stamp_baht + " บาท");
    if (r.mstamp != null) got.push("สมาชิกรับ M-Stamp " + r.mstamp);
    return nm + (r.price_after != null ? (" จ่าย " + r.price_after + " บาท") : "") + (got.length ? (" ได้แสตมป์ " + got.join(" / ")) : "");
  }
  if (t === "freebie") {
    const fr = (r.extra && r.extra["ของแถม"]) ? String(r.extra["ของแถม"]) : "";
    return nm + (r.price_after != null ? (" ซื้อครบ " + r.price_after + " บาท") : "") + (fr ? (" แถม " + fr) : "");
  }
  if (t === "redeem") return nm + " ใช้แสตมป์ " + (r.stamp_baht != null ? (r.stamp_baht + " บาท") : (r.stamp_pieces + " ดวง")) + (r.price_after ? (" + จ่ายเพิ่ม " + r.price_after + " บาท") : "");
  return nm;
}
const PTYPE_TH: Record<string, string> = { stamp: "ซื้อแล้วรับแสตมป์", discount: "ลดราคา", bundle: "ซื้อคู่/เซ็ต", freebie: "ซื้อครบแถมฟรี", redeem: "แลกด้วยแสตมป์/คะแนน", custom: "กติกาเฉพาะ" };

async function loadPromos(top = 3): Promise<{ text: string; sheets: string[]; top: string[]; ending: string[] }> {
  const today = bkkDate(0);
  const out: string[] = [], sheets: string[] = [], topLines: string[] = [], endingLines: string[] = [];
  try {
    const [{ data: sh }, { data: it }] = await Promise.all([
      sb.from("promo_sheets").select("title,promo_type,period_start,period_end,reviewed,active").eq("active", true).limit(60),
      sb.from("promo_items_v").select("*").eq("sheet_active", true).limit(600),
    ]);
    const live = (sh || []).filter((x: any) => (!x.period_start || String(x.period_start) <= today) && (!x.period_end || String(x.period_end) >= today));
    if (!live.length) return { text: "", sheets: [], top: [], ending: [] };

    const dleft = (d: any) => Math.round((Date.parse(String(d) + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
    const seen = new Set<string>();
    out.push("[โปรโมชั่นที่ใช้ได้จริงตอนนี้ — อ่านมาจากใบโปรฯ ในระบบ ไม่ใช่ข้อความที่คนพิมพ์]");
    for (const x of live) {
      const t = String(x.title); if (seen.has(t)) continue; seen.add(t);
      const dl = x.period_end ? dleft(x.period_end) : null;
      const tail = dl != null ? (" · เหลืออีก " + dl + " วัน" + (dl <= 7 ? " ⚠ ใกล้หมด" : "")) : "";
      out.push("• " + t + " [" + (PTYPE_TH[String(x.promo_type)] || String(x.promo_type)) + "]" + tail + (x.reviewed ? "" : " (ยังไม่ตรวจแก้)"));
      sheets.push(t);
      if (dl != null && dl >= 0 && dl <= 7) endingLines.push(t + " — เหลืออีก " + dl + " วัน");
    }

    const items = ((it || []) as any[]).filter((r: any) => r["สถานะ"] === "ใช้อยู่");
    const saveOf = (r: any) => (r.price_before != null && r.price_after != null) ? (Number(r.price_before) - Number(r.price_after)) : null;
    const grab = (label: string, list: any[]) => {
      const l = list.slice(0, top); if (!l.length) return;
      out.push(label + ":");
      l.forEach((r: any) => { const s2 = "  - " + promoLine(r) + " (ใบ " + r.sheet_title + ")"; out.push(s2); topLines.push(promoLine(r)); });
    };
    grab("ลดแรงที่สุด", items.filter((r: any) => saveOf(r) != null).sort((x: any, y: any) => (saveOf(y) as number) - (saveOf(x) as number)));
    grab("ได้แสตมป์มูลค่าสูงสุด", items.filter((r: any) => String(r.promo_type) === "stamp" && r.stamp_baht != null).sort((x: any, y: any) => Number(y.stamp_baht) - Number(x.stamp_baht)));
    grab("คุ้มที่สุดต่อเงิน 1 บาท", items.filter((r: any) => String(r.promo_type) === "stamp" && r.stamp_baht != null && Number(r.price_after) > 0).sort((x: any, y: any) => (Number(y.stamp_baht) / Number(y.price_after)) - (Number(x.stamp_baht) / Number(x.price_after))));
    grab("ซื้อครบแถมฟรี", items.filter((r: any) => String(r.promo_type) === "freebie" || (r.extra && r.extra["ของแถม"])));
    grab("ซื้อคู่/เซ็ต", items.filter((r: any) => String(r.promo_type) === "bundle"));
    out.push("(รายการโปรฯ ที่ใช้ได้ตอนนี้ทั้งหมด " + items.length + " รายการ จาก " + live.length + " ใบ)");
  } catch (_e) { return { text: "", sheets: [], top: [], ending: [] }; }
  return { text: out.join("\n").slice(0, 5000), sheets: [...new Set(sheets)], top: topLines.slice(0, 6), ending: endingLines };
}

const PROMO_RULES = `กติกาเรื่องโปรโมชั่น (สำคัญที่สุด ห้ามพลาด):
- ถ้าจะพูดถึงสินค้า ราคา หรือโปรโมชั่น ต้องหยิบจากบล็อก [โปรโมชั่นที่ใช้ได้จริงตอนนี้] เท่านั้น ห้ามแต่งเอง ห้ามเดาราคา ห้ามคิดส่วนลดเอง
- ถ้าคลังความรู้กับบล็อกโปรโมชั่นขัดกัน ให้ยึดบล็อกโปรโมชั่น (มาจากใบโปรฯ จริงที่คนตรวจแล้ว)
- แยกให้ชัด: "ราคาที่จ่าย" คือเงินที่ลูกค้าจ่าย ส่วน "ได้แสตมป์" คือของที่ได้กลับมา ห้ามเรียกสลับกัน
- โปรฯ ที่เหลือน้อยกว่า 7 วัน ให้ยกขึ้นเป็นข้อแรกและบอกว่าเหลืออีกกี่วัน
- ทุกข้อต้องผูกกับ "สาขาไหน" และ "ตัวเลขอะไรที่ชี้ว่าต้องทำ" พร้อมประโยคที่พนักงานพูดกับลูกค้าได้จริง
- ยอดขายในระบบละเอียดแค่ระดับสาขา/วัน ไม่มียอดรายสินค้า ห้ามพูดว่าสินค้าตัวไหนขายดีหรือขายไม่ดี`;

async function analyze(day: string, today: Agg[], prev: Agg[]): Promise<string> {
  if (!GKEY) return "";
  const prevMap: Record<string, Agg> = {}; prev.forEach(p => prevMap[p.branch_id] = p);
  const lines = today.map(a => {
    const p = prevMap[a.branch_id];
    const dod = p && p.total > 0 ? Math.round((a.total - p.total) / p.total * 100) : null;
    const tp  = achievePct(a);
    return `${a.name}: ยอดรวม ${Math.round(a.total)} บาท` +
      (tp !== null ? ` (เป้า ${Math.round(a.target_total)} = ${tp.toFixed(1)}% ของเป้า)` : "") +
      (dod !== null ? ` เทียบวันก่อน ${dod >= 0 ? "+" : ""}${dod}%` : "") +
      `; สินค้า ${Math.round(a.product)} บัตร ${Math.round(a.card)} All Cafe ${Math.round(a.allcafe)} Delivery ${Math.round(a.delivery)} ลูกค้า ${Math.round(a.customers)} คน ต่อหัว ${perHead(a).toFixed(2)}` +
      (a.reported ? "" : " [ยังไม่ส่งยอด]");
  }).join("\n");
  const grand = today.reduce((s, a) => s + a.total, 0);
  const prevGrand = prev.reduce((s, a) => s + a.total, 0);
  // ★ คำนวณ "ข้อมูลเชิงลึก" ให้โมเดลใช้ตีความ (ไม่ใช่แค่ทวนตัวเลข)
  const rep = today.filter(a => a.reported);
  const insight: string[] = [];
  if (rep.length >= 2) {
    const byTp = [...rep].filter(a => achievePct(a) !== null).sort((x, y) => (achievePct(y)! - achievePct(x)!));
    if (byTp.length) insight.push(`สาขาทำ %เป้าสูงสุด: ${byTp[0].name} (${achievePct(byTp[0])!.toFixed(1)}%) · ต่ำสุด: ${byTp[byTp.length - 1].name} (${achievePct(byTp[byTp.length - 1])!.toFixed(1)}%)`);
    const byPh = [...rep].sort((x, y) => perHead(y) - perHead(x));
    insight.push(`ยอดต่อหัวสูงสุด: ${byPh[0].name} (${perHead(byPh[0]).toFixed(2)}) · ต่ำสุด: ${byPh[byPh.length - 1].name} (${perHead(byPh[byPh.length - 1]).toFixed(2)})`);
    rep.forEach(a => { const dm = a.total > 0 ? Math.round(a.delivery / a.total * 100) : 0; const cm = a.total > 0 ? Math.round(a.allcafe / a.total * 100) : 0; insight.push(`${a.name}: All Cafe ${cm}% Delivery ${dm}% ของยอด`); });
    const belowTgt = rep.filter(a => { const tp = achievePct(a); return tp !== null && tp < 100; });
    belowTgt.forEach(a => { const gap = a.target_total - a.total; if (gap > 0) insight.push(`${a.name} ขาดอีก ${Math.round(gap)} บาทจะถึงเป้า`); });
  }
  const prompt = `คุณคือ "นิดา" โค้ชปฏิบัติการหน้าร้านของเครือ 7-Eleven กำลังโค้ชผู้จัดการ 3 สาขา จากยอดขายประจำวัน (${day}) ตัวเลขผู้จัดการเห็นในข้อความก่อนหน้าแล้ว ห้ามทวนซ้ำ

ข้อมูลต่อสาขา (ใช้คิด ไม่ต้องอ่านออกมาตรงๆ):
${lines}
ยอดรวมทุกสาขา ${Math.round(grand)} บาท (วันก่อน ${Math.round(prevGrand)} บาท)
ประเด็นที่คำนวณไว้ให้:
${insight.map(s => "- " + s).join("\n")}

${COACH_STYLE}`;
  // ★ ป้อนโปรฯ ที่ใช้ได้จริงวันนี้เข้าไปด้วย — บทวิเคราะห์จะได้เชียร์ของที่มีอยู่จริง ไม่ใช่พูดลอย ๆ ว่า "เสนอขายเพิ่ม"
  const pm = await loadPromos(2);
  const prompt2 = pm.text ? (prompt + "\n\n" + pm.text + "\n\n" + PROMO_RULES) : prompt;
  return await askGemini(prompt2, 1024);
}


// ============================================================
// การ์ด Flex สำหรับรายงานยอดขาย (แทนข้อความล้วนแบบเดิม)
//   หัวสีกะทัดรัด + % + แถบความคืบหน้า · ชุดเดียวกับการ์ดงานใน staff-notify
//   carousel ทั้งชุด LINE นับเป็น "1 ข้อความ" ต่อผู้รับ — ไม่กินโควตาเพิ่มจากเดิม
// ============================================================
const C_GREEN = "#15803d", C_AMBER = "#b45309", C_RED = "#dc2626", C_GREY = "#71717a", C_VIOLET = "#6d28d9";
const TH_DOW = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
const dowLabel = (d: string) => TH_DOW[new Date(d + "T00:00:00Z").getUTCDay()];
const fmtThaiDate = (d: string) => { try { return new Date(d + "T00:00:00Z").toLocaleDateString("th-TH", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }); } catch { return d; } };

function capHead(color: string, label: string, pct: number | null, pctText?: string) {
  const c: any[] = [{ type: "text", text: label, color: "#ffffff", size: "sm", weight: "bold", wrap: true }];
  if (pct != null && isFinite(pct)) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    c.push({ type: "text", text: pctText || (p + "%"), color: "#ffffff", size: "xs", weight: "bold", margin: "sm" });
    c.push({
      type: "box", layout: "horizontal", height: "7px", backgroundColor: "#ffffff55", cornerRadius: "4px", margin: "sm",
      contents: p > 0
        ? [{ type: "box", layout: "vertical", width: p + "%", backgroundColor: "#ffffff", cornerRadius: "4px", contents: [{ type: "filler" }] }, { type: "filler" }]
        : [{ type: "filler" }],
    });
  }
  return { type: "box", layout: "vertical", backgroundColor: color, paddingAll: "14px", contents: c };
}
function kvRow(label: string, value: string, color = "#111111") {
  return { type: "box", layout: "baseline", spacing: "sm", contents: [
    { type: "text", text: label, size: "sm", color: "#8c8c8c", flex: 5 },
    { type: "text", text: value, size: "sm", color, weight: "bold", flex: 6, align: "end" },
  ] };
}
function capText(t: string) { return { type: "text", text: t, size: "xs", color: "#8c8c8c", margin: "md" }; }
function sepLine() { return { type: "separator", margin: "md" }; }
function noteBox(text: string, color: string, bg: string) {
  return { type: "box", layout: "vertical", margin: "md", backgroundColor: bg, cornerRadius: "8px", paddingAll: "10px",
    contents: [{ type: "text", text, wrap: true, size: "xs", color }] };
}
// ★ 17 ก.ย. 69 — แถบเทียบแนวนอน ตามแบบที่ตกลงกันไว้ (ของเดิมทำเป็นกราฟแท่งแนวตั้ง ผิดแบบ)
//   1 แถว = 1 วัน : ป้ายวัน · ตัวเลข · รางแถบเติมตามสัดส่วนของวันสูงสุด
//   แถวล่าสุด = ตัวหนา + แถบใช้สีสถานะของการ์ด · แถวก่อนหน้าเป็นสีเทา
//   หมายเหตุ: ต้องใช้ layout "horizontal" ไม่ใช่ "baseline" — baseline ใส่กล่องซ้อนไม่ได้ LINE จะตีกลับ
const BAR_TRACK = "#f2f4f7", BAR_DIM = "#c3c9d0";
function barCell(pct: number, color: string, flex = 7) {
  const w = Math.max(0, Math.min(100, Math.round(pct)));
  return { type: "box", layout: "horizontal", flex, height: "7px", backgroundColor: BAR_TRACK, cornerRadius: "3px",
    contents: w > 0
      ? [{ type: "box", layout: "vertical", width: w + "%", backgroundColor: color, cornerRadius: "3px", contents: [{ type: "filler" }] }, { type: "filler" }]
      : [{ type: "filler" }] };
}
function hBarRows(vals: number[], labels: string[], hiColor: string) {
  const mx = Math.max(1, ...vals);
  const last = vals.length - 1;
  return vals.map((v, i) => {
    const now = i === last;
    return { type: "box", layout: "horizontal", spacing: "sm", margin: "xs", alignItems: "center", contents: [
      { type: "text", text: labels[i] || " ", size: "xxs", flex: 3, gravity: "center",
        color: now ? "#18181b" : "#8c8c8c", weight: now ? "bold" : "regular" },
      { type: "text", text: v > 0 ? th(v) : "—", size: "xxs", flex: 5, align: "end", gravity: "center",
        color: now ? "#18181b" : "#8c8c8c", weight: now ? "bold" : "regular" },
      barCell(v > 0 ? Math.max(3, (v / mx) * 100) : 0, now ? hiColor : BAR_DIM, 7),
    ] };
  });
}
const TH_DOW_FULL = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const dayNum = (d: string) => { try { return String(new Date(d + "T00:00:00Z").getUTCDate()); } catch { return ""; } };
const dowDay = (d: string) => (dowLabel(d) || "") + " " + dayNum(d);
const dowFull = (d: string) => { try { return TH_DOW_FULL[new Date(d + "T00:00:00Z").getUTCDay()] || ""; } catch { return ""; } };
// กราฟแท่ง — กล่องแนวตั้งความสูงเป็น px (วิธีมาตรฐานของ Flex ไม่ต้องใช้รูป)
function barChart(vals: number[], labels: string[], hiIdx = -1, color = C_GREEN, dim = "#bbf7d0") {
  const max = Math.max(1, ...vals);
  const H = 62;
  const cols = vals.map((v, i) => ({
    type: "box", layout: "vertical", contents: [
      { type: "filler" },
      { type: "box", layout: "vertical", height: Math.max(3, Math.round((v / max) * H)) + "px", backgroundColor: i === hiIdx ? color : dim, cornerRadius: "3px", contents: [{ type: "filler" }] },
    ],
  }));
  return [
    { type: "box", layout: "horizontal", spacing: "xs", height: H + "px", margin: "sm", contents: cols },
    { type: "box", layout: "horizontal", spacing: "xs", margin: "xs", contents: labels.map((l) => ({ type: "text", text: l, size: "xxs", color: "#8c8c8c", align: "center" })) },
  ];
}
function salesBubble(o: { color: string; headLabel: string; headPct: number | null; headPctText?: string; cap: string; big: string; delta?: { text: string; color: string }; body: any[]; note?: { text: string; color: string; bg: string }; btn: string; url: string }) {
  // ★ ใบที่ไม่มีตัวเลขก้อนใหญ่ (เช่นใบเฉลี่ยรายสาขา) ส่ง big:"" มา — ต้องไม่ใส่โหนดว่างลงไป
  const b: any[] = [];
  if (o.cap) b.push({ type: "text", text: o.cap, size: "xs", color: "#8c8c8c", wrap: true });
  if (o.big) b.push({ type: "text", text: o.big, size: "xxl", weight: "bold", color: "#18181b" });
  if (o.delta) b.push({ type: "text", text: o.delta.text, size: "sm", weight: "bold", color: o.delta.color, margin: "sm" });
  b.push(...o.body);
  if (o.note) b.push({ type: "box", layout: "vertical", margin: "md", backgroundColor: o.note.bg, cornerRadius: "8px", paddingAll: "10px", contents: [{ type: "text", text: o.note.text, wrap: true, size: "xs", color: o.note.color }] });
  return {
    type: "bubble",
    header: capHead(o.color, o.headLabel, o.headPct, o.headPctText),
    body: { type: "box", layout: "vertical", contents: b },
    footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: o.color, action: { type: "uri", label: o.btn, uri: o.url } }] },
  };
}
const pctColor = (p: number | null) => p == null ? C_GREY : p >= 100 ? C_GREEN : p >= 95 ? C_AMBER : C_RED;
const deltaOf = (now: number, prev: number) => {
  if (!prev) return undefined;
  const d = now - prev, p = d / prev * 100;
  return { text: (d >= 0 ? "▲ +" : "▼ −") + th(Math.abs(d)) + " (" + (d >= 0 ? "+" : "−") + Math.abs(p).toFixed(1) + "%)", color: d >= 0 ? C_GREEN : C_RED };
};

// ยอดรายวันย้อนหลัง N วัน (ไว้วาดกราฟ)
async function dailySeries(branches: any[], endDay: string, days = 7) {
  const start = addDaysStr(endDay, -(days - 1));
  const { data } = await sb.from("sales_daily").select(SALES_COLS).gte("sale_date", start).lte("sale_date", endDay);
  const dates: string[] = []; for (let i = 0; i < days; i++) dates.push(addDaysStr(start, i));
  const byBranch: Record<string, number[]> = {}; const total: number[] = [];
  (branches || []).forEach((b: any) => { byBranch[b.branch_id] = new Array(days).fill(0); });
  dates.forEach((d, i) => {
    const aggs = aggregate((data || []).filter((r: any) => r.sale_date === d), branches);
    let t = 0;
    aggs.forEach((a) => { if (byBranch[a.branch_id]) byBranch[a.branch_id][i] = a.total; t += a.total; });
    total.push(t);
  });
  return { dates, byBranch, total };
}

// ============================================================
// ★ 17 ก.ย. 69 — ชุดข้อมูลใหม่สำหรับการ์ดใบ 1 และบทวิเคราะห์ท้าย carousel
//   ใบ 1  : เฉลี่ยต่อวันรายสาขา เทียบ "เดือนต่อเดือน" (ไม่ใช้ค่าเฉลี่ย 3 เดือนรวม
//           เพราะเฉลี่ยรวมจะกลบเดือนที่ตก ทำให้ยอดดูสูงเกินจริง)
//   ใบท้าย: บทวิเคราะห์ + ข้อสังเกตความผิดปกติของ "ข้อมูล" เพื่อให้ตามไปตรวจได้
//   นับเฉพาะวันที่ยอดครบ (มีแถวสิ้นวัน หรือครบ 3 ผลัด) — วันที่ข้อมูลขาดถูกข้าม
// ============================================================
type MonStat = { key: string; label: string; days: number; avg: number; cust: number; ph: number; skipped: number };
// ★ 17 ก.ย. 69 — กรอบยอดต่อหัวที่สมเหตุผล · นอกกรอบ = กรอกจำนวนลูกค้าเกิน/ขาดหลัก
//   เคสจริง 6 ก.ย. ตลาดหล่มสัก กรอก 6,426 คน (ปกติ ~640) ทำให้ต่อหัวเหลือ ฿6.85
//   ถ้าไม่กัน ค่าเฉลี่ยทั้งเดือนเพี้ยน แล้วการ์ดจะสรุปผิดว่า "ยอดต่อหัวลด ให้ไปดูการขายพ่วง"
const PH_MIN = 25, PH_MAX = 250;
const phSane = (total: number, cust: number) => cust > 0 && (total / cust) >= PH_MIN && (total / cust) <= PH_MAX;

// ย้อนหลัง N เดือนปฏิทิน (รวมเดือนปัจจุบัน) — เฉลี่ยต่อวันของแต่ละสาขา
async function monthAvgSeries(branches: any[], endDay: string, nMonths = 4) {
  const end = new Date(endDay + "T00:00:00Z");
  const firstMon = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (nMonths - 1), 1));
  const start = firstMon.toISOString().slice(0, 10);
  const { data } = await sb.from("sales_daily").select(SALES_COLS).gte("sale_date", start).lte("sale_date", endDay);
  const rows = data || [];
  // จัดกลุ่มเป็นรายวัน แล้วใช้ aggregate() ตัวเดิม (มีตรรกะกันนับซ้ำแถวสิ้นวันอยู่แล้ว)
  const days = [...new Set(rows.map((r: any) => String(r.sale_date)))].sort();
  const acc: Record<string, Record<string, { sum: number; cust: number; n: number; cn: number; skip: number }>> = {};
  for (const d of days) {
    const aggs = aggregate(rows.filter((r: any) => String(r.sale_date) === d), branches);
    const mk = d.slice(0, 7);
    for (const a of aggs) {
      if (!a.reported || !a.complete) continue;           // ★ ข้ามวันที่ข้อมูลไม่ครบ
      const m = (acc[a.branch_id] = acc[a.branch_id] || {});
      const c = (m[mk] = m[mk] || { sum: 0, cust: 0, n: 0, cn: 0, skip: 0 });
      c.sum += a.total; c.n++;
      // ★ นับจำนวนลูกค้าเฉพาะวันที่ยอดต่อหัวอยู่ในกรอบสมเหตุผล — กันวันที่กรอกผิดดึงค่าเฉลี่ยเพี้ยน
      if (phSane(a.total, a.customers)) { c.cust += a.customers; c.cn++; } else if (a.customers > 0) c.skip++;
    }
  }
  const keys: string[] = [];
  for (let i = nMonths - 1; i >= 0; i--) {
    const dd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    keys.push(dd.toISOString().slice(0, 7));
  }
  const out: Record<string, MonStat[]> = {};
  for (const b of (branches || [])) {
    out[b.branch_id] = keys.map((k) => {
      const c = acc[b.branch_id]?.[k];
      const avg = c && c.n ? c.sum / c.n : 0;
      const cu  = c && c.cn ? c.cust / c.cn : 0;     // ★ หารด้วยจำนวน "วันที่ข้อมูลลูกค้าใช้ได้" เท่านั้น
      return { key: k, label: String(TH_MON[Number(k.slice(5, 7)) - 1] || "").replace(/\.$/, ""), days: c?.n || 0, avg, cust: cu, ph: cu > 0 ? avg / cu : 0, skipped: c?.skip || 0 };
    });
  }
  return out;
}

// แถวเดือน + % เทียบเดือนก่อนหน้า
function monRows(list: MonStat[]) {
  const mx = Math.max(1, ...list.map((m) => m.avg));
  return list.map((m, i) => {
    const prev = i > 0 ? list[i - 1].avg : 0;
    const dp = prev > 0 && m.avg > 0 ? (m.avg / prev - 1) * 100 : null;
    const now = i === list.length - 1;
    // ★ 17 ก.ย. 69 — คืนรางแถบแนวนอนตามแบบที่ตกลงกันไว้ (ก่อนหน้านี้หายไป เหลือแต่ตัวเลข)
    return { type: "box", layout: "horizontal", spacing: "sm", margin: "xs", alignItems: "center", contents: [
      { type: "text", text: m.label, size: "xxs", gravity: "center", color: now ? "#18181b" : "#8c8c8c", weight: now ? "bold" : "regular", flex: 3 },
      { type: "text", text: m.avg > 0 ? th(m.avg) : "—", size: "xxs", gravity: "center", color: now ? "#18181b" : "#8c8c8c", weight: now ? "bold" : "regular", align: "end", flex: 5 },
      barCell(m.avg > 0 ? Math.max(3, (m.avg / mx) * 100) : 0, now ? C_GREEN : BAR_DIM, 6),
      { type: "text", text: dp == null ? "—" : (dp >= 0 ? "+" : "−") + Math.abs(dp).toFixed(1) + "%",
        size: "xxs", weight: "bold", align: "end", gravity: "center", flex: 5,
        color: dp == null ? C_GREY : dp >= 0 ? C_GREEN : C_RED },
    ] };
  });
}

// สรุปสถิติ 7 วันของสาขาหนึ่ง (ใช้กับการ์ดรายสาขา)
function w7stat(ser7: number[]) {
  const v = (ser7 || []).filter((x) => x > 0);
  if (!v.length) return null;
  const avg = v.reduce((s2, x) => s2 + x, 0) / v.length;
  return { avg, max: Math.max(...v), min: Math.min(...v), n: v.length };
}
function w7rows(ser7: number[], dates: string[], today: number) {
  const st = w7stat(ser7); if (!st) return [];
  const iMax = ser7.indexOf(st.max);
  const dv = st.avg > 0 ? (today / st.avg - 1) * 100 : null;
  const isLow = today > 0 && today <= st.min;
  const out: any[] = [
    sepLine(),
    kvRow("เฉลี่ย 7 วัน", "฿" + th(st.avg)),
    kvRow("วันนี้เทียบเฉลี่ย", dv == null ? "—" : (dv >= 0 ? "+" : "−") + Math.abs(dv).toFixed(1) + "%",
      dv == null ? C_GREY : dv >= -3 ? C_GREEN : dv >= -10 ? C_AMBER : C_RED),
    kvRow("สูงสุดสัปดาห์", iMax >= 0 ? dowLabel(dates[iMax]) + " · ฿" + th(st.max) : "—"),
  ];
  if (isLow) out.push(kvRow("สถานะ", "ต่ำสุดของสัปดาห์", C_RED));
  return out;
}

// ============================================================
// ★ 17 ก.ย. 69 — บทวิเคราะห์ + ข้อสังเกตความผิดปกติ (ใบสุดท้ายของ carousel)
//   คำนวณจากตัวเลขตรง ๆ ไม่ผ่าน AI — ผลจึงคงที่ ตรวจย้อนได้ ไม่มีการเดา
//   "ข้อสังเกต" แยกเป็น 2 ชนิด: ผิดปกติเชิงธุรกิจ  กับ  ข้อมูลน่าจะกรอกผิด
// ============================================================
function insightBubble(day: string, aggs: Agg[], ser: any, mon?: Record<string, MonStat[]>) {
  const rep2 = aggs.filter((a) => a.reported && a.complete);
  const body: any[] = [];
  const findings: string[] = [];   // ข้อสังเกตเชิงธุรกิจ
  const dataFlags: string[] = [];  // ข้อมูลน่าจะผิด — ให้ไปตรวจ

  // ---- 1) ทิศทางเทียบเดือนก่อน ----
  if (mon) {
    const ups: string[] = [], dns: string[] = [];
    for (const a of aggs) {
      const L = mon[a.branch_id] || []; if (L.length < 2) continue;
      const c = L[L.length - 1], pv = L[L.length - 2];
      if (!(c.avg > 0 && pv.avg > 0)) continue;
      const dp = (c.avg / pv.avg - 1) * 100;
      (dp >= 0 ? ups : dns).push(bareName(a.name) + " " + (dp >= 0 ? "+" : "−") + Math.abs(dp).toFixed(1) + "%");
    }
    if (ups.length || dns.length) {
      body.push({ type: "text", text: "เทียบเดือนก่อน", size: "xs", weight: "bold", color: "#18181b" });
      if (ups.length) body.push({ type: "text", text: "▲ ดีขึ้น: " + ups.join(" · "), size: "xxs", color: C_GREEN, wrap: true, margin: "xs" });
      if (dns.length) body.push({ type: "text", text: "▼ ลดลง: " + dns.join(" · "), size: "xxs", color: C_RED, wrap: true, margin: "xs" });
    }
    // ยอดต่อหัวเปลี่ยนแรง = สัญญาณการขายพ่วง (หรือกรอกลูกค้าผิด)
    for (const a of aggs) {
      const L = mon[a.branch_id] || []; if (L.length < 2) continue;
      const c = L[L.length - 1], pv = L[L.length - 2];
      if (!(c.ph > 0 && pv.ph > 0)) continue;
      if (c.skipped > 0 || pv.skipped > 0) {        // ★ ข้อมูลลูกค้าเดือนนั้นมีวันที่กรอกผิด — ไม่สรุปเชิงธุรกิจ
        dataFlags.push(bareName(a.name) + ": มีวันที่กรอกจำนวนลูกค้าผิด (" + (c.skipped + pv.skipped) + " วัน) — ยอดต่อหัวรายเดือนยังเชื่อไม่ได้เต็มที่");
        continue;
      }
      const dp = (c.ph / pv.ph - 1) * 100;
      if (dp <= -8) findings.push(bareName(a.name) + " ยอดต่อหัวลด " + Math.abs(dp).toFixed(0) + "% (฿" + pv.ph.toFixed(2) + " → ฿" + c.ph.toFixed(2) + ") — ดูการเสนอขายพ่วง");
      else if (dp >= 10) findings.push(bareName(a.name) + " ยอดต่อหัวเพิ่ม " + dp.toFixed(0) + "% — หาว่าทำอะไรได้ผล แล้วขยายไปสาขาอื่น");
    }
  }

  // ---- 2) วันล่าสุดเทียบ 7 วัน ----
  const lows: string[] = [], drops: string[] = [];
  for (const a of rep2) {
    const s7 = (ser.byBranch[a.branch_id] || []).map((x: number) => Math.round(x));
    const st = w7stat(s7); if (!st || st.n < 3) continue;
    const dv = (a.total / st.avg - 1) * 100;
    if (a.total <= st.min) lows.push(bareName(a.name));
    if (dv <= -10) drops.push(bareName(a.name) + " " + dv.toFixed(0) + "%");
  }
  if (lows.length || drops.length) {
    body.push(sepLine());
    body.push({ type: "text", text: "ยอดวันล่าสุด", size: "xs", weight: "bold", color: "#18181b", margin: "md" });
    if (drops.length) body.push({ type: "text", text: "ต่ำกว่าเฉลี่ย 7 วันมาก: " + drops.join(" · "), size: "xxs", color: C_RED, wrap: true, margin: "xs" });
    if (lows.length) body.push({ type: "text", text: "ต่ำสุดของสัปดาห์: " + lows.join(" · "), size: "xxs", color: C_AMBER, wrap: true, margin: "xs" });
  }
  // ตกพร้อมกันทุกสาขา = ปัจจัยภายนอก ไม่ใช่ปัญหาของร้านใดร้านหนึ่ง
  if (rep2.length >= 2 && lows.length === rep2.length) {
    findings.push("ทุกสาขาต่ำสุดของสัปดาห์พร้อมกัน — น่าจะเป็นปัจจัยภายนอก (อากาศ/วันหยุด/กำลังซื้อ) มากกว่าปัญหาของร้านใดร้านหนึ่ง");
  }
  // สาขาที่ควรโฟกัส = ตกแรงสุด
  let focus: { nm: string; dv: number; cust: string } | null = null;
  for (const a of rep2) {
    const s7 = (ser.byBranch[a.branch_id] || []).map((x: number) => Math.round(x));
    const st = w7stat(s7); if (!st || st.n < 3) continue;
    const dv = (a.total / st.avg - 1) * 100;
    if (!focus || dv < focus.dv) focus = { nm: bareName(a.name), dv, cust: th(a.customers) };
  }
  if (focus && focus.dv <= -5) {
    findings.push("โฟกัสวันนี้: " + focus.nm + " (ต่ำกว่าเฉลี่ย 7 วัน " + focus.dv.toFixed(0) + "% · ลูกค้า " + focus.cust + " คน)");
  }

  // ---- 3) ข้อสังเกตว่า "ข้อมูลน่าจะกรอกผิด" ----
  for (const a of rep2) {
    // ยอดต่อหัวหลุดกรอบสมเหตุผล → มักเกิดจากกรอกจำนวนลูกค้าเกิน/ขาดหลัก
    const ph = perHead(a);
    if (a.customers > 0 && (ph < 25 || ph > 250)) {
      dataFlags.push(bareName(a.name) + ": ยอดต่อหัว ฿" + ph.toFixed(2) + " (ลูกค้า " + th(a.customers) + " คน) — ตรวจช่องจำนวนลูกค้า");
    }
    // เป้าหลุดกรอบ → % บรรลุเป้าจะเพี้ยนทั้งการ์ด
    if (a.target_total > 0 && a.total > 0) {
      const r = a.target_total / a.total;
      if (r < 0.2) dataFlags.push(bareName(a.name) + ": เป้าวันนี้ ฿" + th(a.target_total) + " ต่ำผิดปกติเทียบยอดจริง ฿" + th(a.total) + " — ตรวจการตั้งเป้า");
      else if (r > 1.6) dataFlags.push(bareName(a.name) + ": เป้าวันนี้ ฿" + th(a.target_total) + " สูงผิดปกติเทียบยอดจริง ฿" + th(a.total) + " — ตรวจการตั้งเป้า");
    }
  }

  if (findings.length) {
    body.push(sepLine());
    body.push({ type: "text", text: "วิเคราะห์", size: "xs", weight: "bold", color: "#18181b", margin: "md" });
    findings.slice(0, 4).forEach((f) => body.push({ type: "text", text: "• " + f, size: "xxs", color: "#3f3f46", wrap: true, margin: "xs" }));
  }
  if (dataFlags.length) {
    body.push({ type: "box", layout: "vertical", margin: "md", backgroundColor: "#fff7ed", cornerRadius: "8px", paddingAll: "10px",
      contents: [{ type: "text", text: "ข้อมูลน่าจะกรอกผิด — ตรวจก่อนเชื่อตัวเลข", size: "xs", weight: "bold", color: "#9a3412", wrap: true },
        ...dataFlags.slice(0, 4).map((f) => ({ type: "text", text: "• " + f, size: "xxs", color: "#9a3412", wrap: true, margin: "xs" }))] });
  }
  if (!body.length) return null;

  return {
    type: "bubble",
    header: capHead(dataFlags.length ? C_AMBER : C_GREY, "วิเคราะห์ & ข้อสังเกต", null),
    body: { type: "box", layout: "vertical", contents: [
      { type: "text", text: "อ้างอิงยอดวันที่ " + fmtThaiDate(day), size: "xs", color: "#8c8c8c" },
      ...body,
    ] },
    footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: dataFlags.length ? C_AMBER : C_GREY, action: { type: "uri", label: "เปิดแดชบอร์ดยอดขาย", uri: APP_URL + "/hr/" } }] },
  };
}

// ---------- carousel รายวัน ----------
function dailyCarousel(day: string, aggs: Agg[], prevMap: Record<string, Agg>, ser: any, mon?: Record<string, MonStat[]>) {
  const rep = aggs.filter((a) => a.reported);
  const grand = rep.reduce((s2, a) => s2 + a.total, 0);
  const tgt = rep.reduce((s2, a) => s2 + a.target_total, 0);
  const prevGrand = Object.values(prevMap).reduce((s2, a) => s2 + a.total, 0);
  const gp = tgt > 0 ? grand / tgt * 100 : null;
  const cust = rep.reduce((s2, a) => s2 + a.customers, 0);
  // ★ ยอดครบทุกผลัดหรือยัง — ถ้ายังไม่ครบ ห้ามโชว์ % เป้า และห้ามเทียบกับวันก่อน
  const doneCnt = aggs.filter((a) => a.complete).length;
  const full = rep.length === aggs.length && doneCnt === aggs.length;
  // ป้ายเตือนบอกให้ครบว่า ขาดของวันไหน · ร้านไหน · ผลัดไหน
  const dLabel = fmtThaiDate(day);
  const lackOf = (a: Agg) => {
    if (!a.reported) return bareName(a.name) + " (ยังไม่ส่งยอดเลย)";
    const m = missShifts(a);
    return m.length ? bareName(a.name) + " (ผลัด" + m.join(", ") + ")" : "";
  };
  const lackAll = aggs.map(lackOf).filter(Boolean).join(" · ");
  const noteAll = { text: "ยอดของวันที่ " + dLabel + " ยังไม่ครบทุกผลัด\nยังขาด: " + lackAll + "\nผลัดดึกจะส่งยอดตอนเช้าอีกวัน ตัวเลขนี้จึงยังไม่ใช่ยอดจริงของวัน และยังเทียบกับวันก่อนหน้าไม่ได้", color: "#92400e", bg: "#fef3c7" };
  const noteOne = (a: Agg) => ({ text: "ยอดของวันที่ " + dLabel + " ยังไม่ครบ — ยังขาดผลัด " + missShifts(a).join(", ") + "\nผลัดดึกจะส่งยอดตอนเช้าอีกวัน ตัวเลขนี้จึงยังไม่ใช่ยอดจริงของวัน", color: "#92400e", bg: "#fef3c7" });
  const bubbles: any[] = [];

  // ---------- ใบ 1: เฉลี่ยต่อวันรายสาขา เทียบเดือนต่อเดือน ----------
  if (mon) {
    const mb: any[] = [];
    let upN = 0, dnN = 0, thinMonth = false; const badDays: string[] = [];
    for (const a of aggs) {
      const list = mon[a.branch_id] || [];
      if (!list.length) continue;
      const cur = list[list.length - 1], prv = list[list.length - 2];
      const dp = prv && prv.avg > 0 && cur.avg > 0 ? (cur.avg / prv.avg - 1) * 100 : null;
      if (dp != null) { if (dp >= 0) upN++; else dnN++; }
      if (cur.days > 0 && cur.days < 7) thinMonth = true;
      if (cur.skipped > 0) badDays.push(bareName(a.name) + " " + cur.skipped + " วัน");
      mb.push(sepLine());
      mb.push({ type: "box", layout: "baseline", spacing: "sm", contents: [
        { type: "text", text: bareName(a.name), size: "sm", weight: "bold", flex: 7, wrap: false },
        { type: "text", text: cur.avg > 0 ? "฿" + th(cur.avg) : "—", size: "sm", weight: "bold", align: "end", flex: 5 },
        { type: "text", text: dp == null ? "" : (dp >= 0 ? "▲ +" : "▼ −") + Math.abs(dp).toFixed(1) + "%",
          size: "xxs", weight: "bold", align: "end", flex: 4, color: dp == null ? C_GREY : dp >= 0 ? C_GREEN : C_RED },
      ] });
      mb.push(...monRows(list));
      if (cur.cust > 0) {
        const phPrev = prv && prv.ph > 0 ? prv.ph : 0;
        mb.push({ type: "text", margin: "xs", size: "xxs", color: "#8c8c8c", wrap: true,
          text: "ลูกค้า " + th(cur.cust) + "/วัน · ต่อหัว ฿" + cur.ph.toFixed(2) + (phPrev ? ("  (" + prv.label + " " + phPrev.toFixed(2) + ")") : "") });
      }
    }
    const headTxt = upN && !dnN ? "ดีขึ้นทุกสาขา" : dnN && !upN ? "ชะลอตัวทุกสาขา" : upN > dnN ? "ส่วนใหญ่ดีขึ้น" : upN < dnN ? "ส่วนใหญ่ชะลอตัว" : "ทรงตัว";
    const curLbl = mon[aggs[0]?.branch_id]?.slice(-1)[0], prvLbl = mon[aggs[0]?.branch_id]?.slice(-2)[0];
    bubbles.push(salesBubble({
      color: upN >= dnN ? C_GREEN : C_RED,
      headLabel: "เฉลี่ยต่อวันรายสาขา · " + headTxt,
      headPct: null,
      cap: (curLbl ? curLbl.label : "") + " เทียบ " + (prvLbl ? prvLbl.label : "เดือนก่อน") +
           (curLbl ? "  ·  เก็บแล้ว " + curLbl.days + " วัน" : ""),
      big: "",
      body: [{ type: "text", size: "xxs", color: "#8c8c8c", wrap: true,
               text: "นับเฉพาะวันที่ยอดครบทุกผลัด · วันที่ข้อมูลขาดถูกข้าม" }, ...mb],
      note: badDays.length
        ? { text: "ตัดวันที่จำนวนลูกค้ากรอกผิดออกจากค่าเฉลี่ยแล้ว: " + badDays.join(" · ") + " — ยอดขายยังนับครบ ตัดเฉพาะตัวเลขลูกค้า/ต่อหัว", color: "#9a3412", bg: "#fff7ed" }
        : thinMonth ? { text: "เดือนนี้เพิ่งเก็บได้ไม่กี่วัน ค่าเฉลี่ยยังแกว่งง่าย ดูเป็นแนวโน้มคร่าว ๆ ก่อน", color: "#92400e", bg: "#fef3c7" } : undefined,
      btn: "เปิดแดชบอร์ดยอดขาย", url: APP_URL + "/hr/",
    }));
  }

  // ---------- ★ 17 ก.ย. 69 — เอา "ใบภาพรวมทุกสาขา (ยอดรวม)" ออกตามแบบที่ตกลงกันไว้ ----------
  //   ชุดที่ตกลงกันคือ ใบ 1 = เฉลี่ยต่อวันรายสาขา (แทนใบยอดรวมเดิม) → ใบ 2-4 = รายสาขา
  //   ใบยอดรวมค้างอยู่เพราะตอนเพิ่มใบใหม่ผมเพิ่มต่อท้ายแทนที่จะแทนที่ของเดิม
  //   ตัวเลขรวม/ส่งยอดแล้ว/ยอดครบทุกผลัด ย้ายไปอยู่บนใบ 1 และใบวิเคราะห์แล้ว

  for (const a of aggs) {
    const p = achievePct(a);
    if (!a.reported) {
      bubbles.push(salesBubble({
        color: C_GREY, headLabel: bareName(a.name) + " · ยังไม่ส่งยอด", headPct: null,
        cap: "ยอดขายรวม", big: "—",
        body: [sepLine(), kvRow("วันที่", fmtThaiDate(day)), kvRow("สถานะ", "รอข้อมูล", C_RED)],
        note: { text: "ยังไม่ได้รับยอดขายของวันที่ " + fmtThaiDate(day) + " — รบกวนติดตามด้วยค่ะ", color: "#52525b", bg: "#f4f4f5" },
        btn: "เปิดหน้ากรอกยอดขาย", url: APP_URL + "/hr/",
      }));
      continue;
    }
    // ★ 17 ก.ย. 69 — สร้างใหม่ตามแบบที่ตกลงกันไว้ (flex-set.html ใบ 2-4)
    //   เดิมใช้กราฟแท่งแนวตั้ง — แบบจริงคือ 7 แถวแนวนอน วันละแถว มีรางแถบเทียบกัน
    const ser7 = (ser.byBranch[a.branch_id] || []).map((x: number) => Math.round(x));
    const st7 = w7stat(ser7);
    const iMax = st7 ? ser7.indexOf(st7.max) : -1;
    const isLow = !!(st7 && a.total > 0 && a.total <= st7.min);
    // ตกติดกัน 2 วัน (วันล่าสุด < เมื่อวาน < วันก่อนหน้า)
    const n7 = ser7.length;
    const drop2 = n7 >= 3 && ser7[n7 - 1] > 0 && ser7[n7 - 2] > 0 && ser7[n7 - 3] > 0 &&
                  ser7[n7 - 1] < ser7[n7 - 2] && ser7[n7 - 2] < ser7[n7 - 3];
    const statusColor = a.complete ? pctColor(p) : C_AMBER;
    const headState = !a.complete ? "ยอดยังไม่ครบทุกผลัด"
      : isLow ? "ต่ำสุดในรอบสัปดาห์"
      : p == null ? "ยังไม่ตั้งเป้า" : p >= 100 ? "เกินเป้า" : "ต่ำกว่าเป้า";
    const dv = st7 && st7.avg > 0 ? (a.total / st7.avg - 1) * 100 : null;
    // เป้าตั้งสูงผิดปกติเทียบยอดจริงเฉลี่ย 7 วัน — ให้ไปตรวจว่าตั้งเป้าถูกไหม
    const tgtOver = (st7 && st7.avg > 0 && a.target_total > 0) ? (a.target_total / st7.avg - 1) * 100 : null;
    const branchNotes: any[] = [];
    if (a.complete && (drop2 || isLow)) {
      const bits: string[] = [];
      if (drop2) bits.push("ตกต่อเนื่อง 2 วัน");
      if (isLow) bits.push("เป็นวันต่ำสุดของสัปดาห์");
      const pv = prevMap[a.branch_id];
      const cu = (pv && pv.customers > 0 && a.customers > 0) ? " · ลูกค้าจาก " + th(pv.customers) + " เหลือ " + th(a.customers) + " คน" : "";
      branchNotes.push(noteBox(bits.join(" และ ") + cu, "#991b1b", "#fef2f2"));
    }
    if (tgtOver != null && tgtOver >= 30) {
      branchNotes.push(noteBox("เป้าวันนี้ตั้งไว้ ฿" + th(a.target_total) + " สูงกว่ายอดจริงเฉลี่ย 7 วัน ~" + Math.round(tgtOver) + "% — ตรวจว่าตั้งเป้าถูกไหม", "#92400e", "#fef3c7"));
    }
    if (!a.complete) branchNotes.push(noteBox(noteOne(a).text, noteOne(a).color, noteOne(a).bg));
    bubbles.push(salesBubble({
      color: statusColor,
      headLabel: bareName(a.name) + " · " + headState,
      headPct: a.complete ? p : null, headPctText: p == null ? undefined : p.toFixed(1) + "% ของเป้า ฿" + th(a.target_total),
      cap: (a.complete ? "ยอดวันล่าสุด · " : "ยอดเท่าที่ส่งแล้ว · ") + dowFull(day) + " " + fmtThaiDate(day),
      big: "฿" + th(a.total),
      delta: a.complete ? (() => { const d2 = deltaOf(a.total, prevMap[a.branch_id]?.total || 0); return d2 ? { text: d2.text + " จากเมื่อวาน", color: d2.color } : undefined; })() : undefined,
      body: [
        sepLine(), capText("7 วันหลังสุด"),
        ...hBarRows(ser7, ser.dates.map(dowDay), statusColor),
        sepLine(),
        kvRow("เฉลี่ย 7 วัน", st7 ? "฿" + th(st7.avg) : "—"),
        kvRow("วันนี้เทียบเฉลี่ย", dv == null ? "—" : (dv >= 0 ? "+" : "−") + Math.abs(dv).toFixed(1) + "%",
          dv == null ? C_GREY : dv >= -3 ? C_GREEN : dv >= -10 ? C_AMBER : C_RED),
        kvRow("สูงสุดสัปดาห์", iMax >= 0 && st7 ? dowDay(ser.dates[iMax]) + " · ฿" + th(st7.max) : "—"),
        kvRow("ลูกค้า / ต่อหัว", th(a.customers) + " คน · ฿" + perHead(a).toFixed(2)),
        ...(a.complete ? [] : [
          kvRow("ส่งยอดแล้ว", a.shiftRows + " / " + SHIFTS_PER_DAY + " ผลัด", C_AMBER),
          kvRow("ขาดผลัด", missShifts(a).join(", ") || "—", C_AMBER),
        ]),
        ...branchNotes,
      ],
      btn: "ดูรายละเอียดสาขานี้", url: APP_URL + "/hr/",
    }));
  }
  const ab = insightBubble(day, aggs, ser, mon);   // ★ ใบวิเคราะห์ท้ายสุด
  if (ab) bubbles.push(ab);
  return { type: "flex", altText: "ยอดขาย " + fmtThaiDate(day) + (full ? " รวม ฿" + th(grand) + (gp != null ? " (" + gp.toFixed(0) + "% ของเป้า)" : "") : " ฿" + th(grand) + " (ยอดยังไม่ครบทุกผลัด)"), contents: { type: "carousel", contents: bubbles.slice(0, 12) } };
}

// ---------- carousel รายสัปดาห์ ----------
function weekCarousel(label: string, aggs: Agg[], prevMap: Record<string, Agg>, ser: any) {
  const rep = aggs.filter((a) => a.reported);
  const grand = rep.reduce((s2, a) => s2 + a.total, 0);
  const tgt = rep.reduce((s2, a) => s2 + a.target_total, 0);
  const prevGrand = Object.values(prevMap).reduce((s2, a) => s2 + a.total, 0);
  const gp = tgt > 0 ? grand / tgt * 100 : null;
  const cust = rep.reduce((s2, a) => s2 + a.customers, 0);
  const tot = ser.total.map((x: number) => Math.round(x));
  const hi = tot.length ? tot.indexOf(Math.max(...tot)) : -1;
  const lo = tot.length ? tot.indexOf(Math.min(...tot.filter((x: number) => x > 0))) : -1;
  const bubbles: any[] = [];

  bubbles.push(salesBubble({
    color: pctColor(gp),
    headLabel: "สรุปสัปดาห์ · ทุกสาขา",
    headPct: gp, headPctText: gp == null ? undefined : gp.toFixed(1) + "% ของเป้าหมาย",
    cap: label, big: "฿" + th(grand), delta: deltaOf(grand, prevGrand),
    body: [
      sepLine(), capText("ยอดรวมรายวัน"),
      ...barChart(tot, ser.dates.map(dowLabel), hi, pctColor(gp)),
      sepLine(),
      ...(hi >= 0 ? [kvRow("วันที่ดีที่สุด", dowLabel(ser.dates[hi]) + " ฿" + th(tot[hi]), C_GREEN)] : []),
      ...(lo >= 0 ? [kvRow("วันที่ต่ำสุด", dowLabel(ser.dates[lo]) + " ฿" + th(tot[lo]), C_AMBER)] : []),
      kvRow("ลูกค้าทั้งสัปดาห์", th(cust) + " คน"),
      kvRow("ยอดต่อหัว", cust > 0 ? "฿" + (grand / cust).toFixed(2) : "—"),
    ],
    btn: "เปิดแดชบอร์ดยอดขาย", url: APP_URL + "/hr/",
  }));

  for (const a of aggs) {
    if (!a.reported) continue;
    const p = achievePct(a);
    const pv = prevMap[a.branch_id]?.total || 0;
    const mx = Math.max(a.total, pv, 1);
    bubbles.push(salesBubble({
      color: pctColor(p),
      headLabel: bareName(a.name) + " · " + (p == null ? "ยังไม่ตั้งเป้า" : p >= 100 ? "เกินเป้า" : "ต่ำกว่าเป้า"),
      headPct: p, headPctText: p == null ? undefined : p.toFixed(1) + "% ของเป้า ฿" + th(a.target_total),
      cap: "ยอดขายทั้งสัปดาห์", big: "฿" + th(a.total), delta: deltaOf(a.total, pv),
      body: [
        sepLine(), capText("เทียบสัปดาห์ก่อน"),
        ...barChart([a.total, pv], ["นี้", "ก่อน"], 0, pctColor(p), "#d4d4d8"),
        sepLine(),
        kvRow("ลูกค้า", th(a.customers) + " คน"),
        kvRow("ยอดต่อหัว", "฿" + perHead(a).toFixed(2)),
        kvRow("All Cafe", "฿" + th(a.allcafe)),
        kvRow("Delivery", "฿" + th(a.delivery)),
      ],
      btn: "ดูรายละเอียดสาขา", url: APP_URL + "/hr/",
    }));
  }
  return { type: "flex", altText: "สรุปยอดขายรายสัปดาห์ " + label + " รวม ฿" + th(grand), contents: { type: "carousel", contents: bubbles.slice(0, 12) } };
}

// ---------- การ์ดบทวิเคราะห์ (ไม่มีปุ่ม) ----------
function analysisBubble(label: string, textBody: string, sources: string[], warn: string, promoTop: string[] = [], promoEnding: string[] = []) {
  const paras = String(textBody || "").split(/\n+/).map((t) => t.trim()).filter(Boolean).slice(0, 12);
  const b: any[] = paras.map((t, i) => ({ type: "text", text: t, wrap: true, size: "sm", color: "#27272a", margin: i ? "md" : "none" }));
  if (warn) b.push({ type: "box", layout: "vertical", margin: "md", backgroundColor: "#fef2f2", cornerRadius: "8px", paddingAll: "10px", contents: [{ type: "text", text: warn, wrap: true, size: "xs", color: "#991b1b" }] });
  if (promoEnding.length) {
    b.push({ type: "box", layout: "vertical", margin: "lg", backgroundColor: "#fff7ed", cornerRadius: "8px", paddingAll: "10px", spacing: "xs", contents: [
      { type: "text", text: "⏳ โปรฯ ใกล้หมด — เร่งเชียร์", size: "xs", weight: "bold", color: "#9a3412" },
      ...promoEnding.slice(0, 4).map((t) => ({ type: "text", text: "• " + t, wrap: true, size: "xxs", color: "#9a3412" })),
    ] });
  }
  if (promoTop.length) {
    b.push({ type: "box", layout: "vertical", margin: "md", backgroundColor: "#f0fdfa", cornerRadius: "8px", paddingAll: "10px", spacing: "xs", contents: [
      { type: "text", text: "🎯 ของคุ้มที่สุดในรอบ — พูดกับลูกค้าได้เลย", size: "xs", weight: "bold", color: "#0f766e" },
      ...promoTop.slice(0, 5).map((t) => ({ type: "text", text: "• " + t, wrap: true, size: "xxs", color: "#115e59" })),
    ] });
  }
  if (sources.length) {
    b.push({ type: "separator", margin: "lg" });
    b.push({ type: "text", text: "อ้างอิงจากคลังความรู้", size: "xxs", color: "#71717a", weight: "bold", margin: "md" });
    b.push({ type: "text", text: sources.slice(0, 6).join(" · "), wrap: true, size: "xxs", color: "#a1a1aa", margin: "xs" });
  }
  return {
    type: "bubble", size: "mega",
    header: capHead(C_VIOLET, "📊 บทวิเคราะห์รายสัปดาห์ · โดยนิดา", null) as any,
    body: { type: "box", layout: "vertical", contents: [{ type: "text", text: label, size: "xs", color: "#8c8c8c" }, ...b] },
  };
}

// ---------- คลังความรู้ของนิดา (โปรโมชั่น/มาตรฐาน/คู่มือ) ----------
const TH_MON_MAP: Record<string, number> = {
  "มค": 1, "กพ": 2, "มีค": 3, "เมย": 4, "พค": 5, "มิย": 6, "กค": 7, "สค": 8, "กย": 9, "ตค": 10, "พย": 11, "ธค": 12,
  "มกราคม": 1, "กุมภาพันธ์": 2, "มีนาคม": 3, "เมษายน": 4, "พฤษภาคม": 5, "มิถุนายน": 6,
  "กรกฎาคม": 7, "สิงหาคม": 8, "กันยายน": 9, "ตุลาคม": 10, "พฤศจิกายน": 11, "ธันวาคม": 12,
};
// หา "วันสุดท้าย" ที่เอกสารอ้างถึง — ใช้ดูว่าโปรฯ หมดอายุหรือยัง (รองรับ พ.ศ./ค.ศ. และเดือนย่อ/เต็ม)
function latestDateIn(text: string): string | null {
  const re = /(\d{1,2})\s*([฀-๿.\s]{2,14}?)\s*((?:25|20)\d{2})/g;
  let m: RegExpExecArray | null, best: string | null = null;
  while ((m = re.exec(text)) !== null) {
    const mon = TH_MON_MAP[m[2].replace(/[.\s]/g, "")];
    if (!mon) continue;
    let y = Number(m[3]); if (y > 2400) y -= 543;
    const d = y + "-" + String(mon).padStart(2, "0") + "-" + m[1].padStart(2, "0");
    if (!best || d > best) best = d;
  }
  return best;
}
async function loadKnowledge(weak: string[]): Promise<{ text: string; sources: string[]; warn: string }> {
  let out = "", warn = "";
  const sources: string[] = [];
  try {
    // 1) โปรโมชั่น / นโยบาย / มาตรฐาน — ใส่เต็ม (จำนวนน้อย แต่เป็นของที่ใช้จริงตอนนี้)
    const { data: core } = await sb.from("nida_knowledge").select("category,title,content,valid_from,valid_to")
      .eq("active", true).in("category", ["note", "policy", "standard"])
      .order("updated_at", { ascending: false }).limit(20);
    const today = bkkDate(0);
    let budget = 9000;
    for (const r of (core || [])) {
      const body = String((r as any).content || "").replace(/\s+/g, " ").trim();
      // ★ 7 ก.ย. 2569 — ใช้คอลัมน์ valid_from/valid_to จริง แทนการเดาวันจากข้อความ (regex เดาผิดได้ง่าย)
      //   ถ้าแถวไหนยังไม่ได้ใส่วันที่ ค่อยถอยไปเดาแบบเดิมเป็นตาข่ายรอง
      const vf = (r as any).valid_from ? String((r as any).valid_from) : null;
      const vt = (r as any).valid_to ? String((r as any).valid_to) : null;
      const exp = vt || (vf ? null : latestDateIn(String((r as any).title || "") + " " + body.slice(0, 400)));
      if (vf && vf > today) continue;                       // ยังไม่ถึงวันเริ่มใช้ — ข้ามไปก่อน ไม่ต้องเตือน
      if (exp && exp < today) { if (!warn) warn = "⚠️ เอกสาร “" + (r as any).title + "” หมดอายุแล้ว (ถึง " + exp + ") รบกวนอัปเดตคลังความรู้ของนิดาด้วยค่ะ"; continue; }
      const per = vt ? " (ใช้ถึง " + vt + ")" : "";
      const line = "• [" + (r as any).category + "] " + (r as any).title + per + ": " + body + "\n";
      if (budget - line.length < 0) break;
      out += line; budget -= line.length; sources.push(String((r as any).title));
    }
    // 2) คู่มือสอนงาน — เลือกเฉพาะที่ตรงกับจุดอ่อนที่ตัวเลขชี้ (ทั้งชุดใหญ่เกินใส่หมด)
    if (weak.length) {
      const ors: string[] = [];
      weak.forEach((w) => { ors.push("title.ilike.%" + w + "%", "content.ilike.%" + w + "%", "tags.ilike.%" + w + "%"); });
      const { data: tr } = await sb.from("nida_knowledge").select("title,content,valid_from,valid_to")
        .eq("active", true).in("category", ["training", "manual"]).or(ors.join(",")).limit(8);
      let b2 = 5000;
      for (const r of (tr || [])) {
        const _vf = (r as any).valid_from ? String((r as any).valid_from) : null;
        const _vt = (r as any).valid_to ? String((r as any).valid_to) : null;
        if (_vf && _vf > today) continue;                   // ยังไม่เริ่มใช้
        if (_vt && _vt < today) continue;                   // หมดอายุแล้ว
        const line = "• [คู่มือ] " + (r as any).title + ": " + String((r as any).content || "").replace(/\s+/g, " ").trim().slice(0, 1100) + "\n";
        if (b2 - line.length < 0) break;
        out += line; b2 -= line.length; sources.push(String((r as any).title));
      }
    }
  } catch (_e) { /* ยังไม่ได้รัน nida_knowledge.sql ก็ข้าม */ }
  return { text: out, sources: [...new Set(sources)], warn };
}
// จุดอ่อนจากตัวเลข → คำค้นคู่มือ
function weakPoints(aggs: Agg[]): string[] {
  const rep = aggs.filter((a) => a.reported); if (!rep.length) return [];
  const w = new Set<string>();
  const avgHead = rep.reduce((s2, a) => s2 + perHead(a), 0) / rep.length;
  if (rep.some((a) => perHead(a) < avgHead)) { w.add("เสนอขาย"); w.add("ขายพ่วง"); }
  if (rep.some((a) => a.delivery <= 0 || a.delivery < a.total * 0.03)) w.add("Delivery");
  if (rep.some((a) => a.allcafe < a.total * 0.08)) w.add("All Cafe");
  if (rep.some((a) => { const p = achievePct(a); return p != null && p < 95; })) { w.add("บริการ"); w.add("ทักทาย"); }
  return [...w].slice(0, 6);
}

// ---------- ตัวช่วยวันที่/ช่วงเวลา ----------
const TH_MON = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
function addDaysStr(s: string, n: number): string { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
type Range = { start: string; end: string };
// สัปดาห์ที่จบล่าสุด (จ.–อา.) เทียบกับ anchor (ตั้งใจให้รันเช้าวันจันทร์)
function lastCompleteWeek(anchor: string): Range {
  const dow = new Date(anchor + "T00:00:00Z").getUTCDay(); // 0=อา..6=ส
  const backToMon = dow === 0 ? 6 : dow - 1;
  const thisMon = addDaysStr(anchor, -backToMon);
  return { start: addDaysStr(thisMon, -7), end: addDaysStr(thisMon, -1) };
}
function prevWeek(r: Range): Range { return { start: addDaysStr(r.start, -7), end: addDaysStr(r.end, -7) }; }
// เดือนปฏิทินที่จบล่าสุด (ตั้งใจให้รันวันที่ 1)
function lastCompleteMonth(anchor: string): Range {
  const d = new Date(anchor + "T00:00:00Z");
  const firstThis = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(firstThis.getTime() - 86400000);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
function prevMonth(r: Range): Range { const end = addDaysStr(r.start, -1); const d = new Date(end + "T00:00:00Z"); const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10); return { start, end }; }
function monthToDate(anchor: string): Range { const d = new Date(anchor + "T00:00:00Z"); const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10); return { start, end: anchor }; }
function weekLabel(r: Range): string { const a = new Date(r.start + "T00:00:00Z"), b = new Date(r.end + "T00:00:00Z"); const y = b.getUTCFullYear(); return a.getUTCMonth() === b.getUTCMonth() ? `${a.getUTCDate()}–${b.getUTCDate()} ${TH_MON[b.getUTCMonth()]} ${y}` : `${a.getUTCDate()} ${TH_MON[a.getUTCMonth()]}–${b.getUTCDate()} ${TH_MON[b.getUTCMonth()]} ${y}`; }
function monthLabel(r: Range): string { const a = new Date(r.start + "T00:00:00Z"); return `${TH_MON[a.getUTCMonth()]} ${a.getUTCFullYear()}`; }

const SALES_COLS = "branch_id,sale_date,shift,sales_total,sales_product,sales_card,target_total,customers,allcafe_baht,delivery_baht";
async function fetchRangeAgg(branches: any[], r: Range): Promise<Agg[]> {
  const { data } = await sb.from("sales_daily").select(SALES_COLS).gte("sale_date", r.start).lte("sale_date", r.end);
  return aggregate(data || [], branches);
}
async function askGemini(prompt: string, maxTok = 1024): Promise<string> {
  if (!GKEY) return "";
  try {
    // thinkingBudget:0 = ปิดโหมดคิด (ไม่งั้น Gemini 2.5 กิน token จนคำตอบจริงถูกตัดกลางประโยค)
    const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: maxTok, thinkingConfig: { thinkingBudget: 0 } } };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GKEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) { console.warn("gemini", r.status, JSON.stringify(j).slice(0, 200)); return ""; }
    const cand = j.candidates?.[0];
    const txt = ((cand?.content?.parts || []).map((p: any) => p.text || "").join("")).trim();
    if (!txt && cand?.finishReason) console.warn("gemini empty, finishReason=", cand.finishReason);
    return txt;
  } catch (e) { console.warn("askGemini error", e); return ""; }
}
// กันส่งซ้ำ (ต้องมีตาราง sales_digest_log)
async function alreadySent(kind: string, key: string): Promise<boolean> { try { const { data } = await sb.from("sales_digest_log").select("kind").eq("log_date", key).eq("kind", kind).maybeSingle(); return !!data; } catch { return false; } }
async function markSent(kind: string, key: string): Promise<void> { try { await sb.from("sales_digest_log").upsert({ log_date: key, kind }, { onConflict: "log_date,kind" }); } catch { /* */ } }

// ---------- สรุปช่วงเวลา (สัปดาห์/เดือน) ----------
function buildPeriodText(title: string, label: string, aggs: Agg[], prevMap: Record<string, Agg>): string {
  const grand = aggs.reduce((s, a) => s + a.total, 0);
  const prevGrand = Object.values(prevMap).reduce((s, a) => s + a.total, 0);
  const dodG = prevGrand > 0 ? (grand - prevGrand) / prevGrand * 100 : null;
  const tgt = aggs.reduce((s, a) => s + a.target_total, 0);
  const L: string[] = [];
  L.push(`${title} (${label}):`);
  L.push("");
  L.push(`ยอดรวมทุกสาขา: ${th(grand)} บาท`);
  if (dodG !== null) L.push(`เทียบช่วงก่อน ${th(prevGrand)} บาท (${dodG >= 0 ? "+" : ""}${dodG.toFixed(1)}%)`);
  if (tgt > 0) L.push(`เฉลี่ยบรรลุเป้า: ${(grand / tgt * 100).toFixed(1)}%`);
  for (const a of aggs) {
    const p = prevMap[a.branch_id];
    const dod = p && p.total > 0 ? (a.total - p.total) / p.total * 100 : null;
    const arrow = dod === null ? "" : dod >= 5 ? " 🔺" : dod <= -5 ? " 🔻" : "";
    L.push("");
    L.push(` • สาขา ${bareName(a.name)}: ${th(a.total)} บาท` + (dod !== null ? ` (${dod >= 0 ? "+" : ""}${dod.toFixed(1)}%)` : "") + arrow);
  }
  // ข้อสังเกตสั้น
  const withDod = aggs.map(a => { const p = prevMap[a.branch_id]; return { a, dod: p && p.total > 0 ? (a.total - p.total) / p.total * 100 : null }; });
  const up = withDod.filter(x => x.dod !== null).sort((x, y) => (y.dod! - x.dod!))[0];
  const down = withDod.filter(x => x.dod !== null).sort((x, y) => (x.dod! - y.dod!))[0];
  const below = aggs.filter(a => { const tp = achievePct(a); return tp !== null && tp < 90; });
  const notes: string[] = [];
  if (up && up.dod! > 0) notes.push(`สาขา${bareName(up.a.name)}เติบโตสูงสุด ${up.dod! >= 0 ? "+" : ""}${up.dod!.toFixed(1)}% ค่ะ`);
  if (down && down.dod! < 0) notes.push(`สาขา${bareName(down.a.name)}ลดลงมากสุด ${down.dod!.toFixed(1)}% ควรจับตาค่ะ`);
  if (below.length) notes.push(`สาขาที่ยังต่ำกว่าเป้า: ${below.map(a => bareName(a.name)).join(", ")}`);
  if (notes.length) { L.push(""); L.push("ข้อสังเกต:"); notes.forEach(n => L.push(` • ${n}`)); }
  return L.join("\n");
}
function periodLinesForAI(aggs: Agg[], prevMap: Record<string, Agg>): string {
  return aggs.map(a => { const p = prevMap[a.branch_id]; const dod = p && p.total > 0 ? Math.round((a.total - p.total) / p.total * 100) : null; const tp = achievePct(a); return `${a.name}: ${Math.round(a.total)} บาท` + (tp !== null ? ` (${tp.toFixed(1)}% เป้า)` : "") + (dod !== null ? ` เทียบช่วงก่อน ${dod >= 0 ? "+" : ""}${dod}%` : "") + `; All Cafe ${Math.round(a.allcafe)} Delivery ${Math.round(a.delivery)} ลูกค้า ${Math.round(a.customers)} ต่อหัว ${perHead(a).toFixed(2)}`; }).join("\n");
}

async function runPeriod(kind: "weekly" | "monthly", anchor: string, dry = false): Promise<Response> {
  const { data: branches } = await sb.from("branches").select("branch_id,name").order("branch_id");
  const r = kind === "weekly" ? lastCompleteWeek(anchor) : lastCompleteMonth(anchor);
  const pr = kind === "weekly" ? prevWeek(r) : prevMonth(r);
  const label = kind === "weekly" ? weekLabel(r) : monthLabel(r);
  const [aggs, prevAggs] = await Promise.all([fetchRangeAgg(branches || [], r), fetchRangeAgg(branches || [], pr)]);
  const prevMap: Record<string, Agg> = {}; prevAggs.forEach(p => prevMap[p.branch_id] = p);
  if (!aggs.some(a => a.reported)) return json({ ok: true, sent: 0, note: `ไม่มียอดขายในช่วง ${label}` });
  const title = kind === "weekly" ? "📈 สรุปยอดขายรายสัปดาห์" : "📅 สรุปยอดขายรายเดือน";
  const overview = buildPeriodText(title, label, aggs, prevMap);
  const grand = aggs.reduce((s, a) => s + a.total, 0), prevGrand = prevAggs.reduce((s, a) => s + a.total, 0);
  const prompt = `คุณคือ "นิดา" โค้ชปฏิบัติการหน้าร้าน 7-Eleven กำลังโค้ชผู้จัดการ 3 สาขา จากยอดขาย${kind === "weekly" ? "รายสัปดาห์" : "รายเดือน"} (${label}) ตัวเลขผู้จัดการเห็นแล้ว ห้ามทวนซ้ำ
ข้อมูลรวมทั้งช่วง (เทียบช่วงก่อนหน้า) ใช้คิด:
${periodLinesForAI(aggs, prevMap)}
ยอดรวมทุกสาขา ${Math.round(grand)} บาท (ช่วงก่อน ${Math.round(prevGrand)} บาท)

${COACH_STYLE}`;
  // ★ รายสัปดาห์: ป้อน "คลังความรู้ของนิดา" เข้าไปด้วย แล้วบังคับให้อ้างของจริง
  //   โปรโมชั่น/นโยบาย/มาตรฐาน ใส่เต็ม · คู่มือสอนงานเลือกเฉพาะที่ตรงกับจุดอ่อนที่ตัวเลขชี้
  const kb = kind === "weekly" ? await loadKnowledge(weakPoints(aggs)) : { text: "", sources: [], warn: "" };
  // ★ 7 ก.ย. 2569 — บทวิเคราะห์รายสัปดาห์ต้องอ้าง "โปรฯ ปัจจุบันทั้งหมด" จากตารางโปรฯ
  //   ของเดิมอ้างจากข้อความในคลังความรู้อย่างเดียว ซึ่งเก่าง่ายและไม่มีตัวเลขให้เชียร์
  const pm = kind === "weekly" ? await loadPromos(3) : { text: "", sheets: [], top: [], ending: [] };
  const ref = [
    kb.text ? "[คลังความรู้ของร้าน — มาตรฐานบริการ · คู่มือ · นโยบาย]\n" + kb.text : "",
    pm.text,
  ].filter(Boolean).join("\n\n");
  const prompt2 = ref ? (prompt + "\n\n" + ref + "\n\n" + PROMO_RULES) : prompt;
  const note = await askGemini(prompt2, 1400);
  if (dry) return json({ ok: true, dry: true, kind, label, overview, analysis: note, kb_sources: kb.sources, kb_warn: kb.warn, promo_sheets: pm.sheets, promo_ending: pm.ending, promo_block: pm.text });
  const gid = await mgrGroupId();
  if (!gid) return json({ ok: true, sent: 0, note: "ยังไม่พบกลุ่ม ผจก.", preview: overview });
  const messages: unknown[] = [];
  if (kind === "weekly") {
    const ser = await dailySeries(branches || [], r.end, 7);
    messages.push(weekCarousel(label, aggs, prevMap, ser));
    if (note || kb.warn || pm.top.length) messages.push({ type: "flex", altText: "บทวิเคราะห์รายสัปดาห์ " + label, contents: analysisBubble(label, note, kb.sources, kb.warn, pm.top, pm.ending) });
  } else {
    messages.push({ type: "text", text: overview });
    if (note) messages.push({ type: "text", text: `📊 บทวิเคราะห์รายเดือน (${label})\n\n${note}` });
  }
  const ok = await pushLine(gid, messages);
  return json({ ok, sent: ok ? messages.length : 0, kind, label, kb_used: kb.sources.length, promo_used: pm.sheets.length, promo_ending: pm.ending.length });
}

// ---------- แจ้งเตือนผิดปกติ (ยอดตก / ยังไม่ส่ง) ----------
async function runAnomaly(check: string, anchor: string): Promise<Response> {
  const day = anchor; // วันที่ตรวจ = เมื่อวาน
  const { data: settings } = await sb.from("app_settings").select("key,value").in("key", ["sales_anomaly_drop_pct"]);
  const thr = Number((settings || []).find((s: any) => s.key === "sales_anomaly_drop_pct")?.value || 20);
  const { data: branches } = await sb.from("branches").select("branch_id,name").order("branch_id");
  const brName: Record<string, string> = {}; (branches || []).forEach((b: any) => brName[b.branch_id] = b.name);
  const start = addDaysStr(day, -7);
  const { data: rows } = await sb.from("sales_daily").select("branch_id,sale_date,shift,sales_total").gte("sale_date", start).lte("sale_date", day);
  // รวมยอด "ต่อวันต่อสาขา" ก่อน (ใช้แถวปิดยอดถ้ามี กันนับซ้ำ) แล้วค่อยแยกเป็นวันนี้ vs 7 วันก่อน
  const grp: Record<string, any[]> = {};
  (rows || []).forEach((x: any) => { if (!x.branch_id) return; const k = x.branch_id + "|" + x.sale_date; (grp[k] = grp[k] || []).push(x); });
  const dayTot: Record<string, Record<string, number>> = {};
  for (const k of Object.keys(grp)) { const [bid, d] = k.split("|"); const use = dayUseRows(grp[k]); const tot = use.reduce((s, r) => s + Number(r.sales_total || 0), 0); (dayTot[bid] = dayTot[bid] || {})[d] = tot; }
  const byBr: Record<string, { day: number | null; prev: number[] }> = {};
  (branches || []).forEach((b: any) => byBr[b.branch_id] = { day: null, prev: [] });
  for (const bid of Object.keys(dayTot)) { const m = byBr[bid] || (byBr[bid] = { day: null, prev: [] }); for (const d of Object.keys(dayTot[bid])) { if (d === day) m.day = dayTot[bid][d]; else m.prev.push(dayTot[bid][d]); } }

  const gid = await mgrGroupId();
  const doMissing = check === "missing" || check === "both";
  const doDrop = check === "drop" || check === "both";
  const messages: unknown[] = [];

  if (doMissing && !(await alreadySent("missing", day))) {
    const miss = Object.entries(byBr).filter(([_, m]) => m.day === null && m.prev.length > 0).map(([bid]) => brName[bid] || bid);
    if (miss.length) messages.push({ type: "text", text: `⏰ ยังไม่ได้รับยอดขาย\n\nถึงเวลาแล้ว แต่ยังไม่ได้รับยอดของวันที่ ${day} จาก:\n${miss.map(n => " • " + n).join("\n")}\n\nรบกวนติดตามด้วยค่ะ` });
    if (gid && miss.length) { await pushLine(gid, [messages[messages.length - 1]]); await markSent("missing", day); }
  }
  if (doDrop && !(await alreadySent("drop", day))) {
    const drops: string[] = [];
    for (const [bid, m] of Object.entries(byBr)) {
      if (m.day === null || m.prev.length < 2) continue;
      const avg = m.prev.reduce((s, v) => s + v, 0) / m.prev.length;
      if (avg <= 0) continue;
      const pctDrop = (avg - m.day) / avg * 100;
      if (pctDrop >= thr) drops.push(` • ${brName[bid] || bid}: ${th(m.day)} บาท — ต่ำกว่าเฉลี่ย 7 วัน (${th(avg)}) −${Math.round(pctDrop)}%`);
    }
    if (drops.length) { const txt = `⚠️ แจ้งเตือนยอดผิดปกติ (${day})\n\n${drops.join("\n")}\n\nรบกวนตรวจสอบสาเหตุ เช่น สินค้าขาด / คนไม่พอ / เหตุการณ์พิเศษ ค่ะ`; messages.push({ type: "text", text: txt }); if (gid) { await pushLine(gid, [{ type: "text", text: txt }]); await markSent("drop", day); } }
  }
  return json({ ok: true, sent: messages.length, day, check, threshold: thr });
}

// ---------- QSSI เทียบยอดขาย ----------
async function runQssi(anchor: string, dry = false): Promise<Response> {
  const { data: branches } = await sb.from("branches").select("branch_id,name").order("branch_id");
  const mtd = monthToDate(anchor);
  const label = monthLabel(mtd);
  const [aggs, { data: audits }] = await Promise.all([
    fetchRangeAgg(branches || [], mtd),
    sb.from("audit_reports").select("branch_id,qssi_adjust,inspect_date,round").order("inspect_date", { ascending: false }),
  ]);
  const latestAudit: Record<string, any> = {};
  (audits || []).forEach((a: any) => { if (a.branch_id && !latestAudit[a.branch_id]) latestAudit[a.branch_id] = a; });
  const rows = aggs.map(a => { const au = latestAudit[a.branch_id]; const tp = achievePct(a); const q = au && au.qssi_adjust != null ? Number(au.qssi_adjust) : null; return { name: a.name, q, tp, hasSales: a.reported }; }).filter(x => x.q !== null || x.hasSales);
  if (!rows.length) return json({ ok: true, sent: 0, note: "ยังไม่มีข้อมูลตรวจร้าน/ยอดขายในเดือนนี้" });
  const L: string[] = [`🔍 คะแนนตรวจร้าน vs ยอดขาย (รอบ ${label})`, ""];
  for (const x of rows) {
    const flag = (x.q !== null && x.q < 80 && x.tp !== null && x.tp < 95) ? " ⚠️ ต่ำทั้งคู่" : (x.q !== null && x.q >= 90 && x.tp !== null && x.tp >= 100) ? " ✅ สอดคล้อง" : "";
    L.push(` • ${x.name}`);
    L.push(`   ตรวจ ${x.q !== null ? x.q.toFixed(0) + "%" : "—"} · ยอด ${x.tp !== null ? x.tp.toFixed(0) + "% เป้า" : "—"}${flag}`);
  }
  const overview = L.join("\n");
  const prompt = `คุณคือ "นิดา" โค้ชปฏิบัติการหน้าร้าน 7-Eleven ดูความสัมพันธ์ระหว่างคะแนนตรวจร้าน (QSSI %) กับผลบรรลุเป้ายอดขาย (%) รอบ ${label}
${rows.map(x => `${x.name}: ตรวจ ${x.q !== null ? x.q.toFixed(0) : "-"}% · ยอด ${x.tp !== null ? x.tp.toFixed(0) : "-"}% เป้า`).join("\n")}
ชี้ว่าสาขาไหนคะแนนตรวจกับยอดสวนทางกัน และสาขาที่ต่ำทั้งคู่ต้องเร่งแก้เรื่องหน้าร้านอะไร

${COACH_STYLE}`;
  const note = await askGemini(prompt);
  if (dry) return json({ ok: true, dry: true, label, overview, analysis: note });
  const messages: unknown[] = [{ type: "text", text: overview }];
  if (note) messages.push({ type: "text", text: `📊 บทวิเคราะห์\n\n${note}` });
  const gid = await mgrGroupId();
  if (!gid) return json({ ok: true, sent: 0, preview: overview });
  const ok = await pushLine(gid, messages);
  return json({ ok, sent: ok ? messages.length : 0, label });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    // ★ 7 ก.ย. 2569 — อ่านพารามิเตอร์จาก URL ได้ด้วย (เดิมอ่านจาก body อย่างเดียว)
    //   เคยยิงทดสอบด้วย GET ...?dry=1 แล้ว dry ไม่ทำงาน กลายเป็นส่งเข้าไลน์จริงโดยไม่ตั้งใจ
    const q = new URL(req.url).searchParams;
    const pick = (k: string): any => (body && body[k] !== undefined) ? body[k] : (q.get(k) ?? undefined);
    const mode = String(pick("mode") ?? pick("kind") ?? "daily");
    const dryV = pick("dry");
    const dry = dryV === true || dryV === "1" || dryV === "true";   // ทดสอบ: คำนวณ+วิเคราะห์แต่ไม่ส่งเข้ากลุ่ม
    const qDate = String(pick("date") ?? "");

    if (mode === "weekly" || mode === "monthly") return await runPeriod(mode, bkkDate(0), dry);
    if (mode === "anomaly") return await runAnomaly(String(pick("check") ?? "both"), /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : bkkDate(-1));
    if (mode === "qssi") return await runQssi(bkkDate(0), dry);

    // ---- daily (ค่าเริ่มต้น) ----
    const day  = /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : bkkDate(-1); // เมื่อวาน (ไทย)
    const prevDay = addDaysStr(day, -1);
    const [{ data: branches }, { data: rowsToday }, { data: rowsPrev }] = await Promise.all([
      sb.from("branches").select("branch_id,name").order("branch_id"),
      sb.from("sales_daily").select("branch_id,sale_date,shift,sales_total,sales_product,sales_card,target_total,customers,allcafe_baht,delivery_baht").eq("sale_date", day),
      sb.from("sales_daily").select("branch_id,sale_date,shift,sales_total,target_total").eq("sale_date", prevDay),
    ]);
    const aggs = aggregate(rowsToday || [], branches || []);
    const prevAggs = aggregate(rowsPrev || [], branches || []);
    if (!aggs.some(a => a.reported)) return json({ ok: true, sent: 0, day, note: "ยังไม่มีสาขาใดส่งยอดขายของวันที่ " + day });

    // ★ รายวัน = การ์ดตัวเลขอย่างเดียว ไม่มีบทวิเคราะห์แล้ว (ย้ายไปรายสัปดาห์)
    //   ดูวันเดียวยังไม่เห็นแนวโน้ม วิเคราะห์ทุกวันเลยกลายเป็นคำแนะนำกว้าง ๆ ซ้ำ ๆ
    const prevMap: Record<string, Agg> = {}; prevAggs.forEach(p => prevMap[p.branch_id] = p);
    const ser = await dailySeries(branches || [], day, 7);
    // ★ 17 ก.ย. 69 — สถิติรายเดือน 4 เดือนล่าสุด สำหรับการ์ดใบแรก (เทียบเดือนต่อเดือน)
    let mon: Record<string, MonStat[]> | undefined;
    try { mon = await monthAvgSeries(branches || [], day, 4); } catch (e) { console.warn("monthAvgSeries", e); }
    const overview = buildOverviewText(day, aggs);            // เก็บไว้เป็น preview ตอน dry เท่านั้น
    const flex = dailyCarousel(day, aggs, prevMap, ser, mon);
    if (dry) return json({ ok: true, dry: true, day, overview, flex });
    const gid = await mgrGroupId();
    if (!gid) return json({ ok: true, sent: 0, day, note: "ยังไม่พบกลุ่ม ผจก. (ตั้ง app_settings.mgr_group_id หรือกลุ่มที่ label มีคำว่า 'ผจก.')", preview: overview });
    const ok = await pushLine(gid, [flex]);
    return json({ ok, sent: ok ? 1 : 0, day, branches: aggs.length, reported: aggs.filter(a => a.reported).length, complete: aggs.filter(a => a.complete).length });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

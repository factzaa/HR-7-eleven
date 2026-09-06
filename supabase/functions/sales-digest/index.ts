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
};
function newAgg(id: string, name: string): Agg {
  return { branch_id: id, name, total: 0, product: 0, card: 0, target_total: 0, customers: 0, allcafe: 0, delivery: 0, shifts: 0, reported: false };
}
// แถว "ปิดยอด/สิ้นวัน" = ยอดรวมทั้งวัน (= เช้า+บ่าย+ดึก) — ห้ามเอาไปบวกกับรายผลัดอีก จะนับซ้ำ 2 เท่า
function isClosingShift(s: any): boolean { return /สิ้นวัน|สิ้นสุด|ปิดยอด|ทั้งวัน|รวมวัน|รวมทั้งวัน/.test(String(s || "")); }
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
    let dayTarget = head ? Number(head.target_total || 0) : sum(shifts, "target_total");
    if (dayTarget <= 0) dayTarget = Math.max(0, ...list.map((r: any) => Number(r.target_total || 0)));
    a.target_total += dayTarget;
  }
  return Object.values(by).sort((x, y) => y.total - x.total);
}
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
  return await askGemini(prompt, 1024);
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
  const b: any[] = [
    { type: "text", text: o.cap, size: "xs", color: "#8c8c8c" },
    { type: "text", text: o.big, size: "xxl", weight: "bold", color: "#18181b" },
  ];
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

// ---------- carousel รายวัน ----------
function dailyCarousel(day: string, aggs: Agg[], prevMap: Record<string, Agg>, ser: any) {
  const rep = aggs.filter((a) => a.reported);
  const grand = rep.reduce((s2, a) => s2 + a.total, 0);
  const tgt = rep.reduce((s2, a) => s2 + a.target_total, 0);
  const prevGrand = Object.values(prevMap).reduce((s2, a) => s2 + a.total, 0);
  const gp = tgt > 0 ? grand / tgt * 100 : null;
  const cust = rep.reduce((s2, a) => s2 + a.customers, 0);
  const bubbles: any[] = [];

  bubbles.push(salesBubble({
    color: pctColor(gp),
    headLabel: "ภาพรวมทุกสาขา · " + (gp == null ? "ยังไม่ตั้งเป้า" : gp >= 100 ? "เกินเป้า" : "ต่ำกว่าเป้า"),
    headPct: gp, headPctText: gp == null ? undefined : gp.toFixed(1) + "% ของเป้าหมาย",
    cap: "ยอดขายรวมเมื่อวาน · " + fmtThaiDate(day),
    big: "฿" + th(grand),
    delta: deltaOf(grand, prevGrand),
    body: [
      sepLine(),
      ...aggs.map((a) => { const p = achievePct(a); return kvRow(bareName(a.name), a.reported ? "฿" + th(a.total) + "  " + (p == null ? "—" : p.toFixed(0) + "%") : "ยังไม่ส่งยอด", a.reported ? pctColor(p) : C_GREY); }),
      sepLine(),
      kvRow("ลูกค้ารวม", th(cust) + " คน"),
      kvRow("ยอดต่อหัว", cust > 0 ? "฿" + (grand / cust).toFixed(2) : "—"),
      kvRow("ส่งยอดแล้ว", rep.length + " / " + aggs.length + " สาขา", rep.length === aggs.length ? C_GREEN : C_AMBER),
    ],
    btn: "เปิดแดชบอร์ดยอดขาย", url: APP_URL + "/hr/",
  }));

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
    const ser7 = (ser.byBranch[a.branch_id] || []).map((x: number) => Math.round(x));
    const hi = ser7.length ? ser7.indexOf(Math.max(...ser7)) : -1;
    bubbles.push(salesBubble({
      color: pctColor(p),
      headLabel: bareName(a.name) + " · " + (p == null ? "ยังไม่ตั้งเป้า" : p >= 100 ? "เกินเป้า" : "ต่ำกว่าเป้า"),
      headPct: p, headPctText: p == null ? undefined : p.toFixed(1) + "% ของเป้า ฿" + th(a.target_total),
      cap: "ยอดขายรวม", big: "฿" + th(a.total),
      delta: deltaOf(a.total, prevMap[a.branch_id]?.total || 0),
      body: [
        sepLine(), capText("ย้อนหลัง 7 วัน"),
        ...barChart(ser7, ser.dates.map(dowLabel), hi, pctColor(p), p != null && p < 95 ? "#fecaca" : "#bbf7d0"),
        sepLine(),
        kvRow("ลูกค้า", th(a.customers) + " คน"),
        kvRow("ยอดต่อหัว", "฿" + perHead(a).toFixed(2)),
        kvRow("ยอดบัตร", "฿" + th(a.card)),
        kvRow("All Cafe", "฿" + th(a.allcafe)),
        kvRow("Delivery", "฿" + th(a.delivery)),
      ],
      btn: "ดูรายละเอียดสาขา", url: APP_URL + "/hr/",
    }));
  }
  return { type: "flex", altText: "ยอดขาย " + fmtThaiDate(day) + " รวม ฿" + th(grand) + (gp != null ? " (" + gp.toFixed(0) + "% ของเป้า)" : ""), contents: { type: "carousel", contents: bubbles.slice(0, 12) } };
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
function analysisBubble(label: string, textBody: string, sources: string[], warn: string) {
  const paras = String(textBody || "").split(/\n+/).map((t) => t.trim()).filter(Boolean).slice(0, 12);
  const b: any[] = paras.map((t, i) => ({ type: "text", text: t, wrap: true, size: "sm", color: "#27272a", margin: i ? "md" : "none" }));
  if (warn) b.push({ type: "box", layout: "vertical", margin: "md", backgroundColor: "#fef2f2", cornerRadius: "8px", paddingAll: "10px", contents: [{ type: "text", text: warn, wrap: true, size: "xs", color: "#991b1b" }] });
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
    const { data: core } = await sb.from("nida_knowledge").select("category,title,content")
      .eq("active", true).in("category", ["note", "policy", "standard"])
      .order("updated_at", { ascending: false }).limit(20);
    const today = bkkDate(0);
    let budget = 9000;
    for (const r of (core || [])) {
      const body = String((r as any).content || "").replace(/\s+/g, " ").trim();
      const exp = latestDateIn(String((r as any).title || "") + " " + body.slice(0, 400));
      // ★ เอกสารโปรฯ ที่เลยวันหมดแล้ว ไม่เอามาแนะนำ — กันนิดาอ้างโปรฯ ที่จบไปแล้ว
      if (exp && exp < today) { if (!warn) warn = "⚠️ เอกสาร “" + (r as any).title + "” หมดอายุแล้ว (ถึง " + exp + ") รบกวนอัปเดตคลังความรู้ของนิดาด้วยค่ะ"; continue; }
      const line = "• [" + (r as any).category + "] " + (r as any).title + ": " + body + "\n";
      if (budget - line.length < 0) break;
      out += line; budget -= line.length; sources.push(String((r as any).title));
    }
    // 2) คู่มือสอนงาน — เลือกเฉพาะที่ตรงกับจุดอ่อนที่ตัวเลขชี้ (ทั้งชุดใหญ่เกินใส่หมด)
    if (weak.length) {
      const ors: string[] = [];
      weak.forEach((w) => { ors.push("title.ilike.%" + w + "%", "content.ilike.%" + w + "%", "tags.ilike.%" + w + "%"); });
      const { data: tr } = await sb.from("nida_knowledge").select("title,content")
        .eq("active", true).in("category", ["training", "manual"]).or(ors.join(",")).limit(6);
      let b2 = 5000;
      for (const r of (tr || [])) {
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
  const prompt2 = kb.text
    ? prompt + `

[คลังความรู้ของร้าน — โปรโมชั่นที่กำลังจัด · มาตรฐานบริการ · คู่มือ]
${kb.text}
กติกาเพิ่มเติม (สำคัญมาก):
- ถ้าจะพูดถึงสินค้า ราคา โปรโมชั่น หรือขั้นตอนการทำงาน ต้องหยิบจากคลังความรู้ข้างบนเท่านั้น ห้ามแต่งขึ้นเอง ห้ามเดาราคา
- ระบุชื่อสินค้าและราคาให้ชัด เช่น "เอ็ม 150 รับ 2 ขวด 22 บาท" พร้อมประโยคที่พนักงานพูดกับลูกค้าได้จริง
- ผูกทุกข้อกับ "สาขาไหน" และ "ตัวเลขอะไรที่ชี้ว่าต้องทำ"
- ถ้าโปรโมชั่นใกล้หมด ให้ยกขึ้นเป็นข้อแรกและบอกว่าเหลืออีกกี่วัน`
    : prompt;
  const note = await askGemini(prompt2, 1400);
  if (dry) return json({ ok: true, dry: true, kind, label, overview, analysis: note, kb_sources: kb.sources, kb_warn: kb.warn });
  const gid = await mgrGroupId();
  if (!gid) return json({ ok: true, sent: 0, note: "ยังไม่พบกลุ่ม ผจก.", preview: overview });
  const messages: unknown[] = [];
  if (kind === "weekly") {
    const ser = await dailySeries(branches || [], r.end, 7);
    messages.push(weekCarousel(label, aggs, prevMap, ser));
    if (note || kb.warn) messages.push({ type: "flex", altText: "บทวิเคราะห์รายสัปดาห์ " + label, contents: analysisBubble(label, note, kb.sources, kb.warn) });
  } else {
    messages.push({ type: "text", text: overview });
    if (note) messages.push({ type: "text", text: `📊 บทวิเคราะห์รายเดือน (${label})\n\n${note}` });
  }
  const ok = await pushLine(gid, messages);
  return json({ ok, sent: ok ? messages.length : 0, kind, label, kb_used: kb.sources.length });
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
    const mode = String(body?.mode || "daily");
    const dry = body?.dry === true || body?.dry === "1";   // ทดสอบ: คำนวณ+วิเคราะห์แต่ไม่ส่งเข้ากลุ่ม

    if (mode === "weekly" || mode === "monthly") return await runPeriod(mode, bkkDate(0), dry);
    if (mode === "anomaly") return await runAnomaly(String(body?.check || "both"), (body?.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : bkkDate(-1));
    if (mode === "qssi") return await runQssi(bkkDate(0), dry);

    // ---- daily (ค่าเริ่มต้น) ----
    const day  = (body?.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : bkkDate(-1); // เมื่อวาน (ไทย)
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
    const overview = buildOverviewText(day, aggs);            // เก็บไว้เป็น preview ตอน dry เท่านั้น
    const flex = dailyCarousel(day, aggs, prevMap, ser);
    if (dry) return json({ ok: true, dry: true, day, overview, flex });
    const gid = await mgrGroupId();
    if (!gid) return json({ ok: true, sent: 0, day, note: "ยังไม่พบกลุ่ม ผจก. (ตั้ง app_settings.mgr_group_id หรือกลุ่มที่ label มีคำว่า 'ผจก.')", preview: overview });
    const ok = await pushLine(gid, [flex]);
    return json({ ok, sent: ok ? 1 : 0, day, branches: aggs.length, reported: aggs.filter(a => a.reported).length });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

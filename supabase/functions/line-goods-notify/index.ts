// ============================================================
// Supabase Edge Function: line-goods-notify
// ยิง Flex แจ้ง "รับสินค้า" เข้ากลุ่ม LINE ของสาขานั้น (LINE Messaging API)
// Channel Access Token ตัวเดียว · Group ID แยกต่อสาขา (branches.line_group_id)
// เรียกจาก client หลังบันทึกรับสินค้า ({id}) · กันซ้ำด้วย goods_receipts.line_notified
// โหมดทดสอบ: {test:true, branch_id} → ส่งข้อความทดสอบเข้ากลุ่มของสาขานั้น
// Deploy: supabase functions deploy line-goods-notify --no-verify-jwt
// Secret: supabase secrets set LINE_CHANNEL_TOKEN=xxxx
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LINE_TOKEN   = Deno.env.get("LINE_CHANNEL_TOKEN") ?? "";
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

function row2(label: string, value: string, color = "#111111") {
  return { type: "box", layout: "baseline", spacing: "sm", contents: [
    { type: "text", text: label, color: "#8c8c8c", size: "sm", flex: 4 },
    { type: "text", text: value, wrap: true, color, size: "sm", flex: 6, weight: "bold" },
  ] };
}

// ★ ตรวจว่า LINE "ดึงรูปนี้ได้จริงไหม" — LINE จะดึงรูปจาก URL เองโดยไม่มี token
//   ถ้า bucket ไม่ public / ไฟล์หาย / ไม่ใช่ไฟล์รูป → LINE โหลดไม่ได้ การ์ดจะมาแต่ไม่มีรูป
async function checkImage(u: string): Promise<{ ok: boolean; status?: number; type?: string; reason?: string }> {
  try {
    let res = await fetch(u, { method: "HEAD" });
    if (res.status === 405 || res.status === 501) res = await fetch(u, { method: "GET" });   // บาง storage ไม่รับ HEAD
    const type = res.headers.get("content-type") || "";
    if (!res.ok) return { ok: false, status: res.status, reason: "โหลดรูปไม่ได้ (bucket ไม่ public หรือไฟล์หาย)" };
    if (!/^image\/(jpeg|jpg|png)/i.test(type)) return { ok: false, status: res.status, type, reason: "ไม่ใช่ JPEG/PNG — LINE ไม่รองรับ" };
    return { ok: true, status: res.status, type };
  } catch (e) {
    return { ok: false, reason: "fetch error: " + String((e as any)?.message || e) };
  }
}

function buildFlex(r: any, branchName: string, revised = false) {
  const diff = r.diff || 0;
  const diffTxt = (diff > 0 ? "+" : "") + diff + (diff === 0 ? " (ตรง)" : " (ไม่ตรง)");
  const diffColor = diff === 0 ? "#15803d" : "#dc2626";
  const bodyContents: any[] = [
    { type: "text", text: revised ? "✏️ แก้ไขข้อมูลรับสินค้า" : "📦 แจ้งรับสินค้า", weight: "bold", size: "lg", color: revised ? "#c2410c" : "#15803d" },
    { type: "text", text: branchName, size: "sm", color: "#8c8c8c" },
    ...(revised ? [{ type: "text", text: "ข้อมูลเดิมคีย์ผิด — ใช้ข้อมูลชุดนี้แทน", size: "xs", color: "#c2410c", wrap: true }] : []),
    { type: "separator", margin: "md" },
    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: [
      row2("คลัง", r.warehouse_name || ("#" + r.warehouse_id)),
      row2("เลขที่เอกสาร", r.ref_no || "-"),
      row2("วันที่", fmtDate(r.work_date)),
      row2("ลังเข้า", String(r.crates_in || 0)),
      row2("ลังคืน", String(r.crates_return || 0)),
      row2("ควรคืน (คงค้าง)", String(r.return_expected || 0)),
      row2("ส่วนต่าง", diffTxt, diffColor),
      row2("ผู้คุมผลัด", r.done_name || r.done_by || "-"),
    ] },
  ];
  if (r.note) bodyContents.push({ type: "text", text: "📝 " + r.note, wrap: true, size: "xs", color: "#8c8c8c", margin: "md" });

  // ★ มีรูปในระบบ แต่ LINE ดึงรูปไม่ได้ (เช่น bucket ไม่ public) → บอกให้รู้ ไม่ใช่เงียบหาย
  if (r._photo_note) {
    bodyContents.push({ type: "text", text: "📷 มีรูปแนบ " + r._photo_note + " รูป (แสดงในไลน์ไม่ได้ — เปิดดูในระบบ)", wrap: true, size: "xs", color: "#c2410c", margin: "md" });
  }

  // รูปแนบทั้งหมด (ลัง / บิล / ของชำรุด ฯลฯ) — แสดงครบทุกรูปแบบกริด 3 คอลัมน์ กดเปิดรูปเต็มได้
  const photos: string[] = (Array.isArray(r.in_photos) ? r.in_photos : []).filter((u: any) => typeof u === "string" && /^https:\/\//.test(u));
  const MAX = 12;                       // กันการ์ดยาวเกินไป
  const shown = photos.slice(0, MAX);
  if (shown.length > 1) {
    bodyContents.push({ type: "text", text: "📷 รูปแนบ " + photos.length + " รูป", size: "xs", color: "#8c8c8c", margin: "md" });
    const rows: any[] = [];
    for (let i = 1; i < shown.length; i += 3) {        // รูปแรกเป็น hero อยู่แล้ว → กริดเริ่มจากรูปที่ 2
      const cells: any[] = shown.slice(i, i + 3).map((u) => ({ type: "image", url: u, size: "full", aspectMode: "cover", aspectRatio: "1:1", action: { type: "uri", uri: u } }));
      while (cells.length < 3) cells.push({ type: "filler" });
      rows.push({ type: "box", layout: "horizontal", spacing: "sm", contents: cells });
    }
    if (rows.length) bodyContents.push({ type: "box", layout: "vertical", spacing: "sm", margin: "sm", contents: rows });
    if (photos.length > MAX) bodyContents.push({ type: "text", text: "…และอีก " + (photos.length - MAX) + " รูป", size: "xxs", color: "#8c8c8c" });
  }

  const bubble: any = { type: "bubble", body: { type: "box", layout: "vertical", contents: bodyContents } };
  if (shown.length) bubble.hero = { type: "image", url: shown[0], size: "full", aspectRatio: "20:13", aspectMode: "cover", action: { type: "uri", uri: shown[0] } };
  return { type: "flex", altText: (revised ? "แก้ไขข้อมูลรับสินค้า: " : "แจ้งรับสินค้า: ") + (r.warehouse_name || "") + " เลขที่ " + (r.ref_no || "-"), contents: bubble };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));

    // ----- โหมดทดสอบ -----
    if (body.test) {
      const bid = body.branch_id;
      const { data: br } = await sb.from("branches").select("name,line_group_id").eq("branch_id", bid).maybeSingle();
      if (!br || !br.line_group_id) return json({ ok: false, error: "สาขานี้ยังไม่ได้ตั้ง LINE Group ID" }, 400);
      if (!LINE_TOKEN) return json({ ok: false, error: "ยังไม่ได้ตั้ง LINE_CHANNEL_TOKEN (secret)" }, 400);
      const ok = await pushLine(br.line_group_id, [{ type: "text", text: "✅ ทดสอบแจ้งเตือนรับสินค้า — สาขา " + (br.name || bid) + " เชื่อมต่อกลุ่ม LINE สำเร็จ" }]);
      return json({ ok, sent: ok ? 1 : 0 });
    }

    // ----- ยิงจริง: id เดียว หรือสแกนที่ยังไม่ส่ง (fallback/retry) -----
    let rows: any[] = [];
    if (body.id) {
      const { data } = await sb.from("goods_receipts").select("*").eq("id", body.id).limit(1);
      rows = data || [];
    } else {
      const { data } = await sb.from("goods_receipts").select("*").eq("line_notified", false).order("submitted_at", { ascending: true }).limit(30);
      rows = data || [];
    }
    if (!rows.length) return json({ ok: true, sent: 0 });

    const revised = !!body.revised;   // ส่งซ้ำหลังแก้ไขข้อมูล → การ์ดจะขึ้นหัวว่า "แก้ไขข้อมูลรับสินค้า"

    const brIds = [...new Set(rows.map((r) => r.branch_id).filter(Boolean))];
    const [{ data: brs }, { data: whs }] = await Promise.all([
      sb.from("branches").select("branch_id,name,line_group_id").in("branch_id", brIds),
      sb.from("warehouses").select("id,code,name"),
    ]);
    const brMap: Record<string, any> = {}; (brs || []).forEach((b) => (brMap[b.branch_id] = b));
    const whMap: Record<string, string> = {}; (whs || []).forEach((w: any) => (whMap[w.id] = (w.code ? "[" + w.code + "] " : "") + w.name));

    let sent = 0;
    const diag: any[] = [];                            // ★ ผลตรวจรูปของแต่ละใบ (ไว้ดีบักว่าทำไมรูปไม่ขึ้น)
    for (const r of rows) {
      const br = brMap[r.branch_id] || {};
      if (!br.line_group_id || !LINE_TOKEN) {
        diag.push({ id: r.id, ref_no: r.ref_no, branch: r.branch_id, skipped: !br.line_group_id ? "สาขานี้ยังไม่ได้ตั้ง LINE Group ID" : "ยังไม่ได้ตั้ง LINE_CHANNEL_TOKEN" });
        continue;   // ไม่มีกลุ่ม/ไม่มี token → ข้าม (คง flag=false ไว้ retry)
      }
      if (!r.warehouse_name) r.warehouse_name = whMap[r.warehouse_id] || ("#" + r.warehouse_id);

      // ---- ตรวจรูปทีละใบก่อนส่ง ----
      const raw: string[] = Array.isArray(r.in_photos) ? r.in_photos.filter((u: any) => typeof u === "string" && u) : [];
      const https = raw.filter((u) => /^https:\/\//i.test(u));
      const checks = await Promise.all(https.map(async (u) => ({ url: u, ...(await checkImage(u)) })));
      const good = checks.filter((c) => c.ok).map((c) => c.url);
      const bad = checks.filter((c) => !c.ok);
      diag.push({
        id: r.id, ref_no: r.ref_no, branch: r.branch_id,
        photos_in_db: raw.length, https: https.length, usable: good.length,
        problems: bad.map((b) => ({ url: b.url, status: b.status, type: b.type, reason: b.reason })),
      });

      // ใช้เฉพาะรูปที่ LINE ดึงได้จริง (กันการ์ดเสีย) — ถ้าไม่มีรูปใช้ได้เลยแต่ในระบบมีรูป จะบอกไว้ในการ์ด
      // ★ ส่ง "การ์ด Flex ใบเดียว" เท่านั้น — ไม่ส่งรูปแยกตามหลังอีก (รกกลุ่ม)
      const rr = { ...r, in_photos: good, _photo_note: (raw.length && !good.length) ? raw.length : 0 };
      const ok = await pushLine(br.line_group_id, [buildFlex(rr, br.name || r.branch_id, revised)]);
      if (ok) { await sb.from("goods_receipts").update({ line_notified: true }).eq("id", r.id); sent++; }
      else diag[diag.length - 1].push_failed = true;
    }
    return json({ ok: true, sent, revised, diag });
  } catch (e) {
    return json({ ok: false, error: String((e && (e as any).message) || e) }, 500);
  }
});

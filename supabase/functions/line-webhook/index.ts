// ============================================================
// Supabase Edge Function: line-webhook
// รับข้อความขาเข้าจากกลุ่ม LINE ของแต่ละสาขา (LINE Messaging API webhook)
// เก็บลงตาราง line_messages เพื่อให้นิดาเอาไปสรุป/จับความเคลื่อนไหว
//
// ต้องตั้งค่าใน LINE Developers console:
//   - Messaging API → Use webhook = ON
//   - Webhook URL = https://<project>.supabase.co/functions/v1/line-webhook
//   - Allow bot to join group chats = ON
// Secrets:
//   supabase secrets set LINE_CHANNEL_TOKEN=xxxx       (มีอยู่แล้ว — ใช้ push/ดึง content)
//   supabase secrets set LINE_CHANNEL_SECRET=xxxx      (ใหม่ — ไว้ verify ลายเซ็น)
// Deploy: supabase functions deploy line-webhook --no-verify-jwt
//
// หมายเหตุ: LINE ดึงประวัติเก่าย้อนหลังไม่ได้ — เก็บได้เฉพาะข้อความใหม่ตั้งแต่เปิด webhook
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LINE_TOKEN   = Deno.env.get("LINE_CHANNEL_TOKEN") ?? "";
const LINE_SECRET  = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
// ★ ส่งต่อ webhook เดิมไปยังปลายทางอื่น (เช่น Google Apps Script ของอีกโปรเจก)
//   LINE ตั้ง Webhook URL ได้แค่ 1 อัน — ให้ของเราเป็นตัวหลักแล้ว forward สำเนาต่อ
//   ตั้งได้หลาย URL คั่นด้วย comma:  supabase secrets set LINE_WEBHOOK_FORWARD=https://script.google.com/.../exec
const FORWARD_URLS = (Deno.env.get("LINE_WEBHOOK_FORWARD") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const PHOTO_BUCKET = "employee-docs";   // public bucket เดิม
const ok200 = (b: unknown = { ok: true }) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

// ---------- ตรวจลายเซ็น X-Line-Signature (HMAC-SHA256 ของ body ดิบ, base64) ----------
async function verifySignature(rawBody: string, signature: string): Promise<boolean> {
  if (!LINE_SECRET || !signature) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(LINE_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
    return b64 === signature;
  } catch (_e) { return false; }
}

// ---------- ดึงชื่อผู้ส่ง (best-effort) ----------
async function memberName(groupId: string, userId: string): Promise<string | null> {
  if (!LINE_TOKEN || !groupId || !userId) return null;
  try {
    const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, {
      headers: { "Authorization": "Bearer " + LINE_TOKEN },
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({}));
    return j.displayName || null;
  } catch (_e) { return null; }
}

// ---------- ดึง content (รูป/ไฟล์) จาก LINE แล้วเก็บขึ้น storage ----------
async function saveMedia(messageId: string, groupId: string): Promise<string | null> {
  if (!LINE_TOKEN || !messageId) return null;
  try {
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { "Authorization": "Bearer " + LINE_TOKEN },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "image/jpeg";
    const ext = ct.includes("png") ? "png" : ct.includes("gif") ? "gif" : ct.includes("mp4") ? "mp4" : ct.includes("pdf") ? "pdf" : "jpg";
    const bytes = new Uint8Array(await res.arrayBuffer());
    const path = `line/${(groupId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "")}/${messageId}.${ext}`;
    const up = await sb.storage.from(PHOTO_BUCKET).upload(path, bytes, { contentType: ct, upsert: true });
    if (up.error) { console.warn("storage upload", up.error.message); return null; }
    const { data } = sb.storage.from(PHOTO_BUCKET).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch (e) { console.warn("saveMedia", e); return null; }
}

async function pushText(to: string, text: string) {
  if (!LINE_TOKEN || !to) return;
  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
    });
  } catch (_e) { /* ไม่ให้ล้ม webhook */ }
}

// จัดหมวด + ระดับความสำคัญของข้อความ (เหมือนฝั่ง hr-api)
const _URGENT = ["ปิดร้าน","ปิดสาขา","ของขาด","สินค้าขาด","ของหมด","สต๊อกหมด","ไฟดับ","ไฟไหม้","น้ำท่วม","ตู้เสีย","เครื่องเสีย","ระบบล่ม","ด่วน","ฉุกเฉิน","ทะเลาะ","วิวาท","ขโมย","ของหาย","เงินหาย","เงินขาด","อุบัติเหตุ","บาดเจ็บ","ร้องเรียน","ตำรวจ"];
function classifyMsg(t: string): { category: string; msg_class: string } {
  t = t || ""; const tt = t.trim();
  if (/(เข้าร่วมกลุ่ม|ออกจากกลุ่ม|ยกเลิกการเชิญ|เชิญ.*เข้ากลุ่ม|เปลี่ยน(ชื่อ|รูป)กลุ่ม|ตั้งชื่อกลุ่ม|ลบอัลบั้ม|ยกเลิกข้อความ|unsent)/.test(t)) return { category: "system", msg_class: "general" };
  const isAudit = /ครั้งที่\s*[:：]\s*\d|รายละเอียดข้อบกพร่อง|ผลการตรวจ|ตรวจร้าน|qssi|ประเมินร้าน/i.test(t);
  const isAnn = /@all|นัดประชุม|แจ้งพนักงานทุกระดับ|เรียน\s*ผู้บริหาร|ประกาศ|แจ้งให้ทราบทุก|ขอให้ทุกสาขา/i.test(t);
  const isTask = (/สร้างอัลบั้ม/.test(t) && /ส่งงาน|ผลัด/.test(t)) || /ส่งงาน|ล้างห้องน้ำ|เช็ค.?temp|temp\s?card|ตรวจเชลฟ์|จัดเชลฟ์/i.test(t);
  const isHand = /รับผลัด|ส่งผลัด|รับ-?ส่งผลัด|ส่งเวร|รับเวร|ล้าง.*ส่งผลัด/.test(t);
  const isPhoto = /^(\S+\s+)?(รูป|สติกเกอร์)$/.test(tt);
  let category = "general";
  if (/แจ้งยอดขาย|ยอดรวม\s*=|ยอดขายสินค้า/.test(t)) category = "sales";
  else if (isAudit) category = "audit";
  else if (isAnn) category = "announce";
  else if (isTask) category = "task";
  else if (isHand) category = "handover";
  else if (_URGENT.some((k) => t.includes(k))) category = "issue";
  else if (isPhoto) category = "photo";
  let cls = "general";
  if (/ด่วนที่สุด|ด่วนมาก|ฉุกเฉิน|ปิดร้าน|ไฟไหม้|ทะเลาะ|ของขาด|ของหมด|ระบบล่ม/.test(t)) cls = "urgent";
  else if (/นโยบาย|policy|ประกาศบริษัท/i.test(t)) cls = "policy";
  else if (/ระเบียบ|ข้อบังคับ|กฎ|บทลงโทษ|ห้าม/.test(t)) cls = "rule";
  else if (/ขั้นตอน|วิธีการ|วิธีปฏิบัติ|แนวปฏิบัติ|คู่มือ|how ?to/i.test(t)) cls = "procedure";
  else if (/ขอความร่วมมือ|ขอความอนุเคราะห์|รบกวนทุก|ช่วยกัน|ขอให้ทุกสาขา/.test(t)) cls = "cooperation";
  else if (/ติดตาม|ยังไม่|ค้าง|กำหนดส่ง|ภายในวันนี้|ภายในพรุ่งนี้|เตือน/.test(t)) cls = "follow_up";
  else if (/แจ้งให้ทราบ|ประชาสัมพันธ์|ข่าว|อัปเดต|โปรโมชั่น|แจ้งเปลี่ยน/.test(t)) cls = "news";
  return { category, msg_class: cls };
}

// ---------- ตัวแยกยอดขาย (เหมือนฝั่ง hr-api) — ให้ยอดขายสดลงตาราง sales_daily อัตโนมัติ ----------
const _snum = (s: string) => { const t = String(s).replace(/[, ]/g, "").replace(/%/g, ""); const v = parseFloat(t); return isNaN(v) ? null : v; };
const _stripLabel = (l: string) => String(l).replace(/^[\s\d]+[.．)]\s*/, "").replace(/[\u{1F000}-\u{1FAFF}]/gu, "").replace(/[《》「」\[\]☀-➿️🌅🌆🌇🥇🥈🥉]/gu, "").trim();
function _isShift(l: string): string | null { const s = _stripLabel(l).replace(/\s/g, ""); if (/สิ้นวัน|สิ้นสุดวัน|ปิดยอด/.test(s)) return "สิ้นวัน"; if (/ผลัดเช้า/.test(s)) return "เช้า"; if (/ผลัดบ่าย/.test(s)) return "บ่าย"; if (/ผลัด(ดึก|กลางคืน)/.test(s)) return "ดึก"; return null; }
function _salesAssign(o: any, label: string, valPart: string) {
  const L = label.toLowerCase(); const n = valPart.split("/").map((v) => _snum(v.trim()));
  const has = (...k: string[]) => k.every((x) => label.includes(x)); const hasL = (s: string) => L.includes(s);
  if (label.includes("เป้า")) { if (n.length >= 3) { o.target_product = n[0]; o.target_card = n[1]; o.target_total = n[2]; } else o.target_total = n[0]; }
  else if (label.includes("ยอดขาย") || label.includes("ยอดรวม")) {
    if (has("สินค้า", "ลูกค้า", "ต่อหัว")) { o.sales_product = n[0]; o.customers = n[1]; o.per_head = n[2]; }
    else if (has("สินค้า", "บัตร", "รวม")) { o.sales_product = n[0]; o.sales_card = n[1]; o.sales_total = n[2]; }
    else if (label.includes("บัตร")) o.sales_card = n[0];
    else if (label.includes("รวม")) o.sales_total = n[0];
    else if (label.includes("สินค้า")) o.sales_product = n[0];
  }
  else if (/^ลูกค้า/.test(label)) o.customers = n[0];
  else if (label.includes("ต่อหัว")) o.per_head = n[0];
  else if (hasL("cafe") || label.includes("คาเฟ่")) { o.allcafe_cups = n[0]; o.allcafe_baht = n[1]; }
  else if (hasL("delivery")) { o.delivery_bills = n[0]; o.delivery_baht = n[1]; }
  else if (hasL("tmw") || label.includes("ทรู") || hasL("truewallet")) { o.truewallet_baht = n[0]; o.truewallet_pct = n[1]; }
  else if (hasL("online")) o.extra.online = n;
  else if (label.includes("พาย")) o.extra.pai = n;
  else if (label.includes("ขนมจีบ")) o.extra.khanomjeeb = n;
  else if (label.includes("ซาลาเปา")) o.extra.salapao = n;
  else if (label) o.extra[label.slice(0, 16)] = n;
}
function extractSales(text: string): any[] {
  const lines = String(text).split("\n"); const shifts: Record<string, any> = {}; let cur: any = null, prevLabel = "";
  const ensure = (sh: string) => (shifts[sh] = shifts[sh] || { shift: sh, extra: {} });
  for (const raw of lines) {
    const line = raw.trim(); if (!line) continue;
    const sh = _isShift(line); if (sh) { cur = ensure(sh); prevLabel = ""; continue; }
    if (!cur) { if (/=|เป้า|ยอดขาย/.test(line)) cur = ensure("เช้า"); else continue; }
    const eq = line.indexOf("="); let label: string, valPart: string;
    if (eq >= 0) { label = line.slice(0, eq).trim(); valPart = line.slice(eq + 1).trim(); if (label === "") label = prevLabel; prevLabel = ""; }
    else { prevLabel = line; continue; }
    if (valPart === "") continue;
    _salesAssign(cur, _stripLabel(label), valPart);
  }
  const rows = Object.values(shifts).filter((s: any) => s.sales_total != null || s.sales_product != null || s.target_total != null);
  rows.forEach((s: any) => { if (s.sales_total == null && s.sales_product != null) s.sales_total = s.sales_product; });
  return rows;
}
function salesDate(text: string, fallbackIso: string): string | null {
  const m = String(text).match(/วันที่\s*(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/);
  if (m) {
    const d = +m[1], mo = +m[2]; let y = +m[3]; if (y < 100) y += 2500; if (y > 2500) y -= 543;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100) { const p = (n: number) => String(n).padStart(2, "0"); return y + "-" + p(mo) + "-" + p(d); }
  }
  return (fallbackIso || "").slice(0, 10) || null;
}

// map group → สาขา (จาก branches.line_group_id)
async function branchOfGroup(groupId: string): Promise<string | null> {
  if (!groupId) return null;
  const { data } = await sb.from("branches").select("branch_id").eq("line_group_id", groupId).maybeSingle();
  return data?.branch_id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "GET") return ok200({ ok: true, service: "line-webhook" });   // เผื่อ verify ตอนตั้ง webhook
  if (req.method !== "POST") return ok200();

  const raw = await req.text();
  const sig = req.headers.get("x-line-signature") || "";
  // ★ ตรวจลายเซ็น — กันคนยิงปลอม (ถ้ายังไม่ตั้ง SECRET จะปฏิเสธทั้งหมด)
  if (!(await verifySignature(raw, sig))) return new Response("bad signature", { status: 401 });

  let body: any = {};
  try { body = JSON.parse(raw); } catch { return ok200(); }
  const events: any[] = Array.isArray(body.events) ? body.events : [];

  // ★ ตอบ 200 ให้ LINE ทันที ไม่ต้องรอประมวลผลเสร็จ (กัน timeout/retry)
  (async () => {
    // ส่งต่อ request เดิม (body ดิบ + ลายเซ็น) ไปยังปลายทางอื่น เพื่อให้อีกโปรเจกทำงานต่อได้
    for (const url of FORWARD_URLS) {
      try {
        await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Line-Signature": sig }, body: raw });
      } catch (e) { console.warn("forward", url, e); }
    }
    for (const ev of events) {
      try { await handleEvent(ev); } catch (e) { console.warn("event", e); }
    }
  })();

  return ok200();
});

async function handleEvent(ev: any) {
  const src = ev.source || {};
  const groupId: string = src.groupId || src.roomId || "";
  const sourceType = src.groupId ? "group" : src.roomId ? "room" : "user";
  if (!groupId) return;   // สนใจเฉพาะข้อความในกลุ่ม/ห้อง

  const branch_id = await branchOfGroup(groupId);

  // บอทถูกเชิญเข้ากลุ่ม → บอก group id ให้ HR เอาไปผูกสาขา
  if (ev.type === "join") {
    await sb.from("line_groups").upsert({ group_id: groupId, joined_at: new Date().toISOString(), last_message_at: new Date().toISOString() }, { onConflict: "group_id" });
    if (!branch_id) await pushText(groupId, "✅ เชื่อมต่อระบบ HR สำเร็จ\nGroup ID: " + groupId + "\n(นำ ID นี้ไปผูกสาขาในระบบ → จัดการสาขา → LINE Group ID)");
    return;
  }
  if (ev.type === "leave") {
    await sb.from("line_groups").update({ note: "บอทออกจากกลุ่มแล้ว (" + new Date().toISOString().slice(0, 10) + ")" }).eq("group_id", groupId);
    return;
  }
  if (ev.type !== "message") return;

  const m = ev.message || {};
  const sentAt = ev.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString();
  const userId: string = src.userId || "";

  let msg_type = m.type || "text";
  let text: string | null = null;
  let media_url: string | null = null;
  let sticker: string | null = null;

  if (m.type === "text") text = m.text || "";
  else if (m.type === "image" || m.type === "video" || m.type === "file" || m.type === "audio") {
    media_url = await saveMedia(m.id, groupId);
    if (m.type === "file") text = m.fileName || null;
  } else if (m.type === "sticker") {
    sticker = (m.packageId || "") + "/" + (m.stickerId || "");
    text = Array.isArray(m.keywords) ? m.keywords.join(" ") : null;   // คำอารมณ์ของสติกเกอร์ (ถ้ามี)
  } else if (m.type === "location") {
    text = (m.title || "") + " " + (m.address || "");
  }

  const display_name = userId ? await memberName(groupId, userId) : null;

  // เก็บข้อความ (กันซ้ำด้วย line_msg_id unique) + จัดหมวด/ความสำคัญ
  const cl = classifyMsg(text || "");
  if (msg_type !== "text" && cl.category === "general") cl.category = "photo";   // ข้อความที่ไม่มีตัวอักษร (รูป/สติกเกอร์) → หมวดภาพ ไม่ใช่ทั่วไป
  await sb.from("line_messages").insert({
    line_msg_id: m.id || null,
    group_id: groupId, branch_id, source_type: sourceType,
    line_user_id: userId || null, display_name,
    msg_type, text, media_url, sticker,
    category: cl.category, msg_class: cl.msg_class,
    raw: ev, sent_at: sentAt,
  });

  // แยกยอดขายสด → ตาราง sales_daily อัตโนมัติ (เฉพาะกลุ่มที่ผูกสาขา + เป็นฟอร์มยอดขาย)
  if (branch_id && text && cl.category === "sales") {
    try {
      const sales = extractSales(text);
      const sdate = salesDate(text, sentAt);
      if (sales.length && sdate) {
        const COLS = ["target_product","target_card","target_total","sales_product","sales_card","sales_total","customers","per_head","allcafe_cups","allcafe_baht","delivery_bills","delivery_baht","truewallet_baht","truewallet_pct"];
        const CAP: Record<string, number> = { target_product:5e6, target_card:5e6, target_total:5e6, sales_product:5e6, sales_card:5e6, sales_total:5e6, customers:2e5, per_head:1e5, allcafe_cups:1e5, allcafe_baht:2e6, delivery_bills:1e5, delivery_baht:2e6, truewallet_baht:2e6, truewallet_pct:1000 };
        const recs = sales.map((s: any) => { const row: any = { branch_id, group_id: groupId, sale_date: sdate, shift: s.shift, reporter: (display_name || "").slice(0, 120), source: "live", raw_text: text.slice(0, 2000), extra: (s.extra && Object.keys(s.extra).length) ? s.extra : null }; COLS.forEach((k) => { let v = (s[k] === undefined ? null : s[k]); if (v != null && Math.abs(v) > CAP[k]) v = null; row[k] = v; }); return row; });
        await sb.from("sales_daily").upsert(recs, { onConflict: "branch_id,sale_date,shift" });
      }
    } catch (e) { console.warn("live sales extract", e); }
  }

  // อัปเดตทะเบียนกลุ่ม (นับข้อความ + ข้อความล่าสุด)
  const { data: g } = await sb.from("line_groups").select("msg_count").eq("group_id", groupId).maybeSingle();
  await sb.from("line_groups").upsert({
    group_id: groupId, branch_id, last_message_at: sentAt,
    last_text: text ? text.slice(0, 200) : ("[" + msg_type + "]"),
    msg_count: ((g?.msg_count as number) || 0) + 1,
  }, { onConflict: "group_id" });
}

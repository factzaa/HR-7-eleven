// ============================================================
// Supabase Edge Function: poster-gen
// นิดาร่าง "สเปกโปสเตอร์" เป็น JSON แบบหลายบล็อก — ฝั่งเว็บเอาไปเรนเดอร์เป็น HTML แล้วแปลงเป็น PNG
// ไม่ให้ AI วาดตัวหนังสือไทยเอง (จะเพี้ยน) → AI คิดเนื้อหา/โครง, เราเรนเดอร์ข้อความเอง
//
// kind:
//   steps   = สอนงานแบบแจกแจงขั้นตอน
//   dos     = ควรทำ / ห้ามทำ
//   announce= ประกาศ/แจ้งร้านทุกสาขา (แบบเอกสารสื่อสารปฏิบัติการ)
//   report  = อินโฟกราฟิกสรุปข้อมูล (กราฟแท่ง)
//
// Deploy: supabase functions deploy poster-gen --no-verify-jwt
// secret: GEMINI_API_KEY
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GKEY  = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// สเปกบล็อกที่เว็บเรนเดอร์ได้ (ห้ามคิด type เอง)
const SCHEMA = `{
  "title":     "หัวเรื่องใหญ่ สั้น ทรงพลัง ไม่เกิน 24 ตัวอักษร",
  "subtitle":  "คำขยายหัวเรื่อง ไม่เกิน 40 ตัวอักษร (ว่างได้)",
  "date_note": "แถบวันที่มีผล เช่น 'มีผลตั้งแต่ 13 กรกฎาคม 2569 เป็นต้นไป' (ว่างได้)",
  "accent":    "green | orange | red",
  "blocks": [
    { "type":"notice",   "head":"หัวข้อกล่อง เช่น แจ้งร้านทุกสาขา", "text":"ใจความหลัก 1-2 ประโยค", "note":"วงเล็บข้อยกเว้น/หมายเหตุ (ว่างได้)" },
    { "type":"cause",    "head":"สาเหตุ", "text":"อธิบายเหตุผล 1-3 ประโยค" },
    { "type":"table",    "head":"หัวตาราง เช่น สั่งถุงให้เพียงพอ", "rows":[ {"code":"รหัส/หัวข้อซ้าย","label":"รายละเอียดขวา"} ] },
    { "type":"steps",    "head":"วิธีปฏิบัติ", "items":[ {"head":"ชื่อขั้นตอนสั้น","detail":"อธิบาย 1 ประโยค"} ] },
    { "type":"compare",  "head":"หัวข้อ (ว่างได้)", "left":{"head":"กรณีซ้าย","text":"ทำอย่างไร"}, "right":{"head":"กรณีขวา","text":"ทำอย่างไร"} },
    { "type":"dos",      "dos":["ข้อควรทำ"], "donts":["ข้อห้าม"] },
    { "type":"remember", "text":"บรรทัดย้ำเตือนท้ายโปสเตอร์" }
  ],
  "footer": "บรรทัดปิดท้าย เช่น ทีมงานผู้จัดการ · 7-Eleven"
}`;

const RULES: Record<string, string> = {
  steps:    "โปสเตอร์สอนงาน → ใช้บล็อก notice (สรุปสิ่งที่ต้องทำ) + steps (4-6 ขั้น) + remember · เพิ่ม cause ได้ถ้ามีเหตุผลสำคัญ",
  dos:      "โปสเตอร์ควรทำ/ห้ามทำ → ใช้บล็อก notice + dos (do 3-5, don't 3-5) + remember",
  announce: "เอกสารสื่อสารปฏิบัติการถึงทุกสาขา → ใช้บล็อก notice (แจ้งร้านทุกสาขา) + cause (สาเหตุ) + steps หรือ compare (วิธีปฏิบัติ) + remember · ถ้ามีรหัสสินค้า/รายการให้ใส่บล็อก table",
  report:   "อินโฟกราฟิกสรุปข้อมูล → ห้ามแต่งตัวเลข ใช้เฉพาะที่ให้มา · ใส่บล็อก notice (สรุปภาพรวม) และ remember (ข้อเสนอแนะ) · ระบบจะวาดกราฟแท่งให้เอง",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const password = String(b.password || "");
    const kind  = String(b.kind || "steps");
    const topic = String(b.topic || "").trim();
    const notes = String(b.notes || "").trim();
    const data  = b.data ?? null;

    if (!password) return json({ ok: false, error: "ไม่มีสิทธิ์" }, 401);
    const { data: okPwd } = await sb.rpc("hr_check_password", { p_password: password });
    if (!okPwd) return json({ ok: false, error: "รหัสผ่านไม่ถูกต้อง" }, 401);
    if (!GKEY) return json({ ok: false, error: "ยังไม่ได้ตั้งค่า GEMINI_API_KEY" }, 400);
    if (!topic) return json({ ok: false, error: "ยังไม่ได้ระบุหัวข้อ" }, 400);

    const SYS = "คุณคือฝ่ายสื่อสารปฏิบัติการ (Store Business Operations) ของ 7-Eleven ประเทศไทย หน้าที่คือร่างเนื้อหาโปสเตอร์/เอกสารสื่อสารถึงร้านสาขา สำหรับติดร้านและส่งในไลน์กลุ่มพนักงาน\n"
      + "กติกา:\n"
      + "1) ตอบเป็น JSON ล้วนตาม schema เท่านั้น ห้ามมี markdown หรือคำอธิบายนอก JSON\n"
      + "2) ใช้เฉพาะ block type ที่ระบุใน schema · เรียงบล็อกตามลำดับที่ควรอ่าน · รวมกันไม่เกิน 5 บล็อก\n"
      + "3) ภาษาไทยล้วน สั้น กระชับ เป็นคำสั่งลงมือทำได้จริงหน้าร้าน · ห้ามยาวเกินที่กำหนดในแต่ละฟิลด์\n"
      + "4) accent: มาตรฐาน/ความสะอาด=green · บริการ/โปรโมชัน=orange · ข้อห้าม/ยกเลิก/ความปลอดภัย=red\n"
      + "5) ถ้าไม่มีข้อมูลพอสำหรับบล็อกไหน ให้ตัดบล็อกนั้นออก อย่าแต่งข้อมูลเอง (โดยเฉพาะรหัสสินค้า/ตัวเลข)\n\n"
      + "โจทย์ประเภทนี้: " + (RULES[kind] || RULES.steps)
      + "\n\nschema:\n" + SCHEMA;

    const userText = "หัวข้อ: " + topic
      + (notes ? "\nรายละเอียด/ข้อมูลจริงจากผู้จัดการ (ใช้ให้ครบ ห้ามแต่งเพิ่ม): " + notes : "")
      + (data ? "\nข้อมูลตัวเลขจริง (ห้ามแก้ตัวเลข): " + JSON.stringify(data) : "");

    const body = {
      system_instruction: { parts: [{ text: SYS }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { temperature: 0.45, maxOutputTokens: 1800, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
    };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GKEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ ok: false, error: "เรียก Gemini ไม่สำเร็จ", raw: j }, 502);

    const raw = ((j.candidates?.[0]?.content?.parts) || []).map((p: any) => p.text || "").join("").trim();
    let spec: any = null;
    try { spec = JSON.parse(raw); } catch (_e) {
      const m = raw.match(/\{[\s\S]*\}/); if (m) { try { spec = JSON.parse(m[0]); } catch (_e2) { /* ข้าม */ } }
    }
    if (!spec) return json({ ok: false, error: "อ่านผลลัพธ์ AI ไม่ได้", raw }, 502);

    const OK_TYPES = ["notice", "cause", "table", "steps", "compare", "dos", "remember"];
    spec.kind      = kind;
    spec.title     = String(spec.title || topic).slice(0, 40);
    spec.subtitle  = String(spec.subtitle || "").slice(0, 60);
    spec.date_note = String(spec.date_note || "").slice(0, 60);
    spec.accent    = ["green", "orange", "red"].includes(spec.accent) ? spec.accent : "green";
    spec.footer    = String(spec.footer || "ทีมงานผู้จัดการ · 7-Eleven").slice(0, 60);
    spec.blocks    = (Array.isArray(spec.blocks) ? spec.blocks : []).filter((bl: any) => bl && OK_TYPES.includes(bl.type)).slice(0, 5);
    if (kind === "report" && data && Array.isArray((data as any).bars)) {
      spec.bars = (data as any).bars.slice(0, 8);
      spec.unit = (data as any).unit || "";
    }
    return json({ ok: true, spec });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});

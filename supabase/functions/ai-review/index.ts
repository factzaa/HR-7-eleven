// ============================================================
// Supabase Edge Function: ai-review
// AI ช่วย ผจก./HR ตรวจงาน — ดูรูปที่พนักงานส่ง + อิง "เหตุผลตีกลับจริง" ของงานนั้น
// แล้วให้คำแนะนำการตรวจ (คนยังกดตัดสินเอง — advisory เท่านั้น)
// ยืนยันรหัส HR ก่อน · ใช้ secret GEMINI_API_KEY (ตัวเดียวกับนิดา)
// Deploy: supabase functions deploy ai-review --no-verify-jwt
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GKEY  = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// ยืนยันตัวตน: HR (รหัสผ่าน) หรือ ผจก. (รหัสพนักงาน + PIN) — โหมด ผจก. ไม่มีรหัส HR จึงต้องรองรับ 2 ทาง
async function authOK(b: any): Promise<boolean> {
  if (b.password) {
    const { data } = await sb.rpc("hr_check_password", { p_password: String(b.password) });
    if (data === true) return true;
  }
  if (b.mgr_emp && b.mgr_pin) {
    try {
      const { data } = await sb.rpc("mgr_login", { p_emp_id: String(b.mgr_emp), p_pin: String(b.mgr_pin) });
      const row = Array.isArray(data) ? data[0] : data;
      if (row && row.branch_id) return true;
    } catch (_e) { /* ข้าม */ }
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    if (!(await authOK(b))) return json({ ok: false, error: "ไม่มีสิทธิ์ (รหัสผ่าน HR หรือ PIN ผจก. ไม่ถูกต้อง)" }, 401);
    if (!GKEY) return json({ ok: false, error: "ยังไม่ได้ตั้งค่า GEMINI_API_KEY" }, 400);

    const title = String(b.title || "").trim();
    const photos: string[] = (Array.isArray(b.photos) ? b.photos : []).filter((u: any) => typeof u === "string" && /^https?:\/\//.test(u));
    if (!photos.length) return json({ ok: false, error: "ไม่มีรูปให้ AI ดู" }, 400);

    // อิง "เหตุผลตีกลับจริง" ของงานชื่อเดียวกัน (ให้คำแนะนำตรงมาตรฐานร้าน)
    let reasons: string[] = [];
    if (title) {
      try {
        const { data } = await sb.from("task_assignments").select("review_note,reviewed_at").eq("title", title).eq("status", "sent_back").not("review_note", "is", null).order("reviewed_at", { ascending: false }).limit(15);
        reasons = [...new Set((data || []).map((x: any) => String(x.review_note || "").trim()).filter(Boolean))].slice(0, 8);
      } catch (_e) { /* ข้าม */ }
    }

    // โหลดรูป (สูงสุด 4) → base64
    const imgs: { mime: string; data: string }[] = [];
    for (const u of photos.slice(0, 4)) {
      try {
        const rr = await fetch(u); if (!rr.ok) continue;
        const mime = rr.headers.get("content-type") || "image/jpeg";
        const buf = new Uint8Array(await rr.arrayBuffer()); if (buf.length > 5 * 1024 * 1024) continue;
        let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        imgs.push({ mime, data: btoa(bin) });
      } catch (_e) { /* ข้ามรูปที่โหลดไม่ได้ */ }
    }
    if (!imgs.length) return json({ ok: false, error: "โหลดรูปไม่สำเร็จ" }, 502);

    const prompt = "คุณเป็นผู้ช่วยตรวจงานหน้าร้านสะดวกซื้อ (7-Eleven) ช่วยผู้จัดการตรวจงานที่พนักงานถ่ายรูปส่งมา\n"
      + "งานที่ตรวจ: \"" + (title || "งานหน้าร้าน") + "\"\n"
      + (reasons.length ? ("จุดที่งานนี้เคยถูกตีกลับบ่อย (ใช้เป็นเกณฑ์): \n- " + reasons.join("\n- ") + "\n") : "")
      + "\nดูรูปที่แนบมา แล้วตอบสั้น ๆ เป็นข้อ ๆ ภาษาไทย:\n"
      + "1) รูปใช้ตรวจได้ไหม (ชัด/ตรงงานหรือไม่ — ถ้าเบลอ/ถ่ายเพดาน/ไม่ตรงงาน ให้บอกว่าควรถ่ายใหม่)\n"
      + "2) ประเมินตามเกณฑ์ทีละข้อ (✓ ผ่าน / ⚠️ ควรดู / ✗ ไม่ผ่าน) พร้อมเหตุผลสั้น\n"
      + "3) สรุปคำแนะนำถึงผู้จัดการ: \"น่าจะผ่าน\" หรือ \"ควรตีกลับ\" + จุดที่ต้องแก้\n"
      + "ย้ำ: นี่เป็นคำแนะนำช่วยตัดสิน ผู้จัดการเป็นผู้ตัดสินสุดท้าย ห้ามฟันธงเด็ดขาด";

    const parts: any[] = imgs.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } }));
    parts.push({ text: prompt });
    const body = { contents: [{ role: "user", parts }], generationConfig: { temperature: 0.2, maxOutputTokens: 900, thinkingConfig: { thinkingBudget: 0 } } };

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GKEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ ok: false, error: "เรียก Gemini ไม่สำเร็จ", raw: j }, 502);
    const text = ((j.candidates?.[0]?.content?.parts) || []).map((p: any) => p.text || "").join("").trim();
    return json({ ok: true, advice: text || "(ไม่มีผลวิเคราะห์)", used_reasons: reasons.length });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});

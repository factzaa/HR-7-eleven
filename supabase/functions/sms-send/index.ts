// ============================================================
// Supabase Edge Function: sms-send
// ส่ง SMS ผ่าน deeSMSX (นัดสัมภาษณ์ผู้สมัครงาน)
// ยืนยันรหัส HR ก่อนส่ง (กันเรียกมั่ว เพราะ SMS มีค่าใช้จ่าย)
// Deploy: supabase functions deploy sms-send --no-verify-jwt
// Secrets:
//   supabase secrets set DEESMSX_API_KEY=xxxx
//   supabase secrets set DEESMSX_SECRET_KEY=xxxx      (หยิบจากเมนู SMS API ของ deeSMSX)
//   supabase secrets set DEESMSX_SENDER=HR-MPALL      (Sender Name ที่อนุมัติแล้ว)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API_KEY    = Deno.env.get("DEESMSX_API_KEY") ?? "";
const SECRET_KEY = Deno.env.get("DEESMSX_SECRET_KEY") ?? "";
const SENDER     = Deno.env.get("DEESMSX_SENDER") ?? "";
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// เบอร์ไทยรูปแบบท้องถิ่น 0XXXXXXXXX (ไว้ตรวจความถูกต้อง)
function normThaiPhone(p: string): string {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("66")) d = "0" + d.slice(2);
  if (!d.startsWith("0") && d.length === 9) d = "0" + d;
  return d;
}
// แปลงเป็นรูปแบบที่ deeSMSX ต้องการ: 66XXXXXXXXX (ตัด 0 นำหน้าออก เติม 66)
function toDeesmsx(local: string): string {
  return "66" + local.replace(/^0/, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));

    // ยืนยันรหัส HR (ใช้ RPC เดียวกับหน้า login)
    const { data: okPw } = await sb.rpc("hr_check_password", { p_password: b.password || "" });
    if (okPw !== true) return json({ ok: false, error: "รหัสผ่าน HR ไม่ถูกต้อง" }, 401);

    if (!API_KEY || !SECRET_KEY || !SENDER) return json({ ok: false, error: "ยังไม่ได้ตั้งค่า deeSMSX (API key / secret key / sender)" }, 400);

    const local = normThaiPhone(b.to);
    const msg = String(b.msg || "").trim();
    if (!/^0\d{8,9}$/.test(local)) return json({ ok: false, error: "เบอร์ผู้รับไม่ถูกต้อง: " + (b.to || "") }, 400);
    if (!msg) return json({ ok: false, error: "ไม่มีข้อความ" }, 400);
    const to = toDeesmsx(local);   // ★ deeSMSX ต้องการรูปแบบ 66XXXXXXXXX

    // ส่งผ่าน deeSMSX v1
    let out: any = {};
    let ok = false;
    try {
      const res = await fetch("https://apicall.deesmsx.com/v1/SMSWebService", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secretKey: SECRET_KEY, apiKey: API_KEY, to, sender: SENDER, msg }),
      });
      out = await res.json().catch(() => ({}));
      // deeSMSX: error === "0" = สำเร็จ · เผื่อรูปแบบอื่นด้วย
      ok = res.ok && (String(out.error) === "0" || out.status === "success" || out.code === 0 || out.code === "0");
    } catch (e) {
      return json({ ok: false, error: "เรียก deeSMSX ไม่สำเร็จ: " + String((e as any)?.message || e) }, 502);
    }

    // บันทึกสถานะที่ผู้สมัคร (ถ้าส่งมา applicant_id)
    if (b.applicant_id) {
      try { await sb.from("applicants").update({ sms_sent_at: new Date().toISOString(), sms_status: ok ? "sent" : "failed" }).eq("id", b.applicant_id); } catch (_e) { /* ไม่ให้พังการส่ง */ }
    }

    if (!ok) return json({ ok: false, error: (out.msg || out.message || "ส่ง SMS ไม่สำเร็จ"), raw: out }, 400);
    return json({ ok: true, credit: out.creditbalance ?? out.credit_balance ?? out.credit ?? null, raw: out });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});

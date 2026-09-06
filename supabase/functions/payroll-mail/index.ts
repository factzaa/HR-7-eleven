// ============================================================
// Supabase Edge Function: payroll-mail
// ส่งสลิปเงินเดือนทางอีเมลผ่าน Resend — ส่งทีละคน (ฝั่ง client วนเรียกทีละคน)
// รับ HTML สลิป + PDF (base64) จาก client แล้วส่งผ่าน Resend + เขียนสถานะกลับ payroll_items
// ยืนยันสิทธิ์ด้วยรหัส HR (hr_check_password) กันคนนอกยิงส่งอีเมล
// Deploy: supabase functions deploy payroll-mail --no-verify-jwt
// ต้องตั้ง secret: RESEND_API_KEY
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY   = Deno.env.get("RESEND_API_KEY") ?? "";
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function setStatus(run_id: string, emp_id: string, patch: Record<string, unknown>) {
  try {
    if (run_id && emp_id) await sb.from("payroll_items").update(patch).eq("run_id", run_id).eq("emp_id", emp_id);
  } catch (_e) { /* ไม่ให้การเขียนสถานะพังการส่ง */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  try {
    const b = await req.json().catch(() => ({}));

    // 1) ยืนยันรหัส HR
    const { data: okPass } = await sb.rpc("hr_check_password", { p_password: String(b.password || "") });
    if (!okPass) return json({ ok: false, error: "รหัส HR ไม่ถูกต้อง" }, 401);

    // 2) ต้องมี RESEND_API_KEY
    if (!RESEND_KEY) return json({ ok: false, error: "ยังไม่ได้ตั้งค่า RESEND_API_KEY ในระบบ (Supabase secrets)" }, 400);

    const run_id = String(b.run_id || "");
    const emp_id = String(b.emp_id || "");
    const to = String(b.to || "").trim();

    // 3) ไม่มีอีเมล → บันทึกสถานะแล้วจบ
    if (!to) {
      await setStatus(run_id, emp_id, { mail_status: "no_email", mail_error: null });
      return json({ ok: false, reason: "no_email", message: "พนักงานคนนี้ยังไม่มีอีเมล" });
    }

    const from = String(b.from || "onboarding@resend.dev").trim();
    const fromName = String(b.from_name || "ฝ่ายบุคคล").trim();

    const payload: Record<string, unknown> = {
      from: `${fromName} <${from}>`,
      to: [to],
      subject: String(b.subject || "สลิปเงินเดือน"),
      html: String(b.html || ""),
    };
    if (b.pdf_base64) {
      payload.attachments = [{ filename: String(b.filename || "payslip.pdf"), content: String(b.pdf_base64) }];
    }

    // 4) ส่งผ่าน Resend
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({} as any));

    if (!r.ok) {
      const err = String((j && (j.message || j.error || j.name)) || ("HTTP " + r.status)).slice(0, 300);
      await setStatus(run_id, emp_id, { mail_status: "failed", mail_error: err });
      return json({ ok: false, error: err }, 502);
    }

    await setStatus(run_id, emp_id, {
      mail_status: "sent",
      mailed_at: new Date().toISOString(),
      mail_msg_id: (j && j.id) || null,
      mail_error: null,
    });
    return json({ ok: true, id: (j && j.id) || null });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});

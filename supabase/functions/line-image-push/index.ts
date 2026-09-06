// ============================================================
// Supabase Edge Function: line-image-push
// ส่ง "รูปภาพ" (โปสเตอร์/อินโฟกราฟิก) เข้ากลุ่ม LINE ของสาขา
// body: { password, image_url, branch_ids?: string[]  // ว่าง = ทุกสาขาที่ตั้ง line_group_id ไว้
//         text?: string }                              // ข้อความนำ (ถ้ามี จะส่งก่อนรูป)
// Deploy: supabase functions deploy line-image-push --no-verify-jwt
// secret: LINE_CHANNEL_TOKEN
// หมายเหตุ LINE: image ต้องเป็น https + jpeg/png · ≤10MB · preview ≤1MB
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LINE_TOKEN   = Deno.env.get("LINE_CHANNEL_TOKEN") ?? "";
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const password = String(b.password || "");
    const imageUrl = String(b.image_url || "").trim();
    const text     = String(b.text || "").trim();
    const wanted: string[] = Array.isArray(b.branch_ids) ? b.branch_ids.map(String) : [];

    if (!password) return json({ ok: false, error: "ไม่มีสิทธิ์" }, 401);
    const { data: okPwd } = await sb.rpc("hr_check_password", { p_password: password });
    if (!okPwd) return json({ ok: false, error: "รหัสผ่านไม่ถูกต้อง" }, 401);
    if (!LINE_TOKEN) return json({ ok: false, error: "ยังไม่ได้ตั้งค่า LINE_CHANNEL_TOKEN" }, 400);
    if (!/^https:\/\//i.test(imageUrl)) return json({ ok: false, error: "image_url ต้องเป็น https" }, 400);

    const { data: brs } = await sb.from("branches").select("branch_id,name,line_group_id").not("line_group_id", "is", null);
    let targets = (brs ?? []).filter((x: any) => String(x.line_group_id || "").trim());
    if (wanted.length) targets = targets.filter((x: any) => wanted.includes(String(x.branch_id)));
    if (!targets.length) return json({ ok: false, error: "ไม่พบสาขาที่ตั้งค่า LINE Group ID" }, 400);

    const messages: any[] = [];
    if (text) messages.push({ type: "text", text: text.slice(0, 900) });
    messages.push({ type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl });

    const results: any[] = [];
    for (const t of targets) {
      try {
        const r = await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + LINE_TOKEN },
          body: JSON.stringify({ to: t.line_group_id, messages }),
        });
        const ok = r.ok;
        const detail = ok ? "" : await r.text().catch(() => "");
        results.push({ branch_id: t.branch_id, name: t.name, ok, detail: detail.slice(0, 200) });
      } catch (e) {
        results.push({ branch_id: t.branch_id, name: t.name, ok: false, detail: String((e as any)?.message || e) });
      }
    }
    const sent = results.filter((r) => r.ok).length;
    return json({ ok: sent > 0, sent, total: results.length, results });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});

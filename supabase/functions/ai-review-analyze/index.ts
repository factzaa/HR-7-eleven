// ============================================================
// Supabase Edge Function: ai-review-analyze
// ขุดประวัติการตรวจงานจริง (ผ่าน/ตีกลับ + เหตุผล) ต่อหัวข้องาน
// แล้วให้ Gemini สรุปเป็น "เกณฑ์ตรวจ + จุดพลาดบ่อย + AI ตรวจได้แค่ไหน"
// ยืนยันรหัส HR ก่อน · ใช้ secret GEMINI_API_KEY (ตัวเดียวกับนิดา)
// Deploy: supabase functions deploy ai-review-analyze --no-verify-jwt
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GKEY  = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function pushGroup(map: any, topic: string, status: string, note: string | null) {
  const g = map[topic] || (map[topic] = { topic, total: 0, approved: 0, sent_back: 0, reasons: {} as Record<string, number> });
  g.total++;
  if (status === "approved") g.approved++;
  else if (status === "sent_back" || status === "rejected") {
    g.sent_back++;
    const n = String(note || "").trim();
    if (n) g.reasons[n] = (g.reasons[n] || 0) + 1;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const { data: okPw } = await sb.rpc("hr_check_password", { p_password: b.password || "" });
    if (okPw !== true) return json({ ok: false, error: "รหัสผ่าน HR ไม่ถูกต้อง" }, 401);
    if (!GKEY) return json({ ok: false, error: "ยังไม่ได้ตั้งค่า GEMINI_API_KEY" }, 400);

    const map: any = {};
    // งานในกะ
    try {
      const { data: ta } = await sb.from("task_assignments").select("title,status,review_note").in("status", ["approved", "sent_back"]).limit(1500);
      (ta || []).forEach((t: any) => pushGroup(map, "งานในกะ: " + (t.title || "-"), t.status, t.review_note));
    } catch (_e) { /* ข้าม */ }
    // เชลฟ์ประจำเดือน
    try {
      const [scR, shR] = await Promise.all([
        sb.from("shelf_checks").select("shelf_id,status,review_note").in("status", ["approved", "sent_back"]).limit(1500),
        sb.from("shelves").select("id,name"),
      ]);
      const shName: Record<string, string> = {}; (shR.data || []).forEach((s: any) => (shName[s.id] = s.name));
      (scR.data || []).forEach((c: any) => pushGroup(map, "เชลฟ์: " + (shName[c.shelf_id] || ("#" + c.shelf_id)), c.status, c.review_note));
    } catch (_e) { /* ข้าม */ }
    // งานพิเศษ
    try {
      const { data: sa } = await sb.from("special_task_assignees").select("task_id,status,review_note").in("status", ["approved", "sent_back"]).limit(1500);
      const ids = [...new Set((sa || []).map((x: any) => x.task_id))];
      const stName: Record<string, string> = {};
      if (ids.length) { const { data: st } = await sb.from("special_tasks").select("id,title").in("id", ids); (st || []).forEach((s: any) => (stName[s.id] = s.title)); }
      (sa || []).forEach((x: any) => pushGroup(map, "งานพิเศษ: " + (stName[x.task_id] || "-"), x.status, x.review_note));
    } catch (_e) { /* ข้าม */ }

    const groups = Object.values(map).map((g: any) => ({
      topic: g.topic, total: g.total, approved: g.approved, sent_back: g.sent_back,
      reject_rate: g.total ? Math.round((g.sent_back / g.total) * 100) : 0,
      top_reasons: Object.entries(g.reasons).sort((a: any, b: any) => b[1] - a[1]).slice(0, 15).map(([note, n]) => ({ note, count: n })),
    })).filter((g: any) => g.total > 0).sort((a: any, b: any) => b.total - a.total).slice(0, 25);

    if (!groups.length) return json({ ok: true, summary: "ยังไม่มีประวัติการตรวจ (ผ่าน/ตีกลับ) มากพอจะวิเคราะห์ — ให้ ผจก./HR ตรวจงานสักระยะก่อน แล้วลองใหม่", stats: [] });

    const prompt = "คุณเป็นผู้เชี่ยวชาญออกแบบเกณฑ์ตรวจงานหน้าร้านสะดวกซื้อ (7-Eleven)\n"
      + "ด้านล่างคือสรุปประวัติการตรวจงานจริง (ต่อหัวข้องาน) พร้อม 'เหตุผลที่พนักงานถูกตีกลับ' และจำนวนครั้ง:\n\n"
      + JSON.stringify(groups, null, 1)
      + "\n\nสำหรับแต่ละหัวข้องาน ช่วยทำ 3 อย่างสั้นๆ:\n"
      + "1) เกณฑ์ตรวจ (checklist) 3-6 ข้อที่ควรใช้ อิงจากเหตุผลตีกลับจริง\n"
      + "2) จุดที่พนักงานพลาดบ่อยที่สุด 1-3 ข้อ\n"
      + "3) ประเมินว่า 'AI ตรวจจากรูปถ่ายได้แค่ไหน' (ง่าย/ปานกลาง/ยาก) พร้อมเหตุผล 1 บรรทัด\n\n"
      + "ปิดท้ายด้วยข้อเสนอแนะรวมว่า 'ควรเริ่มให้ AI ช่วยตรวจหัวข้อไหนก่อน' (ที่คุ้มและแม่นสุด)\n"
      + "ตอบภาษาไทย กระชับ อ่านง่าย จัดหัวข้อชัดเจนด้วยหัวข้อ/เลขข้อ (ห้ามใช้ตาราง)";

    const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 2400, thinkingConfig: { thinkingBudget: 0 } } };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GKEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ ok: false, error: "เรียก Gemini ไม่สำเร็จ", raw: j }, 502);
    const text = ((j.candidates?.[0]?.content?.parts) || []).map((p: any) => p.text || "").join("").trim();
    return json({ ok: true, summary: text || "(ไม่มีผลวิเคราะห์)", stats: groups });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});

// ============================================================
// Supabase Edge Function: poster-art
// สร้าง "ภาพประกอบ" สำหรับโปสเตอร์ด้วย Gemini (โมเดลรูปภาพ)
// สำคัญ: บังคับให้เป็นภาพล้วน "ห้ามมีตัวอักษรใด ๆ" — ตัวหนังสือไทยให้เว็บเรนเดอร์เอง (ไม่งั้นเพี้ยน)
//
// body: { password, prompt, style? ('cartoon'|'flat'|'photo'), aspect? ('square'|'portrait') }
// คืน: { ok, image: "data:image/png;base64,..." }
//
// Deploy: supabase functions deploy poster-art --no-verify-jwt
// secrets: GEMINI_API_KEY · (ปรับโมเดลได้ด้วย GEMINI_IMAGE_MODEL, ค่าเริ่มต้น gemini-2.5-flash-image)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GKEY  = Deno.env.get("GEMINI_API_KEY") ?? "";
const IMODEL = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-2.5-flash-image";
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const STYLE: Record<string, string> = {
  cartoon: "friendly 3D cartoon illustration, clean vector-like shading, cheerful",
  flat:    "flat vector illustration, simple shapes, minimal, corporate infographic style",
  photo:   "clean product photography style, softbox lighting, plain background",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const password = String(b.password || "");
    const prompt   = String(b.prompt || "").trim();
    const style    = String(b.style || "cartoon");
    const aspect   = String(b.aspect || "square");

    if (!password) return json({ ok: false, error: "ไม่มีสิทธิ์" }, 401);
    const { data: okPwd } = await sb.rpc("hr_check_password", { p_password: password });
    if (!okPwd) return json({ ok: false, error: "รหัสผ่านไม่ถูกต้อง" }, 401);
    if (!GKEY) return json({ ok: false, error: "ยังไม่ได้ตั้งค่า GEMINI_API_KEY" }, 400);
    if (!prompt) return json({ ok: false, error: "ยังไม่ได้ระบุสิ่งที่จะให้วาด" }, 400);

    const full = [
      `Illustration for an internal staff poster of a Thai convenience store (7-Eleven style).`,
      `Subject: ${prompt}.`,
      `Style: ${STYLE[style] || STYLE.cartoon}. Brand palette: green #008061, orange #f68121, red #ee3124, white background.`,
      aspect === "portrait" ? `Composition: vertical portrait framing.` : `Composition: square framing, subject centered.`,
      `CRITICAL: absolutely NO text, NO letters, NO words, NO numbers, NO logos, NO signage, NO captions anywhere in the image. Pure illustration only.`,
      `Isolated on a clean white or transparent-looking background so it can be placed on a poster.`,
    ].join(" ");

    const body = {
      contents: [{ role: "user", parts: [{ text: full }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${IMODEL}:generateContent?key=${GKEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j?.error?.message) || "เรียกโมเดลรูปภาพไม่สำเร็จ";
      return json({ ok: false, error: msg + " (โมเดล: " + IMODEL + " — ตั้งค่าใหม่ได้ที่ secret GEMINI_IMAGE_MODEL)", raw: j }, 502);
    }

    const parts = j.candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p: any) => p.inlineData?.data || p.inline_data?.data);
    const inline = img?.inlineData || img?.inline_data;
    if (!inline?.data) return json({ ok: false, error: "โมเดลไม่ได้คืนรูปภาพมา", raw: j }, 502);

    const mime = inline.mimeType || inline.mime_type || "image/png";
    return json({ ok: true, image: `data:${mime};base64,${inline.data}` });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});

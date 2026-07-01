// ============================================================
// 7-Eleven HR — ลบรูปเก่าเกินกำหนด (Storage retention)
// ลบเฉพาะ: รูปเช็กอิน (bucket attendance-photos) + รูปส่งงาน/รับส่งผลัด (employee-docs/task, employee-docs/handover)
// *** ไม่แตะเอกสารโปรไฟล์ (สำเนาบัตร/บัญชี/ทะเบียนบ้าน/วุฒิ) ***
// ตั้งอายุเก็บผ่าน env RETENTION_DAYS (ดีฟอลต์ 90 วัน)
// Deploy เป็น Edge Function ชื่อ "storage-cleanup" + ตั้ง cron วันละครั้ง (storage_cleanup_cron.sql)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RETENTION_DAYS = Number(Deno.env.get("RETENTION_DAYS") ?? "90");

Deno.serve(async () => {
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
    let removed = 0, scanned = 0;

    // ไล่ลบไฟล์เก่าในโฟลเดอร์ (ลงลึกได้ตาม depth) — โฟลเดอร์ใน Supabase = item ที่ id === null
    async function purge(bucket: string, prefix: string, depth: number) {
      let offset = 0;
      while (true) {
        const { data, error } = await sb.storage.from(bucket).list(prefix, {
          limit: 100, offset, sortBy: { column: "name", order: "asc" },
        });
        if (error || !data || !data.length) break;
        const toDel: string[] = [];
        for (const it of data as any[]) {
          const path = prefix ? `${prefix}/${it.name}` : it.name;
          const isFolder = it.id === null || it.id === undefined;
          if (isFolder) {
            if (depth > 0) await purge(bucket, path, depth - 1);
          } else {
            scanned++;
            const ts = it.created_at || it.updated_at || (it.metadata && it.metadata.lastModified) || 0;
            const created = new Date(ts).getTime();
            if (created && created < cutoff) toDel.push(path);
          }
        }
        if (toDel.length) {
          const { error: de } = await sb.storage.from(bucket).remove(toDel);
          if (!de) removed += toDel.length;
        }
        if (data.length < 100) break;
        offset += 100;
      }
    }

    await purge("attendance-photos", "", 2);   // โครงสร้าง: empId/ วันที่.jpg
    await purge("employee-docs", "task", 1);     // รูปส่งงาน
    await purge("employee-docs", "handover", 1); // รูปรับส่งผลัด

    return json({ ok: true, removed, scanned, retention_days: RETENTION_DAYS });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

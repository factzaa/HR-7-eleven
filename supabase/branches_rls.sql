-- ============================================================
-- แก้ RLS ตาราง branches ให้ "เพิ่ม/แก้ไข/ลบ" ได้ (จากหน้า HR)
-- อาการเดิม: "new row violates row-level security policy for table branches"
-- เพราะ branches มี policy แค่ select (อ่านอย่างเดียว)
-- รันบน Supabase: Dashboard > SQL Editor > วาง > Run (รันซ้ำได้)
--
-- หมายเหตุ: เฟสนี้ยังเปิดกว้างให้ anon ตามแนวทางเดิม (Phase 4 ค่อยรัดกุมด้วย Auth)
-- ============================================================

alter table public.branches enable row level security;

-- ลบ policy อ่านอย่างเดียวเดิม แล้วเปิดให้อ่าน+เขียนทั้งหมด
drop policy if exists anon_read_branches on public.branches;
drop policy if exists anon_rw_branches   on public.branches;
create policy anon_rw_branches on public.branches
  for all to anon, authenticated
  using (true) with check (true);

-- ตรวจผล
select branch_id, name, radius_m from public.branches order by branch_id;

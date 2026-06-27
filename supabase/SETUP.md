# คู่มือติดตั้ง Supabase — 7-Eleven HR System

## ขั้นที่ 1 — สร้างโปรเจกต์
1. ไปที่ https://supabase.com → Sign in → **New project**
2. ตั้งชื่อ เช่น `7eleven-hr` เลือก Region ที่ใกล้ (Singapore) ตั้งรหัส database แล้วรอสร้างเสร็จ ~2 นาที

## ขั้นที่ 2 — สร้างตาราง
1. เมนูซ้าย **SQL Editor** → **New query**
2. คัดลอกเนื้อหา `schema.sql` ทั้งหมดมาวาง → กด **Run**
3. ทำซ้ำกับ `seed.sql` (ข้อมูลตัวอย่าง) แล้ว `functions.sql` (ฟังก์ชันคำนวณ)

ตรวจผลที่เมนู **Table Editor** ควรเห็นตาราง: shifts, branches, employees, attendance, warnings, leaves, holidays, app_config

## ขั้นที่ 3 — สร้าง Storage สำหรับรูป
1. เมนู **Storage** → **New bucket**
2. สร้าง 2 buckets ตั้งเป็น **Public**:
   - `employee-photos` — รูปโปรไฟล์พนักงาน
   - `attendance-photos` — รูปตอนเช็กอิน
   > (Public เพื่อให้ HR เปิดดูรูปได้ง่ายในเฟสแรก ภายหลังปรับเป็น signed URL ได้)

## ขั้นที่ 4 — เอา Key มาใส่ในเว็บ
1. เมนู **Project Settings** (เฟือง) → **API**
2. คัดลอก 2 ค่า:
   - **Project URL** (เช่น `https://xxxx.supabase.co`)
   - **anon public** key
3. เปิดไฟล์ `shared/config.js` แล้วใส่ค่าทั้งสองลงไป

## ขั้นที่ 5 — รัน RLS (ความปลอดภัย) — ทำตอนพร้อม
ดูไฟล์ `rls.sql` (ผมจะสร้างให้ใน Phase 4) — เฟสแรกยังไม่เปิด RLS เพื่อให้พัฒนาง่ายก่อน

---

## หมายเหตุความปลอดภัย
- รหัส HR เริ่มต้น `admin1234` (อยู่ในตาราง `app_config`) — เปลี่ยนได้ที่ Table Editor
- anon key เปิดเผยใน frontend ได้ตามปกติ แต่ความปลอดภัยจริงต้องพึ่ง **RLS** (Phase 4)
- ข้อมูลอ่อนไหว (เลขบัตร/บัญชี) — ดูแผนหลักหัวข้อ §7

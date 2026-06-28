# บันทึกความคืบหน้า — ระบบ HR 7-Eleven (Supabase)

อัปเดตล่าสุด: 27 มิ.ย. 2026

## สถานะปัจจุบัน: ใช้งานได้แล้วทั้ง 2 หน้า ✅
ย้ายออกจาก Google Apps Script มาเป็น Supabase ครบ ทดสอบผ่านจริง (เช็กอิน → ข้อมูลขึ้น HR dashboard)

## ทำเสร็จแล้ว
- **Phase 0** — ฐานข้อมูล Supabase: 8 ตาราง + ฟังก์ชัน + RLS policies + Storage 2 buckets
- **Phase 1** — หน้าลงเวลาพนักงาน (`employee/index.html`): กล้อง + จดจำใบหน้า + GPS + เช็กอิน/เอาท์
- **Phase 2** — หน้า HR (`hr/index.html`): ครบ 5 แท็บ (Dashboard, พนักงาน, รายงาน, วินัย&ใบเตือน, ลา&วันหยุด)
- **ฟีเจอร์เสริม** — ปุ่ม "สถานะของฉัน" หน้าพนักงาน (ดูสถิติวินัยตนเองตามรหัส, ไม่แสดง OT)
- ปรับปุ่มสถานะ/ลงทะเบียนใบหน้าให้เป็นปุ่มชัดเจน (มีไอคอน ขอบ)

## โครงไฟล์
```
HR-7-eleven-main/
├── employee/index.html    # หน้าลงเวลาพนักงาน
├── hr/index.html          # หน้า HR (รหัสผ่าน: admin1234)
├── shared/
│   ├── config.js          # URL + anon key ของ Supabase (ตั้งค่าแล้ว)
│   ├── supabase.js        # ชั้นเชื่อมต่อ + selfStatus
│   └── hr-api.js          # backend หน้า HR (ทุก action)
├── supabase/              # ไฟล์ SQL (รันบน Supabase หมดแล้ว)
│   ├── schema.sql · seed.sql · functions.sql
│   ├── policies.sql · storage_policies.sql
│   └── SETUP.md
├── README.md              # วิธีรัน
└── แผนพัฒนาระบบบริหารบุคลากร-7Eleven.md   # แผนหลัก
```

## วิธีรันต่อ (ครั้งหน้า)
1. เปิด Command Prompt ที่โฟลเดอร์ `HR-7-eleven-main` (พิมพ์ `cmd` ที่ address bar ของ File Explorer)
2. พิมพ์ `python -m http.server 8000`
3. เปิดเบราว์เซอร์:
   - พนักงาน → http://localhost:8000/employee/
   - HR → http://localhost:8000/hr/  (รหัส `admin1234`)
   > ถ้า cmd เปิดผิดโฟลเดอร์ ให้เติม path: `localhost:8000/Downloads/HR-7-eleven-main/employee/`

## รอบล่าสุด (27 มิ.ย. 2026 — ต่อจากที่ค้าง)
- ✅ ยืนยันเกณฑ์วินัยตรงกัน 2 ไฟล์ (`hr-api.js` / `supabase.js`) — คงเกณฑ์เดิมตามที่ตัดสินใจ
- ✅ เตรียม SQL แก้รัศมี B002 → 20 ม. ที่ `supabase/fix_branch_radius.sql` (ต้องรันบน Supabase)
- ✅ เตรียม deploy GitHub Pages: `index.html` (หน้าเลือกเมนู), `.nojekyll`, `.gitignore`, `DEPLOY-GITHUB.md`
  (path เป็น relative อยู่แล้ว ใช้กับ Pages ได้เลย) — deploy แล้วที่ factzaa.github.io/HR-7-eleven/
- ✅ ทำเป็น PWA ติดตั้งบนมือถือได้: `manifest.webmanifest`, `sw.js`, โฟลเดอร์ `icons/`
  ผูก manifest + meta + register service worker เข้าทั้ง 3 หน้า (index/employee/hr)
  ⚠️ ไฟล์ใหม่เหล่านี้ต้องอัปขึ้น GitHub ด้วย: `manifest.webmanifest`, `sw.js`, `icons/` (ทั้งโฟลเดอร์)
     และอัป `index.html`, `employee/index.html`, `hr/index.html` ทับของเดิม
- ✅ สแตมป์เวลา/สถานที่บนรูปเช็กอิน (หน้า employee): เบิร์น overlay ลงรูปตอนกดเข้างาน
  เนื้อหา: เวลา (ตัวใหญ่) + วันที่ พ.ศ.ย่อ + วันในสัปดาห์ + ชื่อสาขา + พิกัด/ความแม่นยำ
  + ชื่อพนักงาน + สถานะ ในเขต/นอกเขต + ลายน้ำโลโก้ 7-Eleven (แก้ใน capturePhoto/drawStamp)
  เพิ่มความละเอียดรูปจาก 320px → 720px เพื่อให้ตัวอักษรคมชัด
  ⚠️ ต้องอัป employee/index.html ทับบน GitHub

## รอบ 28 มิ.ย. 2026 — จัดการสาขา + ตารางงาน + ไปทำแทนสาขา
- ✅ ตารางใหม่ `schedules` (ตารางเวร) — ไฟล์ `supabase/schedules.sql` (ยังไม่ได้รันบน Supabase)
- ✅ แท็บ "สาขา" 🏪 — CRUD สาขา (ชื่อ/lat/lng/รัศมี) + ปุ่มดึงพิกัด GPS + ลิงก์แผนที่
  API: `hr_branch_list/save/delete` (ลบไม่ได้ถ้ายังมีพนักงาน/ประวัติลงเวลา)
- ✅ แท็บ "ตารางงาน" 🗓️ — กริดรายสัปดาห์ (พนักงาน×7วัน) ตั้งกะ+สาขา, นำทางสัปดาห์, คัดลอกสัปดาห์
  API: `hr_sched_week/save/delete/copy` — ช่องสีส้ม = ไปแทนสาขาอื่น (auto เมื่อสาขา≠สาขาประจำ)
- ✅ ไปทำแทนสาขา: เช็กอินที่สาขาไหนก็ได้ในเขต geofence, ระบบ flag "ไปแทน" อัตโนมัติ (attendance.branch_id ≠ สาขาประจำ)
- ✅ วินัย/ขาดงาน อิงตารางเวร: ถ้ารอบมีตารางเวร → วันควรมา = วันที่จัดเวร, ไม่งั้น fallback weekly_off
- ✅ รายงานเพิ่ม: คอลัมน์ "ไปแทน" + สรุปวันประจำ/วันไปแทนต่อคน + มุมมอง "การไปทำแทนสาขา" รายวัน + export
- ไฟล์ที่แก้: `shared/hr-api.js`, `hr/index.html` · ไฟล์ใหม่: `supabase/schedules.sql`
  ⚠️ ต้องทำ 2 อย่าง: (1) รัน `supabase/schedules.sql` บน Supabase (2) อัป `shared/hr-api.js` + `hr/index.html` ขึ้น GitHub

## รอบ 28 มิ.ย. 2026 (2) — คีย์โค้ดจัดเวร + ตั้งค่ากะ + ลาออนไลน์ + แจ้งเตือน
- ✅ จัดตารางแบบ "คีย์โค้ด": พิมพ์โค้ดย่อในช่อง (1=เช้า 2=บ่าย 3=ดึก D=Delivery) Enter เพื่อบันทึก, ช่องว่าง=วันหยุด, คลิก "ไปแทน" ใต้ช่องเพื่อจัด cover
- ✅ แท็บใหม่ "ตั้งค่ากะ" ⚙️ — เพิ่ม/แก้/ลบกะ: โค้ดคีย์, ชื่อ, เวลาเข้า-ออก, ผ่อนผัน · API hr_shift_list/save/delete
- ✅ หน้าพนักงาน (index): ปุ่ม "ขอลา" + ฟอร์มส่งคำขอ → สถานะ "รออนุมัติ" + ดูสถานะคำขอของตนเอง (HR.requestLeave/myLeaves)
- ✅ HR อนุมัติ/ปฏิเสธใบลา ในแท็บ "ลา & วันหยุด" (ใบลารออนุมัติเด้งขึ้นก่อน) · API hr_leave_status
- ✅ แผงแจ้งเตือนแอดมินบน Dashboard: ใบลารออนุมัติ / คนยังไม่กดออก / มาสายวันนี้ / ขาด-ยังไม่มาตามตาราง · API hr_notifications
- ไฟล์แก้: shared/hr-api.js, hr/index.html, employee/index.html, shared/supabase.js · ไฟล์ใหม่: supabase/shift_codes.sql
  ⚠️ ต้องรัน `supabase/shift_codes.sql` บน Supabase (เพิ่มคอลัมน์ code + กะ D + เปิดสิทธิ์แก้กะ) แล้วอัปไฟล์ที่แก้ขึ้น GitHub

## รอบ 28 มิ.ย. 2026 (3) — โฮม + พนักงานกรอกข้อมูลเอง + ย้ายขอลา
- ✅ ปุ่ม 🏠 หน้าแรก ในหน้า employee, hr, staff (กลับไป landing index)
- ✅ ย้าย "ขอลา" จากหน้า employee ไปไว้ที่ "หน้าแรก" (index.html) แล้ว — มี modal + ดูสถานะคำขอ
- ✅ หน้าใหม่ `staff/index.html` — ลิงก์ส่งให้พนักงานกรอกข้อมูลเอง: กรอกรหัส → กรอกข้อมูลส่วนตัว/บัญชี + อัปเอกสาร 5 ชนิด (รูปถ่าย, สำเนาบัตร, สมุดบัญชี, ทะเบียนบ้าน, วุฒิ) → ส่งเข้าสถานะ "รอตรวจ"
- ✅ แท็บ HR ใหม่ "ข้อมูลรอตรวจ" 📥 — ดูข้อมูล+เปิดเอกสาร, กดอนุมัติ (เขียนเข้า employees) / ปฏิเสธ + เด้งในแผงแจ้งเตือน
- ไฟล์แก้: index.html, employee/index.html, hr/index.html, shared/hr-api.js, shared/supabase.js · ไฟล์ใหม่: staff/index.html, supabase/profile.sql
  ⚠️ ต้องรัน `supabase/profile.sql` (คอลัมน์เอกสาร + ตาราง profile_submissions + bucket employee-docs) แล้วอัปไฟล์ขึ้น GitHub

## รอบ 28 มิ.ย. 2026 (4) — เงื่อนไขการลา
- ✅ พนักงานตรวจสถานะคำขอลาได้ที่หน้าแรก (กรอกรหัส → เห็น รออนุมัติ/อนุมัติ/ปฏิเสธ + เหตุผลถ้าถูกปฏิเสธ)
- ✅ HR ปฏิเสธใบลาต้องระบุเหตุผล (prompt) → เก็บใน leaves.hr_note และพนักงานเห็น
- ✅ แท็บ "ตั้งค่ากะ" เพิ่มตาราง "เงื่อนไขการลา" (ตาราง leave_types): ตั้งลาล่วงหน้าขั้นต่ำ/โควตาต่อปี/ลาย้อนหลัง/ต้องแนบเอกสาร · API hr_leavetype_list/save
- ✅ ตรวจเงื่อนไขตอนพนักงานส่ง: ลาล่วงหน้าไม่พอ/เกินโควตา/ทับวันไปแทนสาขา → บล็อก พร้อมข้อความ
- ✅ ลาป่วยต้องแนบใบรับรองแพทย์ (require_doc) — ฟอร์มขอลาโชว์ช่องแนบรูป, บล็อกถ้าไม่แนบ, HR เปิดดูได้ (📎) เก็บใน leaves.doc_url
- ไฟล์แก้: index.html, hr/index.html, shared/hr-api.js, shared/supabase.js · ไฟล์ใหม่: supabase/leave_rules.sql
  ⚠️ ต้องรัน `supabase/leave_rules.sql` แล้วอัปไฟล์ขึ้น GitHub

## รอบ 28 มิ.ย. 2026 (5) — ตารางงาน: กรองสาขา + ส่งสรุป Line
- ✅ เลือกดูตารางตามสาขา (dropdown กรองพนักงานตามสาขาประจำ)
- ✅ ปุ่ม "คัดลอกข้อความ" — สรุปตารางทั้งสัปดาห์เป็นข้อความ (โค้ดกะต่อวัน + → ไปแทนสาขา) คัดลอกไปวางในกลุ่ม Line
- ✅ ปุ่ม "บันทึก/แชร์รูป (Line)" — render ตารางเป็นรูป PNG แล้วแชร์ผ่าน Web Share (มือถือเด้งเลือก Line ได้) หรือดาวน์โหลด
- หมายเหตุ: LINE Notify ปิดบริการแล้ว + เว็บเป็น static → ยังไม่ทำ auto-push (ถ้าต้องการต้องใช้ LINE Messaging API + backend)
- ไฟล์แก้: hr/index.html เท่านั้น (ไม่มี SQL ใหม่)

## รอบ 28 มิ.ย. 2026 (6) — หน้าระเบียบการทำงาน + รับทราบ
- ✅ หน้าใหม่ `rules/index.html` — แสดงระเบียบข้อบังคับ (โทนเข้ม เน้นวินัย/บทลงโทษ) + ช่องกรอกรหัส + ติ๊กยอมรับ → บันทึกการรับทราบ
- ✅ เพิ่มปุ่ม "📋 ระเบียบการทำงาน" ที่หน้าแรก
- ✅ บันทึกการยอมรับลงตาราง rule_acks (emp_id, version) · แสดงถ้ารหัสนั้นยอมรับแล้ว
- ร่างเอกสารต้นฉบับ: `ระเบียบการทำงาน-ร่าง.md`
- ไฟล์ใหม่: rules/index.html, supabase/rules_ack.sql · แก้: index.html, shared/supabase.js
  ⚠️ ต้องรัน `supabase/rules_ack.sql`

## SQL ที่ต้องรันบน Supabase (รวมทุกรอบที่ยังไม่ได้รัน)
1. `schedules.sql` — ตารางเวร
2. `branches_rls.sql` — ให้เพิ่ม/แก้/ลบสาขาได้
3. `shift_codes.sql` — โค้ดกะ + กะ Delivery + ให้แก้กะได้
4. `profile.sql` — พนักงานกรอกข้อมูล/อัปเอกสารเอง + bucket เอกสาร
5. `leave_rules.sql` — เงื่อนไขการลา + เหตุผลปฏิเสธ + แนบใบรับรองแพทย์
6. `rules_ack.sql` — บันทึกการรับทราบระเบียบ

## ค้างไว้ / จะทำต่อ
**Phase 3 — เก็บรายละเอียดให้สมจริง**
- รัน `supabase/fix_branch_radius.sql` บน Supabase เพื่อ set radius B002 = 20 (ยังไม่ได้รัน)
- เพิ่มข้อมูลพนักงาน/สาขาจริง
- (เกณฑ์ระดับวินัย — คงเดิม ถ้าจะแก้ ต้องแก้ตรงกัน 2 ที่: `hr-api.js` + `supabase.js`)

**Phase 4 — ความปลอดภัย + ขึ้นออนไลน์**
- Deploy ขึ้น GitHub Pages — ไฟล์พร้อมแล้ว ทำตาม `DEPLOY-GITHUB.md` (ยังไม่ได้ push ขึ้น repo)
- เปลี่ยนรหัส HR (ตาราง app_config) จาก admin1234
- รัดกุม RLS + ปกป้องเลขบัตร/บัญชี (PDPA) — ปัจจุบันเปิดกว้างไว้ก่อน
- เพิ่ม Supabase Auth แยกสิทธิ์ HR/พนักงาน

## หมายเหตุเทคนิค
- กล้อง+GPS ต้องรันผ่าน localhost หรือ HTTPS เท่านั้น (เปิดไฟล์ตรงๆ ไม่ได้)
- หลังแก้ไฟล์ .js ให้รีเฟรชแบบ Ctrl+Shift+R (ล้าง cache)
- รอบประเมิน = 21 ถึง 20 ของเดือนถัดไป

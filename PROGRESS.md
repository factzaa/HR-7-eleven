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
  (path เป็น relative อยู่แล้ว ใช้กับ Pages ได้เลย)

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

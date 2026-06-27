# 7-Eleven HR System (เวอร์ชัน Supabase)

ระบบบริหารบุคลากร 2 หน้า เชื่อมฐานข้อมูล Supabase

```
HR-7-eleven-main/
├── employee/index.html   # หน้าลงเวลาพนักงาน (กล้อง+ใบหน้า+GPS)  ← Phase 1 ✅
├── hr/index.html         # หน้า HR dashboard (5 แท็บ)             ← Phase 2 ✅
├── shared/
│   ├── config.js         # ใส่ URL + anon key ของ Supabase
│   ├── supabase.js       # ชั้นเชื่อมต่อกลาง (หน้าลงเวลา)
│   └── hr-api.js         # ชั้น backend หน้า HR (แทน Apps Script)
└── supabase/
    ├── schema.sql        # โครงฐานข้อมูล
    ├── seed.sql          # ข้อมูลตัวอย่าง
    ├── functions.sql     # ฟังก์ชันคำนวณ
    └── SETUP.md          # คู่มือติดตั้ง Supabase
```

## วิธีทดสอบในเครื่อง

กล้องและ GPS ทำงานเฉพาะบน **https หรือ localhost** (เปิดไฟล์แบบดับเบิลคลิก `file://` จะไม่ทำงาน)
ให้รันเว็บเซิร์ฟเวอร์ในเครื่องก่อน:

**ถ้ามี Python:** เปิด Command Prompt/Terminal ที่โฟลเดอร์ `HR-7-eleven-main` แล้วพิมพ์
```
python -m http.server 8000
```
จากนั้นเปิดเบราว์เซอร์ไปที่:
- หน้าลงเวลา → http://localhost:8000/employee/
- หน้า HR → http://localhost:8000/hr/   (เมื่อทำ Phase 2 เสร็จ)

**ถ้าไม่มี Python:** ใช้ VS Code + ส่วนขยาย "Live Server" คลิกขวาที่ไฟล์ index.html → Open with Live Server

## ก่อนทดสอบ ต้องเสร็จ 3 อย่าง
1. รัน schema.sql + seed.sql + functions.sql บน Supabase (ดู supabase/SETUP.md)
2. สร้าง Storage buckets: `employee-photos`, `attendance-photos` (ตั้ง Public)
3. ใส่ URL + anon key ใน `shared/config.js` ✅ (ทำแล้ว)

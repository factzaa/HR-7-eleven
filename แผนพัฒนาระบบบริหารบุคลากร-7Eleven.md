# แผนพัฒนาระบบบริหารบุคลากร 7-Eleven (HR System)

> เอกสารวิเคราะห์ Demo ปัจจุบัน + แผนยกระดับสู่ Supabase
> จัดทำ: 26 มิ.ย. 2026

---

## 1. ภาพรวม: Demo ปัจจุบันทำอะไรได้บ้าง

โปรเจกต์ปัจจุบันมี **2 หน้าเว็บ** ที่เป็นไฟล์ `index.html` ไฟล์เดียวจบในตัว (HTML + CSS + JS อยู่ในไฟล์เดียว) และทั้งคู่ยิงข้อมูลไปที่ **Google Apps Script ตัวเดียวกัน** (`SCRIPT_URL` เดียวกัน) ซึ่งทำหน้าที่เป็น backend อ่าน/เขียน Google Sheets

| หน้า | ไฟล์ | ผู้ใช้ | หน้าที่ |
|------|------|--------|---------|
| **หน้าลงเวลา** | `7-eleven-main/index.html` (381 บรรทัด) | พนักงานหน้าร้าน | เปิดกล้อง → จดจำใบหน้า → เช็ก GPS ว่าอยู่ในรัศมีสาขา → กดเข้างาน/ออกงาน |
| **หน้า HR** | `HR-7-eleven-main/index.html` (1,112 บรรทัด) | ฝ่ายบุคคล | Dashboard, จัดการพนักงาน, รายงานการลงเวลา, ใบเตือน/วินัย, การลา & วันหยุด |

### 1.1 หน้าลงเวลาพนักงาน (Employee Check-in)

ขั้นตอนการทำงาน:

1. โหลด config จาก backend (`?action=config`) → ได้รายชื่อสาขา, กะ, พนักงาน, threshold การจดจำใบหน้า
2. เปิดกล้องหน้า แล้วโหลดโมเดล `face-api.js` (TinyFaceDetector + FaceLandmark68 + FaceRecognition)
3. ขอตำแหน่ง GPS แล้วคำนวณระยะห่างจากทุกสาขาด้วยสูตร Haversine หาสาขาที่ใกล้ที่สุด และเช็กว่าอยู่ในรัศมี (`radius_m` + เผื่อ accuracy)
4. พนักงานกรอกรหัส → ระบบเทียบกับรายชื่อ (รองรับ `001 = 1`)
5. เงื่อนไขปลดล็อกปุ่ม: มีรหัสถูก + โมเดลพร้อม + เห็นใบหน้า + อยู่ในพื้นที่
6. กดเข้างาน/ออกงาน → ส่ง `descriptor` (เวกเตอร์ใบหน้า 128 มิติ) + พิกัด + รูปถ่าย (เฉพาะตอนเข้างาน) ไป backend
7. backend ตอบกลับชื่อ, กะ, เวลา, จำนวนนาทีที่สาย

มี action: `config`, `register` (ลงทะเบียนใบหน้า), `checkin`, `checkout`

### 1.2 หน้า HR (Management Dashboard)

ล็อกอินด้วยรหัสผ่านเดียว (`hr_login`) แล้วแบ่งเป็น 5 แท็บ:

- **Dashboard** — KPI วันนี้ (ลงเวลาแล้ว/สาย/ยังไม่กดออก), กราฟแนวโน้ม 30 วัน, สรุปตามกะ, Top 5 คนสาย, สรุปตามสาขา
- **พนักงาน** — เพิ่ม/แก้ไข/ดูโปรไฟล์ + อัปโหลดรูป (ย่อก่อนส่ง), เปิด/ปิดการใช้งาน
- **รายงาน** — ดูการลงเวลาแบบละเอียด/สรุป ตามช่วงวันที่ + export CSV
- **วินัย & ใบเตือน** — ประเมินคนสาย/ขาดตามรอบ แล้วออกใบเตือนเป็นเอกสาร (พิมพ์ได้)
- **ลา & วันหยุด** — บันทึกใบลา และจัดการวันหยุดบริษัท

มี action ฝั่ง HR: `hr_login`, `hr_list`, `hr_dashboard`, `hr_save`, `hr_toggle`, `hr_report`, `hr_discipline`, `hr_warnings_list`, `hr_warning_issue`, `hr_warning_get`, `hr_leaves_list`, `hr_leaves_save`, `hr_leaves_delete`, `hr_holidays_list`, `hr_holidays_save`, `hr_holidays_delete`

---

## 2. Data Model ที่ถอดได้จากโค้ด (ปัจจุบันเก็บใน Google Sheets)

จากการอ่านฟิลด์ที่โค้ดใช้จริง สรุปได้เป็น 7 กลุ่มข้อมูล:

**พนักงาน (employees)**
`emp_id, start_date, name, nickname, default_shift, branch_id, phone, emergency_phone, emergency_name, bank_name, bank_account, id_card, address, line_user_id, weekly_off, photo_url, active, face_descriptor`

**สาขา (branches)**
`branch_id, name, lat, lng, radius_m`

**กะ (shifts)**
`shift_id, name` (+ น่าจะมีเวลาเข้า/ออก เพื่อคำนวณสาย/OT)

**การลงเวลา (attendance)**
`work_date, emp_id, shift, branch, check_in, check_out, late_min, ot_hours, photo_url, gps_lat, gps_lng, status (OPEN/CLOSED)`

**ใบเตือน (warnings)**
`warning_id, emp_id, issue_date, level, level_name, cycle_start, cycle_end, late_count, late_total, absent_count, reason, issued_by`

**การลา (leaves)**
`leave_id, emp_id, start_date, end_date, type, reason, status`

**วันหยุด (holidays)**
`date, name, type, active`

---

## 3. ปัญหา/ข้อจำกัดของ Demo ปัจจุบัน

1. **Backend เป็น Google Apps Script + Sheets** — ช้าเมื่อข้อมูลเยอะ, มีโควต้าจำกัด (วันละ ~20,000 เรียก/script run time), query ซับซ้อนไม่ได้, ไม่มี index จริง
2. **ความปลอดภัยอ่อน** — รหัสผ่าน HR ฝังในระบบเดียว, ข้อมูลอ่อนไหว (เลขบัตรประชาชน, เลขบัญชี) เก็บใน Sheets แบบไม่เข้ารหัส, ใครมี SCRIPT_URL ก็อาจยิง action ได้
3. **โค้ดรวมเป็นไฟล์เดียว** — แก้ไข/ขยายยาก, CSS+JS+HTML ปนกัน 1,100 บรรทัด
4. **ไม่มีฐานข้อมูลเชิงสัมพันธ์** — emp_id/branch_id/shift_id เป็นแค่ string อ้างอิงข้าม sheet เอง ไม่มี foreign key, เสี่ยงข้อมูลไม่สอดคล้อง
5. **รูปภาพ** — เก็บเป็น base64/URL ปนใน data ทำให้ payload ใหญ่
6. **face_descriptor** เก็บเป็น text — เทียบใบหน้าทำฝั่งไหนยังไม่ชัด (น่าจะส่งไปเทียบที่ backend ทุกครั้ง ซึ่งช้า)

---

## 4. สถาปัตยกรรมที่แนะนำ ⭐

> คุณเลือก "แนะนำหน่อย" — นี่คือคำแนะนำของผม พร้อมเหตุผล

### แนะนำ: คงเป็น **HTML/JS เดิม + Supabase JS Client โดยตรง** (ทางเลือกที่ 1)

**เหตุผล:**
- โค้ด demo ของคุณเขียนดีและทำงานครบแล้ว การเปลี่ยนแค่ "ชั้น backend" จาก Apps Script เป็น Supabase ทำให้ได้ของเร็ว ไม่ต้องเขียนใหม่หมด
- Supabase มี **JS client** เรียกตรงจาก browser ได้ (`supabase.from('employees').select()`) แทนที่ฟังก์ชัน `post({action})` เดิมแทบ 1:1
- ได้ PostgreSQL จริง + Storage (เก็บรูป) + Auth + Row Level Security ในตัว ฟรี tier เพียงพอสำหรับเริ่มต้น
- ทีมเล็ก/คนเดียวดูแลได้ ไม่ต้องตั้ง server เอง

**เมื่อไหร่ค่อยขยับไป React/Next.js:** เมื่อหน้า HR ซับซ้อนขึ้นมาก (หลาย role, real-time, มือถือ native) ค่อย refactor — แต่ตอนนี้ยังไม่จำเป็น และจะทำให้ MVP ช้าโดยไม่จำเป็น

### โครงสร้างที่จะปรับ

```
project/
├── employee/index.html      # หน้าลงเวลา (จากไฟล์ 7-eleven)
├── hr/index.html            # หน้า HR
├── shared/
│   ├── supabase.js          # init client + ฟังก์ชัน query กลาง
│   └── styles.css           # แยก CSS ออกจาก HTML
└── supabase/
    └── schema.sql           # โครงฐานข้อมูล
```

---

## 5. Supabase Schema ที่ออกแบบให้

ออกแบบเป็นตารางเชิงสัมพันธ์พร้อม foreign key (แก้ปัญหาข้อ 4 ด้านบน):

```sql
-- ===== กะการทำงาน =====
create table shifts (
  shift_id    text primary key,            -- เช่น 'M', 'A', 'N'
  name        text not null,               -- 'เช้า', 'บ่าย', 'ดึก'
  start_time  time not null,               -- เวลาเข้ากะ (ใช้คำนวณสาย)
  end_time    time not null,               -- เวลาออกกะ (ใช้คำนวณ OT)
  grace_min   int default 5                -- ผ่อนผันก่อนนับสาย (นาที)
);

-- ===== สาขา =====
create table branches (
  branch_id   text primary key,
  name        text not null,
  lat         double precision not null,
  lng         double precision not null,
  radius_m    int default 80               -- รัศมี geofence
);

-- ===== พนักงาน =====
create table employees (
  emp_id          text primary key,
  name            text not null,
  nickname        text,
  start_date      date,
  default_shift   text references shifts(shift_id),
  branch_id       text references branches(branch_id),
  weekly_off      text,                    -- 'Sun' หรือ 'Sat,Sun'
  phone           text,
  line_user_id    text,
  address         text,
  emergency_name  text,
  emergency_phone text,
  -- ข้อมูลอ่อนไหว (ดู §7 เรื่องความปลอดภัย)
  bank_name       text,
  bank_account    text,
  id_card         text,
  photo_url       text,                    -- ชี้ไป Supabase Storage
  face_descriptor jsonb,                   -- เวกเตอร์ 128 มิติ
  active          boolean default true,
  created_at      timestamptz default now()
);

-- ===== การลงเวลา =====
create table attendance (
  id          bigint generated always as identity primary key,
  emp_id      text references employees(emp_id),
  work_date   date not null,
  shift_id    text references shifts(shift_id),
  branch_id   text references branches(branch_id),
  check_in    timestamptz,
  check_out   timestamptz,
  late_min    int default 0,
  ot_hours    numeric(4,2) default 0,
  photo_url   text,
  gps_lat     double precision,
  gps_lng     double precision,
  status      text default 'OPEN',         -- OPEN / CLOSED
  unique (emp_id, work_date)               -- 1 คน 1 วัน 1 แถว
);

-- ===== ใบเตือน =====
create table warnings (
  warning_id  text primary key,            -- เช่น 'W-2026-0001'
  emp_id      text references employees(emp_id),
  issue_date  date default current_date,
  level       int,
  level_name  text,
  cycle_start date,
  cycle_end   date,
  late_count  int,
  late_total  int,
  absent_count int,
  reason      text,
  issued_by   text default 'HR'
);

-- ===== การลา =====
create table leaves (
  leave_id    bigint generated always as identity primary key,
  emp_id      text references employees(emp_id),
  start_date  date not null,
  end_date    date,
  type        text,                        -- ลากิจ/ลาป่วย/พักร้อน
  reason      text,
  status      text default 'approved'
);

-- ===== วันหยุดบริษัท =====
create table holidays (
  date    date primary key,
  name    text not null,
  type    text,
  active  boolean default true
);

-- ===== ตั้งค่าระบบ (รหัส HR ฯลฯ) =====
create table app_config (
  key   text primary key,
  value text
);
```

**index แนะนำ** (เพื่อให้รายงานเร็ว):
```sql
create index on attendance (work_date);
create index on attendance (emp_id, work_date);
create index on warnings (emp_id);
create index on leaves (emp_id);
```

**Supabase Storage:** สร้าง bucket `employee-photos` และ `attendance-photos` เก็บรูปแทน base64 → เก็บแค่ URL ในตาราง

---

## 6. แผนพัฒนาเป็น Phase

### Phase 0 — เตรียมพร้อม (½ วัน)
- สร้างโปรเจกต์ Supabase, รัน `schema.sql`, สร้าง Storage buckets
- เพิ่มข้อมูลตั้งต้น: สาขา, กะ (พร้อมเวลาเข้า/ออก), พนักงานทดลอง 2-3 คน
- เก็บ `SUPABASE_URL` + `anon key` ไว้ใช้ฝั่ง client

### Phase 1 — ย้าย Backend หน้าลงเวลา (1-2 วัน)
- แทน `loadConfig()` → ดึง branches/shifts/employees จาก Supabase
- แทน `post({action:'checkin/checkout/register'})` → เขียนลงตาราง `attendance` / อัปเดต `face_descriptor`
- ย้ายการคำนวณสาย/OT มาทำตอน check-in โดยอ้าง `shifts.start_time/end_time`
- อัปโหลดรูปเข้า Storage แทนส่ง base64
- **ตัดสินใจเรื่องการเทียบใบหน้า** (ดู §8)

### Phase 2 — ย้าย Backend หน้า HR (2-3 วัน)
- `hr_list` → `select` employees + join branch/shift
- `hr_save` → upsert employees + อัปโหลดรูป
- `hr_dashboard` → เขียนเป็น SQL view หรือ Postgres function (`rpc`) คำนวณ KPI/trend ในฐานข้อมูล (เร็วกว่า Apps Script มาก)
- `hr_report` → query attendance ตามช่วงวันที่
- `hr_discipline` / `hr_warning_*` → คำนวณคนสายต่อรอบ + เขียนใบเตือน
- `hr_leaves_*`, `hr_holidays_*` → CRUD ตรงไปตรงมา

### Phase 3 — เชื่อมสองหน้าให้สอดคล้อง (1 วัน)
- ทดสอบ flow ครบวง: พนักงานเช็กอิน → ข้อมูลโผล่บน HR dashboard ทันที
- ตรวจ logic วันหยุด/วันลา ไม่ให้นับเป็น "ขาดงาน" ตอนออกใบเตือน
- เปิด Realtime ของ Supabase (ถ้าต้องการให้ dashboard อัปเดตสด)

### Phase 4 — เก็บงาน & ความปลอดภัย (1-2 วัน)
- แยก CSS/JS ออกจาก HTML, ใส่ `.gitignore`, จัดโครงโฟลเดอร์
- ตั้ง Row Level Security เบื้องต้น (ดู §7)
- ปกปิดข้อมูลอ่อนไหว, ใส่ระบบ log การแก้ไข
- Deploy: Vercel / Netlify / Cloudflare Pages (ฟรี, รองรับ HTTPS ซึ่งจำเป็นต่อกล้อง+GPS)

**รวมประมาณ 6-9 วันทำงาน** สำหรับ MVP ที่ใช้งานจริงได้

---

## 7. ความปลอดภัย (คงระบบเดิมแบบง่ายก่อน ตามที่เลือก)

ช่วงแรกคง flow เดิม: HR ใช้รหัสผ่านเดียว, พนักงานยืนยันด้วยรหัส+ใบหน้า แต่ขอแนะนำ **3 อย่างที่ควรทำขั้นต่ำ** แม้จะยังง่าย:

1. **ย้ายรหัส HR ไปไว้ในตาราง `app_config`** (เก็บเป็น hash เช่น bcrypt) ไม่ฝังในโค้ด — แก้ได้โดยไม่ต้อง deploy ใหม่
2. **เปิด Row Level Security (RLS)** บนตารางที่มีข้อมูลอ่อนไหว แล้วเข้าถึงผ่าน Postgres function (`rpc`) ที่ตรวจรหัสก่อน แทนการ `select *` ตรงๆ ด้วย anon key — กัน `bank_account`/`id_card` รั่ว
3. **แยก key:** ใช้ `anon key` เฉพาะงานอ่านสาธารณะ (config สาขา/กะ) ส่วนงานเขียน attendance ให้ผ่าน function ที่ validate

> ⚠️ ข้อควรระวัง: ปัจจุบันเลขบัตรประชาชน + เลขบัญชีถูกเก็บแบบ plain text ซึ่งเป็นข้อมูลส่วนบุคคลตาม PDPA หากระบบใช้งานจริง ควรวางแผนเข้ารหัส/จำกัดสิทธิ์เข้าถึงตั้งแต่ต้น แม้เฟสแรกจะยังคงระบบล็อกอินแบบง่าย

---

## 8. Face Recognition — ข้อดี/ข้อเสีย (ตามที่ขอให้ช่วยแนะนำ)

ฟีเจอร์จดจำใบหน้าด้วย `face-api.js` เป็นจุดเด่นของ demo แต่ก็มีต้นทุน ขอสรุปให้ตัดสินใจ:

**ข้อดี**
- กันการ "ฝากเพื่อนตอกบัตร" (buddy punching) ได้ระดับหนึ่ง — เพราะต้องมีใบหน้าตรงกับที่ลงทะเบียน
- ทำงานในเบราว์เซอร์ฝั่ง client ได้ ไม่ต้องส่งรูปไปประมวลผลที่ server (ถ้าออกแบบให้เทียบฝั่ง client)
- รวมกับ GPS geofence แล้วได้หลักฐาน 2 ชั้น (อยู่ในพื้นที่ + ใช่ตัวจริง)

**ข้อเสีย / ข้อควรระวัง**
- **โหลดโมเดลหนัก** (~หลาย MB) ครั้งแรกช้า โดยเฉพาะเน็ตร้านไม่ดี
- **ความแม่นยำไม่สมบูรณ์** — แสง/มุม/หน้ากาก ทำให้พลาดได้ และ TinyFaceDetector เป็นรุ่นเบา เน้นเร็วกว่าแม่น
- **กันรูปถ่ายไม่ได้ (no liveness detection)** — ยกมือถือที่มีรูปเพื่อนมาส่องก็อาจผ่าน ถ้าต้องการกันจริงต้องเพิ่ม liveness ซึ่งซับซ้อน
- **PDPA:** ข้อมูล biometric (descriptor ใบหน้า) เป็นข้อมูลอ่อนไหวพิเศษ ต้องขอความยินยอม + เก็บให้ปลอดภัย
- ต้องใช้ **HTTPS** เท่านั้น (กล้องไม่ทำงานบน http)

**คำแนะนำของผม:** ใน MVP ให้ทำ flow หลัก (ข้อมูล + GPS + dashboard) ให้เสถียรก่อน แล้ว**คงการถ่ายรูปไว้เป็นหลักฐาน** (เก็บรูปตอนเช็กอินทุกครั้ง ให้ HR เปิดดูได้) ส่วนการ "เทียบใบหน้าอัตโนมัติ" ให้ทำเป็น **ตัวช่วยเตือน** (ถ้าไม่ตรงให้ขึ้น flag ให้ HR ตรวจ) แทนการบล็อกแข็ง — จะลดปัญหา false reject ที่ทำให้พนักงานเข้างานไม่ได้ และยังได้ประโยชน์ด้านการตรวจสอบครบ ถ้าภายหลังต้องการเข้มขึ้นค่อยเปิดโหมดบังคับ

ถ้าจะทำเทียบใบหน้าให้เร็ว: ดึง `face_descriptor` ของพนักงานคนนั้นมาเทียบ **ฝั่ง client** ด้วย Euclidean distance < threshold (0.5 ตามที่ตั้งไว้) แทนการส่งไปเทียบที่ server ทุกครั้ง

---

## 9. สรุปขั้นถัดไป

ลำดับที่แนะนำให้ลงมือ:

1. ผมสร้างไฟล์ `schema.sql` พร้อมรันได้ + ไฟล์ `supabase.js` (ชั้นเชื่อมต่อกลาง) ให้
2. ปรับหน้าลงเวลาให้ต่อ Supabase (Phase 1)
3. ปรับหน้า HR ให้ต่อ Supabase (Phase 2)
4. ทดสอบเชื่อมสองหน้า + deploy

บอกได้เลยว่าจะให้เริ่มที่ Phase ไหนก่อน หรือให้ผมลงมือสร้าง `schema.sql` + โครงโปรเจกต์ใหม่ให้ทันที

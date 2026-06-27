# คู่มือ Deploy ขึ้น GitHub Pages — ระบบ HR 7-Eleven

ระบบนี้เป็นเว็บ static (HTML/JS + Supabase บนคลาวด์) จึง deploy บน **GitHub Pages** ได้ฟรี
และได้ **HTTPS** อัตโนมัติ — สำคัญมาก เพราะกล้องและ GPS ทำงานเฉพาะบน HTTPS/localhost

---

## ขั้นตอน (ทำครั้งเดียว)

### 1. สร้าง repo บน GitHub
1. ไปที่ https://github.com/new
2. ตั้งชื่อ เช่น `7eleven-hr` → เลือก **Public** (Pages ฟรีสำหรับ public repo)
3. กด **Create repository**

### 2. อัปโหลดโค้ดขึ้น repo
**วิธี A — ลากวางผ่านเว็บ (ง่ายสุด ไม่ต้องลง Git):**
1. ในหน้า repo กด **uploading an existing file**
2. ลากไฟล์ทั้งหมดในโฟลเดอร์ `HR-7-eleven-main` (รวมโฟลเดอร์ย่อย `employee/ hr/ shared/`) เข้าไป
3. กด **Commit changes**

**วิธี B — ผ่าน Git (ถ้าติดตั้ง Git แล้ว):**
```bash
cd HR-7-eleven-main
git init
git add .
git commit -m "ระบบ HR 7-Eleven เวอร์ชันแรก"
git branch -M main
git remote add origin https://github.com/<ชื่อคุณ>/7eleven-hr.git
git push -u origin main
```

### 3. เปิด GitHub Pages
1. ในหน้า repo → **Settings** → เมนูซ้าย **Pages**
2. หัวข้อ *Build and deployment* → Source = **Deploy from a branch**
3. Branch = **main**, โฟลเดอร์ = **/ (root)** → กด **Save**
4. รอ 1–2 นาที จะได้ลิงก์: `https://<ชื่อคุณ>.github.io/7eleven-hr/`

---

## ลิงก์เข้าใช้งานหลัง deploy
- หน้าแรก (เลือกเมนู) → `https://<ชื่อคุณ>.github.io/7eleven-hr/`
- พนักงาน → `.../7eleven-hr/employee/`
- HR → `.../7eleven-hr/hr/`  (รหัส `admin1234`)

> พนักงานเปิดผ่านมือถือได้ทันที กล้อง/GPS จะขออนุญาตตามปกติ (เพราะเป็น HTTPS)

---

## ⚠️ ก่อนเปิดให้คนนอกใช้จริง — ตรวจ 3 ข้อนี้
1. **เปลี่ยนรหัส HR** จาก `admin1234`
   Supabase → Table Editor → ตาราง `app_config` → แถว `hr_password`
2. **เปิด RLS ครบทุกตาราง** — โค้ด `shared/config.js` มี anon key อยู่ในไฟล์ที่เปิดเผยบน GitHub
   anon key เปิดเผยได้ตามดีไซน์ของ Supabase **แต่จะปลอดภัยก็ต่อเมื่อ RLS รัดกุม**
   (ดู `supabase/policies.sql` — ตอนนี้ตั้งเปิดกว้างไว้ก่อน ควรรัดให้แน่นใน Phase 4)
3. **ปกป้องข้อมูลส่วนบุคคล (PDPA)** — เลขบัตร/เลขบัญชี ไม่ควรอ่านได้ผ่าน anon key

---

## อัปเดตโค้ดภายหลัง
แก้ไฟล์ในเครื่อง → อัปโหลด/commit ทับขึ้น repo เดิม → GitHub Pages อัปเดตเองใน 1–2 นาที
(ผู้ใช้รีเฟรชแบบ Ctrl+Shift+R เพื่อล้าง cache)

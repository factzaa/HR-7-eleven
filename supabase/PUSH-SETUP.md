# ตั้งค่า Web Push แจ้งเตือนฝั่ง HR (เด้งแม้ปิดแอป)

ระบบนี้ทำให้ HR / โทรศัพท์ร้าน ได้รับแจ้งเตือนเด้งขึ้นจอเอง (ขาด/มาสาย/ลืมเช็กเอาต์/ใบลาใหม่/ข้อมูลรอตรวจ) โดยไม่ต้องเปิดหน้าเว็บค้างไว้

## ภาพรวม 3 ส่วน
1. **อุปกรณ์ HR** กดปุ่ม 🔔 ในหน้า HR เพื่อสมัครรับแจ้งเตือน → เก็บลงตาราง `push_subscriptions`
2. **Edge Function `hr-notify`** รันบนคลาวด์ คำนวณว่ามีใครควรรู้อะไร แล้วส่ง push (กันส่งซ้ำด้วย `notify_sent`)
3. **cron** เรียก Edge Function ทุก 15 นาที

---

## VAPID Keys (สร้างไว้ให้แล้ว)
- **PUBLIC** (ใส่ในไฟล์ client แล้วที่ `shared/config.js` → `window.VAPID_PUBLIC`):
  ```
  BPOFTKZjK1dz1DXjLpsQKCa5RXa6oxu5qgqauordoECbvXIgxNeS4pkjxJiy_yh-o-D-YeUoNpyHc96-Jb0SKqI
  ```
- **PRIVATE** (ลับ! ใส่เป็น secret ของ Edge Function เท่านั้น ห้ามอยู่ในไฟล์ฝั่ง client):
  ```
  -2PoKl6hNqg0_W2jiAVKDgrcLMqg8fcdoL_801DMgWY
  ```
> ถ้าต้องการสร้างคู่ใหม่: `npx web-push generate-vapid-keys`

---

## ขั้นตอนติดตั้ง (ทำครั้งเดียว)

### 1) รัน SQL บน Supabase
- `supabase/push_notifications.sql` (สร้างตาราง subscription + ledger)

### 2) สร้าง Edge Function ในหน้าเว็บ (ไม่ต้องลงโปรแกรม)
1. เข้า https://supabase.com/dashboard → เลือกโปรเจกต์
2. เมนูซ้าย กดไอคอน **Edge Functions**
3. กด **Deploy a new function** → เลือก **Via Editor**
4. ตั้งชื่อฟังก์ชันว่า **hr-notify** (ต้องสะกดแบบนี้เป๊ะ)
5. ลบโค้ดตัวอย่างทิ้งทั้งหมด แล้ววางโค้ดจากไฟล์ `supabase/functions/hr-notify/index.ts` ลงไป
6. กด **Deploy** (มุมขวา) รอสักครู่จนขึ้นว่าสำเร็จ

### 3) ใส่ "กุญแจลับ" (Secrets) ในหน้าเว็บ
1. ยังอยู่ในเมนู **Edge Functions** → กดแท็บ/เมนู **Secrets** (หรือ Settings ของ Functions)
2. เพิ่มทีละค่า (กด Add new secret) รวม 3 ค่า:
   - ชื่อ `VAPID_PUBLIC` ค่า: `BPOFTKZjK1dz1DXjLpsQKCa5RXa6oxu5qgqauordoECbvXIgxNeS4pkjxJiy_yh-o-D-YeUoNpyHc96-Jb0SKqI`
   - ชื่อ `VAPID_PRIVATE` ค่า: `-2PoKl6hNqg0_W2jiAVKDgrcLMqg8fcdoL_801DMgWY`
   - ชื่อ `VAPID_SUBJECT` ค่า: `mailto:อีเมลของคุณ@example.com`
3. กด Save
> `SUPABASE_URL` และ `SUPABASE_SERVICE_ROLE_KEY` ระบบมีให้อยู่แล้ว ไม่ต้องเพิ่ม

### 4) เปิด extension + ตั้งเวลา (cron)
- เมนูซ้าย **Database → Extensions** → ค้นหาแล้วเปิด **pg_cron** และ **pg_net**
- เมนูซ้าย **SQL Editor** → วางเนื้อหาไฟล์ `supabase/push_cron.sql` → กด **Run**

### 6) เปิดแจ้งเตือนที่อุปกรณ์
- เปิดหน้า HR บนเครื่อง/มือถือที่ต้องการ → ล็อกอิน → กดปุ่ม **🔔 แจ้งเตือน** ที่มุมขวาบน → อนุญาต → ตั้งชื่อเครื่อง
- ทำซ้ำได้ทุกเครื่อง (โทรศัพท์ร้าน, มือถือ HR, คอม) แต่ละเครื่องจะได้รับเหมือนกัน
- บน iPhone: ต้อง "เพิ่มไปยังหน้าจอโฮม" (ติดตั้งเป็นแอป) ก่อน ถึงจะเปิด push ได้

---

## ทดสอบ (ในหน้าเว็บ)
- ไปที่ Edge Functions → เปิดฟังก์ชัน hr-notify → กดปุ่ม **Test/Invoke** (ส่ง body ว่าง `{}`) → ดูผลลัพธ์
- หรือสร้างใบลาทดสอบในแอป แล้วรอรอบ cron ถัดไป (≤15 นาที) จะมีแจ้งเตือนเด้ง
- ดู log ได้ที่หน้าฟังก์ชัน → แท็บ **Logs**

## หมายเหตุ
- กันส่งซ้ำ: แต่ละเหตุการณ์ส่งครั้งเดียว (เก็บ key ใน `notify_sent` ล้างเองเมื่อเกิน 7 วัน)
- ถ้าอุปกรณ์ถอนการอนุญาต/หมดอายุ ระบบลบ subscription ให้อัตโนมัติ
- ปรับความถี่ได้ที่ `push_cron.sql` (เช่น ทุก 10 นาที) · ปรับชนิดแจ้งเตือนได้ในฟังก์ชัน `index.ts`

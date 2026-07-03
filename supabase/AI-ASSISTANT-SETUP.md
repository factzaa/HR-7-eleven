# ผู้ช่วย AI ฝ่ายบุคคล (hr-assistant) — วิธีติดตั้ง

ผู้ช่วย AI (เฟส 1) สำหรับ **ฝ่ายบุคคลเท่านั้น · อ่านข้อมูลอย่างเดียว** ใช้ Google Gemini
ผ่าน Supabase Edge Function มีเครื่องมือ 6 ตัว: ค้นหาพนักงาน, ภาพรวมการมาทำงาน,
สรุปรายบุคคล, ใบลารออนุมัติ, งานค้างข้ามวัน, สินค้าใกล้หมดอายุ

## 1) ขอ API Key จาก Google AI Studio (ฟรี)
1. ไปที่ https://aistudio.google.com → **Get API key** → สร้างคีย์
2. รุ่นแนะนำ: `gemini-2.5-flash` (ฟรีเทียร์ ~1,500 คำขอ/วัน รองรับ function calling)

## 2) ตั้งค่า Secret ของ Edge Function
```bash
supabase secrets set GEMINI_API_KEY=YOUR_KEY_HERE
# (ถ้าต้องการเปลี่ยนรุ่น) supabase secrets set GEMINI_MODEL=gemini-2.5-flash
```
> `SUPABASE_URL` และ `SUPABASE_SERVICE_ROLE_KEY` มีให้อัตโนมัติในสภาพแวดล้อม Edge Function

## 3) Deploy ฟังก์ชัน (สำคัญ: ใช้ --no-verify-jwt)
```bash
supabase functions deploy hr-assistant --no-verify-jwt
```
**ต้องใส่ `--no-verify-jwt`** เพราะฟังก์ชันนี้ถูกเรียกจากเบราว์เซอร์และตรวจสิทธิ์ด้วย
รหัส HR เองอยู่แล้ว หากไม่ใส่ Supabase gateway จะบล็อกคำขอ preflight (OPTIONS)
ของเบราว์เซอร์ → หน้าแชทจะขึ้น **"Failed to fetch"**

ตรวจว่า deploy สำเร็จ: เปิด `https://<project>.supabase.co/functions/v1/hr-assistant`
ตรง ๆ ควรได้ JSON `{"error":"POST only"}` (ไม่ใช่ 404) = ฟังก์ชันออนไลน์แล้ว

## 4) ใช้งาน
เข้าคอนโซล HR → แท็บ **🤖 ผู้ช่วย AI** → พิมพ์คำถาม เช่น
"ใครมาสายมากสุดรอบนี้", "ใบลารออนุมัติมีใครบ้าง", "สรุปของ [ชื่อพนักงาน] เดือนนี้",
"งานค้างข้ามวัน", "สินค้าจะหมดอายุใน 7 วัน"

## ความปลอดภัย
- ตรวจรหัส HR ทุกครั้งก่อนตอบ (ผ่าน RPC `hr_check_password`) — ไม่ผ่าน = ปฏิเสธ
- อ่านอย่างเดียว: ไม่มีเครื่องมือที่แก้ไข/ลบข้อมูล
- ทุกคำถามถูกบันทึกลง `activity_log`
- คีย์ Gemini อยู่ฝั่งเซิร์ฟเวอร์เท่านั้น ไม่หลุดสู่เบราว์เซอร์

## หมายเหตุ (ต่อยอดเฟสถัดไป)
- เฟส 2: ผู้ช่วยฝั่งพนักงาน (เห็นเฉพาะข้อมูลตัวเอง) + สรุปเชิงรุกทุกเช้า
- เฟส 3: เตรียมข้อมูล/ส่งออกไฟล์ + ช่วยทำงานแบบยืนยันก่อนทำ (เฉพาะ HR)
- รูปแบบ functionResponse ของ Gemini ใช้ role `user` — หากเวอร์ชัน API เปลี่ยน
  อาจต้องปรับใน `supabase/functions/hr-assistant/index.ts` (จุด `contents.push`)

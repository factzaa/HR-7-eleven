// ============================================================
// ใส่ค่าจาก Supabase: Project Settings > API
// ============================================================
window.SUPABASE_CONFIG = {
  url:     'https://vppvctftfgchweonxycb.supabase.co',   // <-- Project URL (ห้ามมี /rest/v1/ ต่อท้าย)
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwcHZjdGZ0ZmdjaHdlb254eWNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0Nzg5NTEsImV4cCI6MjA5ODA1NDk1MX0.mzaxs61QEvYFT12fRkS8RkgXDwbvlBbcbpGKPoOpqzU'                // <-- แก้ตรงนี้
};

// เวอร์ชันระเบียบการทำงาน — แก้เลขนี้เมื่อประกาศระเบียบฉบับใหม่
// (พนักงานทุกคนจะถูกขอให้ยอมรับใหม่อัตโนมัติ)
window.RULES_VERSION = '2026-06-28';

// Web Push — กุญแจสาธารณะ VAPID (ใส่ได้ในไฟล์ client ปลอดภัย ห้ามใส่ private key)
// คู่กับ private key ที่ตั้งเป็น secret ของ Edge Function (ดู supabase/PUSH-SETUP.md)
window.VAPID_PUBLIC = 'BPOFTKZjK1dz1DXjLpsQKCa5RXa6oxu5qgqauordoECbvXIgxNeS4pkjxJiy_yh-o-D-YeUoNpyHc96-Jb0SKqI';

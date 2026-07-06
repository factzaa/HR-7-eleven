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

// ============================================================
// ตัวช่วยแสดงวันที่เป็น พ.ศ. (พุทธศักราช) ทั้งระบบ — รูปแบบ "10 ก.ค. 2569"
// beDate(x)     : รับ "YYYY-MM-DD" / ISO / Date → "10 ก.ค. 2569" (ปี +543)
// beDateTime(x) : รับ ISO timestamp → "10 ก.ค. 2569 14:12"
// ใช้เวลาไทยของเครื่อง (พนักงาน/HR ใช้ในไทย) · ค่าว่าง/ผิดรูป → คืน "—"
// ============================================================
(function () {
  var TH_MON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  function toDate(x) {
    if (x == null || x === '') return null;
    if (x instanceof Date) return isNaN(x) ? null : x;
    var s = String(x).trim();
    var d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
    return isNaN(d) ? null : d;
  }
  window.beDate = function (x) {
    var d = toDate(x); if (!d) return (x == null || x === '') ? '—' : String(x);
    return d.getDate() + ' ' + TH_MON[d.getMonth()] + ' ' + (d.getFullYear() + 543);
  };
  window.beDateTime = function (x) {
    var d = toDate(x); if (!d) return (x == null || x === '') ? '—' : String(x);
    var hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
    return d.getDate() + ' ' + TH_MON[d.getMonth()] + ' ' + (d.getFullYear() + 543) + ' ' + hh + ':' + mm;
  };
})();

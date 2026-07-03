// ============================================================
// State ส่วนกลาง: จำ "รหัสพนักงาน" ข้ามหน้า (localStorage)
// ใช้ร่วมกันทุกหน้าฝั่งพนักงาน (employee / handover / qa / staff / rules / หน้าแรก)
// - HRSession.getEmp()      อ่านรหัสที่จำไว้
// - HRSession.setEmp(id)    บันทึกรหัส (เรียกหลัง lookup สำเร็จ)
// - HRSession.clearEmp()    ล้างรหัส (เรียกตอนกด "เปลี่ยนรหัส")
// - HRSession.prefill('empId')  เติมค่าลงช่องกรอกอัตโนมัติ + trigger input
// หมายเหตุ: เก็บเฉพาะ "รหัสพนักงาน" (ไม่ใช่ข้อมูลลับ) เพื่อความสะดวก ไม่ต้องพิมพ์ซ้ำ
// ============================================================
(function () {
  var KEY = 'hr_emp_id';
  function safeGet() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  var S = {
    getEmp: function () { return safeGet(); },
    setEmp: function (id) { try { if (id) localStorage.setItem(KEY, String(id)); } catch (e) {} },
    clearEmp: function () { try { localStorage.removeItem(KEY); } catch (e) {} },
    prefill: function (inputId) {
      inputId = inputId || 'empId';
      try {
        var el = document.getElementById(inputId), v = safeGet();
        if (el && v && !el.value) {
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));   // ให้หน้าที่ฟัง input ทำงานเหมือนพิมพ์เอง
        }
        return v;
      } catch (e) { return ''; }
    }
  };
  window.HRSession = S;

  // เติมรหัสที่จำไว้อัตโนมัติเมื่อหน้าโหลดเสร็จ (เฉพาะหน้าที่มีช่อง id="empId")
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { S.prefill('empId'); });
  } else {
    S.prefill('empId');
  }
})();

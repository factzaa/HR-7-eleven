// ============================================================
// [ปิดการใช้งาน] เดิม: จำ "รหัสพนักงาน" ข้ามหน้า (localStorage)
// เหตุผล: บนอุปกรณ์ที่ใช้ร่วมกัน (แท็บเล็ตสาขา) การเติมรหัสอัตโนมัติ
//         ทำให้พนักงานคนถัดไปเผลอลงชื่อเข้างานเป็นคนก่อนหน้า (ลงผิดคน)
// ตอนนี้: ไม่จำ ไม่เติมอัตโนมัติอีกต่อไป — ทุกครั้งต้องกรอกรหัสเอง
// คงชื่อฟังก์ชันไว้ (no-op) เพื่อไม่ให้หน้าที่เรียกใช้อยู่พัง
//
// ★ เพิ่ม PIN 4 หลักรายบุคคล (14 ก.ย. 2569)
//   พนักงานตั้ง PIN ของตัวเองครั้งแรกที่เข้าใช้ · ต้องใส่ทุกครั้งที่เปิดหน้า
//   ลืม PIN → ยืนยันตัวตนเองแล้วตั้งใหม่ได้ (วันเกิด หรือ เลข 4 ตัวท้ายบัตรประชาชน)
//   ใส่ผิด 5 ครั้ง → ล็อก 10 นาที · PIN เก็บเป็น bcrypt ไม่มีใครเห็นค่าจริง
// ============================================================
(function () {
  var KEY = 'hr_emp_id';
  try { localStorage.removeItem(KEY); } catch (e) {}

  // ---------- UI ----------
  function ensureDom() {
    if (document.getElementById('hrPinOv')) return;
    var css = document.createElement('style');
    css.textContent =
      '#hrPinOv{position:fixed;inset:0;z-index:100010;background:rgba(8,20,14,.62);display:none;' +
      'align-items:center;justify-content:center;padding:18px;' +
      'font-family:"Kanit",system-ui,-apple-system,"Segoe UI","Sarabun",sans-serif}' +
      '#hrPinOv.on{display:flex}' +
      '#hrPinBox{background:#fff;border-radius:18px;max-width:340px;width:100%;padding:20px 18px 18px;' +
      'box-shadow:0 20px 50px -18px rgba(0,0,0,.55);color:#0f172a;text-align:center}' +
      '#hrPinBox h3{margin:0 0 4px;font-size:18px;font-weight:600}' +
      '#hrPinBox .who{font-size:13.5px;color:#00582f;font-weight:600;margin-bottom:2px}' +
      '#hrPinBox .sub{font-size:12.5px;color:#64748b;line-height:1.6;margin-bottom:14px}' +
      '#hrPinBox input{width:100%;box-sizing:border-box;padding:13px;border:1.5px solid #cbd5e1;border-radius:12px;' +
      'font:inherit;font-size:22px;text-align:center;letter-spacing:10px;margin-bottom:9px;background:#f8fafc}' +
      '#hrPinBox input.txt{font-size:16px;letter-spacing:2px}' +
      '#hrPinBox input:focus{outline:none;border-color:#00582f;background:#fff}' +
      '#hrPinBox .err{font-size:12.5px;color:#dc2626;min-height:18px;margin-bottom:6px;line-height:1.55;white-space:pre-line}' +
      '#hrPinBox .bt{display:flex;gap:8px;margin-top:2px}' +
      '#hrPinBox button{flex:1;padding:12px;border-radius:12px;border:0;font:inherit;font-size:15px;font-weight:600;cursor:pointer}' +
      '#hrPinOk{background:#00582f;color:#fff}#hrPinCancel{background:#f1f5f9;color:#475569}' +
      '#hrPinLink{display:block;margin-top:12px;font-size:12.5px;color:#0369a1;text-decoration:underline;cursor:pointer}';
    document.head.appendChild(css);
    var d = document.createElement('div');
    d.id = 'hrPinOv';
    d.innerHTML =
      '<div id="hrPinBox">' +
        '<div class="who" id="hrPinWho"></div>' +
        '<h3 id="hrPinTitle">ใส่ PIN</h3>' +
        '<div class="sub" id="hrPinSub"></div>' +
        '<input id="hrPin1" type="password" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••">' +
        '<input id="hrPin2" type="password" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••" style="display:none">' +
        '<div class="err" id="hrPinErr"></div>' +
        '<div class="bt"><button id="hrPinCancel" type="button">ยกเลิก</button><button id="hrPinOk" type="button">ยืนยัน</button></div>' +
        '<span id="hrPinLink"></span>' +
      '</div>';
    document.body.appendChild(d);
  }

  function rpc(name, args) {
    if (!window.HR || !window.HR.sb) return Promise.reject(new Error('ระบบยังไม่พร้อม'));
    return window.HR.sb.rpc(name, args).then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });
  }

  var MSG = {
    not_found: 'ไม่พบรหัสพนักงานนี้',
    locked: 'ใส่ PIN ผิดหลายครั้ง — ระบบล็อกไว้ชั่วคราว ลองใหม่อีก 10 นาที',
    wrong: 'PIN ไม่ถูกต้อง',
    wrong_answer: 'ข้อมูลยืนยันตัวตนไม่ถูกต้อง',
    bad_pin: 'PIN ต้องเป็นตัวเลข 4 หลัก',
    already: 'มี PIN อยู่แล้ว — ใส่ PIN เดิม หรือกด "ลืม PIN"'
  };

  // pinGate(emp) -> Promise<boolean>
  function pinGate(emp) {
    var empId = (emp && emp.emp_id) ? String(emp.emp_id) : String(emp || '');
    var who = (emp && (emp.nickname || emp.name)) ? (emp.nickname || emp.name) : '';
    if (!empId) return Promise.resolve(false);
    ensureDom();

    var ov = document.getElementById('hrPinOv');
    var p1 = document.getElementById('hrPin1'), p2 = document.getElementById('hrPin2');
    var eTitle = document.getElementById('hrPinTitle'), eSub = document.getElementById('hrPinSub');
    var eErr = document.getElementById('hrPinErr'), eWho = document.getElementById('hrPinWho');
    var bOk = document.getElementById('hrPinOk'), bNo = document.getElementById('hrPinCancel');
    var link = document.getElementById('hrPinLink');

    return rpc('staff_pin_status', { p_emp_id: empId }).then(function (rows) {
      var st = Array.isArray(rows) ? rows[0] : rows;
      if (!st) return false;
      if (!who) who = st.nm || '';

      return new Promise(function (resolve) {
        var mode = st.has_pin ? 'login' : 'setup';   // login | setup | reset
        var busy = false;

        function paint(err) {
          eWho.textContent = who ? (who + ' · ' + empId) : empId;
          eErr.textContent = err || '';
          p1.value = ''; p2.value = '';
          p1.className = ''; p2.className = '';
          p1.type = 'password'; p2.type = 'password';
          p1.setAttribute('maxlength', '4'); p2.setAttribute('maxlength', '4');
          p1.placeholder = '••••'; p2.placeholder = '••••';
          if (mode === 'setup') {
            eTitle.textContent = 'ตั้ง PIN ของคุณ';
            eSub.innerHTML = 'ตั้งรหัส 4 หลักที่คุณจำได้ ใช้เข้าระบบทุกครั้ง<br><b>ห้ามบอกเพื่อนร่วมงาน</b>';
            p2.style.display = ''; p2.placeholder = 'ใส่ซ้ำอีกครั้ง';
            link.textContent = '';
          } else if (mode === 'login') {
            eTitle.textContent = 'ใส่ PIN';
            eSub.textContent = 'ใส่ PIN 4 หลักของคุณเพื่อเข้าใช้งาน';
            p2.style.display = 'none';
            link.textContent = 'ลืม PIN ?';
          } else {
            eTitle.textContent = 'ยืนยันตัวตน';
            eSub.textContent = (st.reset_by === 'birth')
              ? 'ใส่วันเกิดของคุณ วว/ดด/ปปปป (พ.ศ. หรือ ค.ศ. ก็ได้) แล้วตั้ง PIN ใหม่'
              : (st.reset_by === 'idcard4'
                  ? 'ใส่เลข 4 ตัวท้ายบัตรประชาชนของคุณ แล้วตั้ง PIN ใหม่'
                  : 'ข้อมูลยืนยันตัวตนยังไม่ครบ — แจ้งผู้จัดการร้านให้รีเซ็ต PIN ให้');
            p1.className = 'txt'; p1.type = 'text';
            p1.setAttribute('maxlength', st.reset_by === 'birth' ? '10' : '4');
            p1.placeholder = st.reset_by === 'birth' ? 'วว/ดด/ปปปป' : '4 ตัวท้ายบัตร';
            p2.style.display = ''; p2.placeholder = 'PIN ใหม่ 4 หลัก';
            link.textContent = '‹ กลับไปใส่ PIN';
          }
          setTimeout(function () { try { p1.focus(); } catch (e) {} }, 60);
        }

        function close(v) {
          ov.classList.remove('on');
          bOk.onclick = bNo.onclick = link.onclick = null;
          p1.onkeydown = p2.onkeydown = null;
          resolve(v);
        }

        function lockMsg(min) {
          return 'ใส่ PIN ผิดหลายครั้ง — รออีก ' + (min > 0 ? min : 10) + ' นาที\nหรือกด "ลืม PIN ?" ด้านล่างเพื่อตั้ง PIN ใหม่ได้เลย';
        }
        function fail(code) {
          if (code === 'locked') {
            return paint(mode === 'reset'
              ? 'ยืนยันตัวตนผิดหลายครั้ง — ลองใหม่อีก 15 นาที หรือแจ้งผู้จัดการร้านให้รีเซ็ตให้'
              : lockMsg(0));
          }
          if (code === 'wrong_answer') {
            return paint(st.reset_by === 'birth'
              ? 'วันเกิดไม่ตรงกับที่บันทึกไว้ — ลองพิมพ์แบบ 05/09/2543 หรือ 2000-09-05'
              : 'เลข 4 ตัวท้ายบัตรประชาชนไม่ตรงกับที่บันทึกไว้ — ถ้ายังไม่ได้ แจ้งผู้จัดการร้านให้รีเซ็ตให้');
          }
          paint(MSG[code] || ('ไม่สำเร็จ (' + code + ')'));
        }

        function submit() {
          if (busy) return; busy = true;
          bOk.textContent = 'กำลังตรวจสอบ…';
          var done = function () { busy = false; bOk.textContent = 'ยืนยัน'; };
          if (mode === 'login') {
            rpc('staff_pin_login', { p_emp_id: empId, p_pin: p1.value.trim() }).then(function (res) {
              done();
              if (res === 'ok') return close(true);
              if (res === 'no_pin') { mode = 'setup'; return paint(''); }
              fail(res);
            }).catch(function (e) { done(); paint(String(e.message || e)); });
          } else if (mode === 'setup') {
            var a = p1.value.trim(), b = p2.value.trim();
            if (!/^[0-9]{4}$/.test(a)) { done(); return paint('PIN ต้องเป็นตัวเลข 4 หลัก'); }
            if (a !== b) { done(); return paint('PIN สองช่องไม่ตรงกัน'); }
            rpc('staff_pin_set', { p_emp_id: empId, p_pin: a }).then(function (res) {
              done();
              if (res === 'ok') return close(true);
              if (res === 'already') { mode = 'login'; return paint(MSG.already); }
              fail(res);
            }).catch(function (e) { done(); paint(String(e.message || e)); });
          } else {
            var ans = p1.value.trim(), np = p2.value.trim();
            if (!ans) { done(); return paint('กรอกข้อมูลยืนยันตัวตนก่อน'); }
            if (!/^[0-9]{4}$/.test(np)) { done(); return paint('PIN ใหม่ต้องเป็นตัวเลข 4 หลัก'); }
            rpc('staff_pin_reset', { p_emp_id: empId, p_answer: ans, p_pin: np }).then(function (res) {
              done();
              if (res === 'ok') return close(true);
              fail(res);
            }).catch(function (e) { done(); paint(String(e.message || e)); });
          }
        }

        bOk.onclick = submit;
        bNo.onclick = function () { close(false); };
        link.onclick = function () {
          if (mode === 'login') {
            if (st.reset_by === 'hr') { paint('ข้อมูลยืนยันตัวตนยังไม่ครบ — แจ้งผู้จัดการร้านให้รีเซ็ต PIN ให้'); return; }
            mode = 'reset';
            paint(st.reset_locked ? 'ยืนยันตัวตนผิดหลายครั้ง — ลองใหม่อีก 15 นาที' : '');
            return;
          }
          if (mode === 'reset') mode = 'login';
          paint('');
        };
        p1.onkeydown = function (ev) { if (ev.key === 'Enter') { if (p2.style.display === 'none') submit(); else p2.focus(); } };
        p2.onkeydown = function (ev) { if (ev.key === 'Enter') submit(); };

        ov.classList.add('on');
        if (st.locked) paint(lockMsg(Number(st.lock_min) || 0));
        else paint('');
      });
    }).catch(function (e) {
      // ถ้าเรียก RPC ไม่ได้ (ยังไม่ได้รัน SQL) → ไม่ล็อกพนักงานออกจากระบบ
      try { console.warn('pinGate:', e && e.message); } catch (_e) {}
      return true;
    });
  }

  window.HRSession = {
    getEmp: function () { return ''; },
    setEmp: function () {},
    clearEmp: function () { try { localStorage.removeItem(KEY); } catch (e) {} },
    prefill: function () { return ''; },
    pinGate: pinGate
  };
})();

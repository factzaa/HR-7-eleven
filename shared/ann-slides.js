/* ============================================================
 * ann-slides.js — สไลด์ประกาศรูปภาพ (ใช้ร่วมกัน: หน้าลงเวลา + หน้ารับส่งผลัด)
 *
 * ลอยขึ้นมาเต็มจอเหมือนภาพโฆษณา · เลื่อนซ้าย-ขวาได้ (ปัดนิ้ว / ปุ่ม / ลูกศร)
 * ไม่ต้องกดรับทราบ ปิดได้เลย · แสดง "วันละครั้งต่อคนต่อประกาศ" (จำด้วย localStorage)
 * ระบบยังบันทึกให้ว่าใครเปิดดูแล้ว (announcement_acks.opened_at)
 *
 * ใช้งาน:
 *   window.ANN.show(emp)                        → รู้ตัวพนักงานแล้ว (หน้ารับส่งผลัด)
 *   window.ANN.show(null, { branchId })         → ยังไม่รู้ว่าใคร (หน้าลงเวลา — เด้งทันทีที่เปิดหน้า)
 *   window.ANN.claim(emp)                       → ผูกยอด "เปิดดูแล้ว" กับพนักงานภายหลัง (ตอนกรอกรหัส)
 *   window.ANN.show(emp, { force:true })        → บังคับแสดงซ้ำ
 * ============================================================ */
(function () {
  const LS_KEY = 'ann_slides_seen';       // { "<empId|dev>|<annId>": "YYYY-MM-DD" }
  const DEV = 'dev';                      // คีย์ระดับเครื่อง (ใช้ตอนยังไม่รู้ว่าใคร)

  const today = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function seenMap() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (_e) { return {}; }
  }
  function markSeen(empId, annId) {
    try {
      const m = seenMap();
      m[empId + '|' + annId] = today();
      // เก็บแค่ 200 รายการล่าสุด กัน localStorage บวม
      const keys = Object.keys(m);
      if (keys.length > 200) keys.slice(0, keys.length - 200).forEach(k => delete m[k]);
      localStorage.setItem(LS_KEY, JSON.stringify(m));
    } catch (_e) { /* ข้าม */ }
  }
  const seenToday = (empId, annId) => seenMap()[empId + '|' + annId] === today();

  // ---------- สร้าง DOM ครั้งเดียว ----------
  // ดีไซน์: ไม่มีพื้นหลังดำ · รูปลอยเกือบเต็มจอ · จุดไข่ปลาบอกตำแหน่งภาพด้านล่าง
  function ensureDom() {
    if (document.getElementById('annSlides')) return;
    const o = document.createElement('div');
    o.id = 'annSlides';
    // พื้นหลังโปร่ง (เบลอเล็กน้อยให้รูปเด่นขึ้น แต่ยังเห็นหน้าเว็บด้านหลัง) · แตะพื้นหลังเพื่อปิด
    o.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.18);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);z-index:100002;display:none;align-items:center;justify-content:center;padding:10px;touch-action:pan-y';
    o.innerHTML =
      '<div id="annSlWrap" style="position:relative;display:flex;flex-direction:column;align-items:center;gap:10px;max-width:100%;max-height:100%">'
      + '  <div id="annSlStage" style="position:relative;display:flex;align-items:center;justify-content:center">'
      + '    <img id="annSlImg" alt="" style="max-width:94vw;max-height:80vh;width:auto;height:auto;object-fit:contain;display:block;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.35)">'
      + '    <button id="annSlClose" style="position:absolute;top:-14px;right:-14px;background:#0f172a;color:#fff;border:2px solid #fff;border-radius:50%;width:36px;height:36px;font-size:19px;line-height:1;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)">×</button>'
      + '    <button id="annSlPrev" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);background:rgba(15,23,42,.5);color:#fff;border:0;border-radius:50%;width:42px;height:42px;font-size:25px;line-height:1;cursor:pointer">‹</button>'
      + '    <button id="annSlNext" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:rgba(15,23,42,.5);color:#fff;border:0;border-radius:50%;width:42px;height:42px;font-size:25px;line-height:1;cursor:pointer">›</button>'
      + '  </div>'
      + '  <div id="annSlDots" style="display:flex;gap:7px;justify-content:center;align-items:center;min-height:12px"></div>'
      + '  <div id="annSlTitle" style="color:#0f172a;font-size:14.5px;font-weight:700;line-height:1.4;text-align:center;max-width:94vw;text-shadow:0 1px 6px rgba(255,255,255,.9)"></div>'
      + '  <div id="annSlMsg" style="color:#334155;font-size:13px;line-height:1.55;text-align:center;max-width:94vw;max-height:14vh;overflow-y:auto;white-space:pre-wrap;text-shadow:0 1px 6px rgba(255,255,255,.9)"></div>'
      + '  <button id="annSlDone" style="padding:10px 26px;border:0;border-radius:999px;background:#0f172a;color:#fff;font-size:14.5px;font-weight:800;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25)">ปิด</button>'
      + '</div>';
    document.body.appendChild(o);
  }

  // ---------- สถานะ ----------
  // i = ประกาศที่เท่าไหร่ · s = สไลด์ที่เท่าไหร่ · key = empId หรือ 'dev'
  // viewed = id ประกาศที่ถูกเปิดดูในรอบนี้ (ไว้ผูกกับพนักงานทีหลังผ่าน claim())
  const S = { items: [], i: 0, s: 0, emp: null, key: DEV, done: null, viewed: [] };

  // บันทึกว่าเปิดดูแล้ว — ถ้ายังไม่รู้ว่าใคร ให้จำ id ไว้ก่อน แล้วค่อยผูกทีหลัง
  function noteViewed(a) {
    if (!a) return;
    markSeen(S.key, a.id);
    if (S.viewed.indexOf(a.id) < 0) S.viewed.push(a.id);
    if (S.emp && S.emp.emp_id) {
      try { window.HR.markAnnouncementOpened(a.id, S.emp.emp_id, S.emp.nickname || S.emp.name, S.emp.branch_id); } catch (_e) { }
    }
  }

  function render() {
    const a = S.items[S.i]; if (!a) return closeAll();
    const imgs = a.images || [];
    if (S.s >= imgs.length) S.s = imgs.length - 1;
    if (S.s < 0) S.s = 0;

    const step = S.items.length > 1 ? ' · ประกาศ ' + (S.i + 1) + '/' + S.items.length : '';
    const tEl = document.getElementById('annSlTitle');
    tEl.textContent = (a.title || '') + step;
    tEl.style.display = (a.title || step) ? 'block' : 'none';

    document.getElementById('annSlImg').src = imgs[S.s] || '';
    const msg = (a.message && a.message !== a.title) ? a.message : '';
    const mEl = document.getElementById('annSlMsg');
    mEl.textContent = msg; mEl.style.display = msg ? 'block' : 'none';

    const multi = imgs.length > 1;
    document.getElementById('annSlPrev').style.display = multi ? 'block' : 'none';
    document.getElementById('annSlNext').style.display = multi ? 'block' : 'none';
    // จุดไข่ปลาบอกว่ากำลังดูภาพที่เท่าไหร่ (กดข้ามไปภาพไหนก็ได้)
    const dots = document.getElementById('annSlDots');
    dots.innerHTML = multi
      ? imgs.map((_u, k) => '<span data-k="' + k + '" style="width:' + (k === S.s ? 22 : 9) + 'px;height:9px;border-radius:999px;background:' + (k === S.s ? '#0f172a' : 'rgba(15,23,42,.28)') + ';cursor:pointer;transition:width .18s;box-shadow:0 1px 4px rgba(255,255,255,.8)"></span>').join('')
      : '';
    dots.style.display = multi ? 'flex' : 'none';
    dots.querySelectorAll('[data-k]').forEach(d => {
      d.onclick = () => { S.s = Number(d.dataset.k); render(); };
    });

    const last = (S.i === S.items.length - 1);
    document.getElementById('annSlDone').textContent = last ? 'ปิด' : 'ประกาศถัดไป →';
  }

  function nextSlide(dir) {
    const a = S.items[S.i]; if (!a) return;
    const n = (a.images || []).length;
    if (n <= 1) return;
    S.s = (S.s + dir + n) % n;    // วนลูป
    render();
  }

  function nextAnn() {
    noteViewed(S.items[S.i]);                       // ดูใบนี้จบแล้ว
    if (S.i < S.items.length - 1) { S.i++; S.s = 0; render(); }
    else closeAll();
  }

  function closeAll() {
    noteViewed(S.items[S.i]);                       // ปิดกลางคัน — นับใบที่กำลังดูอยู่ด้วย
    const o = document.getElementById('annSlides');
    if (o) o.style.display = 'none';
    document.removeEventListener('keydown', onKey);
    const d = S.done; S.done = null; S.items = [];
    if (d) d(true);
  }

  function onKey(e) {
    if (e.key === 'ArrowLeft') nextSlide(-1);
    else if (e.key === 'ArrowRight') nextSlide(1);
    else if (e.key === 'Escape') closeAll();
  }

  function wire() {
    const o = document.getElementById('annSlides');
    if (o.dataset.wired) return;
    o.dataset.wired = '1';
    document.getElementById('annSlClose').onclick = closeAll;
    document.getElementById('annSlDone').onclick = nextAnn;
    document.getElementById('annSlPrev').onclick = () => nextSlide(-1);
    document.getElementById('annSlNext').onclick = () => nextSlide(1);
    o.addEventListener('click', e => { if (e.target === o) closeAll(); });

    // ปัดนิ้วซ้าย-ขวา
    let x0 = null, y0 = null;
    const stage = document.getElementById('annSlStage');
    stage.addEventListener('touchstart', e => { const t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
    stage.addEventListener('touchend', e => {
      if (x0 === null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) nextSlide(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  // ---------- API ----------
  // show(emp)                     → รู้ตัวพนักงานแล้ว
  // show(null, { branchId })      → ยังไม่รู้ว่าใคร (หน้าลงเวลา) · ใช้สาขาจาก GPS
  // คืน Promise ที่ resolve เมื่อผู้ใช้ปิดสไลด์ (หรือไม่มีประกาศให้แสดง)
  async function show(emp, opt) {
    opt = opt || {};
    if (!window.HR || !window.HR.getImageAnnouncements) return true;
    const key = (emp && emp.emp_id) ? String(emp.emp_id) : DEV;
    const branchId = opt.branchId || (emp && emp.branch_id) || null;

    let list = [];
    try { list = await window.HR.getImageAnnouncements(key, branchId); } catch (_e) { return true; }
    // ยังไม่รู้สาขา (GPS ยังไม่จับ) → แสดงเฉพาะประกาศ "ทุกสาขา" ไปก่อน
    if (!branchId) list = list.filter(a => !Array.isArray(a.branch_ids) || !a.branch_ids.length);
    if (!opt.force) list = list.filter(a => !seenToday(key, a.id));
    if (!list.length) return true;

    ensureDom(); wire();
    S.items = list; S.i = 0; S.s = 0; S.emp = (emp && emp.emp_id) ? emp : null; S.key = key;
    document.getElementById('annSlides').style.display = 'flex';
    document.addEventListener('keydown', onKey);
    render();
    return new Promise(res => { S.done = res; });
  }

  // ผูกยอด "เปิดดูแล้ว" กับพนักงาน หลังจากเขากรอกรหัส (กรณีสไลด์เด้งไปก่อนที่จะรู้ว่าเป็นใคร)
  function claim(emp) {
    if (!emp || !emp.emp_id || !S.viewed.length) return;
    S.viewed.forEach(id => {
      markSeen(emp.emp_id, id);
      try { window.HR.markAnnouncementOpened(id, emp.emp_id, emp.nickname || emp.name, emp.branch_id); } catch (_e) { }
    });
    S.viewed = [];
  }

  window.ANN = { show, claim, _esc: esc };
})();

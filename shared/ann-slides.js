/* ============================================================
 * ann-slides.js — สไลด์ประกาศรูปภาพ (ใช้ร่วมกัน: หน้าลงเวลา + หน้ารับส่งผลัด)
 *
 * ลอยขึ้นมาเต็มจอเหมือนภาพโฆษณา · เลื่อนซ้าย-ขวาได้ (ปัดนิ้ว / ปุ่ม / ลูกศร)
 * ไม่ต้องกดรับทราบ ปิดได้เลย · แสดง "วันละครั้งต่อคนต่อประกาศ" (จำด้วย localStorage)
 * ระบบยังบันทึกให้ว่าใครเปิดดูแล้ว (announcement_acks.opened_at)
 *
 * ใช้งาน:  await window.ANN.show(emp)          // emp = { emp_id, branch_id, name, nickname }
 *          window.ANN.show(emp, { force:true }) // บังคับแสดงซ้ำ (ไม่สนใจว่าเคยดูวันนี้แล้ว)
 * ============================================================ */
(function () {
  const LS_KEY = 'ann_slides_seen';       // { "<empId>|<annId>": "YYYY-MM-DD" }

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
  function ensureDom() {
    if (document.getElementById('annSlides')) return;
    const o = document.createElement('div');
    o.id = 'annSlides';
    o.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.92);z-index:100002;display:none;align-items:center;justify-content:center;padding:14px;touch-action:pan-y';
    o.innerHTML =
      '<div id="annSlWrap" style="position:relative;max-width:560px;width:100%;max-height:92vh;display:flex;flex-direction:column;gap:8px">'
      + '<div style="display:flex;align-items:center;gap:8px">'
      + '  <div id="annSlTitle" style="flex:1;color:#fff;font-size:16px;font-weight:800;line-height:1.35;text-shadow:0 1px 4px rgba(0,0,0,.4)"></div>'
      + '  <button id="annSlClose" style="flex:none;background:rgba(255,255,255,.18);color:#fff;border:0;border-radius:50%;width:38px;height:38px;font-size:21px;line-height:1;cursor:pointer">×</button>'
      + '</div>'
      + '<div id="annSlStage" style="position:relative;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 14px 50px rgba(0,0,0,.45);flex:1;min-height:0;display:flex;align-items:center;justify-content:center">'
      + '  <img id="annSlImg" alt="" style="width:100%;height:100%;max-height:76vh;object-fit:contain;display:block;background:#fff">'
      + '  <button id="annSlPrev" style="position:absolute;left:8px;top:50%;transform:translateY(-50%);background:rgba(15,23,42,.55);color:#fff;border:0;border-radius:50%;width:44px;height:44px;font-size:26px;line-height:1;cursor:pointer">‹</button>'
      + '  <button id="annSlNext" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:rgba(15,23,42,.55);color:#fff;border:0;border-radius:50%;width:44px;height:44px;font-size:26px;line-height:1;cursor:pointer">›</button>'
      + '</div>'
      + '<div id="annSlDots" style="display:flex;gap:6px;justify-content:center;align-items:center;min-height:14px"></div>'
      + '<div id="annSlMsg" style="color:#e2e8f0;font-size:13.5px;line-height:1.6;text-align:center;max-height:22vh;overflow-y:auto;white-space:pre-wrap"></div>'
      + '<button id="annSlDone" style="width:100%;padding:13px;border:0;border-radius:12px;background:#16a34a;color:#fff;font-size:15.5px;font-weight:800;cursor:pointer">ปิด</button>'
      + '</div>';
    document.body.appendChild(o);
  }

  // ---------- สถานะ ----------
  const S = { items: [], i: 0, s: 0, emp: null, done: null };   // i = ประกาศที่เท่าไหร่ · s = สไลด์ที่เท่าไหร่

  function render() {
    const a = S.items[S.i]; if (!a) return closeAll();
    const imgs = a.images || [];
    if (S.s >= imgs.length) S.s = imgs.length - 1;
    if (S.s < 0) S.s = 0;

    const step = S.items.length > 1 ? ' (' + (S.i + 1) + '/' + S.items.length + ')' : '';
    document.getElementById('annSlTitle').textContent = (a.title || 'ประกาศ') + step;
    document.getElementById('annSlImg').src = imgs[S.s] || '';
    const msg = (a.message && a.message !== a.title) ? a.message : '';
    const mEl = document.getElementById('annSlMsg');
    mEl.textContent = msg; mEl.style.display = msg ? 'block' : 'none';

    const multi = imgs.length > 1;
    document.getElementById('annSlPrev').style.display = multi ? 'block' : 'none';
    document.getElementById('annSlNext').style.display = multi ? 'block' : 'none';
    document.getElementById('annSlDots').innerHTML = multi
      ? imgs.map((_u, k) => '<span data-k="' + k + '" style="width:' + (k === S.s ? 20 : 8) + 'px;height:8px;border-radius:999px;background:' + (k === S.s ? '#fff' : 'rgba(255,255,255,.45)') + ';cursor:pointer;transition:width .18s"></span>').join('')
      : '';
    document.getElementById('annSlDots').querySelectorAll('[data-k]').forEach(d => {
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
    // บันทึกว่าดูประกาศใบนี้แล้ว
    const a = S.items[S.i];
    if (a && S.emp) {
      markSeen(S.emp.emp_id, a.id);
      try { window.HR.markAnnouncementOpened(a.id, S.emp.emp_id, S.emp.nickname || S.emp.name, S.emp.branch_id); } catch (_e) { }
    }
    if (S.i < S.items.length - 1) { S.i++; S.s = 0; render(); }
    else closeAll();
  }

  function closeAll() {
    // ปิดกลางคัน — บันทึกใบที่กำลังดูอยู่ด้วย
    const a = S.items[S.i];
    if (a && S.emp && !seenToday(S.emp.emp_id, a.id)) {
      markSeen(S.emp.emp_id, a.id);
      try { window.HR.markAnnouncementOpened(a.id, S.emp.emp_id, S.emp.nickname || S.emp.name, S.emp.branch_id); } catch (_e) { }
    }
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
  // คืน Promise ที่ resolve เมื่อผู้ใช้ปิดสไลด์ (หรือไม่มีประกาศให้แสดง)
  async function show(emp, opt) {
    opt = opt || {};
    if (!emp || !emp.emp_id || !window.HR || !window.HR.getImageAnnouncements) return true;
    let list = [];
    try { list = await window.HR.getImageAnnouncements(emp.emp_id, emp.branch_id); } catch (_e) { return true; }
    if (!opt.force) list = list.filter(a => !seenToday(emp.emp_id, a.id));
    if (!list.length) return true;

    ensureDom(); wire();
    S.items = list; S.i = 0; S.s = 0; S.emp = emp;
    document.getElementById('annSlides').style.display = 'flex';
    document.addEventListener('keydown', onKey);
    render();
    return new Promise(res => { S.done = res; });
  }

  window.ANN = { show, _esc: esc };
})();

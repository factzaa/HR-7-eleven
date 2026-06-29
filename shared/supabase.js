// ============================================================
// 7-Eleven HR — ชั้นเชื่อมต่อ Supabase กลาง
// โหลดหลัง: <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//           <script src="../shared/config.js"></script>
// ============================================================
(function () {
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg || cfg.url.includes('YOUR-PROJECT')) {
    console.error('ยังไม่ได้ตั้งค่า shared/config.js');
  }
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey);

  // ---------- ข้อมูลตั้งต้น (config สาธารณะ) ----------
  async function loadConfig() {
    const [branches, shifts, employees] = await Promise.all([
      sb.from('branches').select('*'),
      sb.from('shifts').select('*'),
      sb.from('employees').select('emp_id,name,nickname,default_shift,branch_id,active,face_descriptor').eq('active', true),
    ]);
    return {
      branches: branches.data || [],
      shifts: shifts.data || [],
      employees: employees.data || [],
      threshold: 0.5,
    };
  }

  // ---------- อัปโหลดรูป base64 -> Storage, คืน public URL ----------
  async function uploadPhoto(bucket, path, dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    const { error } = await sb.storage.from(bucket).upload(path, blob, {
      upsert: true, contentType: blob.type || 'image/jpeg',
    });
    if (error) throw error;
    return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }

  // ---------- ลงทะเบียนใบหน้า ----------
  async function registerFace(empId, descriptor) {
    const { error } = await sb.from('employees')
      .update({ face_descriptor: descriptor }).eq('emp_id', empId);
    if (error) throw error;
    return true;
  }

  // ---------- เช็กอิน ----------
  async function checkIn({ empId, shiftId, branchId, lat, lng, accuracy, photoDataUrl, faceMatch }) {
    const today = bangkokDate();
    // กันเช็กอินซ้ำ: ถ้าวันนี้เคยเช็กอินแล้ว ไม่ให้เขียนทับ (ต้องให้ HR แก้)
    const { data: ex } = await sb.from('attendance').select('check_in,check_out').eq('emp_id', empId).eq('work_date', today).maybeSingle();
    if (ex && ex.check_in) {
      throw new Error('คุณเช็กอินไปแล้ววันนี้ เวลา ' + _fmtTime(ex.check_in) + (ex.check_out ? ' (และเช็กเอาต์แล้ว)' : '') + ' — หากต้องแก้ไข ติดต่อ HR');
    }
    let photo_url = null;
    if (photoDataUrl) {
      photo_url = await uploadPhoto('attendance-photos', `${empId}/${today}.jpg`, photoDataUrl);
    }
    // คำนวณสายผ่าน RPC
    const nowIso = new Date().toISOString();
    const { data: lateMin } = await sb.rpc('calc_late_min', { p_shift_id: shiftId, p_check_in: nowIso });

    const { error } = await sb.from('attendance').upsert({
      emp_id: empId, work_date: today, shift_id: shiftId, branch_id: branchId,
      check_in: nowIso, late_min: lateMin || 0,
      photo_url, gps_lat: lat, gps_lng: lng, gps_accuracy: accuracy,
      face_match: faceMatch, status: 'OPEN',
    }, { onConflict: 'emp_id,work_date' });
    if (error) throw error;
    return { late_min: lateMin || 0 };
  }

  // ---------- เช็กเอาท์ ----------
  async function checkOut({ empId, shiftId }) {
    const today = bangkokDate();
    const { data: row } = await sb.from('attendance')
      .select('check_in').eq('emp_id', empId).eq('work_date', today).maybeSingle();
    const nowIso = new Date().toISOString();
    let ot = 0;
    if (row?.check_in) {
      const { data: sh } = await sb.from('shifts').select('end_time').eq('shift_id', shiftId).maybeSingle();
      ot = computeOt(nowIso, sh?.end_time);
    }
    const { error } = await sb.from('attendance')
      .update({ check_out: nowIso, ot_hours: ot, status: 'CLOSED' })
      .eq('emp_id', empId).eq('work_date', today);
    if (error) throw error;
    return { ot_hours: ot };
  }

  // ---------- สถานะการลงเวลาวันนี้ (ไว้สลับปุ่มเข้า/ออก) ----------
  async function todayAttendance(empId) {
    if (!empId) return null;
    const { data } = await sb.from('attendance').select('check_in,check_out,status,late_min')
      .eq('emp_id', empId).eq('work_date', bangkokDate()).maybeSingle();
    return data || null;
  }

  // ---------- สถานะของฉัน (พนักงานตรวจวินัยตนเอง — ไม่แสดง OT) ----------
  async function selfStatus(empId) {
    const today = bangkokDate();
    const cyc = cycleRange21();
    const endEff = cyc.end < today ? cyc.end : today;
    const [empR, attR, holR, lvR] = await Promise.all([
      sb.from('employees').select('emp_id,name,nickname,default_shift,branch_id,weekly_off').eq('emp_id', empId).maybeSingle(),
      sb.from('attendance').select('work_date,check_in,late_min,status').eq('emp_id', empId).gte('work_date', cyc.start).lte('work_date', endEff),
      sb.from('holidays').select('date').eq('active', true).gte('date', cyc.start).lte('date', cyc.end),
      sb.from('leaves').select('start_date,end_date,status').eq('emp_id', empId).eq('status', 'approved').lte('start_date', cyc.end).gte('end_date', cyc.start),
    ]);
    if (empR.error) throw empR.error;
    if (!empR.data) throw new Error('ไม่พบรหัสพนักงานนี้');
    const att = attR.data || [];
    const todayRow = att.find(a => a.work_date === today);
    const late = att.filter(a => a.late_min > 0);
    const worked = new Set(att.filter(a => a.check_in).map(a => a.work_date));
    const holidaySet = new Set((holR.data || []).map(h => h.date));
    let leave_days = 0;
    (lvR.data || []).forEach(l => {
      const s = l.start_date < cyc.start ? cyc.start : l.start_date;
      const e = (l.end_date || l.start_date) > endEff ? endEff : (l.end_date || l.start_date);
      if (s <= e) leave_days += _daysBetween(s, e);
    });
    const days_should = _workingDays(cyc.start, endEff, empR.data.weekly_off, holidaySet);
    const days_worked = worked.size;
    const late_count = late.length;
    const late_total = late.reduce((s, a) => s + (a.late_min || 0), 0);
    const absent = Math.max(0, days_should - days_worked - leave_days);
    const level = _disciplineLevel(late_count, absent);
    return {
      emp: empR.data, cycle: cyc,
      today: {
        checked_in: !!(todayRow && todayRow.check_in),
        check_in_time: (todayRow && todayRow.check_in) ? _fmtTime(todayRow.check_in) : null,
        late_min: todayRow ? (todayRow.late_min || 0) : 0,
        status: todayRow ? todayRow.status : null,
      },
      stats: { days_worked, days_should, late_count, late_total, absent, leave_days },
      level,
    };
  }

  // ---------- helper ----------
  function bangkokDate() {
    const d = new Date(Date.now() + 7 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }
  const _iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  function cycleRange21() {
    const t = new Date(bangkokDate() + 'T00:00:00');
    const day = t.getDate();
    const endRef = (day <= 20) ? new Date(t.getFullYear(), t.getMonth(), 20) : new Date(t.getFullYear(), t.getMonth() + 1, 20);
    const end = new Date(endRef.getFullYear(), endRef.getMonth(), 20);
    const start = new Date(endRef.getFullYear(), endRef.getMonth() - 1, 21);
    return { start: _iso(start), end: _iso(end) };
  }
  function _daysBetween(a, b) { const s = new Date(a + 'T00:00:00'), e = new Date((b || a) + 'T00:00:00'); return Math.round((e - s) / 86400000) + 1; }
  const _DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  function _workingDays(start, end, weeklyOff, holidaySet) {
    const off = new Set(); String(weeklyOff || '').split(',').map(x => x.trim().toLowerCase().slice(0, 3)).forEach(x => { if (x in _DOW) off.add(_DOW[x]); });
    let n = 0; const d = new Date(start + 'T00:00:00'), e = new Date(end + 'T00:00:00');
    for (; d <= e; d.setDate(d.getDate() + 1)) { if (off.has(d.getDay())) continue; if (holidaySet.has(_iso(d))) continue; n++; }
    return n;
  }
  function _fmtTime(ts) { try { return new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false }); } catch (e) { return ''; } }
  function _disciplineLevel(lateCount, absent) {
    if (lateCount >= 10 || absent >= 3) return { level: 4, name: 'ใบเตือนระดับ 2', color: '#b91c1c', message: '⚠️ เข้าข่ายใบเตือนระดับสูง กรุณาปรับปรุงการมาทำงานโดยด่วน' };
    if (lateCount >= 7  || absent >= 2) return { level: 3, name: 'ใบเตือนระดับ 1', color: '#ea580c', message: '⚠️ คุณเข้าข่ายได้รับใบเตือน โปรดระวังการมาสาย/ขาดงาน' };
    if (lateCount >= 5  || absent >= 1) return { level: 2, name: 'ตักเตือนลายลักษณ์อักษร', color: '#d97706', message: 'โปรดระวัง หากสะสมเพิ่มอาจเข้าข่ายใบเตือน' };
    if (lateCount >= 3)                 return { level: 1, name: 'ตักเตือนด้วยวาจา', color: '#ca8a04', message: 'เริ่มมาสายบ่อย ควรปรับปรุงให้ตรงเวลา' };
    return { level: 0, name: 'ดีเยี่ยม', color: '#16a34a', message: 'รักษาวินัยได้ดีมาก ขอให้รักษามาตรฐานนี้ไว้ 👍' };
  }
  function computeOt(checkOutIso, endTime) {
    if (!endTime) return 0;
    const out = new Date(checkOutIso);
    const [h, m] = endTime.split(':').map(Number);
    const endLocal = new Date(out);
    endLocal.setHours(h, m, 0, 0);
    let diff = (out - endLocal) / 3600000;       // ชั่วโมง
    if (diff < 0) diff = 0;
    return Math.round(diff * 100) / 100;
  }

  // ---------- เงื่อนไขการลา ----------
  function _inclusiveDays(a, b) { const s = new Date(a + 'T00:00:00'), e = new Date((b || a) + 'T00:00:00'); return Math.round((e - s) / 86400000) + 1; }
  function _diffDays(from, to) { const s = new Date(from + 'T00:00:00'), e = new Date(to + 'T00:00:00'); return Math.round((e - s) / 86400000); }
  async function getLeaveRules() {
    const { data } = await sb.from('leave_types').select('*').eq('active', true).order('sort');
    return data || [];
  }
  async function getLeaveUsage(empId) {
    const yr = bangkokDate().slice(0, 4);
    const { data } = await sb.from('leaves').select('type,start_date,end_date,status')
      .eq('emp_id', empId).in('status', ['approved', 'pending'])
      .gte('start_date', yr + '-01-01').lte('start_date', yr + '-12-31');
    const used = {};
    (data || []).forEach(l => { used[l.type] = (used[l.type] || 0) + _inclusiveDays(l.start_date, l.end_date || l.start_date); });
    return used;
  }

  // ---------- พนักงานส่งคำขอลา (รออนุมัติ) ----------
  async function requestLeave({ empId, start_date, end_date, type, reason, doc }) {
    if (!empId || !start_date) throw new Error('ต้องระบุรหัสพนักงานและวันที่');
    const emp = await lookupEmployee(empId);
    if (!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    if (emp.active === false) throw new Error('รหัสพนักงานนี้ถูกปิดใช้งาน');
    const end = end_date || start_date;
    const today = bangkokDate();
    // เงื่อนไขตามประเภทการลา
    const { data: rule } = await sb.from('leave_types').select('*').eq('type', type).maybeSingle();
    if (rule) {
      if (!rule.allow_backdate && start_date < today)
        throw new Error('ประเภท "' + type + '" ลาย้อนหลังไม่ได้');
      if (!rule.allow_backdate && rule.advance_days > 0 && _diffDays(today, start_date) < rule.advance_days)
        throw new Error('ประเภท "' + type + '" ต้องลาล่วงหน้าอย่างน้อย ' + rule.advance_days + ' วัน');
      if (rule.quota_per_year != null) {
        const usage = await getLeaveUsage(empId);
        const used = usage[type] || 0;
        const reqDays = _inclusiveDays(start_date, end);
        if (used + reqDays > rule.quota_per_year)
          throw new Error('เกินโควตา "' + type + '" (' + rule.quota_per_year + ' วัน/ปี) — ใช้ไปแล้ว ' + used + ' วัน ขอเพิ่ม ' + reqDays + ' วัน');
      }
      if (rule.require_doc && !doc)
        throw new Error('ประเภท "' + type + '" ต้องแนบเอกสาร (เช่น ใบรับรองแพทย์)');
    }
    // ทับวันที่ถูกจัดไปทำแทนสาขา → บล็อก
    const { data: cov } = await sb.from('schedules').select('work_date')
      .eq('emp_id', empId).eq('is_cover', true).gte('work_date', start_date).lte('work_date', end);
    if (cov && cov.length)
      throw new Error('ช่วงนี้คุณถูกจัดไปทำแทนสาขา (' + cov.map(c => c.work_date).join(', ') + ') กรุณาติดต่อ HR ก่อนลา');
    // อัปโหลดเอกสารแนบ (ถ้ามี)
    let doc_url = null;
    if (doc) doc_url = await uploadPhoto('employee-docs', empId + '/leave_' + Date.now() + '.jpg', doc);
    const row = { emp_id: empId, start_date, end_date: end, type: type || null, reason: reason || null, status: 'pending', doc_url };
    const { error } = await sb.from('leaves').insert(row);
    if (error) throw error;
    return { ok: true };
  }
  // ---------- ใบลาของฉัน (ดูสถานะ + เหตุผลปฏิเสธ) ----------
  async function myLeaves(empId) {
    const { data, error } = await sb.from('leaves')
      .select('leave_id,start_date,end_date,type,reason,status,hr_note,created_at')
      .eq('emp_id', empId).order('start_date', { ascending: false }).limit(10);
    if (error) throw error;
    return data || [];
  }

  // ---------- พนักงานกรอกข้อมูลตัวเอง + อัปเอกสาร (รอ HR อนุมัติ) ----------
  async function lookupEmployee(empId) {
    const { data } = await sb.from('employees').select('emp_id,name,nickname,active,branch_id,default_shift').eq('emp_id', empId).maybeSingle();
    return data || null;
  }
  async function submitProfile(p) {
    const emp = await lookupEmployee(p.empId);
    if (!emp) throw new Error('ไม่พบรหัสพนักงานนี้ (ให้ HR สร้างรหัสก่อน)');
    if (emp.active === false) throw new Error('รหัสพนักงานนี้ถูกปิดใช้งาน');
    const base = p.empId + '/' + Date.now();
    const up = async (val, name) => val ? await uploadPhoto('employee-docs', base + '_' + name + '.jpg', val) : null;
    const row = {
      emp_id: p.empId, name: p.name || emp.name, nickname: p.nickname || null,
      phone: p.phone || null, address: p.address || null,
      emergency_name: p.emergency_name || null, emergency_phone: p.emergency_phone || null,
      bank_name: p.bank_name || null, bank_account: p.bank_account || null, id_card: p.id_card || null,
      photo_url: await up(p.photo, 'photo'),
      idcard_url: await up(p.idcard, 'idcard'),
      bankbook_url: await up(p.bankbook, 'bankbook'),
      house_url: await up(p.house, 'house'),
      edu_url: await up(p.edu, 'edu'),
      status: 'pending',
    };
    const { error } = await sb.from('profile_submissions').insert(row);
    if (error) throw error;
    return { ok: true };
  }

  // ---------- รับทราบ/ยอมรับระเบียบการทำงาน ----------
  async function acceptRules(empId, version) {
    const emp = await lookupEmployee(empId);
    if (!emp) throw new Error('ไม่พบรหัสพนักงานนี้ (ติดต่อ HR)');
    if (emp.active === false) throw new Error('รหัสพนักงานนี้ถูกปิดใช้งาน');
    const { error } = await sb.from('rule_acks').insert({ emp_id: empId, version });
    if (error) throw error;
    return { ok: true, name: emp.name };
  }
  async function getRuleAck(empId, version) {
    const { data } = await sb.from('rule_acks').select('accepted_at')
      .eq('emp_id', empId).eq('version', version).order('accepted_at', { ascending: false }).limit(1).maybeSingle();
    return data || null;
  }

  // ---------- ส่ง/รับผลัด (Shift Handover) ----------
  async function submitHandover(p) {
    const emp = await lookupEmployee(p.empId);
    if (!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    if (emp.active === false) throw new Error('รหัสพนักงานนี้ถูกปิดใช้งาน');
    let photo_url = null;
    if (p.photo) photo_url = await uploadPhoto('employee-docs', 'handover/' + (emp.branch_id || 'x') + '_' + Date.now() + '.jpg', p.photo);
    const row = {
      branch_id: emp.branch_id || null, shift_id: emp.default_shift || null, work_date: bangkokDate(),
      from_emp_id: emp.emp_id, from_name: emp.nickname || emp.name,
      status: 'sent', checklist: p.checklist || {},
      done_count: p.done_count || 0, total_count: p.total_count || 0,
      pending_work: p.pending_work || null, issues: p.issues || null, photo_url,
    };
    const { error } = await sb.from('handovers').insert(row);
    if (error) throw error;
    return { ok: true, branch_id: row.branch_id };
  }
  // ผลัดที่รอรับของสาขานี้วันนี้ (ล่าสุดที่ยังไม่ถูกรับ)
  async function getPendingHandover(branchId) {
    if (!branchId) return null;
    const { data } = await sb.from('handovers').select('*')
      .eq('branch_id', branchId).eq('work_date', bangkokDate()).eq('status', 'sent')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data || null;
  }
  // คนกะถัดไปกดยืนยันรับผลัด (หรือแจ้งไม่เรียบร้อย)
  async function receiveHandover({ id, empId, status, note }) {
    const emp = await lookupEmployee(empId);
    if (!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const upd = {
      to_emp_id: emp.emp_id, to_name: emp.nickname || emp.name,
      status: status === 'rejected' ? 'rejected' : 'received',
      receiver_note: note || null, received_at: new Date().toISOString(),
    };
    const { error } = await sb.from('handovers').update(upd).eq('id', id);
    if (error) throw error;
    return { ok: true };
  }
  // คนกะถัดไปแจ้งว่า "ไม่มีการส่งผลัด" → HR ได้รับแจ้งเตือน
  async function reportNoHandover({ empId, note }) {
    const emp = await lookupEmployee(empId);
    if (!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const row = {
      branch_id: emp.branch_id || null, shift_id: emp.default_shift || null, work_date: bangkokDate(),
      to_emp_id: emp.emp_id, to_name: emp.nickname || emp.name,
      status: 'no_handover', receiver_note: note || null, received_at: new Date().toISOString(),
    };
    const { error } = await sb.from('handovers').insert(row);
    if (error) throw error;
    return { ok: true };
  }

  // ---------- งานในกะ (Shift Tasks) ----------
  // งานของฉันวันนี้
  async function getMyTasks(empId) {
    if (!empId) return [];
    const { data } = await sb.from('task_assignments').select('*')
      .eq('emp_id', empId).eq('work_date', bangkokDate())
      .order('status', { ascending: true }).order('id', { ascending: true });
    return data || [];
  }
  // ส่งงาน (แนบรูปถ้าต้องการ) — ใช้ตอนส่งครั้งแรกหรือแก้หลังถูกตีกลับ
  async function submitTask({ id, empId, photo, note }) {
    const row = (await sb.from('task_assignments').select('require_photo,branch_id').eq('id', id).maybeSingle()).data;
    if (!row) throw new Error('ไม่พบงานนี้');
    let photo_url = null;
    if (photo) photo_url = await uploadPhoto('employee-docs', 'task/' + (row.branch_id || 'x') + '_' + id + '_' + Date.now() + '.jpg', photo);
    if (row.require_photo && !photo_url) throw new Error('งานนี้ต้องแนบรูปก่อนส่ง');
    const upd = { status: 'submitted', emp_note: note || null, submitted_at: new Date().toISOString(), reviewer: null, review_note: null, reviewed_at: null };
    if (photo_url) upd.photo_url = photo_url;
    const { error } = await sb.from('task_assignments').update(upd).eq('id', id);
    if (error) throw error;
    return { ok: true };
  }
  // (ผู้ตรวจหน้างาน) งานที่ส่งแล้วของสาขานี้วันนี้ — ไว้ตรวจ/ตีกลับ
  async function getBranchTasks(branchId) {
    if (!branchId) return [];
    const { data } = await sb.from('task_assignments').select('*')
      .eq('branch_id', branchId).eq('work_date', bangkokDate()).eq('status', 'submitted')
      .order('submitted_at', { ascending: true });
    return data || [];
  }
  // ตรวจงาน: ผ่าน (approved) หรือ ตีกลับ (sent_back) — โดยพนักงาน(หัวหน้า)หรือคนรับผลัด
  async function reviewTask({ id, reviewerId, status, note }) {
    let reviewer = 'หัวหน้า';
    if (reviewerId) { const e = await lookupEmployee(reviewerId); if (e) reviewer = e.nickname || e.name; }
    const upd = {
      status: status === 'approved' ? 'approved' : 'sent_back',
      reviewer, review_note: note || null, reviewed_at: new Date().toISOString(),
    };
    const { error } = await sb.from('task_assignments').update(upd).eq('id', id);
    if (error) throw error;
    return { ok: true };
  }

  // ---------- กระดานงานตามกะ (พนักงานหยิบทำเอง/แบ่งงานกันเอง) ----------
  // เห็นงานของกะ + สถานะใครทำ + เพื่อนร่วมสาขา (ไว้แบ่งงาน) + รายการกะ
  async function getShiftBoard(empId, shiftId) {
    const emp = await lookupEmployee(empId);
    if (!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const today = bangkokDate();
    const group = shiftId || await _empGroup(emp);   // ผลัดหลัก (เช้า/บ่าย/ดึก หรือ กะพิเศษ)
    const [defsR, asgR, schR, empsR, shR] = await Promise.all([
      sb.from('task_defs').select('*').eq('active', true).order('sort'),
      sb.from('task_assignments').select('*').eq('branch_id', emp.branch_id || '').eq('work_date', today).eq('shift_id', group),
      sb.from('schedules').select('emp_id,shift_id').eq('branch_id', emp.branch_id || '').eq('work_date', today),
      sb.from('employees').select('emp_id,name,nickname').eq('active', true).eq('branch_id', emp.branch_id || ''),
      sb.from('shifts').select('shift_id,name,main_shift').order('start_time'),
    ]);
    const nameOf = {}; (empsR.data || []).forEach(e => { nameOf[e.emp_id] = e.nickname || e.name; });
    const grpOf = {}; (shR.data || []).forEach(s => { grpOf[s.shift_id] = s.main_shift || s.shift_id; });
    const memberIds = [...new Set((schR.data || []).filter(r => grpOf[r.shift_id] === group).map(r => r.emp_id))];
    const defs = (defsR.data || []).filter(d => !d.shift_id || d.shift_id === group);
    const byDef = {}; (asgR.data || []).forEach(a => { byDef[a.task_def_id] = a; });
    return {
      emp, shift: group, shifts: shR.data || [],
      members: memberIds.map(id => ({ emp_id: id, name: nameOf[id] || id })),       // คนในกะวันนี้ (จากตารางเวรจริง)
      colleagues: (empsR.data || []).map(e => ({ emp_id: e.emp_id, name: e.nickname || e.name })), // ทุกคนในสาขา (ไว้เพิ่มเข้ากะ)
      scheduled: memberIds.includes(emp.emp_id),
      defs: defs.map(d => ({ id: d.id, title: d.title, require_photo: !!d.require_photo, assignment: byDef[d.id] || null })),
    };
  }
  // หัวหน้าผลัด: กรอกรหัสซ้ำเพื่อรับเป็นคนคุมผลัดวันนี้ (บันทึก Log)
  async function leaderLogin(empId, shiftId) {
    const emp = await lookupEmployee(empId);
    if (!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    if (emp.active === false) throw new Error('รหัสนี้ถูกปิดใช้งาน');
    const today = bangkokDate();
    let shift = shiftId;
    if (!shift) {
      const sc = (await sb.from('schedules').select('shift_id').eq('emp_id', emp.emp_id).eq('work_date', today).maybeSingle()).data;
      shift = (sc && sc.shift_id) || emp.default_shift || '';
    }
    await sb.from('shift_leads').upsert({ work_date: today, branch_id: emp.branch_id || null, shift_id: shift, emp_id: emp.emp_id, emp_name: emp.nickname || emp.name }, { onConflict: 'work_date,branch_id,shift_id' });
    try { await sb.from('activity_log').insert({ action: 'คุมผลัด', emp_id: emp.emp_id, detail: 'รับเป็นหัวหน้าผลัด กะ ' + (shift || '-') + ' สาขา ' + (emp.branch_id || '-'), actor: emp.nickname || emp.name }); } catch (e) {}
    return { ok: true, emp, shift, branch_id: emp.branch_id || '' };
  }
  // เพิ่มคนเข้ากะวันนี้เฉพาะกิจ (กรณียังไม่จัดตารางเวร) = สร้างแถวตารางเวรของวันนี้
  async function addShiftMember({ branchId, shiftId, empId }) {
    const e = await lookupEmployee(empId);
    if (!e) throw new Error('ไม่พบรหัสพนักงานที่จะเพิ่ม');
    const today = bangkokDate();
    const { error } = await sb.from('schedules').upsert({ emp_id: e.emp_id, work_date: today, shift_id: shiftId || null, branch_id: branchId || e.branch_id || null, is_cover: false, note: 'เพิ่มเข้ากะเฉพาะกิจ' }, { onConflict: 'emp_id,work_date' });
    if (error) throw error;
    return { ok: true, name: e.nickname || e.name };
  }
  // หางาน assignment เดิมของ (สาขา+วัน+กะ+งาน)
  async function _findAsg(branch, today, shift, defId) {
    return (await sb.from('task_assignments').select('id').eq('branch_id', branch || '').eq('work_date', today).eq('shift_id', shift).eq('task_def_id', defId).maybeSingle()).data;
  }
  // พนักงานกดทำงานนี้เอง + บันทึกว่าเป็นผู้ทำ (ส่งเลย)
  async function doTaskSelf({ empId, task_def_id, shiftId, photo, note }) {
    const emp = await lookupEmployee(empId);
    if (!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const def = (await sb.from('task_defs').select('*').eq('id', task_def_id).maybeSingle()).data;
    if (!def) throw new Error('ไม่พบงานนี้');
    const shift = shiftId || emp.default_shift || '';
    const today = bangkokDate();
    let photo_url = null;
    if (photo) photo_url = await uploadPhoto('employee-docs', 'task/' + (emp.branch_id || 'x') + '_' + task_def_id + '_' + Date.now() + '.jpg', photo);
    if (def.require_photo && !photo_url) throw new Error('งานนี้ต้องแนบรูปก่อนส่ง');
    const base = { emp_id: emp.emp_id, emp_name: emp.nickname || emp.name, status: 'submitted', emp_note: note || null, submitted_at: new Date().toISOString(), reviewer: null, review_note: null, reviewed_at: null };
    if (photo_url) base.photo_url = photo_url;
    const existing = await _findAsg(emp.branch_id, today, shift, task_def_id);
    if (existing) { const { error } = await sb.from('task_assignments').update(base).eq('id', existing.id); if (error) throw error; }
    else { const { error } = await sb.from('task_assignments').insert(Object.assign({ work_date: today, branch_id: emp.branch_id || null, shift_id: shift, task_def_id, title: def.title, require_photo: !!def.require_photo }, base)); if (error) throw error; }
    return { ok: true };
  }
  // หัวหน้าผลัดแบ่งงานให้เพื่อนในกะ (มอบหมาย — ยังไม่ส่ง)
  async function assignColleague({ byEmpId, toEmpId, task_def_id, shiftId }) {
    const by = await lookupEmployee(byEmpId); if (!by) throw new Error('ไม่พบรหัสผู้แบ่งงาน');
    const to = await lookupEmployee(toEmpId); if (!to) throw new Error('ไม่พบพนักงานที่จะมอบ');
    const def = (await sb.from('task_defs').select('*').eq('id', task_def_id).maybeSingle()).data;
    if (!def) throw new Error('ไม่พบงานนี้');
    const shift = shiftId || await _empGroup(by) || '';
    const today = bangkokDate();
    const base = { emp_id: to.emp_id, emp_name: to.nickname || to.name, status: 'todo', photo_url: null, emp_note: null, submitted_at: null, reviewer: null, review_note: null, reviewed_at: null };
    const existing = await _findAsg(by.branch_id, today, shift, task_def_id);
    if (existing) { const { error } = await sb.from('task_assignments').update(base).eq('id', existing.id); if (error) throw error; }
    else { const { error } = await sb.from('task_assignments').insert(Object.assign({ work_date: today, branch_id: by.branch_id || null, shift_id: shift, task_def_id, title: def.title, require_photo: !!def.require_photo }, base)); if (error) throw error; }
    return { ok: true };
  }

  // ===== ระบบงานผลัดใหม่ (เฟส 1) =====
  function _addDays(dateStr, n){ const d=new Date(dateStr+'T00:00:00'); d.setDate(d.getDate()+n); return _iso(d); }
  async function _empShiftToday(emp){
    const today=bangkokDate();
    const sc=(await sb.from('schedules').select('shift_id').eq('emp_id',emp.emp_id).eq('work_date',today).maybeSingle()).data;
    return (sc&&sc.shift_id)||emp.default_shift||'';
  }
  async function _prevShift(curShift){
    const today=bangkokDate();
    const list=(await sb.from('shifts').select('shift_id,name,start_time').order('start_time')).data||[];
    const idx=list.findIndex(s=>s.shift_id===curShift);
    if(idx<0) return { shift:null, date:today, list };
    if(idx===0) return { shift:list[list.length-1]||null, date:_addDays(today,-1), list };  // กะแรก → ผลัดก่อนหน้า = กะสุดท้ายเมื่อวาน
    return { shift:list[idx-1], date:today, list };
  }
  // ---- ผลัดหลัก (จัดกลุ่ม): group = main_shift ของกะ (ว่าง = ใช้ shift_id เดิม = พิเศษ) ----
  async function _empGroup(emp){
    const today=bangkokDate();
    const sc=(await sb.from('schedules').select('shift_id').eq('emp_id',emp.emp_id).eq('work_date',today).maybeSingle()).data;
    const raw=(sc&&sc.shift_id)||emp.default_shift||'';
    if(!raw) return '';
    const sh=(await sb.from('shifts').select('main_shift').eq('shift_id',raw).maybeSingle()).data;
    return (sh&&sh.main_shift)||raw;
  }
  // ผลัดหลักก่อนหน้า (วนเฉพาะกะที่เป็นผลัดหลัก main_shift===shift_id เรียงตามเวลาเริ่ม)
  async function _prevMainGroup(group){
    const today=bangkokDate();
    const list=(await sb.from('shifts').select('shift_id,main_shift,start_time').order('start_time')).data||[];
    const chain=list.filter(s=>s.main_shift && s.main_shift===s.shift_id).map(s=>s.shift_id);
    const idx=chain.indexOf(group);
    if(idx<0) return { group:null, date:today, isMain:false };
    if(idx===0) return { group: chain[chain.length-1]||null, date:_addDays(today,-1), isMain:true };  // ผลัดหลักแรก → ก่อนหน้า = ผลัดหลักสุดท้ายเมื่อวาน
    return { group: chain[idx-1], date:today, isMain:true };
  }
  async function _shiftName(group){
    if(!group) return '';
    const s=(await sb.from('shifts').select('name').eq('shift_id',group).maybeSingle()).data;
    return s?s.name:group;
  }

  // เมนู 1: หัวหน้าผลัด — ดูสถานะ / ยืนยัน (โอนสิทธิ์ได้)
  async function leaderInfo(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    if(emp.active===false) throw new Error('รหัสนี้ถูกปิดใช้งาน');
    const today=bangkokDate(); const shift=await _empGroup(emp);
    const lead=(await sb.from('shift_leads').select('emp_id,emp_name').eq('work_date',today).eq('branch_id',emp.branch_id||'').eq('shift_id',shift).maybeSingle()).data;
    const sh=(await sb.from('shifts').select('name').eq('shift_id',shift).maybeSingle()).data;
    return { emp, shift, shift_name: sh?sh.name:shift, branch_id:emp.branch_id||'',
      currentLeader: lead?{ emp_id:lead.emp_id, name:lead.emp_name }:null, isMe: !!(lead&&lead.emp_id===emp.emp_id) };
  }
  async function leaderConfirm(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const today=bangkokDate(); const shift=await _empGroup(emp);
    await sb.from('shift_leads').upsert({ work_date:today, branch_id:emp.branch_id||null, shift_id:shift, emp_id:emp.emp_id, emp_name:emp.nickname||emp.name }, { onConflict:'work_date,branch_id,shift_id' });
    try{ await sb.from('activity_log').insert({ action:'คุมผลัด', emp_id:emp.emp_id, detail:'รับเป็นหัวหน้าผลัด กะ '+(shift||'-')+' สาขา '+(emp.branch_id||'-'), actor:emp.nickname||emp.name }); }catch(e){}
    return { ok:true, emp, shift };
  }

  // เมนู 2: งานที่ได้รับมอบหมาย (ของฉัน / ทีม / ยังว่าง)
  async function getMyAssignments(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const today=bangkokDate(); const shift=await _empGroup(emp);
    const [defsR, asgR, shR, leadR] = await Promise.all([
      sb.from('task_defs').select('*').eq('active',true).order('sort'),
      sb.from('task_assignments').select('*').eq('branch_id',emp.branch_id||'').eq('work_date',today).eq('shift_id',shift),
      sb.from('shifts').select('name').eq('shift_id',shift).maybeSingle(),
      sb.from('shift_leads').select('emp_id,emp_name').eq('work_date',today).eq('branch_id',emp.branch_id||'').eq('shift_id',shift).maybeSingle(),
    ]);
    const defs=(defsR.data||[]).filter(d=>!d.shift_id||d.shift_id===shift);
    const asg=asgR.data||[]; const byDef={}; asg.forEach(a=>{ byDef[a.task_def_id]=a; });
    return { emp, shift, shift_name: shR.data?shR.data.name:shift,
      leader: leadR.data?{ emp_id:leadR.data.emp_id, name:leadR.data.emp_name }:null,
      mine: asg.filter(a=>a.emp_id===emp.emp_id), team: asg,
      unassigned: defs.filter(d=>!byDef[d.id]).map(d=>({ id:d.id, title:d.title, min_photos:d.min_photos||0 })) };
  }
  async function pullTask({ empId, task_def_id }){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const def=(await sb.from('task_defs').select('*').eq('id',task_def_id).maybeSingle()).data; if(!def) throw new Error('ไม่พบงานนี้');
    const today=bangkokDate(); const shift=await _empGroup(emp);
    const existing=await _findAsg(emp.branch_id,today,shift,task_def_id);
    const base={ emp_id:emp.emp_id, emp_name:emp.nickname||emp.name, status:'todo', photos:null, photo_url:null, emp_note:null, submitted_at:null, reviewer:null, review_note:null, reviewed_at:null };
    if(existing){ const {error}=await sb.from('task_assignments').update(base).eq('id',existing.id); if(error) throw error; }
    else { const {error}=await sb.from('task_assignments').insert(Object.assign({ work_date:today, branch_id:emp.branch_id||null, shift_id:shift, task_def_id, title:def.title, require_photo:(def.min_photos||0)>0 }, base)); if(error) throw error; }
    return { ok:true };
  }
  async function submitTaskMulti({ id, empId, photos, note }){
    const row=(await sb.from('task_assignments').select('branch_id,task_def_id').eq('id',id).maybeSingle()).data; if(!row) throw new Error('ไม่พบงานนี้');
    const def=(await sb.from('task_defs').select('min_photos').eq('id',row.task_def_id).maybeSingle()).data;
    const minP=def?(def.min_photos||0):0;
    const urls=[];
    for(const p of (photos||[])){ if(p) urls.push(await uploadPhoto('employee-docs','task/'+(row.branch_id||'x')+'_'+id+'_'+Date.now()+'_'+urls.length+'.jpg', p)); }
    if(urls.length < minP) throw new Error('งานนี้ต้องแนบรูปอย่างน้อย '+minP+' รูป');
    const upd={ status:'submitted', emp_note:note||null, submitted_at:new Date().toISOString(), reviewer:null, review_note:null, reviewed_at:null };
    if(urls.length){ upd.photos=urls; upd.photo_url=urls[0]; }
    const {error}=await sb.from('task_assignments').update(upd).eq('id',id); if(error) throw error;
    return { ok:true };
  }

  // เมนู 3: ตรวจผลัดก่อนหน้า (เฉพาะหัวหน้าผลัดถัดไป)
  async function getPrevShiftReview(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const today=bangkokDate(); const curGroup=await _empGroup(emp);
    const pv=await _prevMainGroup(curGroup);
    const lead=(await sb.from('shift_leads').select('emp_id').eq('work_date',today).eq('branch_id',emp.branch_id||'').eq('shift_id',curGroup).maybeSingle()).data;
    const canReview=!!(lead&&lead.emp_id===emp.emp_id)&&pv.isMain;   // ตรวจได้เฉพาะหัวหน้าผลัดของผลัดหลัก
    let tasks=[];
    if(pv.group) tasks=(await sb.from('task_assignments').select('*').eq('branch_id',emp.branch_id||'').eq('work_date',pv.date).eq('shift_id',pv.group).order('id')).data||[];
    return { emp, curShift:curGroup, cur_name:await _shiftName(curGroup), prev_shift: pv.group, prev_name: pv.group?(await _shiftName(pv.group)):'-', prev_date: pv.date, isMain:pv.isMain, canReview, tasks };
  }
  async function reviewPrevTask({ reviewerId, id, status, note }){
    const emp=await lookupEmployee(reviewerId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const today=bangkokDate(); const curGroup=await _empGroup(emp);
    const lead=(await sb.from('shift_leads').select('emp_id').eq('work_date',today).eq('branch_id',emp.branch_id||'').eq('shift_id',curGroup).maybeSingle()).data;
    if(!lead||lead.emp_id!==emp.emp_id) throw new Error('เฉพาะหัวหน้าผลัดเท่านั้นที่ตรวจได้');
    const task=(await sb.from('task_assignments').select('shift_id,work_date,sent_back_count').eq('id',id).maybeSingle()).data; if(!task) throw new Error('ไม่พบงานนี้');
    const pv=await _prevMainGroup(curGroup);
    if(!pv.group || task.shift_id!==pv.group || String(task.work_date)!==pv.date) throw new Error('ตรวจได้เฉพาะงานของผลัดก่อนหน้าเท่านั้น');
    const upd={ status: status==='approved'?'approved':'sent_back', reviewer: emp.nickname||emp.name, review_note:note||null, reviewed_at:new Date().toISOString() };
    if(status!=='approved') upd.sent_back_count=(task.sent_back_count||0)+1;
    const {error}=await sb.from('task_assignments').update(upd).eq('id',id); if(error) throw error;
    return { ok:true };
  }

  // รายงานรับส่งผลัด (พนักงานดูสาขาตัวเอง)
  async function getHandoverReport({ empId, date }){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const d=date||bangkokDate();
    const [asgR, shR] = await Promise.all([
      sb.from('task_assignments').select('*').eq('branch_id',emp.branch_id||'').eq('work_date',d).order('shift_id').order('id'),
      sb.from('shifts').select('shift_id,name,start_time').order('start_time'),
    ]);
    return { emp, date:d, shifts: shR.data||[], rows: asgR.data||[] };
  }

  // export
  window.HR = { sb, loadConfig, uploadPhoto, registerFace, checkIn, checkOut, bangkokDate, todayAttendance, selfStatus, requestLeave, myLeaves, lookupEmployee, submitProfile, getLeaveRules, getLeaveUsage, acceptRules, getRuleAck, submitHandover, getPendingHandover, receiveHandover, reportNoHandover, getMyTasks, submitTask, getBranchTasks, reviewTask, getShiftBoard, doTaskSelf, assignColleague, leaderLogin, addShiftMember, leaderInfo, leaderConfirm, getMyAssignments, pullTask, submitTaskMulti, getPrevShiftReview, reviewPrevTask, getHandoverReport };
})();

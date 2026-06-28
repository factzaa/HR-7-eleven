// ============================================================
// 7-Eleven HR — ชั้น backend ของหน้า HR (แทน Google Apps Script)
// ใช้ผ่าน window.HRAPI.dispatch(payload) -> คืน response รูปแบบเดิม { ok, ... }
// ต้องโหลดหลัง shared/supabase.js (ใช้ window.HR.sb)
// ============================================================
(function () {
  const sb = () => window.HR.sb;

  // ---------- helpers ----------
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const bkkToday = () => window.HR.bangkokDate();
  function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); }
  function fmtTime(ts) { if (!ts) return ''; try { return new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false }); } catch (e) { return ''; } }
  function daysBetween(a, b) { if (!a) return 0; const s = new Date(a + 'T00:00:00'), e = new Date((b || a) + 'T00:00:00'); return Math.round((e - s) / 86400000) + 1; }

  // รอบประเมิน 21–20 (ตรงกับ defaultCycle เดิม)
  function cycleRange(which) {
    const t = new Date(bkkToday() + 'T00:00:00');
    const day = t.getDate();
    let endRef = (day <= 20) ? new Date(t.getFullYear(), t.getMonth(), 20)
                             : new Date(t.getFullYear(), t.getMonth() + 1, 20);
    if (which === 'previous') endRef = new Date(endRef.getFullYear(), endRef.getMonth() - 1, 20);
    const end = new Date(endRef.getFullYear(), endRef.getMonth(), 20);
    const start = new Date(endRef.getFullYear(), endRef.getMonth() - 1, 21);
    return { start: iso(start), end: iso(end), startStr: iso(start), endStr: iso(end) };
  }

  // นับวันที่ "ต้องมาทำงาน" ในช่วง (ตัดวันหยุดประจำสัปดาห์ + วันหยุดบริษัท)
  const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  function weeklyOffSet(s) {
    const set = new Set();
    String(s || '').split(',').map(x => x.trim().toLowerCase().slice(0, 3)).forEach(x => { if (x in DOW) set.add(DOW[x]); });
    return set;
  }
  function workingDays(start, end, weeklyOff, holidaySet) {
    const off = weeklyOffSet(weeklyOff);
    let n = 0; const d = new Date(start + 'T00:00:00'), e = new Date(end + 'T00:00:00');
    for (; d <= e; d.setDate(d.getDate() + 1)) {
      if (off.has(d.getDay())) continue;
      if (holidaySet.has(iso(d))) continue;
      n++;
    }
    return n;
  }

  // ============================================================
  // ตรรกะระดับวินัย (ปรับ threshold ได้ตามระเบียบบริษัท)
  // ============================================================
  function disciplineLevel(lateCount, absent) {
    if (lateCount >= 10 || absent >= 3) return { level: 4, level_name: 'ใบเตือนระดับ 2', level_color: '#b91c1c' };
    if (lateCount >= 7  || absent >= 2) return { level: 3, level_name: 'ใบเตือนระดับ 1', level_color: '#ea580c' };
    if (lateCount >= 5  || absent >= 1) return { level: 2, level_name: 'ตักเตือนลายลักษณ์อักษร', level_color: '#d97706' };
    if (lateCount >= 3)                 return { level: 1, level_name: 'ตักเตือนด้วยวาจา', level_color: '#ca8a04' };
    return { level: 0, level_name: 'ปกติ', level_color: '#16a34a' };
  }

  // ============================================================
  // Dispatcher
  // ============================================================
  // บันทึกกิจกรรมลง activity_log (ไม่ให้ error กระทบงานหลัก)
  async function logAct(action, emp_id, detail, actor) {
    try { await sb().from('activity_log').insert({ action, emp_id: emp_id || null, detail: detail || null, actor: actor || 'HR' }); } catch (e) { console.warn('logAct', e); }
  }

  async function dispatch(p) {
    try {
      switch (p.action) {
        case 'hr_login':          return await hrLogin(p.password);
        case 'hr_list':           return await hrList();
        case 'hr_dashboard':      return await hrDashboard();
        case 'hr_save':           return await hrSave(p.data);
        case 'hr_toggle':         return await hrToggle(p.emp_id);
        case 'hr_emp_delete':     return await hrEmpDelete(p.emp_id);
        case 'hr_report':         return await hrReport(p.filter);
        case 'hr_discipline':     return await hrDiscipline(p.cycle);
        case 'hr_warnings_list':  return await hrWarningsList();
        case 'hr_warning_issue':  return await hrWarningIssue(p.data);
        case 'hr_warning_get':    return await hrWarningGet(p.warning_id);
        case 'hr_warning_update': return await hrWarningUpdate(p.data);
        case 'hr_warning_delete': return await hrWarningDelete(p.warning_id);
        case 'hr_leaves_list':    return await hrLeavesList();
        case 'hr_leaves_save':    return await hrLeavesSave(p.data);
        case 'hr_leaves_delete':  return await hrLeavesDelete(p.leave_id);
        case 'hr_holidays_list':  return await hrHolidaysList();
        case 'hr_holidays_save':  return await hrHolidaysSave(p.data);
        case 'hr_holidays_delete':return await hrHolidaysDelete(p.date);
        case 'hr_branch_list':    return await hrBranchList();
        case 'hr_branch_save':    return await hrBranchSave(p.data);
        case 'hr_branch_delete':  return await hrBranchDelete(p.branch_id);
        case 'hr_sched_week':     return await hrSchedWeek(p.start, p.end);
        case 'hr_sched_save':     return await hrSchedSave(p.data);
        case 'hr_sched_delete':   return await hrSchedDelete(p.emp_id, p.work_date);
        case 'hr_sched_copy':     return await hrSchedCopy(p.from_start, p.to_start);
        case 'hr_coverage':       return await hrCoverage(p.filter);
        case 'hr_shift_list':     return await hrShiftList();
        case 'hr_shift_save':     return await hrShiftSave(p.data);
        case 'hr_shift_delete':   return await hrShiftDelete(p.shift_id);
        case 'hr_leave_status':   return await hrLeaveStatus(p.leave_id, p.status, p.note);
        case 'hr_leavetype_list': return await hrLeaveTypeList();
        case 'hr_leavetype_save': return await hrLeaveTypeSave(p.data);
        case 'hr_rule_status':    return await hrRuleStatus();
        case 'hr_activity':       return await hrActivity();
        case 'hr_notifications':  return await hrNotifications();
        case 'hr_submission_list':    return await hrSubmissionList();
        case 'hr_submission_approve': return await hrSubmissionApprove(p.id);
        case 'hr_submission_reject':  return await hrSubmissionReject(p.id);
        default: return { ok: false, error: 'unknown action: ' + p.action };
      }
    } catch (e) {
      console.error('[HRAPI]', p.action, e);
      return { ok: false, error: e.message || String(e) };
    }
  }

  // ---------- LOGIN ----------
  async function hrLogin(password) {
    const { data, error } = await sb().rpc('hr_check_password', { p_password: password });
    if (error) throw error;
    return { ok: data === true, error: data === true ? null : 'รหัสผ่านไม่ถูกต้อง' };
  }

  // ---------- LIST (พนักงาน + meta) ----------
  async function hrList() {
    const [emp, br, sh] = await Promise.all([
      sb().from('employees').select('*').order('emp_id'),
      sb().from('branches').select('*').order('branch_id'),
      sb().from('shifts').select('*').order('start_time'),
    ]);
    if (emp.error) throw emp.error;
    const rows = (emp.data || []).map(e => ({ ...e, face_descriptor: e.face_descriptor ? 'registered' : '' }));
    return { ok: true, headers: [], rows, branches: br.data || [], shifts: sh.data || [] };
  }

  // ---------- DASHBOARD ----------
  async function hrDashboard() {
    const today = bkkToday();
    const cyc = cycleRange('current');
    const [empsR, shR, brR, todayR, d30R, cycR] = await Promise.all([
      sb().from('employees').select('emp_id,name,photo_url,default_shift,active').eq('active', true),
      sb().from('shifts').select('shift_id,name'),
      sb().from('branches').select('branch_id,name'),
      sb().from('attendance').select('emp_id,shift_id,branch_id,check_in,late_min,status').eq('work_date', today),
      sb().from('attendance').select('work_date,late_min,ot_hours').gte('work_date', addDays(today, -29)).lte('work_date', today),
      sb().from('attendance').select('emp_id,late_min').gte('work_date', cyc.start).lte('work_date', cyc.end),
    ]);
    if (empsR.error) throw empsR.error;
    const emps = empsR.data || [], todayA = todayR.data || [];
    const empName = {}, empPhoto = {}, brName = {};
    emps.forEach(e => { empName[e.emp_id] = e.name; empPhoto[e.emp_id] = e.photo_url; });
    (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });

    const cards = {
      total_emp: emps.length,
      checked_in: todayA.filter(a => a.check_in).length,
      late_today: todayA.filter(a => a.late_min > 0).length,
      still_open: todayA.filter(a => String(a.status).toUpperCase() === 'OPEN').length,
      cycle_start: cyc.start, cycle_end: cyc.end,
    };

    // กะวันนี้
    const shifts = {};
    (shR.data || []).forEach(s => { shifts[s.shift_id] = { total: 0, checkedIn: 0, late: 0 }; });
    emps.forEach(e => { if (e.default_shift && shifts[e.default_shift]) shifts[e.default_shift].total++; });
    todayA.forEach(a => { if (a.shift_id && shifts[a.shift_id]) { if (a.check_in) shifts[a.shift_id].checkedIn++; if (a.late_min > 0) shifts[a.shift_id].late++; } });

    // trend 30 วัน
    const tmap = {};
    (d30R.data || []).forEach(a => { const m = tmap[a.work_date] || (tmap[a.work_date] = { late: 0, ot: 0 }); if (a.late_min > 0) m.late++; m.ot += Number(a.ot_hours) || 0; });
    const trend = [];
    for (let i = 29; i >= 0; i--) { const d = addDays(today, -i); const m = tmap[d] || { late: 0, ot: 0 }; trend.push({ date: d.slice(5), late: m.late, ot: Math.round(m.ot * 10) / 10 }); }

    // top 5 คนสายในรอบ
    const lmap = {};
    (cycR.data || []).forEach(a => { if (a.late_min > 0) { const m = lmap[a.emp_id] || (lmap[a.emp_id] = { emp_id: a.emp_id, late_count: 0, late_total: 0 }); m.late_count++; m.late_total += a.late_min; } });
    const top_late = Object.values(lmap).sort((a, b) => b.late_total - a.late_total).slice(0, 5)
      .map(m => ({ ...m, emp_name: empName[m.emp_id] || m.emp_id, photo_url: empPhoto[m.emp_id] || '' }));

    // สาขาวันนี้
    const bmap = {};
    todayA.forEach(a => { if (!a.branch_id) return; const m = bmap[a.branch_id] || (bmap[a.branch_id] = { count: 0, late: 0 }); m.count++; if (a.late_min > 0) m.late++; });
    const branches = Object.keys(bmap).map(b => ({ name: brName[b] || b, count: bmap[b].count, late: bmap[b].late }));

    return { ok: true, cards, shifts, trend, top_late, branches };
  }

  // ---------- SAVE EMPLOYEE ----------
  async function hrSave(d) {
    const row = {
      emp_id: d.emp_id, name: d.name, nickname: d.nickname || null,
      start_date: d.start_date || null, default_shift: d.default_shift || null,
      branch_id: d.branch_id || null, weekly_off: d.weekly_off || null,
      phone: d.phone || null, line_user_id: d.line_user_id || null, address: d.address || null,
      emergency_name: d.emergency_name || null, emergency_phone: d.emergency_phone || null,
      bank_name: d.bank_name || null, bank_account: d.bank_account || null, id_card: d.id_card || null,
      active: !!d.active,
    };
    if (d._photo_base64) row.photo_url = await window.HR.uploadPhoto('employee-photos', d.emp_id + '.jpg', d._photo_base64);
    else if (d.photo_url === '') row.photo_url = null;

    const { data: existing } = await sb().from('employees').select('emp_id').eq('emp_id', d.emp_id).maybeSingle();
    const action = existing ? 'updated' : 'created';
    const { error } = await sb().from('employees').upsert(row, { onConflict: 'emp_id' });
    if (error) throw error;
    return { ok: true, action };
  }

  // ---------- TOGGLE ACTIVE ----------
  async function hrToggle(empId) {
    const { data: cur, error: e1 } = await sb().from('employees').select('active').eq('emp_id', empId).maybeSingle();
    if (e1) throw e1;
    const next = !(cur && cur.active);
    const { error } = await sb().from('employees').update({ active: next }).eq('emp_id', empId);
    if (error) throw error;
    return { ok: true, active: next };
  }

  // ---------- DELETE EMPLOYEE (ลบพนักงาน + ข้อมูลที่ผูกอยู่) ----------
  async function hrEmpDelete(empId) {
    if (!empId) return { ok: false, error: 'ไม่ระบุรหัสพนักงาน' };
    // ลบข้อมูลที่อ้างถึงก่อน (กัน foreign key)
    await sb().from('attendance').delete().eq('emp_id', empId);
    await sb().from('leaves').delete().eq('emp_id', empId);
    await sb().from('warnings').delete().eq('emp_id', empId);
    await sb().from('schedules').delete().eq('emp_id', empId);
    await sb().from('rule_acks').delete().eq('emp_id', empId);
    await sb().from('profile_submissions').delete().eq('emp_id', empId);
    const { error } = await sb().from('employees').delete().eq('emp_id', empId);
    if (error) throw error;
    return { ok: true };
  }

  // ---------- REPORT ----------
  async function hrReport(f) {
    let q = sb().from('attendance')
      .select('*, employees(name,photo_url,branch_id), shifts(name), branches(name)')
      .gte('work_date', f.start).lte('work_date', f.end)
      .order('work_date', { ascending: false });
    if (f.emp_id) q = q.eq('emp_id', f.emp_id);
    if (f.branch_id) q = q.eq('branch_id', f.branch_id);
    if (f.shift_id) q = q.eq('shift_id', f.shift_id);
    const [{ data, error }, brR] = await Promise.all([
      q,
      sb().from('branches').select('branch_id,name'),
    ]);
    if (error) throw error;
    const brName = {};
    (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });

    let rows = (data || []).map(r => {
      const home = (r.employees && r.employees.branch_id) || null;
      const is_cover = !!(r.branch_id && home && r.branch_id !== home && r.check_in);
      return {
        work_date: r.work_date, emp_id: r.emp_id,
        emp_name: (r.employees && r.employees.name) || r.emp_id,
        emp_photo: (r.employees && r.employees.photo_url) || '',
        shift_name: (r.shifts && r.shifts.name) || r.shift_id || '',
        branch_id: r.branch_id || '',
        branch_name: (r.branches && r.branches.name) || r.branch_id || '',
        home_branch: brName[home] || home || '',
        is_cover,
        check_in: fmtTime(r.check_in), check_out: fmtTime(r.check_out),
        late_min: r.late_min || 0, ot_hours: r.ot_hours || 0,
        photo_url: r.photo_url || '', gps_lat: r.gps_lat, gps_lng: r.gps_lng, status: r.status,
      };
    });
    if (f.only_late) rows = rows.filter(r => r.late_min > 0);
    if (f.only_ot) rows = rows.filter(r => r.ot_hours > 0);
    if (f.only_cover) rows = rows.filter(r => r.is_cover);

    const map = {};
    rows.forEach(r => {
      const m = map[r.emp_id] || (map[r.emp_id] = { emp_id: r.emp_id, emp_name: r.emp_name, photo_url: r.emp_photo, days: 0, days_home: 0, days_cover: 0, late_count: 0, late_total: 0, ot: 0, cover_by: {} });
      m.days++;
      if (r.is_cover) { m.days_cover++; m.cover_by[r.branch_name] = (m.cover_by[r.branch_name] || 0) + 1; }
      else m.days_home++;
      if (r.late_min > 0) { m.late_count++; m.late_total += r.late_min; }
      m.ot += Number(r.ot_hours) || 0;
    });
    const summary = Object.values(map).map(m => ({
      ...m, ot: Math.round(m.ot * 100) / 100,
      cover_detail: Object.keys(m.cover_by).map(k => k + ' ' + m.cover_by[k] + ' วัน').join(' · '),
    }));
    return { ok: true, rows, summary };
  }

  // ---------- DISCIPLINE ----------
  async function hrDiscipline(which) {
    const cyc = cycleRange(which === 'previous' ? 'previous' : 'current');
    const today = bkkToday();
    const endEff = cyc.end < today ? cyc.end : today;
    const [empsR, attR, holR, lvR, schR] = await Promise.all([
      sb().from('employees').select('emp_id,name,photo_url,weekly_off,start_date').eq('active', true),
      sb().from('attendance').select('emp_id,work_date,check_in,late_min,ot_hours').gte('work_date', cyc.start).lte('work_date', endEff),
      sb().from('holidays').select('date').eq('active', true).gte('date', cyc.start).lte('date', cyc.end),
      sb().from('leaves').select('emp_id,start_date,end_date,status').eq('status', 'approved').lte('start_date', cyc.end).gte('end_date', cyc.start),
      sb().from('schedules').select('emp_id,work_date').gte('work_date', cyc.start).lte('work_date', endEff),
    ]);
    if (empsR.error) throw empsR.error;
    const holidaySet = new Set((holR.data || []).map(h => h.date));
    const att = attR.data || [], leaves = lvR.data || [];
    // ตารางเวรต่อพนักงาน (เซ็ตของวันที่ถูกจัดเวร)
    const schByEmp = {};
    (schR.data || []).forEach(s => { (schByEmp[s.emp_id] || (schByEmp[s.emp_id] = new Set())).add(s.work_date); });

    const employees = (empsR.data || []).map(e => {
      const myAtt = att.filter(a => a.emp_id === e.emp_id);
      const workedSet = new Set(myAtt.filter(a => a.check_in).map(a => a.work_date));
      const late = myAtt.filter(a => a.late_min > 0);
      const late_count = late.length;
      const late_total = late.reduce((s, a) => s + (a.late_min || 0), 0);
      const ot_hours = Math.round(myAtt.reduce((s, a) => s + (Number(a.ot_hours) || 0), 0) * 10) / 10;
      const myLeaves = leaves.filter(l => l.emp_id === e.emp_id);
      const onLeave = (dateStr) => myLeaves.some(l => dateStr >= l.start_date && dateStr <= (l.end_date || l.start_date));

      const days_worked = workedSet.size;
      // นับเฉพาะ "วันที่มีการจัดเวร (จัดจ๊อบ) ที่ผ่านไปแล้วจริง คือก่อนวันนี้" เท่านั้น
      // ขาด = วันที่ถูกจัดเวรแต่ไม่มาทำงานและไม่ได้ลา · วันนี้ที่ยังไม่จบ/ไม่มีตารางเวร = ไม่นับ
      const basis = 'roster';
      const mySched = schByEmp[e.emp_id] || new Set();
      const pastSched = [...mySched].filter(d => d < today);   // เฉพาะวันก่อนวันนี้
      const days_should = pastSched.length;
      let absent = 0;
      pastSched.forEach(d => { if (!workedSet.has(d) && !onLeave(d)) absent++; });
      const lv = disciplineLevel(late_count, absent);
      return {
        emp_id: e.emp_id, emp_name: e.name, photo_url: e.photo_url || '',
        late_count, late_total, ot_hours, absent,
        days_should, days_worked, basis,
        level: lv.level, level_name: lv.level_name, level_color: lv.level_color,
      };
    }).sort((a, b) => b.level - a.level || b.late_total - a.late_total);

    return { ok: true, employees, cycle: cyc };
  }

  // ---------- WARNINGS ----------
  async function hrWarningsList() {
    const { data, error } = await sb().from('warnings').select('*, employees(name)').order('issue_date', { ascending: false });
    if (error) throw error;
    const rows = (data || []).map(w => ({ ...w, emp_name: (w.employees && w.employees.name) || w.emp_id }));
    return { ok: true, rows };
  }

  async function hrWarningIssue(d) {
    const year = new Date().getFullYear();
    const { count } = await sb().from('warnings').select('warning_id', { count: 'exact', head: true }).like('warning_id', 'W-' + year + '-%');
    const warning_id = 'W-' + year + '-' + String((count || 0) + 1).padStart(4, '0');
    const row = {
      warning_id, emp_id: d.emp_id, issue_date: bkkToday(),
      level: parseInt(d.level) || null, level_name: d.level_name,
      cycle_start: d.cycle_start, cycle_end: d.cycle_end,
      late_count: d.late_count, late_total: d.late_total, absent_count: d.absent_count,
      reason: d.reason, issued_by: 'HR',
    };
    const { error } = await sb().from('warnings').insert(row);
    if (error) throw error;
    await logAct('ออกใบเตือน ' + warning_id, d.emp_id, (d.level_name || '') + ' · สาย ' + (d.late_count || 0) + ' ครั้ง · ขาด ' + (d.absent_count || 0) + ' วัน');
    return { ok: true, warning_id };
  }

  async function hrWarningUpdate(d) {
    if (!d.warning_id) return { ok: false, error: 'ไม่ระบุเลขที่ใบเตือน' };
    const upd = {};
    if (d.reason !== undefined) upd.reason = d.reason;
    if (d.level !== undefined && d.level !== '') { upd.level = parseInt(d.level) || null; upd.level_name = d.level_name || null; }
    const { error } = await sb().from('warnings').update(upd).eq('warning_id', d.warning_id);
    if (error) throw error;
    await logAct('แก้ไขใบเตือน ' + d.warning_id, d.emp_id || null, 'แก้ไขรายละเอียดใบเตือน');
    return { ok: true };
  }
  async function hrWarningDelete(wid) {
    const { data: w } = await sb().from('warnings').select('emp_id').eq('warning_id', wid).maybeSingle();
    const { error } = await sb().from('warnings').delete().eq('warning_id', wid);
    if (error) throw error;
    await logAct('ลบใบเตือน ' + wid, w ? w.emp_id : null, 'ลบใบเตือนออกจากระบบ');
    return { ok: true };
  }

  async function hrWarningGet(wid) {
    const { data, error } = await sb().from('warnings')
      .select('*, employees(name,nickname,default_shift,branch_id,start_date)')
      .eq('warning_id', wid).maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, error: 'ไม่พบใบเตือน' };
    const e = data.employees || {};
    const warning = {
      ...data, emp_name: e.name || data.emp_id, nickname: e.nickname || '',
      default_shift: e.default_shift || '', branch_id: e.branch_id || '', start_date: e.start_date || '',
    };
    return { ok: true, warning };
  }

  // ---------- LEAVES ----------
  async function hrLeavesList() {
    const { data, error } = await sb().from('leaves').select('*, employees(name)').order('start_date', { ascending: false });
    if (error) throw error;
    const rows = (data || []).map(l => ({
      ...l, emp_name: (l.employees && l.employees.name) || l.emp_id,
      days: daysBetween(l.start_date, l.end_date || l.start_date),
    }));
    return { ok: true, rows };
  }
  async function hrLeavesSave(d) {
    const row = { emp_id: d.emp_id, start_date: d.start_date, end_date: d.end_date || d.start_date, type: d.type || null, reason: d.reason || null, status: d.status || 'approved' };
    const { error } = await sb().from('leaves').insert(row);
    if (error) throw error;
    return { ok: true };
  }
  async function hrLeavesDelete(leaveId) {
    const { error } = await sb().from('leaves').delete().eq('leave_id', leaveId);
    if (error) throw error;
    return { ok: true };
  }

  // ---------- HOLIDAYS ----------
  async function hrHolidaysList() {
    const { data, error } = await sb().from('holidays').select('*').order('date');
    if (error) throw error;
    return { ok: true, rows: data || [] };
  }
  async function hrHolidaysSave(d) {
    const { error } = await sb().from('holidays').upsert({ date: d.date, name: d.name, type: d.type || null, active: d.active !== false }, { onConflict: 'date' });
    if (error) throw error;
    return { ok: true };
  }
  async function hrHolidaysDelete(date) {
    const { error } = await sb().from('holidays').delete().eq('date', date);
    if (error) throw error;
    return { ok: true };
  }

  // ---------- BRANCHES (จัดการสาขา) ----------
  async function hrBranchList() {
    const { data, error } = await sb().from('branches').select('*').order('branch_id');
    if (error) throw error;
    // นับพนักงานประจำแต่ละสาขา
    const { data: emps } = await sb().from('employees').select('branch_id').eq('active', true);
    const cnt = {};
    (emps || []).forEach(e => { if (e.branch_id) cnt[e.branch_id] = (cnt[e.branch_id] || 0) + 1; });
    const rows = (data || []).map(b => ({ ...b, emp_count: cnt[b.branch_id] || 0 }));
    return { ok: true, rows };
  }
  async function hrBranchSave(d) {
    if (!d.branch_id || !d.name) return { ok: false, error: 'ต้องมีรหัสสาขาและชื่อ' };
    const lat = parseFloat(d.lat), lng = parseFloat(d.lng), radius = parseInt(d.radius_m);
    if (!isFinite(lat) || !isFinite(lng)) return { ok: false, error: 'พิกัด lat/lng ไม่ถูกต้อง' };
    const row = {
      branch_id: String(d.branch_id).trim(), name: d.name.trim(),
      lat, lng, radius_m: isFinite(radius) && radius > 0 ? radius : 80,
    };
    const { data: existing } = await sb().from('branches').select('branch_id').eq('branch_id', row.branch_id).maybeSingle();
    const action = existing ? 'updated' : 'created';
    const { error } = await sb().from('branches').upsert(row, { onConflict: 'branch_id' });
    if (error) throw error;
    return { ok: true, action };
  }
  async function hrBranchDelete(branchId) {
    // กันลบสาขาที่ยังมีพนักงานประจำอยู่
    const { count: empCount } = await sb().from('employees').select('emp_id', { count: 'exact', head: true }).eq('branch_id', branchId);
    if (empCount && empCount > 0) return { ok: false, error: 'ลบไม่ได้: ยังมีพนักงานประจำ ' + empCount + ' คนที่สาขานี้ (ย้ายสาขาพนักงานก่อน)' };
    const { count: attCount } = await sb().from('attendance').select('id', { count: 'exact', head: true }).eq('branch_id', branchId);
    if (attCount && attCount > 0) return { ok: false, error: 'ลบไม่ได้: มีประวัติการลงเวลา ' + attCount + ' รายการที่สาขานี้' };
    // ลบเวรในตารางเวรที่อ้างถึงสาขานี้ก่อน (เป็นเพียงแผน ไม่ใช่หลักฐาน) กัน foreign key
    await sb().from('schedules').delete().eq('branch_id', branchId);
    const { error } = await sb().from('branches').delete().eq('branch_id', branchId);
    if (error) throw error;
    return { ok: true };
  }

  // ---------- SCHEDULES (ตารางเวรรายสัปดาห์) ----------
  async function hrSchedWeek(start, end) {
    const [empsR, schR, brR, shR] = await Promise.all([
      sb().from('employees').select('emp_id,name,nickname,default_shift,branch_id').eq('active', true).order('emp_id'),
      sb().from('schedules').select('*').gte('work_date', start).lte('work_date', end),
      sb().from('branches').select('branch_id,name').order('branch_id'),
      sb().from('shifts').select('shift_id,name').order('start_time'),
    ]);
    if (empsR.error) throw empsR.error;
    if (schR.error) throw schR.error;
    // index ตารางเวร: key = emp_id|work_date
    const cells = {};
    (schR.data || []).forEach(s => { cells[s.emp_id + '|' + s.work_date] = s; });
    return {
      ok: true,
      employees: empsR.data || [],
      schedules: cells,
      branches: brR.data || [],
      shifts: shR.data || [],
    };
  }
  async function hrSchedSave(d) {
    if (!d.emp_id || !d.work_date) return { ok: false, error: 'ต้องระบุพนักงานและวันที่' };
    // หาสาขาประจำ เพื่อ auto-set is_cover เมื่อสาขาในตาราง ≠ สาขาประจำ
    const { data: emp } = await sb().from('employees').select('branch_id').eq('emp_id', d.emp_id).maybeSingle();
    const home = emp ? emp.branch_id : null;
    const branch_id = d.branch_id || home || null;
    const is_cover = !!(branch_id && home && branch_id !== home);
    const row = {
      emp_id: d.emp_id, work_date: d.work_date,
      shift_id: d.shift_id || null, branch_id,
      is_cover, note: d.note || null,
    };
    const { error } = await sb().from('schedules').upsert(row, { onConflict: 'emp_id,work_date' });
    if (error) throw error;
    return { ok: true, is_cover };
  }
  async function hrSchedDelete(empId, workDate) {
    const { error } = await sb().from('schedules').delete().eq('emp_id', empId).eq('work_date', workDate);
    if (error) throw error;
    return { ok: true };
  }
  // คัดลอกตารางทั้งสัปดาห์ (7 วันจาก from_start) ไปยังสัปดาห์ใหม่ (to_start)
  async function hrSchedCopy(fromStart, toStart) {
    const fromEnd = addDays(fromStart, 6);
    const { data, error } = await sb().from('schedules').select('*').gte('work_date', fromStart).lte('work_date', fromEnd);
    if (error) throw error;
    const offset = daysBetween(fromStart, toStart) - 1; // จำนวนวันเลื่อน
    const rows = (data || []).map(s => ({
      emp_id: s.emp_id, work_date: addDays(s.work_date, offset),
      shift_id: s.shift_id, branch_id: s.branch_id, is_cover: s.is_cover, note: s.note,
    }));
    if (!rows.length) return { ok: true, copied: 0 };
    const { error: e2 } = await sb().from('schedules').upsert(rows, { onConflict: 'emp_id,work_date' });
    if (e2) throw e2;
    return { ok: true, copied: rows.length };
  }

  // ---------- COVERAGE (รายงานการไปทำแทนสาขา) ----------
  // ใช้ attendance จริง: สาขาที่เช็กอิน ≠ สาขาประจำ = ไปแทน
  async function hrCoverage(f) {
    f = f || {};
    const start = f.start, end = f.end;
    const [attR, empsR, brR, schR] = await Promise.all([
      sb().from('attendance').select('emp_id,work_date,shift_id,branch_id,check_in,late_min').gte('work_date', start).lte('work_date', end).not('check_in', 'is', null),
      sb().from('employees').select('emp_id,name,branch_id'),
      sb().from('branches').select('branch_id,name'),
      sb().from('schedules').select('emp_id,work_date,note,branch_id').gte('work_date', start).lte('work_date', end),
    ]);
    if (attR.error) throw attR.error;
    const home = {}, empName = {}, brName = {};
    (empsR.data || []).forEach(e => { home[e.emp_id] = e.branch_id; empName[e.emp_id] = e.name; });
    (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const schNote = {};
    (schR.data || []).forEach(s => { schNote[s.emp_id + '|' + s.work_date] = s.note; });

    const rows = (attR.data || [])
      .filter(a => a.branch_id && home[a.emp_id] && a.branch_id !== home[a.emp_id])
      .map(a => ({
        work_date: a.work_date, emp_id: a.emp_id, emp_name: empName[a.emp_id] || a.emp_id,
        from_branch: brName[home[a.emp_id]] || home[a.emp_id] || '—',
        to_branch: brName[a.branch_id] || a.branch_id,
        shift_id: a.shift_id || '', late_min: a.late_min || 0,
        note: schNote[a.emp_id + '|' + a.work_date] || '',
        check_in: fmtTime(a.check_in),
      }))
      .sort((x, y) => (y.work_date < x.work_date ? -1 : 1));
    return { ok: true, rows };
  }

  // ---------- SHIFTS (ตั้งค่ากะ + โค้ดย่อ) ----------
  async function hrShiftList() {
    const { data, error } = await sb().from('shifts').select('*').order('start_time');
    if (error) throw error;
    // นับการใช้งานแต่ละกะ
    const { data: emps } = await sb().from('employees').select('default_shift').eq('active', true);
    const cnt = {};
    (emps || []).forEach(e => { if (e.default_shift) cnt[e.default_shift] = (cnt[e.default_shift] || 0) + 1; });
    return { ok: true, rows: (data || []).map(s => ({ ...s, emp_count: cnt[s.shift_id] || 0 })) };
  }
  async function hrShiftSave(d) {
    if (!d.shift_id || !d.name) return { ok: false, error: 'ต้องมีรหัสกะและชื่อ' };
    const row = {
      shift_id: String(d.shift_id).trim(), name: d.name.trim(),
      code: (d.code || '').trim() || null,
      start_time: d.start_time || '00:00', end_time: d.end_time || '00:00',
      grace_min: parseInt(d.grace_min) >= 0 ? parseInt(d.grace_min) : 5,
    };
    const { error } = await sb().from('shifts').upsert(row, { onConflict: 'shift_id' });
    if (error) throw error;
    return { ok: true };
  }
  async function hrShiftDelete(shiftId) {
    const { count: e1 } = await sb().from('employees').select('emp_id', { count: 'exact', head: true }).eq('default_shift', shiftId);
    if (e1 && e1 > 0) return { ok: false, error: 'ลบไม่ได้: มีพนักงานใช้กะนี้เป็นกะประจำ ' + e1 + ' คน' };
    const { count: a1 } = await sb().from('attendance').select('id', { count: 'exact', head: true }).eq('shift_id', shiftId);
    if (a1 && a1 > 0) return { ok: false, error: 'ลบไม่ได้: มีประวัติการลงเวลากะนี้ ' + a1 + ' รายการ' };
    await sb().from('schedules').delete().eq('shift_id', shiftId);
    const { error } = await sb().from('shifts').delete().eq('shift_id', shiftId);
    if (error) throw error;
    return { ok: true };
  }

  // ---------- LEAVE APPROVAL (อนุมัติ/ปฏิเสธใบลา + เหตุผล) ----------
  async function hrLeaveStatus(leaveId, status, note) {
    if (!['approved', 'rejected', 'pending'].includes(status)) return { ok: false, error: 'สถานะไม่ถูกต้อง' };
    const upd = { status };
    if (note !== undefined) upd.hr_note = note || null;
    const { data: lv } = await sb().from('leaves').select('emp_id,type,start_date,end_date').eq('leave_id', leaveId).maybeSingle();
    const { error } = await sb().from('leaves').update(upd).eq('leave_id', leaveId);
    if (error) throw error;
    if (lv && status !== 'pending') {
      const range = lv.start_date + (lv.end_date && lv.end_date !== lv.start_date ? (' – ' + lv.end_date) : '');
      await logAct(status === 'approved' ? 'อนุมัติใบลา' : 'ปฏิเสธใบลา', lv.emp_id, (lv.type || 'ลา') + ' ' + range + (note ? (' · เหตุผล: ' + note) : ''));
    }
    return { ok: true };
  }

  // ---------- LEAVE TYPES (เงื่อนไขการลา) ----------
  async function hrLeaveTypeList() {
    const { data, error } = await sb().from('leave_types').select('*').order('sort');
    if (error) throw error;
    return { ok: true, rows: data || [] };
  }
  async function hrLeaveTypeSave(d) {
    if (!d.type) return { ok: false, error: 'ต้องระบุประเภท' };
    const q = d.quota_per_year;
    const row = {
      type: String(d.type).trim(),
      advance_days: parseInt(d.advance_days) >= 0 ? parseInt(d.advance_days) : 0,
      quota_per_year: (q === '' || q == null) ? null : (parseInt(q) >= 0 ? parseInt(q) : null),
      allow_backdate: !!d.allow_backdate,
      require_doc: !!d.require_doc,
      active: d.active !== false,
      sort: parseInt(d.sort) || 0,
    };
    const { error } = await sb().from('leave_types').upsert(row, { onConflict: 'type' });
    if (error) throw error;
    return { ok: true };
  }

  // ---------- NOTIFICATIONS (แจ้งเตือนแอดมิน) ----------
  async function hrNotifications() {
    const today = bkkToday();
    const [lvR, todayR, schR, empR, lvApprR, subR, shR] = await Promise.all([
      sb().from('leaves').select('*, employees(name)').eq('status', 'pending').order('created_at', { ascending: false }),
      sb().from('attendance').select('emp_id,check_in,check_out,late_min,status,branch_id').eq('work_date', today),
      sb().from('schedules').select('emp_id,shift_id,branch_id').eq('work_date', today),
      sb().from('employees').select('emp_id,name,branch_id').eq('active', true),
      sb().from('leaves').select('emp_id,start_date,end_date').eq('status', 'approved').lte('start_date', today),
      sb().from('profile_submissions').select('id,emp_id,name,submitted_at').eq('status', 'pending').order('submitted_at', { ascending: false }),
      sb().from('shifts').select('shift_id,name,start_time'),
    ]);
    const empName = {}; (empR.data || []).forEach(e => { empName[e.emp_id] = e.name; });
    const att = todayR.data || [];
    const checkedIn = new Set(att.filter(a => a.check_in).map(a => a.emp_id));
    const onleave = new Set((lvApprR.data || []).filter(l => today <= (l.end_date || l.start_date)).map(l => l.emp_id));

    const pending_leaves = (lvR.data || []).map(l => ({
      leave_id: l.leave_id, emp_id: l.emp_id, emp_name: (l.employees && l.employees.name) || l.emp_id,
      start_date: l.start_date, end_date: l.end_date, type: l.type, reason: l.reason,
      days: daysBetween(l.start_date, l.end_date || l.start_date),
    }));
    const not_checked_out = att.filter(a => a.check_in && !a.check_out)
      .map(a => ({ emp_id: a.emp_id, emp_name: empName[a.emp_id] || a.emp_id, check_in: fmtTime(a.check_in) }));
    const late_today = att.filter(a => a.late_min > 0)
      .map(a => ({ emp_id: a.emp_id, emp_name: empName[a.emp_id] || a.emp_id, late_min: a.late_min }));
    // เตือน "ขาด/ยังไม่มา" เฉพาะกะที่ถึงเวลาเข้างานแล้วเท่านั้น (ไม่ใช่ตอนเพิ่งจัดเวร)
    const nowHM = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(11, 16);
    const shiftStart = {}, shiftName = {};
    (shR.data || []).forEach(s => { shiftStart[s.shift_id] = String(s.start_time || '').slice(0, 5); shiftName[s.shift_id] = s.name; });
    const absent_roster = (schR.data || []).filter(s => {
      if (checkedIn.has(s.emp_id) || onleave.has(s.emp_id)) return false;
      const st = shiftStart[s.shift_id];
      if (!st) return false;            // ไม่มีเวลากะ = ยังไม่เตือน
      return nowHM >= st;               // ถึงเวลาเข้ากะแล้วเท่านั้น
    }).map(s => ({ emp_id: s.emp_id, emp_name: empName[s.emp_id] || s.emp_id, shift_id: s.shift_id, shift_name: shiftName[s.shift_id] || s.shift_id, start_time: shiftStart[s.shift_id] }));

    const pending_profiles = (subR.data || []).map(s => ({ id: s.id, emp_id: s.emp_id, name: s.name || s.emp_id }));
    return {
      ok: true, pending_leaves, not_checked_out, late_today, absent_roster, pending_profiles,
      counts: { pending_leaves: pending_leaves.length, not_checked_out: not_checked_out.length, late_today: late_today.length, absent_roster: absent_roster.length, pending_profiles: pending_profiles.length },
    };
  }

  // ---------- PROFILE SUBMISSIONS (ข้อมูลพนักงานกรอกเอง — รอตรวจ) ----------
  async function hrSubmissionList() {
    const { data, error } = await sb().from('profile_submissions')
      .select('*, employees(name)').eq('status', 'pending').order('submitted_at', { ascending: false });
    if (error) throw error;
    return { ok: true, rows: (data || []).map(s => ({ ...s, current_name: (s.employees && s.employees.name) || s.emp_id })) };
  }
  async function hrSubmissionApprove(id) {
    const { data: s, error } = await sb().from('profile_submissions').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!s) return { ok: false, error: 'ไม่พบรายการ' };
    const upd = {};
    ['name', 'nickname', 'phone', 'address', 'emergency_name', 'emergency_phone', 'bank_name', 'bank_account', 'id_card', 'photo_url', 'idcard_url', 'bankbook_url', 'house_url', 'edu_url']
      .forEach(k => { if (s[k] != null && s[k] !== '') upd[k] = s[k]; });
    if (Object.keys(upd).length) {
      const { error: e2 } = await sb().from('employees').update(upd).eq('emp_id', s.emp_id);
      if (e2) throw e2;
    }
    const { error: e3 } = await sb().from('profile_submissions').update({ status: 'approved' }).eq('id', id);
    if (e3) throw e3;
    await logAct('อนุมัติข้อมูล/เอกสาร', s.emp_id, 'HR อนุมัติและบันทึกข้อมูลที่พนักงานส่ง');
    return { ok: true };
  }
  async function hrSubmissionReject(id) {
    const { data: s } = await sb().from('profile_submissions').select('emp_id').eq('id', id).maybeSingle();
    const { error } = await sb().from('profile_submissions').update({ status: 'rejected' }).eq('id', id);
    if (error) throw error;
    await logAct('ปฏิเสธข้อมูล/เอกสาร', s ? s.emp_id : null, 'HR ปฏิเสธข้อมูลที่พนักงานส่ง');
    return { ok: true };
  }

  // ---------- RULE ACK STATUS (สถานะรับทราบระเบียบ) ----------
  async function hrRuleStatus() {
    const version = (typeof window !== 'undefined' && window.RULES_VERSION) ? window.RULES_VERSION : '';
    const [empsR, ackR] = await Promise.all([
      sb().from('employees').select('emp_id,name,nickname,branch_id').eq('active', true).order('emp_id'),
      sb().from('rule_acks').select('emp_id,accepted_at').eq('version', version).order('accepted_at', { ascending: false }),
    ]);
    if (empsR.error) throw empsR.error;
    const ack = {};
    (ackR.data || []).forEach(a => { if (!ack[a.emp_id]) ack[a.emp_id] = a.accepted_at; });
    const rows = (empsR.data || []).map(e => ({ emp_id: e.emp_id, name: e.name, nickname: e.nickname, branch_id: e.branch_id, accepted_at: ack[e.emp_id] || null }));
    const accepted = rows.filter(r => r.accepted_at).length;
    return { ok: true, version, rows, counts: { accepted, pending: rows.length - accepted } };
  }

  // ---------- ACTIVITY LOG (บันทึกกิจกรรมพนักงาน) ----------
  async function hrActivity() {
    const [subR, lvR, akR, atR, logR, empR] = await Promise.all([
      sb().from('profile_submissions').select('emp_id,submitted_at, employees(name)').order('submitted_at', { ascending: false }).limit(50),
      sb().from('leaves').select('emp_id,type,start_date,end_date,created_at, employees(name)').order('created_at', { ascending: false }).limit(50),
      sb().from('rule_acks').select('emp_id,version,accepted_at, employees(name)').order('accepted_at', { ascending: false }).limit(50),
      sb().from('attendance').select('emp_id,branch_id,check_in,check_out, employees(name), branches(name)').not('check_in', 'is', null).order('check_in', { ascending: false }).limit(50),
      sb().from('activity_log').select('*').order('at', { ascending: false }).limit(100),
      sb().from('employees').select('emp_id,name'),
    ]);
    const nm = o => (o && o.employees && o.employees.name) || o.emp_id;
    const empMap = {}; (empR.data || []).forEach(e => { empMap[e.emp_id] = e.name; });
    const ev = [];
    // เหตุการณ์ "ที่พนักงานสร้าง" (ตามเวลาที่สร้างจริง)
    (subR.data || []).forEach(s => ev.push({ when: s.submitted_at, type: 'ส่งข้อมูล/เอกสาร', icon: '📄', emp: nm(s), emp_id: s.emp_id, detail: 'พนักงานส่งข้อมูล/เอกสารเข้าระบบ', actor: s.emp_id }));
    (lvR.data || []).forEach(l => ev.push({ when: l.created_at, type: 'ยื่นคำขอลา', icon: '📝', emp: nm(l), emp_id: l.emp_id, detail: (l.type || 'ลา') + ' ' + l.start_date + (l.end_date && l.end_date !== l.start_date ? (' – ' + l.end_date) : ''), actor: l.emp_id }));
    (akR.data || []).forEach(a => ev.push({ when: a.accepted_at, type: 'ยอมรับระเบียบ', icon: '✅', emp: nm(a), emp_id: a.emp_id, detail: 'ยอมรับระเบียบ ฉบับ ' + a.version, actor: a.emp_id }));
    (atR.data || []).forEach(a => ev.push({ when: a.check_in, type: 'ลงเวลา', icon: '⏰', emp: nm(a), emp_id: a.emp_id, detail: 'เข้า ' + fmtTime(a.check_in) + (a.check_out ? (' · ออก ' + fmtTime(a.check_out)) : '') + ' @ ' + ((a.branches && a.branches.name) || a.branch_id || ''), actor: a.emp_id }));
    // เหตุการณ์ "HR ดำเนินการ" (จาก activity_log ตามเวลาที่ทำจริง)
    (logR.data || []).forEach(l => {
      const st = (l.action || '').indexOf('ปฏิเสธ') >= 0 || (l.action || '').indexOf('ลบ') >= 0 ? 'rejected'
        : (l.action || '').indexOf('อนุมัติ') >= 0 ? 'approved' : '';
      ev.push({ when: l.at, type: l.action, icon: '🗂️', emp: (l.emp_id ? (empMap[l.emp_id] || l.emp_id) : '—'), emp_id: l.emp_id || '', detail: (l.detail || '') + (l.actor ? ' · โดย ' + l.actor : ''), status: st, actor: l.actor || 'HR' });
    });
    ev.sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
    return { ok: true, rows: ev.slice(0, 150) };
  }

  window.HRAPI = { dispatch };
})();

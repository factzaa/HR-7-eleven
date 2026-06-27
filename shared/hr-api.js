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
  async function dispatch(p) {
    try {
      switch (p.action) {
        case 'hr_login':          return await hrLogin(p.password);
        case 'hr_list':           return await hrList();
        case 'hr_dashboard':      return await hrDashboard();
        case 'hr_save':           return await hrSave(p.data);
        case 'hr_toggle':         return await hrToggle(p.emp_id);
        case 'hr_report':         return await hrReport(p.filter);
        case 'hr_discipline':     return await hrDiscipline(p.cycle);
        case 'hr_warnings_list':  return await hrWarningsList();
        case 'hr_warning_issue':  return await hrWarningIssue(p.data);
        case 'hr_warning_get':    return await hrWarningGet(p.warning_id);
        case 'hr_leaves_list':    return await hrLeavesList();
        case 'hr_leaves_save':    return await hrLeavesSave(p.data);
        case 'hr_leaves_delete':  return await hrLeavesDelete(p.leave_id);
        case 'hr_holidays_list':  return await hrHolidaysList();
        case 'hr_holidays_save':  return await hrHolidaysSave(p.data);
        case 'hr_holidays_delete':return await hrHolidaysDelete(p.date);
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

  // ---------- REPORT ----------
  async function hrReport(f) {
    let q = sb().from('attendance')
      .select('*, employees(name,photo_url), shifts(name), branches(name)')
      .gte('work_date', f.start).lte('work_date', f.end)
      .order('work_date', { ascending: false });
    if (f.emp_id) q = q.eq('emp_id', f.emp_id);
    if (f.branch_id) q = q.eq('branch_id', f.branch_id);
    if (f.shift_id) q = q.eq('shift_id', f.shift_id);
    const { data, error } = await q;
    if (error) throw error;

    let rows = (data || []).map(r => ({
      work_date: r.work_date, emp_id: r.emp_id,
      emp_name: (r.employees && r.employees.name) || r.emp_id,
      emp_photo: (r.employees && r.employees.photo_url) || '',
      shift_name: (r.shifts && r.shifts.name) || r.shift_id || '',
      branch_name: (r.branches && r.branches.name) || r.branch_id || '',
      check_in: fmtTime(r.check_in), check_out: fmtTime(r.check_out),
      late_min: r.late_min || 0, ot_hours: r.ot_hours || 0,
      photo_url: r.photo_url || '', gps_lat: r.gps_lat, gps_lng: r.gps_lng, status: r.status,
    }));
    if (f.only_late) rows = rows.filter(r => r.late_min > 0);
    if (f.only_ot) rows = rows.filter(r => r.ot_hours > 0);

    const map = {};
    rows.forEach(r => {
      const m = map[r.emp_id] || (map[r.emp_id] = { emp_id: r.emp_id, emp_name: r.emp_name, photo_url: r.emp_photo, days: 0, late_count: 0, late_total: 0, ot: 0 });
      m.days++; if (r.late_min > 0) { m.late_count++; m.late_total += r.late_min; } m.ot += Number(r.ot_hours) || 0;
    });
    const summary = Object.values(map).map(m => ({ ...m, ot: Math.round(m.ot * 100) / 100 }));
    return { ok: true, rows, summary };
  }

  // ---------- DISCIPLINE ----------
  async function hrDiscipline(which) {
    const cyc = cycleRange(which === 'previous' ? 'previous' : 'current');
    const today = bkkToday();
    const endEff = cyc.end < today ? cyc.end : today;
    const [empsR, attR, holR, lvR] = await Promise.all([
      sb().from('employees').select('emp_id,name,photo_url,weekly_off,start_date').eq('active', true),
      sb().from('attendance').select('emp_id,work_date,check_in,late_min,ot_hours').gte('work_date', cyc.start).lte('work_date', endEff),
      sb().from('holidays').select('date').eq('active', true).gte('date', cyc.start).lte('date', cyc.end),
      sb().from('leaves').select('emp_id,start_date,end_date,status').eq('status', 'approved').lte('start_date', cyc.end).gte('end_date', cyc.start),
    ]);
    if (empsR.error) throw empsR.error;
    const holidaySet = new Set((holR.data || []).map(h => h.date));
    const att = attR.data || [], leaves = lvR.data || [];

    const employees = (empsR.data || []).map(e => {
      const myAtt = att.filter(a => a.emp_id === e.emp_id);
      const worked = new Set(myAtt.filter(a => a.check_in).map(a => a.work_date));
      const late = myAtt.filter(a => a.late_min > 0);
      const late_count = late.length;
      const late_total = late.reduce((s, a) => s + (a.late_min || 0), 0);
      const ot_hours = Math.round(myAtt.reduce((s, a) => s + (Number(a.ot_hours) || 0), 0) * 10) / 10;
      // วันลาที่อนุมัติในรอบ
      let leaveDays = 0;
      leaves.filter(l => l.emp_id === e.emp_id).forEach(l => {
        const s = l.start_date < cyc.start ? cyc.start : l.start_date;
        const en = (l.end_date || l.start_date) > endEff ? endEff : (l.end_date || l.start_date);
        if (s <= en) leaveDays += daysBetween(s, en);
      });
      const days_should = workingDays(cyc.start, endEff, e.weekly_off, holidaySet);
      const days_worked = worked.size;
      const absent = Math.max(0, days_should - days_worked - leaveDays);
      const lv = disciplineLevel(late_count, absent);
      return {
        emp_id: e.emp_id, emp_name: e.name, photo_url: e.photo_url || '',
        late_count, late_total, ot_hours, absent,
        days_should, days_worked,
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
    return { ok: true, warning_id };
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

  window.HRAPI = { dispatch };
})();

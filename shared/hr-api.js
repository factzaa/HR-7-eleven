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
  // which = 'current'|'previous' หรือจำนวนรอบย้อนหลัง (0=ปัจจุบัน, 1=ก่อนหน้า, 2=สองรอบก่อน ...)
  function cycleRange(which) {
    const t = new Date(bkkToday() + 'T00:00:00');
    const day = t.getDate();
    let endRef = (day <= 20) ? new Date(t.getFullYear(), t.getMonth(), 20)
                             : new Date(t.getFullYear(), t.getMonth() + 1, 20);
    const back = (typeof which === 'number') ? which : (which === 'previous' ? 1 : 0);
    if (back) endRef = new Date(endRef.getFullYear(), endRef.getMonth() - back, 20);
    const end = new Date(endRef.getFullYear(), endRef.getMonth(), 20);
    const start = new Date(endRef.getFullYear(), endRef.getMonth() - 1, 21);
    return { start: iso(start), end: iso(end), startStr: iso(start), endStr: iso(end) };
  }
  // แปลงคีย์เวิร์ดรอบ → จำนวนรอบย้อนหลัง
  function cycleBack(which) {
    if (which === 'previous') return 1;
    if (which === 'prev2') return 2;
    if (which === 'prev3') return 3;
    return (typeof which === 'number') ? which : 0;
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
  // ตรรกะระดับวินัย — อ่านเกณฑ์จากตาราง discipline_rules (ปรับได้จากหน้า HR)
  // ============================================================
  // เกณฑ์เริ่มต้น (ใช้เมื่อยังไม่มีตาราง/ตารางว่าง)
  const DEFAULT_DISC_RULES = [
    { level: 1, level_name: 'ตักเตือนด้วยวาจา',        level_color: '#ca8a04', late_min: 3,  absent_min: null, enabled: true },
    { level: 2, level_name: 'ตักเตือนลายลักษณ์อักษร', level_color: '#d97706', late_min: 5,  absent_min: 1,    enabled: true },
    { level: 3, level_name: 'ใบเตือนระดับ 1',          level_color: '#ea580c', late_min: 7,  absent_min: 2,    enabled: true },
    { level: 4, level_name: 'ใบเตือนระดับ 2',          level_color: '#b91c1c', late_min: 10, absent_min: 3,    enabled: true },
  ];

  async function loadDisciplineRules() {
    try {
      const r = await sb().from('discipline_rules').select('*').order('level');
      if (r.error || !r.data || !r.data.length) return DEFAULT_DISC_RULES;
      return r.data;
    } catch (e) { return DEFAULT_DISC_RULES; }
  }

  // หา "ระดับสูงสุด" ที่เข้าเกณฑ์ (สาย OR ขาด ตามค่าที่ตั้ง) — rules = อาเรย์เกณฑ์
  function disciplineLevel(lateCount, absent, rules) {
    const rs = (rules && rules.length ? rules : DEFAULT_DISC_RULES)
      .filter(r => r.enabled !== false)
      .slice().sort((a, b) => b.level - a.level);   // รุนแรงสุดก่อน
    for (const r of rs) {
      const hitLate   = (r.late_min   != null) && lateCount >= r.late_min;
      const hitAbsent = (r.absent_min != null) && absent    >= r.absent_min;
      if (hitLate || hitAbsent) {
        return { level: r.level, level_name: r.level_name, level_color: r.level_color };
      }
    }
    return { level: 0, level_name: 'ปกติ', level_color: '#16a34a' };
  }

  // อ่านเกณฑ์ใบเตือน (ถ้ายังไม่มีตาราง/ว่าง คืนค่าเริ่มต้น)
  async function hrDiscRulesGet() {
    const rules = await loadDisciplineRules();
    return { ok: true, rules };
  }

  // บันทึกเกณฑ์ใบเตือน — data = อาเรย์ [{level,level_name,level_color,late_min,absent_min,enabled}]
  async function hrDiscRulesSave(data) {
    if (!Array.isArray(data) || !data.length) return { ok: false, error: 'ไม่มีข้อมูลเกณฑ์' };
    const rows = data.map(r => ({
      level: Number(r.level),
      level_name: r.level_name,
      level_color: r.level_color,
      late_min:   (r.late_min   === '' || r.late_min   == null) ? null : Number(r.late_min),
      absent_min: (r.absent_min === '' || r.absent_min == null) ? null : Number(r.absent_min),
      enabled: r.enabled !== false,
    }));
    const r = await sb().from('discipline_rules').upsert(rows, { onConflict: 'level' });
    if (r.error) throw r.error;
    await logAct('แก้ไขเกณฑ์ใบเตือน', null, 'อัปเดตเกณฑ์วินัย ' + rows.length + ' ระดับ');
    return { ok: true };
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
        case 'mgr_login':         return await mgrLogin(p.emp_id, p.pin);
        case 'hr_list':           return await hrList();
        case 'hr_dashboard':      return await hrDashboard(p.branch, p.date);
        case 'hr_board':          return await hrBoard(p.date);
        case 'hr_save':           return await hrSave(p.data);
        case 'hr_toggle':         return await hrToggle(p.emp_id);
        case 'hr_emp_delete':     return await hrEmpDelete(p.emp_id);
        case 'hr_change_emp_id':  return await hrChangeEmpId(p.old_id, p.new_id);
        case 'hr_report':         return await hrReport(p.filter);
        case 'hr_discipline':     return await hrDiscipline(p.cycle, p.range);
        case 'hr_settings_get':   return await hrSettingsGet();
        case 'hr_settings_save':  return await hrSettingsSave(p.key, p.value);
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
        case 'hr_sched_delete':   return await hrSchedDelete(p.emp_id, p.work_date, p.shift_id);
        case 'hr_sched_fill_week':return await hrSchedFillWeek(p.data);
        case 'hr_sched_copy':     return await hrSchedCopy(p.from_start, p.to_start);
        case 'hr_coverage':       return await hrCoverage(p.filter);
        case 'hr_shift_list':     return await hrShiftList();
        case 'hr_shift_save':     return await hrShiftSave(p.data);
        case 'hr_shift_delete':   return await hrShiftDelete(p.shift_id);
        case 'hr_wh_list':        return await hrWhList();
        case 'hr_wh_save':        return await hrWhSave(p.data);
        case 'hr_wh_delete':      return await hrWhDelete(p.id);
        case 'hr_goods_list':     return await hrGoodsList(p.filter);
        case 'hr_goods_audit':    return await hrGoodsAudit(p.filter);
        case 'hr_leave_status':   return await hrLeaveStatus(p.leave_id, p.status, p.note);
        case 'hr_leave_propose':  return await hrLeaveProposeConditional(p.leave_id, p.message);
        case 'hr_leavetype_list': return await hrLeaveTypeList();
        case 'hr_leavetype_save': return await hrLeaveTypeSave(p.data);
        case 'hr_rule_status':    return await hrRuleStatus();
        case 'hr_disc_rules_get': return await hrDiscRulesGet();
        case 'hr_disc_rules_save':return await hrDiscRulesSave(p.data);
        case 'hr_score_get':         return await hrScoreGet(p.cycle);
        case 'hr_score_config_get':  return await hrScoreConfigGet();
        case 'hr_score_config_save': return await hrScoreConfigSave(p.data);
        case 'hr_score_rules_save':  return await hrScoreRulesSave(p.data);
        case 'hr_score_rule_delete': return await hrScoreRuleDelete(p.rule_key);
        case 'hr_score_bands_save':  return await hrScoreBandsSave(p.data);
        case 'hr_score_event_add':   return await hrScoreEventAdd(p.data);
        case 'hr_score_event_list':  return await hrScoreEventList(p.emp_id, p.cycle);
        case 'hr_score_event_delete':return await hrScoreEventDelete(p.id);
        case 'hr_score_issue_warnings': return await hrScoreIssueWarnings(p.cycle);
        case 'hr_handover_list':     return await hrHandoverList();
        case 'hr_task_defs_get':     return await hrTaskDefsGet();
        case 'hr_task_def_save':     return await hrTaskDefSave(p.data);
        case 'hr_task_def_delete':   return await hrTaskDefDelete(p.id);
        case 'hr_task_assign':       return await hrTaskAssign(p.data);
        case 'hr_task_list':         return await hrTaskList(p.date);
        case 'hr_task_review':       return await hrTaskReview(p.id, p.status, p.note, p.markup);
        case 'hr_task_delete':       return await hrTaskDelete(p.id);
        case 'hr_task_log':          return await hrTaskLog(p.filter);
        case 'hr_open_tasks':        return await hrOpenTasks();
        case 'hr_task_close_group':  return await hrTaskCloseGroup(p.data);
        case 'hr_emp_summary':       return await hrEmpSummary(p.data);
        case 'hr_analytics':         return await hrAnalytics(p.data);
        case 'hr_special_create':    return await hrSpecialCreate(p.data);
        case 'hr_special_list':      return await hrSpecialList(p.branch);
        case 'hr_special_review':    return await hrSpecialReview(p.assignee_id, p.status, p.note, p.markup);
        case 'hr_special_delete':    return await hrSpecialDelete(p.id);
        case 'hr_qa_folder_create':  return await hrQaFolderCreate(p.data);
        case 'hr_qa_folder_list':    return await hrQaFolderList();
        case 'hr_qa_folder_delete':  return await hrQaFolderDelete(p.id);
        case 'hr_qa_items':          return await hrQaItems(p.folder_id, p.status);
        case 'hr_qa_item_delete':    return await hrQaItemDelete(p.id);
        case 'hr_qa_item_update':    return await hrQaItemUpdate(p.id, p.data);
        case 'hr_applicants_list':   return await hrApplicantsList(p.branch);
        case 'hr_applicant_get':     return await hrApplicantGet(p.id);
        case 'hr_applicant_stage':   return await hrApplicantStage(p.id, p.status);
        case 'hr_applicant_interview': return await hrApplicantInterview(p.id, p.interview_at, p.note);
        case 'hr_applicant_reject':  return await hrApplicantReject(p.id, p.reason);
        case 'hr_applicant_hire':    return await hrApplicantHire(p.id, p.branch_id);
        case 'hr_positions_list':    return await hrPositionsList();
        case 'hr_position_save':     return await hrPositionSave(p.data);
        case 'hr_position_delete':   return await hrPositionDelete(p.id);
        case 'hr_mtask_create':      return await hrMtaskCreate(p.data);
        case 'hr_mtask_list':        return await hrMtaskList(p.branch);
        case 'hr_mtask_get':         return await hrMtaskGet(p.id);
        case 'hr_mtask_stage':       return await hrMtaskStage(p.id, p.status, p.role, p.sender_name);
        case 'hr_mtask_feed_add':    return await hrMtaskFeedAdd(p.data);
        case 'hr_mtask_feed_list':   return await hrMtaskFeedList(p.task_id);
        case 'hr_mtask_assign':      return await hrMtaskAssign(p.id, p.emp_id, p.emp_name);
        case 'hr_mtask_update':      return await hrMtaskUpdate(p.id, p.data);
        case 'hr_mtask_delete':      return await hrMtaskDelete(p.id);
        case 'hr_mdaily_defs_list':  return await hrMdailyDefsList();
        case 'hr_mdaily_defs_save':  return await hrMdailyDefsSave(p.data);
        case 'hr_mdaily_defs_delete':return await hrMdailyDefsDelete(p.id);
        case 'hr_mdaily_today':      return await hrMdailyToday(p.branch, p.date);
        case 'hr_mdaily_submit':     return await hrMdailySubmit(p.data);
        case 'hr_mdaily_review':     return await hrMdailyReview(p.log_id, p.status, p.note, p.markup);
        case 'hr_mdaily_board':      return await hrMdailyBoard(p.date, p.branch);
        case 'hr_mdaily_report':     return await hrMdailyReport(p.month, p.branch);
        case 'hr_shelf_list':        return await hrShelfList(p.branch);
        case 'hr_shelf_save':        return await hrShelfSave(p.data);
        case 'hr_shelf_delete':      return await hrShelfDelete(p.id);
        case 'hr_shelf_assign':      return await hrShelfAssign(p.data);
        case 'hr_shelf_assignments': return await hrShelfAssignments(p.month, p.branch);
        case 'hr_shelf_assign_delete': return await hrShelfAssignDelete(p.id);
        case 'hr_shelf_checks':      return await hrShelfChecks(p.shelf_id, p.month);
        case 'hr_shelf_check_review':return await hrShelfCheckReview(p.id, p.status, p.note, p.markup);
        case 'hr_checkout_corr_list':   return await hrCheckoutCorrList();
        case 'hr_checkout_corr_review': return await hrCheckoutCorrReview(p.id, p.status, p.note);
        case 'hr_mark_duty':            return await hrMarkDuty(p.data);
        case 'hr_duty_list':            return await hrDutyList(p.branch);
        case 'hr_duty_delete':          return await hrDutyDelete(p.emp_id, p.work_date);
        case 'hr_activity':       return await hrActivity();
        case 'hr_notifications':  return await hrNotifications(p.branch, p.date);
        case 'hr_notify_history': return await hrNotifyHistory();
        case 'hr_announce_save':  return await hrAnnounceSave(p.data);
        case 'hr_announce_delete':return await hrAnnounceDelete(p.id);
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

  // ---------- LOGIN ผจก.สาขา (รหัสพนักงาน + PIN) ----------
  async function mgrLogin(empId, pin) {
    empId = String(empId || '').trim();
    pin = String(pin || '').trim();
    if (!empId || !pin) return { ok: false, error: 'กรอกรหัสพนักงานและ PIN' };
    const { data, error } = await sb().rpc('mgr_login', { p_emp_id: empId, p_pin: pin });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.branch_id) return { ok: false, error: 'รหัสพนักงานหรือ PIN ไม่ถูกต้อง' };
    await logAct('ผจก.เข้าระบบ', empId, 'สาขา ' + row.branch_id);
    return { ok: true, emp_id: empId, branch_id: row.branch_id, name: row.name || '', nickname: row.nickname || '' };
  }

  // ---------- LIST (พนักงาน + meta) ----------
  async function hrList() {
    const [emp, br, sh] = await Promise.all([
      sb().from('employees').select('*').order('emp_id'),
      sb().from('branches').select('*').order('branch_id'),
      sb().from('shifts').select('*').order('start_time'),
    ]);
    if (emp.error) throw emp.error;
    const rows = (emp.data || []).map(e => {
      const { manager_pin, ...rest } = e;              // ไม่ส่ง PIN ออกไปฝั่ง client
      return { ...rest, has_pin: !!manager_pin, is_manager: !!e.is_manager, face_descriptor: e.face_descriptor ? 'registered' : '' };
    });
    return { ok: true, headers: [], rows, branches: br.data || [], shifts: sh.data || [] };
  }

  // ---------- DASHBOARD ----------
  // ---------- ค่าตั้งระบบ (app_settings) ----------
  let _settings = null;
  async function loadAppSettings() {
    if (_settings) return _settings;
    try { const { data } = await sb().from('app_settings').select('key,value'); _settings = {}; (data || []).forEach(r => { _settings[r.key] = r.value; }); }
    catch (e) { _settings = {}; }
    return _settings;
  }
  async function getSettingNum(key, def) {
    const s = await loadAppSettings(); const v = s[key];
    return (v === undefined || v === null || v === '' || isNaN(Number(v))) ? def : Number(v);
  }
  async function getSettingBool(key) { const s = await loadAppSettings(); return String(s[key] || '') === '1'; }
  // ปรับ OT ตามเงื่อนไข: ถ้าตั้ง "ปัดชั่วโมงเต็มต่อวัน" → ปัดลงเป็นจำนวนเต็ม (เศษนาทีไม่นับ) · ใช้ต่อรายการลงเวลา (ต่อวัน) ก่อนนำไปรวม
  function otAdj(h, whole) { h = Number(h) || 0; return whole ? Math.floor(h + 1e-9) : h; }
  function hmToMin(hm) { const p = String(hm || '').split(':'); return (parseInt(p[0]) || 0) * 60 + (parseInt(p[1]) || 0); }
  // "ลืมกดออก" แล้วหรือยัง — รองรับกะข้ามคืน (deadline ของกะดึกตกในวันถัดไป)
  // workDate=วันที่ของแถวลงเวลา · st/en=เวลาเข้า/ออกของกะ · grace=ผ่อนผัน · today=วันนี้ · nowMin=นาทีปัจจุบัน
  function coOverdue(workDate, st, en, grace, today, nowMin) {
    if (!en) return false;                                  // ไม่รู้เวลาเลิกกะ
    const overnight = st && en <= st;                       // กะข้ามคืน
    const deadlineDate = overnight ? addDays(workDate, 1) : workDate;
    if (deadlineDate < today) return true;                  // เลยวันเลิกกะมาแล้ว = ลืมแน่
    if (deadlineDate === today) { const thr = hmToMin(en) + grace; return thr < 1440 && nowMin >= thr; }
    return false;                                           // ยังไม่ถึงเวลาเลิกกะ
  }
  async function hrSettingsGet() { return { ok: true, settings: await loadAppSettings() }; }
  async function hrSettingsSave(key, value) {
    if (!key) return { ok: false, error: 'ไม่มี key' };
    const { error } = await sb().from('app_settings').upsert({ key: String(key), value: String(value) }, { onConflict: 'key' });
    if (error) throw error;
    _settings = null;
    return { ok: true };
  }

  async function hrDashboard(branch, date) {
    const today = bkkToday();
    const d = date || today;                 // วันที่ของ "ภาพรวมรายวัน" (ค่าเริ่มต้น = วันนี้)
    const otWhole = await getSettingBool('ot_whole_day');
    const cyc = cycleRange('current');
    let qEmp = sb().from('employees').select('emp_id,name,photo_url,active,branch_id').eq('active', true);
    let qToday = sb().from('attendance').select('emp_id,shift_id,branch_id,check_in,check_out,late_min,status,extend_until').eq('work_date', d);
    let qD30 = sb().from('attendance').select('work_date,late_min,ot_hours,branch_id').gte('work_date', addDays(today, -29)).lte('work_date', today);
    let qCyc = sb().from('attendance').select('emp_id,late_min,branch_id').gte('work_date', cyc.start).lte('work_date', cyc.end);
    let qSch = sb().from('schedules').select('emp_id,shift_id,branch_id').eq('work_date', d);
    if (branch) { qEmp = qEmp.eq('branch_id', branch); qToday = qToday.eq('branch_id', branch); qD30 = qD30.eq('branch_id', branch); qCyc = qCyc.eq('branch_id', branch); qSch = qSch.eq('branch_id', branch); }
    const [empsR, shR, brR, todayR, d30R, cycR, schR, upLvR] = await Promise.all([
      qEmp,
      sb().from('shifts').select('shift_id,name,start_time,end_time'),
      sb().from('branches').select('branch_id,name'),
      qToday, qD30, qCyc, qSch,
      sb().from('leaves').select('emp_id,type,start_date,end_date,status').eq('status', 'approved').gte('end_date', today).lte('start_date', addDays(today, 14)),  // ลาที่จะถึงใน 14 วัน
    ]);
    if (empsR.error) throw empsR.error;
    const emps = empsR.data || [], todayA = todayR.data || [];
    const empSet = new Set(emps.map(e => e.emp_id));
    const empName = {}, empPhoto = {}, brName = {};
    emps.forEach(e => { empName[e.emp_id] = e.name; empPhoto[e.emp_id] = e.photo_url; });
    (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    // "ลืมกดออก" = เลยเวลาเลิกกะแล้วยังไม่เช็กเอาต์ (ไม่นับคนที่ยังทำงานอยู่)
    const nowHM = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(11, 16);
    const shEnd = {}, shStart = {}, shNm = {};
    (shR.data || []).forEach(s => { shStart[s.shift_id] = String(s.start_time || '').slice(0, 5); shEnd[s.shift_id] = String(s.end_time || '').slice(0, 5); shNm[s.shift_id] = s.name; });
    const mkRow = a => ({ emp_id: a.emp_id, emp_name: empName[a.emp_id] || a.emp_id, shift: shNm[a.shift_id] || a.shift_id || '', branch: brName[a.branch_id] || '', check_in: fmtTime(a.check_in), check_out: a.check_out ? fmtTime(a.check_out) : '', late_min: a.late_min || 0, end_time: shEnd[a.shift_id] || '' });
    const coGrace = await getSettingNum('checkout_grace_min', 15);   // ผ่อนผันก่อนเตือนลืมกดออก
    const nowMin = hmToMin(nowHM);
    // ยึด "กะปัจจุบันจากตารางเวร" (รองรับ HR เปลี่ยนกะหลังเช็กอิน + ควบกะ) — ไม่ใช้กะที่ค้างในแถวลงเวลา
    let qSchOv = sb().from('schedules').select('emp_id,shift_id,work_date').gte('work_date', addDays(d, -1)).lte('work_date', d);
    if (branch) qSchOv = qSchOv.eq('branch_id', branch);
    const schOv = (await qSchOv).data || [];
    const schByED = {};
    schOv.forEach(s => { if (s.shift_id) (schByED[s.emp_id + '|' + s.work_date] = schByED[s.emp_id + '|' + s.work_date] || []).push(s.shift_id); });
    // เวลาเลิก "กะสุดท้ายของวัน" (ตามตารางเวร; ถ้าไม่มีเวรใช้กะที่เช็กอิน) — คืน {en, endDate}
    const effEnd = (empId, wd, snapShift) => {
      const sids = (schByED[empId + '|' + wd] && schByED[empId + '|' + wd].length) ? schByED[empId + '|' + wd] : [snapShift];
      let best = null, bestMs = -Infinity;
      for (const sid of sids) {
        const en = shEnd[sid]; if (!en) continue;
        const st = shStart[sid]; const overnight = !!st && en <= st;
        const endDate = overnight ? addDays(wd, 1) : wd;
        const ms = new Date(endDate + 'T' + en + ':00+07:00').getTime();
        if (ms > bestMs) { bestMs = ms; best = { en, endDate }; }
      }
      return best;
    };
    const isOverdue = (empId, wd, snapShift) => {
      const e = effEnd(empId, wd, snapShift); if (!e) return false;
      if (e.endDate < today) return true;
      if (e.endDate === today) { const thr = hmToMin(e.en) + coGrace; return thr < 1440 && nowMin >= thr; }
      return false;
    };
    // รวมกะข้ามคืน: ดึงแถวที่ยังเปิดค้างจากเมื่อวานมาด้วย (กะดึกเลิกเช้าวันถัดไป)
    let qYestOpen = sb().from('attendance').select('emp_id,shift_id,branch_id,check_in,check_out,late_min,extend_until').eq('work_date', addDays(d, -1)).not('check_in', 'is', null).is('check_out', null);
    if (branch) qYestOpen = qYestOpen.eq('branch_id', branch);
    const yestOpen = (await qYestOpen).data || [];
    const openRows = todayA.filter(a => a.check_in && !a.check_out).map(a => ({ ...a, work_date: d }))
      .concat(yestOpen.map(a => ({ ...a, work_date: addDays(d, -1) })));
    const stillOpenList = openRows.filter(a => {
      if (a.extend_until && new Date(a.extend_until).getTime() > Date.now()) return false;   // ประกาศควบกะต่อ → ยังไม่ถือว่าลืม
      return isOverdue(a.emp_id, a.work_date, a.shift_id);
    }).map(a => { const e = effEnd(a.emp_id, a.work_date, a.shift_id); const r = mkRow(a); if (e) r.end_time = e.en; return r; });
    const lateList = todayA.filter(a => a.late_min > 0).map(mkRow);
    const checkedInList = todayA.filter(a => a.check_in).map(mkRow);

    const cards = {
      total_emp: emps.length,
      checked_in: checkedInList.length,
      late_today: lateList.length,
      still_open: stillOpenList.length,
      cycle_start: cyc.start, cycle_end: cyc.end,
    };
    const lists = { checked_in: checkedInList, late: lateList, still_open: stillOpenList };

    // กะวันนี้ — total นับจากตารางเวรวันนี้ (ไม่ใช่กะประจำแล้ว)
    const shifts = {};
    (shR.data || []).forEach(s => { shifts[s.shift_id] = { total: 0, checkedIn: 0, late: 0 }; });
    (schR.data || []).forEach(s => { if (s.shift_id && shifts[s.shift_id] && empSet.has(s.emp_id)) shifts[s.shift_id].total++; });   // นับเฉพาะพนักงาน active
    todayA.forEach(a => { if (a.shift_id && shifts[a.shift_id]) { if (a.check_in) shifts[a.shift_id].checkedIn++; if (a.late_min > 0) shifts[a.shift_id].late++; } });

    // trend 30 วัน
    const tmap = {};
    (d30R.data || []).forEach(a => { const m = tmap[a.work_date] || (tmap[a.work_date] = { late: 0, ot: 0 }); if (a.late_min > 0) m.late++; m.ot += otAdj(a.ot_hours, otWhole); });
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

    // การลาที่อนุมัติแล้วและจะถึงใน 14 วันข้างหน้า
    const upcoming_leaves = (upLvR.data || []).filter(l => !branch || empSet.has(l.emp_id)).map(l => {
      const e = l.end_date || l.start_date;
      return { emp_name: empName[l.emp_id] || l.emp_id, type: l.type || 'ลา', start_date: l.start_date, end_date: e,
        days: Math.round((new Date(e) - new Date(l.start_date)) / 86400000) + 1 };
    }).sort((a, b) => a.start_date < b.start_date ? -1 : 1);

    return { ok: true, cards, lists, shifts, trend, top_late, branches, upcoming_leaves };
  }

  // ---------- BOARD: บอร์ดวันนี้ (สาขา × กะ × คน + สถานะ) ----------
  async function hrBoard(date) {
    const d = date || bkkToday();
    const [schR, empsR, shR, brR, attR, lvR] = await Promise.all([
      sb().from('schedules').select('emp_id,shift_id,branch_id,is_cover,note').eq('work_date', d),
      sb().from('employees').select('emp_id,name,nickname,branch_id,photo_url'),
      sb().from('shifts').select('shift_id,name,code,start_time').order('start_time'),
      sb().from('branches').select('branch_id,name').order('branch_id'),
      sb().from('attendance').select('emp_id,check_in,check_out,late_min,status,branch_id,shift_id,face_match,gps_accuracy,photo_url,checkout_photo_url').eq('work_date', d),
      sb().from('leaves').select('emp_id,type,start_date,end_date,status').eq('status', 'approved').lte('start_date', d).gte('end_date', d),
    ]);
    if (schR.error) throw schR.error;
    const empById = {}, brName = {}, shById = {};
    (empsR.data || []).forEach(e => { empById[e.emp_id] = e; });
    (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    (shR.data || []).forEach(s => { shById[s.shift_id] = s; });
    const attBy = {}; (attR.data || []).forEach(a => { attBy[a.emp_id] = a; });
    const onLeave = {}; (lvR.data || []).forEach(l => { onLeave[l.emp_id] = l.type || 'ลา'; });

    // สถานะของแต่ละคน
    function statusOf(empId) {
      if (onLeave[empId]) return { status: 'leave', leave_type: onLeave[empId] };
      const a = attBy[empId];
      if (a && a.check_in) return { status: a.late_min > 0 ? 'late' : 'present', check_in: fmtTime(a.check_in), check_out: a.check_out ? fmtTime(a.check_out) : '', late_min: a.late_min || 0, att_branch: a.branch_id, face_match: a.face_match, gps_accuracy: a.gps_accuracy, att_photo_in: a.photo_url || '', att_photo_out: a.checkout_photo_url || '' };
      return { status: 'absent' };
    }

    // โครง: branch -> shift -> people[]
    const board = {};
    function ensure(brId, shId) {
      board[brId] = board[brId] || {};
      board[brId][shId] = board[brId][shId] || [];
      return board[brId][shId];
    }
    const scheduledEmp = new Set();
    (schR.data || []).forEach(s => {
      if (!s.shift_id) return;
      scheduledEmp.add(s.emp_id);
      const emp = empById[s.emp_id] || { emp_id: s.emp_id, name: s.emp_id };
      const brId = s.branch_id || emp.branch_id || '—';
      const home = emp.branch_id || null;
      const st = statusOf(s.emp_id);
      ensure(brId, s.shift_id).push({
        emp_id: s.emp_id, name: emp.nickname || emp.name, full_name: emp.name, nickname: emp.nickname || '', photo_url: emp.photo_url || '',
        is_cover: !!(s.is_cover || (home && brId !== home)),
        cover_from: (home && brId !== home) ? (brName[home] || home) : '',
        note: s.note || '', ...st,
      });
    });
    // คนที่เช็กอินแต่ไม่มีในตารางเวร (นอกตาราง)
    (attR.data || []).forEach(a => {
      if (scheduledEmp.has(a.emp_id) || !a.check_in) return;
      const emp = empById[a.emp_id] || { emp_id: a.emp_id, name: a.emp_id };
      const brId = a.branch_id || emp.branch_id || '—';
      ensure(brId, a.shift_id || '_none').push({
        emp_id: a.emp_id, name: emp.nickname || emp.name, full_name: emp.name, nickname: emp.nickname || '', photo_url: emp.photo_url || '',
        is_cover: false, cover_from: '', off_schedule: true,
        status: a.late_min > 0 ? 'late' : 'present', check_in: fmtTime(a.check_in), check_out: a.check_out ? fmtTime(a.check_out) : '', late_min: a.late_min || 0,
        att_photo_in: a.photo_url || '', att_photo_out: a.checkout_photo_url || '',
      });
    });

    // จัดรูปแบบผลลัพธ์ + สรุปนับ
    const sum = { scheduled: 0, present: 0, late: 0, absent: 0, leave: 0 };
    const branches = Object.keys(board).map(brId => {
      const shiftIds = Object.keys(board[brId]).sort((x, y) => {
        const sx = shById[x] ? shById[x].start_time : 'zzz', sy = shById[y] ? shById[y].start_time : 'zzz';
        return sx < sy ? -1 : 1;
      });
      const shifts = shiftIds.map(shId => {
        const people = board[brId][shId].sort((p, q) => (p.name || '').localeCompare(q.name || '', 'th'));
        const c = { present: 0, late: 0, absent: 0, leave: 0 };
        people.forEach(p => {
          if (p.off_schedule) return;            // คนนอกตารางไม่นับในสรุป
          if (c[p.status] !== undefined) c[p.status]++;
          if (sum[p.status] !== undefined) sum[p.status]++;
          sum.scheduled++;
        });
        const sh = shById[shId];
        return {
          shift_id: shId, shift_name: sh ? sh.name : (shId === '_none' ? 'นอกตาราง' : shId),
          code: sh ? (sh.code || '') : '', start_time: sh ? (sh.start_time || '') : '',
          counts: c, people,
        };
      });
      return { branch_id: brId, name: brName[brId] || brId, shifts };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'th'));

    return { ok: true, date: d, summary: sum, branches };
  }

  // ---------- SAVE EMPLOYEE ----------
  async function hrSave(d) {
    const row = {
      emp_id: d.emp_id, name: d.name, nickname: d.nickname || null,
      start_date: d.start_date || null,
      end_date: d.end_date || null,
      branch_id: d.branch_id || null, weekly_off: d.weekly_off || null,
      phone: d.phone || null, line_user_id: d.line_user_id || null, address: d.address || null,
      emergency_name: d.emergency_name || null, emergency_phone: d.emergency_phone || null,
      bank_name: d.bank_name || null, bank_account: d.bank_account || null, id_card: d.id_card || null,
      active: !!d.active,
      is_manager: !!d.is_manager,
    };
    // PIN ผจก.: ยกเลิกสิทธิ์ = ล้าง PIN · ตั้ง ผจก.+กรอก PIN ใหม่ = อัปเดต · ตั้ง ผจก.แต่เว้น PIN = คง PIN เดิม
    if (!d.is_manager) row.manager_pin = null;
    else if (d.manager_pin != null && String(d.manager_pin).trim() !== '') row.manager_pin = String(d.manager_pin).trim();
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
    // ลบข้อมูลผูกเพิ่มเติม กันข้อมูลค้าง (ไม่เช็ก error รายตาราง เผื่อบางดีพลอยยังไม่มีตารางนั้น)
    await sb().from('task_assignments').delete().eq('emp_id', empId);
    await sb().from('special_task_assignees').delete().eq('emp_id', empId);
    await sb().from('qa_folder_assignees').delete().eq('emp_id', empId);
    await sb().from('shift_leads').delete().eq('emp_id', empId);
    await sb().from('checkout_corrections').delete().eq('emp_id', empId);
    await sb().from('score_events').delete().eq('emp_id', empId);
    const { error } = await sb().from('employees').delete().eq('emp_id', empId);
    if (error) throw error;
    await logAct('ลบพนักงาน', empId, 'รหัส ' + empId + ' และข้อมูลที่ผูกอยู่');
    return { ok: true };
  }

  // เปลี่ยนรหัสพนักงาน (ย้ายข้อมูลทุกตารางผ่านฟังก์ชัน change_emp_id แบบ atomic)
  async function hrChangeEmpId(oldId, newId) {
    if (!oldId || !newId) return { ok: false, error: 'ต้องระบุรหัสเดิมและรหัสใหม่' };
    const { data, error } = await sb().rpc('change_emp_id', { p_old: String(oldId).trim(), p_new: String(newId).trim() });
    if (error) return { ok: false, error: error.message || 'เปลี่ยนรหัสไม่สำเร็จ (รัน change_emp_id.sql แล้วหรือยัง?)' };
    if (data && data.ok) await logAct('เปลี่ยนรหัสพนักงาน ' + oldId + ' → ' + newId, newId);
    return data || { ok: false, error: 'ไม่มีผลลัพธ์' };
  }

  // ---------- REPORT ----------
  async function hrReport(f) {
    let q = sb().from('attendance')
      .select('*, employees(name,photo_url,branch_id), shifts(name,day_value), branches(name)')
      .gte('work_date', f.start).lte('work_date', f.end)
      .order('work_date', { ascending: false });
    if (f.emp_id) q = q.eq('emp_id', f.emp_id);
    if (f.branch_id) q = q.eq('branch_id', f.branch_id);
    if (f.shift_id) q = q.eq('shift_id', f.shift_id);
    const today = bkkToday();
    // ตารางเวร + ใบลา ในช่วง (ใช้คำนวณ "ขาดงาน" และ "ลา" สำหรับ payroll)
    let sq = sb().from('schedules').select('emp_id,work_date,shift_id').gte('work_date', f.start).lte('work_date', f.end);
    if (f.emp_id) sq = sq.eq('emp_id', f.emp_id);
    let lq = sb().from('leaves').select('emp_id,start_date,end_date,status').eq('status', 'approved').lte('start_date', f.end).gte('end_date', f.start);
    if (f.emp_id) lq = lq.eq('emp_id', f.emp_id);
    // วันที่มาทำงานจริง (ไม่อิงฟิลเตอร์สาขา/กะ) ใช้คำนวณขาดงานให้ถูก แม้ไปทำแทนสาขาอื่น
    let wq = sb().from('attendance').select('emp_id,work_date').not('check_in', 'is', null).gte('work_date', f.start).lte('work_date', f.end);
    if (f.emp_id) wq = wq.eq('emp_id', f.emp_id);
    const [{ data, error }, brR, schR, lvR, empR, wR, shR2] = await Promise.all([
      q,
      sb().from('branches').select('branch_id,name'),
      sq, lq,
      sb().from('employees').select('emp_id,name,nickname,photo_url,branch_id'),
      wq,
      sb().from('shifts').select('shift_id,day_value'),
    ]);
    if (error) throw error;
    const brName = {};
    (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const empById = {};
    (empR.data || []).forEach(e => { empById[e.emp_id] = e; });

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
        shift_id: r.shift_id || '',
        day_value: (r.shifts && r.shifts.day_value != null) ? Number(r.shifts.day_value) : 1,
        early_out_min: r.early_out_min != null ? Number(r.early_out_min) : null,
        check_in: fmtTime(r.check_in), check_out: fmtTime(r.check_out),
        late_min: r.late_min || 0, ot_hours: r.ot_hours || 0,
        checkout_branch: r.checkout_branch_id ? (brName[r.checkout_branch_id] || r.checkout_branch_id) : '',
        checkout_note: r.checkout_note || '',
        cross_out: !!(r.checkout_branch_id && r.branch_id && r.checkout_branch_id !== r.branch_id),
        photo_url: r.photo_url || '', checkout_photo_url: r.checkout_photo_url || '', gps_lat: r.gps_lat, gps_lng: r.gps_lng, status: r.status,
      };
    });
    if (f.only_late) rows = rows.filter(r => r.late_min > 0);
    if (f.only_ot) rows = rows.filter(r => r.ot_hours > 0);
    if (f.only_cover) rows = rows.filter(r => r.is_cover);
    // แผนที่ day_value ต่อกะ (ใช้ถ่วงน้ำหนักวันจัดเวร/ขาด)
    const shDVmap = {}; (shR2.data || []).forEach(s => { shDVmap[s.shift_id] = s.day_value != null ? Number(s.day_value) : 1; });
    const dvOf = sid => (shDVmap[sid] != null ? shDVmap[sid] : 1);
    const earlyGrace = await getSettingNum('early_out_grace_min', 10);
    const otWhole = await getSettingBool('ot_whole_day');

    const map = {};
    function ensureM(empId) {
      if (map[empId]) return map[empId];
      const e = empById[empId] || {};
      return (map[empId] = {
        emp_id: empId, emp_name: e.name || empId, nickname: e.nickname || '', photo_url: e.photo_url || '',
        days: 0, days_home: 0, days_cover: 0, late_count: 0, late_total: 0,
        ot: 0, ot_days: 0, absent: 0, leave_days: 0, scheduled: 0, cover_by: {},
        early_out_days: 0, early_out_min: 0,
      });
    }
    // นับจากแถวลงเวลา (ตามฟิลเตอร์ที่เลือก) — ถ่วงน้ำหนักวันด้วย day_value ของกะ (ครึ่งวัน=0.5)
    rows.forEach(r => {
      const m = ensureM(r.emp_id);
      if (r.check_in) {
        const dv = r.day_value || 1;
        m.days += dv;
        if (r.is_cover) { m.days_cover += dv; m.cover_by[r.branch_name] = (m.cover_by[r.branch_name] || 0) + 1; }
        else m.days_home += dv;
        if (r.early_out_min != null && r.early_out_min > earlyGrace) { m.early_out_days++; m.early_out_min += r.early_out_min; }
      }
      if (r.late_min > 0) { m.late_count++; m.late_total += r.late_min; }
      if (Number(r.ot_hours) > 0) { m.ot += otAdj(r.ot_hours, otWhole); m.ot_days++; }
    });
    // วันที่มาทำงานจริง (ไม่อิงฟิลเตอร์สาขา/กะ) ใช้คำนวณขาดงาน
    const workedByEmp = {};
    (wR.data || []).forEach(r => { (workedByEmp[r.emp_id] || (workedByEmp[r.emp_id] = new Set())).add(r.work_date); });
    const lvByEmp = {};
    (lvR.data || []).forEach(l => { (lvByEmp[l.emp_id] || (lvByEmp[l.emp_id] = [])).push(l); });
    const onLeave = (emp, d) => (lvByEmp[emp] || []).some(l => d >= l.start_date && d <= (l.end_date || l.start_date));
    const inBranch = emp => !f.branch_id || (empById[emp] || {}).branch_id === f.branch_id;
    // ตารางเวร -> วันที่จัดเวร + ขาดงาน (วันที่จัดเวร ผ่านไปแล้ว ไม่มา ไม่ลา)
    const schByEmp = {};
    (schR.data || []).forEach(s => { if (s.shift_id) { (schByEmp[s.emp_id] || (schByEmp[s.emp_id] = {}))[s.work_date] = s.shift_id; } });
    Object.keys(schByEmp).forEach(emp => {
      if (!inBranch(emp)) return;
      const m = ensureM(emp);
      const dates = Object.keys(schByEmp[emp]);
      const worked = workedByEmp[emp] || new Set();
      let sc = 0, ab = 0;
      dates.forEach(d => { const dv = dvOf(schByEmp[emp][d]); sc += dv; if (d < today && !worked.has(d) && !onLeave(emp, d)) ab += dv; });
      m.scheduled = Math.round(sc * 10) / 10;
      m.absent = Math.round(ab * 10) / 10;
    });
    // ลา (วัน) ในช่วง
    Object.keys(lvByEmp).forEach(emp => {
      if (f.emp_id && emp !== f.emp_id) return;
      if (!inBranch(emp)) return;
      const m = ensureM(emp);
      let ld = 0;
      lvByEmp[emp].forEach(l => {
        const s = l.start_date < f.start ? f.start : l.start_date;
        const e = (l.end_date || l.start_date) > f.end ? f.end : (l.end_date || l.start_date);
        if (s <= e) ld += daysBetween(s, e);
      });
      m.leave_days = ld;
    });
    const summary = Object.values(map).map(m => ({
      ...m, ot: Math.round(m.ot * 100) / 100,
      days: Math.round(m.days * 10) / 10, days_home: Math.round(m.days_home * 10) / 10, days_cover: Math.round(m.days_cover * 10) / 10,
      early_out_hours: Math.round((m.early_out_min / 60) * 10) / 10,
      cover_detail: Object.keys(m.cover_by).map(k => k + ' ' + m.cover_by[k] + ' วัน').join(' · '),
    }));
    return { ok: true, rows, summary };
  }

  // ---------- DISCIPLINE ----------
  async function hrDiscipline(which, range) {
    // รองรับ: รอบ (current/previous/prev2/prev3) หรือ ช่วงวันที่กำหนดเอง {start,end}
    const cyc = (range && range.start && range.end)
      ? { start: range.start, end: range.end, startStr: range.start, endStr: range.end }
      : cycleRange(cycleBack(which));
    const today = bkkToday();
    const endEff = cyc.end < today ? cyc.end : today;
    const discRules = await loadDisciplineRules();
    const [empsR, attR, holR, lvR, schR, shDVR] = await Promise.all([
      sb().from('employees').select('emp_id,name,photo_url,weekly_off,start_date,branch_id').eq('active', true),
      sb().from('attendance').select('emp_id,work_date,check_in,late_min,ot_hours,shift_id,early_out_min').gte('work_date', cyc.start).lte('work_date', endEff),
      sb().from('holidays').select('date').eq('active', true).gte('date', cyc.start).lte('date', cyc.end),
      sb().from('leaves').select('emp_id,start_date,end_date,status').eq('status', 'approved').lte('start_date', cyc.end).gte('end_date', cyc.start),
      sb().from('schedules').select('emp_id,work_date,shift_id').gte('work_date', cyc.start).lte('work_date', endEff),
      sb().from('shifts').select('shift_id,day_value'),
    ]);
    if (empsR.error) throw empsR.error;
    const holidaySet = new Set((holR.data || []).map(h => h.date));
    const att = attR.data || [], leaves = lvR.data || [];
    const dvMap = {}; (shDVR.data || []).forEach(s => { dvMap[s.shift_id] = s.day_value != null ? Number(s.day_value) : 1; });
    const dvOf = sid => (dvMap[sid] != null ? dvMap[sid] : 1);
    const earlyGrace = await getSettingNum('early_out_grace_min', 10);
    const earlyWarnDays = await getSettingNum('early_out_warn_days', 3);
    const otWhole = await getSettingBool('ot_whole_day');
    // ตารางเวรต่อพนักงาน (map วันที่ → กะ ไว้ถ่วงน้ำหนักครึ่งวัน)
    const schByEmp = {};
    (schR.data || []).forEach(s => { if (s.shift_id) { (schByEmp[s.emp_id] || (schByEmp[s.emp_id] = {}))[s.work_date] = s.shift_id; } });

    const employees = (empsR.data || []).map(e => {
      const myAtt = att.filter(a => a.emp_id === e.emp_id);
      const workedSet = new Set(myAtt.filter(a => a.check_in).map(a => a.work_date));
      const late = myAtt.filter(a => a.late_min > 0);
      const late_count = late.length;
      const late_total = late.reduce((s, a) => s + (a.late_min || 0), 0);
      const ot_hours = Math.round(myAtt.reduce((s, a) => s + otAdj(a.ot_hours, otWhole), 0) * 10) / 10;
      const myLeaves = leaves.filter(l => l.emp_id === e.emp_id);
      const onLeave = (dateStr) => myLeaves.some(l => dateStr >= l.start_date && dateStr <= (l.end_date || l.start_date));

      // ถ่วงน้ำหนักวันด้วย day_value ของกะ (ครึ่งวัน=0.5) — มีผลกับ "วันทำงาน/ขาด/วินัย"
      const attDV = {}; myAtt.forEach(a => { if (a.check_in) attDV[a.work_date] = dvOf(a.shift_id); });
      const days_worked = Math.round([...workedSet].reduce((s, d) => s + (attDV[d] || 1), 0) * 10) / 10;
      // ออกก่อนเวลา (เกินผ่อนผัน) — เก็บจำนวนครั้ง + รวมนาที
      const earlyRows = myAtt.filter(a => a.early_out_min != null && a.early_out_min > earlyGrace);
      const early_out_count = earlyRows.length;
      const early_out_min = earlyRows.reduce((s, a) => s + (a.early_out_min || 0), 0);
      // นับเฉพาะ "วันที่มีการจัดเวรที่ผ่านไปแล้ว (ก่อนวันนี้)" · ขาด = จัดเวรแต่ไม่มา+ไม่ลา (ถ่วง day_value)
      const basis = 'roster';
      const mySchedMap = schByEmp[e.emp_id] || {};
      const pastSched = Object.keys(mySchedMap).filter(d => d < today);
      const days_should = Math.round(pastSched.reduce((s, d) => s + dvOf(mySchedMap[d]), 0) * 10) / 10;
      let absent = 0;
      pastSched.forEach(d => { if (!workedSet.has(d) && !onLeave(d)) absent += dvOf(mySchedMap[d]); });
      absent = Math.round(absent * 10) / 10;
      const lv = disciplineLevel(late_count, absent, discRules);
      return {
        emp_id: e.emp_id, emp_name: e.name, photo_url: e.photo_url || '', branch_id: e.branch_id || '',
        late_count, late_total, ot_hours, absent,
        early_out_count, early_out_hours: Math.round((early_out_min / 60) * 10) / 10,
        early_out_warn: early_out_count >= earlyWarnDays,
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
    await logAct('HR บันทึกใบลา', d.emp_id, (d.type || 'ลา') + ' ' + row.start_date + (row.end_date !== row.start_date ? (' ถึง ' + row.end_date) : '') + ' · สถานะ ' + row.status);
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
    if (d.line_group_id !== undefined) row.line_group_id = (d.line_group_id || '').trim() || null;   // กลุ่ม LINE ต่อสาขา (รับสินค้า)
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
    // index ตารางเวร: key = emp_id|work_date → array ของกะ (รองรับควบกะหลายกะ/วัน)
    const cells = {};
    (schR.data || []).forEach(s => { const k = s.emp_id + '|' + s.work_date; (cells[k] = cells[k] || []).push(s); });
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
    const { error } = await sb().from('schedules').upsert(row, { onConflict: 'emp_id,work_date,shift_id' });
    if (error) throw error;
    // ---- ซิงค์กะให้ "แถวลงเวลา" ตามตารางเวรที่เพิ่งจัด ----
    // แก้ปัญหา: HR เปลี่ยนกะหลังพนักงานเช็กอินแล้ว → attendance.shift_id ยังค้างกะเดิม
    // ทำให้รายงาน(กรองกะ)/แจ้งเตือน "เลยเวลาเลิกกะ" เพี้ยน
    // เงื่อนไข: มีแถวลงเวลาที่เช็กอินแล้วในวันนั้น และกะที่ค้าง "ไม่ตรงกับตารางเวรปัจจุบัน" (กันแตะเคสควบกะที่กะเดิมยังอยู่)
    try {
      if (d.shift_id) {
        const { data: att } = await sb().from('attendance')
          .select('shift_id,check_in').eq('emp_id', d.emp_id).eq('work_date', d.work_date).maybeSingle();
        if (att && att.check_in) {
          const { data: daySched } = await sb().from('schedules').select('shift_id').eq('emp_id', d.emp_id).eq('work_date', d.work_date);
          const schSet = new Set((daySched || []).map(s => s.shift_id).filter(Boolean));
          if (!schSet.has(att.shift_id)) {   // กะที่ค้างในแถวลงเวลาไม่อยู่ในตารางเวรแล้ว → ปรับตามกะที่จัดใหม่
            await sb().from('attendance').update({ shift_id: d.shift_id }).eq('emp_id', d.emp_id).eq('work_date', d.work_date);
            await logAct('ปรับกะแถวลงเวลาให้ตรงตารางเวร', d.emp_id, d.work_date + ' · ' + (att.shift_id || '—') + ' → ' + d.shift_id);
          }
        }
      }
    } catch (e) { console.warn('sync attendance shift', e); }
    return { ok: true, is_cover };
  }
  async function hrSchedDelete(empId, workDate, shiftId) {
    let q = sb().from('schedules').delete().eq('emp_id', empId).eq('work_date', workDate);
    if (shiftId) q = q.eq('shift_id', shiftId);   // ลบเฉพาะกะที่ระบุ (ควบกะ) · ไม่ระบุ = ลบทุกกะของวันนั้น
    const { error } = await q;
    if (error) throw error;
    return { ok: true };
  }
  // จัด 1 วัน → เติมกะเดียวกันทั้งสัปดาห์ (เฉพาะวันที่ยังว่าง) แล้วแก้ทีหลังได้
  async function hrSchedFillWeek(d) {
    if (!d || !d.emp_id || !d.start || !d.shift_id) return { ok: false, error: 'ข้อมูลไม่ครบ' };
    const { data: emp } = await sb().from('employees').select('branch_id').eq('emp_id', d.emp_id).maybeSingle();
    const home = emp ? emp.branch_id : null;
    const rows = [];
    for (let i = 0; i < 7; i++) rows.push({ emp_id: d.emp_id, work_date: addDays(d.start, i), shift_id: d.shift_id, branch_id: home, is_cover: false, note: null });
    const { error } = await sb().from('schedules').upsert(rows, { onConflict: 'emp_id,work_date,shift_id' });
    if (error) throw error;
    return { ok: true, count: rows.length };
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
    const { error: e2 } = await sb().from('schedules').upsert(rows, { onConflict: 'emp_id,work_date,shift_id' });
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
      main_shift: (d.main_shift === undefined) ? undefined : (d.main_shift || null),  // ผลัดหลักที่สังกัด (ว่าง=พิเศษ)
      no_ot: (d.no_ot === undefined) ? undefined : !!d.no_ot,   // กะนี้ไม่คิด OT (เช่น กะ ผจก.)
      day_value: (d.day_value === undefined) ? undefined : (Number(d.day_value) === 0.5 ? 0.5 : 1.0),  // 0.5 = กะครึ่งวัน
    };
    if (row.no_ot === undefined) delete row.no_ot;
    if (row.main_shift === undefined) delete row.main_shift;
    if (row.day_value === undefined) delete row.day_value;
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

  // ---------- คลัง (Warehouses) — ใช้ร่วมทุกสาขา ----------
  async function hrWhList() {
    const { data, error } = await sb().from('warehouses').select('*').order('sort').order('id');
    if (error) throw error;
    return { ok: true, rows: data || [] };
  }
  async function hrWhSave(d) {
    d = d || {};
    if (!d.name || !String(d.name).trim()) return { ok: false, error: 'กรอกชื่อคลัง' };
    const row = { code: (d.code || '').trim() || null, name: String(d.name).trim(), active: d.active !== false, sort: Number(d.sort) || 0 };
    if (d.id) { const { error } = await sb().from('warehouses').update(row).eq('id', d.id); if (error) throw error; }
    else { const { error } = await sb().from('warehouses').insert(row); if (error) throw error; }
    await logAct('บันทึกคลัง', null, row.name);
    return { ok: true };
  }
  async function hrWhDelete(id) {
    if (!id) return { ok: false, error: 'ไม่ระบุคลัง' };
    const { count } = await sb().from('goods_receipts').select('id', { count: 'exact', head: true }).eq('warehouse_id', id);
    if (count && count > 0) return { ok: false, error: 'ลบไม่ได้: มีประวัติรับสินค้าคลังนี้ ' + count + ' รายการ (ปิดใช้งานแทนได้)' };
    const { error } = await sb().from('warehouses').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }
  // ---------- รับสินค้า: รายการ + ค้นหาเลขรัน ----------
  async function hrGoodsList(f) {
    f = f || {};
    let q = sb().from('goods_receipts').select('*').order('submitted_at', { ascending: false }).limit(500);
    if (f.branch_id) q = q.eq('branch_id', f.branch_id);
    if (f.warehouse_id) q = q.eq('warehouse_id', f.warehouse_id);
    if (f.ref_no) q = q.eq('ref_no', String(f.ref_no).trim());
    if (f.start) q = q.gte('work_date', f.start);
    if (f.end) q = q.lte('work_date', f.end);
    const [gr, brR] = await Promise.all([q, sb().from('branches').select('branch_id,name')]);
    if (gr.error) throw gr.error;
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const rows = (gr.data || []).map(r => ({ ...r, branch_name: brName[r.branch_id] || r.branch_id || '—' }));
    return { ok: true, rows };
  }
  // ออดิทลัง: รวมต่อสาขา×คลัง — คงค้าง (สะสมถึงวันสิ้นสุด) + กิจกรรมในช่วง + ส่วนต่าง
  async function hrGoodsAudit(f) {
    f = f || {};
    let q = sb().from('goods_receipts').select('branch_id,warehouse_id,warehouse_name,warehouse_code,crates_in,crates_return,diff,work_date').limit(5000);
    if (f.branch_id) q = q.eq('branch_id', f.branch_id);
    if (f.warehouse_id) q = q.eq('warehouse_id', f.warehouse_id);
    if (f.end) q = q.lte('work_date', f.end);   // คงค้างนับสะสมถึงวันสิ้นสุด
    const [gr, brR] = await Promise.all([q, sb().from('branches').select('branch_id,name')]);
    if (gr.error) throw gr.error;
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const groups = {};
    (gr.data || []).forEach(r => {
      const key = (r.branch_id || '') + '|' + r.warehouse_id;
      const g = groups[key] || (groups[key] = { branch_id: r.branch_id, branch_name: brName[r.branch_id] || r.branch_id || '—', warehouse_id: r.warehouse_id, warehouse_name: r.warehouse_name || ('คลัง #' + r.warehouse_id), warehouse_code: r.warehouse_code || '', outstanding: 0, range_in: 0, range_return: 0, range_docs: 0, range_diff_docs: 0, range_diff_sum: 0 });
      g.outstanding += (r.crates_in || 0) - (r.crates_return || 0);   // สะสมถึงวันสิ้นสุด
      const inRange = (!f.start || r.work_date >= f.start) && (!f.end || r.work_date <= f.end);
      if (inRange) { g.range_in += r.crates_in || 0; g.range_return += r.crates_return || 0; g.range_docs++; if ((r.diff || 0) !== 0) g.range_diff_docs++; g.range_diff_sum += (r.diff || 0); }
    });
    const rows = Object.values(groups).sort((a, b) => (a.branch_name || '').localeCompare(b.branch_name || '', 'th') || (a.warehouse_name || '').localeCompare(b.warehouse_name || '', 'th'));
    return { ok: true, rows };
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

  // ข้อเสนอแนะเพิ่มเติมการลา → สถานะ 'proposed' + ข้อความถึงพนักงาน (HR แก้กะ+อนุมัติเองภายหลัง)
  async function hrLeaveProposeConditional(leaveId, message) {
    if (!leaveId) return { ok: false, error: 'ไม่ระบุใบลา' };
    const msg = String(message || '').trim();
    if (!msg) return { ok: false, error: 'กรุณาพิมพ์ข้อเสนอแนะเพิ่มเติมถึงพนักงาน' };
    const { data: lv } = await sb().from('leaves').select('emp_id,type,start_date,end_date').eq('leave_id', leaveId).maybeSingle();
    if (!lv) return { ok: false, error: 'ไม่พบใบลา' };
    const upd = { status: 'proposed', proposal_msg: msg, proposal_at: new Date().toISOString(), proposal_seen: false, response: null, response_msg: null, response_at: null };
    const { error } = await sb().from('leaves').update(upd).eq('leave_id', leaveId);
    if (error) throw error;
    const range = lv.start_date + (lv.end_date && lv.end_date !== lv.start_date ? (' – ' + lv.end_date) : '');
    await logAct('ส่งข้อเสนอแนะเพิ่มเติม (การลา)', lv.emp_id, (lv.type || 'ลา') + ' ' + range + ' · ' + msg.slice(0, 120));
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
  async function hrNotifications(branch, date) {
    const today = bkkToday();
    const d = date || today;                 // วันที่ของภาพรวมรายวัน (ค่าเริ่มต้น = วันนี้)
    const isPast = d < today;
    const [lvR, todayR, schR, empR, lvApprR, subR, shR] = await Promise.all([
      sb().from('leaves').select('*, employees(name)').eq('status', 'pending').order('created_at', { ascending: false }),
      sb().from('attendance').select('emp_id,check_in,check_out,late_min,status,branch_id,shift_id,extend_until').eq('work_date', d),
      sb().from('schedules').select('emp_id,shift_id,branch_id').eq('work_date', d),
      sb().from('employees').select('emp_id,name,branch_id').eq('active', true),
      sb().from('leaves').select('emp_id,start_date,end_date').eq('status', 'approved').lte('start_date', d),
      sb().from('profile_submissions').select('id,emp_id,name,submitted_at').eq('status', 'pending').order('submitted_at', { ascending: false }),
      sb().from('shifts').select('shift_id,name,start_time,end_time'),
    ]);
    const empName = {}, empBranch = {}; (empR.data || []).forEach(e => { empName[e.emp_id] = e.name; empBranch[e.emp_id] = e.branch_id; });
    const activeSet = new Set((empR.data || []).map(e => e.emp_id));   // เฉพาะพนักงานที่ยัง active
    const att = (todayR.data || []).filter(a => !branch || a.branch_id === branch);
    const schRows = (schR.data || []).filter(s => (!branch || s.branch_id === branch) && activeSet.has(s.emp_id));   // ตัดกะของพนักงานที่ปิดใช้งานออก
    const checkedIn = new Set(att.filter(a => a.check_in).map(a => a.emp_id));
    const onleave = new Set((lvApprR.data || []).filter(l => d >= l.start_date && d <= (l.end_date || l.start_date)).map(l => l.emp_id));

    const pending_leaves = (lvR.data || []).filter(l => !branch || empBranch[l.emp_id] === branch).map(l => ({
      leave_id: l.leave_id, emp_id: l.emp_id, emp_name: (l.employees && l.employees.name) || l.emp_id,
      start_date: l.start_date, end_date: l.end_date, type: l.type, reason: l.reason,
      days: daysBetween(l.start_date, l.end_date || l.start_date),
    }));
    // เวลาปัจจุบัน (Asia/Bangkok) + ตารางเวลากะ
    const nowHM = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(11, 16);
    const shiftStart = {}, shiftEnd = {}, shiftName = {};
    (shR.data || []).forEach(s => { shiftStart[s.shift_id] = String(s.start_time || '').slice(0, 5); shiftEnd[s.shift_id] = String(s.end_time || '').slice(0, 5); shiftName[s.shift_id] = s.name; });
    // เตือน "ยังไม่กดออก" เฉพาะคนที่เลยเวลาเลิกกะ + ผ่อนผันแล้ว (ไม่ใช่ทันทีหลังเช็กอิน)
    const coGrace = await getSettingNum('checkout_grace_min', 15);
    const nowMin = hmToMin(nowHM);
    // ยึด "กะปัจจุบันจากตารางเวร" (รองรับ HR เปลี่ยนกะหลังเช็กอิน + ควบกะ) — ไม่ใช้กะที่ค้างในแถวลงเวลา
    let qSchOv = sb().from('schedules').select('emp_id,shift_id,work_date').gte('work_date', addDays(d, -1)).lte('work_date', d);
    if (branch) qSchOv = qSchOv.eq('branch_id', branch);
    const schByED = {};
    ((await qSchOv).data || []).forEach(s => { if (s.shift_id) (schByED[s.emp_id + '|' + s.work_date] = schByED[s.emp_id + '|' + s.work_date] || []).push(s.shift_id); });
    const effEndN = (empId, wd, snapShift) => {
      const sids = (schByED[empId + '|' + wd] && schByED[empId + '|' + wd].length) ? schByED[empId + '|' + wd] : [snapShift];
      let best = null, bestMs = -Infinity;
      for (const sid of sids) {
        const en = shiftEnd[sid]; if (!en) continue;
        const st = shiftStart[sid]; const overnight = !!st && en <= st;
        const endDate = overnight ? addDays(wd, 1) : wd;
        const ms = new Date(endDate + 'T' + en + ':00+07:00').getTime();
        if (ms > bestMs) { bestMs = ms; best = { en, endDate }; }
      }
      return best;
    };
    const isOverdueN = (empId, wd, snapShift) => {
      const e = effEndN(empId, wd, snapShift); if (!e) return false;
      if (e.endDate < today) return true;
      if (e.endDate === today) { const thr = hmToMin(e.en) + coGrace; return thr < 1440 && nowMin >= thr; }
      return false;
    };
    // รวมกะข้ามคืน: ดึงแถวที่ยังเปิดค้างจากเมื่อวาน (กะดึกเลิกเช้าวันถัดไป)
    let qYestOpen = sb().from('attendance').select('emp_id,shift_id,branch_id,check_in,check_out,extend_until').eq('work_date', addDays(d, -1)).not('check_in', 'is', null).is('check_out', null);
    if (branch) qYestOpen = qYestOpen.eq('branch_id', branch);
    const yestOpen = (await qYestOpen).data || [];
    const ncoRows = att.filter(a => a.check_in && !a.check_out).map(a => ({ ...a, work_date: d }))
      .concat(yestOpen.map(a => ({ ...a, work_date: addDays(d, -1) })));
    const not_checked_out = ncoRows.filter(a => {
      if (a.extend_until && new Date(a.extend_until).getTime() > Date.now()) return false;   // ประกาศควบกะต่อ → ยังไม่ถือว่าลืม
      return isOverdueN(a.emp_id, a.work_date, a.shift_id);
    }).map(a => { const e = effEndN(a.emp_id, a.work_date, a.shift_id); return { emp_id: a.emp_id, emp_name: empName[a.emp_id] || a.emp_id, check_in: fmtTime(a.check_in), shift_name: shiftName[a.shift_id] || '', end_time: (e ? e.en : (shiftEnd[a.shift_id] || '')) }; });
    const late_today = att.filter(a => a.late_min > 0)
      .map(a => ({ emp_id: a.emp_id, emp_name: empName[a.emp_id] || a.emp_id, late_min: a.late_min }));
    // เตือน "ขาด/ยังไม่มา" เฉพาะกะที่ถึงเวลาเข้างานแล้วเท่านั้น (ไม่ใช่ตอนเพิ่งจัดเวร)
    const absent_roster = (schRows).filter(s => {
      if (checkedIn.has(s.emp_id) || onleave.has(s.emp_id)) return false;
      const st = shiftStart[s.shift_id];
      if (!st) return false;            // ไม่มีเวลากะ = ยังไม่เตือน
      return isPast || nowHM >= st;     // วันย้อนหลัง = ถือว่าถึงเวลาแล้วทั้งหมด · วันนี้ = เฉพาะกะที่ถึงเวลาเข้าแล้ว
    }).map(s => ({ emp_id: s.emp_id, emp_name: empName[s.emp_id] || s.emp_id, shift_id: s.shift_id, shift_name: shiftName[s.shift_id] || s.shift_id, start_time: shiftStart[s.shift_id] }));

    const pending_profiles = (subR.data || []).filter(s => !branch || empBranch[s.emp_id] === branch).map(s => ({ id: s.id, emp_id: s.emp_id, name: s.name || s.emp_id }));
    // พนักงานตอบข้อเสนอแนะเพิ่มเติมการลาแล้ว (รอ HR ปรับกะ+อนุมัติ)
    const { data: lrData } = await sb().from('leaves')
      .select('leave_id,emp_id,type,start_date,end_date,response,response_msg,proposal_msg,response_at')
      .eq('status', 'proposed').not('response', 'is', null).order('response_at', { ascending: false });
    const leave_responses = (lrData || []).filter(l => !branch || empBranch[l.emp_id] === branch).map(l => ({
      leave_id: l.leave_id, emp_id: l.emp_id, emp_name: empName[l.emp_id] || l.emp_id, type: l.type,
      start_date: l.start_date, end_date: l.end_date, response: l.response, response_msg: l.response_msg, proposal_msg: l.proposal_msg,
    }));
    // ใบสมัครงานใหม่ (กันตารางยังไม่ถูกสร้าง)
    let new_applicants = [];
    try {
      const { data: appR } = await sb().from('applicants').select('id,full_name,position,branch_id,created_at').eq('status', 'new').order('created_at', { ascending: false }).limit(30);
      new_applicants = (appR || []).filter(a => !branch || a.branch_id === branch).map(a => ({ id: a.id, full_name: a.full_name, position: a.position || '', created_at: a.created_at }));
    } catch (e) { /* ตาราง applicants ยังไม่มี */ }
    return {
      ok: true, pending_leaves, not_checked_out, late_today, absent_roster, pending_profiles, leave_responses, new_applicants,
      counts: { pending_leaves: pending_leaves.length, not_checked_out: not_checked_out.length, late_today: late_today.length, absent_roster: absent_roster.length, pending_profiles: pending_profiles.length, leave_responses: leave_responses.length, new_applicants: new_applicants.length },
    };
  }

  // ---------- ประวัติแจ้งเตือน (push ที่ส่งแล้ว + ประกาศที่ HR เขียนเอง) ----------
  async function hrNotifyHistory() {
    const [sentR, annR, empR] = await Promise.all([
      sb().from('notify_sent').select('*').order('sent_at', { ascending: false }).limit(200),
      sb().from('announcements').select('*').order('created_at', { ascending: false }).limit(100),
      sb().from('employees').select('emp_id,name,nickname'),
    ]);
    const nm = {}; (empR.data || []).forEach(e => { nm[e.emp_id] = e.nickname || e.name; });
    const TYPES = {
      nocheckout: { label: 'ลืมกดออก', color: '#0ea5e9' },
      late: { label: 'มาสาย', color: '#ea580c' },
      absent: { label: 'ขาด/ยังไม่มา', color: '#b91c1c' },
      leave: { label: 'ใบลาใหม่', color: '#16a34a' },
      profile: { label: 'ข้อมูลรอตรวจ', color: '#7c3aed' },
      ho: { label: 'ส่ง/รับผลัด', color: '#0891b2' },
    };
    const events = (sentR.data || []).map(s => {
      const parts = String(s.event_key || '').split(':');
      const t = TYPES[parts[0]] || { label: parts[0] || 'แจ้งเตือน', color: '#64748b' };
      // นามคน: รูปแบบ type:emp:date(:shift) → parts[1] เป็น emp_id
      const empId = (['nocheckout', 'late', 'absent'].includes(parts[0])) ? parts[1] : '';
      return {
        kind: 'push', type: parts[0], label: t.label, color: t.color,
        who: empId ? (nm[empId] || empId) : '', at: s.sent_at, key: s.event_key,
      };
    });
    const announces = (annR.data || []).map(a => ({
      kind: 'announce', id: a.id, label: 'ประกาศถึงพนักงาน',
      color: a.level === 'urgent' ? '#dc2626' : (a.level === 'warn' ? '#d97706' : '#2563eb'),
      level: a.level, message: a.message, active: a.active, expire_date: a.expire_date,
      at: a.created_at, created_by: a.created_by,
    }));
    const all = events.concat(announces).sort((x, y) => (y.at || '') < (x.at || '') ? -1 : 1);
    return { ok: true, items: all, announcements: announces };
  }

  async function hrAnnounceSave(d) {
    if (!d || !d.message || !d.message.trim()) return { ok: false, error: 'ต้องมีข้อความ' };
    const row = { message: d.message.trim(), level: d.level || 'info', expire_date: d.expire_date || null, active: true, created_by: 'HR' };
    const { error } = await sb().from('announcements').insert(row);
    if (error) throw error;
    return { ok: true };
  }
  async function hrAnnounceDelete(id) {
    const { error } = await sb().from('announcements').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
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

  // ============================================================
  // SCORE SYSTEM — ระบบคะแนนวินัยรายเดือน (รอบ 21–20)
  // ============================================================
  async function hrScoreGet(which) {
    const cyc = cycleRange(which === 'previous' ? 'previous' : 'current');
    const today = bkkToday();
    const endEff = cyc.end < today ? cyc.end : today;
    const [cfgR, rulesR, bandsR, empsR, attR, schR, lvR, evR] = await Promise.all([
      sb().from('score_config').select('*').eq('id', 1).maybeSingle(),
      sb().from('score_rules').select('*').order('sort'),
      sb().from('score_bands').select('*').order('sort'),
      sb().from('employees').select('emp_id,name,nickname,photo_url,branch_id').eq('active', true),
      sb().from('attendance').select('emp_id,work_date,check_in,late_min').gte('work_date', cyc.start).lte('work_date', endEff),
      sb().from('schedules').select('emp_id,work_date').gte('work_date', cyc.start).lte('work_date', endEff),
      sb().from('leaves').select('emp_id,start_date,end_date,status').eq('status', 'approved').lte('start_date', cyc.end).gte('end_date', cyc.start),
      sb().from('score_events').select('*').gte('event_date', cyc.start).lte('event_date', cyc.end),
    ]);
    if (empsR.error) throw empsR.error;
    const start = (cfgR.data && cfgR.data.start_score) || 100;
    const rules = rulesR.data || [];
    const bands = (bandsR.data || []).slice().sort((a, b) => b.min_score - a.min_score);
    const ruleByKind = {};
    rules.forEach(r => { if (r.enabled !== false) ruleByKind[r.kind] = r; });
    const att = attR.data || [], leaves = lvR.data || [], events = evR.data || [];
    const schByEmp = {};
    (schR.data || []).forEach(s => { (schByEmp[s.emp_id] || (schByEmp[s.emp_id] = new Set())).add(s.work_date); });
    const bandFor = (sc) => bands.find(b => sc >= b.min_score && sc <= b.max_score) || null;

    const employees = (empsR.data || []).map(e => {
      const myAtt = att.filter(a => a.emp_id === e.emp_id && a.check_in);
      const myLeaves = leaves.filter(l => l.emp_id === e.emp_id);
      const onLeave = d => myLeaves.some(l => d >= l.start_date && d <= (l.end_date || l.start_date));
      const items = [];
      let autoDeduct = 0;
      // มาสาย (แยกช่วง)
      const tiers = [
        { kind: 'auto_late_1_10',   test: m => m >= 1 && m <= 10 },
        { kind: 'auto_late_11_30',  test: m => m >= 11 && m <= 30 },
        { kind: 'auto_late_30plus', test: m => m > 30 },
      ];
      tiers.forEach(t => {
        const r = ruleByKind[t.kind]; if (!r) return;
        const hits = myAtt.filter(a => t.test(a.late_min || 0));
        if (hits.length) { const sum = r.points * hits.length; autoDeduct += sum; items.push({ label: r.label, count: hits.length, points: sum, source: 'auto' }); }
      });
      // ขาดและไม่แจ้ง (วันที่จัดเวรไว้ ผ่านไปแล้ว ไม่มา ไม่ลา)
      const ra = ruleByKind['auto_absent_no_notify'];
      if (ra) {
        const mySched = [...(schByEmp[e.emp_id] || new Set())].filter(d => d < today);
        const workedSet = new Set(myAtt.map(a => a.work_date));
        const absDays = mySched.filter(d => !workedSet.has(d) && !onLeave(d));
        if (absDays.length) { const sum = ra.points * absDays.length; autoDeduct += sum; items.push({ label: ra.label, count: absDays.length, points: sum, source: 'auto' }); }
      }
      // เหตุการณ์ที่ HR เพิ่มเอง
      const myEv = events.filter(ev => ev.emp_id === e.emp_id);
      let manualDeduct = 0;
      myEv.forEach(ev => { manualDeduct += ev.points; items.push({ label: ev.label || '(เหตุการณ์)', count: 1, points: ev.points, source: 'manual', date: ev.event_date, note: ev.note, id: ev.id }); });

      let score = start + autoDeduct + manualDeduct;
      if (score < 0) score = 0;
      const band = bandFor(score);
      return {
        emp_id: e.emp_id, emp_name: e.name, nickname: e.nickname || '', photo_url: e.photo_url || '', branch_id: e.branch_id || '',
        start, score, auto_deduct: autoDeduct, manual_deduct: manualDeduct, total_deduct: autoDeduct + manualDeduct,
        items,
        band_label: band ? band.label : '', band_color: band ? band.color : '#475569',
        bonus: band && band.bonus_amount ? band.bonus_amount : 0,
        warn_level: band ? band.warn_level : null, warn_name: band ? band.warn_name : null,
      };
    }).sort((a, b) => a.score - b.score);

    return { ok: true, cycle: cyc, start_score: start, bands: bandsR.data || [], employees };
  }

  async function hrScoreConfigGet() {
    const [cfgR, rulesR, bandsR] = await Promise.all([
      sb().from('score_config').select('*').eq('id', 1).maybeSingle(),
      sb().from('score_rules').select('*').order('sort'),
      sb().from('score_bands').select('*').order('sort'),
    ]);
    return { ok: true, start_score: (cfgR.data && cfgR.data.start_score) || 100, rules: rulesR.data || [], bands: bandsR.data || [] };
  }
  async function hrScoreConfigSave(d) {
    const s = parseInt(d.start_score);
    const { error } = await sb().from('score_config').upsert({ id: 1, start_score: (isFinite(s) && s > 0) ? s : 100 }, { onConflict: 'id' });
    if (error) throw error;
    await logAct('แก้ไขคะแนนเริ่มต้น', null, 'คะแนนเริ่มเดือน = ' + (isFinite(s) ? s : 100));
    return { ok: true };
  }
  async function hrScoreRulesSave(data) {
    if (!Array.isArray(data) || !data.length) return { ok: false, error: 'ไม่มีข้อมูลกฎ' };
    const rows = data.map(r => ({
      rule_key: r.rule_key, label: r.label, kind: r.kind,
      points: Number(r.points) || 0,
      range_min: (r.range_min === '' || r.range_min == null) ? null : Number(r.range_min),
      enabled: r.enabled !== false, sort: Number(r.sort) || 0,
    }));
    const { error } = await sb().from('score_rules').upsert(rows, { onConflict: 'rule_key' });
    if (error) throw error;
    await logAct('แก้ไขกฎคะแนนวินัย', null, 'อัปเดต ' + rows.length + ' กฎ');
    return { ok: true };
  }
  async function hrScoreRuleDelete(rule_key) {
    if (!rule_key) return { ok: false, error: 'ไม่ระบุกฎ' };
    const { data: r } = await sb().from('score_rules').select('kind,label').eq('rule_key', rule_key).maybeSingle();
    if (!r) return { ok: false, error: 'ไม่พบกฎนี้' };
    if (r.kind !== 'manual') return { ok: false, error: 'ลบได้เฉพาะกฎ manual (กฎ auto ระบบต้องใช้)' };
    const { error } = await sb().from('score_rules').delete().eq('rule_key', rule_key);
    if (error) throw error;
    await logAct('ลบกฎคะแนนวินัย', null, r.label || rule_key);
    return { ok: true };
  }
  async function hrScoreBandsSave(data) {
    if (!Array.isArray(data) || !data.length) return { ok: false, error: 'ไม่มีข้อมูลแถบ' };
    const rows = data.map(b => ({
      id: b.id, min_score: Number(b.min_score), max_score: Number(b.max_score),
      label: b.label, bonus_amount: (b.bonus_amount === '' || b.bonus_amount == null) ? 0 : Number(b.bonus_amount),
      warn_level: (b.warn_level === '' || b.warn_level == null) ? null : Number(b.warn_level),
      warn_name: b.warn_name || null, color: b.color || '#475569', sort: Number(b.sort) || 0,
    }));
    const { error } = await sb().from('score_bands').upsert(rows, { onConflict: 'id' });
    if (error) throw error;
    await logAct('แก้ไขแถบผลคะแนน', null, 'อัปเดต ' + rows.length + ' แถบ');
    return { ok: true };
  }
  async function hrScoreEventAdd(d) {
    if (!d.emp_id || !d.rule_key) return { ok: false, error: 'ต้องระบุพนักงานและเหตุ' };
    const { data: rule } = await sb().from('score_rules').select('*').eq('rule_key', d.rule_key).maybeSingle();
    let points = Number(d.points);
    if (!isFinite(points)) points = rule ? rule.points : 0;
    if (rule) {
      const hi = rule.points, lo = rule.range_min != null ? rule.range_min : rule.points;
      const maxV = Math.max(hi, lo), minV = Math.min(hi, lo);
      if (points > maxV) points = maxV; if (points < minV) points = minV;
    }
    if (points > 0) points = -Math.abs(points);
    const row = {
      emp_id: d.emp_id, event_date: d.event_date || bkkToday(),
      rule_key: d.rule_key, label: rule ? rule.label : (d.label || 'เหตุการณ์'),
      points, note: d.note || null,
    };
    const { error } = await sb().from('score_events').insert(row);
    if (error) throw error;
    // แจ้งพนักงาน (โปร่งใส) — กล่องแจ้งเตือน emp_notifications
    try {
      await sb().from('emp_notifications').insert({
        emp_id: d.emp_id, kind: 'score_deduct',
        title: 'คะแนนวินัยถูกหัก ' + Math.abs(points) + ' คะแนน',
        body: 'เหตุผล: ' + (d.note || row.label || '-') + '\nดูคะแนนรวมล่าสุดในหน้า "สถานะของฉัน"',
        ref: 'score', created_by: 'HR',
      });
    } catch (e) { console.warn('emp_notify', e); }
    await logAct('ตัดคะแนนวินัย', d.emp_id, row.label + ' (' + points + ')' + (d.note ? (' · ' + d.note) : ''));
    return { ok: true };
  }
  async function hrScoreEventList(empId, which) {
    const cyc = cycleRange(which === 'previous' ? 'previous' : 'current');
    let q = sb().from('score_events').select('*').gte('event_date', cyc.start).lte('event_date', cyc.end).order('event_date', { ascending: false });
    if (empId) q = q.eq('emp_id', empId);
    const { data, error } = await q;
    if (error) throw error;
    return { ok: true, rows: data || [], cycle: cyc };
  }
  async function hrScoreEventDelete(id) {
    const { data: ev } = await sb().from('score_events').select('emp_id,label,points').eq('id', id).maybeSingle();
    const { error } = await sb().from('score_events').delete().eq('id', id);
    if (error) throw error;
    await logAct('ลบรายการตัดคะแนน', ev ? ev.emp_id : null, ev ? (ev.label + ' (' + ev.points + ')') : '');
    return { ok: true };
  }
  async function hrScoreIssueWarnings(which) {
    const sc = await hrScoreGet(which);
    if (!sc.ok) return sc;
    const cyc = sc.cycle;
    const { data: existing } = await sb().from('warnings').select('emp_id,level,cycle_start').eq('cycle_start', cyc.start);
    const has = new Set((existing || []).map(w => w.emp_id + '|' + w.level));
    const targets = sc.employees.filter(e => e.warn_level != null);
    let issued = 0;
    for (const e of targets) {
      if (has.has(e.emp_id + '|' + e.warn_level)) continue;
      const year = new Date().getFullYear();
      const { count } = await sb().from('warnings').select('warning_id', { count: 'exact', head: true }).like('warning_id', 'W-' + year + '-%');
      const warning_id = 'W-' + year + '-' + String((count || 0) + 1).padStart(4, '0');
      const { error } = await sb().from('warnings').insert({
        warning_id, emp_id: e.emp_id, issue_date: bkkToday(),
        level: e.warn_level, level_name: e.warn_name,
        cycle_start: cyc.start, cycle_end: cyc.end,
        late_count: 0, late_total: 0, absent_count: 0,
        reason: '[ระบบคะแนนวินัย] คะแนนปลายเดือน ' + e.score + '/' + e.start + ' → ' + e.band_label, issued_by: 'HR(คะแนน)',
      });
      if (!error) { issued++; has.add(e.emp_id + '|' + e.warn_level); await logAct('ออกใบเตือน ' + warning_id, e.emp_id, '(จากคะแนนวินัย) ' + e.warn_name + ' · คะแนน ' + e.score); }
    }
    return { ok: true, issued, total: targets.length };
  }

  // ---------- HANDOVER (ส่ง/รับผลัด) ----------
  async function hrHandoverList() {
    const [hR, brR] = await Promise.all([
      sb().from('handovers').select('*').order('created_at', { ascending: false }).limit(120),
      sb().from('branches').select('branch_id,name'),
    ]);
    if (hR.error) throw hR.error;
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const rows = (hR.data || []).map(h => ({ ...h, branch_name: brName[h.branch_id] || h.branch_id || '—' }));
    const counts = {
      no_handover: rows.filter(r => r.status === 'no_handover').length,
      rejected: rows.filter(r => r.status === 'rejected').length,
      pending: rows.filter(r => r.status === 'sent').length,
    };
    return { ok: true, rows, counts };
  }

  // ---------- TASKS (งานในกะ) ----------
  async function hrTaskDefsGet() {
    const { data, error } = await sb().from('task_defs').select('*').order('sort');
    if (error) throw error;
    return { ok: true, rows: data || [] };
  }
  async function hrTaskDefSave(d) {
    if (!d || !d.title) return { ok: false, error: 'ต้องมีชื่องาน' };
    const mp = (Number(d.min_photos) >= 0) ? Number(d.min_photos) : 0;
    const row = { title: String(d.title).trim(), require_photo: mp > 0, min_photos: mp, active: d.active !== false, sort: Number(d.sort) || 0, shift_id: d.shift_id || null };
    if (d.id) { const { error } = await sb().from('task_defs').update(row).eq('id', d.id); if (error) throw error; }
    else { const { error } = await sb().from('task_defs').insert(row); if (error) throw error; }
    return { ok: true };
  }
  async function hrTaskDefDelete(id) {
    const { error } = await sb().from('task_defs').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }
  async function hrTaskAssign(d) {
    if (!d || !d.emp_id || !Array.isArray(d.def_ids) || !d.def_ids.length) return { ok: false, error: 'เลือกพนักงานและงานอย่างน้อย 1 รายการ' };
    const date = d.work_date || bkkToday();
    const { data: emp } = await sb().from('employees').select('emp_id,name,nickname,branch_id').eq('emp_id', d.emp_id).maybeSingle();
    if (!emp) return { ok: false, error: 'ไม่พบพนักงาน' };
    const { data: defs } = await sb().from('task_defs').select('*').in('id', d.def_ids);
    const { data: existing } = await sb().from('task_assignments').select('task_def_id').eq('emp_id', d.emp_id).eq('work_date', date);
    const have = new Set((existing || []).map(x => x.task_def_id));
    const shift = d.shift_id || emp.default_shift || null;
    const rows = (defs || []).filter(df => !have.has(df.id)).map(df => ({
      work_date: date, emp_id: emp.emp_id, emp_name: emp.nickname || emp.name, branch_id: emp.branch_id || null,
      task_def_id: df.id, title: df.title, require_photo: !!df.require_photo, status: 'todo', shift_id: shift,
    }));
    if (!rows.length) return { ok: true, added: 0 };
    const { error } = await sb().from('task_assignments').insert(rows);
    if (error) throw error;
    await logAct('มอบหมายงาน', emp.emp_id, rows.length + ' งาน · ' + date);
    return { ok: true, added: rows.length };
  }
  async function hrTaskList(date) {
    const d = date || bkkToday();
    const [tR, brR] = await Promise.all([
      sb().from('task_assignments').select('*').eq('work_date', d).order('status').order('emp_name'),
      sb().from('branches').select('branch_id,name'),
    ]);
    if (tR.error) throw tR.error;
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const rows = (tR.data || []).map(t => ({ ...t, branch_name: brName[t.branch_id] || t.branch_id || '—' }));
    const counts = {
      submitted: rows.filter(r => r.status === 'submitted').length,
      sent_back: rows.filter(r => r.status === 'sent_back').length,
      todo: rows.filter(r => r.status === 'todo').length,
      approved: rows.filter(r => r.status === 'approved').length,
    };
    return { ok: true, date: d, rows, counts };
  }
  async function hrTaskReview(id, status, note, markup) {
    const { data: t } = await sb().from('task_assignments').select('emp_id,title,sent_back_count').eq('id', id).maybeSingle();
    const upd = { status: status === 'approved' ? 'approved' : 'sent_back', reviewer: 'HR', review_note: note || null, reviewed_at: new Date().toISOString() };
    if (status !== 'approved') upd.sent_back_count = ((t && t.sent_back_count) || 0) + 1;
    // รูปที่ผู้ตรวจวาดชี้จุด (data URL) → อัปโหลดเก็บเป็น review_markup
    if (status !== 'approved' && Array.isArray(markup) && markup.length) {
      const urls = [];
      for (const m of markup) {
        if (typeof m === 'string' && m.startsWith('data:')) {
          try { urls.push(await window.HR.uploadPhoto('employee-docs', 'markup/' + id + '_' + Date.now() + '_' + urls.length + '.jpg', m)); } catch (e) { console.warn('markup upload', e); }
        } else if (typeof m === 'string' && m) { urls.push(m); }
      }
      upd.review_markup = urls.length ? urls : null;
    }
    // หมายเหตุ: อนุมัติแล้วไม่ลบ review_markup — เก็บไว้ให้ดูในรายงานว่าเคยสั่งแก้อะไร (คู่กับรูปที่แก้แล้ว)
    const { error } = await sb().from('task_assignments').update(upd).eq('id', id);
    if (error) throw error;
    await logAct(status === 'approved' ? 'อนุมัติงาน' : 'ตีงานกลับ', t ? t.emp_id : null, (t ? t.title : '') + (note ? (' · ' + note) : ''));
    return { ok: true };
  }
  // ลบงานในกะออกจากระบบ (ใช้กับงานที่ลงผิดวัน/ซ้ำ)
  async function hrTaskDelete(id) {
    if (!id) return { ok: false, error: 'ไม่ระบุงาน' };
    const { data: t } = await sb().from('task_assignments').select('emp_id,title,work_date,shift_id').eq('id', id).maybeSingle();
    const { error } = await sb().from('task_assignments').delete().eq('id', id);
    if (error) throw error;
    await logAct('ลบงานในกะ', t ? t.emp_id : null, t ? (t.title + ' · ' + (t.work_date || '') + ' · กะ ' + (t.shift_id || '')) : ('#' + id));
    return { ok: true };
  }

  // ---------- งานค้างข้ามวัน (work_date < วันนี้ ยังไม่ approved) — ไว้แสดงการ์ดใน Dashboard ----------
  async function hrOpenTasks() {
    const today = bkkToday();
    const [tR, brR, shR] = await Promise.all([
      sb().from('task_assignments').select('*').lt('work_date', today).neq('status', 'approved').order('work_date').order('shift_id'),
      sb().from('branches').select('branch_id,name'),
      sb().from('shifts').select('shift_id,name'),
    ]);
    if (tR.error) throw tR.error;
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const shName = {}; (shR.data || []).forEach(s => { shName[s.shift_id] = s.name; });
    const groups = {};
    (tR.data || []).forEach(t => {
      const k = (t.work_date || '') + '|' + (t.branch_id || '') + '|' + (t.shift_id || '');
      if (!groups[k]) groups[k] = { work_date: t.work_date, branch_id: t.branch_id, branch_name: brName[t.branch_id] || t.branch_id || '—', shift_id: t.shift_id, shift_name: shName[t.shift_id] || t.shift_id || '—', todo: 0, submitted: 0, sent_back: 0, tasks: [] };
      const g = groups[k];
      if (t.status === 'submitted') g.submitted++; else if (t.status === 'sent_back') g.sent_back++; else g.todo++;
      g.tasks.push({ id: t.id, title: t.title, emp_name: t.emp_name, status: t.status, emp_note: t.emp_note || null });
    });
    const list = Object.values(groups).sort((a, b) => (a.work_date < b.work_date ? -1 : a.work_date > b.work_date ? 1 : 0));
    return { ok: true, today, groups: list, total: (tR.data || []).length };
  }
  // ปิด (อนุมัติ) งานค้างทั้งกลุ่มในครั้งเดียว — ใช้แก้ deadlock งานข้ามวัน
  async function hrTaskCloseGroup(d) {
    if (!d || !d.work_date) return { ok: false, error: 'ไม่ระบุกลุ่มงาน' };
    let q = sb().from('task_assignments').update({ status: 'approved', reviewer: 'HR', review_note: (d.note || 'ปิดโดย HR (งานค้างข้ามวัน)'), reviewed_at: new Date().toISOString() })
      .eq('work_date', d.work_date).neq('status', 'approved');
    if (d.branch_id != null) q = q.eq('branch_id', d.branch_id);
    if (d.shift_id != null) q = q.eq('shift_id', d.shift_id);
    const { data, error } = await q.select('id');
    if (error) throw error;
    await logAct('ปิดงานค้างข้ามวัน', null, (d.work_date || '') + ' · สาขา ' + (d.branch_id || '-') + ' · กะ ' + (d.shift_id || '-') + ' · ' + ((data || []).length) + ' งาน');
    return { ok: true, closed: (data || []).length };
  }

  // ---------- สรุปผลการทำงาน + วินัย รายบุคคล (สำหรับพิมพ์เอกสาร) ----------
  async function hrEmpSummary(p) {
    p = p || {};
    if (!p.emp_id) return { ok: false, error: 'ไม่ระบุพนักงาน' };
    const today = bkkToday();
    let start, end, rangeLabel;
    if (p.cycle === 'current' || p.cycle === 'previous') {
      const c = cycleRange(p.cycle); start = c.start; end = c.end;
      rangeLabel = (p.cycle === 'previous' ? 'รอบก่อนหน้า' : 'รอบปัจจุบัน') + ' (' + start + ' ถึง ' + end + ')';
    } else {
      start = p.start || cycleRange('current').start;
      end = p.end || today;
      rangeLabel = start + ' ถึง ' + end;
    }
    const endEff = end < today ? end : today;
    const [empR, brR, shR, attR, schR, lvR, taR, staR, stR] = await Promise.all([
      sb().from('employees').select('emp_id,name,nickname,branch_id,weekly_off,start_date,default_shift').eq('emp_id', p.emp_id).maybeSingle(),
      sb().from('branches').select('branch_id,name'),
      sb().from('shifts').select('shift_id,name'),
      sb().from('attendance').select('work_date,check_in,check_out,late_min,ot_hours,status').eq('emp_id', p.emp_id).gte('work_date', start).lte('work_date', endEff),
      sb().from('schedules').select('work_date,shift_id').eq('emp_id', p.emp_id).gte('work_date', start).lte('work_date', endEff),
      sb().from('leaves').select('start_date,end_date,type,status').eq('emp_id', p.emp_id).eq('status', 'approved').lte('start_date', end).gte('end_date', start),
      sb().from('task_assignments').select('work_date,shift_id,title,status,sent_back_count,review_note,reviewer').eq('emp_id', p.emp_id).gte('work_date', start).lte('work_date', end),
      sb().from('special_task_assignees').select('task_id,status').eq('emp_id', p.emp_id),
      sb().from('special_tasks').select('*'),
    ]);
    if (empR.error) throw empR.error;
    if (!empR.data) return { ok: false, error: 'ไม่พบพนักงาน' };
    const emp = empR.data;
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const shName = {}; (shR.data || []).forEach(s => { shName[s.shift_id] = s.name; });
    const att = attR.data || [], leaves = lvR.data || [];
    const onLeave = d => leaves.some(l => d >= l.start_date && d <= (l.end_date || l.start_date));
    const workedSet = new Set(att.filter(a => a.check_in).map(a => a.work_date));
    const late = att.filter(a => a.late_min > 0);
    const late_count = late.length, late_total = late.reduce((s, a) => s + (a.late_min || 0), 0);
    const otWhole = await getSettingBool('ot_whole_day');
    const ot_hours = Math.round(att.reduce((s, a) => s + otAdj(a.ot_hours, otWhole), 0) * 10) / 10;
    const mySched = [...new Set((schR.data || []).filter(s => s.shift_id).map(s => s.work_date))];
    const pastSched = mySched.filter(d => d < today);
    const days_should = pastSched.length;
    const days_worked = pastSched.filter(d => workedSet.has(d)).length;
    const absentDays = pastSched.filter(d => !workedSet.has(d) && !onLeave(d)).sort();
    const absent = absentDays.length;
    let leave_days = 0;
    leaves.forEach(l => { const s = l.start_date < start ? start : l.start_date; const e = (l.end_date || l.start_date) > end ? end : (l.end_date || l.start_date); if (s <= e) leave_days += Math.round((new Date(e + 'T00:00:00') - new Date(s + 'T00:00:00')) / 86400000) + 1; });
    const rules = await loadDisciplineRules();
    const lv = disciplineLevel(late_count, absent, rules);
    // งานที่ได้รับมอบหมาย (task_assignments)
    const tasks = taR.data || [];
    const tCount = st => tasks.filter(t => t.status === st).length;
    const t_total = tasks.length, t_approved = tCount('approved'), t_submitted = tCount('submitted'), t_todo = tCount('todo'), t_sentback = tCount('sent_back');
    const sent_back_total = tasks.reduce((s, t) => s + (t.sent_back_count || 0), 0);
    const pass_rate = t_total ? Math.round(t_approved / t_total * 100) : 0;
    // งานพิเศษ (กรองตามวันที่สร้างงานในช่วง; ถ้าไม่มีวันที่ = รวมไว้)
    const stById = {}; (stR.data || []).forEach(t => { stById[t.id] = t; });
    const spRows = (staR.data || []).map(a => ({ status: a.status, task: stById[a.task_id] })).filter(a => {
      if (!a.task) return false; const cd = String(a.task.created_at || '').slice(0, 10);
      return !cd || (cd >= start && cd <= end);
    });
    const sp_total = spRows.length, sp_approved = spRows.filter(a => a.status === 'approved').length,
      sp_submitted = spRows.filter(a => a.status === 'submitted').length, sp_open = spRows.filter(a => a.status === 'todo' || a.status === 'sent_back').length;
    const sentBackTasks = tasks.filter(t => (t.sent_back_count || 0) > 0 || t.status === 'sent_back')
      .map(t => ({ date: t.work_date, shift: shName[t.shift_id] || t.shift_id || '-', title: t.title, note: t.review_note || '', count: t.sent_back_count || 0, status: t.status, reviewer: t.reviewer || '' }))
      .sort((a, b) => a.date < b.date ? -1 : 1);
    return {
      ok: true,
      emp: { emp_id: emp.emp_id, name: emp.name, nickname: emp.nickname || '', branch_id: emp.branch_id || '', branch_name: brName[emp.branch_id] || emp.branch_id || '—', start_date: emp.start_date || '', shift_name: emp.default_shift ? (shName[emp.default_shift] || emp.default_shift) : '' },
      range: { start, end, label: rangeLabel, generated: new Date().toISOString() },
      attendance: { days_should, days_worked, absent, late_count, late_total, leave_days, ot_hours },
      discipline: { level: lv.level, level_name: lv.level_name, level_color: lv.level_color },
      tasks: { total: t_total, approved: t_approved, submitted: t_submitted, todo: t_todo, sent_back: t_sentback, sent_back_total, pass_rate },
      special: { total: sp_total, approved: sp_approved, submitted: sp_submitted, open: sp_open },
      details: {
        late: late.map(a => ({ date: a.work_date, min: a.late_min })).sort((x, y) => x.date < y.date ? -1 : 1),
        absent: absentDays,
        sent_back_tasks: sentBackTasks,
      },
    };
  }

  // ============================================================
  // ANALYTICS — วิเคราะห์เชิงลึก (รวมวินัย + ความรับผิดชอบงาน ทุกคน/ทุกสาขา)
  //   คืน: kpis, series(รายวัน), branches(เทียบสาขา), rows(สกอร์บอร์ดรายคน)
  //   f = { start, end, branch, cycle }
  // ============================================================
  async function hrAnalytics(f) {
    f = f || {};
    const today = bkkToday();
    let start, end, label;
    if (f.cycle === 'current' || f.cycle === 'previous') {
      const c = cycleRange(f.cycle); start = c.start; end = c.end;
      label = (f.cycle === 'previous' ? 'รอบก่อนหน้า' : 'รอบปัจจุบัน') + ' (' + start + ' – ' + end + ')';
    } else {
      start = f.start || cycleRange('current').start;
      end   = f.end   || today;
      label = start + ' – ' + end;
    }
    const endEff = end < today ? end : today;   // ตัดวันอนาคตออกจากการนับ ขาด/มา
    const branch = f.branch || '';

    let qEmp = sb().from('employees').select('emp_id,name,nickname,branch_id,weekly_off,default_shift').eq('active', true);
    let qAtt = sb().from('attendance').select('emp_id,work_date,check_in,late_min,ot_hours,branch_id').gte('work_date', start).lte('work_date', endEff);
    let qSch = sb().from('schedules').select('emp_id,work_date,shift_id,branch_id').gte('work_date', start).lte('work_date', endEff);
    let qTask = sb().from('task_assignments').select('emp_id,status,sent_back_count,branch_id').gte('work_date', start).lte('work_date', end);
    let qShelf = sb().from('shelf_checks').select('emp_id,check_date,branch_id').gte('check_date', start).lte('check_date', end);
    let qHand = sb().from('handovers').select('from_emp_id,work_date,status,branch_id').gte('work_date', start).lte('work_date', end);
    let qQa   = sb().from('qa_items').select('emp_id,branch_id,created_at').gte('created_at', start + 'T00:00:00').lte('created_at', end + 'T23:59:59');
    if (branch) { qEmp = qEmp.eq('branch_id', branch); qAtt = qAtt.eq('branch_id', branch); qSch = qSch.eq('branch_id', branch); qTask = qTask.eq('branch_id', branch); qShelf = qShelf.eq('branch_id', branch); qHand = qHand.eq('branch_id', branch); qQa = qQa.eq('branch_id', branch); }

    const [empR, brR, shR, hdR, attR, schR, lvR, taskR, shelfR, handR, qaR, rules] = await Promise.all([
      qEmp, sb().from('branches').select('branch_id,name'), sb().from('shifts').select('shift_id,name'),
      sb().from('holidays').select('date').eq('active', true).gte('date', start).lte('date', end),
      qAtt, qSch,
      sb().from('leaves').select('emp_id,start_date,end_date,status').eq('status', 'approved').lte('start_date', end).gte('end_date', start),
      qTask, qShelf, qHand, qQa, loadDisciplineRules(),
    ]);
    if (empR.error) throw empR.error;

    const emps = empR.data || [];
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const holidaySet = new Set((hdR.data || []).map(h => h.date));
    const att = attR.data || [], sch = schR.data || [], leaves = lvR.data || [];
    const tasks = taskR.data || [], shelfChk = shelfR.data || [], handovers = handR.data || [], qaItems = qaR.data || [];
    const otWhole = await getSettingBool('ot_whole_day');

    // จัดกลุ่มตาม emp
    const byEmp = {};
    emps.forEach(e => { byEmp[e.emp_id] = { emp: e, att: [], sched: [], leaves: [], tasks: [], shelf: 0, qa: 0, handover: 0 }; });
    const ensure = id => (byEmp[id] || (byEmp[id] = { emp: null, att: [], sched: [], leaves: [], tasks: [], shelf: 0, qa: 0, handover: 0 }));
    att.forEach(a => { if (byEmp[a.emp_id]) byEmp[a.emp_id].att.push(a); });
    sch.forEach(s => { if (s.shift_id && byEmp[s.emp_id]) byEmp[s.emp_id].sched.push(s); });
    leaves.forEach(l => { if (byEmp[l.emp_id]) byEmp[l.emp_id].leaves.push(l); });
    tasks.forEach(t => { if (byEmp[t.emp_id]) byEmp[t.emp_id].tasks.push(t); });
    shelfChk.forEach(s => { if (byEmp[s.emp_id]) byEmp[s.emp_id].shelf++; });
    qaItems.forEach(q => { if (q.emp_id && byEmp[q.emp_id]) byEmp[q.emp_id].qa++; });
    handovers.forEach(h => { if (h.from_emp_id && byEmp[h.from_emp_id]) byEmp[h.from_emp_id].handover++; });

    // ---- สกอร์บอร์ดรายคน (รวมวินัย + ความรับผิดชอบ) ----
    const rows = emps.map(e => {
      const g = byEmp[e.emp_id];
      const workedSet = new Set(g.att.filter(a => a.check_in).map(a => a.work_date));
      const onLeave = d => g.leaves.some(l => d >= l.start_date && d <= (l.end_date || l.start_date));
      const lateRows = g.att.filter(a => (a.late_min || 0) > 0);
      const late_count = lateRows.length;
      const late_total = lateRows.reduce((s, a) => s + (a.late_min || 0), 0);
      const ot_hours = Math.round(g.att.reduce((s, a) => s + otAdj(a.ot_hours, otWhole), 0) * 10) / 10;
      const schedDates = [...new Set(g.sched.map(s => s.work_date))];
      const pastSched = schedDates.filter(d => d < today);
      const days_should = pastSched.length;
      const days_worked = pastSched.filter(d => workedSet.has(d)).length;
      const absent = pastSched.filter(d => !workedSet.has(d) && !onLeave(d)).length;
      const lv = disciplineLevel(late_count, absent, rules);
      const t_total = g.tasks.length;
      const t_approved = g.tasks.filter(t => t.status === 'approved').length;
      const sent_back = g.tasks.reduce((s, t) => s + (t.sent_back_count || 0), 0)
        + g.tasks.filter(t => t.status === 'sent_back').length;
      const pass_rate = t_total ? Math.round(t_approved / t_total * 100) : null;
      return {
        emp_id: e.emp_id, name: e.name, nickname: e.nickname || '',
        branch_id: e.branch_id || '', branch_name: brName[e.branch_id] || e.branch_id || '—',
        days_should, days_worked, late_count, late_total, absent, ot_hours,
        level: lv.level, level_name: lv.level_name, level_color: lv.level_color,
        task_total: t_total, task_approved: t_approved, pass_rate, sent_back,
        qa: g.qa, shelf: g.shelf, handover: g.handover,
      };
    }).sort((a, b) => (b.late_total + b.absent * 480) - (a.late_total + a.absent * 480));

    // ---- ซีรีส์รายวัน (มา/สาย/ขาด/OT) ----
    const dayMap = {};
    const eachDay = (s, e, fn) => { const d = new Date(s + 'T00:00:00'), z = new Date(e + 'T00:00:00'); for (; d <= z; d.setDate(d.getDate() + 1)) fn(iso(d)); };
    eachDay(start, endEff, d => { dayMap[d] = { date: d, present: 0, late: 0, absent: 0, ot: 0 }; });
    att.forEach(a => { const d = dayMap[a.work_date]; if (!d) return; if (a.check_in) d.present++; if ((a.late_min || 0) > 0) d.late++; d.ot += otAdj(a.ot_hours, otWhole); });
    // ขาดรายวัน: มีเวรวันนั้น(อดีต) แต่ไม่มาและไม่ลา
    const empLeaves = {}; emps.forEach(e => { empLeaves[e.emp_id] = byEmp[e.emp_id].leaves; });
    const workedByDay = {}; att.forEach(a => { if (a.check_in) (workedByDay[a.work_date] = workedByDay[a.work_date] || new Set()).add(a.emp_id); });
    sch.forEach(s => {
      if (s.work_date >= today) return;
      const d = dayMap[s.work_date]; if (!d) return;
      const worked = workedByDay[s.work_date] && workedByDay[s.work_date].has(s.emp_id);
      const onLv = (empLeaves[s.emp_id] || []).some(l => s.work_date >= l.start_date && s.work_date <= (l.end_date || l.start_date));
      if (!worked && !onLv) d.absent++;
    });
    const series = Object.values(dayMap).map(d => ({ ...d, ot: Math.round(d.ot * 10) / 10 }));

    // ---- เทียบสาขา ----
    const brAgg = {};
    rows.forEach(r => {
      const b = brAgg[r.branch_id] || (brAgg[r.branch_id] = { branch_id: r.branch_id, branch_name: r.branch_name, emp: 0, late_count: 0, late_total: 0, absent: 0, ot: 0, pass_sum: 0, pass_n: 0 });
      b.emp++; b.late_count += r.late_count; b.late_total += r.late_total; b.absent += r.absent; b.ot += r.ot_hours;
      if (r.pass_rate != null) { b.pass_sum += r.pass_rate; b.pass_n++; }
    });
    const branches = Object.values(brAgg).map(b => ({
      branch_id: b.branch_id, branch_name: b.branch_name, emp: b.emp,
      late_count: b.late_count, late_total: b.late_total, absent: b.absent,
      ot: Math.round(b.ot * 10) / 10, pass_rate: b.pass_n ? Math.round(b.pass_sum / b.pass_n) : null,
    })).sort((a, b) => b.late_total - a.late_total);

    // ---- KPI รวม ----
    const passVals = rows.filter(r => r.pass_rate != null).map(r => r.pass_rate);
    const kpis = {
      total_emp: rows.length,
      worked_days: rows.reduce((s, r) => s + r.days_worked, 0),
      late_count: rows.reduce((s, r) => s + r.late_count, 0),
      late_total: rows.reduce((s, r) => s + r.late_total, 0),
      absent: rows.reduce((s, r) => s + r.absent, 0),
      ot_hours: Math.round(rows.reduce((s, r) => s + r.ot_hours, 0) * 10) / 10,
      sent_back: rows.reduce((s, r) => s + r.sent_back, 0),
      task_total: rows.reduce((s, r) => s + r.task_total, 0),
      task_approved: rows.reduce((s, r) => s + r.task_approved, 0),
      avg_pass_rate: passVals.length ? Math.round(passVals.reduce((a, b) => a + b, 0) / passVals.length) : null,
      at_risk: rows.filter(r => r.level >= 3).length,
    };

    return { ok: true, range: { start, end, label }, kpis, series, branches, rows };
  }

  // ---------- TASK LOG (ตรวจสอบงานย้อนหลัง) ----------
  async function hrTaskLog(f) {
    f = f || {};
    const today = bkkToday();
    const start = f.start || today, end = f.end || today;
    let tq = sb().from('task_assignments').select('*').gte('work_date', start).lte('work_date', end);
    let lq = sb().from('shift_leads').select('*').gte('work_date', start).lte('work_date', end);
    if (f.branch_id) { tq = tq.eq('branch_id', f.branch_id); lq = lq.eq('branch_id', f.branch_id); }
    const [tR, lR, brR] = await Promise.all([
      tq.order('work_date', { ascending: false }).order('submitted_at', { ascending: false }).limit(400),
      lq.order('work_date', { ascending: false }),
      sb().from('branches').select('branch_id,name'),
    ]);
    if (tR.error) throw tR.error;
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const rows = (tR.data || []).map(t => ({ ...t, branch_name: brName[t.branch_id] || t.branch_id || '—' }));
    const leaders = (lR.data || []).map(l => ({ ...l, branch_name: brName[l.branch_id] || l.branch_id || '—' }));
    return { ok: true, start, end, rows, leaders };
  }

  // ---------- SPECIAL TASKS (งานพิเศษ มอบหมายรายบุคคล) ----------
  async function hrSpecialCreate(d) {
    d = d || {};
    if (!d.title || !String(d.title).trim()) return { ok: false, error: 'ต้องระบุชื่องาน' };
    if (!Array.isArray(d.emp_ids) || !d.emp_ids.length) return { ok: false, error: 'เลือกผู้รับผิดชอบอย่างน้อย 1 คน' };
    // อัปโหลดรูปตัวอย่างจาก HR (ถ้ามี)
    const hr_photos = [];
    for (const p of (d.hr_photos || [])) {
      if (p) { try { hr_photos.push(await window.HR.uploadPhoto('employee-docs', 'special/hr_' + Date.now() + '_' + hr_photos.length + '.jpg', p)); } catch (e) { console.warn('hr photo', e); } }
    }
    const ins = {
      title: String(d.title).trim(),
      detail: (d.detail || '').trim() || null,
      deadline: d.deadline || null,
      hr_photos,
      hr_note: (d.hr_note || '').trim() || null,
      created_by: d.created_by || 'HR',
      active: true,
    };
    const { data: task, error } = await sb().from('special_tasks').insert(ins).select('id').single();
    if (error) throw error;
    // ดึงสาขาประจำของพนักงาน เพื่อ snapshot ไว้กรอง/แจ้ง HR
    const { data: emps } = await sb().from('employees').select('emp_id,branch_id,name,nickname').in('emp_id', d.emp_ids);
    const brOf = {}; (emps || []).forEach(e => { brOf[e.emp_id] = e.branch_id; });
    const rows = d.emp_ids.map(id => ({ task_id: task.id, emp_id: id, branch_id: brOf[id] || null, status: 'todo' }));
    const { error: e2 } = await sb().from('special_task_assignees').insert(rows);
    if (e2) throw e2;
    await logAct('มอบหมายงานพิเศษ', null, ins.title + ' · ' + rows.length + ' คน' + (ins.deadline ? (' · ครบกำหนด ' + ins.deadline) : ''));
    return { ok: true, id: task.id, assigned: rows.length };
  }

  async function hrSpecialList(branch) {
    const [tR, brR, empR] = await Promise.all([
      sb().from('special_tasks').select('*').eq('active', true).order('created_at', { ascending: false }).limit(200),
      sb().from('branches').select('branch_id,name'),
      sb().from('employees').select('emp_id,name,nickname'),
    ]);
    if (tR.error) throw tR.error;
    const tasks = tR.data || [];
    if (!tasks.length) return { ok: true, rows: [] };
    const ids = tasks.map(t => t.id);
    const { data: asg } = await sb().from('special_task_assignees').select('*').in('task_id', ids);
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const empName = {}; (empR.data || []).forEach(e => { empName[e.emp_id] = e.nickname || e.name; });
    const byTask = {};
    (asg || []).forEach(a => { (byTask[a.task_id] = byTask[a.task_id] || []).push(a); });
    let rows = tasks.map(t => {
      const people = (byTask[t.id] || []).map(a => ({
        ...a, emp_name: empName[a.emp_id] || a.emp_id, branch_name: brName[a.branch_id] || a.branch_id || '—',
      })).sort((x, y) => (x.emp_name > y.emp_name ? 1 : -1));
      const done = people.filter(p => p.status === 'approved').length;
      const waiting = people.filter(p => p.status === 'submitted').length;
      return { ...t, people, n: people.length, done, waiting };
    });
    if (branch) rows = rows.filter(t => t.people.some(p => p.branch_id === branch));
    return { ok: true, rows };
  }

  async function hrSpecialReview(assigneeId, status, note, markup) {
    if (!assigneeId) return { ok: false, error: 'ไม่ระบุรายการ' };
    const { data: a } = await sb().from('special_task_assignees').select('emp_id,task_id').eq('id', assigneeId).maybeSingle();
    const upd = {
      status: status === 'approved' ? 'approved' : 'sent_back',
      reviewer: 'HR', review_note: note || null, reviewed_at: new Date().toISOString(),
    };
    // ตีกลับ = ให้ทำใหม่ + แจ้งพนักงานอีกครั้ง
    if (upd.status === 'sent_back') upd.assigned_notified = false;
    // รูปที่ผู้ตรวจวาดชี้จุด (data URL) → อัปโหลดเก็บเป็น review_markup
    if (status !== 'approved' && Array.isArray(markup) && markup.length) {
      const urls = [];
      for (const m of markup) {
        if (typeof m === 'string' && m.startsWith('data:')) {
          try { urls.push(await window.HR.uploadPhoto('employee-docs', 'spmarkup/' + assigneeId + '_' + Date.now() + '_' + urls.length + '.jpg', m)); } catch (e) { console.warn('special markup upload', e); }
        } else if (typeof m === 'string' && m) { urls.push(m); }
      }
      upd.review_markup = urls.length ? urls : null;
    }
    const { error } = await sb().from('special_task_assignees').update(upd).eq('id', assigneeId);
    if (error) throw error;
    let title = '';
    if (a) { const { data: t } = await sb().from('special_tasks').select('title').eq('id', a.task_id).maybeSingle(); title = t ? t.title : ''; }
    await logAct(upd.status === 'approved' ? 'อนุมัติงานพิเศษ' : 'ตีกลับงานพิเศษ', a ? a.emp_id : null, title + (note ? (' · ' + note) : ''));
    return { ok: true };
  }

  async function hrSpecialDelete(id) {
    if (!id) return { ok: false, error: 'ไม่ระบุงาน' };
    const { data: t } = await sb().from('special_tasks').select('title').eq('id', id).maybeSingle();
    const { error } = await sb().from('special_tasks').delete().eq('id', id);  // cascade ลบ assignees เอง
    if (error) throw error;
    await logAct('ลบงานพิเศษ', null, t ? t.title : ('#' + id));
    return { ok: true };
  }

  // ---------- QA สินค้าใกล้หมดอายุ (โฟลเดอร์ + สินค้า) ----------
  async function hrQaFolderCreate(d) {
    d = d || {};
    if (!d.title || !String(d.title).trim()) return { ok: false, error: 'ต้องระบุชื่อหัวข้อ/โฟลเดอร์' };
    if (!Array.isArray(d.emp_ids) || !d.emp_ids.length) return { ok: false, error: 'เลือกผู้รับผิดชอบอย่างน้อย 1 คน' };
    const ins = {
      title: String(d.title).trim(),
      target_month: (d.target_month || '').trim() || null,
      note: (d.note || '').trim() || null,
      created_by: d.created_by || 'HR',
      active: true,
    };
    const { data: folder, error } = await sb().from('qa_folders').insert(ins).select('id').single();
    if (error) throw error;
    const { data: emps } = await sb().from('employees').select('emp_id,branch_id').in('emp_id', d.emp_ids);
    const brOf = {}; (emps || []).forEach(e => { brOf[e.emp_id] = e.branch_id; });
    const rows = d.emp_ids.map(id => ({ folder_id: folder.id, emp_id: id, branch_id: brOf[id] || null }));
    const { error: e2 } = await sb().from('qa_folder_assignees').insert(rows);
    if (e2) throw e2;
    await logAct('สร้างโฟลเดอร์ QA', null, ins.title + ' · ' + rows.length + ' คน');
    return { ok: true, id: folder.id, assigned: rows.length };
  }

  async function hrQaFolderList() {
    const [fR, empR] = await Promise.all([
      sb().from('qa_folders').select('*').eq('active', true).order('created_at', { ascending: false }).limit(200),
      sb().from('employees').select('emp_id,name,nickname,branch_id'),
    ]);
    if (fR.error) throw fR.error;
    const folders = fR.data || [];
    if (!folders.length) return { ok: true, rows: [] };
    const ids = folders.map(f => f.id);
    const [asgR, itR] = await Promise.all([
      sb().from('qa_folder_assignees').select('folder_id,emp_id').in('folder_id', ids),
      sb().from('qa_items').select('folder_id,status,expiry_date').in('folder_id', ids),
    ]);
    const empName = {}; (empR.data || []).forEach(e => { empName[e.emp_id] = e.nickname || e.name; });
    const empBr = {}; (empR.data || []).forEach(e => { empBr[e.emp_id] = e.branch_id || null; });
    const asgByF = {}; (asgR.data || []).forEach(a => { (asgByF[a.folder_id] = asgByF[a.folder_id] || []).push(empName[a.emp_id] || a.emp_id); });
    const asgBrByF = {}; (asgR.data || []).forEach(a => { const s = asgBrByF[a.folder_id] = asgBrByF[a.folder_id] || new Set(); if (empBr[a.emp_id]) s.add(empBr[a.emp_id]); });
    const today = bkkToday();
    const itByF = {};
    (itR.data || []).forEach(i => {
      const o = itByF[i.folder_id] = itByF[i.folder_id] || { total: 0, on_shelf: 0, sold: 0, removed: 0, expiring: 0 };
      o.total++; o[i.status] = (o[i.status] || 0) + 1;
      if (i.status === 'on_shelf' && i.expiry_date && i.expiry_date <= addDays(today, 30) && i.expiry_date >= today) o.expiring++;
    });
    const rows = folders.map(f => ({ ...f, assignees: asgByF[f.id] || [], branch_ids: [...(asgBrByF[f.id] || [])], stats: itByF[f.id] || { total: 0, on_shelf: 0, sold: 0, removed: 0, expiring: 0 } }));
    return { ok: true, rows };
  }

  async function hrQaFolderDelete(id) {
    if (!id) return { ok: false, error: 'ไม่ระบุโฟลเดอร์' };
    const { data: f } = await sb().from('qa_folders').select('title').eq('id', id).maybeSingle();
    const { error } = await sb().from('qa_folders').delete().eq('id', id);  // cascade
    if (error) throw error;
    await logAct('ลบโฟลเดอร์ QA', null, f ? f.title : ('#' + id));
    return { ok: true };
  }

  async function hrQaItems(folderId, status) {
    if (!folderId) return { ok: false, error: 'ไม่ระบุโฟลเดอร์' };
    let q = sb().from('qa_items').select('*').eq('folder_id', folderId);
    if (status) q = q.eq('status', status);
    const [itR, brR, fR, asgR] = await Promise.all([
      q.order('expiry_date', { ascending: true }),
      sb().from('branches').select('branch_id,name'),
      sb().from('qa_folders').select('*').eq('id', folderId).maybeSingle(),
      sb().from('qa_folder_assignees').select('emp_id').eq('folder_id', folderId),
    ]);
    if (itR.error) throw itR.error;
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const rows = (itR.data || []).map(i => ({ ...i, branch_name: brName[i.branch_id] || i.branch_id || '—' }));
    // ผู้รับผิดชอบโฟลเดอร์ (สำหรับ HR/ผจก. บันทึกแทน)
    const asgIds = (asgR.data || []).map(a => a.emp_id);
    let assignees = [];
    if (asgIds.length) {
      const { data: emps } = await sb().from('employees').select('emp_id,name,nickname,branch_id').in('emp_id', asgIds);
      assignees = (emps || []).map(e => ({ emp_id: e.emp_id, name: e.name, nickname: e.nickname || '', branch_id: e.branch_id || null }));
    }
    return { ok: true, folder: fR.data || null, assignees, rows };
  }

  async function hrQaItemDelete(id) {
    if (!id) return { ok: false, error: 'ไม่ระบุรายการ' };
    const { error } = await sb().from('qa_items').delete().eq('id', id);
    if (error) throw error;
    await logAct('ลบสินค้า QA', null, '#' + id);
    return { ok: true };
  }

  // ---------- รับสมัครงาน (Recruitment) ----------
  async function hrApplicantsList(branch) {
    let q = sb().from('applicants').select('*').order('created_at', { ascending: false }).limit(500);
    if (branch) q = q.eq('branch_id', branch);
    const [aR, brR] = await Promise.all([q, sb().from('branches').select('branch_id,name')]);
    if (aR.error) throw aR.error;
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const rows = (aR.data || []).map(a => ({ ...a, branch_name: brName[a.branch_id] || a.branch_id || '—' }));
    const counts = { new: 0, reviewing: 0, interview: 0, hired: 0, rejected: 0, unseen: 0 };
    rows.forEach(r => { if (counts[r.status] != null) counts[r.status]++; if (!r.seen) counts.unseen++; });
    return { ok: true, rows, counts };
  }
  async function hrApplicantGet(id) {
    if (!id) return { ok: false, error: 'ไม่ระบุผู้สมัคร' };
    const { data, error } = await sb().from('applicants').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, error: 'ไม่พบผู้สมัคร' };
    if (!data.seen) { try { await sb().from('applicants').update({ seen: true }).eq('id', id); } catch (e) {} }
    const { data: br } = await sb().from('branches').select('name').eq('branch_id', data.branch_id || '').maybeSingle();
    return { ok: true, applicant: { ...data, seen: true, branch_name: (br && br.name) || data.branch_id || '—' } };
  }
  async function hrApplicantStage(id, status) {
    const allowed = ['new', 'reviewing', 'interview', 'hired', 'rejected'];
    if (!id || !allowed.includes(status)) return { ok: false, error: 'ข้อมูลไม่ถูกต้อง' };
    const { error } = await sb().from('applicants').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    await logAct('เปลี่ยนสถานะผู้สมัคร', null, '#' + id + ' → ' + status);
    return { ok: true };
  }
  async function hrApplicantInterview(id, interviewAt, note) {
    if (!id || !interviewAt) return { ok: false, error: 'ระบุวัน-เวลาสัมภาษณ์' };
    const { error } = await sb().from('applicants').update({
      status: 'interview', interview_at: interviewAt, interview_note: note || null, updated_at: new Date().toISOString(),
    }).eq('id', id);
    if (error) throw error;
    await logAct('นัดสัมภาษณ์ผู้สมัคร', null, '#' + id + ' · ' + interviewAt);
    return { ok: true };
  }
  async function hrApplicantReject(id, reason) {
    if (!id) return { ok: false, error: 'ไม่ระบุผู้สมัคร' };
    const { error } = await sb().from('applicants').update({
      status: 'rejected', reject_reason: reason || null, updated_at: new Date().toISOString(),
    }).eq('id', id);
    if (error) throw error;
    await logAct('ปฏิเสธผู้สมัคร', null, '#' + id + (reason ? (' · ' + reason) : ''));
    return { ok: true };
  }
  // รับเข้าทำงาน → เจนรหัสชั่วคราว NEW-xxxxx + สร้างพนักงาน + ย้ายเอกสาร
  async function hrApplicantHire(id, branchId) {
    if (!id) return { ok: false, error: 'ไม่ระบุผู้สมัคร' };
    const { data: a } = await sb().from('applicants').select('*').eq('id', id).maybeSingle();
    if (!a) return { ok: false, error: 'ไม่พบผู้สมัคร' };
    if (a.hired_emp_id) return { ok: true, emp_id: a.hired_emp_id, already: true };
    const branch = branchId || a.branch_id;
    if (!branch) return { ok: false, error: 'เลือกสาขาที่รับเข้า' };
    // หารหัสชั่วคราวถัดไป NEW-00001
    const { data: exist } = await sb().from('employees').select('emp_id').like('emp_id', 'NEW-%');
    let mx = 0; (exist || []).forEach(e => { const n = parseInt(String(e.emp_id).replace('NEW-', ''), 10); if (!isNaN(n) && n > mx) mx = n; });
    const code = 'NEW-' + String(mx + 1).padStart(5, '0');
    const emp = {
      emp_id: code, name: a.full_name, nickname: a.nickname || null,
      phone: a.phone || null, address: a.address || null, id_card: a.id_card || null,
      emergency_name: a.emergency_name || null, emergency_phone: a.emergency_phone || null,
      branch_id: branch, active: true, start_date: bkkToday(),
      photo_url: a.photo_url || null, idcard_url: a.idcard_url || null,
      house_url: a.house_url || null, edu_url: a.edu_url || null,
    };
    const { error: e1 } = await sb().from('employees').insert(emp);
    if (e1) throw e1;
    const { error: e2 } = await sb().from('applicants').update({
      status: 'hired', hired_emp_id: code, updated_at: new Date().toISOString(),
    }).eq('id', id);
    if (e2) throw e2;
    await logAct('รับผู้สมัครเข้าทำงาน', code, a.full_name + ' · สาขา ' + branch);
    return { ok: true, emp_id: code };
  }
  // ---------- ตำแหน่งงาน (สำหรับหน้าสมัคร) ----------
  async function hrPositionsList() {
    const { data, error } = await sb().from('positions').select('*').order('sort').order('id');
    if (error) throw error;
    return { ok: true, rows: data || [] };
  }
  async function hrPositionSave(d) {
    d = d || {};
    if (!d.name || !String(d.name).trim()) return { ok: false, error: 'กรอกชื่อตำแหน่ง' };
    const row = { name: String(d.name).trim(), active: d.active !== false, sort: Number(d.sort) || 0 };
    if (d.id) { const { error } = await sb().from('positions').update(row).eq('id', d.id); if (error) throw error; }
    else { const { error } = await sb().from('positions').insert(row); if (error) throw error; }
    await logAct('บันทึกตำแหน่งงาน', null, row.name);
    return { ok: true };
  }
  async function hrPositionDelete(id) {
    if (!id) return { ok: false, error: 'ไม่ระบุตำแหน่ง' };
    const { error } = await sb().from('positions').delete().eq('id', id);
    if (error) throw error;
    await logAct('ลบตำแหน่งงาน', null, '#' + id);
    return { ok: true };
  }

  // ---------- งาน ผจก. (Manager Tasks) ----------
  async function _uploadMany(prefix, arr) {
    const urls = [];
    for (const m of (arr || [])) {
      if (typeof m === 'string' && m.startsWith('data:')) {
        try { urls.push(await window.HR.uploadPhoto('employee-docs', prefix + '_' + Date.now() + '_' + urls.length + '.jpg', m)); } catch (e) { console.warn('mtask upload', e); }
      } else if (typeof m === 'string' && m) urls.push(m);
    }
    return urls;
  }
  async function hrMtaskCreate(d) {
    d = d || {};
    if (!d.title || !String(d.title).trim()) return { ok: false, error: 'กรอกหัวข้องาน' };
    if (!d.branch_id) return { ok: false, error: 'เลือกสาขา' };
    const photos = await _uploadMany('mtask/hr', d.hr_photos);
    const { data, error } = await sb().from('mgr_tasks').insert({
      title: String(d.title).trim(), detail: (d.detail || '').trim() || null, branch_id: d.branch_id,
      priority: d.priority === 'urgent' ? 'urgent' : 'normal', source: d.source || 'HR',
      due_date: d.due_date || null, hr_photos: photos.length ? photos : null, created_by: 'HR', status: 'todo',
    }).select('id').single();
    if (error) throw error;
    await sb().from('mgr_task_feed').insert({ task_id: data.id, role: 'hr', sender_name: 'HR', kind: 'assign', message: 'มอบหมายงาน: ' + String(d.title).trim(), photos: photos.length ? photos : null });
    await logAct('มอบหมายงาน ผจก.', null, String(d.title).trim() + ' · สาขา ' + d.branch_id);
    return { ok: true, id: data.id };
  }
  async function hrMtaskList(branch) {
    let q = sb().from('mgr_tasks').select('*').order('updated_at', { ascending: false }).limit(300);
    if (branch) q = q.eq('branch_id', branch);
    const [tR, brR] = await Promise.all([q, sb().from('branches').select('branch_id,name')]);
    if (tR.error) throw tR.error;
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const rows = (tR.data || []).map(t => ({ ...t, branch_name: brName[t.branch_id] || t.branch_id || '—' }));
    return { ok: true, rows };
  }
  async function hrMtaskGet(id) {
    if (!id) return { ok: false, error: 'ไม่ระบุงาน' };
    const { data, error } = await sb().from('mgr_tasks').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, error: 'ไม่พบงาน' };
    const { data: br } = await sb().from('branches').select('name').eq('branch_id', data.branch_id || '').maybeSingle();
    return { ok: true, task: { ...data, branch_name: (br && br.name) || data.branch_id || '—' } };
  }
  async function hrMtaskStage(id, status, actorRole, actorName) {
    const allowed = ['todo', 'doing', 'review', 'done'];
    if (!id || !allowed.includes(status)) return { ok: false, error: 'ข้อมูลไม่ถูกต้อง' };
    const upd = { status, updated_at: new Date().toISOString() };
    if (status === 'done') upd.done_at = new Date().toISOString();
    const { error } = await sb().from('mgr_tasks').update(upd).eq('id', id);
    if (error) throw error;
    const lbl = ({ todo: 'งานใหม่', doing: 'กำลังทำ', review: 'ใกล้เสร็จ', done: 'สำเร็จ' })[status];
    await sb().from('mgr_task_feed').insert({ task_id: id, role: actorRole || 'mgr', sender_name: actorName || 'ผจก.', kind: 'status', message: 'เปลี่ยนสถานะ → ' + lbl });
    return { ok: true };
  }
  async function hrMtaskFeedAdd(d) {
    d = d || {};
    if (!d.task_id) return { ok: false, error: 'ไม่ระบุงาน' };
    const msg = (d.message || '').trim();
    const photos = await _uploadMany('mtask/feed', d.photos);
    if (!msg && !photos.length) return { ok: false, error: 'พิมพ์ข้อความหรือแนบรูป' };
    const { error } = await sb().from('mgr_task_feed').insert({
      task_id: d.task_id, role: d.role || 'mgr', sender_name: d.sender_name || '', message: msg || null,
      photos: photos.length ? photos : null, kind: d.kind || 'chat',
    });
    if (error) throw error;
    await sb().from('mgr_tasks').update({ updated_at: new Date().toISOString() }).eq('id', d.task_id);
    return { ok: true };
  }
  async function hrMtaskFeedList(taskId) {
    if (!taskId) return { ok: false, error: 'ไม่ระบุงาน' };
    const { data, error } = await sb().from('mgr_task_feed').select('*').eq('task_id', taskId).order('created_at', { ascending: true });
    if (error) throw error;
    return { ok: true, rows: data || [] };
  }
  // ---------- งานประจำวัน ผจก. (Manager Daily Checklist) ----------
  async function hrMdailyDefsList() {
    const { data, error } = await sb().from('mgr_daily_defs').select('*').order('sort').order('id');
    if (error) throw error;
    return { ok: true, rows: data || [] };
  }
  async function hrMdailyDefsSave(d) {
    d = d || {};
    if (!d.title || !String(d.title).trim()) return { ok: false, error: 'กรอกชื่องาน' };
    const row = { title: String(d.title).trim(), min_photos: Math.max(0, parseInt(d.min_photos) || 0), sort: Number(d.sort) || 0, active: d.active !== false };
    if (d.id) { const { error } = await sb().from('mgr_daily_defs').update(row).eq('id', d.id); if (error) throw error; }
    else { const { error } = await sb().from('mgr_daily_defs').insert(row); if (error) throw error; }
    await logAct('บันทึกงานประจำวัน ผจก.', null, row.title);
    return { ok: true };
  }
  async function hrMdailyDefsDelete(id) {
    if (!id) return { ok: false, error: 'ไม่ระบุ' };
    const { error } = await sb().from('mgr_daily_defs').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }
  // เช็กลิสต์ของสาขา/วันนั้น = เทมเพลต active + ผลที่ทำแล้ว (merge)
  async function hrMdailyToday(branch, date) {
    const d = date || bkkToday();
    const [defR, logR] = await Promise.all([
      sb().from('mgr_daily_defs').select('*').eq('active', true).order('sort').order('id'),
      branch ? sb().from('mgr_daily_logs').select('*').eq('branch_id', branch).eq('work_date', d)
             : Promise.resolve({ data: [] }),
    ]);
    if (defR.error) throw defR.error;
    const logByDef = {}; (logR.data || []).forEach(l => { logByDef[l.def_id] = l; });
    const items = (defR.data || []).map(def => {
      const l = logByDef[def.id];
      return {
        def_id: def.id, title: def.title, min_photos: def.min_photos || 0,
        log_id: l ? l.id : null, status: l ? l.status : 'todo',
        photos: (l && l.photos) || [], note: (l && l.note) || '',
        review_note: (l && l.review_note) || '', review_markup: (l && l.review_markup) || [],
        done_name: (l && l.done_name) || '', submitted_at: l ? l.submitted_at : null,
      };
    });
    const done = items.filter(i => i.status !== 'todo').length;
    return { ok: true, date: d, items, total: items.length, done };
  }
  async function hrMdailySubmit(d) {
    d = d || {};
    if (!d.def_id || !d.branch_id) return { ok: false, error: 'ข้อมูลไม่ครบ' };
    const today = bkkToday();
    const wd = d.work_date || today;
    if (wd !== today) return { ok: false, error: 'ส่งได้เฉพาะงานของวันนี้' };
    // ล็อกถ้าตรวจแล้ว (ผ่าน/ไม่ผ่าน) — แก้ในวันถัดไป
    const { data: cur } = await sb().from('mgr_daily_logs').select('id,status').eq('def_id', d.def_id).eq('branch_id', d.branch_id).eq('work_date', wd).maybeSingle();
    if (cur && (cur.status === 'approved' || cur.status === 'rejected')) return { ok: false, error: 'HR ตรวจแล้ว — ปรับปรุงในวันถัดไป' };
    const photos = await _uploadMany('mdaily/' + d.branch_id, d.photos);
    const row = {
      def_id: d.def_id, branch_id: d.branch_id, work_date: wd, status: 'submitted',
      photos: photos.length ? photos : null, note: (d.note || '').trim() || null,
      done_by: d.emp_id || null, done_name: d.emp_name || null, submitted_at: new Date().toISOString(),
      reviewer: null, review_note: null, review_markup: null, reviewed_at: null,
    };
    const { error } = await sb().from('mgr_daily_logs').upsert(row, { onConflict: 'def_id,branch_id,work_date' });
    if (error) throw error;
    return { ok: true };
  }
  async function hrMdailyReview(logId, status, note, markup) {
    if (!logId || !['approved', 'rejected'].includes(status)) return { ok: false, error: 'ข้อมูลไม่ถูกต้อง' };
    const upd = { status, reviewer: 'HR', review_note: note || null, reviewed_at: new Date().toISOString() };
    if (status === 'rejected' && Array.isArray(markup) && markup.length) {
      const urls = [];
      for (const m of markup) {
        if (typeof m === 'string' && m.startsWith('data:')) { try { urls.push(await window.HR.uploadPhoto('employee-docs', 'mdailymk/' + logId + '_' + Date.now() + '_' + urls.length + '.jpg', m)); } catch (e) {} }
        else if (typeof m === 'string' && m) urls.push(m);
      }
      upd.review_markup = urls.length ? urls : null;
    }
    const { error } = await sb().from('mgr_daily_logs').update(upd).eq('id', logId);
    if (error) throw error;
    await logAct(status === 'approved' ? 'อนุมัติงานประจำวัน' : 'ตีกลับงานประจำวัน', null, '#' + logId + (note ? (' · ' + note) : ''));
    return { ok: true };
  }
  // บอร์ด HR: รวมทุกสาขาของวันนั้น + สรุป
  async function hrMdailyBoard(date, branch) {
    const d = date || bkkToday();
    const [defR, brR, logR] = await Promise.all([
      sb().from('mgr_daily_defs').select('*').eq('active', true).order('sort').order('id'),
      sb().from('branches').select('branch_id,name').order('branch_id'),
      sb().from('mgr_daily_logs').select('*').eq('work_date', d),
    ]);
    if (defR.error) throw defR.error;
    const defs = defR.data || [];
    let branches = (brR.data || []);
    if (branch) branches = branches.filter(b => b.branch_id === branch);
    const logs = (logR.data || []);
    const logKey = {}; logs.forEach(l => { logKey[l.def_id + '|' + l.branch_id] = l; });
    const rows = branches.map(b => {
      const items = defs.map(def => {
        const l = logKey[def.id + '|' + b.branch_id];
        return { def_id: def.id, title: def.title, min_photos: def.min_photos || 0,
          log_id: l ? l.id : null, status: l ? l.status : 'todo',
          photos: (l && l.photos) || [], note: (l && l.note) || '', done_name: (l && l.done_name) || '',
          review_note: (l && l.review_note) || '', review_markup: (l && l.review_markup) || [] };
      });
      const done = items.filter(i => i.status !== 'todo').length;
      const pending = items.filter(i => i.status === 'submitted').length;
      return { branch_id: b.branch_id, branch_name: b.name, items, total: items.length, done, pending };
    });
    return { ok: true, date: d, rows, def_count: defs.length };
  }
  // รายงานย้อนหลังรายเดือน (ต่อสาขา)
  async function hrMdailyReport(month, branch) {
    const today = bkkToday();
    const m = month || today.slice(0, 7);
    const start = m + '-01';
    const y = parseInt(m.slice(0, 4)), mo = parseInt(m.slice(5, 7));
    const endMonth = iso(new Date(y, mo, 0));           // วันสุดท้ายของเดือน
    const endEff = endMonth < today ? endMonth : today; // ไม่นับวันอนาคต
    const days = (endEff >= start) ? daysBetween(start, endEff) : 0;
    const [defR, brR, logR] = await Promise.all([
      sb().from('mgr_daily_defs').select('id').eq('active', true),
      sb().from('branches').select('branch_id,name').order('branch_id'),
      sb().from('mgr_daily_logs').select('branch_id,def_id,work_date,status').gte('work_date', start).lte('work_date', endEff),
    ]);
    if (defR.error) throw defR.error;
    const defCount = (defR.data || []).length;
    const expected = defCount * days;
    let branches = (brR.data || []);
    if (branch) branches = branches.filter(b => b.branch_id === branch);
    const logs = logR.data || [];
    const rows = branches.map(b => {
      const bl = logs.filter(l => l.branch_id === b.branch_id);
      const approved = bl.filter(l => l.status === 'approved').length;
      const rejected = bl.filter(l => l.status === 'rejected').length;
      const submitted = bl.filter(l => l.status === 'submitted').length;
      const done = bl.length;                             // ทำแล้ว (ส่ง/ผ่าน/ไม่ผ่าน)
      const missed = Math.max(0, expected - done);
      const pct = expected ? Math.round(done / expected * 100) : 0;
      const passPct = done ? Math.round(approved / done * 100) : 0;
      return { branch_id: b.branch_id, branch_name: b.name, expected, done, approved, rejected, submitted, missed, pct, pass_pct: passPct };
    });
    return { ok: true, month: m, days, def_count: defCount, expected, rows };
  }

  // แก้ไขงานที่มอบหมาย (หัวข้อ/รายละเอียด/กำหนดส่ง/ด่วน/สาขา)
  async function hrMtaskUpdate(id, d) {
    d = d || {};
    if (!id) return { ok: false, error: 'ไม่ระบุงาน' };
    if (!d.title || !String(d.title).trim()) return { ok: false, error: 'กรอกหัวข้องาน' };
    const upd = {
      title: String(d.title).trim(),
      detail: (d.detail || '').trim() || null,
      due_date: d.due_date || null,
      priority: d.priority === 'urgent' ? 'urgent' : 'normal',
      updated_at: new Date().toISOString(),
    };
    if (d.branch_id) upd.branch_id = d.branch_id;
    const { error } = await sb().from('mgr_tasks').update(upd).eq('id', id);
    if (error) throw error;
    await sb().from('mgr_task_feed').insert({ task_id: id, role: 'hr', sender_name: 'HR', kind: 'status', message: 'แก้ไขรายละเอียดงาน' });
    await logAct('แก้ไขงาน ผจก.', null, upd.title);
    return { ok: true };
  }
  async function hrMtaskDelete(id) {
    if (!id) return { ok: false, error: 'ไม่ระบุงาน' };
    const { data: t } = await sb().from('mgr_tasks').select('title').eq('id', id).maybeSingle();
    await sb().from('mgr_task_feed').delete().eq('task_id', id);   // เผื่อ FK ไม่ได้ตั้ง cascade
    const { error } = await sb().from('mgr_tasks').delete().eq('id', id);
    if (error) throw error;
    await logAct('ลบงาน ผจก.', null, (t && t.title) || ('#' + id));
    return { ok: true };
  }
  // ผจก.มอบต่อให้พนักงานในสาขา
  async function hrMtaskAssign(id, empId, empName) {
    if (!id) return { ok: false, error: 'ไม่ระบุงาน' };
    const { error } = await sb().from('mgr_tasks').update({ assignee_emp: empId || null, assignee_name: empName || null, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    await sb().from('mgr_task_feed').insert({ task_id: id, role: 'mgr', sender_name: 'ผจก.', kind: 'status', message: empName ? ('มอบหมายให้: ' + empName) : 'ยกเลิกการมอบหมาย' });
    // แจ้งพนักงานที่ถูกมอบหมาย → เห็นในกล่องแจ้งเตือน + งานโผล่ในหน้า "งานรับส่งผลัด"
    if (empId) {
      try {
        const { data: t } = await sb().from('mgr_tasks').select('title').eq('id', id).maybeSingle();
        await sb().from('emp_notifications').insert({
          emp_id: empId, kind: 'mgr_task',
          title: 'ได้รับมอบหมายงานจากผู้จัดการ',
          body: 'งาน: ' + ((t && t.title) || '-') + '\nเปิดหน้า "งานรับส่งผลัด" เพื่อทำและส่งรูปหลักฐาน',
          ref: 'mgr_task', created_by: 'ผจก.',
        });
      } catch (e) { console.warn('mtask emp_notify', e); }
    }
    return { ok: true };
  }

  // แก้ไขรายละเอียดสินค้า QA (ชื่อ/บาร์โค้ด/ขนาด/จำนวน/หมดอายุ/โซน/สถานะ)
  async function hrQaItemUpdate(id, d) {
    if (!id) return { ok: false, error: 'ไม่ระบุรายการ' };
    d = d || {};
    if (!d.name || !String(d.name).trim()) return { ok: false, error: 'กรอกชื่อสินค้า' };
    if (!d.expiry_date) return { ok: false, error: 'เลือกวันหมดอายุ' };
    const bc = String(d.barcode || '').trim() || null;
    const upd = {
      name: String(d.name).trim(),
      barcode: bc,
      size: String(d.size || '').trim() || null,
      qty: parseInt(d.qty) > 0 ? parseInt(d.qty) : 1,
      expiry_date: d.expiry_date,
      zone: String(d.zone || '').trim() || null,
      updated_at: new Date().toISOString(),
    };
    if (d.status && ['on_shelf', 'sold', 'removed'].includes(d.status)) upd.status = d.status;
    const { error } = await sb().from('qa_items').update(upd).eq('id', id);
    if (error) throw error;
    if (bc) { try { await sb().from('qa_products').upsert({ barcode: bc, name: upd.name, size: upd.size, updated_at: new Date().toISOString() }, { onConflict: 'barcode' }); } catch (e) {} }
    await logAct('แก้ไขสินค้า QA', null, '#' + id + ' · ' + upd.name);
    return { ok: true };
  }

  // ---------- งานพิเศษ: ดูแลเชลฟ์ประจำเดือน (Shelf Care) ----------
  function curMonth() { return bkkToday().slice(0, 7); }
  function monthBounds(m) { const [y, mo] = m.split('-').map(Number); const s = m + '-01'; const nx = new Date(y, mo, 1); const e = nx.getFullYear() + '-' + String(nx.getMonth() + 1).padStart(2, '0') + '-01'; return { s, e }; }

  async function hrShelfList(branch) {
    const [shR, brR] = await Promise.all([
      sb().from('shelves').select('*').order('branch_id', { ascending: true }).order('shelf_code', { ascending: true }),
      sb().from('branches').select('branch_id,name'),
    ]);
    if (shR.error) throw shR.error;
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    let rows = (shR.data || []).map(s => ({ ...s, branch_name: brName[s.branch_id] || s.branch_id || '—' }));
    if (branch) rows = rows.filter(s => s.branch_id === branch);
    return { ok: true, rows };
  }

  async function hrShelfSave(d) {
    d = d || {};
    if (!d.shelf_code || !String(d.shelf_code).trim()) return { ok: false, error: 'ระบุรหัสเชลฟ์' };
    if (!d.name || !String(d.name).trim()) return { ok: false, error: 'ระบุชื่อเชลฟ์' };
    if (!d.branch_id) return { ok: false, error: 'เลือกสาขา' };
    const row = { shelf_code: String(d.shelf_code).trim(), name: String(d.name).trim(), branch_id: d.branch_id, active: d.active !== false };
    if (Array.isArray(d.checklist)) {
      const cl = d.checklist.map(x => String(x || '').trim()).filter(Boolean).slice(0, 20);
      row.checklist = cl.length ? cl : ['ทำความสะอาดเชลฟ์เรียบร้อย', 'จัดเรียงสินค้าหน้าตรง เต็มชั้น', 'FIFO — สินค้าตรงป้ายราคา', 'ตรวจวันหมดอายุครบทุกแถว'];
    }
    let error;
    if (d.id) { ({ error } = await sb().from('shelves').update(row).eq('id', d.id)); }
    else { ({ error } = await sb().from('shelves').insert(row)); }
    if (error) { if (String(error.message || '').includes('duplicate')) return { ok: false, error: 'รหัสเชลฟ์นี้มีอยู่แล้วในสาขานี้' }; throw error; }
    await logAct(d.id ? 'แก้ไขเชลฟ์' : 'เพิ่มเชลฟ์', null, row.shelf_code + ' · ' + row.name);
    return { ok: true };
  }

  async function hrShelfDelete(id) {
    if (!id) return { ok: false, error: 'ไม่ระบุเชลฟ์' };
    const { data: s } = await sb().from('shelves').select('name,shelf_code').eq('id', id).maybeSingle();
    const { error } = await sb().from('shelves').delete().eq('id', id);  // cascade มอบหมาย/เช็ก
    if (error) throw error;
    await logAct('ลบเชลฟ์', null, s ? (s.shelf_code + ' · ' + s.name) : ('#' + id));
    return { ok: true };
  }

  async function hrShelfAssign(d) {
    d = d || {};
    if (!d.shelf_id) return { ok: false, error: 'เลือกเชลฟ์' };
    if (!Array.isArray(d.emp_ids) || !d.emp_ids.length) return { ok: false, error: 'เลือกผู้รับผิดชอบอย่างน้อย 1 คน' };
    const month = (d.month || curMonth());
    const { data: sh } = await sb().from('shelves').select('branch_id,name,shelf_code').eq('id', d.shelf_id).maybeSingle();
    if (!sh) return { ok: false, error: 'ไม่พบเชลฟ์' };
    const detail = (d.detail || '').trim() || null;
    const rows = d.emp_ids.map(id => ({ shelf_id: d.shelf_id, emp_id: id, branch_id: sh.branch_id || null, month, detail, created_by: d.created_by || 'HR' }));
    const { error } = await sb().from('shelf_assignments').upsert(rows, { onConflict: 'shelf_id,emp_id,month' });
    if (error) throw error;
    await logAct('มอบหมายเชลฟ์', null, sh.shelf_code + ' · ' + sh.name + ' · เดือน ' + month + ' · ' + rows.length + ' คน');
    return { ok: true, assigned: rows.length };
  }

  async function hrShelfAssignments(month, branch) {
    month = month || curMonth();
    const { data: asg, error } = await sb().from('shelf_assignments').select('*').eq('month', month);
    if (error) throw error;
    const rowsA = asg || [];
    if (!rowsA.length) return { ok: true, month, rows: [] };
    const shIds = [...new Set(rowsA.map(a => a.shelf_id))];
    const { s, e } = monthBounds(month);
    const [shR, empR, brR, ckR] = await Promise.all([
      sb().from('shelves').select('*').in('id', shIds),
      sb().from('employees').select('emp_id,name,nickname'),
      sb().from('branches').select('branch_id,name'),
      sb().from('shelf_checks').select('shelf_id,emp_id,check_date').in('shelf_id', shIds).gte('check_date', s).lt('check_date', e),
    ]);
    const shBy = {}; (shR.data || []).forEach(x => { shBy[x.id] = x; });
    const empName = {}; (empR.data || []).forEach(x => { empName[x.emp_id] = x.nickname || x.name; });
    const brName = {}; (brR.data || []).forEach(x => { brName[x.branch_id] = x.name; });
    const ckCnt = {}; (ckR.data || []).forEach(c => { const k = c.shelf_id + '|' + c.emp_id; (ckCnt[k] = ckCnt[k] || new Set()).add(c.check_date); });
    let rows = rowsA.map(a => {
      const sh = shBy[a.shelf_id] || {};
      const days = (ckCnt[a.shelf_id + '|' + a.emp_id] || new Set()).size;
      return { ...a, shelf_code: sh.shelf_code || '', shelf_name: sh.name || ('#' + a.shelf_id), branch_id: a.branch_id || sh.branch_id || null, branch_name: brName[a.branch_id || sh.branch_id] || '—', emp_name: empName[a.emp_id] || a.emp_id, checked_days: days };
    }).sort((x, y) => (x.shelf_name + x.emp_name > y.shelf_name + y.emp_name ? 1 : -1));
    if (branch) rows = rows.filter(r => r.branch_id === branch);
    return { ok: true, month, rows };
  }

  async function hrShelfAssignDelete(id) {
    if (!id) return { ok: false, error: 'ไม่ระบุรายการ' };
    const { error } = await sb().from('shelf_assignments').delete().eq('id', id);
    if (error) throw error;
    await logAct('ยกเลิกมอบหมายเชลฟ์', null, '#' + id);
    return { ok: true };
  }

  async function hrShelfChecks(shelfId, month) {
    if (!shelfId) return { ok: false, error: 'ไม่ระบุเชลฟ์' };
    month = month || curMonth();
    const { s, e } = monthBounds(month);
    const [ckR, empR] = await Promise.all([
      sb().from('shelf_checks').select('*').eq('shelf_id', shelfId).gte('check_date', s).lt('check_date', e).order('check_date', { ascending: false }),
      sb().from('employees').select('emp_id,name,nickname'),
    ]);
    if (ckR.error) throw ckR.error;
    const empName = {}; (empR.data || []).forEach(x => { empName[x.emp_id] = x.nickname || x.name; });
    const rows = (ckR.data || []).map(c => ({ ...c, emp_name: empName[c.emp_id] || c.emp_id }));
    return { ok: true, month, rows };
  }

  // ตรวจการดูแลเชลฟ์รายวัน: ผ่าน / ตีกลับ (แบบเดียวกับงานในกะ)
  //   status='approved' → ผ่าน · อื่น ๆ → sent_back + เก็บ review_note/review_markup + นับ sent_back_count
  async function hrShelfCheckReview(id, status, note, markup) {
    if (!id) return { ok: false, error: 'ไม่ระบุรายการตรวจ' };
    const { data: c } = await sb().from('shelf_checks').select('emp_id,shelf_id,check_date,sent_back_count').eq('id', id).maybeSingle();
    const upd = { status: status === 'approved' ? 'approved' : 'sent_back', reviewer: 'HR', review_note: note || null, reviewed_at: new Date().toISOString() };
    if (status !== 'approved') upd.sent_back_count = ((c && c.sent_back_count) || 0) + 1;
    // รูปที่ผู้ตรวจวาดชี้จุด (data URL) → อัปโหลดเก็บเป็น review_markup
    if (status !== 'approved' && Array.isArray(markup) && markup.length) {
      const urls = [];
      for (const m of markup) {
        if (typeof m === 'string' && m.startsWith('data:')) {
          try { urls.push(await window.HR.uploadPhoto('employee-docs', 'shelfmarkup/' + id + '_' + Date.now() + '_' + urls.length + '.jpg', m)); } catch (e) { console.warn('shelf markup upload', e); }
        } else if (typeof m === 'string' && m) { urls.push(m); }
      }
      upd.review_markup = urls.length ? urls : null;
    }
    const { error } = await sb().from('shelf_checks').update(upd).eq('id', id);
    if (error) throw error;
    await logAct(status === 'approved' ? 'อนุมัติการตรวจเชลฟ์' : 'ตีกลับการตรวจเชลฟ์', c ? c.emp_id : null, 'เชลฟ์#' + (c ? c.shelf_id : '') + ' · ' + (c ? c.check_date : '') + (note ? (' · ' + note) : ''));
    return { ok: true };
  }

  // ---------- คำขอแก้ไขเวลาออก (ลืมกดออก/ระบบปิดให้) ----------
  function _otHours(actualIso, endTime, freeHours) {
    if (!endTime || !actualIso) return 0;
    const outMs = new Date(actualIso).getTime();
    const [h, m] = String(endTime).split(':').map(Number);
    // อ้างอิงเวลาไทย (+07:00) เสมอ — ไม่ขึ้นกับเขตเวลาของเครื่อง HR
    const bkk = new Date(outMs + 7 * 3600 * 1000);
    const day = bkk.getUTCFullYear() + '-' + String(bkk.getUTCMonth() + 1).padStart(2, '0') + '-' + String(bkk.getUTCDate()).padStart(2, '0');
    let endMs = new Date(day + 'T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00+07:00').getTime();
    if ((outMs - endMs) / 3600000 < -12) endMs -= 86400000;   // กะข้ามคืน: เลิกกะตกวันก่อนหน้า
    const diff = (outMs - endMs) / 3600000 - (freeHours || 0); // เริ่มคิด OT ที่ชั่วโมงที่ (freeHours+1)
    return diff > 0 ? Math.round(diff * 100) / 100 : 0;
  }
  async function _otFree() { const n = await getSettingNum('ot_start_hour', 2); return Math.max(0, n - 1); }
  async function hrCheckoutCorrList() {
    const [cR, brR] = await Promise.all([
      sb().from('checkout_corrections').select('*').order('created_at', { ascending: false }).limit(200),
      sb().from('branches').select('branch_id,name'),
    ]);
    if (cR.error) throw cR.error;
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    // คำนวณ OT ที่จะได้ ถ้าอนุมัติ (โชว์เฉพาะ HR)
    const shifts = {};
    const shR = await sb().from('shifts').select('shift_id,end_time,no_ot');
    (shR.data || []).forEach(s => { shifts[s.shift_id] = s; });
    const free = await _otFree();
    const rows = (cR.data || []).map(c => {
      const sh = shifts[c.shift_id];
      return { ...c, branch_name: brName[c.branch_id] || c.branch_id || '—',
        ot_if_approved: (sh && sh.no_ot) ? 0 : _otHours(c.actual_checkout, sh ? sh.end_time : null, free) };
    });
    return { ok: true, rows, pending: rows.filter(r => r.status === 'pending').length };
  }
  async function hrCheckoutCorrReview(id, status, note) {
    if (!id) return { ok: false, error: 'ไม่ระบุคำขอ' };
    const { data: c } = await sb().from('checkout_corrections').select('*').eq('id', id).maybeSingle();
    if (!c) return { ok: false, error: 'ไม่พบคำขอ' };
    const upd = { status: status === 'approved' ? 'approved' : 'rejected', reviewer: 'HR', review_note: note || null, reviewed_at: new Date().toISOString() };
    const { error } = await sb().from('checkout_corrections').update(upd).eq('id', id);
    if (error) throw error;
    if (upd.status === 'approved') {
      const { data: sh } = await sb().from('shifts').select('end_time,no_ot').eq('shift_id', c.shift_id).maybeSingle();
      const ot = (sh && sh.no_ot) ? 0 : _otHours(c.actual_checkout, sh ? sh.end_time : null, await _otFree());
      await sb().from('attendance').update({ check_out: c.actual_checkout, ot_hours: ot, status: 'CLOSED', auto_closed: false })
        .eq('emp_id', c.emp_id).eq('work_date', c.work_date);
      await logAct('อนุมัติแก้ไขเวลาออก', c.emp_id, (c.emp_name || c.emp_id) + ' · ' + c.work_date + ' · OT ' + ot + ' ชม.');
    } else {
      await logAct('ปฏิเสธแก้ไขเวลาออก', c.emp_id, (c.emp_name || c.emp_id) + ' · ' + c.work_date + (note ? (' · ' + note) : ''));
    }
    return { ok: true };
  }

  // ---------- วันอบรม / ปฏิบัติงานนอกสถานที่ (นับเป็นวันทำงาน ไม่ต้องสแกน) ----------
  async function hrMarkDuty(d) {
    d = d || {};
    if (!d.emp_id || !Array.isArray(d.dates) || !d.dates.length) return { ok: false, error: 'เลือกพนักงานและวันที่' };
    const { data: emp } = await sb().from('employees').select('emp_id,name,branch_id,default_shift').eq('emp_id', d.emp_id).maybeSingle();
    if (!emp) return { ok: false, error: 'ไม่พบพนักงาน' };
    const [schR, shR] = await Promise.all([
      sb().from('schedules').select('work_date,shift_id,branch_id').eq('emp_id', d.emp_id).in('work_date', d.dates),
      sb().from('shifts').select('shift_id,start_time,end_time'),
    ]);
    const schBy = {}; (schR.data || []).forEach(s => { schBy[s.work_date] = s; });
    const shBy = {}; (shR.data || []).forEach(s => { shBy[s.shift_id] = s; });
    const note = (d.note || '').trim() || null;
    const rows = d.dates.map(wd => {
      const sc = schBy[wd];
      const shiftId = (sc && sc.shift_id) || emp.default_shift || null;
      const sh = shiftId ? shBy[shiftId] : null;
      const st = (sh && sh.start_time) ? String(sh.start_time).slice(0, 5) : '09:00';
      const en = (sh && sh.end_time) ? String(sh.end_time).slice(0, 5) : '18:00';
      const branch = (sc && sc.branch_id) || emp.branch_id || null;
      return {
        emp_id: emp.emp_id, work_date: wd, shift_id: shiftId, branch_id: branch,
        check_in: new Date(wd + 'T' + st + ':00+07:00').toISOString(),
        check_out: new Date(wd + 'T' + en + ':00+07:00').toISOString(),
        late_min: 0, ot_hours: 0, status: 'TRAINING', duty_note: note,
      };
    });
    const { error } = await sb().from('attendance').upsert(rows, { onConflict: 'emp_id,work_date' });
    if (error) throw error;
    await logAct('บันทึกวันอบรม/ปฏิบัติงานนอกสถานที่', emp.emp_id, rows.length + ' วัน' + (note ? (' · ' + note) : ''));
    return { ok: true, count: rows.length };
  }
  // รายการบันทึกวันอบรม/ปฏิบัติงานนอกสถานที่ (status=TRAINING) — ล่าสุดก่อน
  async function hrDutyList(branch) {
    let q = sb().from('attendance').select('id,emp_id,work_date,shift_id,branch_id,duty_note,created_at')
      .eq('status', 'TRAINING').order('work_date', { ascending: false }).limit(300);
    if (branch) q = q.eq('branch_id', branch);
    const [aR, empR, brR, shR] = await Promise.all([
      q,
      sb().from('employees').select('emp_id,name,nickname'),
      sb().from('branches').select('branch_id,name'),
      sb().from('shifts').select('shift_id,name'),
    ]);
    if (aR.error) throw aR.error;
    const empName = {}; (empR.data || []).forEach(e => { empName[e.emp_id] = e.name; });
    const empNick = {}; (empR.data || []).forEach(e => { empNick[e.emp_id] = e.nickname || ''; });
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const shName = {}; (shR.data || []).forEach(s => { shName[s.shift_id] = s.name; });
    const rows = (aR.data || []).map(a => ({
      id: a.id, emp_id: a.emp_id, emp_name: empName[a.emp_id] || a.emp_id, nickname: empNick[a.emp_id] || '',
      work_date: a.work_date, shift_name: shName[a.shift_id] || a.shift_id || '',
      branch_name: brName[a.branch_id] || a.branch_id || '—', note: a.duty_note || '', created_at: a.created_at,
    }));
    return { ok: true, rows };
  }
  // ลบบันทึกวันอบรม 1 วัน (ใช้กับที่ลงผิด) — ลบเฉพาะแถวที่เป็น TRAINING
  async function hrDutyDelete(empId, workDate) {
    if (!empId || !workDate) return { ok: false, error: 'ไม่ระบุพนักงาน/วันที่' };
    const { error } = await sb().from('attendance').delete().eq('emp_id', empId).eq('work_date', workDate).eq('status', 'TRAINING');
    if (error) throw error;
    await logAct('ลบบันทึกวันอบรม', empId, String(workDate));
    return { ok: true };
  }

  window.HRAPI = { dispatch };
})();

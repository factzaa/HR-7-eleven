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
    // กันกดเข้างานทั้งที่ยังมีกะค้างไม่ได้กดออก (เช่น จบกะดึกเมื่อวาน แล้วเช้านี้กดเข้าแทนออก)
    const { data: openRow } = await sb.from('attendance').select('work_date,check_in')
      .eq('emp_id', empId).not('check_in', 'is', null).is('check_out', null)
      .gte('work_date', _addDays(today, -2)).neq('work_date', today)
      .order('check_in', { ascending: false }).limit(1).maybeSingle();
    if (openRow && openRow.check_in) {
      throw new Error('คุณยังมีกะที่ยังไม่ได้กดออกงาน (วันที่ ' + openRow.work_date + ' เข้างาน ' + _fmtTime(openRow.check_in) + ') — ถ้าจบกะแล้วให้กด "ออกงาน" ก่อน · หากกดผิดโปรดติดต่อ HR');
    }
    // หา "กะวันนี้" จากตารางเวรก่อน (authoritative) แล้วค่อย fallback กะประจำที่ส่งมา
    // กันบั๊ก: ถ้าใช้ default_shift อย่างเดียว คนที่จัดกะผ่านตารางเวร (default_shift ว่าง) จะคำนวณสายไม่ได้
    let useShift = shiftId || null;
    const sched = (await sb.from('schedules').select('shift_id').eq('emp_id', empId).eq('work_date', today).maybeSingle()).data;
    if (sched && sched.shift_id) useShift = sched.shift_id;

    let photo_url = null;
    if (photoDataUrl) {
      // ใส่ timestamp กันชื่อไฟล์ซ้ำ: ถ้าลบข้อมูลแล้วเช็กอินใหม่วันเดิม จะได้ URL ใหม่ (ไม่ติดแคชรูปเก่า)
      photo_url = await uploadPhoto('attendance-photos', `${empId}/${today}_${Date.now()}.jpg`, photoDataUrl);
    }
    // คำนวณสายผ่าน RPC (อิงกะที่ใช้จริง)
    const nowIso = new Date().toISOString();
    const { data: lateMin } = await sb.rpc('calc_late_min', { p_shift_id: useShift, p_check_in: nowIso });

    const { error } = await sb.from('attendance').upsert({
      emp_id: empId, work_date: today, shift_id: useShift, branch_id: branchId,
      check_in: nowIso, late_min: lateMin || 0,
      photo_url, gps_lat: lat, gps_lng: lng, gps_accuracy: accuracy,
      face_match: faceMatch, status: 'OPEN',
    }, { onConflict: 'emp_id,work_date' });
    if (error) throw error;
    return { late_min: lateMin || 0, shift_id: useShift };
  }

  // ---------- คำแนะนำก่อนเช็กอิน: กันกดเข้างานผิด (นอกกะ / เพิ่งออกงาน) ----------
  async function checkInAdvisory(empId) {
    const out = { offSchedule: false, recentCheckout: null, openRecord: null };
    if (!empId) return out;
    try {
      const today = bangkokDate();
      const yday = _addDays(today, -1);
      const nowMs = Date.now();
      const st = await _loadSettings();
      const earlyMin = Number(st.checkin_early_min || 180);      // เข้างานก่อนกะได้ไม่เกิน N นาที
      const recentHrs = Number(st.recent_checkout_hours || 8);   // เพิ่งออกงานภายใน N ชม. → เตือน

      // 1) นอกกะ: หา "กะที่คาดหวัง" จากตารางเวรวันนี้/เมื่อวาน (รองรับข้ามคืน) ถ้าไม่มีใช้กะประจำ
      const { data: emp } = await sb.from('employees').select('default_shift').eq('emp_id', empId).maybeSingle();
      const { data: sch } = await sb.from('schedules').select('work_date,shift_id').eq('emp_id', empId).in('work_date', [today, yday]);
      const cand = [];
      (sch || []).forEach(s => { if (s.shift_id) cand.push({ d: s.work_date, sid: s.shift_id }); });
      if (!cand.length && emp && emp.default_shift) { cand.push({ d: today, sid: emp.default_shift }); cand.push({ d: yday, sid: emp.default_shift }); }
      if (cand.length) {
        const ids = [...new Set(cand.map(c => c.sid))];
        const { data: shs } = await sb.from('shifts').select('shift_id,start_time,end_time').in('shift_id', ids);
        const shBy = {}; (shs || []).forEach(s => { shBy[s.shift_id] = s; });
        let inWindow = false;
        for (const c of cand) {
          const s = shBy[c.sid]; if (!s || !s.start_time || !s.end_time) continue;
          const stt = String(s.start_time).slice(0, 5), en = String(s.end_time).slice(0, 5);
          const overnight = en <= stt;                                   // กะข้ามคืน: เลิกเช้าวันถัดไป
          const startMs = new Date(c.d + 'T' + stt + ':00+07:00').getTime() - earlyMin * 60000;
          const endMs = new Date((overnight ? _addDays(c.d, 1) : c.d) + 'T' + en + ':00+07:00').getTime();
          if (nowMs >= startMs && nowMs <= endMs) { inWindow = true; break; }
        }
        out.offSchedule = !inWindow;                                     // มีกะให้เทียบ แต่เวลานี้ไม่อยู่ในกรอบกะใด
      }

      // 2) ยังมีงานที่ "ยังไม่กดออก" ค้างอยู่ (เช่น เพิ่งจบกะดึกแต่ยังไม่ปิด) → น่าจะตั้งใจกดออก ไม่ใช่เข้าใหม่
      const { data: op } = await sb.from('attendance').select('work_date,check_in,shift_id')
        .eq('emp_id', empId).not('check_in', 'is', null).is('check_out', null)
        .gte('work_date', _addDays(today, -2)).order('check_in', { ascending: false }).limit(1).maybeSingle();
      if (op && op.check_in) out.openRecord = { workDate: op.work_date, checkinTime: _fmtTime(op.check_in) };

      // 3) เพิ่งออกงาน/ถูกปิดงานอัตโนมัติภายใน N ชม.
      const { data: rc } = await sb.from('attendance').select('work_date,check_out,auto_closed,status')
        .eq('emp_id', empId).not('check_out', 'is', null)
        .gte('work_date', _addDays(today, -2)).order('check_out', { ascending: false }).limit(1).maybeSingle();
      if (rc && rc.check_out) {
        const hoursAgo = (nowMs - new Date(rc.check_out).getTime()) / 3600000;
        if (hoursAgo >= 0 && hoursAgo <= recentHrs) {
          out.recentCheckout = {
            hoursAgo: Math.round(hoursAgo * 10) / 10,
            autoClosed: rc.auto_closed === true || rc.status === 'AUTO_CLOSED',
            checkoutTime: _fmtTime(rc.check_out), workDate: rc.work_date,
          };
        }
      }
    } catch (e) { /* เงียบไว้: advisory ล้มไม่ควรบล็อกการเช็กอิน */ }
    return out;
  }

  // ---------- เช็กเอาท์ ----------
  async function checkOut({ empId, shiftId, checkoutBranchId, reason, photoDataUrl }) {
    const today = bangkokDate();
    // หาแถวที่ "ยังเปิดอยู่ล่าสุด" (เช็กอินแล้ว ยังไม่เช็กเอาต์) ภายใน 2 วัน — รองรับกะข้ามคืน (เข้าเมื่อวาน ออกวันนี้)
    let { data: row } = await sb.from('attendance')
      .select('work_date,check_in,shift_id,branch_id')
      .eq('emp_id', empId).not('check_in', 'is', null).is('check_out', null)
      .gte('work_date', _addDays(today, -2))
      .order('check_in', { ascending: false }).limit(1).maybeSingle();
    if (!row || !row.check_in) return { ot_hours: 0, none: true };   // ไม่มีแถวที่ค้างเปิดอยู่
    const checkinBranch = row.branch_id || null;
    const crossBranch = !!(checkoutBranchId && checkinBranch && checkoutBranchId !== checkinBranch);
    // ข้ามสาขา แต่ยังไม่ได้ใส่เหตุผล → ขอเหตุผลก่อน (ยังไม่ปิดงาน)
    if (crossBranch && !(reason && String(reason).trim())) {
      return { needReason: true, checkinBranch, checkoutBranch: checkoutBranchId };
    }
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const effShift = row.shift_id || shiftId;
    // ควบกะ: OT คิดจากเวลาเลิก "กะสุดท้าย" ที่จัดเวรไว้วันนั้น (รองรับข้ามคืน) ไม่ใช่กะที่เช็กอิน
    const { data: daySched } = await sb.from('schedules').select('shift_id').eq('emp_id', empId).eq('work_date', row.work_date);
    const schIds = [...new Set((daySched || []).map(s => s.shift_id).filter(Boolean))];
    const consider = schIds.length ? schIds : (effShift ? [effShift] : []);
    let ot = 0, earlyOutMin = null;
    if (consider.length) {
      const { data: shs } = await sb.from('shifts').select('shift_id,start_time,end_time,no_ot').in('shift_id', consider);
      const shById = {}; (shs || []).forEach(s => { shById[s.shift_id] = s; });
      let lastEndMs = -Infinity, lastShift = null;
      consider.forEach(sid => {
        const s = shById[sid]; if (!s || !s.end_time) return;
        const st = String(s.start_time || '').slice(0, 5), en = String(s.end_time).slice(0, 5);
        const overnight = st && en <= st;                       // กะข้ามคืน: เลิกเช้าวันถัดไป
        const endDate = overnight ? _addDays(row.work_date, 1) : row.work_date;
        const ms = new Date(endDate + 'T' + en + ':00+07:00').getTime();
        if (ms > lastEndMs) { lastEndMs = ms; lastShift = s; }
      });
      if (lastShift && !lastShift.no_ot && lastEndMs > -Infinity) {
        const diff = (nowMs - lastEndMs) / 3600000 - (await _otFreeHours());
        ot = diff > 0 ? Math.round(diff * 100) / 100 : 0;
      }
      // ออกก่อนเวลา: กดออกก่อนเวลาเลิก "กะสุดท้าย" → เก็บจำนวนนาทีที่ออกก่อน
      if (lastEndMs > -Infinity && nowMs < lastEndMs) earlyOutMin = Math.round((lastEndMs - nowMs) / 60000);
    }
    const upd = { check_out: nowIso, ot_hours: ot, early_out_min: earlyOutMin, status: 'CLOSED', auto_closed: false, extend_until: null };
    // รูปถ่ายตอนออกงาน (เซลฟี) — เก็บแยกจากรูปตอนเข้า
    if (photoDataUrl) {
      try { upd.checkout_photo_url = await uploadPhoto('attendance-photos', `${empId}/${row.work_date}_out_${Date.now()}.jpg`, photoDataUrl); } catch (e) { /* ไม่ให้รูปพังการกดออก */ }
    }
    if (checkoutBranchId) upd.checkout_branch_id = checkoutBranchId;
    if (crossBranch) upd.checkout_note = String(reason).trim();
    const { error } = await sb.from('attendance')
      .update(upd)
      .eq('emp_id', empId).eq('work_date', row.work_date);
    if (error) throw error;
    return { ot_hours: ot, work_date: row.work_date, crossBranch };
  }

  // ---------- ควบกะต่อ: เลื่อนเวลาที่ระบบจะปิดงานอัตโนมัติ ----------
  async function extendShift({ empId, untilIso }) {
    const today = bangkokDate();
    const { data: row } = await sb.from('attendance').select('work_date,check_in')
      .eq('emp_id', empId).not('check_in', 'is', null).is('check_out', null)
      .gte('work_date', _addDays(today, -2)).order('check_in', { ascending: false }).limit(1).maybeSingle();
    if (!row || !row.check_in) return { none: true };
    const { error } = await sb.from('attendance').update({ extend_until: untilIso, auto_closed: false })
      .eq('emp_id', empId).eq('work_date', row.work_date);
    if (error) throw error;
    return { ok: true, work_date: row.work_date };
  }

  // ---------- สถานะการกดออก (ไว้โชว์การ์ดเตือน/ควบกะ/ยื่นแก้ไข) ----------
  async function getCheckoutState(empId) {
    if (!empId) return { none: true };
    const today = bangkokDate();
    const { data: row } = await sb.from('attendance').select('work_date,check_in,check_out,shift_id,auto_closed,extend_until')
      .eq('emp_id', empId).not('check_in', 'is', null)
      .gte('work_date', _addDays(today, -2)).order('check_in', { ascending: false }).limit(1).maybeSingle();
    if (!row) return { none: true };
    let shift = null;
    if (row.shift_id) { const { data: sh } = await sb.from('shifts').select('shift_id,name,start_time,end_time').eq('shift_id', row.shift_id).maybeSingle(); shift = sh || null; }
    return { row, shift };
  }

  // ---------- ยื่นแก้ไขเวลาออกจริง (กรณีระบบปิดให้/ลืมกด) ----------
  async function requestCheckoutCorrection({ empId, actualIso, reason }) {
    const emp = await lookupEmployee(empId); if (!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const today = bangkokDate();
    // หาแถวที่เกี่ยวข้อง: ปิดโดยระบบ หรือ เปิดค้าง ภายใน 2 วัน
    const { data: row } = await sb.from('attendance').select('work_date,check_in,check_out,shift_id,branch_id,auto_closed')
      .eq('emp_id', empId).not('check_in', 'is', null)
      .gte('work_date', _addDays(today, -2)).order('check_in', { ascending: false }).limit(1).maybeSingle();
    if (!row) throw new Error('ไม่พบรายการลงเวลาที่จะแก้ไข');
    if (!actualIso) throw new Error('ระบุเวลาออกจริง');
    const { error } = await sb.from('checkout_corrections').insert({
      emp_id: emp.emp_id, emp_name: emp.nickname || emp.name, work_date: row.work_date,
      branch_id: row.branch_id || emp.branch_id || null, shift_id: row.shift_id || null,
      system_checkout: row.check_out || null, actual_checkout: actualIso, reason: (reason || '').trim() || null, status: 'pending',
    });
    if (error) throw error;
    return { ok: true, work_date: row.work_date };
  }

  // ---------- สถานะการลงเวลาวันนี้ (ไว้สลับปุ่มเข้า/ออก) ----------
  async function todayAttendance(empId) {
    if (!empId) return null;
    const today = bangkokDate();
    const { data } = await sb.from('attendance').select('check_in,check_out,status,late_min,work_date')
      .eq('emp_id', empId).eq('work_date', today).maybeSingle();
    if (data && data.check_in) return data;   // มีแถววันนี้ + เช็กอินแล้ว → ใช้เลย
    // เผื่อกะข้ามคืน: ถ้ายังมีแถวที่ค้างเปิดอยู่ (เข้าเมื่อวานยังไม่ออก) ให้ปุ่มยังเป็น "ออกงาน"
    const { data: open } = await sb.from('attendance').select('check_in,check_out,status,late_min,work_date')
      .eq('emp_id', empId).not('check_in', 'is', null).is('check_out', null)
      .gte('work_date', _addDays(today, -2)).order('check_in', { ascending: false }).limit(1).maybeSingle();
    return open || data || null;
  }

  // ---------- สถานะของฉัน (พนักงานตรวจวินัยตนเอง — ไม่แสดง OT) ----------
  async function selfStatus(empId) {
    const today = bangkokDate();
    const cyc = cycleRange21();
    const endEff = cyc.end < today ? cyc.end : today;
    const [empR, attR, schR, lvR] = await Promise.all([
      sb.from('employees').select('emp_id,name,nickname,default_shift,branch_id,weekly_off').eq('emp_id', empId).maybeSingle(),
      sb.from('attendance').select('work_date,check_in,late_min,status').eq('emp_id', empId).gte('work_date', cyc.start).lte('work_date', endEff),
      sb.from('schedules').select('work_date,shift_id').eq('emp_id', empId).gte('work_date', cyc.start).lte('work_date', endEff),
      sb.from('leaves').select('start_date,end_date,status').eq('emp_id', empId).eq('status', 'approved').lte('start_date', cyc.end).gte('end_date', cyc.start),
    ]);
    if (empR.error) throw empR.error;
    if (!empR.data) throw new Error('ไม่พบรหัสพนักงานนี้');
    const att = attR.data || [];
    const todayRow = att.find(a => a.work_date === today);
    const late = att.filter(a => a.late_min > 0);
    const worked = new Set(att.filter(a => a.check_in).map(a => a.work_date));
    const myLeaves = lvR.data || [];
    const onLeave = d => myLeaves.some(l => d >= l.start_date && d <= (l.end_date || l.start_date));
    let leave_days = 0;
    myLeaves.forEach(l => {
      const s = l.start_date < cyc.start ? cyc.start : l.start_date;
      const e = (l.end_date || l.start_date) > endEff ? endEff : (l.end_date || l.start_date);
      if (s <= e) leave_days += _daysBetween(s, e);
    });
    // ขาดงาน = นับจากวัน "จัดกะจริง" (ตารางเวร) ที่ผ่านมาแล้ว แต่ไม่มาและไม่ได้ลา
    const mySched = [...new Set((schR.data || []).filter(s => s.shift_id).map(s => s.work_date))].filter(d => d < today);
    const days_should = mySched.length;
    const days_worked = mySched.filter(d => worked.has(d)).length;
    const late_count = late.length;
    const late_total = late.reduce((s, a) => s + (a.late_min || 0), 0);
    const absent = mySched.filter(d => !worked.has(d) && !onLeave(d)).length;
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

  // ---------- สถานะเต็มสำหรับป๊อปอัพหลังเช็กอิน (วินัย + คะแนน + ระยะถึงบทลงโทษ) ----------
  async function myStatus(empId) {
    const today = bangkokDate();
    const cyc = cycleRange21();
    const endEff = cyc.end < today ? cyc.end : today;
    const [empR, attR, schR, lvR, drR, scfgR, srR, sbR, seR] = await Promise.all([
      sb.from('employees').select('emp_id,name,nickname,branch_id,photo_url').eq('emp_id', empId).maybeSingle(),
      sb.from('attendance').select('work_date,check_in,late_min,status').eq('emp_id', empId).gte('work_date', cyc.start).lte('work_date', endEff),
      sb.from('schedules').select('work_date,shift_id').eq('emp_id', empId).gte('work_date', cyc.start).lte('work_date', endEff),
      sb.from('leaves').select('start_date,end_date,status').eq('emp_id', empId).eq('status', 'approved').lte('start_date', cyc.end).gte('end_date', cyc.start),
      sb.from('discipline_rules').select('*'),
      sb.from('score_config').select('*').eq('id', 1).maybeSingle(),
      sb.from('score_rules').select('*'),
      sb.from('score_bands').select('*'),
      sb.from('score_events').select('*').eq('emp_id', empId).gte('event_date', cyc.start).lte('event_date', cyc.end),
    ]);
    if (empR.error) throw empR.error;
    if (!empR.data) throw new Error('ไม่พบรหัสพนักงานนี้');
    const att = attR.data || [];
    const worked = new Set(att.filter(a => a.check_in).map(a => a.work_date));
    const myLeaves = lvR.data || [];
    const onLeave = d => myLeaves.some(l => d >= l.start_date && d <= (l.end_date || l.start_date));
    const late = att.filter(a => a.late_min > 0);
    const late_count = late.length, late_total = late.reduce((s, a) => s + (a.late_min || 0), 0);
    const mySched = [...new Set((schR.data || []).filter(s => s.shift_id).map(s => s.work_date))].filter(d => d < today);
    const absent = mySched.filter(d => !worked.has(d) && !onLeave(d)).length;
    let leave_days = 0;
    myLeaves.forEach(l => { const s = l.start_date < cyc.start ? cyc.start : l.start_date; const e = (l.end_date || l.start_date) > endEff ? endEff : (l.end_date || l.start_date); if (s <= e) leave_days += _daysBetween(s, e); });
    const todayRow = att.find(a => a.work_date === today);
    const todayStatus = { checked_in: !!(todayRow && todayRow.check_in), check_in_time: (todayRow && todayRow.check_in) ? _fmtTime(todayRow.check_in) : null, late_min: todayRow ? (todayRow.late_min || 0) : 0 };

    const discipline = _disciplineFromRules(drR.data, late_count, absent);
    const score = _computeScore({ cfg: scfgR.data, rules: srR.data, bands: sbR.data, events: seR.data, att, mySched, worked, onLeave });

    return { emp: empR.data, cycle: cyc, today: todayStatus, stats: { late_count, late_total, absent, leave_days }, discipline, score };
  }

  // ประกาศที่ HR เขียนถึงพนักงาน (active + ยังไม่หมดอายุ)
  async function getAnnouncements() {
    const today = bangkokDate();
    const { data } = await sb.from('announcements').select('id,message,level,created_at,kind')
      .eq('active', true).or(`expire_date.is.null,expire_date.gte.${today}`)
      .order('created_at', { ascending: false });
    // ประกาศรูปภาพแสดงเป็นสไลด์แยกต่างหาก ไม่เอามาปนกับแบนเนอร์ข้อความ
    return (data || []).filter(a => (a.kind || 'text') !== 'image');
  }

  // ---------- ระบบยืนยันการรับทราบประกาศ ----------
  // ประกาศที่ "ค้างรับทราบ" ของพนักงานคนนี้ (important / mandatory ที่ยังไม่กดรับทราบ)
  //  · normal        = แค่แจ้ง ไม่ต้องรับทราบ (ไม่คืนมาที่นี่)
  //  · important     = ต้องกดรับทราบ
  //  · mandatory     = ต้องกดรับทราบ + ตอบคำถามยืนยันความเข้าใจให้ถูก (บล็อกหน้ารับส่งผลัด)
  async function getPendingAnnouncements(empId, branchId) {
    try {
      const today = bangkokDate();
      const { data: anns } = await sb.from('announcements')
        .select('id,title,message,level,priority,branch_ids,quiz_q,quiz_choices,quiz_answer,created_at')
        .eq('active', true).in('priority', ['important', 'mandatory'])
        .or(`expire_date.is.null,expire_date.gte.${today}`)
        .order('created_at', { ascending: true });
      let list = anns || [];
      // กรองตามสาขา (branch_ids ว่าง = ทุกสาขา)
      if (branchId) {
        list = list.filter(a => {
          const bs = Array.isArray(a.branch_ids) ? a.branch_ids : [];
          return bs.length === 0 || bs.map(String).includes(String(branchId));
        });
      }
      if (!list.length) return [];
      const ids = list.map(a => a.id);
      const { data: acks } = await sb.from('announcement_acks')
        .select('ann_id,acked_at').eq('emp_id', String(empId)).in('ann_id', ids);
      const done = {}; (acks || []).forEach(a => { if (a.acked_at) done[a.ann_id] = true; });
      return list.filter(a => !done[a.id]);
    } catch (e) { console.error('pending announcements', e); return []; }
  }

  // ---------- เคสวินัย: การดำเนินการที่พนักงานต้องกดรับทราบ ----------
  async function getPendingDiscAcks(empId) {
    try {
      const { data } = await sb.from('disc_actions')
        .select('id,action_type,level_name,reason,detail,score,band_label,late_count,late_total,absent_count,warning_id,performed_by,performed_role,performed_at,photos')
        .eq('emp_id', String(empId)).eq('need_ack', true).is('ack_at', null)
        .order('performed_at', { ascending: true });
      return data || [];
    } catch (e) { console.error('pending disc acks', e); return []; }
  }

  // พนักงานกดรับทราบ — เก็บเวลา + อุปกรณ์เป็นหลักฐาน
  async function ackDiscAction(id, empId, note) {
    try {
      const now = new Date().toISOString();
      const { data: row } = await sb.from('disc_actions').select('id,warning_id,emp_id').eq('id', id).maybeSingle();
      if (!row) return { ok: false, error: 'ไม่พบรายการนี้' };
      if (String(row.emp_id) !== String(empId)) return { ok: false, error: 'รายการนี้ไม่ใช่ของคุณ' };

      const { error } = await sb.from('disc_actions').update({
        ack_at: now, ack_note: (note || '').slice(0, 500), status: 'acknowledged',
        ack_device: (navigator.userAgent || '').slice(0, 120)
      }).eq('id', id);
      if (error) throw error;

      // ถ้าเป็นใบเตือน → อัปเดตสถานะใบเตือนด้วย
      if (row.warning_id) {
        try {
          await sb.from('warnings').update({ status: 'acknowledged', acknowledged_at: now, ack_note: (note || '').slice(0, 500) })
            .eq('warning_id', row.warning_id);
        } catch (_e) { /* ข้าม */ }
      }
      // หลักฐานเพิ่มเติมใน activity_log
      try { await sb.from('activity_log').insert({ action: 'รับทราบการดำเนินการทางวินัย', emp_id: String(empId), detail: (note || '').slice(0, 200), actor: String(empId) }); } catch (_e) { }
      return { ok: true };
    } catch (e) { console.error('ack disc', e); return { ok: false, error: 'บันทึกไม่สำเร็จ' }; }
  }

  // ประกาศแบบ "รูปภาพ" (สไลด์) ที่ยังแสดงอยู่ — ไม่ต้องกดรับทราบ
  async function getImageAnnouncements(empId, branchId) {
    try {
      const today = bangkokDate();
      const { data } = await sb.from('announcements')
        .select('id,title,message,images,branch_ids,created_at')
        .eq('active', true).eq('kind', 'image')
        .or(`expire_date.is.null,expire_date.gte.${today}`)
        .order('created_at', { ascending: false });
      let list = (data || []).filter(a => Array.isArray(a.images) && a.images.length);
      if (branchId) {
        list = list.filter(a => {
          const bs = Array.isArray(a.branch_ids) ? a.branch_ids : [];
          return bs.length === 0 || bs.map(String).includes(String(branchId));
        });
      }
      return list;
    } catch (e) { console.error('image announcements', e); return []; }
  }

  // บันทึกว่า "เปิดอ่าน" แล้ว (ยังไม่กดรับทราบ)
  async function markAnnouncementOpened(annId, empId, empName, branchId) {
    try {
      const { data: ex } = await sb.from('announcement_acks')
        .select('ann_id,opened_at').eq('ann_id', annId).eq('emp_id', String(empId)).maybeSingle();
      if (ex && ex.opened_at) return true;
      await sb.from('announcement_acks').upsert({
        ann_id: annId, emp_id: String(empId), emp_name: empName || '', branch_id: branchId ? String(branchId) : null,
        opened_at: new Date().toISOString(), device: (navigator.userAgent || '').slice(0, 120)
      }, { onConflict: 'ann_id,emp_id' });
      return true;
    } catch (e) { console.error('ann opened', e); return false; }
  }

  // กดรับทราบ · ถ้ามีคำถาม ต้องส่ง answerIdx มาด้วยและต้องตอบถูก
  // คืน { ok, error }
  async function ackAnnouncement(annId, empId, empName, branchId, answerIdx) {
    try {
      const { data: a } = await sb.from('announcements')
        .select('id,quiz_q,quiz_answer').eq('id', annId).maybeSingle();
      if (!a) return { ok: false, error: 'ไม่พบประกาศนี้' };

      let quizOk = null;
      if (a.quiz_q) {
        if (answerIdx === null || answerIdx === undefined || answerIdx === '') return { ok: false, error: 'กรุณาตอบคำถามยืนยันความเข้าใจ' };
        quizOk = Number(answerIdx) === Number(a.quiz_answer);
        if (!quizOk) {
          // นับจำนวนครั้งที่ตอบผิด (เก็บเป็นหลักฐานว่าอ่านจริงหรือกดมั่ว)
          const { data: cur } = await sb.from('announcement_acks')
            .select('quiz_tries').eq('ann_id', annId).eq('emp_id', String(empId)).maybeSingle();
          await sb.from('announcement_acks').upsert({
            ann_id: annId, emp_id: String(empId), emp_name: empName || '', branch_id: branchId ? String(branchId) : null,
            quiz_tries: ((cur && cur.quiz_tries) || 0) + 1, quiz_ok: false
          }, { onConflict: 'ann_id,emp_id' });
          return { ok: false, error: 'คำตอบยังไม่ถูกต้อง กรุณาอ่านประกาศอีกครั้งแล้วลองใหม่' };
        }
      }

      const { data: cur } = await sb.from('announcement_acks')
        .select('quiz_tries,opened_at').eq('ann_id', annId).eq('emp_id', String(empId)).maybeSingle();
      await sb.from('announcement_acks').upsert({
        ann_id: annId, emp_id: String(empId), emp_name: empName || '', branch_id: branchId ? String(branchId) : null,
        opened_at: (cur && cur.opened_at) || new Date().toISOString(),
        acked_at: new Date().toISOString(),
        quiz_ok: quizOk, quiz_tries: (cur && cur.quiz_tries) || 0,
        device: (navigator.userAgent || '').slice(0, 120)
      }, { onConflict: 'ann_id,emp_id' });
      return { ok: true };
    } catch (e) { console.error('ack announcement', e); return { ok: false, error: 'บันทึกไม่สำเร็จ' }; }
  }

  // บันทึก log ว่าพนักงานรับทราบสถานะแล้ว (หลักฐานตอนออกใบเตือน)
  async function acknowledgeStatus(empId, detail, name) {
    try {
      await sb.from('activity_log').insert({ action: 'รับทราบสถานะ', emp_id: empId, detail: detail || '', actor: name || empId });
      return true;
    } catch (e) { console.error('ack log', e); return false; }
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

  // ระดับวินัยจากเกณฑ์ที่ HR ตั้งไว้ (ตาราง discipline_rules) + ระยะถึงระดับถัดไป
  function _disciplineFromRules(rulesRaw, lateCount, absent) {
    const rules = (rulesRaw || []).filter(r => r.enabled !== false).sort((a, b) => a.level - b.level);
    if (!rules.length) { const d = _disciplineLevel(lateCount, absent); return { level: d.level, name: d.name, color: d.color, message: d.message, next: null }; }
    const meets = r => ((r.late_min != null && lateCount >= r.late_min) || (r.absent_min != null && absent >= r.absent_min));
    let cur = null;
    rules.forEach(r => { if (meets(r)) cur = r; });
    const curLevel = cur ? cur.level : 0;
    const next = rules.find(r => r.level > curLevel && !meets(r)) || rules.find(r => r.level > curLevel) || null;
    let nextInfo = null;
    if (next) {
      nextInfo = {
        name: next.level_name,
        need_late: (next.late_min != null) ? Math.max(0, next.late_min - lateCount) : null,
        need_absent: (next.absent_min != null) ? Math.max(0, next.absent_min - absent) : null,
      };
    }
    return {
      level: curLevel,
      name: cur ? cur.level_name : 'ปกติ',
      color: cur ? cur.level_color : '#16a34a',
      message: cur ? ('เข้าข่าย "' + cur.level_name + '" แล้ว โปรดปรับปรุงด่วน') : 'ยังไม่เข้าข่ายใบเตือน รักษาวินัยให้ดีต่อไป',
      next: nextInfo,
    };
  }

  // คะแนนวินัยเดือนนี้ (จำลองสูตรเดียวกับฝั่ง HR hrScoreGet) + ระยะถึงโซนใบเตือน
  function _computeScore({ cfg, rules, bands, events, att, mySched, worked, onLeave }) {
    bands = bands || [];
    if (!bands.length) return { enabled: false };           // ยังไม่ได้ตั้งระบบคะแนน
    const start = (cfg && cfg.start_score) || 100;
    const byKind = {}; (rules || []).filter(r => r.enabled !== false).forEach(r => { byKind[r.kind] = r; });
    const myAtt = att.filter(a => a.check_in);
    let autoDeduct = 0;
    [['auto_late_1_10', m => m >= 1 && m <= 10], ['auto_late_11_30', m => m >= 11 && m <= 30], ['auto_late_30plus', m => m > 30]]
      .forEach(([k, test]) => { const r = byKind[k]; if (!r) return; const hits = myAtt.filter(a => test(a.late_min || 0)).length; if (hits) autoDeduct += r.points * hits; });
    const ra = byKind['auto_absent_no_notify'];
    if (ra) { const absDays = mySched.filter(d => !worked.has(d) && !onLeave(d)).length; autoDeduct += ra.points * absDays; }
    let manualDeduct = 0; (events || []).forEach(ev => { manualDeduct += ev.points; });
    let score = start + autoDeduct + manualDeduct; if (score < 0) score = 0;
    const sorted = bands.slice().sort((a, b) => b.min_score - a.min_score);
    const band = sorted.find(b => score >= b.min_score && score <= b.max_score) || null;
    // โซนใบเตือนที่ใกล้สุดซึ่งอยู่ "ใต้" คะแนนปัจจุบัน
    const warnBelow = sorted.filter(b => b.warn_level != null && score > b.max_score).sort((a, b) => b.max_score - a.max_score)[0];
    let to_warn = null;
    if (band && band.warn_level != null) to_warn = { already: true, warn_name: band.warn_name || band.label };
    else if (warnBelow) to_warn = { gap: score - warnBelow.max_score, warn_name: warnBelow.warn_name || warnBelow.label, at_or_below: warnBelow.max_score };
    return {
      enabled: true, start, score,
      band_label: band ? band.label : '', band_color: band ? band.color : '#475569',
      bonus: band && band.bonus_amount ? band.bonus_amount : 0,
      to_warn,
    };
  }
  // OT = ชั่วโมงหลังเลิกกะ หักชั่วโมงที่ยังไม่คิด (freeHours) — เริ่มคิด OT ที่ชั่วโมงที่ (freeHours+1)
  function computeOt(checkOutIso, endTime, freeHours) {
    if (!endTime) return 0;
    const outMs = new Date(checkOutIso).getTime();
    const [h, m] = endTime.split(':').map(Number);
    // อ้างอิงเวลาไทย (+07:00) เสมอ — ไม่ขึ้นกับเขตเวลาของเครื่อง
    const bkk = new Date(outMs + 7 * 3600 * 1000);
    const day = bkk.getUTCFullYear() + '-' + String(bkk.getUTCMonth() + 1).padStart(2, '0') + '-' + String(bkk.getUTCDate()).padStart(2, '0');
    let endMs = new Date(day + 'T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00+07:00').getTime();
    if ((outMs - endMs) / 3600000 < -12) endMs -= 86400000;   // กะข้ามคืน
    const diff = (outMs - endMs) / 3600000 - (freeHours || 0);
    return diff > 0 ? Math.round(diff * 100) / 100 : 0;
  }
  async function _otFreeHours() {
    const s = await _loadSettings();
    const start = parseInt(s['ot_start_hour']);   // เริ่มคิด OT ที่ชั่วโมงที่ N (ดีฟอลต์ 2)
    return Math.max(0, (isNaN(start) ? 2 : start) - 1);
  }

  // ---------- เงื่อนไขการลา ----------
  function _inclusiveDays(a, b) { const s = new Date(a + 'T00:00:00'), e = new Date((b || a) + 'T00:00:00'); return Math.round((e - s) / 86400000) + 1; }
  function _diffDays(from, to) { const s = new Date(from + 'T00:00:00'), e = new Date(to + 'T00:00:00'); return Math.round((e - s) / 86400000); }
  async function getLeaveRules() {
    const { data } = await sb.from('leave_types').select('*').eq('active', true).order('sort');
    return data || [];
  }
  async function getLeaveUsage(empId, ym) {
    ym = ym || bangkokDate().slice(0, 7);   // YYYY-MM — โควตานับเป็น "รายเดือน"
    const { data } = await sb.from('leaves').select('type,start_date,end_date,status')
      .eq('emp_id', empId).in('status', ['approved', 'pending'])
      .gte('start_date', ym + '-01').lte('start_date', ym + '-31');
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
    // ล็อก: มีข้อเสนอแนะเพิ่มเติมจาก HR ที่ยังไม่ตอบ → ต้องตอบก่อนยื่นใบใหม่ (กันความซับซ้อน)
    const { data: openProp } = await sb.from('leaves').select('leave_id').eq('emp_id', empId).eq('status', 'proposed').is('response', null).limit(1);
    if (openProp && openProp.length) throw new Error('คุณมีข้อเสนอแนะเพิ่มเติมจากผู้จัดการที่ยังไม่ได้ตอบ กรุณาตอบรับ/ปฏิเสธก่อนยื่นใบลาใหม่ค่ะ');
    const end = end_date || start_date;
    const today = bangkokDate();
    // เงื่อนไขตามประเภทการลา
    const { data: rule } = await sb.from('leave_types').select('*').eq('type', type).maybeSingle();
    if (rule) {
      if (!rule.allow_backdate && start_date < today)
        throw new Error('ประเภท "' + type + '" ลาย้อนหลังไม่ได้');
      if (!rule.allow_backdate && rule.advance_days > 0 && _diffDays(today, start_date) < rule.advance_days)
        throw new Error('ประเภท "' + type + '" ต้องลาล่วงหน้าอย่างน้อย ' + rule.advance_days + ' วัน');
      if (rule.quota_per_year != null) {   // quota_per_year = โควตาต่อเดือน (คงชื่อคอลัมน์เดิม)
        const usage = await getLeaveUsage(empId, String(start_date).slice(0, 7));   // นับเฉพาะเดือนของวันที่ลา
        const used = usage[type] || 0;
        const reqDays = _inclusiveDays(start_date, end);
        if (used + reqDays > rule.quota_per_year)
          throw new Error('เกินโควตา "' + type + '" (' + rule.quota_per_year + ' วัน/เดือน) — เดือนนี้ใช้ไปแล้ว ' + used + ' วัน ขอเพิ่ม ' + reqDays + ' วัน');
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
  // ---------- ข้อเสนอแนะเพิ่มเติมการลา (จาก HR) — ดึงที่ค้าง + ประวัติ ----------
  async function getLeaveProposals(empId) {
    if (!empId) return { pending: [], history: [] };
    const { data } = await sb.from('leaves')
      .select('leave_id,start_date,end_date,type,reason,status,proposal_msg,proposal_at,response,response_msg,response_at')
      .eq('emp_id', empId).not('proposal_at', 'is', null).order('proposal_at', { ascending: false }).limit(20);
    const rows = data || [];
    const pending = rows.filter(l => l.status === 'proposed' && !l.response);   // รอตอบ
    return { pending, history: rows };
  }
  // ---------- พนักงานตอบข้อเสนอ (ยอมรับ/ปฏิเสธ) — ปฏิเสธต้องมีเหตุผล ----------
  async function respondProposal(empId, leave_id, response, note) {
    if (!empId || !leave_id) throw new Error('ข้อมูลไม่ครบ');
    response = (response === 'accepted') ? 'accepted' : 'declined';
    note = (note || '').trim();
    if (response === 'declined' && !note) throw new Error('กรุณาระบุเหตุผลที่ไม่ยอมรับ');
    const { data: lv } = await sb.from('leaves').select('leave_id,emp_id,status').eq('leave_id', leave_id).maybeSingle();
    if (!lv || lv.emp_id !== empId) throw new Error('ไม่พบใบลานี้');
    if (lv.status !== 'proposed') throw new Error('ใบลานี้ไม่ได้อยู่ระหว่างรอตอบแล้ว');
    const upd = { response, response_msg: note || null, response_at: new Date().toISOString(), proposal_seen: true };
    const { error } = await sb.from('leaves').update(upd).eq('leave_id', leave_id).eq('emp_id', empId);
    if (error) throw error;
    return { ok: true, response };
  }

  // ---------- กล่องแจ้งเตือนของฉัน (คะแนน/ข้อความจากระบบ) ----------
  async function getMyNotifications(empId) {
    if (!empId) return { unseen: [], all: [] };
    const { data } = await sb.from('emp_notifications').select('*').eq('emp_id', empId).order('created_at', { ascending: false }).limit(30);
    const rows = data || [];
    return { unseen: rows.filter(n => !n.seen_at), all: rows };
  }
  async function markNotificationsSeen(empId, ids) {
    if (!empId) return { ok: true };
    let q = sb.from('emp_notifications').update({ seen_at: new Date().toISOString() }).eq('emp_id', empId).is('seen_at', null);
    if (Array.isArray(ids) && ids.length) q = q.in('id', ids);
    const { error } = await q; if (error) throw error;
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
    if (!emp) throw new Error('ไม่พบรหัสพนักงานนี้ (ให้ผู้จัดการสร้างรหัสก่อน)');
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

  // ---------- รับสมัครงาน (สาธารณะ) ----------
  async function getPositions() {
    const { data } = await sb.from('positions').select('name').eq('active', true).order('sort');
    return (data || []).map(p => p.name);
  }
  async function getBranchesPublic() {
    const { data } = await sb.from('branches').select('branch_id,name').order('branch_id');
    return data || [];
  }
  async function submitApplication(p) {
    p = p || {};
    if (!p.full_name || !String(p.full_name).trim()) throw new Error('กรอกชื่อ-นามสกุล');
    if (!p.phone || !String(p.phone).trim()) throw new Error('กรอกเบอร์โทร');
    if (!p.branch_id) throw new Error('เลือกสาขาที่สมัคร');
    if (!p.position) throw new Error('เลือกตำแหน่งที่สมัคร');
    if (p.id_card && !/^\d{13}$/.test(String(p.id_card).trim())) throw new Error('เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก');
    const base = 'applicants/' + (String(p.id_card || 'x').trim() || 'x') + '_' + Date.now();
    const up = async (val, name) => val ? await uploadPhoto('employee-docs', base + '_' + name + '.jpg', val) : null;
    const row = {
      full_name: String(p.full_name).trim(),
      nickname: (p.nickname || '').trim() || null,
      phone: String(p.phone).trim(),
      line_id: (p.line_id || '').trim() || null,
      email: (p.email || '').trim() || null,
      birth_date: p.birth_date || null,
      address: (p.address || '').trim() || null,
      id_card: (p.id_card || '').trim() || null,
      emergency_name: (p.emergency_name || '').trim() || null,
      emergency_relation: (p.emergency_relation || '').trim() || null,
      emergency_phone: (p.emergency_phone || '').trim() || null,
      branch_id: p.branch_id || null,
      position: p.position || null,
      expected_salary: (p.expected_salary === '' || p.expected_salary == null) ? null : Number(p.expected_salary),
      start_available: p.start_available || null,
      experience: (p.experience || '').trim() || null,
      photo_url: await up(p.photo, 'photo'),
      idcard_url: await up(p.idcard, 'idcard'),
      house_url: await up(p.house, 'house'),
      edu_url: await up(p.edu, 'edu'),
      other_url: await up(p.other, 'other'),
      status: 'new',
    };
    const { error } = await sb.from('applicants').insert(row);
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
    const _ctx = await _shiftCtx(emp);               // รองรับกะข้ามคืน (ดึก) + สาขาที่ไปทำแทน
    const today = _ctx.workDate;
    const branch = _ctx.branch;                       // สาขาที่ทำงานจริงวันนี้ (อาจเป็นสาขาที่ไปแทน)
    const group = shiftId || _ctx.group;             // ผลัดหลัก (เช้า/บ่าย/ดึก หรือ กะพิเศษ)
    const [defsR, asgR, schR, empsR, shR, brR] = await Promise.all([
      sb.from('task_defs').select('*').eq('active', true).order('sort'),
      sb.from('task_assignments').select('*').eq('branch_id', branch || '').eq('work_date', today).eq('shift_id', group),
      sb.from('schedules').select('emp_id,shift_id').eq('branch_id', branch || '').eq('work_date', today),
      sb.from('employees').select('emp_id,name,nickname,branch_id').eq('active', true),   // ทั้งหมด → resolve ชื่อคนทำแทนจากสาขาอื่นได้
      sb.from('shifts').select('shift_id,name,main_shift').order('start_time'),
      sb.from('branches').select('branch_id,name'),
    ]);
    const brName = {}; (brR.data || []).forEach(b => { brName[b.branch_id] = b.name; });
    const nameOf = {}; (empsR.data || []).forEach(e => { nameOf[e.emp_id] = e.nickname || e.name; });
    const grpOf = {}; (shR.data || []).forEach(s => { grpOf[s.shift_id] = s.main_shift || s.shift_id; });
    const memberIds = [...new Set((schR.data || []).filter(r => grpOf[r.shift_id] === group).map(r => r.emp_id))];
    const defs = (defsR.data || []).filter(d => !d.shift_id || d.shift_id === group);
    const byDef = {}; (asgR.data || []).forEach(a => { byDef[a.task_def_id] = a; });
    return {
      emp, shift: group, work_date: today, branch, shifts: shR.data || [],
      members: memberIds.map(id => ({ emp_id: id, name: nameOf[id] || id })),       // คนในกะวันนี้ (จากตารางเวรจริง)
      colleagues: (empsR.data || []).filter(e => (e.branch_id || '') === (branch || '')).map(e => ({ emp_id: e.emp_id, name: e.nickname || e.name })), // ทุกคนในสาขา (ไว้เพิ่มเข้ากะ)
      all_staff: (empsR.data || []).map(e => ({ emp_id: e.emp_id, name: e.nickname || e.name, branch_id: e.branch_id || '', branch_name: brName[e.branch_id] || e.branch_id || '', same_branch: (e.branch_id || '') === (branch || '') })), // ทุกคนทุกสาขา (ไว้เพิ่มคนข้ามสาขามาช่วย)
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
  async function addShiftMember({ branchId, shiftId, empId, workDate }) {
    const e = await lookupEmployee(empId);
    if (!e) throw new Error('ไม่พบรหัสพนักงานที่จะเพิ่ม');
    const today = workDate || bangkokDate();   // อิงวันทำงานของกะ (รองรับกะข้ามคืน)
    const { error } = await sb.from('schedules').upsert({ emp_id: e.emp_id, work_date: today, shift_id: shiftId || null, branch_id: branchId || e.branch_id || null, is_cover: false, note: 'เพิ่มเข้ากะเฉพาะกิจ' }, { onConflict: 'emp_id,work_date,shift_id' });
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
    const _ctx = await _shiftCtx(emp);   // รองรับกะข้ามคืน + สาขาที่ไปทำแทน
    const shift = shiftId || _ctx.group || '';
    const today = _ctx.workDate;
    const branch = _ctx.branch;
    _assertHasShift(shift);
    await _assertShiftStarted(shift, today);
    await _assertPrevShiftDone(branch, shift, today);
    let photo_url = null;
    if (photo) photo_url = await uploadPhoto('employee-docs', 'task/' + (branch || 'x') + '_' + task_def_id + '_' + Date.now() + '.jpg', photo);
    if (def.require_photo && !photo_url) throw new Error('งานนี้ต้องแนบรูปก่อนส่ง');
    const base = { emp_id: emp.emp_id, emp_name: emp.nickname || emp.name, status: 'submitted', emp_note: note || null, submitted_at: new Date().toISOString(), reviewer: null, review_note: null, reviewed_at: null };
    if (photo_url) base.photo_url = photo_url;
    const existing = await _findAsg(branch, today, shift, task_def_id);
    if (existing) { const { error } = await sb.from('task_assignments').update(base).eq('id', existing.id); if (error) throw error; }
    else { const { error } = await sb.from('task_assignments').insert(Object.assign({ work_date: today, branch_id: branch || null, shift_id: shift, task_def_id, title: def.title, require_photo: !!def.require_photo }, base)); if (error) throw error; }
    return { ok: true };
  }
  // หัวหน้าผลัดแบ่งงานให้เพื่อนในกะ (มอบหมาย — ยังไม่ส่ง)
  async function assignColleague({ byEmpId, toEmpId, task_def_id, shiftId }) {
    const by = await lookupEmployee(byEmpId); if (!by) throw new Error('ไม่พบรหัสผู้แบ่งงาน');
    const to = await lookupEmployee(toEmpId); if (!to) throw new Error('ไม่พบพนักงานที่จะมอบ');
    const def = (await sb.from('task_defs').select('*').eq('id', task_def_id).maybeSingle()).data;
    if (!def) throw new Error('ไม่พบงานนี้');
    const _ctx = await _shiftCtx(by);   // รองรับกะข้ามคืน + สาขาที่ไปทำแทน
    const shift = shiftId || _ctx.group || '';
    const today = _ctx.workDate;
    const branch = _ctx.branch;
    _assertHasShift(shift);
    await _assertShiftStarted(shift, today);
    await _assertPrevShiftDone(branch, shift, today);
    const base = { emp_id: to.emp_id, emp_name: to.nickname || to.name, status: 'todo', photo_url: null, emp_note: null, submitted_at: null, reviewer: null, review_note: null, reviewed_at: null };
    const existing = await _findAsg(branch, today, shift, task_def_id);
    if (existing) { const { error } = await sb.from('task_assignments').update(base).eq('id', existing.id); if (error) throw error; }
    else { const { error } = await sb.from('task_assignments').insert(Object.assign({ work_date: today, branch_id: branch || null, shift_id: shift, task_def_id, title: def.title, require_photo: !!def.require_photo }, base)); if (error) throw error; }
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
  // "วันทำงาน + ผลัดหลัก" ปัจจุบันของพนักงาน — รองรับกะข้ามคืน (ดึก)
  // ถ้ามีลงเวลาที่ยังเปิดค้างจากเมื่อวาน (กะดึกยังไม่จบ) ให้ยึด work_date + กะของแถวนั้น
  async function _shiftCtx(emp){
    const today=bangkokDate();
    const open=(await sb.from('attendance').select('work_date,shift_id,branch_id')
      .eq('emp_id',emp.emp_id).not('check_in','is',null).is('check_out',null)
      .gte('work_date',_addDays(today,-1)).lt('work_date',today)
      .order('check_in',{ascending:false}).limit(1).maybeSingle()).data;
    if(open && open.work_date){
      const sh=(await sb.from('shifts').select('main_shift').eq('shift_id',open.shift_id).maybeSingle()).data;
      return { workDate: open.work_date, group: (sh&&sh.main_shift)||open.shift_id, branch: open.branch_id||emp.branch_id||'' };
    }
    // อิงตารางเวรวันนี้ (รองรับไปทำแทนสาขาอื่น: ใช้สาขา+กะจากตารางเวร ไม่ใช่สาขาประจำ)
    const sc=(await sb.from('schedules').select('shift_id,branch_id').eq('emp_id',emp.emp_id).eq('work_date',today).maybeSingle()).data;
    const raw=(sc&&sc.shift_id)||emp.default_shift||'';
    let group=raw;
    if(raw){ const sh=(await sb.from('shifts').select('main_shift').eq('shift_id',raw).maybeSingle()).data; group=(sh&&sh.main_shift)||raw; }
    return { workDate: today, group, branch: (sc&&sc.branch_id)||emp.branch_id||'' };
  }
  // ---- ค่าตั้งระบบ + กฎกันทำงานผิดเวลา/ข้ามกะ ----
  let _appSettings=null;
  async function _loadSettings(){ if(_appSettings) return _appSettings; try{ const {data}=await sb.from('app_settings').select('key,value'); _appSettings={}; (data||[]).forEach(r=>{_appSettings[r.key]=r.value;}); }catch(e){ _appSettings={}; } return _appSettings; }
  async function _guardOn(key){ const s=await _loadSettings(); const v=s[key]; return v===undefined||v===null||v===''||v==='1'||v==='true'; }  // ดีฟอลต์ = เปิด
  function _hm2m(hm){ const p=String(hm||'').split(':'); return (parseInt(p[0])||0)*60+(parseInt(p[1])||0); }
  function _nowBkkMin(){ const hm=new Date(Date.now()+7*3600*1000).toISOString().slice(11,16); return _hm2m(hm); }
  // กฎ 0: ต้องมี "กะ" ก่อนจึงบันทึกงานได้ (งานไม่มีกะจะหลุดระบบตรวจรับผลัด → คนตรวจมองไม่เห็น)
  function _assertHasShift(shift){
    if(!shift || !String(shift).trim())
      throw new Error('ยังไม่มีกะของวันนี้ — ให้ผู้จัดการจัดตารางเวร หรือหัวหน้าผลัดใช้ "เพิ่มเข้ากะ" ก่อน จึงจะบันทึกงานได้ (งานที่ไม่มีกะจะไม่เข้าระบบตรวจรับผลัด ทำให้คนตรวจมองไม่เห็น)');
  }
  // กฎ 2: ถึงเวลาเข้ากะหรือยัง (ห้ามทำ/แจกงานก่อนเวลาเข้ากะ)
  async function _assertShiftStarted(group, workDate){
    if(!(await _guardOn('guard_shift_start'))) return;
    const sh=(await sb.from('shifts').select('start_time,name').eq('shift_id',group).maybeSingle()).data;
    if(!sh || !sh.start_time) return;                 // ไม่รู้เวลาเข้ากะ = ไม่บล็อก
    const today=bangkokDate();
    if(today > workDate) return;                       // เลยวันเข้ากะมาแล้ว = กำลังทำอยู่
    if(today === workDate && _nowBkkMin() >= _hm2m(sh.start_time)) return;
    throw new Error('ยังไม่ถึงเวลาเข้ากะ'+(sh.name?(' '+sh.name):'')+' (เริ่ม '+String(sh.start_time).slice(0,5)+' น.) — ยังทำงานไม่ได้');
  }
  // กฎ 1: งานของ "กะเดียวกันในวันก่อนหน้า" (สาขาเดียวกัน) ต้อง "ผ่าน" ครบก่อน
  //       เช่น ดึกวันที่ 2 จะทำได้ต่อเมื่อ ดึกวันที่ 1 ผ่านครบ · ไม่เกี่ยวกับผลัดอื่น (เช้า/บ่ายทำได้ปกติ)
  async function _assertPrevShiftDone(branch, group, workDate){
    if(!(await _guardOn('guard_prev_shift'))) return;
    const prev=_addDays(workDate,-1);
    const rows=(await sb.from('task_assignments').select('status').eq('branch_id',branch||'').eq('shift_id',group).eq('work_date',prev)).data||[];
    const pending=rows.filter(r=>r.status!=='approved').length;
    if(pending>0) throw new Error('งานกะนี้ของวันก่อนหน้ายังไม่ผ่านครบ ('+pending+' รายการ) — ต้องทำ/ให้ตรวจให้เสร็จก่อน จึงจะเริ่มกะนี้ของวันนี้ได้');
  }
  // ผลัดหลักก่อนหน้า (วนเฉพาะกะที่เป็นผลัดหลัก main_shift===shift_id เรียงตามเวลาเริ่ม)
  // baseDate = "วันทำงานของกะที่กำลังทำ" (work_date จาก _shiftCtx) — สำคัญมากกับกะดึกข้ามคืน
  // ถ้าไม่ส่งมา ใช้วันปฏิทินจริง (fallback)
  async function _prevMainGroup(group, baseDate){
    const today=baseDate||bangkokDate();
    const list=(await sb.from('shifts').select('shift_id,main_shift,start_time').order('start_time')).data||[];
    const chain=list.filter(s=>s.main_shift && s.main_shift===s.shift_id).map(s=>s.shift_id);
    const idx=chain.indexOf(group);
    if(idx<0) return { group:null, date:today, isMain:false };
    if(idx===0) return { group: chain[chain.length-1]||null, date:_addDays(today,-1), isMain:true };  // ผลัดหลักแรก(เช้า) → ก่อนหน้า = ผลัดหลักสุดท้ายของวันก่อนหน้า
    return { group: chain[idx-1], date:today, isMain:true };   // เช่น ดึก(ข้ามคืน) → บ่ายของ work_date เดียวกัน (ซึ่งอาจเป็น "เมื่อวาน" ตามปฏิทิน)
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
    const {workDate:today,group:shift,branch}=await _shiftCtx(emp);
    const lead=(await sb.from('shift_leads').select('emp_id,emp_name').eq('work_date',today).eq('branch_id',branch||'').eq('shift_id',shift).maybeSingle()).data;
    const sh=(await sb.from('shifts').select('name').eq('shift_id',shift).maybeSingle()).data;
    const brName=branch?((await sb.from('branches').select('name').eq('branch_id',branch).maybeSingle()).data||{}).name:'';
    const isCover = !!(branch && emp.branch_id && branch !== emp.branch_id);
    return { emp, shift, shift_name: sh?sh.name:shift, branch_id:branch||'', branch_name:brName||branch||'', is_cover:isCover,
      currentLeader: lead?{ emp_id:lead.emp_id, name:lead.emp_name }:null, isMe: !!(lead&&lead.emp_id===emp.emp_id) };
  }
  async function leaderConfirm(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const {workDate:today,group:shift,branch}=await _shiftCtx(emp);
    await sb.from('shift_leads').upsert({ work_date:today, branch_id:branch||null, shift_id:shift, emp_id:emp.emp_id, emp_name:emp.nickname||emp.name }, { onConflict:'work_date,branch_id,shift_id' });
    try{ await sb.from('activity_log').insert({ action:'คุมผลัด', emp_id:emp.emp_id, detail:'รับเป็นหัวหน้าผลัด กะ '+(shift||'-')+' สาขา '+(branch||'-'), actor:emp.nickname||emp.name }); }catch(e){}
    return { ok:true, emp, shift, branch_id:branch||'' };
  }

  // เมนู 2: งานที่ได้รับมอบหมาย (ของฉัน / ทีม / ยังว่าง)
  async function getMyAssignments(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const {workDate:today,group:shift,branch}=await _shiftCtx(emp);
    const [defsR, asgR, shR, leadR] = await Promise.all([
      sb.from('task_defs').select('*').eq('active',true).order('sort'),
      sb.from('task_assignments').select('*').eq('branch_id',branch||'').eq('work_date',today).eq('shift_id',shift),
      sb.from('shifts').select('name').eq('shift_id',shift).maybeSingle(),
      sb.from('shift_leads').select('emp_id,emp_name').eq('work_date',today).eq('branch_id',branch||'').eq('shift_id',shift).maybeSingle(),
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
    const {workDate:today,group:shift,branch}=await _shiftCtx(emp);
    _assertHasShift(shift);
    await _assertShiftStarted(shift, today);
    await _assertPrevShiftDone(branch, shift, today);
    const existing=await _findAsg(branch,today,shift,task_def_id);
    const base={ emp_id:emp.emp_id, emp_name:emp.nickname||emp.name, status:'todo', photos:null, photo_url:null, emp_note:null, submitted_at:null, reviewer:null, review_note:null, reviewed_at:null };
    if(existing){ const {error}=await sb.from('task_assignments').update(base).eq('id',existing.id); if(error) throw error; }
    else { const {error}=await sb.from('task_assignments').insert(Object.assign({ work_date:today, branch_id:branch||null, shift_id:shift, task_def_id, title:def.title, require_photo:(def.min_photos||0)>0 }, base)); if(error) throw error; }
    return { ok:true };
  }
  async function submitTaskMulti({ id, empId, photos, note }){
    const row=(await sb.from('task_assignments').select('*').eq('id',id).maybeSingle()).data; if(!row) throw new Error('ไม่พบงานนี้');
    // งานที่ ผจก.ตีกลับให้ "ผู้ตรวจของผลัดถัดไป" แก้ → คนแก้ไม่ได้อยู่กะเดียวกับงานเดิม จึงไม่ต้องเช็กว่ากะเริ่มหรือยัง
    const isFix = !!(row.fix_emp && !row.fix_done_at && row.status==='sent_back');
    if(!isFix) await _assertShiftStarted(row.shift_id, row.work_date);
    const def=(await sb.from('task_defs').select('min_photos,mgr_review').eq('id',row.task_def_id).maybeSingle()).data;
    const minP=def?(def.min_photos||0):0;
    // needs_mgr = งานติ๊ก "ผจก.ตรวจ" และกะนั้นเป็นกะที่ ผจก.ตรวจ (บางกะ เช่นดึก ไม่อยู่ในเวลา ผจก.)
    let shiftMgr=true;
    if(def && def.mgr_review && row.shift_id){ const sh=(await sb.from('shifts').select('mgr_review').eq('shift_id',row.shift_id).maybeSingle()).data; shiftMgr = !sh || sh.mgr_review!==false; }
    const wantMgr = !!(def && def.mgr_review && shiftMgr);
    const urls=[];
    // photos อาจมีทั้ง "รูปเดิม" (http URL — เก็บไว้ตามเดิม) และ "รูปใหม่" (data URL — อัปโหลด)
    // → แก้ไขงานที่ส่งแล้วได้เรื่อย ๆ: เพิ่ม/ลบรูป โดยรูปเดิมนับรวมกับขั้นต่ำ ไม่ต้องถ่ายใหม่ทั้งหมด
    for(const p of (photos||[])){
      if(!p) continue;
      if(typeof p==='string' && /^https?:/i.test(p)) urls.push(p);
      else urls.push(await uploadPhoto('employee-docs','task/'+(row.branch_id||'x')+'_'+id+'_'+Date.now()+'_'+urls.length+'.jpg', p));
    }
    if(urls.length < minP) throw new Error('งานนี้ต้องแนบรูปอย่างน้อย '+minP+' รูป');
    const upd={ status:'submitted', emp_note:note||null, submitted_at:new Date().toISOString(), reviewer:null, review_note:null, reviewed_at:null, needs_mgr: wantMgr };
    upd.photos = urls.length?urls:null; upd.photo_url = urls.length?urls[0]:null;
    if(isFix){
      // ส่งงานที่แก้แล้ว → ปิดงานแก้ + ล้างผลตรวจของ ผจก. เพื่อให้ ผจก.ตรวจซ้ำอีกรอบ
      upd.fix_done_at=new Date().toISOString();
      upd.mgr_checked_at=null; upd.mgr_checked_by=null; upd.mgr_result=null;
      upd.needs_mgr=true;
    }
    const {error}=await sb.from('task_assignments').update(upd).eq('id',id); if(error) throw error;
    try{
      const who=await lookupEmployee(empId);
      await sb.from('task_flow_log').insert({ task_id:id, branch_id:row.branch_id||null, work_date:row.work_date||null,
        event: isFix?'fix_submit':'submit', actor_emp: empId||null, actor_name: who?(who.nickname||who.name):null,
        actor_role:'emp', shift_id: row.shift_id||null, note: note||null });
    }catch(e){}
    return { ok:true, fix:isFix };
  }

  // เมนู 3: ตรวจผลัดก่อนหน้า (เฉพาะหัวหน้าผลัดถัดไป)
  async function getPrevShiftReview(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const {workDate:today,group:curGroup,branch}=await _shiftCtx(emp);
    const pv=await _prevMainGroup(curGroup, today);   // อิง work_date ของกะที่ทำ (รองรับกะดึกข้ามคืน)
    const lead=(await sb.from('shift_leads').select('emp_id').eq('work_date',today).eq('branch_id',branch||'').eq('shift_id',curGroup).maybeSingle()).data;
    const canReview=!!(lead&&lead.emp_id===emp.emp_id)&&pv.isMain;   // ตรวจได้เฉพาะหัวหน้าผลัดของผลัดหลัก
    let tasks=[];
    if(pv.group) tasks=(await sb.from('task_assignments').select('*').eq('branch_id',branch||'').eq('work_date',pv.date).eq('shift_id',pv.group).order('id')).data||[];
    return { emp, curShift:curGroup, cur_name:await _shiftName(curGroup), prev_shift: pv.group, prev_name: pv.group?(await _shiftName(pv.group)):'-', prev_date: pv.date, isMain:pv.isMain, canReview, tasks };
  }
  async function reviewPrevTask({ reviewerId, id, status, note, markup }){
    const emp=await lookupEmployee(reviewerId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const {workDate:today,group:curGroup,branch}=await _shiftCtx(emp);
    const lead=(await sb.from('shift_leads').select('emp_id').eq('work_date',today).eq('branch_id',branch||'').eq('shift_id',curGroup).maybeSingle()).data;
    if(!lead||lead.emp_id!==emp.emp_id) throw new Error('เฉพาะหัวหน้าผลัดเท่านั้นที่ตรวจได้');
    const task=(await sb.from('task_assignments').select('shift_id,work_date,sent_back_count').eq('id',id).maybeSingle()).data; if(!task) throw new Error('ไม่พบงานนี้');
    const pv=await _prevMainGroup(curGroup, today);   // อิง work_date ของกะที่ทำ (รองรับกะดึกข้ามคืน)
    if(!pv.group || task.shift_id!==pv.group || String(task.work_date)!==pv.date) throw new Error('ตรวจได้เฉพาะงานของผลัดก่อนหน้าเท่านั้น');
    const upd={ status: status==='approved'?'approved':'sent_back', reviewer: emp.nickname||emp.name, review_note:note||null, reviewed_at:new Date().toISOString() };
    if(status!=='approved') upd.sent_back_count=(task.sent_back_count||0)+1;
    // เก็บร่องรอย "ผลัดไหนตรวจ" — ถ้า ผจก.มาตรวจซ้ำแล้วไม่ผ่าน คนแก้จะเป็นผู้ตรวจคนนี้ (เพราะรับรองงานไปแล้ว)
    upd.checked_by_emp=emp.emp_id; upd.checked_by_name=emp.nickname||emp.name;
    upd.checked_by_shift=curGroup; upd.checked_at=new Date().toISOString();
    // รูปที่หัวหน้าผลัดวาดชี้จุด (data URL) → อัปโหลดเก็บเป็น review_markup
    if(status!=='approved' && Array.isArray(markup) && markup.length){
      const urls=[];
      for(const m of markup){ if(typeof m==='string'&&m.startsWith('data:')){ try{ urls.push(await uploadPhoto('employee-docs','markup/'+id+'_'+Date.now()+'_'+urls.length+'.jpg', m)); }catch(e){} } else if(typeof m==='string'&&m){ urls.push(m); } }
      upd.review_markup=urls.length?urls:null;
    }
    const {error}=await sb.from('task_assignments').update(upd).eq('id',id); if(error) throw error;
    try{ await sb.from('task_flow_log').insert({ task_id:id, branch_id:branch||null, work_date:task.work_date||null,
      event: status==='approved'?'shift_approve':'shift_reject', actor_emp:emp.emp_id, actor_name:emp.nickname||emp.name,
      actor_role:'leader', shift_id:curGroup, note:note||null }); }catch(e){}
    return { ok:true };
  }

  // ---------- งานที่ ผจก.ตีกลับมาให้ "ฉัน" แก้ (อาจเป็นงานที่ฉันเป็นคนตรวจผ่าน ไม่ใช่คนส่ง) ----------
  async function getMyFixTasks(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const { data } = await sb.from('task_assignments').select('*')
      .eq('fix_emp', emp.emp_id).eq('status','sent_back').is('fix_done_at', null)
      .order('work_date',{ascending:false}).limit(50);
    const rows=data||[];
    const shIds=[...new Set(rows.map(r=>r.shift_id).concat(rows.map(r=>r.fix_shift_id)).filter(Boolean))];
    let shName={};
    if(shIds.length){ const {data:sh}=await sb.from('shifts').select('shift_id,name').in('shift_id',shIds); (sh||[]).forEach(s=>{ shName[s.shift_id]=s.name||s.shift_id; }); }
    // จำนวนรูปขั้นต่ำของงานนั้น (หน้าเว็บจะได้เตือนก่อนกดส่ง แทนที่จะโดนเด้งตอนส่ง)
    const defIds=[...new Set(rows.map(r=>r.task_def_id).filter(Boolean))];
    let minP={};
    if(defIds.length){ const {data:df}=await sb.from('task_defs').select('id,min_photos').in('id',defIds); (df||[]).forEach(d=>{ minP[d.id]=d.min_photos||0; }); }
    return { emp, rows: rows.map(r=>({
      ...r,
      shift_name: shName[r.shift_id]||r.shift_id||'',
      fix_shift_name: shName[r.fix_shift_id]||r.fix_shift_id||'',
      min_photos: minP[r.task_def_id]||0,
      i_was_checker: r.checked_by_emp===emp.emp_id && r.emp_id!==emp.emp_id,   // ฉันเป็นคนตรวจผ่าน → ฉันต้องแก้
    })) };
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

  // ---------- SPECIAL TASKS (งานพิเศษจาก HR — แสดงในหน้า "งานของฉัน") ----------
  async function getSpecialTasks(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const { data: asg } = await sb.from('special_task_assignees').select('*').eq('emp_id', empId).order('id', { ascending:false });
    if(!asg || !asg.length) return { emp, rows:[] };
    const ids=[...new Set(asg.map(a=>a.task_id))];
    const { data: tasks } = await sb.from('special_tasks').select('*').in('id', ids);
    const tById={}; (tasks||[]).forEach(t=>{ tById[t.id]=t; });
    const rows = asg.filter(a=>{ const t=tById[a.task_id]; return t && t.active!==false; }).map(a=>{
      const t=tById[a.task_id];
      return {
        id:a.id, task_id:a.task_id, title:t.title, detail:t.detail, deadline:t.deadline,
        hr_photos:t.hr_photos||[], hr_note:t.hr_note,
        status:a.status, photos:a.photos||[], emp_note:a.emp_note,
        review_note:a.review_note, review_markup:a.review_markup||null, reviewer:a.reviewer, submitted_at:a.submitted_at,
      };
    });
    return { emp, rows };
  }
  async function submitSpecialTask({ assignee_id, empId, photos, note }){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const a=(await sb.from('special_task_assignees').select('id,emp_id,task_id,status').eq('id',assignee_id).maybeSingle()).data;
    if(!a) throw new Error('ไม่พบงานนี้');
    if(a.emp_id!==empId) throw new Error('ไม่ใช่งานของคุณ');
    const urls=[];
    for(const p of (photos||[])){ if(p) urls.push(await uploadPhoto('employee-docs','special/'+(emp.branch_id||'x')+'_'+a.task_id+'_'+empId+'_'+Date.now()+'_'+urls.length+'.jpg', p)); }
    const upd={ status:'submitted', emp_note:note||null, submitted_at:new Date().toISOString(), reviewer:null, review_note:null, review_markup:null, reviewed_at:null, submit_notified:false };
    if(urls.length){ upd.photos=urls; }
    const {error}=await sb.from('special_task_assignees').update(upd).eq('id',assignee_id); if(error) throw error;
    return { ok:true };
  }

  // ---------- งานที่ ผจก. มอบหมายให้พนักงาน (mgr_tasks.assignee_emp) ----------
  async function getMyMgrTasks(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const { data } = await sb.from('mgr_tasks').select('*')
      .eq('assignee_emp', empId).neq('status','done')
      .order('updated_at',{ ascending:false }).limit(60);
    const rows=(data||[]).map(t=>({
      id:t.id, title:t.title, detail:t.detail||'', priority:t.priority||'normal',
      due_date:t.due_date, status:t.status, hr_photos:t.hr_photos||[],
      emp_photos:t.emp_photos||[], emp_note:t.emp_note||'', emp_submitted_at:t.emp_submitted_at||null,
    }));
    return { emp, rows };
  }
  async function submitMgrTaskByEmp({ task_id, empId, photos, note }){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const t=(await sb.from('mgr_tasks').select('id,assignee_emp,status,branch_id').eq('id',task_id).maybeSingle()).data;
    if(!t) throw new Error('ไม่พบงานนี้');
    if(t.assignee_emp!==empId) throw new Error('งานนี้ไม่ได้มอบหมายให้คุณ');
    const msg=(note||'').trim();
    const urls=[];
    for(const p of (photos||[])){ if(p) urls.push(await uploadPhoto('employee-docs','mtask/emp/'+(t.branch_id||'x')+'_'+task_id+'_'+empId+'_'+Date.now()+'_'+urls.length+'.jpg', p)); }
    if(!urls.length && !msg) throw new Error('กรุณาแนบรูปหรือพิมพ์หมายเหตุ');
    // 1) เข้าไทม์ไลน์งาน ผจก. (role='emp') → ผจก./HR เห็นแบบเรียลไทม์
    const who=emp.nickname||emp.name||('พนง.'+empId);
    const { error:eF }=await sb.from('mgr_task_feed').insert({
      task_id, role:'emp', sender_name:who,
      message: msg||('พนักงานส่งความคืบหน้า'+(urls.length?(' · '+urls.length+' รูป'):'')),
      photos: urls.length?urls:null, kind:'progress',
    });
    if(eF) throw eF;
    // 2) อัปเดตงาน: เก็บชุดล่าสุด + ดันสถานะเป็น review ถ้ายังไม่ถึง
    const upd={ emp_submitted_at:new Date().toISOString(), emp_note:msg||null, updated_at:new Date().toISOString() };
    if(urls.length) upd.emp_photos=urls;
    if(t.status==='todo'||t.status==='doing') upd.status='review';
    const { error:eT }=await sb.from('mgr_tasks').update(upd).eq('id',task_id);
    if(eT) throw eT;
    return { ok:true };
  }

  // ---------- ผู้คุมผลัด + รับสินค้า (Goods Receiving) ----------
  async function getWarehouses(){
    const { data } = await sb.from('warehouses').select('*').eq('active',true).order('sort').order('id');
    return { rows: data||[] };
  }
  async function getShiftController(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const {workDate,branch}=await _shiftCtx(emp);
    const ctrl=(await sb.from('shift_controllers').select('*').eq('branch_id',branch||'').eq('work_date',workDate).maybeSingle()).data;
    return { emp, branch, work_date:workDate, controller:ctrl||null, is_me: !!(ctrl&&ctrl.emp_id===emp.emp_id) };
  }
  async function claimShiftController({empId}){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const {workDate,branch}=await _shiftCtx(emp);
    if(!branch) throw new Error('ยังไม่มีข้อมูลสาขา/กะของคุณวันนี้ จึงกดรับผู้คุมผลัดไม่ได้');
    const cur=(await sb.from('shift_controllers').select('*').eq('branch_id',branch).eq('work_date',workDate).maybeSingle()).data;
    if(cur){ if(cur.emp_id===emp.emp_id) return { ok:true, already:true }; throw new Error('วันนี้ '+(cur.emp_name||cur.emp_id)+' เป็นผู้คุมผลัดของสาขานี้แล้ว'); }
    const { error }=await sb.from('shift_controllers').insert({ branch_id:branch, work_date:workDate, emp_id:emp.emp_id, emp_name:emp.nickname||emp.name });
    if(error){ if(String(error.message||'').toLowerCase().includes('duplicate')) throw new Error('เพิ่งมีคนกดรับเป็นผู้คุมผลัดไปแล้ว'); throw error; }
    return { ok:true };
  }
  async function releaseShiftController({empId}){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const {workDate,branch}=await _shiftCtx(emp);
    const cur=(await sb.from('shift_controllers').select('emp_id').eq('branch_id',branch||'').eq('work_date',workDate).maybeSingle()).data;
    if(!cur) return { ok:true };
    if(cur.emp_id!==emp.emp_id) throw new Error('เฉพาะผู้คุมผลัดปัจจุบันเท่านั้นที่ปล่อยสิทธิ์ได้');
    const { error }=await sb.from('shift_controllers').delete().eq('branch_id',branch).eq('work_date',workDate); if(error) throw error;
    return { ok:true };
  }
  // ยอดคงค้างต่อคลัง (running balance) = Σลังเข้า − Σลังคืน ก่อนวันที่กำหนด
  async function _whOutstanding(branch, warehouseId, beforeDate){
    const [rcp, op] = await Promise.all([
      sb.from('goods_receipts').select('crates_in,crates_return').eq('branch_id',branch||'').eq('warehouse_id',warehouseId).lt('work_date',beforeDate),
      sb.from('goods_opening').select('opening').eq('branch_id',branch||'').eq('warehouse_id',warehouseId).maybeSingle(),
    ]);
    let bal=(op.data&&op.data.opening)||0;   // ยอดคงค้างตั้งต้น + Σ(ลังเข้า − ลังคืน) ก่อนวันที่กำหนด
    (rcp.data||[]).forEach(r=>{ bal += (r.crates_in||0) - (r.crates_return||0); });
    return bal;
  }
  async function getGoodsReceiving(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const {workDate,branch}=await _shiftCtx(emp);
    const [whR, todayR]=await Promise.all([
      sb.from('warehouses').select('*').eq('active',true).order('sort').order('id'),
      sb.from('goods_receipts').select('*').eq('branch_id',branch||'').eq('work_date',workDate).order('submitted_at',{ascending:false}),
    ]);
    const warehouses=whR.data||[]; const today=todayR.data||[];
    const outstanding={};
    for(const w of warehouses){ outstanding[w.id]=await _whOutstanding(branch, w.id, workDate); }
    return { emp, branch, work_date:workDate, warehouses, outstanding, today };
  }
  async function submitGoodsReceipt({ empId, id, warehouse_id, ref_no, crates_in, crates_return, in_photos, note }){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const {workDate,branch}=await _shiftCtx(emp);
    const ctrl=(await sb.from('shift_controllers').select('emp_id').eq('branch_id',branch||'').eq('work_date',workDate).maybeSingle()).data;
    if(!ctrl||ctrl.emp_id!==emp.emp_id) throw new Error('เฉพาะผู้คุมผลัดของสาขาวันนี้เท่านั้นที่บันทึกรับสินค้าได้');
    if(!warehouse_id) throw new Error('เลือกคลังก่อน');
    const ref=String(ref_no||'').trim();
    if(!/^\d{6}$/.test(ref)) throw new Error('เลขรันต้องเป็นตัวเลข 6 หลัก');
    const wh=(await sb.from('warehouses').select('code,name').eq('id',warehouse_id).maybeSingle()).data;
    const cin=Math.max(0, parseInt(crates_in)||0);
    const cret=Math.max(0, parseInt(crates_return)||0);
    const expected=await _whOutstanding(branch, warehouse_id, workDate);
    const diff=cret - expected;
    const urls=[];
    for(const p of (in_photos||[])){ if(!p) continue; if(typeof p==='string'&&/^https?:/i.test(p)) urls.push(p); else urls.push(await uploadPhoto('employee-docs','goods/'+(branch||'x')+'_'+warehouse_id+'_'+Date.now()+'_'+urls.length+'.jpg', p)); }
    const row={ ref_no:ref, branch_id:branch, work_date:workDate, warehouse_id, warehouse_code:(wh&&wh.code)||null, warehouse_name:(wh&&wh.name)||null,
      crates_in:cin, crates_return:cret, return_expected:expected, diff, in_photos:urls.length?urls:null, note:(note||'').trim()||null,
      done_by:emp.emp_id, done_name:emp.nickname||emp.name, updated_at:new Date().toISOString(), line_notified:false };
    let rid=id;
    if(id){ const {error}=await sb.from('goods_receipts').update(row).eq('id',id); if(error) throw error; }
    else { const {data,error}=await sb.from('goods_receipts').insert(row).select('id').single(); if(error) throw error; rid=data&&data.id; }
    // ยิง Flex เข้ากลุ่ม LINE ของสาขา (fire-and-forget · edge function กันซ้ำด้วย line_notified)
    try{ const base=String((window.SUPABASE_CONFIG||{}).url||'').replace(/\/$/,''); if(base&&rid) fetch(base+'/functions/v1/line-goods-notify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:rid})}); }catch(e){}
    return { ok:true, id:rid };
  }

  // ---------- QA สินค้าใกล้หมดอายุ (พนักงานบันทึก/ดู + ระบบจำบาร์โค้ด) ----------
  function _addDaysStr(s, n){ return new Date(new Date(s+'T00:00:00Z').getTime()+n*86400000).toISOString().slice(0,10); }
  async function getQaFolders(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const { data: asg } = await sb.from('qa_folder_assignees').select('folder_id').eq('emp_id', empId);
    const ids=[...new Set((asg||[]).map(a=>a.folder_id))];
    if(!ids.length) return { emp, rows:[] };
    const [fR, itR] = await Promise.all([
      sb.from('qa_folders').select('*').in('id', ids).eq('active', true).order('created_at', { ascending:false }),
      sb.from('qa_items').select('folder_id,status,expiry_date').in('folder_id', ids),
    ]);
    const today=bangkokDate(); const soon=_addDaysStr(today, 30);
    const cnt={};
    (itR.data||[]).forEach(i=>{ const o=cnt[i.folder_id]=cnt[i.folder_id]||{ total:0, on_shelf:0, expiring:0 }; o.total++; if(i.status==='on_shelf'){ o.on_shelf++; if(i.expiry_date&&i.expiry_date>=today&&i.expiry_date<=soon) o.expiring++; } });
    const rows=(fR.data||[]).map(f=>({ ...f, stats: cnt[f.id]||{ total:0, on_shelf:0, expiring:0 } }));
    return { emp, rows };
  }
  async function getQaItems(folderId){
    const { data } = await sb.from('qa_items').select('*').eq('folder_id', folderId).order('expiry_date', { ascending:true });
    return { rows: data||[] };
  }
  async function qaLookupProduct(barcode){
    if(!barcode) return null;
    const { data } = await sb.from('qa_products').select('name,size').eq('barcode', String(barcode).trim()).maybeSingle();
    return data||null;
  }
  async function qaAddItem({ folder_id, empId, barcode, name, size, qty, expiry_date, zone, photos, status }){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    if(!name||!String(name).trim()) throw new Error('กรอกชื่อสินค้า');
    if(!expiry_date) throw new Error('เลือกวันหมดอายุ');
    const st=['on_shelf','sold','removed'].includes(status)?status:'on_shelf';
    if(st==='removed'&&!(photos&&photos.length)) throw new Error('การเก็บออกต้องแนบรูปหลักฐานอย่างน้อย 1 รูป');
    const urls=[];
    for(const p of (photos||[])){ if(p) urls.push(await uploadPhoto('employee-docs','qa/'+(emp.branch_id||'x')+'_'+folder_id+'_'+Date.now()+'_'+urls.length+'.jpg', p)); }
    const bc=(barcode||'').trim()||null;
    const row={ folder_id, barcode:bc, name:String(name).trim(), size:(size||'').trim()||null, qty: parseInt(qty)>0?parseInt(qty):1, expiry_date, zone:(zone||'').trim()||null, photos:urls, status:st, branch_id:emp.branch_id||null, emp_id:emp.emp_id, emp_name:emp.nickname||emp.name };
    const { error }=await sb.from('qa_items').insert(row); if(error) throw error;
    if(bc){ try{ await sb.from('qa_products').upsert({ barcode:bc, name:row.name, size:row.size, updated_at:new Date().toISOString() }, { onConflict:'barcode' }); }catch(e){} }
    return { ok:true };
  }
  async function qaUpdateItemStatus({ item_id, empId, status }){
    if(!['on_shelf','sold','removed'].includes(status)) throw new Error('สถานะไม่ถูกต้อง');
    const { error }=await sb.from('qa_items').update({ status, updated_at:new Date().toISOString() }).eq('id', item_id);
    if(error) throw error; return { ok:true };
  }
  // พนักงานที่ได้รับมอบหมายเชลฟ์ สร้างโฟลเดอร์ QA เองได้ (เดือนปัจจุบัน)
  async function qaCreateFolder({ empId, title, target_month, note }){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const month=(target_month||bangkokDate().slice(0,7));
    // ต้องมีสิทธิ์: ได้รับมอบหมายเชลฟ์อย่างน้อย 1 รายการในเดือนนี้
    const { data: asg }=await sb.from('shelf_assignments').select('id').eq('emp_id', empId).eq('month', month).limit(1);
    if(!asg||!asg.length) throw new Error('ยังไม่ได้รับมอบหมายเชลฟ์ในเดือนนี้ จึงยังสร้างโฟลเดอร์ไม่ได้');
    const t=(title||('QA เชลฟ์ '+month)).trim();
    const { data: folder, error }=await sb.from('qa_folders').insert({ title:t, target_month:month, note:(note||'').trim()||null, created_by:(emp.nickname||emp.name||'พนักงาน'), active:true }).select('id').single();
    if(error) throw error;
    const { error:e2 }=await sb.from('qa_folder_assignees').insert({ folder_id:folder.id, emp_id:emp.emp_id, branch_id:emp.branch_id||null });
    if(e2) throw e2;
    return { ok:true, id:folder.id };
  }

  // ---------- งานพิเศษ: ดูแลเชลฟ์ประจำเดือน (พนักงาน) ----------
  async function getMyShelves(empId){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    const month=bangkokDate().slice(0,7); const today=bangkokDate();
    const { data: asg }=await sb.from('shelf_assignments').select('*').eq('emp_id', empId).eq('month', month);
    const rowsA=asg||[]; if(!rowsA.length) return { emp, month, rows:[] };
    const ids=[...new Set(rowsA.map(a=>a.shelf_id))];
    const [shR, ckR]=await Promise.all([
      sb.from('shelves').select('*').in('id', ids),
      sb.from('shelf_checks').select('*').eq('emp_id', empId).eq('check_date', today).in('shelf_id', ids),
    ]);
    const shBy={}; (shR.data||[]).forEach(s=>{ shBy[s.id]=s; });
    const ckBy={}; (ckR.data||[]).forEach(c=>{ ckBy[c.shelf_id]=c; });
    const DEF_CL=['ทำความสะอาดเชลฟ์เรียบร้อย','จัดเรียงสินค้าหน้าตรง เต็มชั้น','FIFO — สินค้าตรงป้ายราคา','ตรวจวันหมดอายุครบทุกแถว'];
    const rows=rowsA.map(a=>{ const s=shBy[a.shelf_id]||{}; const cl=(Array.isArray(s.checklist)&&s.checklist.length)?s.checklist:DEF_CL; return {
      assignment_id:a.id, shelf_id:a.shelf_id, shelf_code:s.shelf_code||'', name:s.name||('#'+a.shelf_id),
      branch_id:a.branch_id||s.branch_id||null, detail:a.detail||'', checklist:cl, today_check:ckBy[a.shelf_id]||null };
    }).sort((x,y)=>(x.name>y.name?1:-1));
    return { emp, month, today, rows };
  }
  async function submitShelfCheck({ empId, shelf_id, items, note, photos }){
    const emp=await lookupEmployee(empId); if(!emp) throw new Error('ไม่พบรหัสพนักงานนี้');
    if(!shelf_id) throw new Error('ไม่ระบุเชลฟ์');
    const month=bangkokDate().slice(0,7); const today=bangkokDate();
    const { data: asg }=await sb.from('shelf_assignments').select('id').eq('emp_id', empId).eq('shelf_id', shelf_id).eq('month', month).limit(1);
    if(!asg||!asg.length) throw new Error('เชลฟ์นี้ไม่ได้อยู่ในความรับผิดชอบของคุณเดือนนี้');
    if(!(photos&&photos.length)) throw new Error('กรุณาแนบรูปถ่ายอย่างน้อย 1 รูป');
    const items2=(Array.isArray(items)?items:[]).map(it=>({ label:String(it.label||'').slice(0,120), done:!!it.done }));
    const urls=[];
    for(const p of (photos||[])){ if(p) urls.push(await uploadPhoto('employee-docs','shelf/'+(emp.branch_id||'x')+'_'+shelf_id+'_'+today+'_'+Date.now()+'_'+urls.length+'.jpg', p)); }
    const row={ shelf_id, emp_id:emp.emp_id, branch_id:emp.branch_id||null, check_date:today,
      items:items2, note:(note||'').trim()||null, photos:urls, updated_at:new Date().toISOString(),
      // ส่ง/ส่งใหม่ → กลับเข้าคิว "รอตรวจ" + ล้างผลรีวิวเดิม (คง sent_back_count ไว้เป็นสถิติ)
      status:'submitted', reviewer:null, review_note:null, review_markup:null, reviewed_at:null };
    const { error }=await sb.from('shelf_checks').upsert(row, { onConflict:'shelf_id,emp_id,check_date' });
    if(error) throw error;
    return { ok:true };
  }

  // export
  window.HR = { sb, loadConfig, uploadPhoto, registerFace, checkIn, checkInAdvisory, checkOut, bangkokDate, todayAttendance, selfStatus, requestLeave, myLeaves, getLeaveProposals, respondProposal, getMyNotifications, markNotificationsSeen, lookupEmployee, submitProfile, getLeaveRules, getLeaveUsage, acceptRules, getRuleAck, submitHandover, getPendingHandover, receiveHandover, reportNoHandover, getMyTasks, submitTask, getBranchTasks, reviewTask, getShiftBoard, doTaskSelf, assignColleague, leaderLogin, addShiftMember, leaderInfo, leaderConfirm, getMyAssignments, pullTask, submitTaskMulti, getPrevShiftReview, reviewPrevTask, getMyFixTasks, getHandoverReport, myStatus, acknowledgeStatus, getAnnouncements, getPendingAnnouncements, getImageAnnouncements, markAnnouncementOpened, ackAnnouncement, getPendingDiscAcks, ackDiscAction, getSpecialTasks, submitSpecialTask, getMyMgrTasks, submitMgrTaskByEmp, getWarehouses, getShiftController, claimShiftController, releaseShiftController, getGoodsReceiving, submitGoodsReceipt, getQaFolders, getQaItems, qaLookupProduct, qaAddItem, qaUpdateItemStatus, qaCreateFolder, getMyShelves, submitShelfCheck, extendShift, requestCheckoutCorrection, getCheckoutState, getPositions, getBranchesPublic, submitApplication };
})();

/* =====================================================
   JIG Inspection Dashboard — app.js  v2
   3-Level Filter (Dept → Line → JIG) + Admin Panel
   ===================================================== */
(function () {
  'use strict';

  /* ══════════════════════════════════════
     STORAGE KEYS
     — structured so migrating to Supabase/Firebase
       in Step 2 only requires swapping the load/save
       functions, nothing else changes.
  ══════════════════════════════════════ */
  const SK = {
    catalog:  'jig_catalog_v2',   // { depts, lines, jigs }
    history:  'jig_history_v2',   // array of report records
  };

  // เดือนไทยแบบย่อ ตรงกับ <option> ใน dropdown #inp-month / #hf-month เป๊ะๆ — ใช้ set ค่า default เป็นเดือนปัจจุบัน
  const TH_MONTHS_ABBR = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const currentThaiMonthAbbr = () => TH_MONTHS_ABBR[new Date().getMonth()];

  /* ══════════════════════════════════════
     SUPABASE — cloud sync (เก็บเป็นตารางแยกจริง อ่านง่ายใน Table Editor)
     ตาราง: departments, lines, jigs, checkpoints, templates, history
     กลยุทธ์: "sync ทั้งก้อน" — เวลาบันทึก จะลบของเก่าทั้งหมดในตารางที่เกี่ยวข้อง
     แล้ว insert ชุดปัจจุบันใหม่ทั้งหมด (ง่าย ตรงไปตรงมา เหมาะกับทีมขนาดเล็ก)
  ══════════════════════════════════════ */
  const SUPABASE_URL = 'https://otytpzimuyaqagvxvexf.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90eXRwemltdXlhcWFndnh2ZXhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1MTMyMDEsImV4cCI6MjEwMDA4OTIwMX0.QQVIcDkIByAgyFTHrF7AmcZ-l-HfvLnbU8jh3Vnwyjw';
  const sb = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

  /* ══════════════════════════════════════
     TELEGRAM — notification บันทึกผล
     ⚠️ ห้ามใส่ Bot Token ตรงนี้เด็ดขาด — client-side โค้ดทุกไฟล์เปิด View Source ดูได้
     ใครก็ตามที่เข้าเว็บนี้จะเห็น token ทันทีถ้าใส่ตรงนี้ (เคยเกิดปัญหานี้มาแล้ว)
     แก้โดยย้าย token ไปเก็บเป็น secret ฝั่ง Supabase Edge Function แทน
     ดู supabase/functions/send-telegram/index.ts + คำแนะนำ deploy แนบมาด้วย
  ══════════════════════════════════════ */
  const TELEGRAM_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/send-telegram`;

  let _syncing = false; // กัน realtime event ที่มาจาก push ของตัวเองไม่ให้ re-render วนซ้ำ
  const _pushTimers = {};
  
  /* ══════════════════════════════════════
     🔧 FIX: Global flags to prevent event listener memory leak
     ────────────────────────────────────── */
  let _editHandlerAttached = false;
  let _deleteHandlerAttached = false;

  function debouncedPush(key, fn) {
    clearTimeout(_pushTimers[key]);
    _pushTimers[key] = setTimeout(fn, 500);
  }

  function flattenCheckpoints(jigs) {
    const rows = [];
    (jigs || []).forEach(j => {
      (j.checkpoints || []).forEach(cp => {
        rows.push({ 
          jig_id: j.id, 
          item_id: cp.id, 
          label: cp.label, 
          sub: cp.sub, 
          method: cp.method, 
          x: cp.x, 
          y: cp.y,
          type: cp.type || null,
          min: cp.min ?? null,
          max: cp.max ?? null,
          unit: cp.unit || null
        });
      });
    });
    return rows;
  }

  // ── ส่ง Catalog ขึ้น Supabase (แยกเป็น 5 ตารางจริง) ──
  // ✅ SAFE: ใช้ UPSERT แทน DELETE ป้องกันข้อมูลหาย
  async function pushCatalogToSupabase(cat) {
    if (!sb) return;
    _syncing = true;
    try {
      // ✅ SAFE: ใช้ upsert แทน delete - ถ้า ID มี update, ถ้าไม่มี insert
      if (cat.depts?.length) {
        const { error } = await sb.from('departments').upsert(
          cat.depts.map(d => ({ id: d.id, name: d.name })),
          { onConflict: 'id' }
        );
        if (error) throw error;
      }
      if (cat.lines?.length) {
        const { error } = await sb.from('lines').upsert(
          cat.lines.map(l => ({ id: l.id, dept_id: l.deptId, name: l.name })),
          { onConflict: 'id' }
        );
        if (error) throw error;
      }
      if (cat.jigs?.length) {
        const { error } = await sb.from('jigs').upsert(
          cat.jigs.map(j => ({
            id: j.id, line_id: j.lineId, name: j.name, doc_no: j.docNo || j.id, bg_image: j.bgImage || null
          })),
          { onConflict: 'id' }
        );
        if (error) throw error;
        const cpRows = flattenCheckpoints(cat.jigs);
        if (cpRows.length) {
          const { error: cpErr } = await sb.from('checkpoints').upsert(cpRows, { onConflict: 'jig_id,item_id' });
          if (cpErr) throw cpErr;
        }
      }
      if (cat.templates?.length) {
        const { error } = await sb.from('templates').upsert(
          cat.templates.map(t => ({ id: t.id, name: t.name, items: t.items || [] })),
          { onConflict: 'id' }
        );
        if (error) throw error;
      }
    } catch (e) {
      console.error('pushCatalogToSupabase error:', e);
    } finally {
      // 1500ms กันชน: เผื่อเวลาให้ realtime event ของ "การเขียนของเราเอง" มาถึงและถูกเพิกเฉย
      // ก่อนหน้านี้ใช้ 300ms ซึ่งสั้นเกินไปเมื่อ catalog มีหลายตาราง/หลายแถว ทำให้บางครั้ง
      // refreshCatalog() ทำงานแทรกกลางคันตอนผู้ใช้กำลังแก้ไข Admin Panel อยู่
      setTimeout(() => { _syncing = false; }, 1500);
    }
  }

  // ── ดึง Catalog จาก Supabase กลับมาประกอบเป็น object เดิม ──
  async function pullCatalogFromSupabase() {
    if (!sb) return null;
    try {
      const [d, l, j, c, t] = await Promise.all([
        sb.from('departments').select('*'),
        sb.from('lines').select('*'),
        sb.from('jigs').select('*'),
        sb.from('checkpoints').select('*'),
        sb.from('templates').select('*'),
      ]);
      const err = d.error || l.error || j.error || c.error || t.error;
      if (err) throw err;

      const cpByJig = {};
      (c.data || []).forEach(row => {
        if (!cpByJig[row.jig_id]) cpByJig[row.jig_id] = [];
        cpByJig[row.jig_id].push({ 
          id: row.item_id, 
          label: row.label, 
          sub: row.sub, 
          method: row.method, 
          x: row.x, 
          y: row.y,
          type: row.type || undefined,
          min: row.min || undefined,
          max: row.max || undefined,
          unit: row.unit || undefined
        });
      });
      const jigs = (j.data || []).map(row => ({
        id: row.id, lineId: row.line_id, name: row.name, docNo: row.doc_no,
        bgImage: row.bg_image || undefined,
        checkpoints: (cpByJig[row.id] || []).sort((a, b) => a.id - b.id),
      }));
      const depts = (d.data || []).map(row => ({ id: row.id, name: row.name }));
      const lines = (l.data || []).map(row => ({ id: row.id, deptId: row.dept_id, name: row.name }));
      const templates = (t.data || []).map(row => ({ id: row.id, name: row.name, items: row.items || [] }));

      if (!depts.length && !jigs.length) return null; // ยังไม่เคย sync ขึ้นเลย — ใช้ข้อมูล local ต่อไป
      return { depts, lines, jigs, templates };
    } catch (e) {
      console.warn('pullCatalogFromSupabase error (ใช้ข้อมูล local แทน):', e);
      return null;
    }
  }

  // ── ส่ง History ขึ้น Supabase (ตาราง history จริง 1 แถวต่อ 1 รายการตรวจ) ──
  // ⚠️ แก้บั๊ก (2026-07-25): เดิมใช้ "delete ทั้งตาราง แล้ว insert ใหม่หมด" ซึ่งพัง
  // เพราะ local เก็บแค่ history ล่าสุด 100 รายการ (ดู submitReport) — ทุกครั้งที่มีคน
  // บันทึก/ลบรายการจากเครื่องที่มี local cache ไม่ครบ จะไปลบของเก่าที่เกิน 100 ทิ้งถาวร
  // จาก Supabase ด้วย! เปลี่ยนมาใช้ upsert แทน เพื่อไม่ให้แถวอื่นที่ไม่ได้ส่งมาถูกลบ
  async function pushHistoryToSupabase(arr) {
    if (!sb) return;
    _syncing = true;
    try {
      const rows = (arr || []).map(h => ({
        id: h.id, ts: h.timestamp,
        dept_id: h.deptId, dept_name: h.deptName,
        line_id: h.lineId, line_name: h.lineName,
        jig_id: h.jigId, jig_name: h.jigName, jig_doc_no: h.jigDocNo,
        insp_date: h.date, shift: h.shift, month: h.month,
        inspector: h.inspector, notes: h.notes, items: h.items || [],
        sig_inspector: h.sigInspector, sig_supervisor: h.sigSupervisor,
        // ─── GPS Data ───
        gps_latitude: h.gps?.latitude || null,
        gps_longitude: h.gps?.longitude || null,
        gps_accuracy: h.gps?.accuracy || null,
        gps_timestamp: h.gps?.timestamp || null,
        gps_status: h.gps?.status || 'unknown',
      }));
      // แบ่งส่งเป็นชุดๆ (มีรูปถ่าย base64 อยู่ในนั้น ก้อนใหญ่ได้) กันพัง request เดียวโตเกินไป
      // upsert ตาม id — แถวที่มีอยู่แล้วจะถูกอัปเดตทับ ส่วนแถวอื่นในตารางที่ไม่ได้ส่งมาจะไม่ถูกแตะต้อง
      for (let i = 0; i < rows.length; i += 40) {
        const { error } = await sb.from('history').upsert(rows.slice(i, i + 40), { onConflict: 'id' });
        if (error) throw error;
      }
    } catch (e) {
      console.error('pushHistoryToSupabase error:', e);
    } finally {
      setTimeout(() => { _syncing = false; }, 1500);
    }
  }

  // ── ลบ history รายการเดียวออกจาก Supabase (ใช้ตอนกดลบใน History Panel) ──
  async function deleteHistoryFromSupabase(id) {
    if (!sb) return;
    _syncing = true;
    try {
      const { error } = await sb.from('history').delete().eq('id', id);
      if (error) throw error;
    } catch (e) {
      console.error('deleteHistoryFromSupabase error:', e);
    } finally {
      setTimeout(() => { _syncing = false; }, 1500);
    }
  }

  // ── ดึง History จาก Supabase กลับมาเป็น array เดิม ──
  async function pullHistoryFromSupabase() {
    if (!sb) return null;
    try {
      const { data, error } = await sb.from('history').select('*').order('ts', { ascending: false });
      if (error) throw error;
      if (!data || !data.length) return null;
      return data.map(row => ({
        id: row.id, timestamp: row.ts,
        deptId: row.dept_id, deptName: row.dept_name,
        lineId: row.line_id, lineName: row.line_name,
        jigId: row.jig_id, jigName: row.jig_name, jigDocNo: row.jig_doc_no,
        date: row.insp_date, shift: row.shift, month: row.month,
        inspector: row.inspector, notes: row.notes, items: row.items || [],
        sigInspector: row.sig_inspector, sigSupervisor: row.sig_supervisor,
        // ─── GPS Data ───
        gps: row.gps_latitude ? {
          latitude: row.gps_latitude,
          longitude: row.gps_longitude,
          accuracy: row.gps_accuracy,
          timestamp: row.gps_timestamp,
          status: row.gps_status || 'unknown'
        } : undefined,
      }));
    } catch (e) {
      console.warn('pullHistoryFromSupabase error (ใช้ข้อมูล local แทน):', e);
      return null;
    }
  }

  // ฟังการเปลี่ยนแปลง realtime จากเพื่อนร่วมทีมคนอื่น แล้วรีเฟรชหน้าจอให้อัตโนมัติ
  function subscribeRealtime() {
    if (!sb) return;
    let catalogTimer, historyTimer;

    async function refreshCatalog() {
      if (_syncing) return;
      const remote = await pullCatalogFromSupabase();
      if (remote) {
        localStorage.setItem(SK.catalog, JSON.stringify(remote));
        loadCatalog();
        renderFilter();
        if (typeof renderAdminLists === 'function') renderAdminLists();
        toast('📥 Catalog อัปเดตจากทีม', 'ok');
      }
    }
    async function refreshHistory() {
      if (_syncing) return;
      const remote = await pullHistoryFromSupabase();
      if (remote) {
        localStorage.setItem(SK.history, JSON.stringify(remote));
        if (typeof populateHistoryPanel === 'function') populateHistoryPanel();
        if (typeof refreshDashboard === 'function') refreshDashboard();
        toast('📥 มีข้อมูลตรวจสอบใหม่จากทีม', 'ok');
      }
    }

    const ch = sb.channel('db_changes');
    ['departments', 'lines', 'jigs', 'checkpoints', 'templates'].forEach(tbl => {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: tbl }, () => {
        clearTimeout(catalogTimer);
        catalogTimer = setTimeout(refreshCatalog, 700);
      });
    });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'history' }, () => {
      clearTimeout(historyTimer);
      historyTimer = setTimeout(refreshHistory, 700);
    });
    ch.subscribe();
  }

  /* ══════════════════════════════════════
     GLOBAL WRAPPER FUNCTIONS (accessible from importAllData)
     These check if Supabase functions exist before calling
  ══════════════════════════════════════ */
  async function refreshCatalogGlobal() {
    loadCatalog();
    renderFilter();
    if (typeof renderAdminLists === 'function') renderAdminLists();
    toast('📥 Catalog อัปเดตจากระบบ', 'ok');
  }
  
  async function refreshHistoryGlobal() {
    if (typeof populateHistoryPanel === 'function') populateHistoryPanel();
    if (typeof refreshDashboard === 'function') refreshDashboard();
    toast('📥 ประวัติตรวจสอบอัปเดตจากระบบ', 'ok');
  }

  /* ══════════════════════════════════════
     DEFAULT CHECKLIST ITEMS
     (per-JIG items come from catalog in future;
      for now all JIGs share the same 10-point list)
  ══════════════════════════════════════ */
  const DEFAULT_ITEMS = [
    { id: 1, label: 'L-Pin ตรวจสอบสภาพ',        sub: 'ไม่สึกหรอ, ยึดแน่น',        method: 'ตรวจสอบด้วยสายตา / จับโยก', x: 140, y: 110 },
    { id: 2, label: 'R-Pin ตรวจสอบสภาพ',        sub: 'ไม่สึกหรอ, ยึดแน่น',        method: 'ตรวจสอบด้วยสายตา / จับโยก', x: 460, y: 110 },
    { id: 3, label: 'Clamp 01 แคลมป์หน้า',     sub: 'ทำงานปกติ, ไม่หลวม',        method: 'ทดสอบการจับยึด', x: 300, y: 120 },
    { id: 4, label: 'Clamp 02 แคลมป์หลัง',     sub: 'ทำงานปกติ, ไม่หลวม',        method: 'ทดสอบการจับยึด', x: 300, y: 220 },
    { id: 5, label: 'Support Block A',            sub: 'ตำแหน่งตรง ไม่มีรอยร้าว', method: 'ตรวจสอบด้วยสายตา', x: 200, y: 75 },
    { id: 6, label: 'Support Block B',            sub: 'ตำแหน่งตรง ไม่มีรอยร้าว', method: 'ตรวจสอบด้วยสายตา', x: 400, y: 265 },
    { id: 7, label: 'ระบบลม Pneumatic',          sub: 'ไม่รั่ว แรงดันปกติ',        method: 'ฟังเสียง / ดูเกจ', x: 520, y: 170 },
    { id: 8, label: 'Proximity Sensor',           sub: 'ตรวจจับชิ้นงานได้',         method: 'ทดสอบ Sensor', x: 300, y: 170 },
    { id: 9, label: 'Ground Cable สายดิน',       sub: 'สภาพดี ต่อแน่น',            method: 'ตรวจสอบด้วยสายตา', x: 80, y: 170 },
    { id: 10, label: 'โครงสร้าง Frame & Base',  sub: 'ไม่บิด ไม่ร้าว ระนาบปกติ', method: 'ตรวจสอบด้วยสายตา', x: 300, y: 50 },
  ];

  /* ══════════════════════════════════════
     STATE
  ══════════════════════════════════════ */

  /* ══════════════════════════════════════
     STATE
  ══════════════════════════════════════ */
  let catalog = { depts: [], lines: [], jigs: [], templates: [] };
  let selection = { deptId: null, lineId: null, jigId: null };
  let jigSearchTerm = ''; // filters the Level-3 JIG chip list
  let checkState = [];  // current inspection items
  let cpEditJigId = null; // JIG ที่กำลังแก้ไขจุดตรวจ/รูปพื้นหลังใน Admin Panel

  /* ══════════════════════════════════════
     STORAGE (localStorage — Step 1)
     Replace these 4 functions with API calls in Step 2
  ══════════════════════════════════════ */
  function loadCatalog() {
    try {
      const raw = localStorage.getItem(SK.catalog);
      if (raw) catalog = JSON.parse(raw);
    } catch (e) { catalog = { depts: [], lines: [], jigs: [], templates: [] }; }
    if (!Array.isArray(catalog.templates)) catalog.templates = []; // migration: เทมเพลตหัวข้อตรวจสอบ (ใหม่)
  }
  function saveCatalog() {
    try {
      localStorage.setItem(SK.catalog, JSON.stringify(catalog));
    } catch (e) {
      console.error('saveCatalog error:', e);
      toast('พื้นที่จัดเก็บเต็ม — รูปภาพอาจไม่ถูกบันทึก ลองลบรูปพื้นหลังบาง JIG ออก', 'ng');
    }
    debouncedPush('catalog', () => pushCatalogToSupabase(catalog));
  }

  /* ══════════════════════════════════════
     🔧 FIX: Global Event Handlers for Admin Panel (Event Delegation)
     This prevents memory leak by using event delegation instead of
     creating a new listener for each admin item.
  ══════════════════════════════════════ */
  function handleAdminEdit(e) {
    const btn = e.target.closest('.adm-item-edit');
    if (!btn) return;
    
    e.stopPropagation();
    const { etype, id } = btn.dataset;
    
    if (etype === 'dept') {
      const d = catalog.depts.find(x => x.id === id);
      if (!d) return;
      const newName = prompt('แก้ไขชื่อแผนก:', d.name);
      if (newName === null) return;
      if (!newName.trim()) { toast('ชื่อห้ามว่าง', 'ng'); return; }
      d.name = newName.trim();
    } else if (etype === 'line') {
      const l = catalog.lines.find(x => x.id === id);
      if (!l) return;
      const newName = prompt('แก้ไขชื่อ Line:', l.name);
      if (newName === null) return;
      if (!newName.trim()) { toast('ชื่อห้ามว่าง', 'ng'); return; }
      l.name = newName.trim();
    } else if (etype === 'jig') {
      const j = catalog.jigs.find(x => x.id === id);
      if (!j) return;
      const newName = prompt('แก้ไขชื่อ JIG:', j.name);
      if (newName === null) return;
      if (!newName.trim()) { toast('ชื่อห้ามว่าง', 'ng'); return; }
      const newDocNo = prompt('แก้ไขรหัส/Part No. (เว้นว่างได้):', j.docNo || '');
      if (newDocNo === null) return;
      j.name = newName.trim();
      j.docNo = newDocNo.trim();
    }
    
    saveCatalog(); renderAdminLists(); renderFilter();
    toast('แก้ไขสำเร็จ', 'ok');
  }

  // ── ลบ catalog item ออกจาก Supabase จริงๆ ──
  // ⚠️ FIX (2026-08-03): pushCatalogToSupabase() เปลี่ยนมาใช้ upsert-only เพื่อกันข้อมูล
  // history หายจากบั๊กก่อนหน้า แต่ผลข้างเคียงคือ "ลบ" ใน Admin Panel จะแค่เอาออกจาก local/
  // localStorage เท่านั้น — แถวเดิมยังค้างอยู่ใน Supabase แล้วโดน pull กลับมาทีหลัง
  // (ตอนเปิดแอปใหม่ / realtime sync) ทำให้ของที่ลบไป "เด้งกลับมา" เหมือนไม่เคยลบ
  // ฟังก์ชันนี้ลบแถวออกจาก Supabase ตรงๆ ให้คู่กับการลบ local ทุกครั้ง
  async function deleteCatalogItemFromSupabase(dtype, id) {
    if (!sb) return;
    _syncing = true;
    try {
      if (dtype === 'jig') {
        // ลบ checkpoints ของ jig นี้ก่อน (กันเหนียว เผื่อ FK cascade ยังไม่ครอบคลุม) แล้วค่อยลบตัว jig
        await sb.from('checkpoints').delete().eq('jig_id', id);
        const { error } = await sb.from('jigs').delete().eq('id', id);
        if (error) throw error;
      } else if (dtype === 'line') {
        // ลบ jig + checkpoints ทั้งหมดที่อยู่ใต้ line นี้ก่อน แล้วค่อยลบตัว line
        const { data: jigsUnder } = await sb.from('jigs').select('id').eq('line_id', id);
        const jigIds = (jigsUnder || []).map(j => j.id);
        if (jigIds.length) {
          await sb.from('checkpoints').delete().in('jig_id', jigIds);
          await sb.from('jigs').delete().in('id', jigIds);
        }
        const { error } = await sb.from('lines').delete().eq('id', id);
        if (error) throw error;
      } else if (dtype === 'dept') {
        // ลบทั้งสาย: checkpoints → jigs → lines → dept
        const { data: linesUnder } = await sb.from('lines').select('id').eq('dept_id', id);
        const lineIds = (linesUnder || []).map(l => l.id);
        if (lineIds.length) {
          const { data: jigsUnder } = await sb.from('jigs').select('id').in('line_id', lineIds);
          const jigIds = (jigsUnder || []).map(j => j.id);
          if (jigIds.length) {
            await sb.from('checkpoints').delete().in('jig_id', jigIds);
            await sb.from('jigs').delete().in('id', jigIds);
          }
          await sb.from('lines').delete().in('id', lineIds);
        }
        const { error } = await sb.from('departments').delete().eq('id', id);
        if (error) throw error;
      }
    } catch (e) {
      console.error(`deleteCatalogItemFromSupabase(${dtype}) error:`, e);
      toast('ลบออกจาก Supabase ไม่สำเร็จ อาจเด้งกลับมาใหม่: ' + (e.message || e), 'ng');
    } finally {
      setTimeout(() => { _syncing = false; }, 1500);
    }
  }

  function handleAdminDelete(e) {
    const btn = e.target.closest('.adm-item-del');
    if (!btn) return;
    
    e.stopPropagation();
    const { dtype, id } = btn.dataset;
    
    if (dtype === 'dept') {
      catalog.lines = catalog.lines.filter(l => l.deptId !== id);
      catalog.jigs  = catalog.jigs.filter(j => {
        const l = catalog.lines.find(x => x.id === j.lineId); 
        return l;
      });
      catalog.depts = catalog.depts.filter(d => d.id !== id);
    } else if (dtype === 'line') {
      catalog.jigs  = catalog.jigs.filter(j => j.lineId !== id);
      catalog.lines = catalog.lines.filter(l => l.id !== id);
    } else if (dtype === 'jig') {
      catalog.jigs = catalog.jigs.filter(j => j.id !== id);
    }
    
    saveCatalog(); renderAdminLists(); renderFilter();
    if (dtype) deleteCatalogItemFromSupabase(dtype, id); // ลบจริงบน Supabase กันเด้งกลับ
    toast('ลบสำเร็จ', 'ok');
  }

  /* ══════════════════════════════════════
     IMAGE HELPERS — ย่อขนาดรูปก่อนเก็บเป็น base64
     เพื่อไม่ให้ localStorage เต็มเร็วเกินไป
  ══════════════════════════════════════ */
  function resizeImageToDataURL(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพได้'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
      reader.readAsDataURL(file);
    });
  }
  
  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 10) / 10 + ' ' + sizes[i];
  }
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(SK.history)) || []; } catch { return []; }
  }
  function saveHistory(arr) {
    try {
      localStorage.setItem(SK.history, JSON.stringify(arr));
      debouncedPush('history', () => pushHistoryToSupabase(arr));
      return true;
    } catch (e) {
      console.error('saveHistory error:', e);
      toast('พื้นที่จัดเก็บเต็ม — บันทึกประวัติไม่สำเร็จ ลองลบประวัติเก่าหรือรูปหลักฐานบางส่วนออก', 'ng');
      return false;
    }
  }

  /* ══════════════════════════════════════
     DOM HELPERS
  ══════════════════════════════════════ */
  const $  = id => document.getElementById(id);
  const qs = (sel, parent) => (parent || document).querySelector(sel);

  // Escape any value before it's interpolated into an innerHTML template.
  // Anything that came from a user-editable field (dept/line/JIG names,
  // checkpoint labels, notes, inspector names, etc.) MUST go through this
  // before being placed in a template string — otherwise someone typing
  // e.g. `<img src=x onerror=...>` as a name would get it executed as
  // real HTML (stored XSS).
  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Generate a collision-safe unique ID for records (history entries, etc).
  // Date.now() alone can collide if two records are created within the
  // same millisecond (e.g. the mock-data generator, or fast repeat taps).
  // crypto.randomUUID() needs a secure context (https/localhost); we fall
  // back to timestamp+random for plain http on a local factory network.
  function genId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fall through to fallback */ }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /* ══════════════════════════════════════
     INIT
  ══════════════════════════════════════ */
  async function init() {
    // ─── ตรวจสอบ GPS Status ───
    await checkGPSStatusOnLoad();
    
    // ดึงข้อมูลล่าสุดจากทีมมาก่อน แล้วค่อย render (ถ้ายังไม่เคย sync ขึ้นเลยจะได้ null แล้วใช้ local ต่อ)
    const [remoteCat, remoteHist] = await Promise.all([pullCatalogFromSupabase(), pullHistoryFromSupabase()]);
    if (remoteCat) localStorage.setItem(SK.catalog, JSON.stringify(remoteCat));
    if (remoteHist) localStorage.setItem(SK.history, JSON.stringify(remoteHist));
    loadCatalog();
    $('inp-date').value = new Date().toISOString().slice(0, 10);
    $('inp-month').value = currentThaiMonthAbbr();

    renderFilter();
    bindJigSearch();
    bindThemeToggle();
    bindAdminPanel();
    bindActionButtons();
    bindLightbox();
    bindHistoryPanel();
    bindPanelOverlay();
    subscribeRealtime();
  }

  /* ══════════════════════════════════════
     3-LEVEL FILTER
  ══════════════════════════════════════ */
  function renderFilter() {
    renderDeptChips();
    renderLineChips();
    renderJigChips();
    updateBreadcrumb();
  }

  function renderDeptChips() {
    const container = $('chips-dept');
    if (!catalog.depts.length) {
      container.innerHTML = '<span class="chip-empty">ยังไม่มีแผนก — ไปที่ Admin Panel เพื่อเพิ่ม หรือกด "โหลดข้อมูลทดสอบ"</span>';
      return;
    }
    container.innerHTML = catalog.depts.map(d => {
      const lineCount = catalog.lines.filter(l => l.deptId === d.id).length;
      const jigCount  = catalog.jigs.filter(j => {
        const line = catalog.lines.find(l => l.id === j.lineId);
        return line && line.deptId === d.id;
      }).length;
      const sel = selection.deptId === d.id ? 'selected' : '';
      return `<button class="chip ${sel}" data-dept="${escHtml(d.id)}">
        ${escHtml(d.name)}
        <span class="chip-code">${escHtml(d.id)}</span>
        <span class="chip-count">${jigCount} JIG</span>
      </button>`;
    }).join('');
    container.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => selectDept(btn.dataset.dept));
    });
  }

  function renderLineChips() {
    const levelEl = $('level-line');
    const container = $('chips-line');
    if (!selection.deptId) { levelEl.classList.add('hidden'); return; }
    levelEl.classList.remove('hidden');
    const lines = catalog.lines.filter(l => l.deptId === selection.deptId);
    if (!lines.length) {
      container.innerHTML = '<span class="chip-empty">ยังไม่มี Line ในแผนกนี้</span>';
      return;
    }
    container.innerHTML = lines.map(l => {
      const jigCount = catalog.jigs.filter(j => j.lineId === l.id).length;
      const sel = selection.lineId === l.id ? 'selected' : '';
      return `<button class="chip ${sel}" data-line="${escHtml(l.id)}">
        ${escHtml(l.name)}
        <span class="chip-code">${escHtml(l.id)}</span>
        <span class="chip-count">${jigCount} JIG</span>
      </button>`;
    }).join('');
    container.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => selectLine(btn.dataset.line));
    });
  }

  function renderJigChips() {
    const levelEl = $('level-jig');
    const container = $('chips-jig');
    const banner = $('selected-banner');
    if (!selection.lineId) { levelEl.classList.add('hidden'); banner.classList.add('hidden'); return; }
    levelEl.classList.remove('hidden');
    const allJigs = catalog.jigs.filter(j => j.lineId === selection.lineId);
    if (!allJigs.length) {
      container.innerHTML = '<span class="chip-empty">ยังไม่มี JIG ใน Line นี้</span>';
      banner.classList.add('hidden');
      return;
    }

    const term = jigSearchTerm.trim().toLowerCase();
    const jigs = term
      ? allJigs.filter(j =>
          j.name.toLowerCase().includes(term) ||
          j.id.toLowerCase().includes(term) ||
          (j.docNo || '').toLowerCase().includes(term))
      : allJigs;

    if (!jigs.length) {
      container.innerHTML = `<span class="chip-empty">ไม่พบ JIG ที่ตรงกับ "${escHtml(jigSearchTerm)}"</span>`;
      banner.classList.add('hidden');
      return;
    }

    container.innerHTML = jigs.map(j => {
      const sel = selection.jigId === j.id ? 'selected' : '';
      return `<button class="chip ${sel}" data-jig="${escHtml(j.id)}">
        🔧 ${escHtml(j.name)}
        <span class="chip-code">${escHtml(j.id)}</span>
      </button>`;
    }).join('');
    container.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => selectJig(btn.dataset.jig));
    });

    // Update banner
    if (selection.jigId) {
      const jig  = catalog.jigs.find(j => j.id === selection.jigId);
      const line = catalog.lines.find(l => l.id === selection.lineId);
      const dept = catalog.depts.find(d => d.id === selection.deptId);
      if (jig) {
        $('sb-jig-name').textContent = `${jig.name}`;
        $('sb-jig-meta').textContent = `${jig.docNo || jig.id}  ·  ${dept ? dept.name : ''}  >  ${line ? line.name : ''}`;
        banner.classList.remove('hidden');
        $('svg-jig-label').textContent = `${jig.name} — ${jig.docNo || jig.id}`;
        $('header-sub').textContent = `${jig.docNo || jig.id}  ·  ${dept ? dept.name : ''}  /  ${line ? line.name : ''}`;
      }
    } else {
      banner.classList.add('hidden');
    }
  }

  function bindJigSearch() {
    const input = $('jig-search');
    const clearBtn = $('jig-search-clear');
    input.addEventListener('input', () => {
      jigSearchTerm = input.value;
      clearBtn.classList.toggle('hidden', !jigSearchTerm);
      renderJigChips();
    });
    clearBtn.addEventListener('click', () => {
      input.value = '';
      resetJigSearch();
      renderJigChips();
      input.focus();
    });
  }

  function resetJigSearch() {
    jigSearchTerm = '';
    const input = $('jig-search');
    const clearBtn = $('jig-search-clear');
    if (input) input.value = '';
    if (clearBtn) clearBtn.classList.add('hidden');
  }

  /* ── Selection handlers ── */
  function selectDept(id) {
    if (selection.deptId === id) {
      selection = { deptId: null, lineId: null, jigId: null };
    } else {
      selection = { deptId: id, lineId: null, jigId: null };
    }
    resetJigSearch();
    hideInspectionCards();
    renderFilter();
  }

  function selectLine(id) {
    if (selection.lineId === id) {
      selection.lineId = null; selection.jigId = null;
    } else {
      selection.lineId = id; selection.jigId = null;
    }
    resetJigSearch();
    hideInspectionCards();
    renderFilter();
  }

  function selectJig(id) {
    if (selection.jigId === id) return;
    selection.jigId = id;
    renderFilter();
    showInspectionCards();
  }

  function updateBreadcrumb() {
    const bc = $('breadcrumb');
    let parts = [{ label: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> เริ่มต้น', level: 0 }];
    if (selection.deptId) {
      const d = catalog.depts.find(x => x.id === selection.deptId);
      if (d) parts.push({ label: escHtml(d.name), level: 1 });
    }
    if (selection.lineId) {
      const l = catalog.lines.find(x => x.id === selection.lineId);
      if (l) parts.push({ label: escHtml(l.name), level: 2 });
    }
    if (selection.jigId) {
      const j = catalog.jigs.find(x => x.id === selection.jigId);
      if (j) parts.push({ label: escHtml(j.name), level: 3 });
    }
    bc.innerHTML = parts.map((p, i) => {
      const active = i === parts.length - 1 ? 'active' : '';
      const sep = i < parts.length - 1 ? '<span class="bc-sep">›</span>' : '';
      return `<span class="bc-item ${active}" data-level="${p.level}">${p.label}</span>${sep}`;
    }).join('');

    bc.querySelectorAll('.bc-item').forEach(el => {
      el.addEventListener('click', () => {
        const lv = parseInt(el.dataset.level);
        if (lv === 0) { selection = { deptId: null, lineId: null, jigId: null }; }
        else if (lv === 1) { selection.lineId = null; selection.jigId = null; }
        else if (lv === 2) { selection.jigId = null; }
        hideInspectionCards();
        renderFilter();
      });
    });
  }

  /* ── Show / hide inspection section ── */
  function showInspectionCards() {
    ['meta-card','map-card','checklist-card','notes-card','sig-card','action-row']
      .forEach(id => $(id).classList.remove('hidden'));
    initCheckState();
    renderChecklist();
    updateStats();
    $(  'meta-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function hideInspectionCards() {
    ['meta-card','map-card','checklist-card','notes-card','sig-card','action-row']
      .forEach(id => $(id).classList.add('hidden'));
  }

  /* ── Reset check state ── */
  function getActiveCheckpoints() {
    const jig = catalog.jigs.find(j => j.id === selection.jigId);
    return (jig && jig.checkpoints && jig.checkpoints.length) ? jig.checkpoints : DEFAULT_ITEMS;
  }

  function initCheckState() {
    const pts = getActiveCheckpoints();
    checkState = pts.map(i => ({
      id: i.id, label: i.label, sub: i.sub, method: i.method,
      status: '', note: '', photos: [],
      type: i.type || null, min: i.min, max: i.max, unit: i.unit, value: null,
    }));
    renderSvgMap();
  }

  /* ── วาดแผนผัง: รูปพื้นหลัง (ถ้ามี) + จุดตรวจสอบตาม JIG ที่เลือก ── */
  function renderSvgMap() {
    const jig = catalog.jigs.find(j => j.id === selection.jigId);
    const bgImg = $('svg-bg-image');
    const defaultDrawing = $('svg-default-drawing');
    if (jig && jig.bgImage) {
      bgImg.setAttribute('href', jig.bgImage);
      bgImg.style.display = '';
      defaultDrawing.style.display = 'none';
    } else {
      bgImg.style.display = 'none';
      defaultDrawing.style.display = '';
    }
    const pts = getActiveCheckpoints();
    $('svg-points-group').innerHTML = pts.map((p, i) => `
      <g class="svg-pt" data-point="${p.id}" transform="translate(${p.x},${p.y})">
        <circle class="pt-pulse" r="14"/><circle class="pt-core" r="8"/><text y="4" class="pt-label">${i + 1}</text>
      </g>`).join('');
  }

  /* ══════════════════════════════════════
     CHECKLIST
  ══════════════════════════════════════ */
  function renderChecklist() {
    const wrap = $('checklist-wrapper');
    wrap.innerHTML = '';
    checkState.forEach((item, idx) => {
      const isNumeric = item.type === 'numeric';
      const div = document.createElement('div');
      div.className = 'check-item';
      div.dataset.idx = idx;
      div.innerHTML = `
        <div class="check-row">
          <span class="check-num">${idx + 1}</span>
          <div class="check-label">
            ${escHtml(item.label)}
            <small>${escHtml(item.sub)} — ${escHtml(item.method)}</small>
            ${isNumeric ? `
              <div class="check-numeric-row">
                <input type="number" step="any" inputmode="decimal" class="check-numeric-input" id="numval-${idx}" placeholder="กรอกค่า">
                <span class="check-numeric-unit">${escHtml(item.unit || '')}</span>
                <span class="check-numeric-range">(เกณฑ์ ${item.min}-${item.max}${item.unit ? ' ' + escHtml(item.unit) : ''})</span>
              </div>` : ''}
          </div>
          <div class="radio-group">
            <button class="rbtn ok" data-v="ok" title="ปกติ">✔</button>
            <button class="rbtn ng" data-v="ng" title="ไม่ปกติ">✖</button>
            <button class="rbtn fixed" data-v="fixed" title="แก้ไขแล้ว">🔧</button>
          </div>
        </div>
        <div class="ng-zone" id="ng-zone-${idx}">
          <div class="ng-zone-title">⚠ รายละเอียดความผิดปกติ</div>
          <textarea class="ng-note-input" id="ng-note-${idx}" placeholder="ระบุรายละเอียด..."></textarea>
          <div class="photo-row" id="photo-row-${idx}">
            <label class="btn-camera">
              <input type="file" accept="image/*" capture="environment" class="file-input" data-idx="${idx}">
              📷 ถ่ายรูป / เลือกรูป
            </label>
          </div>
        </div>`;
      wrap.appendChild(div);

      function setStatus(v) {
        checkState[idx].status = v;
        div.querySelectorAll('.rbtn').forEach(b => b.classList.toggle('active', b.dataset.v === v));
        const zone = $(`ng-zone-${idx}`);
        zone.classList.toggle('show', v === 'ng' || v === 'fixed');
        updateSvgPoint(item.id, v);
        updateStats();
      }

      div.querySelectorAll('.rbtn').forEach(btn => {
        btn.addEventListener('click', () => setStatus(btn.dataset.v));
      });

      // หัวข้อกรอกค่าตัวเลข: กรอกค่าแล้วระบบตัดสิน ผ่าน/ไม่ผ่าน อัตโนมัติจากช่วงเกณฑ์ที่ตั้งไว้
      // (ยังสามารถกดปุ่ม 🔧 "แก้ไขแล้ว" ทับได้ภายหลัง ถ้าแก้ไขปัญหาแล้วแต่ค่าที่วัดยังไม่อยู่ในช่วง)
      if (isNumeric) {
        $(`numval-${idx}`).addEventListener('input', e => {
          const raw = e.target.value;
          if (raw === '') {
            checkState[idx].value = null;
            checkState[idx].status = '';
            div.querySelectorAll('.rbtn').forEach(b => b.classList.remove('active'));
            $(`ng-zone-${idx}`).classList.remove('show');
            updateSvgPoint(item.id, '');
            updateStats();
            return;
          }
          const val = parseFloat(raw);
          if (isNaN(val)) return;
          checkState[idx].value = val;
          const inRange = (item.min == null || val >= item.min) && (item.max == null || val <= item.max);
          setStatus(inRange ? 'ok' : 'ng');
        });
      }

      $(`ng-note-${idx}`).addEventListener('input', e => { checkState[idx].note = e.target.value; });
      div.querySelector('.file-input').addEventListener('change', e => handlePhoto(e, idx));
    });
  }

  function updateSvgPoint(pointId, status) {
    const g = document.querySelector(`.svg-pt[data-point="${pointId}"]`);
    if (!g) return;
    g.classList.remove('status-ok','status-ng','status-fixed');
    if (status) g.classList.add(`status-${status}`);
  }

  function updateStats() {
    let ok = 0, ng = 0, pending = 0;
    checkState.forEach(i => {
      if (i.status === 'ok' || i.status === 'fixed') ok++;
      else if (i.status === 'ng') ng++;
      else pending++;
    });
    $('stat-ok').textContent = ok;
    $('stat-ng').textContent = ng;
    $('stat-pending').textContent = pending;
  }

  /* ── SVG click → scroll to checklist item ── */
  function bindSvgPoints() {
    document.querySelectorAll('.svg-pt').forEach(g => {
      g.addEventListener('click', () => {
        const pt = parseInt(g.dataset.point);
        const idx = checkState.findIndex(i => i.id === pt);
        if (idx < 0) return;
        document.querySelectorAll('.check-item').forEach(el => el.classList.remove('highlight'));
        const el = $('checklist-wrapper').querySelector(`.check-item[data-idx="${idx}"]`);
        if (el) { el.classList.add('highlight'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        document.querySelectorAll('.svg-pt').forEach(p => p.classList.remove('active'));
        g.classList.add('active');
      });
    });
  }

  /* ══════════════════════════════════════
     PHOTOS
  ══════════════════════════════════════ */
  async function handlePhoto(e, idx) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('กรุณาเลือกไฟล์รูปภาพ', 'ng'); e.target.value = ''; return; }
    try {
      // ย่อขนาดรูปก่อนเก็บ (เหมือนรูปพื้นหลัง JIG) — ป้องกัน Supabase storage เต็มเร็ว
      // เพราะรูปหลักฐาน NG อาจมีได้หลายรูปต่อ 1 การตรวจ และตรวจหลายรายการ/วัน
      // ลด maxDim 1000→600px, quality 0.75→0.60 เพื่อประหยัด storage ~70% ของเดิม
      // (ยังคงชัดพอให้เห็นรายละเอียดบนมือถือ)
      const dataUrl = await resizeImageToDataURL(file, 600, 0.60);
      checkState[idx].photos.push(dataUrl);
      renderPhotos(idx);
    } catch (err) {
      console.error(err);
      toast('อัปโหลดรูปไม่สำเร็จ', 'ng');
    }
    e.target.value = '';
  }

  function renderPhotos(idx) {
    const row = $(`photo-row-${idx}`);
    row.querySelectorAll('.photo-thumb-wrap').forEach(el => el.remove());
    checkState[idx].photos.forEach((src, pi) => {
      const wrap = document.createElement('div');
      wrap.className = 'photo-thumb-wrap';
      wrap.innerHTML = `<img src="${escHtml(src)}" class="photo-thumb"><button class="photo-del" data-pi="${pi}">✕</button>`;
      row.insertBefore(wrap, row.querySelector('.btn-camera'));
      wrap.querySelector('.photo-thumb').addEventListener('click', () => openLightbox(src));
      wrap.querySelector('.photo-del').addEventListener('click', () => {
        checkState[idx].photos.splice(pi, 1); renderPhotos(idx);
      });
    });
  }

  /* ══════════════════════════════════════
     SUBMIT
  ══════════════════════════════════════ */
  // ─── ขอ GPS Coordinates ─── (เก็บ "แต่ไม่บังคับ")
  async function getGPSCoordinates() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        console.warn('Geolocation ไม่รองรับในอุปกรณ์นี้');
        resolve({ latitude: null, longitude: null, accuracy: null, timestamp: null, status: 'unsupported' });
        return;
      }
      
      const timeoutId = setTimeout(() => {
        resolve({ latitude: null, longitude: null, accuracy: null, timestamp: null, status: 'timeout' });
      }, 10000); // รอ 10 วินาที ถ้าหา GPS ไม่ได้ให้ถือว่า timeout
      
      navigator.geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(timeoutId);
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: new Date().toISOString(),
            status: 'success'
          });
        },
        (error) => {
          clearTimeout(timeoutId);
          console.warn('GPS Error:', error);
          resolve({
            latitude: null,
            longitude: null,
            accuracy: null,
            timestamp: new Date().toISOString(),
            status: error.code === 1 ? 'denied' : 'error' // 1 = PERMISSION_DENIED
          });
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  /* ─── ส่ง Telegram Message — ผ่าน Edge Function เท่านั้น (token ไม่เคยอยู่ฝั่ง client) ─── */
  async function sendTelegramMessage(msg) {
    try {
      const response = await fetch(TELEGRAM_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, // Edge Function ต้องการ header นี้ตามค่า default ของ Supabase
        },
        body: JSON.stringify({ text: msg }),
      });

      if (!response.ok) {
        console.error('Telegram send failed:', response.status, await response.text().catch(() => ''));
      }
    } catch (e) {
      console.error('Telegram error:', e);
    }
  }

  async function submitReport() {
    if (!selection.jigId) { toast('กรุณาเลือก JIG ก่อนบันทึก', 'ng'); return; }
    if (!$('inp-inspector').value.trim()) { toast('กรุณาระบุชื่อผู้ตรวจสอบ', 'ng'); $('inp-inspector').focus(); return; }
    if (!$('inp-date').value) { toast('กรุณาเลือกวันที่', 'ng'); return; }
    if (!$('inp-shift').value) { toast('กรุณาเลือกกะ', 'ng'); return; }
    const unchecked = checkState.filter(i => !i.status);
    if (unchecked.length) { toast(`ยังมี ${unchecked.length} รายการที่ยังไม่ตรวจ`, 'ng'); return; }

    // ─── ขอ GPS พอดีกดบันทึก (บังคับต้องได้) ─── 
    toast('🔄 กำลังเก็บค่า GPS... (ต้องได้พิกัดก่อนบันทึกได้)', 'ok');
    const gpsData = await getGPSCoordinates();

    // ─── ตรวจสอบว่าได้พิกัด GPS สำเร็จหรือไม่ ───
    if (gpsData.status !== 'success' || gpsData.latitude === null || gpsData.longitude === null) {
      // ไม่ได้พิกัด → ไม่ให้บันทึก
      let errMsg = '';
      if (gpsData.status === 'denied') {
        errMsg = '❌ คุณปฏิเสธการใช้ GPS — ต้องเปิดให้ browser ใช้ GPS ก่อนจึงจะบันทึกได้ (ไปที่ Settings หรือลองใหม่)';
      } else if (gpsData.status === 'timeout') {
        errMsg = '⏱️ GPS หาพิกัดไม่ได้ (หมดเวลา) — เลื่อนไปที่กลางแจ้ง เปิด GPS ให้เต็มที่ แล้วลองบันทึกใหม่';
      } else if (gpsData.status === 'error') {
        errMsg = '⚠️ GPS เกิดข้อผิดพลาด — ลองปิด/เปิด GPS แล้วบันทึกใหม่';
      } else if (gpsData.status === 'unsupported') {
        errMsg = '❓ อุปกรณ์ของคุณไม่รองรับ GPS — ต้องใช้ smartphone ที่มี GPS';
      } else {
        errMsg = '❌ ไม่ได้พิกัด GPS — ต้องบันทึกให้ได้พิกัด GPS ก่อน';
      }
      toast(errMsg, 'ng');
      return;
    }

    // ─── ได้พิกัด → ดำเนินการบันทึก ───
    const jig  = catalog.jigs.find(j => j.id === selection.jigId);
    const line = catalog.lines.find(l => l.id === selection.lineId);
    const dept = catalog.depts.find(d => d.id === selection.deptId);

    const record = {
      id:         genId(),
      timestamp:  new Date().toISOString(),
      deptId:     selection.deptId,
      deptName:   dept ? dept.name : '',
      lineId:     selection.lineId,
      lineName:   line ? line.name : '',
      jigId:      selection.jigId,
      jigName:    jig  ? jig.name  : '',
      jigDocNo:   jig  ? (jig.docNo || jig.id) : '',
      date:       $('inp-date').value,
      shift:      $('inp-shift').value,
      month:      $('inp-month').value,
      inspector:  $('inp-inspector').value.trim(),
      notes:      $('report-notes').value,
      items:      checkState.map(i => ({ id: i.id, label: i.label, status: i.status, note: i.note, photos: i.photos, value: i.value ?? null, unit: i.unit || '' })),
      sigInspector:  $('sig-inspector').value.trim(),
      sigSupervisor: $('sig-supervisor').value.trim(),
      // ─── GPS Data ─── (บันทึกพิกัด - ตรวจสอบแล้วว่าได้พิกัด)
      gps: {
        latitude:   gpsData.latitude,
        longitude:  gpsData.longitude,
        accuracy:   gpsData.accuracy,
        timestamp:  gpsData.timestamp,
        status:     gpsData.status // 'success' เท่านั้น
      }
    };

    let hist = loadHistory();
    hist.unshift(record);
    if (hist.length > 100) hist = hist.slice(0, 100);
    if (saveHistory(hist)) {
      toast(`✅ บันทึกสำเร็จ! GPS: ${gpsData.latitude.toFixed(6)}, ${gpsData.longitude.toFixed(6)} (±${Math.round(gpsData.accuracy)}m)`, 'ok');
      
      // ─── ส่ง Telegram Notification ───
      const okCount = checkState.filter(i => i.status === 'ok' || i.status === 'fixed').length;
      const ngCount = checkState.filter(i => i.status === 'ng').length;
      const ngItems = checkState.filter(i => i.status === 'ng');
      const time = new Date(record.timestamp).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
      
      let telegramMsg = `
📊 *JIG Inspection Report*
━━━━━━━━━━━━━━━━━━━━━━━━━
*${escHtml(record.jigName)}*
${record.jigDocNo ? `_${escHtml(record.jigDocNo)}_` : ''}

📅 วันที่: ${record.date}
🕐 เวลา: ${time}
🔄 กะ: ${record.shift}
👤 ผู้ตรวจ: ${escHtml(record.inspector)}

✅ ผ่าน (OK): ${okCount}
${ngCount > 0 ? `❌ ไม่ผ่าน (NG): ${ngCount}` : ''}
`;

      // เพิ่มรายละเอียด NG items
      if (ngItems.length > 0) {
        telegramMsg += `\n*🔴 รายการที่ไม่ผ่าน:*\n`;
        ngItems.forEach((item, idx) => {
          const value = item.value ? ` (ค่า: ${item.value}${item.unit ? ' ' + item.unit : ''})` : '';
          const note = item.note ? ` - _${escHtml(item.note)}_` : '';
          telegramMsg += `${idx + 1}. ${escHtml(item.label)}${value}${note}\n`;
        });
      }

      telegramMsg += `
📍 GPS: ${gpsData.latitude.toFixed(6)}, ${gpsData.longitude.toFixed(6)}
━━━━━━━━━━━━━━━━━━━━━━━━━
`;
      
      await sendTelegramMessage(telegramMsg);
    }
  }

  /* ══════════════════════════════════════
     BACKUP — EXPORT / IMPORT
     ดึงข้อมูลตรงจาก Supabase ทุกครั้ง เพื่อให้ได้ข้อมูลล่าสุดเสมอ
     ไม่ใช้ localStorage เพราะอาจค้างหรือไม่ตรงกับ Supabase
  ══════════════════════════════════════ */
  async function exportAllData() {
    if (!sb) { toast('ไม่ได้เชื่อมต่อ Supabase', 'ng'); return; }
    toast('กำลังดึงข้อมูลจาก Supabase...', 'ok');
    try {
      // ดึง catalog ทุกตาราง
      const [depts, lines, jigs, checkpoints, templates, histRows] = await Promise.all([
        sb.from('departments').select('*'),
        sb.from('lines').select('*'),
        sb.from('jigs').select('*'),
        sb.from('checkpoints').select('*'),
        sb.from('templates').select('*'),
        sb.from('history').select('*').order('ts', { ascending: false }),
      ]);

      // ประกอบ checkpoints กลับเข้า jigs (เหมือนโครงสร้างใน memory)
      const jigsWithCp = (jigs.data || []).map(j => ({
        ...j,
        checkpoints: (checkpoints.data || [])
          .filter(cp => cp.jig_id === j.id)
          .sort((a, b) => a.item_id - b.item_id)
          .map(cp => ({ id: cp.item_id, label: cp.label, sub: cp.sub, method: cp.method, x: cp.x, y: cp.y, type: cp.type || null, min: cp.min ?? null, max: cp.max ?? null, unit: cp.unit || null }))
      }));

      const payload = {
        app: 'jig-inspection-dashboard',
        version: 3,
        exportedAt: new Date().toISOString(),
        catalog: {
          depts: depts.data || [],
          lines: lines.data || [],
          jigs: jigsWithCp,
          templates: (templates.data || []).map(t => ({ id: t.id, name: t.name, items: t.items || [] })),
        },
        history: histRows.data || [],
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `jig-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      const jigCount = jigsWithCp.length;
      const histCount = (histRows.data || []).length;
      toast(`✅ Export สำเร็จ — ${jigCount} JIG, ${histCount} ประวัติ`, 'ok');
    } catch (err) {
      console.error('exportAllData error:', err);
      toast('Export ไม่สำเร็จ: ' + (err.message || err), 'ng');
    }
  }

  function importAllData(file) {
    if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
      toast('กรุณาเลือกไฟล์ .json ที่ export จากระบบนี้เท่านั้น', 'ng');
      return;
    }
    const reader = new FileReader();
    reader.onload = async ev => {
      let data;
      try {
        data = JSON.parse(ev.target.result);
      } catch (err) {
        toast('ไฟล์ไม่ใช่ JSON ที่ถูกต้อง', 'ng');
        return;
      }
      const cat = data && (data.catalog || (data.data && data.data.catalog));
      const hist = data && (data.history || (data.data && data.data.history));
      const validCatalog = cat && Array.isArray(cat.depts) && Array.isArray(cat.lines) && Array.isArray(cat.jigs);
      if (!validCatalog || !Array.isArray(hist)) {
        toast('รูปแบบไฟล์ไม่ถูกต้อง — ต้อง export มาจากระบบนี้เท่านั้น', 'ng');
        return;
      }

      // Normalize data: convert snake_case from backup to camelCase for internal use
      cat.lines = (cat.lines || []).map(l => ({
        id: l.id,
        name: l.name,
        deptId: l.deptId || l.dept_id  // Support both formats
      }));
      
      cat.jigs = (cat.jigs || []).map(j => ({
        id: j.id,
        name: j.name,
        lineId: j.lineId || j.line_id,  // Support both formats
        docNo: j.docNo || j.doc_no || '',
        bgImage: j.bgImage || j.bg_image || null,
        checkpoints: (j.checkpoints || []).map(cp => ({
          id: cp.id,
          label: cp.label || '',
          sub: cp.sub || '',
          method: cp.method || '',
          x: cp.x || 0,
          y: cp.y || 0,
          type: cp.type || null,
          min: cp.min ?? null,
          max: cp.max ?? null,
          unit: cp.unit || null
        }))
      }));
      if (!confirm(`นำเข้าข้อมูลนี้จะ "แทนที่" ข้อมูลปัจจุบันทั้งหมด\n(${cat.jigs.length} JIG, ${hist.length} ประวัติ)\nแนะนำให้ Export สำรองไว้ก่อน — ต้องการดำเนินการต่อหรือไม่?`)) return;

      if (!sb) { toast('ไม่ได้เชื่อมต่อ Supabase', 'ng'); return; }
      toast('กำลังนำเข้าข้อมูลขึ้น Supabase...', 'ok');

      try {
        _syncing = true;

        // ✅ SAFE: ใช้ UPSERT แทน DELETE+INSERT - ป้องกันข้อมูลหาย
        // Upsert departments
        if (cat.depts.length) {
          const { error } = await sb.from('departments').upsert(
            cat.depts.map(d => ({ id: d.id, name: d.name })),
            { onConflict: 'id' }
          );
          if (error) throw error;
        }

        // Upsert lines (data is already normalized to camelCase)
        if (cat.lines.length) {
          const { error } = await sb.from('lines').upsert(
            cat.lines.map(l => ({ 
              id: l.id, 
              dept_id: l.deptId,  // Now using normalized camelCase
              name: l.name 
            })),
            { onConflict: 'id' }
          );
          if (error) throw error;
        }

        // Upsert jigs (data is already normalized to camelCase)
        if (cat.jigs.length) {
          const { error } = await sb.from('jigs').upsert(
            cat.jigs.map(j => ({ 
              id: j.id, 
              line_id: j.lineId,  // Now using normalized camelCase
              name: j.name, 
              doc_no: j.docNo, 
              bg_image: j.bgImage 
            })),
            { onConflict: 'id' }
          );
          if (error) throw error;
        }

        // ✅ Upsert checkpoints แยก
        const allCps = cat.jigs.flatMap(j =>
          (j.checkpoints || []).map(cp => ({ jig_id: j.id, item_id: cp.id, label: cp.label || '', sub: cp.sub || '', method: cp.method || '', x: cp.x || 0, y: cp.y || 0, type: cp.type || null, min: cp.min ?? null, max: cp.max ?? null, unit: cp.unit || null }))
        );
        for (let i = 0; i < allCps.length; i += 200) {
          const { error } = await sb.from('checkpoints').upsert(
            allCps.slice(i, i + 200),
            { onConflict: 'jig_id,item_id' }
          );
          if (error) throw error;
        }

        // ✅ Upsert templates
        if ((cat.templates || []).length) {
          const { error } = await sb.from('templates').upsert(
            cat.templates.map(t => ({ id: t.id, name: t.name, items: t.items || [] })),
            { onConflict: 'id' }
          );
          if (error) throw error;
        }

        // Insert history (แบ่ง batch 40 แถวต่อครั้ง เพราะ history มีรูป base64 ใหญ่)
        for (let i = 0; i < hist.length; i += 40) {
          const batch = hist.slice(i, i + 40).map(h => ({
            id: h.id, ts: h.timestamp || h.ts,
            dept_id: h.deptId || h.dept_id || '', dept_name: h.deptName || h.dept_name || '',
            line_id: h.lineId || h.line_id || '', line_name: h.lineName || h.line_name || '',
            jig_id: h.jigId || h.jig_id || '', jig_name: h.jigName || h.jig_name || '',
            jig_doc_no: h.jigDocNo || h.jig_doc_no || '',
            insp_date: h.date || h.insp_date || '', shift: h.shift || '',
            month: h.month || '', inspector: h.inspector || '', notes: h.notes || '',
            items: h.items || [],
            sig_inspector: h.sigInspector || h.sig_inspector || '',
            sig_supervisor: h.sigSupervisor || h.sig_supervisor || '',
          }));
          const { error } = await sb.from('history').upsert(batch, { onConflict: 'id' });
          if (error) throw error;
        }

        setTimeout(() => { _syncing = false; }, 2000);

        // Save normalized catalog to localStorage
        localStorage.setItem(SK.catalog, JSON.stringify(cat));
        localStorage.setItem(SK.history, JSON.stringify(hist));

        // รีโหลดข้อมูลเข้า memory และ re-render
        if (typeof refreshCatalogGlobal === 'function') await refreshCatalogGlobal();
        if (typeof refreshHistoryGlobal === 'function') await refreshHistoryGlobal();
        selection = { deptId: null, lineId: null, jigId: null };
        hideInspectionCards(); renderAdminLists(); renderFilter(); refreshDashboard();
        toast(`✅ Import สำเร็จ — ${cat.jigs.length} JIG, ${hist.length} ประวัติ`, 'ok');
      } catch (err) {
        _syncing = false;
        console.error('importAllData error:', err);
        toast('Import ไม่สำเร็จ: ' + (err.message || err), 'ng');
      }
    };
    reader.onerror = () => toast('อ่านไฟล์ไม่สำเร็จ', 'ng');
    reader.readAsText(file);
  }

  /* ══════════════════════════════════════
     ADMIN PANEL & LOGIN
  ══════════════════════════════════════ */
  let admLoggedIn = false;

  // แยก checkpoint dropdown binding ออกมา เพื่อให้ re-bind ได้หลายครั้ง
  // (renderAdminLists อาจ rebuild dropdown หลายครั้ง เมื่อ realtime sync เกิดขึ้น)
  function bindCpJigDropdown() {
    $('adm-cp-jig').addEventListener('change', () => {
      const jid = $('adm-cp-jig').value;
      cpEditJigId = jid || null;
      if (!jid) { $('adm-cp-editor').classList.add('hidden'); return; }
      const jig = catalog.jigs.find(j => j.id === jid);
      if (!jig.checkpoints) jig.checkpoints = [];
      $('adm-cp-editor').classList.remove('hidden');
      renderCpBgControls(jid);
      renderAdmCpMap(jid);
      renderCpList(jid);
      renderTplSelect();
      renderTplPreview();
      renderTplList();
    });
  }

  function bindAdminPanel() {
    $('adm-jig-search').addEventListener('input', filterJigList);

    $('btn-admin-toggle').addEventListener('click', () => {
      if (admLoggedIn) openPanel('admin-panel');
      else {
        $('admin-login-modal').classList.remove('hidden');
        $('inp-admin-pass').value = '';
        $('inp-admin-pass').focus();
        // ซ่อน hint "รหัสผ่านเริ่มต้น" ทันทีที่มีการตั้งรหัสผ่านใหม่แล้ว — กันข้อมูลเก่าค้างจอ
        $('hint-default-pass').classList.toggle('hidden', !!localStorage.getItem('jig_admin_pass'));
      }
    });
    
    // Login flow — ตรวจสอบจาก Supabase admin_users table
    $('btn-close-login').addEventListener('click', () => $('admin-login-modal').classList.add('hidden'));
    $('admin-login-modal').addEventListener('click', e => { if (e.target === $('admin-login-modal')) $('admin-login-modal').classList.add('hidden'); });
    $('btn-login-submit').addEventListener('click', async () => {
      const username = ($('inp-admin-user')?.value?.trim()) || 'admin';
      const pass = $('inp-admin-pass').value;
      
      if (!pass) {
        toast('กรุณากรอกรหัสผ่าน', 'ng');
        return;
      }

      // Fallback ถ้า Supabase ไม่พร้อม (เพื่อความสะดวกใน dev)
      if (!sb) {
        const localPass = localStorage.getItem('jig_admin_pass');
        if (pass === localPass) {
          admLoggedIn = true;
          $('admin-login-modal').classList.add('hidden');
          openPanel('admin-panel');
          toast('เข้าสู่ระบบสำเร็จ (local mode)', 'ok');
        } else {
          toast('รหัสผ่านไม่ถูกต้อง', 'ng');
        }
        return;
      }

      // ตรวจสอบผ่าน RPC — DB จะตอบแค่ true/false เท่านั้น ไม่เคยส่ง password_hash กลับมาให้ client เห็น
      try {
        $('btn-login-submit').disabled = true;
        const btnText = $('btn-login-submit').textContent;
        $('btn-login-submit').textContent = '🔄 กำลังตรวจสอบ...';

        const { data: ok, error } = await sb.rpc('verify_admin_login', {
          p_username: username,
          p_password: pass,
        });

        if (error) {
          console.error('Login RPC error:', error);
          toast('เกิดข้อผิดพลาดในการตรวจสอบ', 'ng');
          $('btn-login-submit').disabled = false;
          $('btn-login-submit').textContent = btnText;
          return;
        }

        if (ok) {
          admLoggedIn = true;
          localStorage.setItem('jig_admin_user', username);
          $('admin-login-modal').classList.add('hidden');
          openPanel('admin-panel');
          toast(`เข้าสู่ระบบสำเร็จ (${username})`, 'ok');
        } else {
          toast('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'ng');
        }
      } catch (e) {
        console.error('Login error:', e);
        toast('เกิดข้อผิดพลาดในการตรวจสอบ', 'ng');
      } finally {
        $('btn-login-submit').disabled = false;
        $('btn-login-submit').textContent = 'เข้าสู่ระบบ';
      }
    });

    $('btn-close-admin').addEventListener('click', () => closePanel('admin-panel'));

    /* Change Pass — ต้องยืนยันรหัสเดิมก่อนเสมอ (ผ่าน RPC ฝั่ง DB) */
    $('btn-adm-pass').addEventListener('click', async () => {
      const oldPass = $('adm-old-pass').value.trim();
      const newPass = $('adm-new-pass').value.trim();
      if (!oldPass) { toast('กรุณากรอกรหัสผ่านเดิม', 'ng'); return; }
      if (!newPass || newPass.length < 4) { 
        toast('รหัสผ่านใหม่ต้องยาว 4 ตัวขึ้นไป', 'ng'); 
        return; 
      }
      
      // ถ้า Supabase ไม่พร้อม ให้บันทึกใน localStorage (fallback)
      if (!sb) {
        const localPass = localStorage.getItem('jig_admin_pass') || 'admin1234';
        if (oldPass !== localPass) { toast('รหัสผ่านเดิมไม่ถูกต้อง', 'ng'); return; }
        localStorage.setItem('jig_admin_pass', newPass);
        $('adm-old-pass').value = ''; $('adm-new-pass').value = '';
        $('hint-default-pass').classList.add('hidden');
        toast('เปลี่ยนรหัสผ่าน Admin แล้ว (local mode)', 'ok');
        return;
      }

      try {
        $('btn-adm-pass').disabled = true;
        const btnText = $('btn-adm-pass').textContent;
        $('btn-adm-pass').textContent = '🔄 กำลังบันทึก...';

        const adminUser = localStorage.getItem('jig_admin_user') || 'admin';

        const { data: ok, error } = await sb.rpc('change_admin_password', {
          p_username: adminUser,
          p_old_password: oldPass,
          p_new_password: newPass,
        });

        if (error) throw error;

        if (!ok) {
          toast('รหัสผ่านเดิมไม่ถูกต้อง', 'ng');
          return;
        }

        $('adm-old-pass').value = ''; $('adm-new-pass').value = '';
        $('hint-default-pass').classList.add('hidden');
        toast('เปลี่ยนรหัสผ่าน Admin แล้ว', 'ok');
      } catch (e) {
        console.error('Change password error:', e);
        toast('เกิดข้อผิดพลาดในการเปลี่ยนรหัสผ่าน', 'ng');
      } finally {
        $('btn-adm-pass').disabled = false;
        $('btn-adm-pass').textContent = 'เปลี่ยนรหัสผ่าน';
      }
    });

    /* Add Dept */
    $('btn-adm-dept').addEventListener('click', () => {
      const id   = $('adm-dept-id').value.trim().toUpperCase();
      const name = $('adm-dept-name').value.trim();
      if (!id || !name) { toast('กรุณากรอกรหัสและชื่อแผนก', 'ng'); return; }
      if (catalog.depts.find(d => d.id === id)) { toast(`รหัส ${id} มีแล้ว`, 'ng'); return; }
      catalog.depts.push({ id, name });
      saveCatalog();
      $('adm-dept-id').value = ''; $('adm-dept-name').value = '';
      renderAdminLists(); renderFilter();
      toast(`เพิ่มแผนก "${name}" สำเร็จ`, 'ok');
    });

    /* Add Line */
    $('btn-adm-line').addEventListener('click', () => {
      const deptId = $('adm-line-dept').value;
      const id     = $('adm-line-id').value.trim();
      const name   = $('adm-line-name').value.trim();
      if (!deptId) { toast('กรุณาเลือกแผนก', 'ng'); return; }
      if (!id || !name) { toast('กรุณากรอกรหัสและชื่อ Line', 'ng'); return; }
      if (catalog.lines.find(l => l.id === id)) { toast(`รหัส ${id} มีแล้ว`, 'ng'); return; }
      catalog.lines.push({ id, deptId, name });
      saveCatalog();
      $('adm-line-id').value = ''; $('adm-line-name').value = '';
      renderAdminLists(); renderFilter();
      toast(`เพิ่ม Line "${name}" สำเร็จ`, 'ok');
    });

    /* Add JIG */
    $('btn-adm-jig').addEventListener('click', () => {
      const deptId = $('adm-jig-dept').value;
      const lineId = $('adm-jig-line').value;
      const id     = $('adm-jig-id').value.trim().toUpperCase();
      const name   = $('adm-jig-name').value.trim();
      if (!lineId) { toast('กรุณาเลือก Line', 'ng'); return; }
      if (!id || !name) { toast('กรุณากรอกรหัสและชื่อ JIG', 'ng'); return; }
      if (catalog.jigs.find(j => j.id === id)) { toast(`รหัส ${id} มีแล้ว`, 'ng'); return; }
      catalog.jigs.push({ id, lineId, name, docNo: id, bgImage: null, checkpoints: [] });
      saveCatalog();
      $('adm-jig-id').value = ''; $('adm-jig-name').value = '';
      renderAdminLists(); renderFilter();
      toast(`เพิ่ม JIG "${name}" สำเร็จ`, 'ok');
    });

    /* JIG line filter on dept change */
    $('adm-jig-dept').addEventListener('change', () => {
      const deptId = $('adm-jig-dept').value;
      const lines  = catalog.lines.filter(l => l.deptId === deptId);
      $('adm-jig-line').innerHTML = '<option value="">Line</option>' +
        lines.map(l => `<option value="${escHtml(l.id)}">${escHtml(l.name)}</option>`).join('');
    });

    /* Checkpoint Management — extracted to bindCpJigDropdown() so it can be re-called */
    bindCpJigDropdown();
    $('btn-adm-cp').addEventListener('click', () => {
      const jid = $('adm-cp-jig').value;
      if (!jid) return;
      const jig = catalog.jigs.find(j => j.id === jid);
      if (!jig.checkpoints) jig.checkpoints = [];
      const label = $('adm-cp-label').value.trim();
      const sub = $('adm-cp-sub').value.trim();
      const method = $('adm-cp-method').value.trim();
      if (!label) { toast('กรุณาใส่ชื่อจุดตรวจ', 'ng'); return; }
      const newId = jig.checkpoints.length ? Math.max(...jig.checkpoints.map(p=>p.id)) + 1 : 1;
      // วางจุดใหม่ไว้กลางแผนผังแบบสุ่มเล็กน้อยกันซ้อนทับ แล้วให้ผู้ใช้ลากจัดตำแหน่งเอง
      const x = 300 + Math.round(Math.random() * 60 - 30);
      const y = 170 + Math.round(Math.random() * 60 - 30);
      jig.checkpoints.push({ id: newId, label, sub, method, x, y });
      
      // ตั้ง _syncing = true ระหว่างเพิ่มจุด เพื่อไม่ให้ realtime event echo มาแทรก
      // (ถ้าปล่อยให้ realtime event มา จะเรียก renderAdminLists() แล้ว dropdown รีเซ็ต 
      //  ทำให้ user ต้องเลือก JIG ใหม่อีกครั้ง)
      _syncing = true;
      saveCatalog();
      // ปกติ saveCatalog ส่งขึ้น Supabase เป็น debounce 500ms ผลจะมาบ้านประมาณ 1-2 วินาที
      // ตั้ง _syncing = false หลังจากนั้นพอ ให้เวลาเพียงพอให้ realtime event ถูกเพิกเฉย
      setTimeout(() => { _syncing = false; }, 2000);
      
      $('adm-cp-label').value = ''; $('adm-cp-sub').value = ''; $('adm-cp-method').value = '';
      renderAdmCpMap(jid);
      renderCpList(jid);
      toast('เพิ่มจุดตรวจแล้ว — ลากจุดบนแผนผังเพื่อจัดตำแหน่ง', 'ok');
    });

    /* ── เทมเพลตหัวข้อตรวจสอบ — ใช้ซ้ำข้ามหลาย JIG โดยไม่ต้องพิมพ์ใหม่ทุกครั้ง ── */
    $('adm-tpl-select').addEventListener('change', () => renderTplPreview());

    $('btn-tpl-select-all').addEventListener('click', () => {
      document.querySelectorAll('#adm-tpl-items input[type=checkbox]').forEach(cb => cb.checked = true);
      updateTplPreviewCount();
    });
    $('btn-tpl-select-none').addEventListener('click', () => {
      document.querySelectorAll('#adm-tpl-items input[type=checkbox]').forEach(cb => cb.checked = false);
      updateTplPreviewCount();
    });

    $('btn-tpl-apply').addEventListener('click', () => {
      const jid = cpEditJigId;
      if (!jid) return;
      const tplId = $('adm-tpl-select').value;
      if (!tplId) { toast('กรุณาเลือกเทมเพลตก่อน', 'ng'); return; }
      const tpl = catalog.templates.find(t => t.id === tplId);
      if (!tpl) return;
      const checkedBoxes = Array.from(document.querySelectorAll('#adm-tpl-items input[type=checkbox]:checked'));
      if (!checkedBoxes.length) { toast('กรุณาเลือกอย่างน้อย 1 หัวข้อที่จะนำเข้า', 'ng'); return; }
      const selectedItems = checkedBoxes.map(cb => tpl.items[parseInt(cb.dataset.i, 10)]);

      const jig = catalog.jigs.find(j => j.id === jid);
      if (!jig.checkpoints) jig.checkpoints = [];
      let nextId = jig.checkpoints.length ? Math.max(...jig.checkpoints.map(p => p.id)) + 1 : 1;
      selectedItems.forEach((item, i) => {
        // กระจายตำแหน่งเริ่มต้นเป็นตารางกลางแผนผัง กันจุดซ้อนทับกันหมด — ลากจัดตำแหน่งจริงภายหลัง
        const col = i % 4, row = Math.floor(i / 4);
        const x = 180 + col * 90 + Math.round(Math.random() * 10 - 5);
        const y = 100 + row * 60 + Math.round(Math.random() * 10 - 5);
        jig.checkpoints.push({ id: nextId++, label: item.label, sub: item.sub, method: item.method, x, y });
      });
      saveCatalog();
      renderAdmCpMap(jid);
      renderCpList(jid);
      toast(`นำเข้า ${selectedItems.length} หัวข้อจากเทมเพลต "${tpl.name}" แล้ว — ลากจุดจัดตำแหน่ง`, 'ok');
      $('adm-tpl-select').value = '';
      renderTplPreview();
    });

    $('btn-tpl-save').addEventListener('click', () => {
      const jid = cpEditJigId;
      if (!jid) return;
      const jig = catalog.jigs.find(j => j.id === jid);
      const pts = jig.checkpoints || [];
      if (!pts.length) { toast('JIG นี้ยังไม่มีหัวข้อตรวจสอบให้บันทึกเป็นเทมเพลต', 'ng'); return; }
      const name = prompt('ตั้งชื่อเทมเพลต (เช่น "เช็คลิสต์มาตรฐาน BODY")', jig.name ? `เทมเพลตจาก ${jig.name}` : '');
      if (!name || !name.trim()) return;
      const items = pts.map(p => ({ label: p.label, sub: p.sub || '', method: p.method || '' }));
      catalog.templates.push({ id: 'tpl_' + Date.now(), name: name.trim(), items });
      saveCatalog();
      renderTplSelect();
      renderTplList();
      toast(`บันทึกเทมเพลต "${name.trim()}" แล้ว (${items.length} หัวข้อ)`, 'ok');
    });

    /* Background image upload / remove */
    $('adm-cp-bg-input').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      if (!cpEditJigId) { toast('กรุณาเลือก JIG ก่อน', 'ng'); return; }
      if (!file.type.startsWith('image/')) { toast('กรุณาเลือกไฟล์รูปภาพ', 'ng'); e.target.value=''; return; }
      try {
        // ลด maxDim 1000→700px, quality 0.82→0.65 เพื่อประหยัด storage
        // (พื้นหลัง JIG ดูบ่อย จึงเก็บคุณภาพที่ดีกว่ารูปหลักฐาน)
        const dataUrl = await resizeImageToDataURL(file, 700, 0.65);
        const jig = catalog.jigs.find(j => j.id === cpEditJigId);
        jig.bgImage = dataUrl;
        saveCatalog();
        renderCpBgControls(cpEditJigId);
        renderAdmCpMap(cpEditJigId);
        renderSvgMap(); // อัปเดตแผนผังในหน้าตรวจสอบด้วย ถ้ากำลังเปิด JIG นี้อยู่
        toast('อัปโหลดรูปพื้นหลังแล้ว', 'ok');
      } catch (err) {
        console.error(err);
        toast('อัปโหลดรูปไม่สำเร็จ', 'ng');
      }
      e.target.value = '';
    });
    $('btn-cp-bg-remove').addEventListener('click', () => {
      if (!cpEditJigId) return;
      const jig = catalog.jigs.find(j => j.id === cpEditJigId);
      delete jig.bgImage;
      saveCatalog();
      renderCpBgControls(cpEditJigId);
      renderAdmCpMap(cpEditJigId);
      renderSvgMap();
      toast('ลบรูปพื้นหลังแล้ว — กลับไปใช้แผนผังเริ่มต้น', 'ok');
    });

    /* Export / Import backup */
    $('btn-export-data').addEventListener('click', exportAllData);
    $('inp-import-data').addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) importAllData(file);
      e.target.value = '';
    });

    /* Save All — ยืนยันการบันทึกอีกครั้ง (ข้อมูลถูก auto-save ทุกครั้งที่กด "เพิ่ม" อยู่แล้ว
       ปุ่มนี้เพิ่มมาเพื่อความมั่นใจของผู้ใช้ และตรวจสอบ round-trip ผ่าน localStorage จริง) */
    $('btn-save-all').addEventListener('click', () => {
      const btn = $('btn-save-all');
      const original = btn.textContent;
      saveCatalog();
      try {
        const raw = localStorage.getItem(SK.catalog);
        const roundTrip = raw && JSON.parse(raw);
        const ok = !!roundTrip && roundTrip.jigs.length === catalog.jigs.length
          && roundTrip.lines.length === catalog.lines.length
          && roundTrip.depts.length === catalog.depts.length;
        if (ok) {
          toast(`✅ บันทึกข้อมูลทั้งหมดแล้ว (${catalog.depts.length} แผนก, ${catalog.lines.length} Line, ${catalog.jigs.length} JIG)`, 'ok');
          btn.textContent = '✅ บันทึกแล้ว';
        } else {
          toast('บันทึกไม่สำเร็จ — พื้นที่จัดเก็บอาจเต็ม กรุณาลองใหม่', 'ng');
          btn.textContent = '⚠️ บันทึกไม่สำเร็จ';
        }
      } catch (err) {
        console.error('btn-save-all error:', err);
        toast('บันทึกไม่สำเร็จ', 'ng');
        btn.textContent = '⚠️ บันทึกไม่สำเร็จ';
      }
      setTimeout(() => { btn.textContent = original; }, 2000);
    });

    /* Seed demo */
    renderAdminLists();
  }

  function renderTplSelect() {
    const sel = $('adm-tpl-select');
    const cur = sel.value;
    sel.innerHTML = '<option value="">เลือกเทมเพลตที่จะนำเข้า...</option>' +
      catalog.templates.map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name)} (${t.items.length} หัวข้อ)</option>`).join('');
    if (catalog.templates.some(t => t.id === cur)) sel.value = cur;
  }

  /* ── แสดงรายการหัวข้อในเทมเพลตที่เลือก พร้อม checkbox ให้เลือกเฉพาะหัวข้อที่ต้องการนำเข้า
     (บางหัวข้อในเทมเพลตอาจไม่ตรงกับ JIG นี้ ไม่จำเป็นต้องนำเข้าทั้งหมด) ── */
  function renderTplPreview() {
    const tplId = $('adm-tpl-select').value;
    const box = $('adm-tpl-preview');
    if (!tplId) { box.classList.add('hidden'); return; }
    const tpl = catalog.templates.find(t => t.id === tplId);
    if (!tpl) { box.classList.add('hidden'); return; }

    box.classList.remove('hidden');
    $('adm-tpl-items').innerHTML = tpl.items.map((item, i) => `
      <label class="tpl-check-row">
        <input type="checkbox" data-i="${i}" checked>
        <span>
          <div>${escHtml(item.label)}</div>
          ${(item.sub || item.method) ? `<div class="tpl-check-sub">${escHtml(item.sub || '')}${item.sub && item.method ? ' — ' : ''}${escHtml(item.method || '')}</div>` : ''}
        </span>
      </label>`).join('');

    document.querySelectorAll('#adm-tpl-items input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', updateTplPreviewCount);
    });
    updateTplPreviewCount();
  }

  function updateTplPreviewCount() {
    const total = document.querySelectorAll('#adm-tpl-items input[type=checkbox]').length;
    const checked = document.querySelectorAll('#adm-tpl-items input[type=checkbox]:checked').length;
    $('tpl-preview-count').textContent = `เลือก ${checked}/${total} หัวข้อ`;
  }

  function renderTplList() {
    const list = $('adm-tpl-list');
    if (!catalog.templates.length) {
      list.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">ยังไม่มีเทมเพลต — เพิ่มหัวข้อให้ JIG นี้ก่อน แล้วกด "บันทึกหัวข้อของ JIG นี้เป็นเทมเพลตใหม่"</div>';
      return;
    }
    list.innerHTML = catalog.templates.map(t => `
      <div class="adm-item" style="padding:6px;">
        <div class="adm-item-info">
          <span class="tpl-item-name">${escHtml(t.name)}</span><span class="tpl-item-count">${t.items.length} หัวข้อ</span>
        </div>
        <button class="adm-item-del btn-del-tpl" data-tid="${escHtml(t.id)}">🗑</button>
      </div>`).join('');

    document.querySelectorAll('.btn-del-tpl').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = catalog.templates.find(x => x.id === btn.dataset.tid);
        if (!t) return;
        if (!confirm(`ลบเทมเพลต "${t.name}" หรือไม่? (ไม่กระทบหัวข้อที่นำเข้าไปยัง JIG ต่างๆ แล้ว)`)) return;
        catalog.templates = catalog.templates.filter(x => x.id !== t.id);
        saveCatalog();
        if (sb) { // ลบออกจาก Supabase ตรงๆ ด้วย — กันเด้งกลับมาเหมือนบั๊ก JIG/Line/Dept ก่อนหน้า
          sb.from('templates').delete().eq('id', t.id).then(({ error }) => {
            if (error) console.error('delete template error:', error);
          });
        }
        renderTplSelect();
        renderTplPreview();
        renderTplList();
        toast('ลบเทมเพลตแล้ว', 'ok');
      });
    });
  }

  function renderCpList(jid) {
    const jig = catalog.jigs.find(j => j.id === jid);
    const pts = jig.checkpoints || [];
    $('adm-cp-list').innerHTML = pts.length ? pts.map((p, i) => `
      <div class="adm-item" style="padding:6px; margin-bottom:4px">
        <div class="adm-item-info">
          <div style="font-size:12px"><strong>${i + 1}.</strong> ${escHtml(p.label)} <span style="font-size:10px; color:var(--text-muted)">(X:${p.x}, Y:${p.y})</span>
            ${p.type === 'numeric' ? `<span class="cp-numeric-badge">🔢 ${p.min}-${p.max}${p.unit ? ' ' + escHtml(p.unit) : ''}</span>` : ''}
          </div>
        </div>
        <div style="display:flex; gap:2px; align-items:center;">
          <div style="display:flex; flex-direction:column;">
            <button class="adm-item-order btn-cp-up" data-jid="${escHtml(jid)}" data-idx="${i}" title="เลื่อนขึ้น" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button class="adm-item-order btn-cp-down" data-jid="${escHtml(jid)}" data-idx="${i}" title="เลื่อนลง" ${i === pts.length - 1 ? 'disabled' : ''}>▼</button>
          </div>
          <button class="adm-item-cfg btn-edit-cp" data-jid="${escHtml(jid)}" data-idx="${i}" title="แก้ไขหัวข้อ">✏️</button>
          <button class="adm-item-cfg btn-cfg-numeric" data-jid="${escHtml(jid)}" data-idx="${i}" title="${p.type === 'numeric' ? 'เปลี่ยนกลับเป็น Pass/Fail' : 'ตั้งเป็นหัวข้อกรอกค่าตัวเลข'}">🔢</button>
          <button class="adm-item-del btn-del-cp" data-jid="${escHtml(jid)}" data-idx="${i}">🗑</button>
        </div>
      </div>`).join('') : '<div style="font-size:11px;color:var(--text-muted)">ยังไม่มีจุดตรวจ ใช้ค่าเริ่มต้น (10 จุด)</div>';

    document.querySelectorAll('.btn-del-cp').forEach(btn => {
      btn.addEventListener('click', () => {
        const j = catalog.jigs.find(x => x.id === btn.dataset.jid);
        const removed = j.checkpoints[btn.dataset.idx];
        j.checkpoints.splice(btn.dataset.idx, 1);
        saveCatalog();
        // ⚠️ FIX: pushCatalogToSupabase ใช้ upsert (ไม่ลบ) — ต้องลบแถวนี้ออกจาก Supabase ตรงๆ
        // ไม่งั้นแถวเดิมจะยังค้างอยู่ใน DB แล้วโดน sync กลับมา "เด้งคืน" เหมือนไม่เคยลบ
        if (sb && removed) {
          sb.from('checkpoints').delete().eq('jig_id', btn.dataset.jid).eq('item_id', removed.id)
            .then(({ error }) => { if (error) console.error('delete checkpoint error:', error); });
        }
        renderCpList(btn.dataset.jid);
        renderAdmCpMap(btn.dataset.jid);
        toast('ลบจุดตรวจแล้ว', 'ok');
      });
    });

    document.querySelectorAll('.btn-cfg-numeric').forEach(btn => {
      btn.addEventListener('click', () => configureNumericCheckpoint(btn.dataset.jid, parseInt(btn.dataset.idx, 10)));
    });

    document.querySelectorAll('.btn-edit-cp').forEach(btn => {
      btn.addEventListener('click', () => editCheckpoint(btn.dataset.jid, parseInt(btn.dataset.idx, 10)));
    });

    document.querySelectorAll('.btn-cp-up').forEach(btn => {
      btn.addEventListener('click', () => moveCheckpoint(btn.dataset.jid, parseInt(btn.dataset.idx, 10), -1));
    });
    document.querySelectorAll('.btn-cp-down').forEach(btn => {
      btn.addEventListener('click', () => moveCheckpoint(btn.dataset.jid, parseInt(btn.dataset.idx, 10), 1));
    });
  }

  /* ── แก้ไขชื่อ/เกณฑ์/วิธีตรวจของจุดตรวจที่มีอยู่แล้ว (ไม่ต้องลบแล้วเพิ่มใหม่ ตำแหน่ง X,Y ยังอยู่เหมือนเดิม) ── */
  function editCheckpoint(jid, idx) {
    const jig = catalog.jigs.find(j => j.id === jid);
    const p = jig.checkpoints[idx];
    if (!p) return;

    const label = prompt('ชื่อจุด', p.label);
    if (label === null) return;
    if (!label.trim()) { toast('ชื่อจุดห้ามว่าง', 'ng'); return; }
    const sub = prompt('เกณฑ์', p.sub || '');
    if (sub === null) return;
    const method = prompt('วิธีตรวจ', p.method || '');
    if (method === null) return;

    p.label = label.trim(); p.sub = sub.trim(); p.method = method.trim();
    saveCatalog();
    renderCpList(jid);
    renderAdmCpMap(jid);
    if (selection.jigId === jid) renderSvgMap(); // sync กับหน้าตรวจสอบถ้าเปิด JIG เดียวกันอยู่
    toast(`แก้ไข "${p.label}" แล้ว`, 'ok');
  }

  /* ── เลื่อนลำดับจุดตรวจขึ้น/ลง — สลับตำแหน่งใน array (id เดิมของแต่ละจุดไม่เปลี่ยน
     ใช้แค่ผูกตำแหน่งบนแผนผังเท่านั้น เลขที่แสดง 1,2,3... จะเรียงตามลำดับใหม่อัตโนมัติ) ── */
  function moveCheckpoint(jid, idx, dir) {
    const jig = catalog.jigs.find(j => j.id === jid);
    const pts = jig.checkpoints;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= pts.length) return;
    [pts[idx], pts[newIdx]] = [pts[newIdx], pts[idx]];
    // ⚠️ FIX: สลับ id (item_id) ตามตำแหน่งใหม่ด้วย — เพราะตอนโหลด/sync จาก Supabase
    // ระบบจะ sort checkpoints ตาม item_id เสมอ (ไม่ได้จำลำดับที่จัดไว้แยกต่างหาก)
    // ถ้าสลับแค่ตำแหน่งใน array แต่ไม่สลับ id ด้วย พอ sync รอบถัดไปมันจะ sort กลับไป
    // ตามลำดับ id เดิม ทำให้ดูเหมือนลำดับที่จัด "เด้งกลับ" ไปเป็นแบบเดิม
    [pts[idx].id, pts[newIdx].id] = [pts[newIdx].id, pts[idx].id];
    saveCatalog();
    renderCpList(jid);
    renderAdmCpMap(jid);
    if (selection.jigId === jid) renderSvgMap();
  }

  /* ── ตั้งค่าหัวข้อตรวจให้เป็นแบบ "กรอกค่าตัวเลข" พร้อมช่วงที่ยอมรับได้ (min-max)
     แทนการกดปุ่ม ✔/✖/🔧 ปกติ — ใช้กับหัวข้อวัดค่า เช่น แรงดันลม, แรงบิด, ระยะห่าง ── */
  function configureNumericCheckpoint(jid, idx) {
    const jig = catalog.jigs.find(j => j.id === jid);
    const p = jig.checkpoints[idx];
    if (!p) return;

    if (p.type === 'numeric') {
      if (!confirm(`เปลี่ยน "${p.label}" กลับเป็นแบบ ปกติ/ไม่ปกติ (Pass/Fail) แทนการกรอกตัวเลขหรือไม่?`)) return;
      delete p.type; delete p.min; delete p.max; delete p.unit;
      saveCatalog();
      renderCpList(jid);
      toast(`เปลี่ยน "${p.label}" กลับเป็นแบบ Pass/Fail แล้ว`, 'ok');
      return;
    }

    const minStr = prompt(`ค่าต่ำสุดที่ยอมรับได้สำหรับ "${p.label}" (เช่น 0.4)`, p.min ?? '');
    if (minStr === null) return;
    const maxStr = prompt(`ค่าสูงสุดที่ยอมรับได้ (เช่น 0.6)`, p.max ?? '');
    if (maxStr === null) return;
    const unit = prompt(`หน่วย (เช่น Mpa, mm, kg — เว้นว่างได้)`, p.unit ?? '');
    if (unit === null) return;

    const min = parseFloat(minStr), max = parseFloat(maxStr);
    if (isNaN(min) || isNaN(max)) { toast('กรุณาใส่ค่าต่ำสุด/สูงสุดเป็นตัวเลข', 'ng'); return; }
    if (min > max) { toast('ค่าต่ำสุดต้องไม่มากกว่าค่าสูงสุด', 'ng'); return; }

    p.type = 'numeric'; p.min = min; p.max = max; p.unit = unit.trim();
    saveCatalog();
    renderCpList(jid);
    toast(`ตั้งค่า "${p.label}" เป็นหัวข้อกรอกตัวเลข (${min}-${max}${unit.trim() ? ' ' + unit.trim() : ''}) แล้ว`, 'ok');
  }

  /* ── สถานะรูปพื้นหลังใน Admin ── */
  function renderCpBgControls(jid) {
    const jig = catalog.jigs.find(j => j.id === jid);
    if (!jig) return;
    const hasImg = !!jig.bgImage;
    $('btn-cp-bg-remove').classList.toggle('hidden', !hasImg);
    $('cp-bg-status').textContent = hasImg
      ? '✅ มีรูปพื้นหลังกำหนดเองแล้ว — ใช้แสดงในหน้าตรวจสอบของ JIG นี้'
      : 'ℹ️ ยังไม่มีรูปพื้นหลัง — ใช้แผนผังเริ่มต้น';
  }

  /* ── วาดแผนผังลากจุดใน Admin Panel ── */
  function renderAdmCpMap(jid) {
    const jig = catalog.jigs.find(j => j.id === jid);
    if (!jig) return;
    const bgImg = $('adm-cp-bg-image');
    if (jig.bgImage) { bgImg.setAttribute('href', jig.bgImage); bgImg.style.display = ''; }
    else { bgImg.style.display = 'none'; }

    const pts = jig.checkpoints || [];
    const group = $('adm-cp-points-group');
    group.innerHTML = pts.map((p, i) => `
      <g class="svg-pt cp-drag-pt" data-id="${p.id}" transform="translate(${p.x},${p.y})">
        <circle class="pt-pulse" r="14"/><circle class="pt-core" r="8"/><text y="4" class="pt-label">${i + 1}</text>
      </g>`).join('');
    bindCpDrag(jid);
  }

  /* ── ลากจุดเพื่อจัดตำแหน่ง (Pointer Events) ── */
  function bindCpDrag(jid) {
    const svg = $('adm-cp-map');
    svg.querySelectorAll('.cp-drag-pt').forEach(g => {
      g.addEventListener('pointerdown', e => {
        e.preventDefault();
        g.setPointerCapture(e.pointerId);
        g.classList.add('dragging');
        let lastX = null, lastY = null;

        const toSvgPoint = ev => {
          const pt = svg.createSVGPoint();
          pt.x = ev.clientX; pt.y = ev.clientY;
          const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
          return {
            x: Math.max(10, Math.min(590, Math.round(loc.x))),
            y: Math.max(10, Math.min(330, Math.round(loc.y)))
          };
        };
        const onMove = ev => {
          const { x, y } = toSvgPoint(ev);
          g.setAttribute('transform', `translate(${x},${y})`);
          lastX = x; lastY = y;
        };
        const onUp = () => {
          svg.removeEventListener('pointermove', onMove);
          svg.removeEventListener('pointerup', onUp);
          g.classList.remove('dragging');
          if (lastX !== null) {
            const jig = catalog.jigs.find(j => j.id === jid);
            const cp = jig && jig.checkpoints.find(p => p.id === parseInt(g.dataset.id));
            if (cp) {
              cp.x = lastX; cp.y = lastY;
              saveCatalog();
              renderCpList(jid);
              if (selection.jigId === jid) renderSvgMap(); // sync กับหน้าตรวจสอบถ้าเปิด JIG เดียวกันอยู่
            }
          }
        };
        svg.addEventListener('pointermove', onMove);
        svg.addEventListener('pointerup', onUp);
      });
    });
  }

  /* ── กรองรายการ JIG ตามคำค้นหา (ชื่อ/รหัส/Line) — ซ่อนแถวที่ไม่ตรง และซ่อนหัวข้อกลุ่มถ้าไม่เหลือ JIG ที่ตรงในกลุ่มนั้น ── */
  function filterJigList() {
    const searchInput = $('adm-jig-search');
    if (!searchInput) return;
    const q = searchInput.value.trim().toLowerCase();
    const rows = document.querySelectorAll('#adm-jig-list .adm-item[data-search]');
    rows.forEach(row => {
      row.classList.toggle('hidden', !!q && !row.dataset.search.includes(q));
    });
    document.querySelectorAll('#adm-jig-list .adm-group-header').forEach(header => {
      const groupKey = header.dataset.group;
      const hasVisible = Array.from(document.querySelectorAll(`#adm-jig-list .adm-item[data-group="${CSS.escape(groupKey)}"]`))
        .some(row => !row.classList.contains('hidden'));
      header.classList.toggle('hidden', !hasVisible);
    });
    const countEl = $('adm-jig-count');
    if (countEl) {
      const visible = Array.from(rows).filter(r => !r.classList.contains('hidden')).length;
      countEl.textContent = q ? `${visible}/${rows.length} JIG` : `${rows.length} JIG`;
    }
  }

  function renderAdminLists() {
    /* Dept list */
    $('adm-dept-list').innerHTML = catalog.depts.length
      ? catalog.depts.map(d => `
          <div class="adm-item">
            <div class="adm-item-info">
              <div>${escHtml(d.name)}</div>
              <div class="adm-item-code">${escHtml(d.id)}</div>
            </div>
            <button class="adm-item-edit" data-etype="dept" data-id="${escHtml(d.id)}">✏️</button>
            <button class="adm-item-del" data-dtype="dept" data-id="${escHtml(d.id)}">🗑</button>
          </div>`).join('')
      : '<div class="adm-item" style="color:var(--text-muted);font-style:italic">ยังไม่มีแผนก</div>';

    /* Line list */
    $('adm-line-list').innerHTML = catalog.lines.length
      ? catalog.lines.map(l => {
          const dept = catalog.depts.find(d => d.id === l.deptId);
          return `<div class="adm-item">
            <div class="adm-item-info">
              <div>${escHtml(l.name)}</div>
              <div class="adm-item-code">${escHtml(l.id)} · ${escHtml(dept ? dept.name : l.deptId)}</div>
            </div>
            <button class="adm-item-edit" data-etype="line" data-id="${escHtml(l.id)}">✏️</button>
            <button class="adm-item-del" data-dtype="line" data-id="${escHtml(l.id)}">🗑</button>
          </div>`;}).join('')
      : '<div class="adm-item" style="color:var(--text-muted);font-style:italic">ยังไม่มี Line</div>';

    /* JIG list — จัดกลุ่มตาม Line และรองรับค้นหา (จำเป็นเมื่อมี JIG หลายร้อยตัว) */
    if (!catalog.jigs.length) {
      $('adm-jig-list').innerHTML = '<div class="adm-item" style="color:var(--text-muted);font-style:italic">ยังไม่มี JIG</div>';
    } else {
      const jigsSorted = [...catalog.jigs].sort((a, b) => {
        const la = catalog.lines.find(l => l.id === a.lineId);
        const lb = catalog.lines.find(l => l.id === b.lineId);
        return (la ? la.name : 'ไม่ระบุ Line').localeCompare(lb ? lb.name : 'ไม่ระบุ Line', 'th');
      });
      let html = '', lastLineId = '\u0000';
      jigsSorted.forEach(j => {
        const line = catalog.lines.find(l => l.id === j.lineId);
        const groupKey = j.lineId || '__none__';
        if (groupKey !== lastLineId) {
          html += `<div class="adm-group-header" data-group="${escHtml(groupKey)}">📍 ${escHtml(line ? line.name : 'ไม่ระบุ Line')}</div>`;
          lastLineId = groupKey;
        }
        const searchText = `${j.name} ${j.id} ${line ? line.name : ''}`.toLowerCase();
        html += `<div class="adm-item" data-group="${escHtml(groupKey)}" data-search="${escHtml(searchText)}">
          <div class="adm-item-info">
            <div>🔧 ${escHtml(j.name)}</div>
            <div class="adm-item-code">${escHtml(j.id)} · ${escHtml(line ? line.name : j.lineId)}</div>
          </div>
          <button class="adm-item-edit" data-etype="jig" data-id="${escHtml(j.id)}">✏️</button>
          <button class="adm-item-del" data-dtype="jig" data-id="${escHtml(j.id)}">🗑</button>
        </div>`;
      });
      $('adm-jig-list').innerHTML = html;
    }
    filterJigList(); // เผื่อผู้ใช้พิมพ์ค้นหาค้างอยู่ตอนที่ list ถูก re-render (เช่น หลังลบ)

    /* 🔧 FIXED: Event Delegation — Attach handlers once using global functions
       ไม่ต้องสร้าง listeners ทีละปุ่ม แล้วใช้ event.target.closest() ตรวจจับ
       เพื่อป้องกัน memory leak ของ listeners ที่สะสมกันเรื่อยๆ */
    if (!_editHandlerAttached) {
      document.addEventListener('click', handleAdminEdit);
      _editHandlerAttached = true;
    }
    if (!_deleteHandlerAttached) {
      document.addEventListener('click', handleAdminDelete);
      _deleteHandlerAttached = true;
    }

    /* Refresh selects in admin */
    $('adm-line-dept').innerHTML = '<option value="">เลือกแผนก</option>' +
      catalog.depts.map(d => `<option value="${escHtml(d.id)}">${escHtml(d.name)}</option>`).join('');
    $('adm-jig-dept').innerHTML = '<option value="">แผนก</option>' +
      catalog.depts.map(d => `<option value="${escHtml(d.id)}">${escHtml(d.name)}</option>`).join('');
    $('adm-jig-line').innerHTML = '<option value="">Line</option>';
    
    // Checkpoints editor dropdown — เก็บค่าที่เลือกอยู่ไว้ก่อน แล้วใส่กลับหลัง re-render
    // (ป้องกันปัญหา: realtime sync เรียก renderAdminLists() แทรกกลางคันตอนแก้ไขจุดตรวจ
    //  แล้ว dropdown รีเซ็ตเป็นค่าว่าง ทำให้ user ต้องเลือก JIG ใหม่)
    const cpJigSel = $('adm-cp-jig');
    const prevCpJig = cpJigSel.value;
    // จัดกลุ่ม JIG ตาม Line (แสดงเป็น "แผนก › Line") เพื่อให้หาง่ายขึ้นตอน JIG เยอะๆ
    const jigsByLine = new Map(); // lineId -> jigs[]
    const orphanJigs = [];
    catalog.jigs.forEach(j => {
      if (j.lineId && catalog.lines.some(l => l.id === j.lineId)) {
        if (!jigsByLine.has(j.lineId)) jigsByLine.set(j.lineId, []);
        jigsByLine.get(j.lineId).push(j);
      } else {
        orphanJigs.push(j);
      }
    });
    let cpJigOptionsHtml = '<option value="">เลือก JIG เพื่อแก้ไขจุดตรวจ...</option>';
    catalog.lines.forEach(l => {
      const jigsInLine = jigsByLine.get(l.id);
      if (!jigsInLine || !jigsInLine.length) return;
      const dept = catalog.depts.find(d => d.id === l.deptId);
      const groupLabel = dept ? `${dept.name} › ${l.name}` : l.name;
      cpJigOptionsHtml += `<optgroup label="${escHtml(groupLabel)}">` +
        jigsInLine.map(j => `<option value="${escHtml(j.id)}">${escHtml(j.id)} - ${escHtml(j.name)}</option>`).join('') +
        `</optgroup>`;
    });
    if (orphanJigs.length) {
      cpJigOptionsHtml += `<optgroup label="อื่นๆ (ไม่มี Line)">` +
        orphanJigs.map(j => `<option value="${escHtml(j.id)}">${escHtml(j.id)} - ${escHtml(j.name)}</option>`).join('') +
        `</optgroup>`;
    }
    cpJigSel.innerHTML = cpJigOptionsHtml;
    
    // re-bind dropdown event listener หลังจากเปลี่ยน innerHTML
    // (innerHTML ใหม่ = element ใหม่ = event listener หลัง bind ก่อนหน้าหายไป)
    bindCpJigDropdown();
    
    // ใส่ค่ากลับและ trigger change event เพื่อให้แพนเนลแก้ไข (cp-editor) render จุดตรวจใหม่
    // โดยเฉพาะกรณีที่ realtime sync เกิดขึ้นขณะ user กำลังแก้ไข checkpoint อยู่ ต้องให้ list update
    if (prevCpJig && catalog.jigs.some(j => j.id === prevCpJig)) {
      cpJigSel.value = prevCpJig;
      cpJigSel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  /* ══════════════════════════════════════
     HISTORY PANEL
  ══════════════════════════════════════ */
  function bindHistoryPanel() {
    $('tab-history').addEventListener('click', () => { openPanel('history-panel'); populateHistoryPanel(); });
    $('btn-close-hist').addEventListener('click', () => closePanel('history-panel'));
    $('btn-hf-apply').addEventListener('click', populateHistoryPanel);
    $('btn-hf-clear').addEventListener('click', () => {
      $('hf-start').value = ''; $('hf-end').value = '';
      $('hf-dept').value = ''; $('hf-shift').value = '';
      populateHistoryPanel();
    });
    $('btn-hf-pdf').addEventListener('click', () => {
      const hist = loadHistory();
      if (!hist.length) { toast('ไม่มีประวัติให้ส่งออก', 'ng'); return; }
      generatePdf(hist[0]);
    });
  }

  function populateHistoryPanel() {
    // Populate dept filter
    const deptSel = $('hf-dept');
    deptSel.innerHTML = '<option value="">ทั้งหมด</option>' +
      catalog.depts.map(d => `<option value="${escHtml(d.id)}">${escHtml(d.name)}</option>`).join('');

    let hist = loadHistory();
    const start = $('hf-start').value;
    const end   = $('hf-end').value;
    const dept  = $('hf-dept').value;
    const shift = $('hf-shift').value;
    if (start) hist = hist.filter(h => h.date >= start);
    if (end)   hist = hist.filter(h => h.date <= end);
    if (dept)  hist = hist.filter(h => h.deptId === dept);
    if (shift) hist = hist.filter(h => h.shift === shift);

    const totalOk = hist.filter(h => h.items.every(i => i.status === 'ok' || i.status === 'fixed')).length;
    $('hist-summary').innerHTML = `
      <div class="hist-stat all"><span class="n">${hist.length}</span><span class="l">ทั้งหมด</span></div>
      <div class="hist-stat ok"><span class="n">${totalOk}</span><span class="l">ผ่าน</span></div>
      <div class="hist-stat ng"><span class="n">${hist.length - totalOk}</span><span class="l">มี NG</span></div>`;

    const list = $('hist-list');
    if (!hist.length) { list.innerHTML = '<div class="no-records">ไม่พบประวัติ</div>'; return; }
    list.innerHTML = hist.map(h => {
      const ngItems = h.items.filter(i => i.status === 'ng');
      const okCount = h.items.filter(i => i.status === 'ok' || i.status === 'fixed').length;
      const photos  = h.items.flatMap(i => i.photos || []);
      
      // ─── GPS Status ─── 
      let gpsDisplay = '';
      if (h.gps) {
        if (h.gps.status === 'success') {
          gpsDisplay = `<span class="gps-badge success" title="GPS: ${h.gps.latitude}, ${h.gps.longitude} (accuracy: ±${Math.round(h.gps.accuracy)}m)">📍 ${h.gps.latitude.toFixed(6)}, ${h.gps.longitude.toFixed(6)}</span>`;
        } else if (h.gps.status === 'denied') {
          gpsDisplay = `<span class="gps-badge denied" title="ผู้ใช้ปฏิเสธการใช้ GPS">❌ ปฏิเสธ GPS</span>`;
        } else if (h.gps.status === 'timeout') {
          gpsDisplay = `<span class="gps-badge timeout" title="GPS หาพิกัดไม่ได้ (หมดเวลา)">⏱ หมดเวลา GPS</span>`;
        } else if (h.gps.status === 'error') {
          gpsDisplay = `<span class="gps-badge error" title="GPS ผิดพลาด">⚠️ GPS Error</span>`;
        } else if (h.gps.status === 'unsupported') {
          gpsDisplay = `<span class="gps-badge unsupported" title="อุปกรณ์ไม่รองรับ GPS">❓ GPS ไม่รองรับ</span>`;
        }
      }
      
      return `<div class="history-item">
        <div class="hi-path">${escHtml(h.deptName || '')}  ›  ${escHtml(h.lineName || '')}  ›  ${escHtml(h.jigName || '')}</div>
        <div class="hi-head">
          <div class="hi-meta"><strong>${escHtml(h.date)}</strong> เวลา: ${new Date(h.timestamp).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} · ${escHtml(h.shift)} · ผู้ตรวจ: ${escHtml(h.inspector)}</div>
          <div class="hi-badges">
            <span class="badge ok">OK ${okCount}</span>
            ${ngItems.length ? `<span class="badge ng">NG ${ngItems.length}</span>` : ''}
            ${gpsDisplay}
          </div>
        </div>
        ${ngItems.length ? `<div class="hi-ng-list">
          ${ngItems.map(i => `<div class="hi-ng-item">
            <span class="hi-ng-label">❌ ข้อ ${i.id}: ${escHtml(i.label || '')}</span>
            ${i.value != null && i.value !== '' ? `<span class="hi-ng-value">ค่าที่วัดได้: ${escHtml(String(i.value))}${escHtml(i.unit || '')}</span>` : ''}
            ${i.note ? `<span class="hi-ng-note">หมายเหตุ: ${escHtml(i.note)}</span>` : `<span class="hi-ng-note hi-ng-note-empty">ไม่ได้ระบุรายละเอียดความผิดปกติ</span>`}
          </div>`).join('')}
        </div>` : ''}
        ${photos.length  ? `<div class="hi-photos">${photos.slice(0,4).map(p=>`<img src="${escHtml(p)}" class="hi-photo" data-src="${escHtml(p)}">`).join('')}</div>` : ''}
        ${(h.sigInspector||h.sigSupervisor) ? `<div class="hi-sigs" style="font-size:11px; color:var(--text-main); margin-top:6px; display:flex; gap:16px;">
          ${h.sigInspector?`<div><strong>ผู้ตรวจ:</strong> ${escHtml(h.sigInspector)}</div>`:''}
          ${h.sigSupervisor?`<div><strong>หัวหน้า:</strong> ${escHtml(h.sigSupervisor)}</div>`:''}
        </div>` : ''}
        <div class="hi-actions">
          <button class="hi-btn" data-pdf="${escHtml(h.id)}">📄 PDF</button>
          <button class="hi-btn del" data-del="${escHtml(h.id)}">🗑 ลบ</button>
        </div>
      </div>`;
    }).join('');

    // Bind dynamic buttons
    list.querySelectorAll('[data-pdf]').forEach(b => b.addEventListener('click', () => {
      const rec = loadHistory().find(h => String(h.id) === b.dataset.pdf);
      if (rec) generatePdf(rec);
    }));
    list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('ลบรายการนี้?')) return;
      const delId = b.dataset.del;
      const remaining = loadHistory().filter(h => String(h.id) !== delId);
      localStorage.setItem(SK.history, JSON.stringify(remaining)); // อัปเดต local ทันที
      deleteHistoryFromSupabase(delId); // ลบเฉพาะแถวนี้จริงๆ บน Supabase (ไม่กระทบแถวอื่น)
      populateHistoryPanel(); toast('ลบแล้ว', 'ok');
    }));
    list.querySelectorAll('.hi-photo').forEach(img => {
      img.addEventListener('click', () => openLightbox(img.dataset.src));
    });
  }

  /* ══════════════════════════════════════
     PDF GENERATION (jsPDF + html2canvas)
     — jsPDF's built-in fonts (Helvetica) have no Thai
       glyphs, which is why Thai text used to render as
       garbled boxes. To fix this we build the report as
       real HTML (using the page's own Thai web fonts —
       Noto Sans Thai / Sarabun), rasterize it with
       html2canvas, then place that image into the PDF.
       This guarantees correct Thai rendering regardless
       of what fonts jsPDF ships with.
  ══════════════════════════════════════ */
  function statusLabel(status) {
    return status === 'ok' ? 'ผ่าน (OK)'
         : status === 'ng' ? 'ไม่ผ่าน (NG)'
         : status === 'fixed' ? 'แก้ไขแล้ว'
         : 'รอตรวจ';
  }
  function statusRowClass(status) {
    return status === 'ok' ? 'pdf-row-ok'
         : status === 'ng' ? 'pdf-row-ng'
         : status === 'fixed' ? 'pdf-row-fixed'
         : 'pdf-row-pending';
  }

  function buildPdfReportHtml(record) {
    const rows = record.items.map((item, i) => `
      <tr class="${statusRowClass(item.status)}">
        <td>${i + 1}</td>
        <td>${escHtml(item.label)}</td>
        <td>${item.value != null ? escHtml(String(item.value)) + (item.unit ? ' ' + escHtml(item.unit) : '') : ''}</td>
        <td>${statusLabel(item.status)}</td>
        <td>${item.note ? escHtml(item.note) : ''}</td>
      </tr>`).join('');

    return `
      <div class="pdf-title">JIG Inspection Report</div>
      <div class="pdf-subtitle">${escHtml(record.jigName)} | ${escHtml(record.jigDocNo)}</div>
      <div class="pdf-subtitle">${escHtml(record.deptName)} &gt; ${escHtml(record.lineName)}</div>
      <div class="pdf-meta-row">
        <span>ผู้ตรวจสอบ: ${escHtml(record.inspector)}</span>
        <span>วันที่: ${escHtml(record.date)}  เวลา: ${new Date(record.timestamp).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}  กะ: ${escHtml(record.shift)}</span>
      </div>
      <table class="pdf-table">
        <thead>
          <tr><th style="width:6%">No</th><th style="width:38%">จุดตรวจสอบ</th><th style="width:14%">ค่าที่วัดได้</th><th style="width:18%">สถานะ</th><th style="width:24%">หมายเหตุ</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${record.notes ? `<div class="pdf-notes"><strong>หมายเหตุ:</strong> ${escHtml(record.notes)}</div>` : ''}
      <div class="pdf-sig-row">
        <div>
          <div>${record.sigInspector ? `( ${escHtml(record.sigInspector)} )` : '(\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0)'}</div>
          <div class="pdf-sig-line">ผู้ตรวจสอบ</div>
        </div>
        <div>
          <div>${record.sigSupervisor ? `( ${escHtml(record.sigSupervisor)} )` : '(\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0)'}</div>
          <div class="pdf-sig-line">หัวหน้างาน</div>
        </div>
      </div>`;
  }

  async function generatePdf(record) {
    if (!window.jspdf) { toast('jsPDF โหลดไม่สำเร็จ', 'ng'); return; }
    if (!window.html2canvas) { toast('html2canvas โหลดไม่สำเร็จ', 'ng'); return; }
    const { jsPDF } = window.jspdf;

    // Build the report off-screen as real HTML so the browser's
    // Thai web fonts are used for shaping/rendering.
    const container = document.createElement('div');
    container.className = 'pdf-export-root';
    container.innerHTML = buildPdfReportHtml(record);
    document.body.appendChild(container);

    // Make sure Thai web fonts are actually loaded before rasterizing,
    // otherwise html2canvas may capture a fallback font mid-swap.
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    } catch (e) { /* ignore */ }

    try {
      const canvas = await html2canvas(container, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true
      });

      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;

      let heightLeft = imgH;
      let position = 0;
      doc.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
      heightLeft -= pageH;

      while (heightLeft > 0) {
        position -= pageH;
        doc.addPage();
        doc.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
        heightLeft -= pageH;
      }

      doc.save(`JIG_${record.jigId}_${record.date}_${record.shift}.pdf`);
      toast('📄 ส่งออก PDF สำเร็จ!', 'ok');
    } catch (err) {
      console.error('generatePdf error:', err);
      toast('สร้าง PDF ไม่สำเร็จ', 'ng');
    } finally {
      document.body.removeChild(container);
    }
  }

  /* ══════════════════════════════════════
     MOCK DATA GENERATOR
  ══════════════════════════════════════ */
  /* ══════════════════════════════════════
     PANEL HELPERS
  ══════════════════════════════════════ */
  function openPanel(id) {
    document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
    $(id).classList.add('open');
    $('panel-overlay').classList.add('show');
  }
  function closePanel(id) {
    $(id).classList.remove('open');
    $('panel-overlay').classList.remove('show');
  }
  function bindPanelOverlay() {
    $('panel-overlay').addEventListener('click', () => {
      document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
      $('panel-overlay').classList.remove('show');
    });
  }

  /* ══════════════════════════════════════
     ACTION BUTTONS
  ══════════════════════════════════════ */
  function bindActionButtons() {
    $('btn-submit').addEventListener('click', submitReport);
    $('btn-reset').addEventListener('click', () => {
      if (!confirm('ล้างผลการตรวจและเริ่มใหม่?')) return;
      initCheckState();
      renderChecklist();
      updateStats();
      $('inp-inspector').value = '';
      $('inp-date').value = new Date().toISOString().slice(0, 10);
      $('inp-shift').value = '';
      $('inp-month').value = currentThaiMonthAbbr();
      $('report-notes').value = '';
      $('sig-inspector').value = '';
      $('sig-supervisor').value = '';
      toast('เริ่มต้นใหม่เรียบร้อย', 'ok');
    });
    // SVG points (bound after inspection cards shown)
    document.addEventListener('click', e => {
      const g = e.target.closest('.svg-pt');
      if (!g) return;
      const pt  = parseInt(g.dataset.point);
      const idx = checkState.findIndex(i => i.id === pt);
      if (idx < 0) return;
      document.querySelectorAll('.check-item').forEach(el => el.classList.remove('highlight'));
      const el = $('checklist-wrapper') && $('checklist-wrapper').querySelector(`.check-item[data-idx="${idx}"]`);
      if (el) { el.classList.add('highlight'); el.scrollIntoView({ behavior:'smooth', block:'center' }); }
      document.querySelectorAll('.svg-pt').forEach(p => p.classList.remove('active'));
      g.classList.add('active');
    });
  }

  /* ══════════════════════════════════════
     THEME TOGGLE
     ค่าเริ่มต้นคือธีมสว่าง — จำธีมที่ผู้ใช้เลือกไว้ล่าสุดไว้ใน localStorage
  ══════════════════════════════════════ */
  const THEME_KEY = 'jig_theme';

  function syncThemeIcons() {
    const current = document.documentElement.getAttribute('data-theme');
    qs('.icon-moon').style.display = current === 'dark'  ? '' : 'none';
    qs('.icon-sun').style.display  = current === 'light' ? '' : 'none';
  }

  function bindThemeToggle() {
    syncThemeIcons(); // ให้ไอคอนตรงกับธีมจริงตอนโหลดหน้า (เผื่อเคยตั้งเป็น dark ไว้)
    $('theme-toggle').addEventListener('click', () => {
      const html = document.documentElement;
      const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
      syncThemeIcons();
    });
  }

  /* ══════════════════════════════════════
     LIGHTBOX
  ══════════════════════════════════════ */
  function bindLightbox() {
    const lb = $('lightbox');
    lb.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
    lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
  }
  function openLightbox(src) { $('lightbox-img').src = src; $('lightbox').classList.add('open'); }
  function closeLightbox() { $('lightbox').classList.remove('open'); $('lightbox-img').src = ''; }

  /* ══════════════════════════════════════
     TOAST
  ══════════════════════════════════════ */
  function toast(msg, type) {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast show ${type || 'ok'}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  /* ══════════════════════════════════════
     LIVE CLOCK (Dashboard)
  ══════════════════════════════════════ */
  function startDashClock() {
    const dateEl = $('dash-clock-date');
    const timeEl = $('dash-clock-time');
    if (!dateEl || !timeEl) return;
    function tick() {
      const now = new Date();
      dateEl.textContent = now.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      timeEl.textContent = `${hh}:${mm}:${ss}`;
    }
    tick();
    setInterval(tick, 1000);
  }

  /* ══════════════════════════════════════
     ADMIN PANEL — DRAG TO RESIZE
     ลากขอบซ้ายของ Admin Panel เพื่อขยาย/หดขนาดหน้าต่าง
     จำขนาดที่ตั้งไว้ล่าสุดไว้ใน localStorage (เฉพาะจอที่กว้างพอ)
  ══════════════════════════════════════ */
  const PANEL_WIDTH_KEY = 'jig_admin_panel_width';
  const PANEL_MIN_W = 320;

  function initPanelResize() {
    const panel  = $('admin-panel');
    const handle = $('admin-resize-handle');
    if (!panel || !handle) return;

    const maxWidth = () => Math.min(1400, window.innerWidth - 40);

    // คืนค่าความกว้างที่เคยตั้งไว้ (เฉพาะจอ desktop/tablet ที่กว้างพอ — บนมือถือให้เต็มจอเสมอ)
    if (window.innerWidth > 640) {
      const saved = parseInt(localStorage.getItem(PANEL_WIDTH_KEY), 10);
      if (saved && saved >= PANEL_MIN_W) {
        panel.style.width = Math.min(saved, maxWidth()) + 'px';
      }
    }

    let dragging = false, startX = 0, startWidth = 0;

    function beginDrag(clientX) {
      dragging = true;
      startX = clientX;
      startWidth = panel.getBoundingClientRect().width;
      handle.classList.add('dragging');
      panel.classList.add('resizing');
      document.body.style.userSelect = 'none';
    }
    function moveDrag(clientX) {
      if (!dragging) return;
      // panel ยึดขอบขวาจอ — ลากขอบซ้ายไปทางซ้าย (clientX ลดลง) = ขยายกว้างขึ้น
      const delta = startX - clientX;
      const newWidth = Math.max(PANEL_MIN_W, Math.min(maxWidth(), startWidth + delta));
      panel.style.width = newWidth + 'px';
    }
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      panel.classList.remove('resizing');
      document.body.style.userSelect = '';
      localStorage.setItem(PANEL_WIDTH_KEY, Math.round(panel.getBoundingClientRect().width));
    }

    handle.addEventListener('mousedown', e => { beginDrag(e.clientX); e.preventDefault(); });
    document.addEventListener('mousemove', e => moveDrag(e.clientX));
    document.addEventListener('mouseup', endDrag);

    handle.addEventListener('touchstart', e => beginDrag(e.touches[0].clientX), { passive: true });
    document.addEventListener('touchmove', e => { if (dragging) moveDrag(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('touchend', endDrag);

    // ดับเบิลคลิกที่ขอบ = รีเซ็ตกลับขนาดเริ่มต้น
    handle.addEventListener('dblclick', () => {
      panel.style.width = '';
      localStorage.removeItem(PANEL_WIDTH_KEY);
    });
  }

  /* ══════════════════════════════════════
     CHANGE JIG BUTTON + INIT
  ══════════════════════════════════════ */
  /* ─── ตรวจสอบ GPS Status (เร็ว + Auto-retry) ─── */
  async function checkGPSStatus() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(false);
        return;
      }
      
      // ลดเวลา timeout จาก 3000 → 1500 ms (เร็วขึ้น 2 เท่า)
      const timeout = setTimeout(() => resolve(false), 1500);
      navigator.geolocation.getCurrentPosition(
        () => { clearTimeout(timeout); resolve(true); },
        () => { clearTimeout(timeout); resolve(false); }
      );
    });
  }

  async function checkGPSStatusOnLoad() {
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      const gpsEnabled = await checkGPSStatus();
      if (gpsEnabled) {
        $('gps-alert-modal').classList.add('hidden');
        return;
      }
      attempts++;
      
      // ถ้า retry ยังไม่พร้อม ให้ show modal
      if (attempts >= maxAttempts) {
        $('gps-alert-modal').classList.remove('hidden');
      } else {
        // retry automatic เร็ว ๆ
        await new Promise(r => setTimeout(r, 400));
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('btn-change-jig').addEventListener('click', () => {
      selection.jigId = null;
      hideInspectionCards();
      renderFilter();
      $('filter-card').scrollIntoView({ behavior:'smooth', block:'start' });
    });

    bindTabNav();
    bindDashboard();
    bindAiPanel();
    startDashClock();
    initPanelResize();
    init();
    
    // ─── GPS Check Button (เร็ว + Auto-retry) ───
    $('btn-gps-check').addEventListener('click', async () => {
      $('btn-gps-check').disabled = true;
      $('btn-gps-check').textContent = '🔄 กำลังเช็ค GPS...';
      
      // try multiple times automatically
      let success = false;
      for (let i = 0; i < 3; i++) {
        const gpsEnabled = await checkGPSStatus();
        if (gpsEnabled) {
          success = true;
          break;
        }
        if (i < 2) await new Promise(r => setTimeout(r, 300));
      }
      
      if (success) {
        $('gps-alert-modal').classList.add('hidden');
        toast('✅ GPS เปิดสำเร็จ!', 'ok');
      } else {
        toast('❌ GPS ยังไม่เปิด โปรดเปิด GPS ในอุปกรณ์', 'ng');
      }
      
      $('btn-gps-check').disabled = false;
      $('btn-gps-check').textContent = '✓ เช็ค GPS ใหม่';
    });
  });

  /* ══════════════════════════════════════
     TAB NAVIGATION
  ══════════════════════════════════════ */
  function bindTabNav() {
    document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $('view-inspect').classList.toggle('hidden', tab !== 'inspect');
        $('view-dashboard').classList.toggle('hidden', tab !== 'dashboard');
        if (tab === 'dashboard') refreshDashboard();
      });
    });
  }

  /* ══════════════════════════════════════
     DASHBOARD
  ══════════════════════════════════════ */
  let charts = {};
  let dashMonthFilter = 'all'; // 'all' หรือ 'YYYY-MM'

  // ตัวแปรสี CSS ในระบบนี้เป็นรูปแบบ hsl(H, S%, L%) — การต่อ '22'/'aa'/'cc' ท้ายสตริง
  // (แบบ hex alpha) ทำให้ได้ค่าสีที่ผิดรูปแบบ เช่น "hsl(145, 65%, 45%)22" ซึ่ง Canvas/Chart.js
  // parse ไม่ออกและ fallback เป็นสีดำ — ฟังก์ชันนี้แปลงเป็น hsla(...) ที่ถูกต้องแทน
  function withAlpha(cssColor, alpha) {
    const c = (cssColor || '').trim();
    const hslMatch = c.match(/^hsl\(([^)]+)\)$/i);
    if (hslMatch) return `hsla(${hslMatch[1]}, ${alpha})`;
    const hslaMatch = c.match(/^hsla\(([^,]+,[^,]+,[^,]+),\s*[\d.]+\)$/i);
    if (hslaMatch) return `hsla(${hslaMatch[1]}, ${alpha})`;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
      const hex = Math.round(alpha * 255).toString(16).padStart(2, '0');
      return c + hex;
    }
    return c; // ไม่รู้จักรูปแบบ — คืนค่าเดิม
  }

  function bindDashboard() {
    $('dash-month-filter').addEventListener('change', e => {
      dashMonthFilter = e.target.value;
      refreshDashboard();
    });
  }

  function refreshDashboard() {
    const allHist = loadHistory();
    populateDashMonthOptions(allHist);
    const hist = dashMonthFilter === 'all'
      ? allHist
      : allHist.filter(h => (h.date || '').slice(0, 7) === dashMonthFilter);
    renderKpis(hist);
    renderTrendChart(hist, dashMonthFilter);
    renderByLineChart(hist);
    renderDeptDonut(hist);
    renderNgRanking(hist);
  }

  const TH_MONTHS_FULL = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];

  function formatMonthLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    return `${TH_MONTHS_FULL[m - 1]} ${y + 543}`; // แสดงเป็น พ.ศ.
  }

  /* สร้าง options ของ dropdown จากเดือนที่มีข้อมูลจริงในประวัติ (เรียงล่าสุดก่อน)
     คงค่าที่เลือกไว้เดิมถ้ายังมีอยู่ ไม่งั้น fallback กลับไปที่ "ทั้งหมด" */
  function populateDashMonthOptions(hist) {
    const months = Array.from(new Set(hist.map(h => (h.date || '').slice(0, 7)).filter(Boolean)))
      .sort().reverse();
    const sel = $('dash-month-filter');
    sel.innerHTML = '<option value="all">ทั้งหมด (All)</option>' +
      months.map(m => `<option value="${m}">${formatMonthLabel(m)}</option>`).join('');
    if (dashMonthFilter !== 'all' && months.includes(dashMonthFilter)) {
      sel.value = dashMonthFilter;
    } else {
      sel.value = 'all';
      dashMonthFilter = 'all';
    }
  }

  /* ── KPI Cards ── */
  function renderKpis(hist) {
    const total   = hist.length;
    const allNgs  = hist.flatMap(h => h.items.filter(i => i.status === 'ng'));
    const passCount = hist.filter(h => h.items.every(i => i.status === 'ok' || i.status === 'fixed')).length;
    const passRate  = total ? Math.round(passCount / total * 100) : 0;
    const jigsSeen  = new Set(hist.map(h => h.jigId)).size;

    $('kpi-n-total').textContent = total;
    $('kpi-n-pass').textContent  = passRate + '%';
    $('kpi-n-ng').textContent    = allNgs.length;
    $('kpi-n-jig').textContent   = jigsSeen;
  }

  /* ── Trend Chart (30 วันล่าสุด, หรือทุกวันในเดือนที่เลือก) ── */
  function renderTrendChart(hist, monthFilter) {
    const labels = [], passData = [], ngData = [];

    if (monthFilter && monthFilter !== 'all') {
      const [y, m] = monthFilter.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${monthFilter}-${String(d).padStart(2, '0')}`;
        labels.push(String(d));
        const dayRecs = hist.filter(h => h.date === key);
        passData.push(dayRecs.filter(h => h.items.every(i => i.status === 'ok' || i.status === 'fixed')).length);
        ngData.push(dayRecs.filter(h => h.items.some(i => i.status === 'ng')).length);
      }
      $('trend-title-text').textContent = `แนวโน้มการตรวจสอบ (${formatMonthLabel(monthFilter)})`;
    } else {
      const days = 30;
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        labels.push(key.slice(5)); // MM-DD
        const dayRecs = hist.filter(h => h.date === key);
        passData.push(dayRecs.filter(h => h.items.every(i => i.status === 'ok' || i.status === 'fixed')).length);
        ngData.push(dayRecs.filter(h => h.items.some(i => i.status === 'ng')).length);
      }
      $('trend-title-text').textContent = 'แนวโน้มการตรวจสอบ (30 วัน)';
    }
    const style = getComputedStyle(document.documentElement);
    const ok  = style.getPropertyValue('--ok').trim();
    const ng  = style.getPropertyValue('--ng').trim();
    const muted = style.getPropertyValue('--text-muted').trim();

    if (charts.trend) charts.trend.destroy();
    charts.trend = new Chart($('chart-trend'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'ผ่าน', data: passData, borderColor: ok, backgroundColor: withAlpha(ok, 0.13), fill: true, tension: 0.4, pointRadius: 3 },
          { label: 'NG',   data: ngData,   borderColor: ng, backgroundColor: withAlpha(ng, 0.13), fill: true, tension: 0.4, pointRadius: 3 },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: muted, font: { size: 10 } }, grid: { color: 'rgba(128,128,128,0.08)' } },
          y: { ticks: { color: muted, font: { size: 10 }, stepSize: 1 }, grid: { color: 'rgba(128,128,128,0.08)' }, beginAtZero: true }
        }
      }
    });
  }

  /* ── NG by Line Bar Chart ── */
  function renderByLineChart(hist) {
    const style = getComputedStyle(document.documentElement);
    const ng  = style.getPropertyValue('--ng').trim();
    const muted = style.getPropertyValue('--text-muted').trim();

    // Count NG per line
    const counts = {};
    hist.forEach(h => {
      const ngCount = h.items.filter(i => i.status === 'ng').length;
      if (!ngCount) return;
      const key = h.lineName || h.lineId || 'Unknown';
      counts[key] = (counts[key] || 0) + ngCount;
    });
    const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 8);

    if (charts.byline) charts.byline.destroy();
    charts.byline = new Chart($('chart-byline'), {
      type: 'bar',
      data: {
        labels: sorted.map(([k]) => k.replace('LINE : ','')),
        datasets: [{ label: 'NG', data: sorted.map(([,v]) => v), backgroundColor: withAlpha(ng, 0.67), borderColor: ng, borderWidth: 1, borderRadius: 5 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: muted, font: { size: 10 }, stepSize: 1 }, grid: { color: 'rgba(128,128,128,0.08)' }, beginAtZero: true }
        }
      }
    });
  }

  /* ── Line Donut (เดิมเป็น Dept Donut — เปลี่ยนมาจัดกลุ่มตาม Line ตามที่พี่บีขอ) ── */
  function renderDeptDonut(hist) {
    const style = getComputedStyle(document.documentElement);
    const colors = [
      style.getPropertyValue('--accent').trim(),
      style.getPropertyValue('--ok').trim(),
      style.getPropertyValue('--ng').trim(),
      style.getPropertyValue('--fixed').trim(),
    ];

    const deptMap = {};
    hist.forEach(h => {
      const key = h.lineName || h.lineId || 'ไม่ระบุ';
      if (!deptMap[key]) deptMap[key] = { pass: 0, total: 0 };
      deptMap[key].total++;
      if (h.items.every(i => i.status === 'ok' || i.status === 'fixed')) deptMap[key].pass++;
    });

    const labels = Object.keys(deptMap);
    const data   = labels.map(k => deptMap[k].total);
    const bgs    = labels.map((_, i) => withAlpha(colors[i % colors.length], 0.8));

    if (charts.dept) charts.dept.destroy();
    if (!labels.length) { $('donut-legend').innerHTML = '<div style="font-size:12px;color:var(--text-muted);text-align:center">ยังไม่มีข้อมูล</div>'; return; }

    charts.dept = new Chart($('chart-dept'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: bgs, borderWidth: 2, borderColor: style.getPropertyValue('--bg-card').trim() }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { display: false }, tooltip: {
          callbacks: { label: ctx => {
            const k = ctx.label; const d = deptMap[k];
            const rate = d ? Math.round(d.pass/d.total*100) : 0;
            return ` ${ctx.parsed} ครั้ง (ผ่าน ${rate}%)`;
          }}
        }}
      }
    });

    $('donut-legend').innerHTML = labels.map((l, i) => `
      <div class="donut-legend-item">
        <div class="donut-legend-dot" style="background:${colors[i % colors.length]}"></div>
        <span>${escHtml(l)}</span>
        <span style="font-family:var(--font-en);color:var(--text-main);font-weight:600">${Math.round(deptMap[l].pass/deptMap[l].total*100)}%</span>
      </div>`).join('');
  }

  /* ── NG Ranking ── */
  function renderNgRanking(hist) {
    const counts = {};
    hist.forEach(h => {
      h.items.forEach(it => {
        if (it.status === 'ng') counts[it.id] = (counts[it.id] || { label: it.label, n: 0 }), counts[it.id].n++;
      });
    });
    // fix: simpler approach
    const tally = {};
    hist.forEach(h => h.items.forEach(it => {
      if (it.status !== 'ng') return;
      if (!tally[it.id]) tally[it.id] = { label: it.label, n: 0 };
      tally[it.id].n++;
    }));
    const sorted = Object.entries(tally).sort((a,b) => b[1].n - a[1].n).slice(0, 7);
    const max = sorted.length ? sorted[0][1].n : 1;

    const el = $('ng-ranking');
    if (!sorted.length) { el.innerHTML = '<div class="ng-rank-empty">✅ ยังไม่มีรายการ NG ในประวัติ</div>'; return; }
    el.innerHTML = sorted.map(([id, d], rank) => `
      <div class="ng-rank-item">
        <div class="ng-rank-num">${rank + 1}</div>
        <div class="ng-rank-bar-wrap">
          <div class="ng-rank-label">ข้อ ${id} — ${escHtml(d.label)}</div>
          <div class="ng-rank-bar-bg">
            <div class="ng-rank-bar-fill" style="width:${Math.round(d.n/max*100)}%"></div>
          </div>
        </div>
        <div class="ng-rank-count">${d.n} ครั้ง</div>
      </div>`).join('');
  }

  /* ══════════════════════════════════════
     AI ANALYSIS ENGINE
  ══════════════════════════════════════ */
  const AI_KEY_STORAGE = 'jig_gemini_key';

  function bindAiPanel() {
    $('btn-ai-analyze').addEventListener('click', runAiAnalysis);
    $('btn-ai-key').addEventListener('click', () => {
      const modal = $('ai-key-modal');
      modal.classList.remove('hidden');
      $('inp-api-key').value = localStorage.getItem(AI_KEY_STORAGE) || '';
    });
    $('btn-modal-close').addEventListener('click', () => $('ai-key-modal').classList.add('hidden'));
    $('ai-key-modal').addEventListener('click', e => { if (e.target === $('ai-key-modal')) $('ai-key-modal').classList.add('hidden'); });
    $('btn-save-key').addEventListener('click', () => {
      const key = $('inp-api-key').value.trim();
      if (key) { localStorage.setItem(AI_KEY_STORAGE, key); toast('บันทึก API Key แล้ว', 'ok'); }
      else { localStorage.removeItem(AI_KEY_STORAGE); toast('ลบ API Key แล้ว', 'ok'); }
      $('ai-key-modal').classList.add('hidden');
    });
  }

  /* ── Sanitize AI report HTML before rendering ──
     The Gemini response is free text from an external API. Even though
     we escape all user-entered fields going INTO the prompt, the model
     itself could still be tricked (indirect prompt injection) into
     returning raw <script>/onerror-style HTML, which would otherwise
     run when we do innerHTML = report. We allow only the small set of
     tags/attributes the prompt actually asks for. */
  function sanitizeReportHtml(html) {
    if (window.DOMPurify) {
      return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['h3', 'p', 'ul', 'li', 'strong', 'small', 'br', 'hr', 'span'],
        ALLOWED_ATTR: ['class']
      });
    }
    // DOMPurify failed to load — fail safe by escaping everything
    // rather than risking unsanitized HTML.
    console.warn('DOMPurify not available; rendering AI report as plain text.');
    return escHtml(html);
  }

  async function runAiAnalysis() {
    const hist = loadHistory();
    if (!hist.length) { toast('ยังไม่มีข้อมูลการตรวจ', 'ng'); return; }

    const btn = $('btn-ai-analyze');
    btn.classList.add('loading');
    btn.textContent = '⏳ กำลังวิเคราะห์...';
    $('ai-result').innerHTML = '<div class="ai-loading"><div class="ai-spinner"></div> กำลังประมวลผล...</div>';

    const apiKey = localStorage.getItem(AI_KEY_STORAGE);

    try {
      let report;
      if (apiKey) {
        report = await analyzeWithGemini(hist, apiKey);
      } else {
        await new Promise(r => setTimeout(r, 600)); // simulate
        report = analyzeWithSmartEngine(hist);
      }
      $('ai-result').innerHTML = `<div class="ai-report">${sanitizeReportHtml(report)}</div>`;
    } catch (err) {
      console.error('AI error:', err);
      // Fallback to smart engine
      const report = analyzeWithSmartEngine(hist);
      $('ai-result').innerHTML = `<div class="ai-report">${sanitizeReportHtml(report)}</div>`;
    }

    btn.classList.remove('loading');
    btn.innerHTML = '<span class="ai-btn-icon">✨</span> วิเคราะห์ด้วย AI';
  }

  /* ── Gemini API ── */
  async function analyzeWithGemini(hist, apiKey) {
    const summary = buildDataSummary(hist);
    const prompt = `คุณเป็น AI วิเคราะห์คุณภาพโรงงานผลิตชิ้นส่วนยานยนต์
วิเคราะห์ข้อมูลการตรวจสอบ JIG ต่อไปนี้ และให้รายงานเป็นภาษาไทย (HTML fragment):

${JSON.stringify(summary, null, 2)}

ให้รายงานครอบคลุม:
1. สรุปภาพรวม (ใช้ emoji นำหน้า)
2. จุดเสี่ยงสูงที่ต้องแก้ไขเร่งด่วน
3. แนวโน้ม (ดีขึ้น/แย่ลง/คงที่)
4. คำแนะนำเชิงป้องกัน (PM)
5. สรุป action items

ตอบเป็น HTML โดยใช้ tag: <h3>, <p>, <ul>, <li> และ class="tag-risk tag-high/tag-med/tag-low" เท่านั้น`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || analyzeWithSmartEngine(hist);
  }

  /* ── Smart Rule-Based Engine (ไม่ต้อง internet) ── */
  function buildDataSummary(hist) {
    const total = hist.length;
    const passCount = hist.filter(h => h.items.every(i => i.status === 'ok' || i.status === 'fixed')).length;
    const passRate  = total ? Math.round(passCount / total * 100) : 0;

    // NG per checkpoint
    const tally = {};
    hist.forEach(h => h.items.forEach(it => {
      if (it.status !== 'ng') return;
      if (!tally[it.id]) tally[it.id] = { label: it.label, n: 0 };
      tally[it.id].n++;
    }));

    // NG per line
    const byLine = {};
    hist.forEach(h => {
      const ngCount = h.items.filter(i => i.status === 'ng').length;
      if (!ngCount) return;
      const key = h.lineName || h.lineId || 'Unknown';
      byLine[key] = (byLine[key] || 0) + ngCount;
    });

    // Trend: compare first half vs second half of history
    const mid = Math.floor(hist.length / 2);
    const old = hist.slice(mid);
    const rec = hist.slice(0, mid);
    const oldRate = old.length ? old.filter(h => h.items.every(i=>i.status==='ok'||i.status==='fixed')).length/old.length : 0;
    const recRate = rec.length ? rec.filter(h => h.items.every(i=>i.status==='ok'||i.status==='fixed')).length/rec.length : 0;

    // Shift analysis
    const byShift = {};
    hist.forEach(h => {
      const s = h.shift || 'ไม่ระบุ';
      if (!byShift[s]) byShift[s] = { total:0, ng:0 };
      byShift[s].total++;
      if (h.items.some(i => i.status === 'ng')) byShift[s].ng++;
    });

    return { total, passRate, passCount, tally, byLine, oldRate: Math.round(oldRate*100), recRate: Math.round(recRate*100), byShift };
  }

  function analyzeWithSmartEngine(hist) {
    const s = buildDataSummary(hist);
    const topNg = Object.entries(s.tally).sort((a,b)=>b[1].n-a[1].n).slice(0,3);
    const topLine = Object.entries(s.byLine).sort((a,b)=>b[1]-a[1]).slice(0,2);
    const trend = s.recRate > s.oldRate + 5 ? 'ดีขึ้น' : s.recRate < s.oldRate - 5 ? 'แย่ลง' : 'คงที่';
    const trendIcon = trend === 'ดีขึ้น' ? '📈' : trend === 'แย่ลง' ? '📉' : '➡️';
    const trendTag  = trend === 'ดีขึ้น' ? 'tag-low' : trend === 'แย่ลง' ? 'tag-high' : 'tag-med';

    // Worst shift
    const shiftEntries = Object.entries(s.byShift).map(([k,v])=>({ k, rate: v.total ? Math.round(v.ng/v.total*100) : 0 }));
    const worstShift = shiftEntries.sort((a,b)=>b.rate-a.rate)[0];

    const riskLevel = (n, total) => {
      const r = total ? n/total : 0;
      if (r > 0.3) return 'tag-high';
      if (r > 0.1) return 'tag-med';
      return 'tag-low';
    };

    const now = new Date().toLocaleDateString('th-TH', { year:'numeric', month:'long', day:'numeric' });

    return `
      <h3>📊 สรุปภาพรวม</h3>
      <p>วิเคราะห์ข้อมูล <strong>${s.total} รายการตรวจสอบ</strong> ณ วันที่ ${now}<br>
      อัตราผ่าน <strong>${s.passRate}%</strong> (ผ่าน ${s.passCount}/${s.total} ครั้ง)
      &nbsp;—&nbsp; แนวโน้ม: ${trendIcon} <span class="tag-risk ${trendTag}">${trend}</span></p>

      <hr class="report-sep">
      <h3>🔴 จุดเสี่ยงที่ต้องแก้ไขเร่งด่วน</h3>
      ${topNg.length ? `<ul>
        ${topNg.map(([id, d]) => `<li>
          <strong>ข้อ ${id} — ${escHtml(d.label)}</strong>
          <span class="tag-risk ${riskLevel(d.n, s.total)}">NG ${d.n} ครั้ง</span>
          <br><small>พบ NG คิดเป็น ${s.total ? Math.round(d.n/s.total*100) : 0}% ของการตรวจทั้งหมด — ควรตรวจสอบ PM schedule</small>
        </li>`).join('')}
      </ul>` : '<p>✅ ไม่พบรายการ NG ที่น่าเป็นห่วง</p>'}

      <hr class="report-sep">
      <h3>🏭 Line ที่มีปัญหาสูงสุด</h3>
      ${topLine.length ? `<ul>
        ${topLine.map(([line, count]) => `<li><strong>${escHtml(line)}</strong> — พบ NG รวม <span class="tag-risk tag-high">${count} รายการ</span>
          <br><small>แนะนำให้ทีม QC เข้าตรวจสอบ Jig อย่างละเอียด</small>
        </li>`).join('')}
      </ul>` : '<p>✅ ทุก Line มีอัตรา NG ต่ำ</p>'}

      <hr class="report-sep">
      <h3>${trendIcon} แนวโน้ม</h3>
      <p>เปรียบเทียบผลการตรวจช่วงต้น vs ล่าสุด:<br>
      ช่วงต้น ${s.oldRate}% → ล่าสุด ${s.recRate}%
      &nbsp;—&nbsp; <span class="tag-risk ${trendTag}">${trend}</span>
      ${trend === 'แย่ลง' ? '<br><strong>⚠ ควรเรียกประชุมทีมเพื่อหาสาเหตุโดยด่วน</strong>' : ''}
      </p>

      ${worstShift ? `<hr class="report-sep">
      <h3>🕐 การวิเคราะห์ตามกะ</h3>
      <p>กะที่มี NG สูงสุด: <strong>${escHtml(worstShift.k)}</strong>
      <span class="tag-risk ${worstShift.rate > 30 ? 'tag-high' : 'tag-med'}">${worstShift.rate}% NG rate</span>
      ${worstShift.rate > 30 ? '<br><small>⚠ ควรตรวจสอบขั้นตอน handover และสภาพอุปกรณ์ก่อน shift นี้</small>' : ''}
      </p>` : ''}

      <hr class="report-sep">
      <h3>✅ คำแนะนำ Action Items</h3>
      <ul>
        ${topNg.length ? `<li>🔧 วางแผน PM เพิ่มความถี่สำหรับ: <strong>${topNg.map(([id,d])=>`ข้อ ${id}`).join(', ')}</strong></li>` : ''}
        ${topLine.length ? `<li>📋 ทำ Audit พิเศษสำหรับ Line: <strong>${escHtml(topLine[0][0])}</strong></li>` : ''}
        ${trend === 'แย่ลง' ? `<li>🚨 ประชุม QC ทีมเพื่อหาสาเหตุแนวโน้มที่แย่ลง</li>` : ''}
        ${s.passRate < 80 ? `<li>📊 อัตราผ่านต่ำกว่า 80% — ทบทวน SOP และ Training</li>` : ''}
        <li>📅 บันทึกผลการตรวจให้ครบทุก Shift ทุกวัน</li>
      </ul>
      <p style="font-size:11px;color:var(--text-muted);margin-top:12px">
        🤖 วิเคราะห์โดย Smart Analysis Engine (ไม่ต้องใช้ internet) &nbsp;|&nbsp;
        เพิ่ม Gemini API Key เพื่อรายงานขั้นสูง
      </p>`;
  }

  /* ═══════════════════════════════════════════════════════════════
     STORAGE STATUS MONITOR — แสดงข้อมูล storage usage ใน Admin Panel
     ═══════════════════════════════════════════════════════════════ */

  // ✅ ฟังก์ชัน: ดึงข้อมูลสถิติ storage จาก Supabase
  async function getStorageStats() {
    if (!sb) return null;
    try {
      const [deptCount, lineCount, jigCount, cpCount, historyCount, templateCount] = await Promise.all([
        sb.from('departments').select('id', { count: 'exact', head: true }),
        sb.from('lines').select('id', { count: 'exact', head: true }),
        sb.from('jigs').select('id', { count: 'exact', head: true }),
        sb.from('checkpoints').select('id', { count: 'exact', head: true }),
        sb.from('history').select('id', { count: 'exact', head: true }),
        sb.from('templates').select('id', { count: 'exact', head: true }),
      ]);

      const stats = {
        departments: deptCount.count || 0,
        lines: lineCount.count || 0,
        jigs: jigCount.count || 0,
        checkpoints: cpCount.count || 0,
        history: historyCount.count || 0,
        templates: templateCount.count || 0,
        totalRecords: (deptCount.count || 0) + (lineCount.count || 0) + (jigCount.count || 0) + 
                      (cpCount.count || 0) + (historyCount.count || 0) + (templateCount.count || 0),
        timestamp: new Date().toLocaleString('th-TH'),
      };

      return stats;
    } catch (error) {
      console.error('❌ Error fetching storage stats:', error);
      return null;
    }
  }

  // ✅ ฟังก์ชัน: คำนวณขนาดเป็น KB/MB/GB
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // ✅ ฟังก์ชัน: render Storage Status panel (Gauge Chart Version)
  async function renderStorageStatus() {
    const storageEl = $('storage-stats-panel');
    if (!storageEl) return;

    storageEl.innerHTML = `<div style="padding: 12px; text-align: center; color: var(--text-muted);">⏳ Loading...</div>`;

    const stats = await getStorageStats();
    if (!stats) {
      storageEl.innerHTML = `<div style="padding: 12px; color: var(--text-muted); font-size: 12px;">⚠️ Cannot retrieve storage</div>`;
      return;
    }

    const SUPABASE_FREE_LIMIT = 1073741824; // 1GB
    const estimatedSize = stats.totalRecords * 500;
    const usagePercent = Math.min((estimatedSize / SUPABASE_FREE_LIMIT) * 100, 100);
    const remainingBytes = Math.max(SUPABASE_FREE_LIMIT - estimatedSize, 0);

    // ✨ Gauge Chart สร้าง SVG
    const gaugeColor = usagePercent > 80 ? '#ff6b6b' : usagePercent > 50 ? '#ffd43b' : '#51cf66';
    const gaugeRotation = (usagePercent / 100) * 180 - 90; // 0-180 degrees
    
    const gaugeSVG = `
      <svg viewBox="0 0 120 70" style="width: 100%; height: 80px; margin-bottom: 8px;">
        <!-- Background arc -->
        <path d="M 10 60 A 50 50 0 0 1 110 60" fill="none" stroke="var(--bg-tertiary)" stroke-width="8" stroke-linecap="round"/>
        <!-- Progress arc -->
        <path d="M 10 60 A 50 50 0 ${usagePercent > 50 ? '1' : '0'} 1 ${10 + 100 * Math.cos((usagePercent / 100) * Math.PI)} ${60 - 100 * Math.sin((usagePercent / 100) * Math.PI)}" 
              fill="none" stroke="${gaugeColor}" stroke-width="8" stroke-linecap="round"/>
        <!-- Center text -->
        <text x="60" y="45" text-anchor="middle" font-size="20" font-weight="bold" fill="var(--text-main)">${usagePercent.toFixed(0)}%</text>
        <text x="60" y="58" text-anchor="middle" font-size="10" fill="var(--text-muted)">${formatBytes(estimatedSize)}</text>
      </svg>
    `;

    storageEl.innerHTML = `
      <div class="storage-panel" style="padding: 12px; background: var(--bg-secondary); border-radius: 6px; font-size: 12px;">
        <div style="margin-bottom: 8px; font-weight: bold; color: var(--text-main);">💾 Storage Status</div>
        
        <!-- Gauge Chart -->
        <div style="margin-bottom: 10px;">
          ${gaugeSVG}
          <div style="text-align: center; color: var(--text-muted); font-size: 10px;">
            ${formatBytes(estimatedSize)} / ${formatBytes(SUPABASE_FREE_LIMIT)} 
            | Remaining: <strong style="color: ${remainingBytes < 100000000 ? '#ff6b6b' : '#51cf66'}">${formatBytes(remainingBytes)}</strong>
          </div>
        </div>

        <!-- Records Count -->
        <div style="background: var(--bg-tertiary); padding: 8px; border-radius: 4px; font-size: 10px; margin-bottom: 8px;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">
            <div>📁 Dept: <strong>${stats.departments}</strong></div>
            <div>📍 Lines: <strong>${stats.lines}</strong></div>
            <div>🔧 JIGs: <strong>${stats.jigs}</strong></div>
            <div>✓ Points: <strong>${stats.checkpoints}</strong></div>
            <div>📋 History: <strong>${stats.history}</strong></div>
            <div>📝 Tpl: <strong>${stats.templates}</strong></div>
          </div>
          <div style="margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--border-color); color: var(--text-main); text-align: center;">
            📊 Total: <strong>${stats.totalRecords}</strong> records
          </div>
        </div>

        <div style="color: var(--text-muted); font-size: 9px; text-align: right; margin-bottom: 8px;">
          🕐 ${stats.timestamp}
        </div>

        <!-- Buttons: Refresh + Backup (Clean removed) -->
        <div style="display: flex; gap: 6px;">
          <button id="btn-refresh-storage" style="flex: 1; padding: 6px 8px; background: var(--primary-color); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;">🔄 Refresh</button>
          <button id="btn-backup-storage" style="flex: 1; padding: 6px 8px; background: #4dabf7; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;">💾 Backup</button>
        </div>

        ${usagePercent > 90 ? `<div style="margin-top: 8px; padding: 8px; background: #ffe066; border-left: 3px solid #ff6b6b; border-radius: 3px; color: #333; font-size: 11px;">⚠️ <strong>Warning:</strong> Almost full! Delete old history or upgrade plan</div>` : ''}
      </div>
    `;

    const refreshBtn = $('btn-refresh-storage');
    const backupBtn = $('btn-backup-storage');
    
    if (refreshBtn) refreshBtn.addEventListener('click', () => renderStorageStatus());
    if (backupBtn) backupBtn.addEventListener('click', () => backupStorageData());
  }

  // ✅ ฟังก์ชัน: Backup ข้อมูล (SAFE - ดาวน์โหลดเท่านั้น ไม่ลบ)
  async function backupStorageData() {
    try {
      const cat = JSON.parse(localStorage.getItem(SK.catalog) || '{}');
      const hist = JSON.parse(localStorage.getItem(SK.history) || '[]');
      
      // ✅ STEP 1: Download backup เสมอ (ปลอดภัย 100%)
      const backup = {
        type: 'JIG_Inspection_Backup',
        version: '2.0',
        timestamp: new Date().toISOString(),
        data: { catalog: cat, history: hist }
      };

      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `jig-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);

      toast(`✅ Backup downloaded — ${cat.jigs?.length || 0} JIG, ${hist.length} records`, 'ok');
      
      // ✅ STEP 2: Push ไป Supabase (ถ้า connection OK)
      // แต่ถ้า push ล้มเหลว ก็ไม่สำคัญ เพราะ local backup ยังอยู่
      if (sb && cat.jigs?.length > 0) {
        try {
          _syncing = true;
          await pushCatalogToSupabase(cat);
          // ✅ Success - data ปลอดภัยแล้ว
        } catch (pushErr) {
          console.warn('⚠️ Supabase push failed, local backup is safe:', pushErr);
          toast('⚠️ Local backup OK, Supabase sync failed (will retry)', 'warning');
        } finally {
          setTimeout(() => { _syncing = false; }, 1000);
        }
      }
    } catch (error) {
      console.error('❌ Backup error:', error);
      toast('❌ Backup failed: ' + error.message, 'ng');
    }
  }

  // ✅ ฟังก์ชัน: ลบ history เก่า
  async function deleteOldHistory(daysOld = 30) {
    if (!sb) return;
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);
      const cutoffISO = cutoffDate.toISOString();
      const { error } = await sb.from('history').delete().lt('ts', cutoffISO);
      if (error) throw error;
      toast(`✅ Deleted history older than ${daysOld} days`, 'ok');
      renderStorageStatus();
    } catch (error) {
      console.error('❌ Error deleting old history:', error);
      toast('❌ Cannot delete', 'error');
    }
  }

  // ✅ Auto-refresh storage status
  function autoRefreshStorageStatus(intervalSeconds = 30) {
    renderStorageStatus();
    setInterval(() => renderStorageStatus(), intervalSeconds * 1000);
  }

  // ✅ เรียกเมื่อ initApp() เสร็จ
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (typeof renderStorageStatus === 'function') {
        renderStorageStatus();
        autoRefreshStorageStatus(30);
      }
    }, 1000);
  });

})();


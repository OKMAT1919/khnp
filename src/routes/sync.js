// 전체 상태 동기화 (프론트의 "컬렉션 통째 저장" 패턴 지원)
//
// [2026-08-19 수정] 데이터 소실 사고 대응
//   - replaceInsts 의 TRUNCATE ... CASCADE 가 tb_course 를 함께 삭제하던 문제 수정
//     (tb_course.institution_id → tb_institution.institution_id 외래키 때문)
//     → upsert 방식으로 변경. 기관 ID 가 유지되어 과정 연결도 끊기지 않음
//   - 나머지 3개 함수의 TRUNCATE → DELETE 로 변경 (DB 안전장치와 호환)
//   - 빈 목록이 들어오면 저장을 거부하도록 방어 로직 추가
//
const router = require('express').Router();
const db = require('../db');

// ---- 초기 로드: 모든 데이터를 프론트 구조로 한 번에 ----
router.get('/bootstrap', async (_req, res, next) => {
  try {
    // courses (map/cp/tags 조립)
    const courses = (await db.query('SELECT * FROM tb_course ORDER BY course_nm')).rows;
    const maps = (await db.query('SELECT map_id,course_id,jikgye,jikryeol,jikmu,edu_level FROM tb_course_map')).rows;
    const compRows = (await db.query('SELECT map_id,comp_nm FROM tb_course_comp')).rows;
    const tagRows = (await db.query('SELECT course_id,tag FROM tb_course_tag')).rows;
    const compByMap = {}; compRows.forEach(r => (compByMap[r.map_id] ||= []).push(r.comp_nm));
    const mapsByCourse = {}; maps.forEach(m => (mapsByCourse[m.course_id] ||= []).push(m));
    const tagsByCourse = {}; tagRows.forEach(t => (tagsByCourse[t.course_id] ||= []).push(t.tag));
    const catalog = courses.map(row => {
      const ms = mapsByCourse[row.course_id] || [];
      const map = ms.map(m => [m.jikgye, m.jikryeol, m.jikmu, m.edu_level ?? '', compByMap[m.map_id] || []]);
      return {
        id: row.course_id, n: row.course_nm, cl: row.edu_type, i: row.inst_nm || '',
        o1: row.host_dept || '', o2: row.host_dept_sub || '', g: row.edu_goal || '', ct: row.edu_content || '',
        d: row.edu_days ?? '', h: row.edu_hours ?? '', m: row.edu_method || '', p: row.edu_place || '',
        lv: row.edu_level ?? '', link: row.course_link || '',
        kb1: row.fw_kb1 || '', kb2: row.fw_kb2 || '', kb3: row.fw_kb3 || '',
        yr: row.plan_year || 2026, grp: row.course_group || row.course_id,
        nw: row.is_new ? 'O' : 'X', mu: row.is_required ? 'O' : 'X', rec: row.is_recommend ? 'O' : 'X',
        tags: tagsByCourse[row.course_id] || [],
        jg: [...new Set(map.map(x => x[0]).filter(Boolean))],
        sr: [...new Set(map.map(x => x[1]).filter(Boolean))],
        jb: [...new Set(map.map(x => x[2]).filter(Boolean))],
        cp: [...new Set(map.flatMap(x => x[4]))].slice(0, 8),
        map, _hidden: !row.is_published,
      };
    });
    // taxonomy
    const tax = {};
    (await db.query('SELECT jikgye,jikryeol,jikmu FROM tb_job_taxonomy WHERE use_yn ORDER BY jikgye,jikryeol,jikmu')).rows
      .forEach(r => { tax[r.jikgye] ||= {}; tax[r.jikgye][r.jikryeol] ||= []; if (r.jikmu) tax[r.jikgye][r.jikryeol].push(r.jikmu); });
    // framework
    const ktree = {};
    (await db.query('SELECT kb1,kb2,kb3 FROM tb_framework WHERE use_yn ORDER BY kb1,kb2,kb3')).rows
      .forEach(r => { ktree[r.kb1] ||= {}; ktree[r.kb1][r.kb2] ||= []; if (r.kb3) ktree[r.kb1][r.kb2].push(r.kb3); });
    // competencies
    const comps = (await db.query('SELECT jikgye AS jg,jikryeol AS sr,jikmu AS jb,comp_level AS lv,comp_nm AS name FROM tb_competency WHERE use_yn ORDER BY comp_nm')).rows;
    // institutions
    const insts = (await db.query('SELECT inst_nm AS name,biz_no AS biz,address AS addr,tel,homepage AS home,memo FROM tb_institution WHERE use_yn ORDER BY inst_nm')).rows;
    // depts + demands + log
    const depts = (await db.query('SELECT dept_nm FROM tb_dept WHERE use_yn ORDER BY dept_id')).rows.map(r => r.dept_nm);
    const demandRows = (await db.query(`SELECT d.demand_id,d.dept_nm,d.submitted_at,i.course_id,i.course_nm,i.inst_nm,i.edu_type,i.edu_hours,i.apply_cnt,i.period,i.remark
      FROM tb_demand d JOIN tb_demand_item i ON i.demand_id=d.demand_id ORDER BY d.submitted_at DESC`)).rows;
    const demandMap = {};
    demandRows.forEach(r => {
      (demandMap[r.demand_id] ||= { dept: r.dept_nm, ts: new Date(r.submitted_at).toLocaleString('ko-KR', { hour12: false }), items: [] })
        .items.push({ id: r.course_id, name: r.course_nm, cls: r.edu_type, inst: r.inst_nm, jg: '', sr: '', hours: r.edu_hours, people: r.apply_cnt, quarter: r.period, memo: r.remark });
    });
    const demands = Object.values(demandMap);
    const log = (await db.query('SELECT action,target,to_char(logged_at,\'YYYY-MM-DD HH24:MI:SS\') AS ts FROM tb_change_log ORDER BY log_id DESC LIMIT 200')).rows;
    res.json({ catalog, tax, ktree, comps, insts, depts, demands, log });
  } catch (e) { next(e); }
});

// =====================================================================
//  안전 검사 — 빈 목록이 들어오면 기존 데이터를 지우지 않고 거부
//  (화면이 로드되기 전에 저장이 호출되는 사고를 막음)
// =====================================================================
function assertNotEmpty(label, size) {
  if (!size) {
    const err = new Error(`${label} 목록이 비어 있어 저장을 중단했습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.`);
    err.status = 400;
    throw err;
  }
}

// ---- 컬렉션 통째 저장 (프론트 save* 대응) ----
async function replaceTaxonomy(tree) {
  const size = Object.keys(tree || {}).length;
  assertNotEmpty('직무체계', size);

  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    // TRUNCATE 대신 DELETE — 같은 트랜잭션에서 재삽입하므로 최종 건수는 유지됨
    await c.query('DELETE FROM tb_job_taxonomy');
    for (const jg of Object.keys(tree)) for (const sr of Object.keys(tree[jg])) {
      const jbs = tree[jg][sr].length ? tree[jg][sr] : [''];
      for (const jb of jbs) await c.query('INSERT INTO tb_job_taxonomy(jikgye,jikryeol,jikmu) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [jg, sr, jb]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

async function replaceFramework(tree) {
  const size = Object.keys(tree || {}).length;
  assertNotEmpty('교육체계', size);

  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    await c.query('DELETE FROM tb_framework');
    for (const d of Object.keys(tree)) for (const j of Object.keys(tree[d])) {
      const ss = tree[d][j].length ? tree[d][j] : [''];
      for (const s of ss) await c.query('INSERT INTO tb_framework(kb1,kb2,kb3) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [d, j, s]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

async function replaceComps(rows) {
  assertNotEmpty('역량', (rows || []).length);

  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    await c.query('DELETE FROM tb_competency');
    for (const x of rows) await c.query('INSERT INTO tb_competency(jikgye,jikryeol,jikmu,comp_level,comp_nm) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [x.jg, x.sr, x.jb || '', x.lv === '' ? null : x.lv, x.name]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// =====================================================================
//  교육기관 저장 — 이번 사고의 원인이었던 함수
//
//  이전:  TRUNCATE tb_institution RESTART IDENTITY CASCADE
//         → tb_course 가 institution_id 로 참조 중이므로 과정이 전부 삭제됨
//         → 게다가 RESTART IDENTITY 로 기관 ID 가 1부터 재발급되어
//            살아남은 과정이 있었어도 엉뚱한 기관에 연결되었을 것
//
//  변경:  ① 들어온 기관은 upsert (있으면 갱신, 없으면 추가) — ID 유지
//         ② 목록에서 빠진 기관 중 과정이 참조 중인 것은 비활성(use_yn=false)
//         ③ 아무도 참조하지 않는 것만 실제 삭제
// =====================================================================
async function replaceInsts(rows) {
  assertNotEmpty('교육기관', (rows || []).length);

  const names = rows.map(x => String(x.name || '').trim()).filter(Boolean);
  assertNotEmpty('교육기관', names.length);

  const c = await db.getClient();
  try {
    await c.query('BEGIN');

    // ① 있으면 갱신, 없으면 추가 (기관 ID 는 그대로 유지됨)
    for (const x of rows) {
      const nm = String(x.name || '').trim();
      if (!nm) continue;
      await c.query(
        `INSERT INTO tb_institution(inst_nm,biz_no,address,tel,homepage,memo,use_yn)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE)
         ON CONFLICT (inst_nm) DO UPDATE SET
           biz_no   = EXCLUDED.biz_no,
           address  = EXCLUDED.address,
           tel      = EXCLUDED.tel,
           homepage = EXCLUDED.homepage,
           memo     = EXCLUDED.memo,
           use_yn   = TRUE`,
        [nm, x.biz || '', x.addr || '', x.tel || '', x.home || '', x.memo || '']);
    }

    // ② 목록에서 빠졌지만 과정이 참조 중인 기관 → 비활성 처리 (연결 보존)
    await c.query(
      `UPDATE tb_institution i SET use_yn = FALSE
        WHERE i.inst_nm <> ALL($1::text[])
          AND i.use_yn
          AND EXISTS (SELECT 1 FROM tb_course c WHERE c.institution_id = i.institution_id)`,
      [names]);

    // ③ 목록에서 빠졌고 아무도 참조하지 않는 기관 → 실제 삭제
    await c.query(
      `DELETE FROM tb_institution i
        WHERE i.inst_nm <> ALL($1::text[])
          AND NOT EXISTS (SELECT 1 FROM tb_course c WHERE c.institution_id = i.institution_id)`,
      [names]);

    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// 큰 변경(컬렉션 통째 교체) 전에 자동 스냅샷 — 실패해도 본 작업은 진행
const { takeSnapshot } = require('./backup');
async function autoSnap(reason) { try { await takeSnapshot(reason, 'auto'); } catch (e) { console.error('autoSnap fail:', e.message); } }

router.put('/taxonomy',     async (req, res, next) => { try { await autoSnap('직무체계 저장 전'); await replaceTaxonomy(req.body.tree || {}); res.json({ ok: true }); } catch (e) { next(e); } });
router.put('/framework',    async (req, res, next) => { try { await autoSnap('교육체계 저장 전'); await replaceFramework(req.body.tree || {}); res.json({ ok: true }); } catch (e) { next(e); } });
router.put('/competencies', async (req, res, next) => { try { await autoSnap('역량 저장 전'); await replaceComps(req.body.rows || []); res.json({ ok: true }); } catch (e) { next(e); } });
router.put('/institutions', async (req, res, next) => { try { await autoSnap('교육기관 저장 전'); await replaceInsts(req.body.rows || []); res.json({ ok: true }); } catch (e) { next(e); } });

// 변경이력 1건 기록
router.post('/log', async (req, res, next) => {
  try { await db.query('INSERT INTO tb_change_log(action,target) VALUES ($1,$2)', [req.body.action || '', req.body.target || '']); res.json({ ok: true }); }
  catch (e) { next(e); }
});

module.exports = router;

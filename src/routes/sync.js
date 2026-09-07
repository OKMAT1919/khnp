// 전체 상태 동기화 (프론트의 "컬렉션 통째 저장" 패턴 지원)
//
// [2026-08-19 수정] 데이터 소실 사고 대응
//   - replaceInsts 의 TRUNCATE ... CASCADE 가 tb_course 를 함께 삭제하던 문제 수정
//     (tb_course.institution_id → tb_institution.institution_id 외래키 때문)
//     → upsert 방식으로 변경. 기관 ID 가 유지되어 과정 연결도 끊기지 않음
//   - 나머지 3개 함수의 TRUNCATE → DELETE 로 변경 (DB 안전장치와 호환)
//   - 빈 목록이 들어오면 저장을 거부하도록 방어 로직 추가
//
// [v2 대응 수정] 폐지(use_yn=FALSE) 이력 보존 + 저장 속도 개선
//   ① DELETE 후 전량 재삽입 → "있으면 살리고 · 없으면 넣고 · 빠진 건 폐지" 방식으로 변경
//      - 기존 방식은 v2 에서 폐지한 항목의 행 자체를 지워버려 되돌리기·감사 추적이 끊겼습니다.
//      - 또한 DELETE 는 tb_competency 를 참조하는 데이터가 생길 경우 위험합니다.
//   ② 행 단위 INSERT 반복(역량 1,300건 = 쿼리 1,300회) → JSON 1회 전송(집합 연산)으로 변경
//      역량·직무체계 저장이 수 초 → 수백 ms 수준으로 단축됩니다.
//   ③ comp_level 이 NULL 인 역량은 ON CONFLICT 가 걸리지 않으므로(PostgreSQL 은 NULL 을
//      서로 다른 값으로 취급) IS NOT DISTINCT FROM 으로 직접 대조합니다.
//   ④ valid_from/valid_to/updated_at 은 migration_v2.sql 적용 후에만 존재하므로
//      기동 시 1회 확인해, 없으면 해당 컬럼 없이 동작합니다(마이그레이션 전에도 안전).
//
const router = require('express').Router();
const db = require('../db');

// ---- 초기 로드: 모든 데이터를 프론트 구조로 한 번에 ----
router.get('/bootstrap', async (_req, res, next) => {
  try {
    // courses (map/cp/tags 조립)
    const courses = (await db.query('SELECT c.*, i.inst_cd FROM tb_course c LEFT JOIN tb_institution i ON i.institution_id=c.institution_id ORDER BY c.course_nm')).rows;
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
        icd: row.inst_cd || '', iid: row.institution_id || null,
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
    const insts = (await db.query('SELECT inst_cd AS code,inst_nm AS name,biz_no AS biz,address AS addr,tel,homepage AS home,memo FROM tb_institution WHERE use_yn ORDER BY inst_nm')).rows;
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

// =====================================================================
//  migration_v2.sql 적용 여부 확인 (valid_from/valid_to/updated_at 존재)
//  - 적용 전이면 해당 컬럼을 쓰지 않고 동작하므로 배포 순서에 상관없이 안전합니다.
// =====================================================================
const V2COL = {};
async function hasV2Cols(table) {
  if (V2COL[table] !== undefined) return V2COL[table];
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='valid_to' LIMIT 1`, [table]);
    V2COL[table] = r.rows.length > 0;
  } catch (e) { V2COL[table] = false; }
  return V2COL[table];
}
// 살아난 행 / 폐지된 행에 붙일 SET 조각
const setAlive = (v2) => v2 ? ', valid_to=NULL, updated_at=now()' : '';
const setDead = (v2) => v2 ? ', valid_to=CURRENT_DATE, updated_at=now()' : '';

// ---- 컬렉션 통째 저장 (프론트 save* 대응) ----
//  공통 전략 : ① 들어온 항목은 살리고(use_yn=TRUE) ② 없던 항목은 새로 넣고
//              ③ 목록에서 빠진 항목은 지우지 않고 폐지(use_yn=FALSE)
//  → 폐지 이력이 남아 v2 「되돌리기」·감사 추적이 가능하고, 참조 무결성도 깨지지 않습니다.

async function replaceTaxonomy(tree) {
  assertNotEmpty('직무체계', Object.keys(tree || {}).length);
  const items = [];
  for (const jg of Object.keys(tree)) for (const sr of Object.keys(tree[jg])) {
    const jbs = tree[jg][sr].length ? tree[jg][sr] : [''];
    for (const jb of jbs) items.push({ jg, sr, jb: jb || '' });
  }
  assertNotEmpty('직무체계', items.length);
  const v2 = await hasV2Cols('tb_job_taxonomy');
  const P = [JSON.stringify(items)];
  const SRC = `jsonb_to_recordset($1::jsonb) AS s(jg text, sr text, jb text)`;
  const MATCH = `t.jikgye=s.jg AND t.jikryeol=s.sr AND t.jikmu=s.jb`;
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    // ① 기존 행 재활성화 (폐지했다가 다시 등록한 경우 포함)
    await c.query(`UPDATE tb_job_taxonomy t SET use_yn=TRUE${setAlive(v2)} FROM ${SRC} WHERE ${MATCH}`, P);
    // ② 신규 행만 삽입
    await c.query(
      `INSERT INTO tb_job_taxonomy(jikgye,jikryeol,jikmu,use_yn)
       SELECT DISTINCT s.jg,s.sr,s.jb,TRUE FROM ${SRC}
        WHERE NOT EXISTS (SELECT 1 FROM tb_job_taxonomy t WHERE ${MATCH})`, P);
    // ③ 목록에서 빠진 항목 → 폐지 (삭제하지 않음)
    await c.query(
      `UPDATE tb_job_taxonomy t SET use_yn=FALSE${setDead(v2)}
        WHERE t.use_yn AND NOT EXISTS (SELECT 1 FROM ${SRC} WHERE ${MATCH})`, P);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

async function replaceFramework(tree) {
  assertNotEmpty('교육체계', Object.keys(tree || {}).length);
  const items = [];
  for (const d of Object.keys(tree)) for (const j of Object.keys(tree[d])) {
    const ss = tree[d][j].length ? tree[d][j] : [''];
    for (const s3 of ss) items.push({ k1: d, k2: j, k3: s3 || '' });
  }
  assertNotEmpty('교육체계', items.length);
  const v2 = await hasV2Cols('tb_framework');
  const P = [JSON.stringify(items)];
  const SRC = `jsonb_to_recordset($1::jsonb) AS s(k1 text, k2 text, k3 text)`;
  const MATCH = `f.kb1=s.k1 AND f.kb2=s.k2 AND f.kb3=s.k3`;
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE tb_framework f SET use_yn=TRUE${setAlive(v2)} FROM ${SRC} WHERE ${MATCH}`, P);
    await c.query(
      `INSERT INTO tb_framework(kb1,kb2,kb3,use_yn)
       SELECT DISTINCT s.k1,s.k2,s.k3,TRUE FROM ${SRC}
        WHERE NOT EXISTS (SELECT 1 FROM tb_framework f WHERE ${MATCH})`, P);
    await c.query(
      `UPDATE tb_framework f SET use_yn=FALSE${setDead(v2)}
        WHERE f.use_yn AND NOT EXISTS (SELECT 1 FROM ${SRC} WHERE ${MATCH})`, P);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

async function replaceComps(rows) {
  assertNotEmpty('역량', (rows || []).length);
  const items = [];
  for (const x of rows) {
    const name = String(x.name || '').trim();
    if (!name || !x.jg || !x.sr) continue;                       // 필수값 없는 행은 저장 대상에서 제외
    const n = (x.lv === '' || x.lv == null) ? null : parseInt(x.lv, 10);
    items.push({ jg: x.jg, sr: x.sr, jb: x.jb || '', lv: Number.isNaN(n) ? null : n, nm: name });
  }
  assertNotEmpty('역량', items.length);
  const v2 = await hasV2Cols('tb_competency');
  const P = [JSON.stringify(items)];
  // comp_level 이 NULL 일 수 있어 = 대신 IS NOT DISTINCT FROM 으로 대조합니다.
  const MATCH = `c.jikgye=s.jg AND c.jikryeol=s.sr AND c.jikmu=s.jb AND c.comp_nm=s.nm
                 AND (c.comp_level IS NOT DISTINCT FROM s.lv)`;
  const SRC = `jsonb_to_recordset($1::jsonb) AS s(jg text, sr text, jb text, lv int, nm text)`;
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE tb_competency c SET use_yn=TRUE${setAlive(v2)} FROM ${SRC} WHERE ${MATCH}`, P);
    await c.query(
      `INSERT INTO tb_competency(jikgye,jikryeol,jikmu,comp_level,comp_nm,use_yn)
       SELECT DISTINCT s.jg,s.sr,s.jb,s.lv,s.nm,TRUE FROM ${SRC}
        WHERE NOT EXISTS (SELECT 1 FROM tb_competency c WHERE ${MATCH})`, P);
    await c.query(
      `UPDATE tb_competency c SET use_yn=FALSE${setDead(v2)}
        WHERE c.use_yn AND NOT EXISTS (SELECT 1 FROM ${SRC} WHERE ${MATCH})`, P);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// =====================================================================
//  교육기관 저장 — 2026-08-19 사고의 원인이었던 함수
//
//  이전:  TRUNCATE tb_institution RESTART IDENTITY CASCADE
//         → tb_course 가 institution_id 로 참조 중이므로 과정이 전부 삭제됨
//         → 게다가 RESTART IDENTITY 로 기관 ID 가 1부터 재발급되어
//            살아남은 과정이 있었어도 엉뚱한 기관에 연결되었을 것
//
//  현재:  ① 들어온 기관은 upsert (있으면 갱신, 없으면 추가) — ID 유지
//         ② 목록에서 빠진 기관은 폐지(use_yn=FALSE) — 삭제하지 않음
//            (이전에는 참조가 없으면 물리 삭제했으나, v2 폐지 이력·되돌리기와 충돌하여 중단)
// =====================================================================
async function replaceInsts(rows) {
  assertNotEmpty('교육기관', (rows || []).length);

  const names = rows.map(x => String(x.name || '').trim()).filter(Boolean);
  assertNotEmpty('교육기관', names.length);
  const v2 = await hasV2Cols('tb_institution');

  const c = await db.getClient();
  try {
    await c.query('BEGIN');

    // ① 코드가 있으면 그 기관을 갱신(개명 포함), 없으면 이름 기준 upsert
    //    코드로 갱신하면 institution_id 가 유지되므로 이름을 바꿔도 과정 연결이 끊기지 않습니다.
    for (const x of rows) {
      const nm = String(x.name || '').trim();
      if (!nm) continue;
      const cd = String(x.code || '').trim();
      if (cd) {
        const r = await c.query(
          `UPDATE tb_institution SET inst_nm=$2,biz_no=$3,address=$4,tel=$5,homepage=$6,memo=$7,use_yn=TRUE${setAlive(v2)}
            WHERE inst_cd=$1 RETURNING institution_id`,
          [cd, nm, x.biz || '', x.addr || '', x.tel || '', x.home || '', x.memo || '']);
        if (r.rowCount) continue;   // 갱신 완료
      }
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

    // ①-b 개명이 있었다면 과정의 표시 이름도 함께 따라가게 (연결은 ID 로 유지)
    await c.query(
      `UPDATE tb_course c SET inst_nm = i.inst_nm
         FROM tb_institution i
        WHERE c.institution_id = i.institution_id
          AND c.inst_nm IS DISTINCT FROM i.inst_nm`);

    // ② 목록에서 빠진 기관 → 폐지 (물리 삭제하지 않음: 과정 연결·되돌리기 보존)
    await c.query(
      `UPDATE tb_institution i SET use_yn = FALSE${setDead(v2)}
        WHERE i.use_yn AND i.inst_nm <> ALL($1::text[])`,
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

// 자동/수동 백업(스냅샷) + 복원
//
// [2026-08-19 수정] 데이터 소실 사고 대응
//   - 복원의 TRUNCATE ... CASCADE → 의존순서 DELETE 로 변경 (DB 안전장치와 호환)
//   - 복원 후 시퀀스 재정렬 추가 (RESTART IDENTITY 대체)
//   - 스냅샷 보관 30개 → 100개, protected·수동·최대건수 스냅샷은 영구 보존
//
const router = require('express').Router();
const db = require('../db');

// 전체 상태를 JSON으로 캡처 (bootstrap과 동일 구조의 원천 데이터)
async function captureState() {
  const courses = (await db.query('SELECT * FROM tb_course ORDER BY course_id')).rows;
  const maps = (await db.query('SELECT * FROM tb_course_map')).rows;
  const comps = (await db.query('SELECT map_id,comp_nm FROM tb_course_comp')).rows;
  const tags = (await db.query('SELECT course_id,tag FROM tb_course_tag')).rows;
  const tax = (await db.query('SELECT jikgye,jikryeol,jikmu FROM tb_job_taxonomy')).rows;
  const fw = (await db.query('SELECT kb1,kb2,kb3 FROM tb_framework')).rows;
  const cp = (await db.query('SELECT jikgye,jikryeol,jikmu,comp_level,comp_nm FROM tb_competency')).rows;
  const insts = (await db.query('SELECT inst_nm,biz_no,address,tel,homepage,memo FROM tb_institution')).rows;
  const depts = (await db.query('SELECT dept_nm FROM tb_dept')).rows;
  return { courses, maps, comps, tags, tax, fw, cp, insts, depts, _ts: new Date().toISOString() };
}

// 스냅샷 저장 (다른 라우트에서도 호출 가능하도록 export)
async function takeSnapshot(reason = '', kind = 'auto') {
  const state = await captureState();
  const cnt = state.courses.length;
  const r = await db.query(
    'INSERT INTO tb_snapshot(reason,kind,payload,course_cnt) VALUES ($1,$2,$3,$4) RETURNING snapshot_id,created_at',
    [reason.slice(0, 80), kind, JSON.stringify(state), cnt]
  );
  // 보관 개수 제한: 최근 100개 유지
  //  + protected 표시분, 수동 백업, 과정 수 최대 스냅샷은 항상 보존
  //  (protected 컬럼이 없는 환경에서도 백업 자체는 실패하지 않도록 보호)
  try {
    await db.query(`DELETE FROM tb_snapshot WHERE snapshot_id NOT IN (
        (SELECT snapshot_id FROM tb_snapshot ORDER BY created_at DESC LIMIT 100)
        UNION (SELECT snapshot_id FROM tb_snapshot WHERE protected)
        UNION (SELECT snapshot_id FROM tb_snapshot WHERE kind <> 'auto')
        UNION (SELECT snapshot_id FROM tb_snapshot ORDER BY course_cnt DESC, created_at DESC LIMIT 1)
      )`);
  } catch (e) {
    console.error('snapshot prune skipped:', e.message);
    await db.query(`DELETE FROM tb_snapshot WHERE snapshot_id NOT IN
      (SELECT snapshot_id FROM tb_snapshot ORDER BY created_at DESC LIMIT 100)`);
  }
  return { snapshot_id: r.rows[0].snapshot_id, created_at: r.rows[0].created_at, course_cnt: cnt };
}

// 수동 백업 생성
router.post('/', async (req, res, next) => {
  try {
    const info = await takeSnapshot(req.body.reason || '수동 백업', 'manual');
    res.json({ ok: true, ...info });
  } catch (e) { next(e); }
});

// 백업 목록 (payload 제외, 가벼운 메타만)
router.get('/', async (_req, res, next) => {
  try {
    const rows = (await db.query(
      `SELECT snapshot_id,reason,kind,course_cnt,to_char(created_at,'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM tb_snapshot ORDER BY created_at DESC LIMIT 100`
    )).rows;
    res.json({ ok: true, snapshots: rows });
  } catch (e) { next(e); }
});

// 특정 백업 내려받기 (payload 포함)
router.get('/:id', async (req, res, next) => {
  try {
    const r = await db.query('SELECT snapshot_id,reason,kind,course_cnt,created_at,payload FROM tb_snapshot WHERE snapshot_id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, snapshot: r.rows[0] });
  } catch (e) { next(e); }
});

// 백업 시점으로 복원
router.post('/:id/restore', async (req, res, next) => {
  const c = await db.getClient();
  try {
    const snap = (await db.query('SELECT payload FROM tb_snapshot WHERE snapshot_id=$1', [req.params.id])).rows[0];
    if (!snap) return res.status(404).json({ ok: false, error: 'not found' });
    const s = snap.payload;
    // 복원 직전 현재 상태를 안전 백업
    await takeSnapshot('복원 직전 자동백업', 'auto');
    await c.query('BEGIN');
    // TRUNCATE ... CASCADE 는 tb_course 를 의도치 않게 함께 비우고
    // DB 안전장치에도 차단되므로, 의존 순서대로 DELETE 로 비운다.
    // (같은 트랜잭션에서 곧바로 재삽입하므로 최종 건수는 복원됨)
    await c.query('DELETE FROM tb_course_comp');
    await c.query('DELETE FROM tb_course_tag');
    await c.query('DELETE FROM tb_course_map');
    await c.query('DELETE FROM tb_course');
    await c.query('DELETE FROM tb_competency');
    await c.query('DELETE FROM tb_job_taxonomy');
    await c.query('DELETE FROM tb_framework');
    await c.query('DELETE FROM tb_institution');
    for (const x of s.insts || []) await c.query('INSERT INTO tb_institution(inst_nm,biz_no,address,tel,homepage,memo) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [x.inst_nm, x.biz_no, x.address, x.tel, x.homepage, x.memo]);
    for (const x of s.tax || []) await c.query('INSERT INTO tb_job_taxonomy(jikgye,jikryeol,jikmu) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [x.jikgye, x.jikryeol, x.jikmu]);
    for (const x of s.fw || []) await c.query('INSERT INTO tb_framework(kb1,kb2,kb3) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [x.kb1, x.kb2, x.kb3]);
    for (const x of s.cp || []) await c.query('INSERT INTO tb_competency(jikgye,jikryeol,jikmu,comp_level,comp_nm) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [x.jikgye, x.jikryeol, x.jikmu, x.comp_level, x.comp_nm]);
    for (const x of s.courses || []) {
      await c.query(`INSERT INTO tb_course(course_id,course_nm,edu_type,inst_nm,host_dept,host_dept_sub,edu_goal,edu_content,edu_days,edu_hours,edu_method,edu_place,edu_level,course_link,fw_kb1,fw_kb2,fw_kb3,is_new,is_required,is_recommend,is_published,plan_year,course_group)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) ON CONFLICT (course_id) DO NOTHING`,
        [x.course_id,x.course_nm,x.edu_type,x.inst_nm,x.host_dept,x.host_dept_sub,x.edu_goal,x.edu_content,x.edu_days,x.edu_hours,x.edu_method,x.edu_place,x.edu_level,x.course_link,x.fw_kb1,x.fw_kb2,x.fw_kb3,x.is_new,x.is_required,x.is_recommend,x.is_published,x.plan_year,x.course_group]);
    }
    for (const m of s.maps || []) await c.query('INSERT INTO tb_course_map(map_id,course_id,jikgye,jikryeol,jikmu,edu_level) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [m.map_id, m.course_id, m.jikgye, m.jikryeol, m.jikmu, m.edu_level]);
    for (const x of s.comps || []) await c.query('INSERT INTO tb_course_comp(map_id,comp_nm) VALUES ($1,$2) ON CONFLICT DO NOTHING', [x.map_id, x.comp_nm]);
    for (const t of s.tags || []) await c.query('INSERT INTO tb_course_tag(course_id,tag) VALUES ($1,$2) ON CONFLICT DO NOTHING', [t.course_id, t.tag]);
    // 명시적 ID 로 넣었으므로 시퀀스를 최대값에 맞춰 재정렬
    //  (안 하면 이후 신규 등록에서 ID 충돌이 발생)
    //  course_id 처럼 문자열 컬럼이라 시퀀스가 없는 경우는 자동으로 건너뜀
    await c.query(`DO $do$
      DECLARE r RECORD; s TEXT; mx BIGINT;
      BEGIN
        FOR r IN SELECT * FROM (VALUES
            ('tb_course','course_id'),
            ('tb_course_map','map_id'),
            ('tb_institution','institution_id')) v(t,c)
        LOOP
          s := pg_get_serial_sequence(r.t, r.c);
          IF s IS NOT NULL THEN
            EXECUTE format(
              'SELECT COALESCE(MAX(%I::bigint),0) FROM %I WHERE %I::text ~ ''^[0-9]+$''',
              r.c, r.t, r.c) INTO mx;
            PERFORM setval(s, GREATEST(mx, 1));
          END IF;
        END LOOP;
      END $do$;`);
    await c.query('COMMIT');
    res.json({ ok: true, restored_courses: (s.courses || []).length });
  } catch (e) { await c.query('ROLLBACK'); next(e); } finally { c.release(); }
});

module.exports = router;
module.exports.takeSnapshot = takeSnapshot;

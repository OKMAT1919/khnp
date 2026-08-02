const router = require('express').Router();
const db = require('../db');

async function logChange(action, target, entity, user) {
  try { await db.query('INSERT INTO tb_change_log(action,target,entity,user_id) VALUES ($1,$2,$3,$4)', [action, target, entity, user || null]); } catch {}
}

// 과정 1건을 프론트 구조(map/cp/tags)로 조립
async function assembleCourse(row) {
  const maps = (await db.query(
    'SELECT map_id, jikgye, jikryeol, jikmu, edu_level FROM tb_course_map WHERE course_id=$1 ORDER BY map_id', [row.course_id]
  )).rows;
  const mapIds = maps.map(m => m.map_id);
  let compsByMap = {};
  if (mapIds.length) {
    const cr = await db.query('SELECT map_id, comp_nm FROM tb_course_comp WHERE map_id = ANY($1)', [mapIds]);
    cr.rows.forEach(r => { (compsByMap[r.map_id] ||= []).push(r.comp_nm); });
  }
  const tags = (await db.query('SELECT tag FROM tb_course_tag WHERE course_id=$1', [row.course_id])).rows.map(r => r.tag);
  const map = maps.map(m => [m.jikgye, m.jikryeol, m.jikmu, m.edu_level ?? '', compsByMap[m.map_id] || []]);
  const jg = [...new Set(maps.map(m => m.jikgye).filter(Boolean))];
  const sr = [...new Set(maps.map(m => m.jikryeol).filter(Boolean))];
  const jb = [...new Set(maps.map(m => m.jikmu).filter(Boolean))];
  const cp = [...new Set(map.flatMap(m => m[4]))].slice(0, 8);
  return {
    id: row.course_id, n: row.course_nm, cl: row.edu_type, i: row.inst_nm || '',
    o1: row.host_dept || '', o2: row.host_dept_sub || '', g: row.edu_goal || '', ct: row.edu_content || '',
    d: row.edu_days ?? '', h: row.edu_hours ?? '', m: row.edu_method || '', p: row.edu_place || '',
    lv: row.edu_level ?? '', link: row.course_link || '',
    kb1: row.fw_kb1 || '', kb2: row.fw_kb2 || '', kb3: row.fw_kb3 || '',
    yr: row.plan_year || 2026, grp: row.course_group || row.course_id,
    nw: row.is_new ? 'O' : 'X', mu: row.is_required ? 'O' : 'X', rec: row.is_recommend ? 'O' : 'X',
    tags, jg, sr, jb, cp, map,
  };
}

// 목록 (검색·필터·페이지네이션)
router.get('/', async (req, res, next) => {
  try {
    const { q, kb1, edu_type, jikgye, jikryeol, jikmu, published = 'true', limit = 100, offset = 0 } = req.query;
    const where = []; const args = [];
    if (published !== 'all') { args.push(published === 'true'); where.push(`c.is_published = $${args.length}`); }
    if (kb1) { args.push(kb1); where.push(`c.fw_kb1 = $${args.length}`); }
    if (edu_type) { args.push(edu_type); where.push(`c.edu_type = $${args.length}`); }
    if (q) { args.push(`%${q}%`); where.push(`(c.course_nm ILIKE $${args.length} OR c.inst_nm ILIKE $${args.length})`); }
    if (jikgye || jikryeol || jikmu) {
      const sub = []; 
      if (jikgye) { args.push(jikgye); sub.push(`m.jikgye = $${args.length}`); }
      if (jikryeol) { args.push(jikryeol); sub.push(`m.jikryeol = $${args.length}`); }
      if (jikmu) { args.push(jikmu); sub.push(`m.jikmu = $${args.length}`); }
      where.push(`EXISTS (SELECT 1 FROM tb_course_map m WHERE m.course_id=c.course_id AND ${sub.join(' AND ')})`);
    }
    const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    args.push(Math.min(+limit || 100, 500)); const lim = args.length;
    args.push(+offset || 0); const off = args.length;
    const rows = (await db.query(`SELECT * FROM tb_course c ${wsql} ORDER BY c.course_nm LIMIT $${lim} OFFSET $${off}`, args)).rows;
    const total = (await db.query(`SELECT count(*)::int AS n FROM tb_course c ${wsql}`, args.slice(0, lim - 1))).rows[0]?.n ?? data.length;
    const data = await Promise.all(rows.map(assembleCourse));
    res.json({ total, count: data.length, data });
  } catch (e) { next(e); }
});

// 상세
router.get('/:id', async (req, res, next) => {
  try {
    const r = await db.query('SELECT * FROM tb_course WHERE course_id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(await assembleCourse(r.rows[0]));
  } catch (e) { next(e); }
});

// 과정 저장(등록/수정) — map/tags 포함 트랜잭션
async function upsertCourse(body, isNew) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const id = body.id || ('NEW_' + Date.now());
    const instId = body.i
      ? (await client.query('SELECT institution_id FROM tb_institution WHERE inst_nm=$1', [body.i])).rows[0]?.institution_id || null
      : null;
    const vals = [
      id, body.n, body.cl || '사내교육', instId, body.i || '', body.o1 || '', body.o2 || '',
      body.g || '', body.ct || '', body.d || null, body.h || null, body.m || '', body.p || '',
      body.lv === '' ? null : body.lv, body.link || '', body.kb1 || '', body.kb2 || '', body.kb3 || '',
      body.nw === 'O', body.mu === 'O', body.rec === 'O', body.published !== false,
      body.yr || 2026, body.grp || id,
    ];
    await client.query(`
      INSERT INTO tb_course(course_id,course_nm,edu_type,institution_id,inst_nm,host_dept,host_dept_sub,
        edu_goal,edu_content,edu_days,edu_hours,edu_method,edu_place,edu_level,course_link,fw_kb1,fw_kb2,fw_kb3,
        is_new,is_required,is_recommend,is_published,plan_year,course_group)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      ON CONFLICT (course_id) DO UPDATE SET
        course_nm=EXCLUDED.course_nm, edu_type=EXCLUDED.edu_type, institution_id=EXCLUDED.institution_id,
        inst_nm=EXCLUDED.inst_nm, host_dept=EXCLUDED.host_dept, host_dept_sub=EXCLUDED.host_dept_sub,
        edu_goal=EXCLUDED.edu_goal, edu_content=EXCLUDED.edu_content, edu_days=EXCLUDED.edu_days,
        edu_hours=EXCLUDED.edu_hours, edu_method=EXCLUDED.edu_method, edu_place=EXCLUDED.edu_place,
        edu_level=EXCLUDED.edu_level, course_link=EXCLUDED.course_link, fw_kb1=EXCLUDED.fw_kb1,
        fw_kb2=EXCLUDED.fw_kb2, fw_kb3=EXCLUDED.fw_kb3, is_new=EXCLUDED.is_new, is_required=EXCLUDED.is_required,
        is_recommend=EXCLUDED.is_recommend, is_published=EXCLUDED.is_published,
        plan_year=EXCLUDED.plan_year, course_group=EXCLUDED.course_group, updated_at=now()
    `, vals);

    // 태그·매핑 재구성
    await client.query('DELETE FROM tb_course_tag WHERE course_id=$1', [id]);
    for (const t of (body.tags || [])) await client.query('INSERT INTO tb_course_tag(course_id,tag) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, t]);
    await client.query('DELETE FROM tb_course_map WHERE course_id=$1', [id]);
    for (const m of (body.map || [])) {
      const [jg, sr, jb, lv, caps] = [m[0] || '', m[1] || '', m[2] || '', m[3] === '' ? null : m[3], m[4] || []];
      const mr = await client.query(
        'INSERT INTO tb_course_map(course_id,jikgye,jikryeol,jikmu,edu_level) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING map_id',
        [id, jg, sr, jb, lv]);
      const mapId = mr.rows[0]?.map_id;
      if (mapId) for (const cp of caps) {
        await client.query('INSERT INTO tb_course_comp(map_id,comp_nm) VALUES ($1,$2) ON CONFLICT DO NOTHING', [mapId, cp]);
        // 역량 마스터에도 정렬 반영
        await client.query(
          'INSERT INTO tb_competency(jikgye,jikryeol,jikmu,comp_level,comp_nm) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [jg, sr, jb, lv, cp]);
      }
    }
    await client.query('COMMIT');
    await logChange(isNew ? '과정 등록' : '과정 수정', body.n, 'tb_course', body.user);
    return id;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

router.post('/', async (req, res, next) => { try { const id = await upsertCourse(req.body, true); res.status(201).json({ id }); } catch (e) { next(e); } });
router.put('/:id', async (req, res, next) => { try { const id = await upsertCourse({ ...req.body, id: req.params.id }, false); res.json({ id }); } catch (e) { next(e); } });

router.patch('/:id/publish', async (req, res, next) => {
  try { await db.query('UPDATE tb_course SET is_published=$1, updated_at=now() WHERE course_id=$2', [!!req.body.published, req.params.id]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
router.delete('/:id', async (req, res, next) => {
  try { await db.query('DELETE FROM tb_course WHERE course_id=$1', [req.params.id]); await logChange('과정 삭제', req.params.id, 'tb_course'); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// 엑셀 일괄 등록 (프론트에서 파싱한 배열 수신)
router.post('/bulk', async (req, res, next) => {
  try {
    const items = req.body.items || [];
    let n = 0; for (const it of items) { await upsertCourse(it, true); n++; }
    res.json({ inserted: n });
  } catch (e) { next(e); }
});

module.exports = router;

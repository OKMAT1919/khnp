const router = require('express').Router();
const db = require('../db');
router.get('/', async (req, res, next) => {
  try {
    const { q, jikgye, level, limit = 500 } = req.query;
    const where = ['use_yn']; const args = [];
    if (jikgye) { args.push(jikgye); where.push(`jikgye=$${args.length}`); }
    if (level) { args.push(level); where.push(`comp_level=$${args.length}`); }
    if (q) { args.push(`%${q}%`); where.push(`(comp_nm ILIKE $${args.length} OR jikmu ILIKE $${args.length})`); }
    args.push(Math.min(+limit || 500, 2000));
    const rows = (await db.query(
      `SELECT jikgye AS jg, jikryeol AS sr, jikmu AS jb, comp_level AS lv, comp_nm AS name
       FROM tb_competency WHERE ${where.join(' AND ')} ORDER BY comp_nm LIMIT $${args.length}`, args)).rows;
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/', async (req, res, next) => {
  try { const { jg, sr, jb, lv, name } = req.body;
    await db.query('INSERT INTO tb_competency(jikgye,jikryeol,jikmu,comp_level,comp_nm) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [jg, sr, jb || '', lv || null, name]); res.status(201).json({ ok: true }); }
  catch (e) { next(e); }
});

// =====================================================================
//  역량명 개명 — 마스터(tb_competency) + 연계 과정(tb_course_comp)을
//  한 트랜잭션에서 함께 갱신합니다. (교육기관 개명과 동일한 "이름 연쇄" 구조)
//
//  과정은 역량을 '이름'으로 참조(tb_course_comp.comp_nm)하고,
//  화면 카운트도 이름 기준이므로 개명은 comp_nm 전체(모든 스코프)에 대해 수행합니다.
//    body: { oldName, newName }
//  반환: { ok, renamed(마스터 행수), courses(갱신된 과정-역량 참조 수) }
// =====================================================================
router.put('/', async (req, res, next) => {
  const client = await db.getClient();
  try {
    const oldName = String((req.body && req.body.oldName) || '').trim();
    const newName = String((req.body && req.body.newName) || '').trim();
    if (!oldName || !newName) return res.status(400).json({ error: 'oldName·newName 이 필요합니다' });
    if (oldName === newName) return res.json({ ok: true, renamed: 0, courses: 0 });

    await client.query('BEGIN');

    // ① 마스터 개명 — 같은 스코프에 newName 이 이미 있으면(UNIQUE 충돌) 그 행은 건드리지 않고
    const up = await client.query(
      `UPDATE tb_competency c SET comp_nm=$2
        WHERE c.comp_nm=$1
          AND NOT EXISTS (
            SELECT 1 FROM tb_competency d
             WHERE d.jikgye=c.jikgye AND d.jikryeol=c.jikryeol AND d.jikmu=c.jikmu
               AND d.comp_level IS NOT DISTINCT FROM c.comp_level
               AND d.comp_nm=$2)`, [oldName, newName]);
    // ①-b 충돌로 개명하지 못한 잔여 구명 행은 폐지(use_yn=FALSE) — 되돌리기·감사 추적 보존
    await client.query(`UPDATE tb_competency SET use_yn=FALSE WHERE comp_nm=$1`, [oldName]);

    // ② 연계 과정의 역량명 갱신 — 같은 map 에 newName 이 이미 있으면(PK 충돌) 건드리지 않고
    const cc = await client.query(
      `UPDATE tb_course_comp t SET comp_nm=$2
        WHERE t.comp_nm=$1
          AND NOT EXISTS (SELECT 1 FROM tb_course_comp u WHERE u.map_id=t.map_id AND u.comp_nm=$2)`,
      [oldName, newName]);
    // ②-b 충돌로 남은 구명 참조(이미 newName 존재)는 중복이므로 제거
    await client.query(`DELETE FROM tb_course_comp WHERE comp_nm=$1`, [oldName]);

    await client.query('INSERT INTO tb_change_log(action,target,entity) VALUES ($1,$2,$3)',
      ['역량 개명', oldName + ' → ' + newName + ' (과정 ' + cc.rowCount + '건)', '역량']);

    await client.query('COMMIT');
    res.json({ ok: true, renamed: up.rowCount, courses: cc.rowCount });
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

router.delete('/', async (req, res, next) => {
  try { const { jg, sr, jb, lv, name } = req.query;
    await db.query('DELETE FROM tb_competency WHERE jikgye=$1 AND jikryeol=$2 AND jikmu=$3 AND comp_level IS NOT DISTINCT FROM $4 AND comp_nm=$5',
      [jg, sr, jb || '', lv || null, name]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
module.exports = router;

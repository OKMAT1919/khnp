const router = require('express').Router();
const db = require('../db');

// 직무체계 트리 {직계:{직렬:[직무...]}}
router.get('/', async (_req, res, next) => {
  try {
    const rows = (await db.query('SELECT jikgye,jikryeol,jikmu FROM tb_job_taxonomy WHERE use_yn ORDER BY jikgye,jikryeol,jikmu')).rows;
    const tree = {};
    rows.forEach(r => {
      tree[r.jikgye] ||= {};
      tree[r.jikgye][r.jikryeol] ||= [];
      if (r.jikmu) tree[r.jikgye][r.jikryeol].push(r.jikmu);
    });
    res.json(tree);
  } catch (e) { next(e); }
});

// 항목 추가 (직계/직렬/직무)
router.post('/', async (req, res, next) => {
  try {
    const { jikgye, jikryeol = '', jikmu = '' } = req.body;
    if (!jikgye) return res.status(400).json({ error: 'jikgye required' });
    await db.query('INSERT INTO tb_job_taxonomy(jikgye,jikryeol,jikmu) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [jikgye, jikryeol, jikmu]);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

// 이름 수정 (연계 과정·역량까지 전파)
router.put('/', async (req, res, next) => {
  const client = await db.getClient();
  try {
    const { level, oldValue, newValue, jikgye, jikryeol } = req.body; // level: jikgye|jikryeol|jikmu
    await client.query('BEGIN');
    if (level === 'jikgye') {
      await client.query('UPDATE tb_job_taxonomy SET jikgye=$1 WHERE jikgye=$2', [newValue, oldValue]);
      await client.query('UPDATE tb_course_map SET jikgye=$1 WHERE jikgye=$2', [newValue, oldValue]);
      await client.query('UPDATE tb_competency SET jikgye=$1 WHERE jikgye=$2', [newValue, oldValue]);
    } else if (level === 'jikryeol') {
      await client.query('UPDATE tb_job_taxonomy SET jikryeol=$1 WHERE jikgye=$2 AND jikryeol=$3', [newValue, jikgye, oldValue]);
      await client.query('UPDATE tb_course_map SET jikryeol=$1 WHERE jikgye=$2 AND jikryeol=$3', [newValue, jikgye, oldValue]);
      await client.query('UPDATE tb_competency SET jikryeol=$1 WHERE jikgye=$2 AND jikryeol=$3', [newValue, jikgye, oldValue]);
    } else if (level === 'jikmu') {
      await client.query('UPDATE tb_job_taxonomy SET jikmu=$1 WHERE jikgye=$2 AND jikryeol=$3 AND jikmu=$4', [newValue, jikgye, jikryeol, oldValue]);
      await client.query('UPDATE tb_course_map SET jikmu=$1 WHERE jikgye=$2 AND jikryeol=$3 AND jikmu=$4', [newValue, jikgye, jikryeol, oldValue]);
      await client.query('UPDATE tb_competency SET jikmu=$1 WHERE jikgye=$2 AND jikryeol=$3 AND jikmu=$4', [newValue, jikgye, jikryeol, oldValue]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

// 삭제
router.delete('/', async (req, res, next) => {
  try {
    const { level, value, jikgye, jikryeol } = req.query;
    if (level === 'jikgye') await db.query('DELETE FROM tb_job_taxonomy WHERE jikgye=$1', [value]);
    else if (level === 'jikryeol') await db.query('DELETE FROM tb_job_taxonomy WHERE jikgye=$1 AND jikryeol=$2', [jikgye, value]);
    else if (level === 'jikmu') await db.query('DELETE FROM tb_job_taxonomy WHERE jikgye=$1 AND jikryeol=$2 AND jikmu=$3', [jikgye, jikryeol, value]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

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
router.delete('/', async (req, res, next) => {
  try { const { jg, sr, jb, lv, name } = req.query;
    await db.query('DELETE FROM tb_competency WHERE jikgye=$1 AND jikryeol=$2 AND jikmu=$3 AND comp_level IS NOT DISTINCT FROM $4 AND comp_nm=$5',
      [jg, sr, jb || '', lv || null, name]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
module.exports = router;

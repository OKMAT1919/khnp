const router = require('express').Router();
const db = require('../db');
router.get('/', async (req, res, next) => {
  try { const { q } = req.query; const args = []; let w = 'WHERE use_yn';
    if (q) { args.push(`%${q}%`); w += ` AND (inst_nm ILIKE $1 OR address ILIKE $1)`; }
    const rows = (await db.query(
      `SELECT inst_nm AS name, biz_no AS biz, address AS addr, tel, homepage AS home, memo FROM tb_institution ${w} ORDER BY inst_nm`, args)).rows;
    res.json(rows); } catch (e) { next(e); }
});
router.post('/', async (req, res, next) => {
  try { const { name, biz = '', addr = '', tel = '', home = '', memo = '' } = req.body;
    await db.query(`INSERT INTO tb_institution(inst_nm,biz_no,address,tel,homepage,memo) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (inst_nm) DO UPDATE SET biz_no=EXCLUDED.biz_no,address=EXCLUDED.address,tel=EXCLUDED.tel,homepage=EXCLUDED.homepage,memo=EXCLUDED.memo`,
      [name, biz, addr, tel, home, memo]); res.status(201).json({ ok: true }); }
  catch (e) { next(e); }
});
router.delete('/:name', async (req, res, next) => {
  try { await db.query('DELETE FROM tb_institution WHERE inst_nm=$1', [req.params.name]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
module.exports = router;

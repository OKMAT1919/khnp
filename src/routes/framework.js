const router = require('express').Router();
const db = require('../db');
// 교육체계 트리 {대분류:{중분류:[소분류...]}}
router.get('/', async (_req, res, next) => {
  try {
    const rows = (await db.query('SELECT kb1,kb2,kb3 FROM tb_framework WHERE use_yn ORDER BY kb1,kb2,kb3')).rows;
    const tree = {};
    rows.forEach(r => { tree[r.kb1] ||= {}; tree[r.kb1][r.kb2] ||= []; if (r.kb3) tree[r.kb1][r.kb2].push(r.kb3); });
    res.json(tree);
  } catch (e) { next(e); }
});
router.post('/', async (req, res, next) => {
  try { const { kb1, kb2 = '', kb3 = '' } = req.body; if (!kb1) return res.status(400).json({ error: 'kb1 required' });
    await db.query('INSERT INTO tb_framework(kb1,kb2,kb3) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [kb1, kb2, kb3]); res.status(201).json({ ok: true }); }
  catch (e) { next(e); }
});
router.delete('/', async (req, res, next) => {
  try { const { level, value, kb1, kb2 } = req.query;
    if (level === 'kb1') await db.query('DELETE FROM tb_framework WHERE kb1=$1', [value]);
    else if (level === 'kb2') await db.query('DELETE FROM tb_framework WHERE kb1=$1 AND kb2=$2', [kb1, value]);
    else if (level === 'kb3') await db.query('DELETE FROM tb_framework WHERE kb1=$1 AND kb2=$2 AND kb3=$3', [kb1, kb2, value]);
    res.json({ ok: true }); }
  catch (e) { next(e); }
});
module.exports = router;

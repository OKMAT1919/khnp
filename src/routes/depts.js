const router = require('express').Router();
const db = require('../db');
router.get('/', async (_req, res, next) => {
  try { const rows = (await db.query('SELECT dept_id, dept_nm, parent_dept FROM tb_dept WHERE use_yn ORDER BY dept_id')).rows; res.json(rows); }
  catch (e) { next(e); }
});
module.exports = router;

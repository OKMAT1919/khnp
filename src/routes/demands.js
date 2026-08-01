const router = require('express').Router();
const db = require('../db');

// 신청현황 (flat rows)
router.get('/', async (req, res, next) => {
  try {
    const { dept } = req.query; const args = []; let w = '';
    if (dept) { args.push(dept); w = 'WHERE d.dept_nm=$1'; }
    const rows = (await db.query(`
      SELECT d.demand_id, d.dept_nm, d.plan_year, d.status, d.submitted_at,
             i.item_id, i.course_id, i.course_nm, i.inst_nm, i.edu_type, i.edu_hours, i.apply_cnt, i.period, i.remark,
             (SELECT homepage FROM tb_institution WHERE inst_nm=i.inst_nm) AS homepage
      FROM tb_demand d JOIN tb_demand_item i ON i.demand_id=d.demand_id
      ${w} ORDER BY d.submitted_at DESC, i.item_id`, args)).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

// 제출 (장바구니)
router.post('/', async (req, res, next) => {
  const client = await db.getClient();
  try {
    const { dept, planYear = 2027, items = [], user } = req.body;
    await client.query('BEGIN');
    const deptId = (await client.query('SELECT dept_id FROM tb_dept WHERE dept_nm=$1', [dept])).rows[0]?.dept_id || null;
    const dr = await client.query('INSERT INTO tb_demand(dept_id,dept_nm,plan_year,submitted_by) VALUES ($1,$2,$3,$4) RETURNING demand_id', [deptId, dept, planYear, user || null]);
    const demandId = dr.rows[0].demand_id;
    for (const it of items) {
      await client.query(`INSERT INTO tb_demand_item(demand_id,course_id,course_nm,inst_nm,edu_type,edu_hours,apply_cnt,period,remark)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (demand_id,course_id) DO NOTHING`,
        [demandId, it.id, it.name, it.inst || '', it.cls || '', it.hours || null, it.people || 1, it.quarter || '', it.memo || '']);
    }
    await client.query('COMMIT');
    await db.query('INSERT INTO tb_change_log(action,target,entity) VALUES ($1,$2,$3)', ['교육신청 제출', `${dept} · ${items.length}건`, 'tb_demand']);
    res.status(201).json({ demand_id: demandId });
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

router.delete('/item/:itemId', async (req, res, next) => {
  try { await db.query('DELETE FROM tb_demand_item WHERE item_id=$1', [req.params.itemId]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
module.exports = router;

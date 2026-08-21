const router = require('express').Router();
const db = require('../db');

// 목록 — 기관코드(IN0001) 포함
router.get('/', async (req, res, next) => {
  try {
    const { q } = req.query; const args = []; let w = 'WHERE use_yn';
    if (q) { args.push(`%${q}%`); w += ` AND (inst_nm ILIKE $1 OR address ILIKE $1 OR inst_cd ILIKE $1)`; }
    const rows = (await db.query(
      `SELECT inst_cd AS code, inst_nm AS name, biz_no AS biz, address AS addr,
              tel, homepage AS home, memo
         FROM tb_institution ${w} ORDER BY inst_nm`, args)).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

// 미연계 원문 집계 — 과정에는 있으나 기관 마스터에 붙지 않은 이름
router.get('/unlinked', async (_req, res, next) => {
  try {
    const rows = (await db.query(
      `SELECT inst_nm AS raw, count(*)::int AS cnt,
              (array_agg(course_nm ORDER BY course_nm))[1:3] AS samples
         FROM tb_course
        WHERE institution_id IS NULL AND coalesce(inst_nm,'') <> ''
        GROUP BY inst_nm ORDER BY count(*) DESC, inst_nm`)).rows;
    res.json(rows);
  } catch (e) { next(e); }
});

// 등록·수정 — code 가 오면 그 기관의 이름 변경(안전한 개명), 없으면 신규
router.post('/', async (req, res, next) => {
  try {
    const { code = '', name, biz = '', addr = '', tel = '', home = '', memo = '' } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: '교육기관명은 필수입니다' });
    const nm = String(name).trim();

    if (code) {
      const r = await db.query(
        `UPDATE tb_institution SET inst_nm=$2, biz_no=$3, address=$4, tel=$5, homepage=$6, memo=$7
          WHERE inst_cd=$1 RETURNING inst_cd, inst_nm`, [code, nm, biz, addr, tel, home, memo]);
      if (!r.rows.length) return res.status(404).json({ error: '해당 기관코드가 없습니다: ' + code });
      // 개명 시 과정의 표시 이름도 함께 갱신 (연결은 ID 로 유지되므로 끊기지 않음)
      await db.query(
        `UPDATE tb_course c SET inst_nm=i.inst_nm FROM tb_institution i
          WHERE c.institution_id=i.institution_id AND i.inst_cd=$1 AND c.inst_nm IS DISTINCT FROM i.inst_nm`, [code]);
      return res.json({ ok: true, code: r.rows[0].inst_cd, name: r.rows[0].inst_nm });
    }

    const r = await db.query(
      `INSERT INTO tb_institution(inst_nm,biz_no,address,tel,homepage,memo)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (inst_nm) DO UPDATE SET
         biz_no=EXCLUDED.biz_no, address=EXCLUDED.address, tel=EXCLUDED.tel,
         homepage=EXCLUDED.homepage, memo=EXCLUDED.memo, use_yn=TRUE
       RETURNING inst_cd, inst_nm`, [nm, biz, addr, tel, home, memo]);
    res.status(201).json({ ok: true, code: r.rows[0].inst_cd, name: r.rows[0].inst_nm });
  } catch (e) { next(e); }
});

// 미연계 원문 → 기관 일괄 연결 (같은 원문을 쓰는 과정 전체가 한 번에 붙습니다)
router.post('/link', async (req, res, next) => {
  try {
    const { raw, code } = req.body;
    if (!raw || !code) return res.status(400).json({ error: 'raw 와 code 가 모두 필요합니다' });
    const inst = (await db.query('SELECT institution_id, inst_nm FROM tb_institution WHERE inst_cd=$1', [code])).rows[0];
    if (!inst) return res.status(404).json({ error: '해당 기관코드가 없습니다: ' + code });
    const r = await db.query(
      `UPDATE tb_course SET institution_id=$1, inst_nm=$2, updated_at=now()
        WHERE institution_id IS NULL AND inst_nm=$3`, [inst.institution_id, inst.inst_nm, raw]);
    await db.query('INSERT INTO tb_change_log(action,target) VALUES ($1,$2)',
      ['기관 연결', raw + ' → ' + code + ' ' + inst.inst_nm + ' (' + r.rowCount + '건)']);
    res.json({ ok: true, linked: r.rowCount, name: inst.inst_nm });
  } catch (e) { next(e); }
});

// 삭제 — 과정이 참조 중이면 거부 (연결 유실 방지)
router.delete('/:code', async (req, res, next) => {
  try {
    const key = req.params.code;
    const inst = (await db.query(
      'SELECT institution_id, inst_cd, inst_nm FROM tb_institution WHERE inst_cd=$1 OR inst_nm=$1', [key])).rows[0];
    if (!inst) return res.status(404).json({ error: '기관을 찾을 수 없습니다' });
    const used = (await db.query('SELECT count(*)::int AS n FROM tb_course WHERE institution_id=$1', [inst.institution_id])).rows[0].n;
    if (used) return res.status(409).json({ error: '연계된 과정이 ' + used + '건 있어 삭제할 수 없습니다', courses: used });
    await db.query('DELETE FROM tb_institution WHERE institution_id=$1', [inst.institution_id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

/* =====================================================================
   /api/v2 — 확장 API (프론트 v6 가 자동 탐지하여 사용)
   - capabilities : 프론트가 v2 지원 여부를 판별
   - history      : 기준정보 필드 단위 변경 이력 (필드·이전값·이후값·영향 과정·되돌리기 페이로드)
   - snapshots    : 연도별 기준정보 봉인 버전
   - meta         : 연도 목록·교육분류·교육방법
   - institutions/delta, competencies/delta : 변경된 행만 upsert / 삭제 (전체 replace 대체)
   - health       : 절전 방지·상태 확인용 (기존에 /api/health 가 있으면 그대로 두어도 됨)

   장착: src/server.js 에 아래 두 줄 추가
     const v2 = require('./routes/v2');
     app.use('/api/v2', v2);
   ===================================================================== */
const express = require('express');
const db = require('../db');
const router = express.Router();
router.use(express.json({ limit: '30mb' }));

const ok = (res, body) => res.json(Object.assign({ ok: true }, body || {}));
const fail = (res, e, code) => { console.error('[v2]', e); res.status(code || 500).json({ ok: false, error: String(e && e.message || e) }); };

/* ---------- capabilities / health ---------- */
router.get('/capabilities', (req, res) => ok(res, { version: 'v2', features: ['history', 'snapshots', 'meta', 'delta:institutions', 'delta:competencies'] }));
router.get('/health', async (req, res) => { try { await db.query('SELECT 1'); ok(res, { db: true, ts: new Date().toISOString() }); } catch (e) { fail(res, e, 503); } });

/* ---------- history ---------- */
router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
    const { entity, year } = req.query;
    const where = []; const params = [];
    if (entity) { params.push(entity); where.push(`entity = $${params.length}`); }
    if (year)   { params.push(parseInt(year)); where.push(`plan_year = $${params.length}`); }
    params.push(limit);
    const q = `SELECT hist_id AS id, ts, entity, op, target_key AS key, before_val AS before, after_val AS after,
                      plan_year AS year, user_nm AS "user", affected, undo_json AS undo, ref_id AS ref
               FROM tb_master_history ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ts DESC LIMIT $${params.length}`;
    const r = await db.query(q, params);
    ok(res, { rows: r.rows });
  } catch (e) { fail(res, e); }
});
router.post('/history', async (req, res) => {
  try {
    const e = req.body || {};
    if (!e.id || !e.entity || !e.op) return fail(res, 'id/entity/op required', 400);
    await db.query(
      `INSERT INTO tb_master_history (hist_id, ts, entity, op, target_key, before_val, after_val, plan_year, user_nm, affected, undo_json, ref_id)
       VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (hist_id) DO NOTHING`,
      [e.id, e.ts || null, e.entity, e.op, e.key || '', e.before || '', e.after || '', e.year || null, e.user || '', e.affected || 0, e.undo ? JSON.stringify(e.undo) : null, e.ref || null]);
    ok(res);
  } catch (e) { fail(res, e); }
});

/* ---------- snapshots (연도 봉인) ---------- */
router.get('/snapshots', async (req, res) => {
  try {
    const full = req.query.full === '1';
    const r = await db.query(
      `SELECT plan_year, sealed_at, sealed_by, ${full ? 'payload' : `jsonb_build_object('courses', payload->'courses') AS payload`}
       FROM tb_master_snapshot WHERE is_current = TRUE ORDER BY plan_year DESC`);
    // 프론트 SNAPS 형식으로 펼침 (payload 가 크므로 full=1 일 때만 전체)
    const rows = r.rows.map(x => Object.assign({ year: x.plan_year, sealedAt: x.sealed_at, by: x.sealed_by }, x.payload || {}));
    ok(res, { rows });
  } catch (e) { fail(res, e); }
});
router.get('/snapshots/:year', async (req, res) => {
  try {
    const r = await db.query(`SELECT plan_year, sealed_at, sealed_by, payload FROM tb_master_snapshot WHERE plan_year=$1 AND is_current=TRUE LIMIT 1`, [parseInt(req.params.year)]);
    if (!r.rows.length) return fail(res, 'not found', 404);
    const x = r.rows[0];
    ok(res, { snapshot: Object.assign({ year: x.plan_year, sealedAt: x.sealed_at, by: x.sealed_by }, x.payload) });
  } catch (e) { fail(res, e); }
});
router.post('/snapshots', async (req, res) => {
  const s = req.body || {};
  if (!s.year) return fail(res, 'year required', 400);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE tb_master_snapshot SET is_current = FALSE WHERE plan_year = $1`, [s.year]);
    const payload = { tax: s.tax, ktree: s.ktree, insts: s.insts, comps: s.comps, eduTypes: s.eduTypes, eduMethods: s.eduMethods, courses: s.courses || 0 };
    await client.query(`INSERT INTO tb_master_snapshot (plan_year, sealed_at, sealed_by, payload, is_current) VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, TRUE)`,
      [s.year, s.sealedAt || null, s.by || '', JSON.stringify(payload)]);
    await client.query('COMMIT');
    ok(res);
  } catch (e) { await client.query('ROLLBACK'); fail(res, e); } finally { client.release(); }
});

/* ---------- meta (연도·교육분류·교육방법) ---------- */
router.get('/meta', async (req, res) => {
  try { const r = await db.query(`SELECT meta_key, meta_val FROM tb_meta`); const meta = {}; r.rows.forEach(x => meta[x.meta_key] = x.meta_val); ok(res, { meta }); }
  catch (e) { fail(res, e); }
});
router.put('/meta', async (req, res) => {
  try {
    const meta = req.body || {};
    for (const k of Object.keys(meta)) {
      if (!['years', 'eduTypes', 'eduMethods'].includes(k)) continue;
      await db.query(`INSERT INTO tb_meta (meta_key, meta_val, updated_at) VALUES ($1, $2, now()) ON CONFLICT (meta_key) DO UPDATE SET meta_val = EXCLUDED.meta_val, updated_at = now()`, [k, JSON.stringify(meta[k])]);
    }
    ok(res);
  } catch (e) { fail(res, e); }
});

/* ---------- 교육기관 delta (변경 행만) ---------- */
const INST_HAS_CODE = { checked: false, col: null };
async function instCodeCol() {
  if (INST_HAS_CODE.checked) return INST_HAS_CODE.col;
  const r = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='tb_institution' AND column_name IN ('inst_cd','inst_code','code')`);
  INST_HAS_CODE.checked = true; INST_HAS_CODE.col = r.rows.length ? r.rows[0].column_name : null; return INST_HAS_CODE.col;
}
router.put('/institutions/delta', async (req, res) => {
  const { upsert = [], remove = [] } = req.body || {};
  const client = await db.getClient();
  try {
    const codeCol = await instCodeCol();
    await client.query('BEGIN');
    let up = 0, del = 0;
    for (const x of upsert) {
      const name = String(x.name || '').trim(); if (!name) continue;
      // ① 코드가 있으면 코드로, 없으면 이름으로 매칭
      let found = null;
      if (codeCol && x.code) { const r = await client.query(`SELECT institution_id FROM tb_institution WHERE ${codeCol}=$1`, [x.code]); found = r.rows[0] || null; }
      if (!found) { const r = await client.query(`SELECT institution_id FROM tb_institution WHERE inst_nm=$1`, [name]); found = r.rows[0] || null; }
      if (found) {
        await client.query(`UPDATE tb_institution SET inst_nm=$1, biz_no=$2, address=$3, tel=$4, homepage=$5, memo=$6, use_yn=TRUE, updated_at=now() WHERE institution_id=$7`,
          [name, x.biz || '', x.addr || '', x.tel || '', x.home || '', x.memo || '', found.institution_id]);
      } else {
        await client.query(`INSERT INTO tb_institution (inst_nm, biz_no, address, tel, homepage, memo, use_yn, valid_from) VALUES ($1,$2,$3,$4,$5,$6,TRUE,CURRENT_DATE)`,
          [name, x.biz || '', x.addr || '', x.tel || '', x.home || '', x.memo || '']);
      }
      up++;
    }
    for (const x of remove) {
      // 물리 삭제 대신 폐지(use_yn=FALSE, valid_to) — 이력·복원 대응. 기존 bootstrap 이 use_yn=TRUE 만 내려주는지 확인 필요
      const r = await client.query(`UPDATE tb_institution SET use_yn=FALSE, valid_to=CURRENT_DATE, updated_at=now() WHERE inst_nm=$1${codeCol && x.code ? ` OR ${codeCol}=$2` : ''}`, codeCol && x.code ? [x.name || '', x.code] : [x.name || '']);
      del += r.rowCount;
    }
    await client.query('COMMIT');
    ok(res, { upserted: up, removed: del });
  } catch (e) { await client.query('ROLLBACK'); fail(res, e); } finally { client.release(); }
});

/* ---------- 역량 delta (변경 행만) ---------- */
router.put('/competencies/delta', async (req, res) => {
  const { upsert = [], remove = [] } = req.body || {};
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    let up = 0, del = 0;
    for (const c of upsert) {
      const name = String(c.name || '').trim(); if (!name || !c.jg || !c.sr) continue;
      const lv = (c.lv === '' || c.lv == null) ? null : parseInt(c.lv);
      const r = await client.query(
        `INSERT INTO tb_competency (jikgye, jikryeol, jikmu, comp_level, comp_nm, use_yn, valid_from) VALUES ($1,$2,$3,$4,$5,TRUE,CURRENT_DATE)
         ON CONFLICT (jikgye, jikryeol, jikmu, comp_level, comp_nm) DO UPDATE SET use_yn=TRUE, valid_to=NULL, updated_at=now()`,
        [c.jg, c.sr, c.jb || '', lv, name]);
      up += r.rowCount;
    }
    for (const c of remove) {
      const lv = (c.lv === '' || c.lv == null) ? null : parseInt(c.lv);
      const r = await client.query(
        `UPDATE tb_competency SET use_yn=FALSE, valid_to=CURRENT_DATE, updated_at=now()
         WHERE jikgye=$1 AND jikryeol=$2 AND jikmu=$3 AND comp_nm=$4 AND (comp_level IS NOT DISTINCT FROM $5)`,
        [c.jg || '', c.sr || '', c.jb || '', c.name || '', lv]);
      del += r.rowCount;
    }
    await client.query('COMMIT');
    ok(res, { upserted: up, removed: del });
  } catch (e) { await client.query('ROLLBACK'); fail(res, e); } finally { client.release(); }
});

module.exports = router;

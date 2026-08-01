try { require('dotenv').config(); } catch { /* dotenv optional; cloud injects env vars */ }
const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cors({ origin: (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim()) }));

// 간단 요청 로깅
app.use((req, _res, next) => { console.log(`${req.method} ${req.url}`); next(); });

// 헬스체크
app.get('/api/health', async (_req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true, db: 'up' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 라우트 등록
app.use('/api/courses',        require('./routes/courses'));
app.use('/api/job-taxonomy',   require('./routes/taxonomy'));
app.use('/api/framework',      require('./routes/framework'));
app.use('/api/competencies',   require('./routes/competencies'));
app.use('/api/institutions',   require('./routes/institutions'));
app.use('/api/demands',        require('./routes/demands'));
app.use('/api/depts',          require('./routes/depts'));
app.use('/api/sync',           require('./routes/sync'));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`KHNP edu API listening on :${PORT}`));

-- =====================================================================
--  KHNP 교육과정 플랫폼 — 3층 운영 안전망
--  적용:  psql "$DATABASE_URL" -f db/ops.sql
--
--  ① 백업 스냅샷 보존 개선 — 좋은 스냅샷이 밀려 사라지지 않게
--  ② 원시 백업(raw backup) — 앱과 무관하게 표 전체를 통째로 보관
--  ③ 매일 자동 실행용 함수 — Render Cron Job 에서 한 줄로 호출
-- =====================================================================


-- =====================================================================
--  ① 스냅샷 보존 개선
-- =====================================================================

-- 보호 표시 컬럼 — true 인 스냅샷은 정리 대상에서 영구 제외
ALTER TABLE tb_snapshot ADD COLUMN IF NOT EXISTS protected BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS ix_snapshot_cnt ON tb_snapshot(course_cnt DESC);


-- 스냅샷 정리 함수
--   keep_n 개의 최신 스냅샷 + 보호 표시된 것 + 과정 수 최대인 것은 항상 남김
CREATE OR REPLACE FUNCTION fn_prune_snapshots(keep_n INT DEFAULT 100)
RETURNS TABLE(deleted BIGINT, remaining BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  v_del BIGINT;
  v_rem BIGINT;
BEGIN
  WITH keepers AS (
    -- 최신 keep_n 개
    (SELECT snapshot_id FROM tb_snapshot ORDER BY created_at DESC LIMIT keep_n)
    UNION
    -- 보호 표시된 것
    (SELECT snapshot_id FROM tb_snapshot WHERE protected)
    UNION
    -- 수동 백업은 전부 보존
    (SELECT snapshot_id FROM tb_snapshot WHERE kind <> 'auto')
    UNION
    -- 과정 수가 가장 많은 스냅샷 (최후의 보루)
    (SELECT snapshot_id FROM tb_snapshot ORDER BY course_cnt DESC, created_at DESC LIMIT 1)
  ),
  gone AS (
    DELETE FROM tb_snapshot
     WHERE snapshot_id NOT IN (SELECT snapshot_id FROM keepers)
    RETURNING 1
  )
  SELECT count(*) INTO v_del FROM gone;

  SELECT count(*) INTO v_rem FROM tb_snapshot;
  RETURN QUERY SELECT v_del, v_rem;
END $$;


-- 과정 수가 가장 많은 스냅샷을 자동으로 보호 표시
UPDATE tb_snapshot
   SET protected = TRUE
 WHERE snapshot_id = (
   SELECT snapshot_id FROM tb_snapshot ORDER BY course_cnt DESC, created_at DESC LIMIT 1
 );


-- =====================================================================
--  ② 원시 백업 — 앱 코드와 무관한 안전 사본
-- =====================================================================

CREATE TABLE IF NOT EXISTS tb_raw_backup (
  raw_id     BIGSERIAL PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT 'daily',
  payload    JSONB NOT NULL,
  row_counts JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_raw_backup_time ON tb_raw_backup(created_at DESC);


-- 존재하는 표만 골라 JSONB 로 덤프
DROP FUNCTION IF EXISTS fn_raw_backup(TEXT);
CREATE FUNCTION fn_raw_backup(p_reason TEXT DEFAULT 'daily')
RETURNS TABLE(backup_id BIGINT, counts JSONB)
LANGUAGE plpgsql AS $$
DECLARE
  t        TEXT;
  v_data   JSONB := '{}'::jsonb;
  v_counts JSONB := '{}'::jsonb;
  v_rows   JSONB;
  v_cnt    BIGINT;
  v_id     BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tb_course','tb_course_map','tb_course_comp','tb_course_tag',
    'tb_job_taxonomy','tb_competency','tb_institution','tb_framework',
    'tb_dept','tb_demand','tb_demand_item'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema='public' AND table_name=t) THEN
      CONTINUE;
    END IF;

    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb), count(*) FROM %I x', t)
       INTO v_rows, v_cnt;

    v_data   := v_data   || jsonb_build_object(t, v_rows);
    v_counts := v_counts || jsonb_build_object(t, v_cnt);
  END LOOP;

  INSERT INTO tb_raw_backup(reason, payload, row_counts)
  VALUES (p_reason, v_data, v_counts)
  RETURNING tb_raw_backup.raw_id INTO v_id;


  -- 30일 지난 원시 백업은 정리 (용량 관리)
  DELETE FROM tb_raw_backup b
   WHERE b.created_at < now() - INTERVAL '30 days'
     AND b.raw_id <> v_id;

  RETURN QUERY SELECT v_id, v_counts;
END $$;


-- =====================================================================
--  ③ 매일 실행용 — Cron Job 에서 이 한 줄만 호출
-- =====================================================================

CREATE OR REPLACE FUNCTION fn_daily_maintenance()
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_raw    BIGINT;
  v_counts JSONB;
  v_del    BIGINT;
  v_rem    BIGINT;
BEGIN
  SELECT backup_id, counts INTO v_raw, v_counts FROM fn_raw_backup('daily');
  SELECT deleted, remaining INTO v_del, v_rem FROM fn_prune_snapshots(100);

  RETURN format('원시백업 #%s 생성 / 스냅샷 %s개 정리, %s개 유지 / 건수 %s',
                v_raw, v_del, v_rem, v_counts::text);
END $$;


-- =====================================================================
--  확인
-- =====================================================================
SELECT count(*) FILTER (WHERE protected) AS "보호된스냅샷",
       count(*)                          AS "전체스냅샷",
       max(course_cnt)                   AS "최대과정수"
  FROM tb_snapshot;


-- =====================================================================
--  【 사용법 】
--
--  즉시 원시 백업 1회
--      SELECT * FROM fn_raw_backup('수동');
--
--  매일 자동 (Render Cron Job 명령)
--      psql "$DATABASE_URL" -c "SELECT fn_daily_maintenance();"
--
--  원시 백업 목록 보기
--      SELECT raw_id, reason, row_counts, created_at
--        FROM tb_raw_backup ORDER BY created_at DESC LIMIT 20;
--
--  특정 스냅샷 영구 보호
--      UPDATE tb_snapshot SET protected=TRUE WHERE snapshot_id=183;
--
--  원시 백업에서 과정 복원 (예: raw_id 1)
--      -- 반드시 안전장치를 잠시 끄고 진행
--      UPDATE tb_guard_config SET enabled=false WHERE table_name='tb_course';
--      DELETE FROM tb_course;
--      INSERT INTO tb_course
--      SELECT * FROM jsonb_populate_recordset(
--        null::tb_course,
--        (SELECT payload->'tb_course' FROM tb_raw_backup WHERE raw_id=1));
--      UPDATE tb_guard_config SET enabled=true WHERE table_name='tb_course';
-- =====================================================================

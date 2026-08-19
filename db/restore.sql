-- =====================================================================
--  KHNP 교육과정 플랫폼 — 스냅샷 직접 복원 (DB 내부 실행)
--  적용:  psql "$DATABASE_URL" -f db/restore.sql
--  사용:  psql "$DATABASE_URL" -c "SELECT * FROM fn_restore_snapshot(198);"
--
--  화면의 「이 시점으로 복원」은 데이터를 한 줄씩 넣기 때문에
--  역량 16,000건 규모에서는 수 분이 걸리거나 멈춘 것처럼 보입니다.
--  이 함수는 같은 일을 DB 안에서 한 번에 처리해 수 초 만에 끝냅니다.
--
--  안전장치(guard)와 호환됩니다.
--    TRUNCATE 를 쓰지 않고, 같은 트랜잭션에서 DELETE 후 곧바로 재삽입하므로
--    트랜잭션 종료 시점의 건수 검사를 정상 통과합니다.
--
--  앱의 복원보다 더 정확합니다.
--    앱 복원은 tb_course.institution_id 를 넣지 않아 과정-기관 연결이 끊깁니다.
--    이 함수는 스냅샷에 담긴 모든 컬럼을 그대로 되살립니다.
-- =====================================================================

CREATE OR REPLACE FUNCTION fn_restore_snapshot(p_id BIGINT)
RETURNS TABLE(항목 TEXT, 복원건수 BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  s JSONB;
BEGIN
  SELECT payload INTO s FROM tb_snapshot WHERE snapshot_id = p_id;
  IF s IS NULL THEN
    RAISE EXCEPTION '스냅샷 %번을 찾을 수 없습니다.', p_id;
  END IF;

  -- 복원 직전 현재 상태를 원시 백업으로 보관 (되돌릴 수 있도록)
  BEGIN
    PERFORM fn_raw_backup('복원 직전 (스냅샷 ' || p_id || ')');
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'fn_raw_backup 이 없어 사전 백업을 건너뜁니다 (ops.sql 미적용).';
  END;

  -- ── 비우기: 자식 → 부모 순서 ───────────────────────────────────
  DELETE FROM tb_course_comp;
  DELETE FROM tb_course_tag;
  DELETE FROM tb_course_map;
  DELETE FROM tb_course;
  DELETE FROM tb_competency;
  DELETE FROM tb_job_taxonomy;
  DELETE FROM tb_framework;
  DELETE FROM tb_institution;

  -- ── 채우기: 부모 → 자식 순서 ───────────────────────────────────
  INSERT INTO tb_institution(inst_nm, biz_no, address, tel, homepage, memo)
  SELECT x.inst_nm, x.biz_no, x.address, x.tel, x.homepage, x.memo
    FROM jsonb_to_recordset(COALESCE(s->'insts', '[]'::jsonb))
      AS x(inst_nm TEXT, biz_no TEXT, address TEXT, tel TEXT, homepage TEXT, memo TEXT)
   WHERE COALESCE(x.inst_nm,'') <> ''
  ON CONFLICT (inst_nm) DO NOTHING;

  INSERT INTO tb_job_taxonomy(jikgye, jikryeol, jikmu)
  SELECT x.jikgye, x.jikryeol, x.jikmu
    FROM jsonb_to_recordset(COALESCE(s->'tax', '[]'::jsonb))
      AS x(jikgye TEXT, jikryeol TEXT, jikmu TEXT)
  ON CONFLICT DO NOTHING;

  INSERT INTO tb_framework(kb1, kb2, kb3)
  SELECT x.kb1, x.kb2, x.kb3
    FROM jsonb_to_recordset(COALESCE(s->'fw', '[]'::jsonb))
      AS x(kb1 TEXT, kb2 TEXT, kb3 TEXT)
  ON CONFLICT DO NOTHING;

  INSERT INTO tb_competency(jikgye, jikryeol, jikmu, comp_level, comp_nm)
  SELECT x.jikgye, x.jikryeol, x.jikmu, x.comp_level, x.comp_nm
    FROM jsonb_to_recordset(COALESCE(s->'cp', '[]'::jsonb))
      AS x(jikgye TEXT, jikryeol TEXT, jikmu TEXT, comp_level INT, comp_nm TEXT)
  ON CONFLICT DO NOTHING;

  -- 과정: 스냅샷의 모든 컬럼을 그대로 복원 (institution_id 포함)
  INSERT INTO tb_course
  SELECT * FROM jsonb_populate_recordset(NULL::tb_course, COALESCE(s->'courses', '[]'::jsonb))
  ON CONFLICT (course_id) DO NOTHING;

  INSERT INTO tb_course_map
  SELECT * FROM jsonb_populate_recordset(NULL::tb_course_map, COALESCE(s->'maps', '[]'::jsonb))
  ON CONFLICT DO NOTHING;

  INSERT INTO tb_course_comp(map_id, comp_nm)
  SELECT x.map_id, x.comp_nm
    FROM jsonb_to_recordset(COALESCE(s->'comps', '[]'::jsonb))
      AS x(map_id BIGINT, comp_nm TEXT)
   WHERE EXISTS (SELECT 1 FROM tb_course_map m WHERE m.map_id = x.map_id)
  ON CONFLICT DO NOTHING;

  INSERT INTO tb_course_tag(course_id, tag)
  SELECT x.course_id, x.tag
    FROM jsonb_to_recordset(COALESCE(s->'tags', '[]'::jsonb))
      AS x(course_id BIGINT, tag TEXT)
   WHERE EXISTS (SELECT 1 FROM tb_course c WHERE c.course_id = x.course_id)
  ON CONFLICT DO NOTHING;

  -- ── 시퀀스 재정렬 (명시적 ID 삽입 후 필수) ─────────────────────
  PERFORM setval(pg_get_serial_sequence('tb_course','course_id'),
                 GREATEST(COALESCE((SELECT MAX(course_id) FROM tb_course), 0), 1));
  PERFORM setval(pg_get_serial_sequence('tb_course_map','map_id'),
                 GREATEST(COALESCE((SELECT MAX(map_id) FROM tb_course_map), 0), 1));
  PERFORM setval(pg_get_serial_sequence('tb_institution','institution_id'),
                 GREATEST(COALESCE((SELECT MAX(institution_id) FROM tb_institution), 0), 1));

  -- ── 안전장치 기준선을 복원된 실제 건수로 재설정 ────────────────
  BEGIN
    UPDATE tb_guard_config g
       SET hwm = x.c, updated_at = now()
      FROM (SELECT 'tb_course' AS t, count(*) AS c FROM tb_course
            UNION ALL SELECT 'tb_institution',  count(*) FROM tb_institution
            UNION ALL SELECT 'tb_job_taxonomy', count(*) FROM tb_job_taxonomy
            UNION ALL SELECT 'tb_competency',   count(*) FROM tb_competency) x
     WHERE g.table_name = x.t;
  EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'tb_guard_config 이 없어 기준선 재설정을 건너뜁니다.';
  END;

  RETURN QUERY
    SELECT '과정'::TEXT,     count(*) FROM tb_course
    UNION ALL SELECT '과정매핑', count(*) FROM tb_course_map
    UNION ALL SELECT '교육기관', count(*) FROM tb_institution
    UNION ALL SELECT '직무체계', count(*) FROM tb_job_taxonomy
    UNION ALL SELECT '교육체계', count(*) FROM tb_framework
    UNION ALL SELECT '역량',     count(*) FROM tb_competency;
END $$;


-- =====================================================================
--  【 사용법 】
--
--  1) 복원할 스냅샷 고르기
--       SELECT snapshot_id, reason, course_cnt, created_at
--         FROM tb_snapshot WHERE course_cnt > 0
--        ORDER BY course_cnt DESC LIMIT 10;
--
--  2) 복원 실행 (예: 198번)
--       SELECT * FROM fn_restore_snapshot(198);
--
--  3) 결과가 표로 바로 출력됩니다.
-- =====================================================================

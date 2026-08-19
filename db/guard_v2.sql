-- =====================================================================
--  KHNP 교육과정 플랫폼 — 2층 안전장치 (대량 소실 차단)
--  적용:  psql "$DATABASE_URL" -f db/guard_v2.sql
--
--  1층(guard.sql)은 "0건이 되는 것"만 막았습니다.
--  이 2층은 "621건이 3건으로 줄어드는" 부분 소실까지 막습니다.
--
--  판정 규칙 (트랜잭션이 끝나는 시점에 검사)
--    보관 기준선(hwm) = 그 표가 지금까지 가졌던 최대 건수
--    남은 건수 < 기준선 × 비율(기본 50%)  →  저장 전체 취소
--    단, 기준선이 min_rows(기본 20) 미만이면 검사하지 않음
--      (초기 구축 단계에서 몇 건씩 넣고 지우는 작업을 막지 않기 위함)
--
--  정상 작업은 통과합니다.
--    예) 엑셀 1,815건 일괄등록 = 전체삭제 후 재삽입이지만
--        끝났을 때 1,815건이므로 통과하고, 기준선도 1,815로 올라감
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) 설정표 — 표별 기준선과 허용 비율
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tb_guard_config (
  table_name  TEXT PRIMARY KEY,
  hwm         BIGINT  NOT NULL DEFAULT 0,   -- 최대 보유 건수(자동 갱신)
  keep_ratio  NUMERIC NOT NULL DEFAULT 0.5, -- 최소 유지 비율
  min_rows    BIGINT  NOT NULL DEFAULT 20,  -- 이 미만이면 검사 안 함
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMP NOT NULL DEFAULT now()
);

COMMENT ON TABLE tb_guard_config IS 'KHNP 데이터 소실 방지 안전장치 설정';


-- ---------------------------------------------------------------------
-- 2) 검사 함수 — 트랜잭션 종료 시점에 1회만 수행
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_guard_mass_loss() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cfg   tb_guard_config%ROWTYPE;
  v_cnt   BIGINT;
  v_floor BIGINT;
BEGIN
  -- 같은 트랜잭션에서 여러 행이 지워져도 검사는 한 번만
  IF current_setting('guard.ck2_' || TG_TABLE_NAME, true) = '1' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('guard.ck2_' || TG_TABLE_NAME, '1', true);

  SELECT * INTO v_cfg FROM tb_guard_config WHERE table_name = TG_TABLE_NAME;
  IF NOT FOUND OR NOT v_cfg.enabled THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SELECT count(*) FROM %I', TG_TABLE_NAME) INTO v_cnt;

  -- 기준선이 아직 작으면 검사하지 않음
  IF v_cfg.hwm >= v_cfg.min_rows THEN
    v_floor := ceil(v_cfg.hwm * v_cfg.keep_ratio);

    IF v_cnt < v_floor THEN
      RAISE EXCEPTION
        '[GUARD] % 대량 소실 차단 — 기존 %건 중 %건만 남게 되어 저장을 취소했습니다.',
        TG_TABLE_NAME, v_cfg.hwm, v_cnt
        USING HINT = '의도한 작업이라면: UPDATE tb_guard_config SET enabled=false WHERE table_name='''
                     || TG_TABLE_NAME || '''; 실행 후 진행하고, 끝나면 다시 true 로 되돌리세요.';
    END IF;
  END IF;

  -- 통과했으면 기준선 갱신
  IF v_cnt > v_cfg.hwm THEN
    UPDATE tb_guard_config
       SET hwm = v_cnt, updated_at = now()
     WHERE table_name = TG_TABLE_NAME;
  END IF;

  RETURN NULL;
END $$;


-- ---------------------------------------------------------------------
-- 3) 기준선 상승 감지 — 삽입으로만 늘어난 경우도 반영
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_guard_raise_hwm() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cnt BIGINT;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I', TG_TABLE_NAME) INTO v_cnt;
  UPDATE tb_guard_config
     SET hwm = v_cnt, updated_at = now()
   WHERE table_name = TG_TABLE_NAME
     AND hwm < v_cnt;
  RETURN NULL;
END $$;


-- ---------------------------------------------------------------------
-- 4) TRUNCATE 차단
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_guard_block_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '[GUARD] % 에 대한 TRUNCATE 가 차단되었습니다.', TG_TABLE_NAME
    USING HINT = 'UPDATE tb_guard_config SET enabled=false WHERE table_name='''
                 || TG_TABLE_NAME || '''; 후 ALTER TABLE ' || TG_TABLE_NAME
                 || ' DISABLE TRIGGER USER; 로 진행하세요.';
END $$;


-- ---------------------------------------------------------------------
-- 5) 보호 대상 표에 설치 (현재 건수를 기준선으로 등록)
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t     TEXT;
  v_cnt BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tb_course','tb_job_taxonomy','tb_institution','tb_competency']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema='public' AND table_name=t) THEN
      RAISE NOTICE '[GUARD] % 표가 없어 건너뜁니다.', t;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(*) FROM %I', t) INTO v_cnt;

    INSERT INTO tb_guard_config(table_name, hwm)
    VALUES (t, v_cnt)
    ON CONFLICT (table_name) DO UPDATE
      SET hwm = GREATEST(tb_guard_config.hwm, EXCLUDED.hwm),
          updated_at = now();

    EXECUTE format('DROP TRIGGER IF EXISTS trg_guard2_del_%s ON %I', t, t);
    EXECUTE format($f$
      CREATE CONSTRAINT TRIGGER trg_guard2_del_%s
        AFTER DELETE ON %I
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION fn_guard_mass_loss()
    $f$, t, t);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_guard2_ins_%s ON %I', t, t);
    EXECUTE format($f$
      CREATE TRIGGER trg_guard2_ins_%s
        AFTER INSERT ON %I
        FOR EACH STATEMENT EXECUTE FUNCTION fn_guard_raise_hwm()
    $f$, t, t);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_guard2_trunc_%s ON %I', t, t);
    EXECUTE format($f$
      CREATE TRIGGER trg_guard2_trunc_%s
        BEFORE TRUNCATE ON %I
        FOR EACH STATEMENT EXECUTE FUNCTION fn_guard_block_truncate()
    $f$, t, t);

    RAISE NOTICE '[GUARD] % 보호 완료 — 기준선 %건', t, v_cnt;
  END LOOP;
END $$;


-- ---------------------------------------------------------------------
-- 6) 설치 확인
-- ---------------------------------------------------------------------
SELECT table_name AS "보호대상",
       hwm        AS "기준선",
       ceil(hwm * keep_ratio)::BIGINT AS "최소유지",
       enabled    AS "작동"
  FROM tb_guard_config
 ORDER BY table_name;

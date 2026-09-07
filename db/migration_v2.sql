-- =====================================================================
--  한수원 교육과정 플랫폼 · v2 확장 마이그레이션 (기존 schema.sql 위에 추가 적용)
--  실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migration_v2.sql
--  기존 테이블·데이터는 건드리지 않습니다 (ADD COLUMN IF NOT EXISTS / CREATE IF NOT EXISTS 만 사용)
-- =====================================================================
BEGIN;

-- ---------- ① 기준정보 변경 이력 (필드 단위 · 되돌리기 페이로드 포함) ----------
CREATE TABLE IF NOT EXISTS tb_master_history (
  hist_id     VARCHAR(40)  PRIMARY KEY,              -- 프론트에서 생성한 id (중복 전송 방지)
  ts          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  entity      VARCHAR(20)  NOT NULL,                 -- 직무체계/교육체계/교육기관/역량/교육분류/교육방법/기준정보
  op          VARCHAR(30)  NOT NULL,                 -- 추가/명칭 수정/수정/폐지/되돌리기/연도 봉인/…
  target_key  VARCHAR(400) NOT NULL DEFAULT '',      -- 경로 (예: 원자력발전 › 발전운영 › 주제어)
  before_val  TEXT         NOT NULL DEFAULT '',
  after_val   TEXT         NOT NULL DEFAULT '',
  plan_year   SMALLINT,                              -- 작업 당시 화면 기준 연도
  user_nm     VARCHAR(80)  DEFAULT '',
  affected    INT          NOT NULL DEFAULT 0,       -- 영향받은 과정 수
  undo_json   JSONB,                                 -- 되돌리기 페이로드
  ref_id      VARCHAR(40)                            -- 되돌리기 대상 이력 id
);
CREATE INDEX IF NOT EXISTS ix_mh_ts     ON tb_master_history(ts DESC);
CREATE INDEX IF NOT EXISTS ix_mh_entity ON tb_master_history(entity, ts DESC);
CREATE INDEX IF NOT EXISTS ix_mh_year   ON tb_master_history(plan_year);

-- ---------- ② 연도별 기준정보 스냅샷 (봉인 버전) ----------
CREATE TABLE IF NOT EXISTS tb_master_snapshot (
  snapshot_id BIGSERIAL    PRIMARY KEY,
  plan_year   SMALLINT     NOT NULL,
  sealed_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  sealed_by   VARCHAR(80)  DEFAULT '',
  payload     JSONB        NOT NULL,                 -- {tax, ktree, insts, comps, eduTypes, eduMethods, courses}
  is_current  BOOLEAN      NOT NULL DEFAULT TRUE     -- 같은 연도에 재봉인하면 이전 버전은 FALSE
);
CREATE INDEX IF NOT EXISTS ix_ms_year ON tb_master_snapshot(plan_year, sealed_at DESC);

-- ---------- ③ 소규모 마스터(연도 목록·교육분류·교육방법) 키-값 저장 ----------
CREATE TABLE IF NOT EXISTS tb_meta (
  meta_key    VARCHAR(40)  PRIMARY KEY,
  meta_val    JSONB        NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------- ④ Effective dating 컬럼 (기준정보 4종) — 이후 '연도별 유효 기준정보' 조회용 ----------
ALTER TABLE tb_job_taxonomy ADD COLUMN IF NOT EXISTS valid_from DATE, ADD COLUMN IF NOT EXISTS valid_to DATE, ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE tb_framework    ADD COLUMN IF NOT EXISTS valid_from DATE, ADD COLUMN IF NOT EXISTS valid_to DATE, ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE tb_institution  ADD COLUMN IF NOT EXISTS valid_from DATE, ADD COLUMN IF NOT EXISTS valid_to DATE, ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE tb_competency   ADD COLUMN IF NOT EXISTS valid_from DATE, ADD COLUMN IF NOT EXISTS valid_to DATE, ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- ---------- ⑤ 저장 속도: 자주 쓰는 조회 경로 인덱스 ----------
CREATE INDEX IF NOT EXISTS ix_inst_nm_lower ON tb_institution (lower(inst_nm));
CREATE INDEX IF NOT EXISTS ix_comp_nm_lower ON tb_competency  (lower(comp_nm));
-- tb_course 의 연도·대표코드 컬럼명은 실제 스키마 기준으로 확인 후 아래 주석을 해제하세요
-- CREATE INDEX IF NOT EXISTS ix_course_year ON tb_course(edu_year);
-- CREATE INDEX IF NOT EXISTS ix_course_grp  ON tb_course(rep_code);

COMMIT;

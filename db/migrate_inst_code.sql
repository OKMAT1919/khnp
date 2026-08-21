-- =====================================================================
--  교육기관 ID(코드) 도입 + 과정↔기관 연결 복구
--  실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrate_inst_code.sql
--  성격: 재실행 안전(idempotent). 기존 데이터를 지우지 않습니다.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 1) 기관코드 컬럼 (IN0001 형식)
-- ---------------------------------------------------------------------
ALTER TABLE tb_institution ADD COLUMN IF NOT EXISTS inst_cd VARCHAR(10);

-- 명칭 정규화 함수 — 공백·괄호·법인표기 제거 후 비교용 키
CREATE OR REPLACE FUNCTION f_norm_inst(t text) RETURNS text AS $$
  SELECT lower(regexp_replace(
           regexp_replace(coalesce(t, ''),
             '\(주\)|\(재\)|\(사\)|\(학\)|㈜|주식회사|재단법인|사단법인|학교법인', '', 'g'),
           '[[:space:]()\[\]·ㆍ,\.\-_/]', '', 'g'));
$$ LANGUAGE sql IMMUTABLE;

-- 기존 기관에 코드 채번 (이름순, 이미 코드가 있으면 건드리지 않음)
WITH base AS (
  SELECT coalesce(max(substring(inst_cd from 3)::int), 0) AS mx
  FROM tb_institution WHERE inst_cd ~ '^IN[0-9]+$'
), n AS (
  SELECT institution_id, row_number() OVER (ORDER BY inst_nm) AS rn
  FROM tb_institution WHERE inst_cd IS NULL OR inst_cd = ''
)
UPDATE tb_institution i
   SET inst_cd = 'IN' || lpad((base.mx + n.rn)::text, 4, '0')
  FROM n, base
 WHERE i.institution_id = n.institution_id;

ALTER TABLE tb_institution ALTER COLUMN inst_cd SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_inst_cd ON tb_institution(inst_cd);

-- 신규 기관은 어느 경로로 들어와도 코드가 자동 부여되도록 트리거
CREATE OR REPLACE FUNCTION trg_inst_cd() RETURNS trigger AS $$
BEGIN
  IF NEW.inst_cd IS NULL OR NEW.inst_cd = '' THEN
    SELECT 'IN' || lpad((coalesce(max(substring(inst_cd from 3)::int), 0) + 1)::text, 4, '0')
      INTO NEW.inst_cd
      FROM tb_institution WHERE inst_cd ~ '^IN[0-9]+$';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_inst_cd ON tb_institution;
CREATE TRIGGER tg_inst_cd BEFORE INSERT ON tb_institution
  FOR EACH ROW EXECUTE FUNCTION trg_inst_cd();

-- ---------------------------------------------------------------------
-- 2) 과정 → 기관 연결 복구 (institution_id 백필)
--    ① 이름 정확일치  ② 정규화 일치  순으로 채웁니다.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_course_inst ON tb_course(institution_id);

-- ① 정확일치
UPDATE tb_course c
   SET institution_id = i.institution_id
  FROM tb_institution i
 WHERE c.institution_id IS NULL
   AND coalesce(c.inst_nm, '') <> ''
   AND i.inst_nm = c.inst_nm;

-- ② 정규화 일치 (같은 정규화 키가 여럿이면 가장 먼저 등록된 기관으로)
UPDATE tb_course c
   SET institution_id = s.institution_id
  FROM (
    SELECT DISTINCT ON (f_norm_inst(inst_nm))
           f_norm_inst(inst_nm) AS k, institution_id
      FROM tb_institution
     ORDER BY f_norm_inst(inst_nm), institution_id
  ) s
 WHERE c.institution_id IS NULL
   AND coalesce(c.inst_nm, '') <> ''
   AND s.k = f_norm_inst(c.inst_nm);

-- ③ 연결된 과정의 표시 이름을 기관 마스터 표준명으로 통일
UPDATE tb_course c
   SET inst_nm = i.inst_nm
  FROM tb_institution i
 WHERE c.institution_id = i.institution_id
   AND c.inst_nm IS DISTINCT FROM i.inst_nm;

COMMIT;

-- ---------------------------------------------------------------------
-- 3) 결과 리포트
-- ---------------------------------------------------------------------
\echo ''
\echo '── 기관 마스터 ──'
SELECT count(*) AS 기관수, min(inst_cd) AS 첫코드, max(inst_cd) AS 끝코드 FROM tb_institution;

\echo ''
\echo '── 과정 연결 상태 ──'
SELECT count(*) FILTER (WHERE institution_id IS NOT NULL)                              AS 연계됨,
       count(*) FILTER (WHERE institution_id IS NULL AND coalesce(inst_nm,'') <> '')  AS 미연계,
       count(*) FILTER (WHERE coalesce(inst_nm,'') = '')                              AS 기관없음
  FROM tb_course;

\echo ''
\echo '── 미연계 원문 상위 30 (과정등록 탭에서 수동 지정 대상) ──'
SELECT inst_nm AS 원문, count(*) AS 과정수
  FROM tb_course
 WHERE institution_id IS NULL AND coalesce(inst_nm,'') <> ''
 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30;

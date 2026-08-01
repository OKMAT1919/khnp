-- =====================================================================
--  한수원 교육과정 등록·신청 플랫폼  ·  PostgreSQL 스키마 (v1)
--  DBMS: PostgreSQL 14+     문자셋: UTF-8
--  실행: psql "$DATABASE_URL" -f db/schema.sql
-- =====================================================================
BEGIN;

DROP TABLE IF EXISTS tb_change_log      CASCADE;
DROP TABLE IF EXISTS tb_demand_item     CASCADE;
DROP TABLE IF EXISTS tb_demand          CASCADE;
DROP TABLE IF EXISTS tb_course_comp     CASCADE;
DROP TABLE IF EXISTS tb_course_map      CASCADE;
DROP TABLE IF EXISTS tb_course_tag      CASCADE;
DROP TABLE IF EXISTS tb_course          CASCADE;
DROP TABLE IF EXISTS tb_competency      CASCADE;
DROP TABLE IF EXISTS tb_job_taxonomy    CASCADE;
DROP TABLE IF EXISTS tb_framework       CASCADE;
DROP TABLE IF EXISTS tb_institution     CASCADE;
DROP TABLE IF EXISTS tb_dept            CASCADE;
DROP TABLE IF EXISTS tb_user            CASCADE;

-- ---------- 기준정보 : 직무체계 (직계 > 직렬 > 직무) ----------
CREATE TABLE tb_job_taxonomy (
  job_id      SERIAL PRIMARY KEY,
  jikgye      VARCHAR(40)  NOT NULL,
  jikryeol    VARCHAR(60)  NOT NULL,
  jikmu       VARCHAR(100) NOT NULL DEFAULT '',
  sort_no     INT DEFAULT 0,
  use_yn      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (jikgye, jikryeol, jikmu)
);
CREATE INDEX ix_job_jikgye ON tb_job_taxonomy(jikgye);
CREATE INDEX ix_job_path   ON tb_job_taxonomy(jikgye, jikryeol);

-- ---------- 기준정보 : 교육체계 (대분류 > 중분류 > 소분류) ----------
CREATE TABLE tb_framework (
  fw_id       SERIAL PRIMARY KEY,
  kb1         VARCHAR(40)  NOT NULL,
  kb2         VARCHAR(60)  NOT NULL,
  kb3         VARCHAR(80)  NOT NULL DEFAULT '',
  sort_no     INT DEFAULT 0,
  use_yn      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (kb1, kb2, kb3)
);
CREATE INDEX ix_fw_kb1 ON tb_framework(kb1);

-- ---------- 기준정보 : 역량 ----------
CREATE TABLE tb_competency (
  comp_id     SERIAL PRIMARY KEY,
  jikgye      VARCHAR(40)  NOT NULL,
  jikryeol    VARCHAR(60)  NOT NULL,
  jikmu       VARCHAR(100) NOT NULL DEFAULT '',
  comp_level  SMALLINT,
  comp_nm     VARCHAR(200) NOT NULL,
  use_yn      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (jikgye, jikryeol, jikmu, comp_level, comp_nm)
);
CREATE INDEX ix_comp_path ON tb_competency(jikgye, jikryeol, jikmu);
CREATE INDEX ix_comp_nm   ON tb_competency(comp_nm);

-- ---------- 기준정보 : 교육기관 ----------
CREATE TABLE tb_institution (
  institution_id SERIAL PRIMARY KEY,
  inst_nm     VARCHAR(120) NOT NULL UNIQUE,
  biz_no      VARCHAR(20)  DEFAULT '',
  address     VARCHAR(200) DEFAULT '',
  tel         VARCHAR(40)  DEFAULT '',
  homepage    VARCHAR(300) DEFAULT '',
  memo        VARCHAR(200) DEFAULT '',
  use_yn      BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX ix_inst_nm ON tb_institution(inst_nm);

-- ---------- 기준정보 : 부서 (eHR 연계) ----------
CREATE TABLE tb_dept (
  dept_id     SERIAL PRIMARY KEY,
  dept_cd     VARCHAR(20) UNIQUE,
  dept_nm     VARCHAR(80) NOT NULL,
  parent_dept VARCHAR(80) DEFAULT '',
  use_yn      BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------- 사용자 (SSO/eHR 연계) ----------
CREATE TABLE tb_user (
  user_id     VARCHAR(30) PRIMARY KEY,
  user_nm     VARCHAR(40) NOT NULL,
  dept_id     INT REFERENCES tb_dept(dept_id),
  role        VARCHAR(20) NOT NULL DEFAULT '조회',
  use_yn      BOOLEAN NOT NULL DEFAULT TRUE,
  last_login  TIMESTAMP
);

-- ---------- 교육과정 ----------
CREATE TABLE tb_course (
  course_id     VARCHAR(30) PRIMARY KEY,
  course_nm     VARCHAR(200) NOT NULL,
  edu_type      VARCHAR(20)  NOT NULL DEFAULT '사내교육',
  institution_id INT REFERENCES tb_institution(institution_id),
  inst_nm       VARCHAR(120) DEFAULT '',
  host_dept     VARCHAR(60)  DEFAULT '',
  host_dept_sub VARCHAR(60)  DEFAULT '',
  edu_goal      TEXT DEFAULT '',
  edu_content   TEXT DEFAULT '',
  edu_days      NUMERIC(6,1),
  edu_hours     NUMERIC(7,1),
  edu_method    VARCHAR(30)  DEFAULT '',
  edu_place     VARCHAR(120) DEFAULT '',
  edu_level     SMALLINT,
  course_link   VARCHAR(300) DEFAULT '',
  fw_kb1        VARCHAR(40)  DEFAULT '',
  fw_kb2        VARCHAR(60)  DEFAULT '',
  fw_kb3        VARCHAR(80)  DEFAULT '',
  is_new        BOOLEAN NOT NULL DEFAULT FALSE,
  is_required   BOOLEAN NOT NULL DEFAULT FALSE,
  is_recommend  BOOLEAN NOT NULL DEFAULT FALSE,
  is_published  BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    VARCHAR(30),
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP
);
CREATE INDEX ix_course_pub  ON tb_course(is_published);
CREATE INDEX ix_course_type ON tb_course(edu_type);
CREATE INDEX ix_course_kb1  ON tb_course(fw_kb1);
CREATE INDEX ix_course_nm   ON tb_course(course_nm);

CREATE TABLE tb_course_tag (
  course_id VARCHAR(30) NOT NULL REFERENCES tb_course(course_id) ON DELETE CASCADE,
  tag       VARCHAR(40) NOT NULL,
  PRIMARY KEY (course_id, tag)
);

CREATE TABLE tb_course_map (
  map_id      BIGSERIAL PRIMARY KEY,
  course_id   VARCHAR(30) NOT NULL REFERENCES tb_course(course_id) ON DELETE CASCADE,
  jikgye      VARCHAR(40)  DEFAULT '',
  jikryeol    VARCHAR(60)  DEFAULT '',
  jikmu       VARCHAR(100) DEFAULT '',
  edu_level   SMALLINT,
  UNIQUE (course_id, jikgye, jikryeol, jikmu, edu_level)
);
CREATE INDEX ix_map_course ON tb_course_map(course_id);
CREATE INDEX ix_map_path   ON tb_course_map(jikgye, jikryeol, jikmu);

CREATE TABLE tb_course_comp (
  map_id    BIGINT NOT NULL REFERENCES tb_course_map(map_id) ON DELETE CASCADE,
  comp_nm   VARCHAR(200) NOT NULL,
  PRIMARY KEY (map_id, comp_nm)
);

-- ---------- 교육신청 ----------
CREATE TABLE tb_demand (
  demand_id    BIGSERIAL PRIMARY KEY,
  dept_id      INT REFERENCES tb_dept(dept_id),
  dept_nm      VARCHAR(80) NOT NULL,
  plan_year    SMALLINT NOT NULL DEFAULT 2027,
  status       VARCHAR(20) NOT NULL DEFAULT '제출',
  submitted_by VARCHAR(30),
  submitted_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX ix_demand_dept ON tb_demand(dept_id);

CREATE TABLE tb_demand_item (
  item_id    BIGSERIAL PRIMARY KEY,
  demand_id  BIGINT NOT NULL REFERENCES tb_demand(demand_id) ON DELETE CASCADE,
  course_id  VARCHAR(30) REFERENCES tb_course(course_id),
  course_nm  VARCHAR(200) NOT NULL,
  inst_nm    VARCHAR(120) DEFAULT '',
  edu_type   VARCHAR(20)  DEFAULT '',
  edu_hours  NUMERIC(7,1),
  apply_cnt  INT NOT NULL DEFAULT 1,
  period     VARCHAR(20) DEFAULT '',
  remark     VARCHAR(300) DEFAULT '',
  UNIQUE (demand_id, course_id)
);

CREATE TABLE tb_change_log (
  log_id    BIGSERIAL PRIMARY KEY,
  action    VARCHAR(60) NOT NULL,
  target    VARCHAR(200) DEFAULT '',
  entity    VARCHAR(40)  DEFAULT '',
  user_id   VARCHAR(30),
  logged_at TIMESTAMP NOT NULL DEFAULT now()
);

COMMIT;

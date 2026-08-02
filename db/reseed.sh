#!/usr/bin/env bash
# 기존 데이터를 지우고 v2 정렬본(신규 직무체계·역량)으로 다시 적재
set -e
: "${DATABASE_URL:?DATABASE_URL 환경변수를 설정하세요}"
echo "1) 기존 데이터 삭제..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "TRUNCATE tb_change_log,tb_demand_item,tb_demand,tb_course_comp,tb_course_map,tb_course_tag,tb_course,tb_competency,tb_job_taxonomy,tb_framework,tb_institution,tb_dept,tb_user RESTART IDENTITY CASCADE;"
echo "2) 정렬본 데이터 적재(수 분 소요)..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seed.sql
echo "완료. 검증:"
psql "$DATABASE_URL" -c "SELECT (SELECT count(*) FROM tb_course) AS 과정, (SELECT count(DISTINCT jikgye) FROM tb_job_taxonomy) AS 직계, (SELECT count(*) FROM tb_competency) AS 역량;"

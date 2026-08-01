#!/usr/bin/env bash
# 클라우드 DB에 스키마+데이터 최초 1회 적재
set -e
: "${DATABASE_URL:?DATABASE_URL 환경변수를 설정하세요}"
echo "1) 스키마 생성..."; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
echo "2) 데이터 적재(수 분 소요)..."; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seed.sql
echo "완료. 과정 수 확인:"; psql "$DATABASE_URL" -c "SELECT count(*) AS courses FROM tb_course;"

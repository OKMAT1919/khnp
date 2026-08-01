# 한수원 교육과정 등록·신청 플랫폼 — 백엔드 (PostgreSQL + Express)

현행 v17 화면(프론트엔드)을 그대로 두고, 데이터 저장소를 **PostgreSQL**로,
그 사이에 **Node.js(Express) API 서버**를 두는 정식 구축용 백엔드입니다.
클라우드 배포를 전제로 구성했습니다.

## 구성
```
db/schema.sql   PostgreSQL 테이블·인덱스 (13개 테이블)
db/seed.sql     현재 데이터 초기적재 (과정 2,492 · 교육기관 517 · 역량 1,283 · 직무체계 · 교육체계)
db/init.sh      스키마+데이터 최초 1회 적재 스크립트
src/server.js   Express 진입점
src/db.js       PostgreSQL 커넥션 풀 (SSL 지원 — 클라우드 관리형 DB 대응)
src/routes/     API 라우트 (courses/taxonomy/framework/competencies/institutions/demands/depts)
Dockerfile      컨테이너 이미지
render.yaml     Render.com 원클릭 배포(관리형 Postgres+웹서비스)
```

## 로컬/클라우드 공통 준비
1. `.env.example` → `.env` 복사 후 `DATABASE_URL` 입력 (클라우드 DB 연결 문자열)
2. 의존성 설치: `npm install`
3. DB 적재: `bash db/init.sh` (스키마 + 데이터)
4. 서버 실행: `npm start` → `http://localhost:8080/api/health`

## 클라우드 배포 (택1)

### A. Render.com — 가장 간단 (관리형 Postgres 포함)
1. 이 폴더를 GitHub 저장소로 push
2. Render 대시보드 → New → Blueprint → 저장소 선택 (render.yaml 자동 인식)
3. DB·웹서비스가 생성되면, Render Shell에서 `bash db/init.sh` 1회 실행
4. 발급된 URL의 `/api/health` 확인

### B. Docker (AWS/GCP/Azure/사내 쿠버네티스 등)
```
docker build -t khnp-edu-api .
docker run -e DATABASE_URL=... -e PGSSL=true -p 8080:8080 khnp-edu-api
```
DB는 관리형(AWS RDS, GCP Cloud SQL, Azure DB for PostgreSQL) 권장.
최초 1회 `psql "$DATABASE_URL" -f db/schema.sql && psql "$DATABASE_URL" -f db/seed.sql`.

## 주요 API
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | /api/courses?q=&kb1=&edu_type=&jikgye=&jikryeol=&jikmu=&limit=&offset= | 과정 목록·검색·필터 |
| GET | /api/courses/:id | 과정 상세(map/역량/태그 포함) |
| POST/PUT | /api/courses(/:id) | 과정 등록/수정 (매핑·역량·태그 트랜잭션) |
| PATCH | /api/courses/:id/publish | 게시/숨김 |
| POST | /api/courses/bulk | 엑셀 일괄 등록 |
| GET/POST/PUT/DELETE | /api/job-taxonomy | 직무체계 (수정 시 연계 과정·역량 전파) |
| GET/POST/DELETE | /api/framework | 교육체계(대·중·소분류) |
| GET/POST/DELETE | /api/competencies | 역량 |
| GET/POST/DELETE | /api/institutions | 교육기관 |
| GET/POST | /api/demands | 교육신청(2027 등록) 조회·제출 |
| GET | /api/depts | 부서 |

## 프론트엔드 연결 (다음 단계)
현재 HTML의 저장/조회 함수(브라우저 저장소 `sget/sset`)를 위 API의 `fetch` 호출로 교체하면
화면은 그대로 두고 DB 기반으로 전환됩니다. 교체 지점이 한 곳(storage 계층)에 모여 있어 최소 수정으로 가능합니다.

## 인증·권한 (운영 전 필수)
- 현재는 인증 미포함(구조 검증용). 운영 시 사내 SSO(JWT) 미들웨어를 `src/server.js`에 추가하고,
  쓰기 라우트(POST/PUT/DELETE)에 권한(관리자/교육담당/부서담당) 체크를 적용하세요.
- `tb_user.role` 기준 권한 설계는 DB 설계 명세서 6번 시트 참조.

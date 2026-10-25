# 미더라 (Midura)

결과를 바꿀 수 없고, 누구나 직접 검증할 수 있는 공정 추첨 사이트.

## 핵심 아이디어
- **봉인 후 추첨**: 참여를 마감할 때 난수(seed)를 정해 해시(commitment)만 먼저 공개하고, 추첨 뒤에 seed 를 공개합니다.
- **수정 불가**: 결과는 직전 결과의 해시를 품은 해시 체인으로 저장되고, 결과 수정/삭제 API 와 DB 훅이 없습니다.
- **직접 검증**: 결과 화면에서 브라우저(WebCrypto)가 서버 없이 결과를 다시 계산해 확인합니다.
- **연출은 재생일 뿐**: 룰렛/카드/사다리는 확정된 결과를 보여주는 애니메이션입니다.
- **구슬 레이스는 진짜 물리**: 서버가 seed 로 출발 위치를 무작위 배치한 뒤 물리 엔진(matter-js)으로 경기를 끝까지 돌리고,
  결승선에 먼저 들어온 구슬이 당첨입니다(유도 없음). 경기 기록은 해시 체인에 포함되어 저장되고 모든 참여자가 같은 기록을 재생합니다.
  브라우저는 기록의 해시·출발 위치·도착 순서를 검증하고, 서버는 같은 seed 로 경기를 처음부터 다시 돌려 기록이 똑같은지 검증합니다.
- **실시간(폴링)**: 추첨 화면을 열어두면 2.5초마다 상태를 확인해, 마감/추첨 실행이 거의 바로 모든 참여자 화면에 반영되고 연출이 자동 재생됩니다.

## 구조
```
server/   Express + MongoDB(Mongoose) 백엔드, race.js(구슬 레이스 물리 시뮬레이션)
client/   React + Vite 프론트엔드
```

## 실행
1. `server/.env.example` 을 `server/.env` 로 복사하고 값을 채웁니다.
2. 개발 (터미널 2개)
   ```bash
   cd server && npm install && npm start      # http://localhost:3000 (API)
   cd client && npm install && npm run dev    # http://localhost:5173 (화면, /api 는 3000 으로 프록시)
   ```
3. 하나로 실행: `cd client && npm run build` 후 `cd server && npm start` → http://localhost:3000

`ADMIN_EMAIL` 로 가입한 계정이 admin 이며, admin 만 추첨 만들기/마감/실행과 회원 권한 관리를 할 수 있습니다.

## Vercel 배포 (프로젝트 1개)
`vercel.json` 이 client 를 정적 사이트로 빌드하고, `api/index.js` 가 server 를 서버리스 함수로 내보냅니다. 주소가 하나라 CORS/쿠키 설정이 필요 없습니다.
1. GitHub 저장소를 Vercel 에서 Import 합니다 (Framework Preset 은 **Other**, Root Directory 는 저장소 루트 그대로).
2. Settings → Environment Variables 에 입력합니다.
   - `MONGODB_ATLAS_URL`: Atlas 접속 문자열. 운영용 DB 이름을 따로 쓰는 걸 권장합니다 (예: `.../midura`).
   - `JWT_SECRET`: 운영용으로 새로 만든 긴 랜덤 문자열
   - `ADMIN_EMAIL`: 관리자로 쓸 이메일
3. MongoDB Atlas → Network Access 에 `0.0.0.0/0` 을 허용합니다 (Vercel 의 접속 IP 가 고정이 아니라서).
4. Deploy. 배포 후 `ADMIN_EMAIL` 로 가입하면 admin 이 됩니다.

서버리스라서 요청 사이에 메모리가 공유되지 않습니다. 그래서 실시간 알림은 SSE 대신 폴링을 쓰고,
로그인 시도 제한(rate limit)은 함수 인스턴스마다 따로 세어져서 로컬보다 약합니다. 구슬 레이스 시뮬레이션은 함수 1회 호출 안에서 끝나며(보통 1초 안팎) 최대 60초로 설정했습니다.

## 한계
- 앱 코드로 결과 수정을 막을 뿐, DB 접속 권한이 있는 사람이 직접 고치는 것까지 막지는 못합니다(해시 체인 검증으로 드러납니다).
- 봉인(commitment)은 "봉인한 뒤 바꾸지 않았다"를 증명하지만, 서버가 봉인 전에 유리한 seed 를 골랐는지까지는 증명하지 못합니다.
- 물리 시뮬레이션은 브라우저마다 수학 계산이 미세하게 달라서 브라우저에서 다시 돌리지 않고, 서버 재현 검증으로 확인합니다.

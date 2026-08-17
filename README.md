# Stock Trading Discord 투자위원회

Discord 봇 5개가 각각 별도 Codex CLI 세션을 유지합니다. `!roundtable`에서는 공통 서버가 발언을 순서대로 다음 세션에 전달합니다.

TradingView 신호 명세의 기준 문서는 로컬 `docs/tradingview-webhook-v6.2.md`입니다. 제공받은 원본 자료이므로 Git에는 포함하지 않습니다.

지금까지의 단계별 구현 내용과 설계 결정은 [`docs/development-history.md`](./docs/development-history.md)에 정리되어 있습니다.

## 1. Discord 봇 만들기

Discord Developer Portal에서 애플리케이션과 봇을 5개 만듭니다.

- 드러켄밀러 관점 AI
- 오닐 관점 AI
- 미너비니 관점 AI
- 리버모어 관점 AI
- 쿨라메기 관점 AI

각 봇의 **Bot > Privileged Gateway Intents > Message Content Intent**를 켜고, 같은 서버에 초대합니다. 필요한 권한은 `View Channels`, `Send Messages`, `Read Message History`입니다.

## 2. 설정

```bash
cd stock-trading
npm install
cp .env.example .env
```

`.env`에 본인의 Discord 사용자 ID와 봇 토큰 5개를 입력합니다. 토큰은 채팅이나 Git에 올리지 마세요.

기본 Codex 설정은 `gpt-5.6-sol`과 `high` 추론 강도입니다.

```text
CODEX_MODEL=gpt-5.6-sol
CODEX_REASONING_EFFORT=high
CODEX_WEB_SEARCH=live
```

## 3. 실행

```bash
npm run start:all
```

Discord 봇, 로컬 웹훅 수신기, ngrok 고정 터널이 함께 실행됩니다. 다음 문구가 나오면 TradingView에 넣을 **전체 웹훅 URL이 클립보드에 복사된 상태**입니다.

```text
TradingView 웹훅 URL 복사 완료: https://your-domain.ngrok-free.dev/webhook/<secret>
```

터미널에는 비밀 경로를 숨겨서 표시합니다. 종료할 때는 `Ctrl+C`를 누릅니다.

## 명령어 한눈에 보기

터미널 명령어는 프로젝트 폴더에서 실행합니다.

| 명령어 | 용도 |
|---|---|
| `npm run start:all` | 봇·웹훅 수신기·ngrok 고정 터널을 한 번에 실행 |
| `npm run test:webhook-live` | 주문 없는 테스트 신호를 로컬 수신기와 Discord로 전송 |
| `npm run self-test` | 전체 코드 자체 점검 |
| `npm run kiwoom:check` | 키움 모의투자 인증·계좌 연결 확인(주문 없음) |
| `CONFIRM_MOCK_ORDER=AAPL-1-USD npm run kiwoom:smoke-order` | 영업일에 해외 모의계좌 AAPL 1주 `$1` 지정가 접수·취소 시험 |
| `npm run telegram:login` | Telegram 사용자 계정 최초 1회 로그인 |
| `npm run telegram:list` | `무니인사이트`가 포함된 허용 채널 확인 |
| `npm run telegram:collect` | 전날 채널 글을 Markdown으로 즉시 수집 |
| `npm run telegram:collect -- 2026-08-09` | 지정 날짜 글을 다시 수집 |
| `npm run setup-discord` | Discord 카테고리와 채널 자동 생성 |
| `npm start` | 봇과 로컬 웹훅 수신기만 실행 |
| `npm run start:webhook` | Discord 연동 없이 웹훅 수신기만 실행 |
| `codex login status` | Codex CLI 로그인 확인 |
| `Ctrl+C` | 실행 중인 봇과 터널 종료 |

## Discord 채널 자동 생성

드러켄밀러 봇 역할에 `채널 관리` 권한을 잠시 켠 다음 실행합니다.

```bash
set -a
source .env
set +a
npm run setup-discord
```

카테고리와 채널이 생성된 뒤에는 드러켄밀러 봇의 `채널 관리` 권한을 다시 꺼도 됩니다. 이미 존재하는 항목은 중복 생성하지 않습니다.

신호 채널은 다음 네 개만 사용합니다.

- 미국: `#미국-관찰신호`, `#미국-매매신호`
- 국내: `#국장-관찰신호`, `#국장-매매신호`

이모지나 표시 문구별 채널은 만들지 않습니다. 위험 게이트를 통과해 모의주문 또는 BUY 승인 대기로 이어지는 신호만 매매신호로, 검토·차단·보유 없음·SHADOW 신호는 관찰신호로 보냅니다. 기존 `#매매신호`는 삭제하지 않고 `#매매신호-이전기록`으로 보존합니다.

Codex CLI는 현재 저장된 ChatGPT 로그인을 재사용합니다. 먼저 `codex login status`가 `Logged in using ChatGPT`인지 확인하세요.

## 사용법

```text
오닐, 이 종목을 CAN SLIM 기준으로 분석해줘
리버모어는 지금 기다려야 한다고 봐?
드라켄 밀러와 미너비니는 이 시장을 어떻게 봐?
모두들 오늘 시장에서 중요한 소식 있어?
야, 오늘 특별한 소식 없어?
!roundtable 현재 반도체 업종의 위험과 기회를 토론해줘
!roundtable 삼성전자 최근 지표까지 포함해서 어때?
쿨라매기 !reset
```

- `@` 없이 이름만 적어도 해당 AI가 답합니다. 여러 이름을 적으면 여러 AI가 각각 답합니다.
- `모두들`, `다들`, `여러분`, `얘들아`라고 하면 다섯 AI가 모두 답합니다.
- 아무도 지칭하지 않은 일반 메시지는 다섯 AI가 돌아가며 한 명만 답합니다.
- `#시장-브리핑`과 `#매매일지`의 이름 없는 메시지는 드러켄밀러가 기본 응답합니다.
- `#관심종목`은 공유된 TradingView 워치리스트 전체를 `회사명 (티커)` 형식으로 정리합니다. 매일 08:15에 추가·삭제를 동기화하며 Discord 글자 제한을 넘으면 여러 메시지로 나눕니다. 이 목록은 자동 알림·자동매매 대상 수와 별개입니다.
- `#알람설정`은 알람 전용 TradingView 공유 워치리스트를 서비스 시작 시와 매일 08:20에 갱신합니다. 다섯 AI는 알람·알림 설정 질문에 이 목록을 공통 기준으로 사용합니다. TradingView의 비공개 알람 화면은 공식 API로 직접 조회할 수 없으므로, 실제 활성 알람 종목과 공유 워치리스트를 같은 목록으로 관리합니다.
- `#주문승인`은 평소 키움 모의서버의 주문 접수를 기록합니다. BUY 승인 시험을 켜면 승인 대기 카드가 올라오며 이 채널에서 `사줘 티커`를 입력합니다.
- `#체결로그`는 부분체결·체결·취소·거부 상태를 자동 기록합니다.
- `#매매일지`는 실제 TradingView 신호로 체결된 모의주문을 한국 시간 기준 하루 한 메시지에 누적합니다. 연결 시험 주문은 제외합니다.
- `#전략-연구`는 자동 작성하지 않는 사용자 전용 기록 공간입니다.
- 보낸 메시지를 수정하면 같은 메시지 담당 AI가 수정된 내용으로 다시 답합니다.
- 각 AI의 독립 Codex 세션 기억에 더해, 현재 Discord 채널의 최근 12개 대화를 공용 문맥으로 읽습니다.
- AI가 다른 AI를 실제로 멘션하면 최대 5회까지 서로 대화할 수 있습니다.
- `!roundtable`은 다섯 세션을 순서대로 실행합니다.
- `!roundtable 종목명/티커`는 저장된 실제 TradingView 웹훅에서 해당 종목의 마지막 Lazy Alpha 지표를 찾아 공통 자료로 전달합니다. 현재 상태를 직접 조회하는 것이 아니므로 수신 시각과 경과시간을 함께 표시하며, 기록이 없으면 공개 종목 정보만 검색해 토론합니다. TradingView 신호 메시지에 답장하여 `!roundtable 이 종목 어때?`라고 해도 종목을 찾습니다.
- `!roundtable 워치리스트 ...`는 최근 웹훅을 받은 종목별 마지막 상태를 최대 20개까지 비교합니다. 이는 TradingView 계정의 워치리스트 전체 목록이 아니라 실제 수신 기록 기준입니다.
- AI가 응답을 준비하는 동안 Discord의 `입력 중…` 표시를 주기적으로 갱신합니다.
- 평일 `08:30`, `15:40`, `22:00`에는 `#시장-브리핑`에서 드러켄밀러가 최근 사용자 자료와 별도로 웹 검색한 지수·금리·환율·수급·뉴스·향후 5거래일 주요 이벤트를 확인해 자동 브리핑합니다. 자동 브리핑은 누적 문맥으로 느려지지 않도록 매번 새 AI 세션을 사용하며, 시간초과를 피하려고 자동·수동 브리핑 모두 문서 본문만 읽습니다.
- 자동 브리핑과 `!roundtable`은 iCloud `주식` 폴더에서 최근 7일 이내 추가·수정된 PDF 중 최신 3개를 함께 참고합니다. 이미지형 PDF는 macOS 내장 OCR로 앞부분 5쪽을 읽으며 원문은 수정하지 않습니다.
- 한 번 정상적으로 다룬 파일은 처리 기록에 남아 이후 **자동 브리핑**에서는 다시 선택되지 않습니다. 사용자가 질문하거나 `!roundtable`을 직접 실행하면 이미 다룬 자료도 다시 참고할 수 있으며, 파일이 수정되면 자동 브리핑에서도 새로운 자료로 인식합니다.
- Discord에는 참고한 파일명이 먼저 표시됩니다. 문서의 시점 민감한 내용은 웹의 공식 자료로 재확인하고, 빠른 매매신호 검토에는 이 자료 읽기를 넣지 않습니다.
- 자동 브리핑 시간과 채널은 `.env`의 `AUTO_BRIEFING_*` 설정으로 바꿀 수 있습니다.
- `!reset`은 해당 봇의 Codex 세션만 새로 시작합니다.
- 다섯 봇에는 주문 실행 권한이 없습니다.

최근 자료의 기간·개수·읽을 페이지 수는 `.env`의 `RESEARCH_LOOKBACK_DAYS`, `RESEARCH_MAX_FILES`, `RESEARCH_MAX_PAGES`로 바꿀 수 있습니다. 바로 토론하려면 Discord에서 다음처럼 입력합니다.

```text
!roundtable 최근 추가된 반도체 자료를 바탕으로 핵심 주장, 반대 근거, 확인할 종목을 토론해줘
```

## 허락받은 Telegram 채널 일일 수집

운영자에게 허락받은 채널만 수집합니다. 제목에 `무니인사이트`가 들어간 채널 중 최근 활동 채널을 자동 선택하므로 `7.15~8.15`처럼 매달 방 이름이 바뀌어도 설정을 다시 바꿀 필요가 없습니다.

1. [Telegram API 개발 도구](https://my.telegram.org/apps)에서 본인 계정의 `api_id`와 `api_hash`를 발급합니다.
2. 두 값을 `.env`의 `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`에 입력합니다. 채팅이나 Discord에는 붙여넣지 않습니다.
3. 프로젝트 폴더에서 `npm run telegram:login`을 한 번 실행하고 전화번호, Telegram 앱 인증 코드, 2단계 인증 비밀번호를 입력합니다.
4. `npm run telegram:list`로 현재 허용 채널이 잡히는지 확인합니다.
5. `npm run telegram:collect`로 전날 자료 저장을 시험합니다.
6. 성공하면 `.env`의 `TELEGRAM_ENABLED=false`를 `true`로 바꾸고 `npm run start:all`을 다시 실행합니다.

활성화 후 매일 `00:10`(한국 시간)에 전날 본문·캡션·링크를 Markdown으로 저장합니다. 사진과 동영상 원본은 내려받지 않습니다.

```text
iCloud Drive/주식/텔레그램/2026-08-09_무니인사이트 7.15~8.15.md
```

새 Markdown은 기존 PDF와 같은 최근 자료로 인식되어 자동 브리핑과 수동 `!roundtable`에서 참고됩니다. 실시간 웹 검색을 완료하고 정상 본문을 반환한 자동 브리핑만 실행·자료 검토 완료로 기록합니다. 실패·시간초과·검색 불가 안내문은 완료로 처리하지 않으며, 사용자가 직접 질문하면 자료를 재검토할 수 있습니다.

`.telegram-session`은 로그인 권한이 담긴 비밀 파일이므로 공유하거나 Git에 올리지 마세요. 로그아웃 또는 세션 폐기가 필요하면 Telegram 설정의 **기기**에서 해당 세션을 종료한 뒤 이 파일을 삭제하고 다시 로그인합니다.

## 자동매매 안전 모드

기본값은 `SHADOW`이며, 동시에 보유할 수 있는 종목은 최대 5개입니다. `!trade paper`로 바꾸면 유효한 일반 TradingView 진입·부분청산·전량청산 신호를 키움 모의계좌로 보냅니다. 실계좌 주문은 계속 차단합니다.

```text
!trade         사용 가능한 명령어 표시
!trade status  현재 모드, 중지 여부, 모의 보유 종목 확인
!trade orders  최근 키움 모의주문 상태 확인
!trade size 250 240 A  진입가 250, 손절가 240, A등급 기준 모의 수량 계산(주문 없음)
!trade halt    신규 진입 즉시 중지
!trade resume  신규 진입 재개
!trade shadow  신호 판단과 모의 포지션만 기록
!trade paper   국내·미국 일반 신호 모의 자동주문 모드
!trade off     모든 진입과 청산 판단 중지
사줘 009830    #주문승인에서 대기 중인 BUY 승인
!roundtable 주제  다섯 AI 순차 토론
AI이름 !reset  해당 AI의 Codex 대화 세션 초기화
```

- 5종목 보유 중인 경우 여섯 번째 신규 진입은 차단합니다.
- 기존 종목을 전량 청산하면 빈 슬롯에 다른 종목이 진입할 수 있습니다.
- 손절가가 없거나 현재가 이상인 매수, 확신도 `D`, 중지 상태의 신규 진입은 차단합니다.
- `!trade live`는 지원하지 않습니다. 키움 모의투자 검증과 체결 추적을 완료한 뒤 별도로 추가합니다.
- 기본 모의 자동주문은 Discord 기록이나 AI 답변을 기다리지 않습니다. `BUY_APPROVAL_REQUIRED=true`로 승인 시험을 켠 경우에만 BUY를 기본 15분 대기하고, SELL은 계속 자동 처리합니다.

## 점검

```bash
npm run self-test
```

## 키움 모의투자 연결 확인

키움 REST API 사용신청과 모의투자 참가신청을 마친 뒤 `.env`의 국내·해외 App Key와 App Secret을 입력합니다. 다음 명령은 국내 모의 서버의 토큰과 계좌번호만 확인하며 주문은 전송하지 않습니다.

```bash
npm run kiwoom:check
```

## TradingView 웹훅 수신기

현재 수신기는 신호를 검증·정규화·기록하고 Discord에 알립니다. `PAPER_AUTO`에서는 안전장치를 통과한 일반 진입·부분청산·전량청산 신호가 국내·미국 모의주문으로 이어집니다. `SHADOW`에서는 주문 없이 판단과 기록만 남깁니다.

국내·미국의 `#*-관찰신호`, `#*-매매신호`에는 요약과 함께 TradingView가 보낸 원본 지표 필드를 빠짐없이 표시합니다. `CHECK` 참고 알림은 자동주문을 만들지 않습니다. `1차 분할청산`·`TP1`은 보유 가능 수량의 25%, `2차 분할청산`·`TP2`는 남은 보유 가능 수량의 50%를 모의매도하며, 같은 단계 신호는 포지션당 한 번만 실행합니다. 계산 결과가 1주 미만이면 전량 매도로 바꾸지 않고 차단합니다.

### 비밀 경로

웹훅 주소의 마지막 비밀값은 프로젝트 루트의 `.webhook-token` 파일에 있습니다. 최초 실행 때 64자리 무작위 값이 자동 생성되며 `.gitignore`에 등록되어 있습니다.

```text
https://your-domain.ngrok-free.dev/webhook/<.webhook-token의 값>
```

값을 터미널에 노출하지 않고 클립보드에 복사하려면 다음을 사용합니다.

```bash
pbcopy < .webhook-token
```

전체 URL을 화면에 표시하지 않고 바로 복사하려면 다음을 사용합니다.

```bash
printf '%s/webhook/%s' "$NGROK_PUBLIC_URL" "$(tr -d '\r\n' < .webhook-token)" | pbcopy
```

평소에는 직접 조합할 필요가 없습니다. `npm run start:all`이 공개 주소와 비밀 경로를 합친 전체 URL을 자동으로 클립보드에 복사합니다. 이 URL은 비밀번호처럼 취급하고 채팅, 화면 캡처, Git에 올리지 마세요.

### 왜 수신 주소가 로컬인가

봇 화면의 `127.0.0.1`은 정상입니다. 외부에 수신기를 직접 공개하지 않고 ngrok이 TradingView 요청을 이 Mac으로 전달합니다.

```text
TradingView → NGROK_PUBLIC_URL → 127.0.0.1:8787 → Discord 봇
```

ngrok 무료 계정에 배정된 개발 주소는 재실행해도 유지됩니다. TradingView 알림의 웹훅 URL은 최초 한 번만 고정 주소로 저장합니다.

### TradingView 알림 설정

- 지표: `Lazy Alpha Indicator: JSON 전용`
- 조건: `어떤 alert() 함수 호출`
- 인터벌: 차트와 같게(현재 4시간봉)
- 웹훅 URL: `npm run start:all`이 복사한 전체 URL 붙여넣기
- 메시지: 지표가 만든 JSON을 그대로 사용하고 임의로 수정하지 않기

알림 생성 자체는 테스트 신호를 보내지 않습니다. 실제 지표 조건이 발생할 때 전송됩니다.

### 안전한 연결 테스트

```bash
npm run test:webhook-live
```

이 테스트는 TradingView를 거치지 않고 로컬 수신기와 Discord 연결만 확인합니다. `INFO_ONLY`, `주문 생성 없음`으로 처리되는 것이 정상입니다.

고정 공개 주소까지 확인하려면 다음처럼 실행합니다.

```bash
WEBHOOK_ORIGIN="$NGROK_PUBLIC_URL" npm run test:webhook-live
```

### TradingView 실제 알람→국내 모의계좌 1주 테스트

[`docs/tradingview-mock-order-test.pine`](./docs/tradingview-mock-order-test.pine)은 `005930` 차트에서만 실행되며 봉당 한 번 테스트 신호를 보냅니다. 실제 주문은 서버의 잠금 파일이 시장가 매수 1주·1회로 제한합니다. 평소에는 반드시 아래 설정을 `false`로 둡니다.

```text
PAPER_ORDER_TEST_ENABLED=false
PAPER_ORDER_TEST_SYMBOL=005930
```

실제 시험 직전에만 `true`로 바꾸고 재시작한 뒤 Discord에서 `!trade paper`를 입력합니다. TradingView 알림 조건은 `Kiwoom Mock Order One-shot Test` → `어떤 alert() 함수 호출`이며 웹훅 URL은 `npm run start:all`이 복사한 값 중 `/health`가 응답하는 현재 터널 주소를 사용합니다. 한 번 주문을 시도하면 `.paper-order-test-lock.json`이 남아 같은 설정으로는 다시 주문할 수 없습니다. 시험 후 TradingView 테스트 알림을 삭제하고 설정을 다시 `false`로 돌린 뒤 재시작합니다.

2026-08-10 실제 장중 시험에서 TradingView 알림 → Cloudflare → 로컬 수신기 → 키움 국내 모의계좌 `005930` 1주 시장가 매수·체결을 확인했습니다. 시험 알림은 삭제했고 테스트 게이트는 다시 `false`로 내렸습니다.

### 현재 안전 설정

- 키움 환경: 모의투자만 허용
- 기본 자동매매 모드: `SHADOW`; Discord에서 `!trade paper`를 입력한 동안만 일반 신호 모의주문
- 동시 보유 한도: 5종목
- 한 종목 투자금 한도: 계좌 평가액의 20%
- 기본 거래당 위험: 계좌 평가액의 0.5%(확신 등급에 따라 조정)
- 국내·미국 BUY 신호: 키움 모의계좌 기준 수량·투자금·예상 손실 계산 후 모의주문
- 4시간봉 BUY 신호: `daily_trend=BULL`, 일봉 EMA 정배열, 일봉 200일선 위일 때만 주문 허용
- 일봉 혼조 또는 EMA 미정렬이지만 200일선 위: `주문승인`에서 `사줘 티커` 승인 시 기본 위험 절반·한 종목 최대 10%로 모의진입
- 일봉 약세 또는 200일선 아래: BUY 차단
- 기존 보유 종목 추가 진입: 기존 평가금액과 신규 주문금액 합계가 계좌 평가액의 20% 이내일 때만 허용
- 국내 진입·전량 청산: 시장가, 미국 진입·전량 청산: 신호 가격 지정가
- 최종 청산·돌파 청산·모멘텀 SELL·PEG Invalid·진입 만료: 보유 가능 수량 전량 모의매도
- `1차 분할청산`·`TP1`: 보유 가능 수량의 25% 모의매도
- `2차 분할청산`·`TP2`: 남은 보유 가능 수량의 50% 모의매도
- 같은 부분청산 단계 중복 신호: 포지션당 한 번만 실행, 1주 미만 계산 시 차단
- `부분 익절고려`·`상승 모멘텀 종료`: 고정 비율 신호가 아니므로 계속 검토만 기록
- TradingView 감시 가능 종목: 최대 20개
- 실계좌 주문: 항상 차단
- `종목-토론`: 체결 후 토론이 아니라 셋업·VCP·PEG Start 등 진입 전 CHECK 신호만 자동 토론
- AI 토론: 주문 승인 조건이 아니며 모의주문과 독립적으로 실행
- 처리 기록: `webhook-events.jsonl`, `trading-decisions.jsonl`

아직 연결하지 않은 항목은 `피라미딩 자동 수량`, `수익 상태별 가변 청산 비율`, `실계좌 주문`입니다.

### 실계좌 전환 예정 정책

실계좌 연결은 아직 구현·활성화하지 않습니다. 모의계좌에서 충분한 기간 동안 주문·체결·재시작 복구·손실 제한을 검증한 뒤 별도 전환합니다. 전환할 때 신규 `BUY`와 추가매수는 `#주문승인`에서 사용자가 `사줘 티커`라고 승인한 경우에만 주문하고, 손절·최종청산·이미 설정된 부분청산 같은 보유 위험을 줄이는 `SELL`은 자동 실행하는 정책을 사용합니다. BUY 승인 대기 중에는 `#종목-토론`에 지표와 투자 철학별 검토를 올리지만 AI 토론 완료를 승인 조건으로 삼지는 않습니다. `부분 익절고려`와 `상승 모멘텀 종료`는 명확한 수량이 없으므로 실계좌에서도 자동주문하지 않습니다.

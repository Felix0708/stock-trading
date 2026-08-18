# TradingView Webhook 기준 문서

자동매매 신호의 기준 명세는 로컬 `tradingview-webhook-v6.2.md`입니다. 제공받은 원본 자료이므로 Git에는 포함하지 않습니다.

## 문서 지도

| 문서 | 역할 |
|---|---|
| [`../README.md`](../README.md) | 설치, 실행, 명령어를 설명하는 사용 설명서 |
| `tradingview-webhook-v6.2.md` | 로컬에서만 보관하는 TradingView 원본 신호 명세 |
| [`shared-trading-context.md`](./shared-trading-context.md) | 다섯 AI가 모든 대화에서 함께 사용하는 핵심 신호·위험·사용자 원칙 요약 |
| [`development-history.md`](./development-history.md) | 구현 과정, 설계 이유, 현재 상태와 다음 작업 기록 |
| [`tradingview-webhook-test.pine`](./tradingview-webhook-test.pine) | TradingView 서버의 실제 웹훅 경로를 확인하는 일회성 테스트 지표 |
| [`tradingview-mock-order-test.pine`](./tradingview-mock-order-test.pine) | `005930` 실제 알람으로 키움 국내 모의주문 1주·1회를 확인하는 테스트 지표 |

- 문서 버전: v6.2
- 문서 날짜: 2026-05-17
- SHA-256: `0d113ada04cafd342c9c84c2b4252f74f627ad2a49cde3024e670d172468b625`
- 원본: 사용자가 제공한 iCloud 문서의 변경 없는 사본

원본 명세는 직접 수정하지 않습니다. 새 버전이 제공되면 별도 파일로 추가하고 검증기와 마이그레이션 기록을 함께 갱신합니다.

## 확인된 명세 차이

문서에는 총 38필드라고 적혀 있지만 첫 번째 전체 JSON 예시는 실제로 39필드입니다. 구현은 필드를 임의로 버리지 않고 39필드를 수신하되, 주문 실행 전 명세 버전과 필수 필드를 별도로 검증합니다.

`type`, `market`, `ai_summary`의 이모지는 표시용으로 보존합니다. 주문 판단에는 이후 정의할 안정적인 내부 `signal_code`를 사용합니다.

## TradingView 실제 알람 경로 테스트

이 테스트는 Lazy Alpha의 매매 조건을 흉내 내지 않습니다. TradingView 서버가 실제로 다음 경로를 통과하는지만 확인합니다.

```text
TradingView → ngrok 고정 주소 → 로컬 수신기 → Discord
```

1. 프로젝트에서 `npm run start:all`을 실행하고 전체 웹훅 URL이 복사될 때까지 기다립니다.
2. TradingView에서 24시간 움직이는 `BINANCE:BTCUSDT`의 1분 차트를 엽니다.
3. Pine 에디터에 [`tradingview-webhook-test.pine`](./tradingview-webhook-test.pine)의 전체 내용을 붙여넣고 차트에 추가합니다.
4. 알림을 만들고 조건을 `Stock Trading Webhook One-shot Test` → `어떤 alert() 함수 호출`로 선택합니다.
5. 웹훅 URL을 켜고 복사된 전체 URL을 붙여넣은 뒤 알림을 생성합니다.
6. 다음 실시간 가격 업데이트에서 한 번만 발송됩니다.
7. Discord의 해당 시장 `#*-관찰신호`에서 `TVTEST`, `CHECK`, `INFO_ONLY`, `주문 생성 안 됨`을 확인합니다.
8. TradingView 알림 로그의 `Webhook status`도 성공인지 확인한 뒤 테스트 알림과 지표를 삭제합니다.

알림은 과거 봉이나 리플레이가 아니라 실시간 봉에서만 발생합니다. 응답이 없으면 `npm run start:all`이 계속 실행 중인지, 고정 ngrok URL이 저장됐는지, TradingView 2단계 인증과 알림 로그의 Webhook 상태를 확인합니다.

주문까지 확인할 때는 별도 [`tradingview-mock-order-test.pine`](./tradingview-mock-order-test.pine)을 사용합니다. 이 지표는 일반 경로 테스트와 달리 모의주문을 만들 수 있으므로 루트 README의 1주·1회 절차와 활성화 확인을 먼저 따라야 합니다.

## 문서 갱신 규칙

- 실행법이나 명령어가 바뀌면 루트 `README.md` 갱신
- TradingView 명세가 바뀌면 원본을 새 버전 파일로 추가하고 이 문서의 버전·해시 갱신
- 기능, 안전장치, 결정 또는 다음 작업이 바뀌면 `development-history.md` 갱신
- 비밀키, 토큰, 계좌번호와 실제 웹훅 비밀 경로는 어떤 문서에도 기록하지 않음

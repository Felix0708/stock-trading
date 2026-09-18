# Account equity sync v1

Read-only account observations; never an order input. Existing holdings sync is unchanged.

`PUT /api/sync/account-equity` uses the existing member integration bearer token.
`GET /api/account-equity` uses the logged-in member session. Ownership is server-derived.

Request: `{version: 1, series: [...]}`. Response: `{ok: true, synced: number}`.
Each series contains:

- `account_ref`: locally persisted random UUID, never an account number or credential hash.
- Optional `account_group_ref`: random UUID for the explicitly configured linked-account
  group. It does not assert that domestic and overseas credentials identify one physical
  account. Broker/environment and both configured Kiwoom identities isolate the group.
- `broker`: `KIWOOM` or `KIS`; `account_type`: `paper` or `live`.
- `currency`: `KRW` or `USD`; `scope`: `domestic`, `overseas` or `account-total-assets`.
- `date_timezone`: `Asia/Seoul` (last observation per local calendar day, not exchange close).
- `return_method`: `daily-sampled-linked-modified-dietz` or null.
- `return_base_at`: original observation timestamp or null.
- `points`: each has `date`, `valued_at`, `collected_at`, `calculated_at`, `equity`,
  `cash`, `stock_value`, `return_index`, `return_status`, `source`.

Dates are YYYY-MM-DD matching collected_at in Asia/Seoul. Timestamps are ISO UTC.
valued_at is null unless the broker supplies an actual valuation timestamp.
Resending never changes collected_at. calculated_at identifies a fresh calculation.
Monetary values and return_index are decimal strings (16 integer / 8 fractional digits,
no exponent) or null. Equity, stocks and return_index are nonnegative; cash can be negative.
Never replace an unknown value with zero or derive missing cash from unrelated totals.

return_status: `verified`, `insufficient_samples`, `cash_flows_unverified`,
`scope_unverified`, `invalid_data`. Only verified has a nonnull return_index (1 at the
base observation) and requires return_method/base. A single sample is not a 0% return.
Only these source/scope/currency combinations are sent: KIWOOM domestic KRW
(`KIWOOM_KR_EQUITY`), KIWOOM overseas USD (`KIWOOM_US_EQUITY`), KIWOOM verified linked
account total KRW (`KIWOOM_ACCOUNT_EQUITY`), KIS whole-account KRW (`KIS_ACCOUNT_EQUITY`).
Existing market histories are never spliced into the new linked-account total curve.

## Common presentation and optional breakdown

Both brokers use **total assets including cash**, then **domestic stock valuation,
US stock valuation, and common cash**. Cash is not arbitrarily assigned to a market.
Market valuation curves are not investment-return curves. Old standalone market asset
histories (including cash) retain their original definitions and are separate records.

An independently reconciled total point can include `breakdown`:
`status: verified`, `domestic_stock_value_krw`, `us_stock_value_usd`,
`us_stock_value_krw`, `cash_krw`, `usd_krw_rate`, `fx_source`, `observed_at`,
`source`, `cash_scope`. Monetary/rate fields are decimal strings; cash may be negative.
Domestic stocks + converted US stocks + cash must match total within KRW 2;
USD stocks times the rate must match converted US stocks within KRW 2. Nonnull point
cash/stock components must also reconcile. The rate observation is at most 120 seconds
before collected_at. This is an observed broker FX rate, not an asserted quote timestamp.

- KIWOOM: `KIWOOM_LINKED_V1`, `KIWOOM_USD_SELL`,
  `cash_scope: same-account | separate-accounts`. Collect domestic/US observations in
  the same run. Compare the two official `ka00001` account identifiers in memory;
  never store or transmit account numbers. For the same account compare D0 KRW cash
  and count domestic D2 KRW cash once. Distinct mock-market accounts add the overseas
  account's separately held KRW cash. Distinct live accounts are not aggregated until
  their complete asset coverage can be proven. Other currencies, unavailable FX,
  loans/receivables/KRW substitution, incomplete pages or unreconciled domestic assets
  block the aggregate. `ust21120` is only a currency-coverage check, never a D0 asset
  fallback. Preserve partial market histories and record the diagnostic locally in
  `equityTotalFailures`; do not emit repeated market-closure alerts.
- KIS: `KIS_RECONCILED_V1`, `KIS_USD_FIRST`, `cash_scope: account`.
  Keep the existing reported KRW total. Independently check complete domestic stock
  rows against `scts_evlu_amt`, deduplicate the complete USD US-exchange position
  responses, convert with the reported USD rate, and reconcile with the total and
  common cash. Any other-market assets or inconsistent observations prevent the
  breakdown; they are never silently relabeled as US assets.

Missing breakdown is **unconfirmed**, not zero. Missing total is **not collected**;
never synthesize it in the receiving website. New totals start a new UUID/history;
old identity-less observations are not retrospectively assigned to a linked group.
The v1 extension is additive; old clients and observations remain supported.

Verification: synthetic tests cover shared/separate cash, identity isolation, stale
inputs, other-currency rejection and preservation of valid totals when details fail.
A read-only KIS mock check on 2026-09-12 confirmed a reported total but inconsistent
US position valuation versus the total's stock component; breakdown was correctly
omitted. Its present-balance detail rows also returned zero quantities/values despite
the separate position ledger containing holdings. No inferred FX or residual cash
was used. Kiwoom's new total remains pending a successful complete broker observation.

The server upserts only supplied observations; omitted/empty history never deletes.
Identity is member + account_ref + broker + environment + currency + scope + date.
Newer collected_at wins; on a tie newer calculated_at wins. Exact time ties with
different contents return 409. Server received_at is separate. Per-observation return
method/base prevents joining curves with different bases. Gaps are not interpolated.
Maximum request: 1 MiB, 20 series, 500 points total. Client batches at 500 points.
The equity sender waits up to 25 seconds, allowing the receiver's 15-second upstream
deadline plus response/network overhead. This does not change broker order timeouts.
Holdings sync waits up to 40 seconds because its receiver first resolves the member and
then stores the snapshot (two sequential upstream calls, each limited to 15 seconds).

Producer identities are private: KIS account/product identity, Kiwoom account-linked
app-key fingerprint. KIWOOM domestic identity uses its domestic client and a separate
local namespace, even if credentials happen to match. Key rotation deliberately starts a new series unless
account continuity is independently verified. Fingerprints never leave this computer.
Legacy observations without a verified identity are not assigned to the current account.

Collection runs hourly and reuses the executor's portfolio refresh, limited to once per hour per
account, plus existing daily evidence collection. Failed collection preserves prior
observations; failed equity sync does not block holdings sync or broker order processing.
Confirmed sync batches are fingerprinted in the private receipt state. Unchanged content
(ignoring only calculated_at) is not resent, including after restart. Changed observations,
return calculations, destination URL or member token require a new acknowledgement.
Partial failure preserves successful batch acknowledgements and still attempts later independent
batches; pending batches retry on the next hourly sync. A local checkpoint write failure stops
the run. Partial success never announces whole-sync recovery. Sync incidents persist across restart, notify once and announce recovery
only when the desired data is acknowledged. Logs contain status, duration and a validated
request ID, never the token, request body or monetary values.
Both hourly and daily-evidence equity reads pause outside the checked-in market calendar's
sessions, retaining a one-hour post-session window for the final hourly sample. Mock US
accounts use regular hours; live US valuation includes pre/after-market. Both KIWOOM and
KIS also follow Korean sessions. This is a valuation schedule, not order eligibility.
New York time handles Korean Saturday mornings and DST; holidays and early closes use the
existing exchange calendar. No zero/stale sample is created while paused. Fill reconciliation,
unknown-order recovery, and holdings checks are not disabled by this equity-only gate.
No automated reconstruction of historical cash-flow coverage is performed.
Cash-flow coverage must include all external movements (or explicit evidence of no
movements) for the account and period. More asset samples alone cannot verify it.

### Collection diagnostics

`PUT /api/sync/account-status` separately sends `{version:1,statuses:[...]}` using the
same bearer token. Each status has only `account_ref`, `broker`, `account_type`,
`checked_at` and `code`; at most 20. Codes: `total_verified`, `other_currency_assets`,
`total_unverified`, `collection_failed`, `ip_not_registered`. Never send account numbers, credential
fingerprints, balances or raw broker error messages. Original observation/attempt
timestamps are preserved; stale updates cannot replace newer status. A diagnostic
failure does not prevent financial history sync. The website distinguishes manual
holdings without total-asset integration from partial observations and failed totals.
Diagnostic delivery runs alongside financial delivery; even a failed diagnostic incident
notification cannot abort financial delivery. Equal-time contradictory local evidence
prefers the non-verified state. The receiver rejects conflicting equal-time codes with
409 (and duplicate account entries with 400), retaining the last accepted state atomically.
The website labels a verified diagnostic as received only after a matching account total
with the same or newer observation time has arrived; a newer total supersedes older failure text.
The executor must load this version for automatic diagnostic delivery; pushing Git
alone does not restart the locally running trading process.

Domestic/overseas KIWOOM reads are isolated: failure in one preserves its history without
discarding fresh observations from the other. Repeated equity outages are persisted per
broker/environment and notified once until a successful complete collection confirms recovery;
closed-market skips are not recovery. Order/safety alerts keep their existing policy.

## Verified collection definitions

- KIWOOM domestic: `kt00018.prsm_dpst_aset_amt` is broker-reported KRW estimated
  deposit assets; `tot_evlt_amt` is the stock valuation. Missing totals, unfinished
  pagination, or missing/nonzero loan fields block collection. Cash is
  `kt00001` estimated query (`qry_tp=3`) `d2_entra` (D+2 projected deposit), shown
  only if it reconciles with stocks and total within KRW 2. Otherwise cash stays null;
  D0 cash, buying power and unexplained residuals are never substituted.
  This is not immediately withdrawable cash. The mapping is validated against the
  [official pinned API specification](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/234560d213acd8871ae344b5481aecd2f30287fa/kiwoom/_data/kiwoom_api_spec.json)
  and synthetic tests; a first successful broker observation is still required for
  deployment-specific amount verification. Domestic history starts at that observation.
- KIWOOM mock rejects historical `ust21132` with RC9000. Current `ust21120` works,
  but its USD cash equals D0 cash, before unsettled trades. The producer therefore
  uses `ust21160.d4_usd_fx_entr` plus `ust21070.tot_evlt_amt` in USD. This is
  **settlement-projected US assets**, not immediately withdrawable cash. Missing
  D4 cash, wrong currency, or an incomplete balance response blocks the sample;
  never fall back to D0, buying power or zero. Other currency wallets are excluded.
  [Official cash fields](https://openapi.kiwoom.com/m/guide/apiguide/32/ust21160),
  [position ledger](https://openapi.kiwoom.com/m/guide/apiguide/32/ust21070).
- KIS uses the broker-reported `tot_asst_amt` in KRW. Decomposition uses total
  deposits plus foreign-currency cash valuation, and the stock valuation total,
  only when these reconcile within KRW 2 and CMA is zero. Unknown or inconsistent
  components remain null without discarding a valid total. Loans are unsupported.
  [Official response labels](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/overseas_stock/inquire_present_balance/chk_inquire_present_balance.py).
- Cash-flow statements must explicitly carry the current `cashFlowCoverage.accountRef`;
  legacy statements cannot prove which account a deposit belongs to.
# ISA 전용 자동 수집

`.env.account`의 `ISA_BROKER`에 `KIS` 또는 `KIWOOM` 한 곳만 지정합니다. ISA 앱 등록을 완료한 전용 키를 사용하며 일반계좌 키·계좌번호를 ISA 슬롯에 복사하지 않습니다.

- 한투: `KIS_ISA_APP_KEY`, `KIS_ISA_APP_SECRET`, `KIS_ISA_ACCOUNT_NO` (8자리-2자리).
- 키움: `KIWOOM_ISA_APP_KEY`, `KIWOOM_ISA_SECRET_KEY`. 키움 API 등록 계좌가 ISA여야 하며 등록 IP에서 조회합니다.
- `start-asset-reader.sh`를 재시작하면 일반·모의계좌와 별도로 ISA를 수집합니다. 실행 중인 컴퓨터에서 기존 시간별 수집 일정을 따릅니다. 주문 실행기·실주문 허용값은 변경하지 않습니다.
- ISA는 국내 잔고 API만 허용합니다. 총자산, D+2 예수금, 보유종목 평가액 합계를 검증하며 일부 페이지·누락 금액·불일치는 전체 잔고로 전송하지 않습니다.
- 전송되는 `account_kind: "isa"`와 `isa_holdings`에는 계좌번호·키가 포함되지 않습니다. Stock-Briefing 실계좌 화면의 ISA 카드에서 잔고와 종목을 표시하며, 모의 화면·일반 해외주식 세금에는 넣지 않습니다.
- 직접 등록한 종목은 삭제·변경하지 않습니다. ISA 카드 안 종목은 위 총자산의 구성내역이며 등록 보유종목을 총자산에 다시 더하지 않습니다.

## 실계좌 보유종목과 매수 주체

읽기 전용 수집기는 일반 실계좌의 국내·미국 잔고와 ISA 국내 잔고를 `PUT /api/sync/broker-holdings`로 전송합니다. 모의 잔고·자동매매 성과를 교체하는 기존 경로와 분리되어 있습니다. 각 계좌·시장 조회가 완전하게 성공했을 때만 전송하며, 성공한 빈 잔고는 반영하고 실패한 잔고는 지우지 않습니다.

일반 실계좌는 기존 주문 기록의 live 체결 보유량을 재사용해 `automated_quantity`를 보냅니다. 나머지는 직접투자 보유분입니다. 이력 누락·미확정 주문·실제 잔고보다 큰 자동 보유량은 `null`(확인 필요)로 표시합니다. ISA 수집기는 주문하지 않으므로 ISA는 직접투자입니다. 평단가는 증권사의 전체 종목 평단가이며 매수 주체별 취득원가를 임의 추정하지 않습니다.

웹은 같은 계좌·시장의 수기/기존 자동 행 대신 조회 잔고를 표시하되 원본 수기 장부는 보존합니다. 최초 적용 때는 기존 수집기를 안전하게 재시작하면서 `sh start-asset-reader.sh --force`로 즉시 조회할 수 있습니다. 중복 실행 방지 잠금을 유지하며 주문 실행기는 재시작할 필요가 없습니다. IP 미등록(8050)은 구체적인 상태로 표시하고 다음 수집에 재시도합니다.

### Stock-Briefing 인계·업데이트 체크리스트

1. 수신 프로젝트에 `20260918052709_isa_account_equity.sql`, `20260918055337_live_holdings_ownership.sql` 순서로 적용하고 웹을 배포합니다. 이미 적용된 마이그레이션은 재실행하지 않습니다.
2. 송신 변경 `93f279f` 이후 코드를 사용하고 읽기 전용 수집기만 재시작합니다. 실행 중인 잠금이 있으면 새 실행은 즉시 종료하므로 `--force`는 기존 프로세스를 갱신하거나 잠금을 우회하지 않습니다. 종료 후 새 수집기가 실행됐는지 확인합니다.
3. `KIWOOM_ORDER_STATE_FILE`·`KIS_ORDER_STATE_FILE`은 해당 실행기의 기존 주문 기록을 가리켜야 합니다. 기본값은 `kiwoom-orders.json`·`kis-orders.json`이며 수집기는 읽기만 합니다. 매수 주체를 맞추려고 기록을 지우거나 빈 장부를 만들지 않습니다.
4. 계좌별 최신 수집 시각, 종목·수량, ISA 분리, 직접/자동 수량과 중복 합산 여부를 확인합니다. 웹의 시세·자산 이력 새로고침은 증권사 잔고 수집을 실행하지 않습니다.
5. 잔고 조회를 위해 실주문 잠금을 풀거나 실행기의 모의/실계좌 선택을 바꾸지 않습니다. 컴퓨터·수집기가 실행 중이고 수집 가능 시간대여야 정기 갱신됩니다.

통화별 JPY 자산 집계와 일본 개별 종목 자동 조회는 별개입니다. 이 보유종목 전송 경로는 KR/US만 지원하며 일본 종목·과거 외부 매매·세금용 취득원가를 잔고에서 만들어내지 않습니다. 최신 잔고 조회가 과거 거래 이력 수집 완료를 뜻하지도 않습니다. 키움 ISA는 설정·코드 경로를 지원하지만 운영 계좌별 실제 연결 검증은 별도로 필요합니다.

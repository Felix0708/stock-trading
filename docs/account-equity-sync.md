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
Partial failure preserves successful batch acknowledgements; pending batches retry on the
next hourly sync. Sync incidents persist across restart, notify once and announce recovery
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

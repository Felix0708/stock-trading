# Account equity sync v1

Read-only account observations; never an order input. Existing holdings sync is unchanged.

`PUT /api/sync/account-equity` uses the existing member integration bearer token.
`GET /api/account-equity` uses the logged-in member session. Ownership is server-derived.

Request: `{version: 1, series: [...]}`. Response: `{ok: true, synced: number}`.
Each series contains:

- `account_ref`: locally persisted random UUID, never an account number or credential hash.
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
(`KIWOOM_KR_EQUITY`), KIWOOM overseas USD (`KIWOOM_US_EQUITY`), KIS whole-account KRW
(`KIS_ACCOUNT_EQUITY`). They are never summed or spliced into one curve.

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

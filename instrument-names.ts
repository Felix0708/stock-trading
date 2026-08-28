"use strict";

type InstrumentName = { ticker?: string; name?: string; koreanName?: string; englishName?: string; exchange?: string; code?: string; [key: string]: any };

const instrumentNameCache = new Map<string, Partial<InstrumentName>>();
const KNOWN_13F_INSTRUMENTS: Record<string, InstrumentName> = {
  "02079K107": { ticker: "GOOG", koreanName: "알파벳 클래스 C", englishName: "Alphabet Class C" },
  "02079K305": { ticker: "GOOGL", koreanName: "알파벳", englishName: "Alphabet Class A" },
  "02079K602": { koreanName: "알파벳 클래스 B 예탁주", englishName: "Alphabet Depositary Shares Class B" },
  "023135106": { ticker: "AMZN", koreanName: "아마존", englishName: "Amazon" },
  "037833100": { ticker: "AAPL", koreanName: "애플", englishName: "Apple" },
  "11135F101": { ticker: "AVGO", koreanName: "브로드컴", englishName: "Broadcom" },
  "30303M102": { ticker: "META", koreanName: "메타 플랫폼스", englishName: "Meta Platforms" },
  "458140100": { ticker: "INTC", koreanName: "인텔", englishName: "Intel" },
  "46090E103": { ticker: "QQQ", koreanName: "인베스코 QQQ", englishName: "Invesco QQQ" },
  "464287572": { ticker: "IOO", koreanName: "아이셰어즈 글로벌 100 ETF", englishName: "iShares Global 100 ETF" },
  "594918104": { ticker: "MSFT", koreanName: "마이크로소프트", englishName: "Microsoft" },
  "67066G104": { ticker: "NVDA", koreanName: "엔비디아", englishName: "NVIDIA" },
  "78462F103": { ticker: "SPY", koreanName: "SPDR S&P 500 ETF", englishName: "SPDR S&P 500 ETF Trust" },
  "81141R100": { ticker: "SE", koreanName: "씨", englishName: "Sea Limited" },
  "91307C102": { ticker: "UTHR", koreanName: "유나이티드 테라퓨틱스", englishName: "United Therapeutics" },
};
const knownByTicker = new Map<string, InstrumentName>(Object.values(KNOWN_13F_INSTRUMENTS)
  .filter((item) => item.ticker)
  .map((item) => [item.ticker, item]));

function exchangeCode(value) {
  const exchange = String(value || "").toUpperCase();
  if (["KRX", "KOSPI", "KOSDAQ"].includes(exchange)) return "KRX";
  if (["NASDAQ", "NASD", "ND"].includes(exchange)) return "NASDAQ";
  if (["NYSE", "NY"].includes(exchange)) return "NYSE";
  if (["AMEX", "ARCA", "NYSEARCA", "NA"].includes(exchange)) return "AMEX";
  return exchange;
}

function instrumentKey(item: InstrumentName) {
  return `${exchangeCode(item.exchange)}:${item.ticker}`;
}

function formatInstrumentLabel({ ticker, name, koreanName, englishName }: InstrumentName = {}) {
  const fallback = String(name || "").trim();
  const symbol = String(ticker || "").trim().toUpperCase();
  const known = knownByTicker.get(symbol) || {};
  const korean = String(known.koreanName || koreanName || (/[가-힣]/.test(fallback) ? fallback : "")).trim();
  const english = String(known.englishName || englishName || (!/[가-힣]/.test(fallback) ? fallback : "")).trim();
  const names = [...new Set([korean, english].filter(Boolean))];
  return `${names.join(" / ")}${names.length && symbol ? " " : ""}${symbol ? `(${symbol})` : ""}` || "종목명 미확인";
}

async function enrichInstrumentNames(items: InstrumentName[], { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}) {
  const rows = items.map((item) => {
    const name = String(item.name || "").trim();
    const exchange = String(item.exchange || "").toUpperCase();
    const ticker = String(item.ticker || item.code || "").replace(/^A(?=\d{6}$)/, "").toUpperCase();
    const known = exchangeCode(exchange) === "KRX" ? {} : knownByTicker.get(ticker) || {};
    return {
      ...item,
      exchange,
      ticker,
      koreanName: String(known.koreanName || item.koreanName || (/[가-힣]/.test(name) ? name : "")).trim(),
      englishName: String(known.englishName || item.englishName || (name && !/[가-힣]/.test(name) ? name : "")).trim(),
    };
  });
  const missing: InstrumentName[] = [...new Map<string, InstrumentName>(rows
    .filter((item) => item.ticker && (!item.koreanName || !item.englishName))
    .map((item) => [instrumentKey(item), item])).values()]
    .filter((item) => {
      const cached = instrumentNameCache.get(instrumentKey(item)) || {};
      return (!item.koreanName && !cached.koreanName) || (!item.englishName && !cached.englishName);
    });

  if (missing.length) {
    try {
      const symbols = missing.map(instrumentKey);
      const response = await fetchImpl("https://scanner.tradingview.com/global/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbols: { tickers: symbols, query: { types: [] } }, columns: ["description"] }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        for (const item of ((await response.json()) as any).data || []) {
          instrumentNameCache.set(item.s, { englishName: String(item.d?.[0] || "").trim() });
        }
      }
    } catch { /* 이름 보완 실패는 목록·주문 기록을 막지 않는다. */ }

    for (let index = 0; index < missing.length; index += 8) {
      await Promise.all(missing.slice(index, index + 8).map(async (item) => {
        const key = instrumentKey(item);
        const market = exchangeCode(item.exchange);
        const suffix = market === "NASDAQ" ? ".O" : market === "NYSE" ? ".K" : market === "AMEX" ? ".A" : "";
        const url = market === "KRX"
          ? `https://m.stock.naver.com/api/stock/${item.ticker}/basic`
          : `https://api.stock.naver.com/stock/${item.ticker}${suffix}/basic`;
        try {
          const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
          if (!response.ok) return;
          const data: any = await response.json();
          instrumentNameCache.set(key, {
            ...instrumentNameCache.get(key),
            koreanName: String(data.stockName || "").trim(),
            englishName: String(data.stockNameEng || instrumentNameCache.get(key)?.englishName || "").trim(),
          });
        } catch { /* 다음 갱신에서 다시 시도한다. */ }
      }));
    }
  }

  return rows.map((item) => ({ ...item, ...instrumentNameCache.get(instrumentKey(item)) }));
}

module.exports = { enrichInstrumentNames, formatInstrumentLabel, KNOWN_13F_INSTRUMENTS };

"use strict";

const SIGNAL_CHANNELS = ["오늘의시그널", "sepa분석", "4h리포트", "관찰", "진입", "추매", "관리", "청산", "모멘텀", "peg"];
const SIGNAL_MARKETS = [
  { id: "US", label: "미국", prefix: "미국", category: "🇺🇸 미국주식", currency: "$", zone: "America/New_York", transport: "미국-매매신호", legacy: "미국",
    exchanges: ["NASDAQ", "NYSE", "AMEX", "NYSEARCA", "ARCA", "ND", "NY", "NA", "BATS"] },
  { id: "KR", label: "국내", prefix: "국장", category: "🇰🇷 국내주식", currency: "원", zone: "Asia/Seoul", transport: "국장-매매신호", legacy: "국장",
    exchanges: ["KRX", "KOSPI", "KOSDAQ"] },
  { id: "JP", label: "일본", prefix: "일본", category: "🇯🇵 일본주식", currency: "엔", zone: "Asia/Tokyo", transport: null, legacy: null,
    exchanges: ["TSE", "TSEJP", "JPX"] },
];

function signalMarket(record) {
  return SIGNAL_MARKETS.find(m => m.exchanges.includes(String(record?.payload?.exchange || "").toUpperCase()));
}

const marketChannelName = (market, name) => `${market.prefix}-${name}`;

// Duplicate display names across markets must never fall back to a different category.
function matchesSignalChannel(channel, name, category) {
  return channel.name === name && channel.isTextBased() && (!category || channel.parent?.name === category);
}

module.exports = { SIGNAL_CHANNELS, SIGNAL_MARKETS, signalMarket, marketChannelName, matchesSignalChannel };

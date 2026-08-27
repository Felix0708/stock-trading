"use strict";

const assert = require("node:assert/strict");
const { enrichInstrumentNames, formatInstrumentLabel } = require("./instrument-names");
const {
  formatInvestorPortfolioMessage,
  formatInvestorPortfolioMessages,
  formatMyPortfolioMessage,
  loadLatestDuquesne13f,
  loadManager13fContexts,
  shouldRefreshInvestorPortfolio,
} = require("./investor-portfolio");

const responses = new Map([
  ["https://data.sec.gov/submissions/CIK0001536411.json", {
    filings: { recent: {
      form: ["13F-HR", "13F-HR"],
      accessionNumber: ["0001536411-26-000006", "0001536411-26-000004"],
      reportDate: ["2026-06-30", "2026-03-31"],
      filingDate: ["2026-08-14", "2026-05-15"],
    } },
  }],
  ["https://www.sec.gov/Archives/edgar/data/1536411/000153641126000006/index.json", {
    directory: { item: [{ name: "primary_doc.xml" }, { name: "form13f_20260630.xml" }] },
  }],
]);

const xml = `<?xml version="1.0"?>
<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <infoTable><nameOfIssuer>SEA LTD</nameOfIssuer><titleOfClass>SPONSORED ADS</titleOfClass><cusip>81141R100</cusip><value>105404</value><shrsOrPrnAmt><sshPrnamt>1099905</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>
  <infoTable><nameOfIssuer>SEA LTD</nameOfIssuer><titleOfClass>SPONSORED ADS</titleOfClass><cusip>81141R100</cusip><value>50000</value><shrsOrPrnAmt><sshPrnamt>500000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>
  <infoTable><nameOfIssuer>NVIDIA CORP</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>67066G104</cusip><value>1000</value><shrsOrPrnAmt><sshPrnamt>5000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>
</informationTable>`;

const fetchImpl = async (url) => {
  if (String(url).endsWith("form13f_20260630.xml")) {
    return { ok: true, text: async () => xml };
  }
  const body = responses.get(String(url));
  return body
    ? { ok: true, json: async () => body }
    : { ok: false, status: 404 };
};

(async () => {
  const updatedAt = "2026-08-19T15:33:00.000Z";
  assert.equal(shouldRefreshInvestorPortfolio(updatedAt, Date.parse("2026-08-19T16:33:00.000Z"), 1), false);
  assert.equal(shouldRefreshInvestorPortfolio(updatedAt, Date.parse("2026-08-20T15:32:59.000Z"), 1), false);
  assert.equal(shouldRefreshInvestorPortfolio(updatedAt, Date.parse("2026-08-20T15:33:00.000Z"), 1), true);
  assert.equal(formatInstrumentLabel({
    ticker: "005930",
    koreanName: "삼성전자",
    englishName: "Samsung Electronics",
  }), "삼성전자 / Samsung Electronics (005930)");
  const [enriched] = await enrichInstrumentNames(
    [{ exchange: "KRX", ticker: "005930", name: "Samsung Electronics Co Ltd" }],
    { fetchImpl: async (url) => {
      if (String(url).includes("scanner.tradingview.com")) {
        return { ok: true, json: async () => ({ data: [{ s: "KRX:005930", d: ["Samsung Electronics Co Ltd"] }] }) };
      }
      return { ok: true, json: async () => ({ stockName: "삼성전자" }) };
    } },
  );
  assert.equal(formatInstrumentLabel(enriched), "삼성전자 / Samsung Electronics Co Ltd (005930)");
  const seaAliases = await enrichInstrumentNames([
    { exchange: "NY", ticker: "SE", name: "씨이에이(ADS)" },
    { exchange: "NYSE", ticker: "SE", name: "Sea Limited Sponsored ADR Class A" },
  ], { fetchImpl: async () => ({ ok: false }) });
  assert.deepEqual(seaAliases.map(formatInstrumentLabel), [
    "씨 / Sea Limited (SE)",
    "씨 / Sea Limited (SE)",
  ]);

  const filing = await loadLatestDuquesne13f({ fetchImpl });
  assert.equal(filing.reportDate, "2026-06-30");
  assert.equal(filing.filingDate, "2026-08-14");
  assert.equal(filing.holdings.length, 3);
  assert.deepEqual(filing.holdings[0], {
    issuer: "SEA LTD",
    title: "SPONSORED ADS",
    cusip: "81141R100",
    valueThousands: 105404,
    shares: 1099905,
    shareType: "SH",
    putCall: "",
  });
  const managerContext = await loadManager13fContexts(
    [{ name: "Duquesne", cik: 1536411 }],
    2,
    { fetchImpl },
  );
  assert.equal((managerContext.match(/씨 \/ Sea Limited \(SE\)/g) || []).length, 1);
  assert.match(managerContext, /엔비디아 \/ NVIDIA \(NVDA\)/);
  assert.match(managerContext, /보고일 2026-06-30/);
  const onePercentContext = await loadManager13fContexts(
    [{ name: "Duquesne", cik: 1536411 }],
    Number.POSITIVE_INFINITY,
    { fetchImpl, minimumWeight: 1 },
  );
  assert.match(onePercentContext, /씨 \/ Sea Limited \(SE\)/);
  assert.doesNotMatch(onePercentContext, /엔비디아 \/ NVIDIA \(NVDA\)/);

  const publicPayload = formatInvestorPortfolioMessage("x".repeat(6_000), "2026-08-21T00:00:00.000Z");
  assert.equal(publicPayload.embeds.length, 1);
  assert.ok(publicPayload.embeds[0].description.length <= 4_096);
  const institutionPayload = formatInvestorPortfolioMessage("기관", "2026-08-21T00:00:00.000Z", "주요 기관 공개 포트폴리오");
  assert.equal(institutionPayload.embeds[0].title, "주요 기관 공개 포트폴리오");
  const portfolioPages = formatInvestorPortfolioMessages([
    "**스탠리 드러켄밀러**",
    "",
    ...Array.from({ length: 120 }, (_, index) => `- 매우 긴 종목 이름 ${index + 1}(TEST${index + 1}) · 보통주 · ${(120 - index) / 10}%`),
    "",
    "**워런 버핏**",
    "",
    "- 버크셔 해서웨이(BRK.B) · 보통주 · 100.0%",
  ].join("\n"), "2026-08-21T00:00:00.000Z");
  assert.equal(portfolioPages.length, 2);
  assert.ok(portfolioPages.every((payload) => payload.embeds[0].description.length <= 4_096));
  assert.match(portfolioPages[0].embeds[0].description, /종목 이름 1/);
  assert.doesNotMatch(portfolioPages[0].embeds[0].description, /종목 이름 120/);
  assert.match(portfolioPages[0].embeds[0].description, /메시지 한도로 비중 하위 종목 생략/);
  assert.equal(portfolioPages[0].embeds[0].title, "스탠리 드러켄밀러");
  assert.equal(portfolioPages.at(-1).embeds[0].title, "워런 버핏");
  assert.doesNotMatch(portfolioPages.at(-1).embeds[0].description, /워런 버핏/);
  const institutionPages = formatInvestorPortfolioMessages(
    "**블랙록 / BlackRock**\n\n- 애플(Apple) · 보통주 · 5.0%",
    "2026-08-21T00:00:00.000Z",
    "주요 기관 공개 포트폴리오",
  );
  assert.equal(institutionPages[0].embeds[0].title, "블랙록 / BlackRock");

  const pagesWithPreamble = formatInvestorPortfolioMessages(
    "공식 공시 원문 확인: 2026-08-26\n\n**피터 린치**\n\n- 최신 공식 공개 포트폴리오 확인 불가",
    "2026-08-26T00:00:00.000Z",
  );
  assert.equal(pagesWithPreamble.length, 1);
  assert.equal(pagesWithPreamble[0].embeds[0].title, "피터 린치");

  const personalPayload = formatMyPortfolioMessage({
    environment: "mock",
    updatedAt: "2026-08-21T00:00:00.000Z",
    domestic: {
      equity: 1_000_000,
      holdingPositions: [{ code: "A005930", name: "삼성전자", koreanName: "삼성전자", englishName: "Samsung Electronics", quantity: 1, currentPrice: 80_000, evaluationAmount: 80_000, positionRatio: 8 }],
    },
    overseas: {
      equity: 10_000,
      holdingPositions: [{ code: "SE", name: "Sea Limited", koreanName: "씨", englishName: "Sea Limited", quantity: 2, currentPrice: 120, evaluationAmount: 240 }],
    },
  });
  const personalText = personalPayload.embeds[0].description;
  assert.match(personalText, /국내주식 · 1종목\*\*\n\n\*\*삼성전자 \/ Samsung Electronics/);
  assert.match(personalText, /삼성전자 \/ Samsung Electronics \(005930\)\*\*\n1주 · 80,000원 · 8\.0%/);
  assert.match(personalText, /미국주식 · 1종목\*\*\n\n\*\*씨 \/ Sea Limited/);
  assert.match(personalText, /씨 \/ Sea Limited \(SE\)\*\*\n2주 · \$240 · 2\.4%/);
  assert.match(personalPayload.embeds[0].footer.text, /모의계좌/);
  const dualAccountPayload = formatMyPortfolioMessage({
    updatedAt: "2026-08-26T00:00:00.000Z",
    accounts: [
      { label: "키움", environment: "mock", domestic: { holdingPositions: [] }, overseas: { holdingPositions: [] } },
      { label: "한투", environment: "mock", domestic: { holdingPositions: [] }, overseas: { holdingPositions: [] } },
    ],
  });
  assert.match(dualAccountPayload.embeds[0].description, /키움 모의계좌/);
  assert.match(dualAccountPayload.embeds[0].description, /한투 모의계좌/);
  assert.match(dualAccountPayload.embeds[0].footer.text, /키움·한투 모의계좌/);
  console.log("investor-portfolio tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

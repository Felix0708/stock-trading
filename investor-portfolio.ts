"use strict";

const EMBED_DESCRIPTION_LIMIT = 4_096;
const { formatInstrumentLabel, KNOWN_13F_INSTRUMENTS } = require("./instrument-names");

function shouldRefreshInvestorPortfolio(updatedAt, now, refreshDays) {
  const previous = Date.parse(updatedAt || "") || 0;
  return !previous || now - previous >= refreshDays * 86_400_000;
}

function decodeXml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .trim();
}

function xmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i"));
  return decodeXml(match?.[1]);
}

function parse13fInformationTable(xml) {
  return [...String(xml).matchAll(/<(?:\w+:)?infoTable\b[^>]*>([\s\S]*?)<\/(?:\w+:)?infoTable>/gi)]
    .map(([, row]) => ({
      issuer: xmlValue(row, "nameOfIssuer"),
      title: xmlValue(row, "titleOfClass"),
      cusip: xmlValue(row, "cusip"),
      valueThousands: Number(xmlValue(row, "value")),
      shares: Number(xmlValue(row, "sshPrnamt")),
      shareType: xmlValue(row, "sshPrnamtType"),
      putCall: xmlValue(row, "putCall"),
    }))
    .filter((holding) => holding.issuer && holding.cusip
      && Number.isFinite(holding.valueThousands) && Number.isFinite(holding.shares));
}

async function responseBody(response, kind, url) {
  if (!response.ok) throw new Error(`SEC 요청 실패 (${response.status}): ${url}`);
  return response[kind]();
}

async function loadLatest13f({ cik, fetchImpl = fetch, userAgent = "stock-trading-local/0.1 personal-research" }: any = {}) {
  const normalizedCik = String(Number(cik));
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${normalizedCik.padStart(10, "0")}.json`;
  const archives = `https://www.sec.gov/Archives/edgar/data/${normalizedCik}`;
  const options = { headers: { "User-Agent": userAgent, Accept: "application/json, application/xml, text/xml" } };
  const submissions = await responseBody(await fetchImpl(submissionsUrl, options), "json", submissionsUrl);
  const recent = submissions.filings?.recent || {};
  const index = recent.form?.findIndex((form) => form === "13F-HR") ?? -1;
  if (index < 0) throw new Error(`CIK ${normalizedCik}의 최신 13F-HR 제출을 찾지 못했습니다.`);

  const accessionNumber = recent.accessionNumber[index];
  const accession = accessionNumber.replaceAll("-", "");
  const filingRoot = `${archives}/${accession}`;
  const directory = await responseBody(await fetchImpl(`${filingRoot}/index.json`, options), "json", `${filingRoot}/index.json`);
  const xmlFiles = (directory.directory?.item || []).filter((item) => /\.xml$/i.test(item.name) && !/^primary_doc\.xml$/i.test(item.name));
  const informationTable = xmlFiles.find((item) => /(?:info(?:rmation)?table|form13f|holding)/i.test(item.name)) || xmlFiles[0];
  if (!informationTable) throw new Error("최신 13F 정보표 XML을 찾지 못했습니다.");

  const sourceUrl = `${filingRoot}/${informationTable.name}`;
  const xml = await responseBody(await fetchImpl(sourceUrl, options), "text", sourceUrl);
  const holdings = parse13fInformationTable(xml);
  if (!holdings.length) throw new Error("최신 13F 정보표에서 보유 종목을 읽지 못했습니다.");
  return {
    accessionNumber,
    reportDate: recent.reportDate[index],
    filingDate: recent.filingDate[index],
    sourceUrl,
    holdings,
  };
}

function loadLatestDuquesne13f(options: any = {}) {
  return loadLatest13f({ cik: 1536411, ...options });
}

function topHoldings(filing, limit, minimumWeight = 0) {
  const total = filing.holdings.reduce((sum, item) => sum + item.valueThousands, 0);
  const merged = new Map();
  for (const holding of filing.holdings) {
    const key = [holding.issuer, holding.title, holding.putCall]
      .map((value) => String(value || "").trim().toUpperCase())
      .join("|");
    const previous = merged.get(key);
    merged.set(key, previous
      ? { ...previous, valueThousands: previous.valueThousands + holding.valueThousands, shares: previous.shares + holding.shares }
      : holding);
  }
  return [...merged.values()]
    .map((holding) => ({ ...holding, weight: total > 0 ? holding.valueThousands / total * 100 : 0 }))
    .filter((holding) => holding.weight >= minimumWeight)
    .sort((a, b) => b.valueThousands - a.valueThousands)
    .slice(0, limit);
}

async function loadManager13fFilings(managers, options: any = {}) {
  const filings = [];
  for (const manager of managers) {
    try {
      filings.push({ manager, filing: await loadLatest13f({ ...options, cik: manager.cik }) });
    } catch (error) {
      filings.push({ manager, error });
    }
  }
  return filings;
}

function formatManager13fContexts(filings, limit = Number.POSITIVE_INFINITY, minimumWeight = 0) {
  return filings.map(({ manager, filing, error }) => {
    if (error) return `**${manager.name}**\n\n- SEC 13F 원문 확인 실패: ${error.message}`;
    const holdings = topHoldings(filing, limit, minimumWeight).map((holding) => {
      const type = holding.putCall || holding.title || "주식";
      const instrument = KNOWN_13F_INSTRUMENTS[holding.cusip.toUpperCase()];
      return `- ${formatInstrumentLabel(instrument || { name: holding.issuer, ticker: holding.cusip })} · ${type} · ${holding.weight.toFixed(1)}%`;
    });
    return [
      `**${manager.name}**`,
      "",
      ...holdings,
      `- 출처: [SEC 13F](${filing.sourceUrl}) · 보고일 ${filing.reportDate}`,
    ].join("\n");
  }).join("\n\n");
}

async function loadManager13fContexts(managers, limit, options: any = {}) {
  return formatManager13fContexts(
    await loadManager13fFilings(managers, options),
    limit,
    Number(options.minimumWeight) || 0,
  );
}

function formatDuquesne13fContext(filing) {
  const holdings = filing.holdings.map((holding) => [
    holding.issuer,
    holding.title,
    holding.cusip,
    `$${holding.valueThousands}k`,
    `${holding.shares}${holding.shareType}`,
    holding.putCall,
  ].filter(Boolean).join(" | "));
  return [
    `Duquesne Family Office SEC 13F 전체 명세: 보고일 ${filing.reportDate}, 제출일 ${filing.filingDate}, ${holdings.length}개 항목`,
    `원문: ${filing.sourceUrl}`,
    "아래는 해당 보고일의 공시 대상 롱·옵션 전체 항목이다. 현재 보유나 공시 이후 거래를 뜻하지 않으며, 목록에 없다는 이유만으로 다른 자산의 미보유를 단정할 수 없다.",
    ...holdings,
  ].join("\n");
}

function clipDescription(value) {
  const text = String(value || "").trim();
  return text.length <= EMBED_DESCRIPTION_LIMIT
    ? text
    : `${text.slice(0, EMBED_DESCRIPTION_LIMIT - 16).trimEnd()}\n\n…이하 생략`;
}

function formatInvestorPortfolioMessage(context, updatedAt, title = "주요인사 공개 포트폴리오") {
  return {
    embeds: [{
      color: 0x5865f2,
      title,
      description: clipDescription(context),
      footer: { text: `공개 자료 기준 · ${String(updatedAt || "").slice(0, 10)}` },
    }],
    allowedMentions: { parse: [] },
  };
}

function formatInvestorPortfolioMessages(context, updatedAt, title = "주요인사 공개 포트폴리오") {
  const sections = String(context || "").trim().split(/\n{2}(?=\*\*[^*\n]+\*\*\n)/).filter(Boolean);
  const pages = [];
  for (const section of sections) {
    const lines = section.split("\n");
    const heading = lines[0].match(/^\*\*([^*\n]+)\*\*$/)?.[1] || "";
    if (!heading && sections.length > 1) continue;
    if (heading) lines.shift();
    const pageTitle = heading || title;
    let page = "";
    const omission = "- 메시지 한도로 비중 하위 종목 생략";
    for (const line of lines) {
      const next = `${page}${page ? "\n" : ""}${line}`;
      if (next.length > EMBED_DESCRIPTION_LIMIT - omission.length - 2) {
        page = `${page.trim()}\n\n${omission}`;
        break;
      }
      page = next;
    }
    if (page.trim()) pages.push({ title: pageTitle, description: page.trim() });
  }
  return pages.map((page) => formatInvestorPortfolioMessage(
    page.description,
    updatedAt,
    page.title,
  ));
}

function money(value, currency) {
  const amount = Math.abs(Number(value) || 0);
  return currency === "KRW"
    ? `${amount.toLocaleString("ko-KR", { maximumFractionDigits: 0 })}원`
    : `$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function holdingLines(account, currency) {
  const holdings = account?.holdingPositions || [];
  if (!holdings.length) return ["- 보유 종목 없음"];
  return holdings.map((holding) => {
    const code = String(holding.code || "").replace(/^A(?=\d{6}$)/, "");
    const ratio = account.equity > 0 ? holding.evaluationAmount / account.equity * 100 : 0;
    return `**${formatInstrumentLabel({ ...holding, ticker: code })}**\n${holding.quantity}주 · ${money(holding.evaluationAmount, currency)} · ${ratio.toFixed(1)}%`;
  });
}

function formatMyPortfolioMessage({ accounts, domestic, overseas, environment, updatedAt }) {
  const connected = accounts?.length ? accounts : [{ label: "키움", domestic, overseas, environment }];
  const description = connected.flatMap((account, index) => [
    ...(index ? [""] : []),
    `**${account.label} ${account.environment === "mock" ? "모의계좌" : "실계좌"}**`,
    "",
    `**국내주식 · ${account.domestic?.holdingPositions?.length || 0}종목**`,
    "",
    ...holdingLines(account.domestic, "KRW"),
    "",
    `**미국주식 · ${account.overseas?.holdingPositions?.length || 0}종목**`,
    "",
    ...holdingLines(account.overseas, "USD"),
  ]).join("\n");
  const labels = connected.map((account) => account.label).join("·");
  const accountKind = connected.every((account) => account.environment === "mock") ? "모의계좌" : "계좌";
  return {
    embeds: [{
      color: 0x2f9e74,
      title: "나의 포트폴리오",
      description: clipDescription(description),
      footer: { text: `비중은 현금 포함 국내·미국 계좌별 기준 · 연결된 ${labels} ${accountKind} · ${String(updatedAt || "").slice(0, 16).replace("T", " ")} UTC` },
    }],
    allowedMentions: { parse: [] },
  };
}

module.exports = {
  formatDuquesne13fContext,
  formatInvestorPortfolioMessage,
  formatInvestorPortfolioMessages,
  formatManager13fContexts,
  formatMyPortfolioMessage,
  loadLatest13f,
  loadLatestDuquesne13f,
  loadManager13fFilings,
  loadManager13fContexts,
  parse13fInformationTable,
  shouldRefreshInvestorPortfolio,
};

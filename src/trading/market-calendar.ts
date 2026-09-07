"use strict";

// Official dated schedules and their limits: docs/market-calendar.md.
// ponytail: checked-in exchange dates; update annually/for extraordinary closures, no paid calendar service.
const CLOSED: Record<string, Record<string, string[]>> = {
  US: {
    "2026": ["01-01", "01-19", "02-16", "04-03", "05-25", "06-19", "07-03", "09-07", "11-26", "12-25"],
    "2027": ["01-01", "01-18", "02-15", "03-26", "05-31", "06-18", "07-05", "09-06", "11-25", "12-24"],
    "2028": ["01-17", "02-21", "04-14", "05-29", "06-19", "07-04", "09-04", "11-23", "12-25"],
  },
  KR: { "2026": ["01-01", "02-16", "02-17", "02-18", "03-02", "05-01", "05-05", "05-25", "06-03", "08-17", "09-24", "09-25", "10-05", "10-09", "12-25", "12-31"] },
};
const EARLY = new Set(["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"]);
const UNCONFIRMED_SPECIAL = ["2026-01-02", "2026-11-19"];

function tradingDay(market: string, date: string, weekday: string) {
  const country = market === "KRX" || market === "KR" ? "KR" : "US";
  const holidays = CLOSED[country][date.slice(0, 4)];
  if (!holidays || (country === "KR" && UNCONFIRMED_SPECIAL.includes(date))) {
    return { known: false, closed: true, early: false, reason: "거래소 특수 일정·연간 캘린더 확인 필요" };
  }
  const closed = ["Sat", "Sun"].includes(weekday) || holidays.includes(date.slice(5));
  return { known: true, closed, early: country === "US" && EARLY.has(date), reason: closed ? "주말·거래소 휴장일" : "" };
}

function calendarNotices(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const until = new Date(now.getTime() + 30 * 86400_000).toISOString().slice(0, 10);
  const notices = UNCONFIRMED_SPECIAL.filter(date => date >= today && date <= until).map(date => `KRX ${date} 특수 거래시간 확인 필요`);
  for (const country of ["KR", "US"]) for (const year of new Set([today.slice(0, 4), until.slice(0, 4)])) {
    if (!CLOSED[country][year]) notices.push(`${country} ${year}년 거래소 캘린더 갱신 필요`);
  }
  return notices;
}

module.exports = { tradingDay, calendarNotices };

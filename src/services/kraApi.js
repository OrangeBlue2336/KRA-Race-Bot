const { XMLParser } = require('fast-xml-parser');
const { kraServiceKey } = require('../config');

const BASE_URL = 'https://apis.data.go.kr/B551015';

const ENDPOINTS = {
  racePlan: '/API72_2/racePlan_2',
  entrySheet: '/API26_2/entrySheet_2',
  raceSummaryResult: '/API34_1/raceSummaryResult_1',
  raceResult: '/API4_3/raceResult_3',
  integratedInfo: '/API160_1/integratedInfo_1',
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});

function encodedServiceKey() {
  if (!kraServiceKey) {
    throw new Error('KRA_SERVICE_KEY 환경변수가 필요합니다.');
  }
  return kraServiceKey.includes('%') ? kraServiceKey : encodeURIComponent(kraServiceKey);
}

function buildUrl(path, params = {}) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');

  const prefix = `${BASE_URL}${path}?serviceKey=${encodedServiceKey()}`;
  return query ? `${prefix}&${query}` : prefix;
}

function parseBody(text, contentType) {
  const trimmed = text.trim();
  if (contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  return xmlParser.parse(trimmed);
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function extractItems(payload) {
  const response = payload.response || payload;
  const header = response.header || {};
  const body = response.body || {};

  if (header.resultCode && header.resultCode !== '00') {
    throw new Error(header.resultMsg || `KRA API 오류: ${header.resultCode}`);
  }

  return toArray(body.items?.item);
}

async function requestKra(path, params = {}) {
  const common = {
    pageNo: 1,
    numOfRows: 100,
    ...params,
  };

  const attempts = [
    { ...common, _type: 'json' },
    common,
  ];

  let lastError;
  for (const attemptParams of attempts) {
    try {
      const response = await fetch(buildUrl(path, attemptParams));
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
      }
      return extractItems(parseBody(text, response.headers.get('content-type') || ''));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function normalizeNumberFields(item) {
  return Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, typeof value === 'number' ? String(value) : value]),
  );
}

async function getRaceSchedule(meet, rcDate) {
  const items = await requestKra(ENDPOINTS.racePlan, {
    meet,
    rc_date: rcDate,
    numOfRows: 100,
  });
  return items.map(normalizeNumberFields);
}

async function getEntryInfo(meet, rcDate, rcNo) {
  const items = await requestKra(ENDPOINTS.entrySheet, {
    meet,
    rc_date: rcDate,
    numOfRows: 500,
  });
  return items
    .map(normalizeNumberFields)
    .filter((item) => Number(item.rcNo) === Number(rcNo))
    .sort((a, b) => Number(a.chulNo) - Number(b.chulNo));
}

async function getRaceSummaryResult(meet, rcDate, rcNo) {
  const items = await requestKra(ENDPOINTS.raceSummaryResult, {
    meet,
    rcDate,
    numOfRows: 500,
  });
  return items
    .map(normalizeNumberFields)
    .find((item) => Number(item.rcDate) === Number(rcDate) && Number(item.rcNo) === Number(rcNo)) || null;
}

async function getRaceResult(meet, rcDate, rcNo) {
  const items = await requestKra(ENDPOINTS.raceResult, {
    meet,
    rc_date: rcDate,
    rc_no: rcNo,
    numOfRows: 100,
  });
  return items
    .map(normalizeNumberFields)
    .filter((item) => Number(item.rcDate) === Number(rcDate) && Number(item.rcNo) === Number(rcNo))
    .sort((a, b) => Number(a.ord) - Number(b.ord));
}

async function getIntegratedOdds(meet, rcDate, rcNo) {
  const items = await requestKra(ENDPOINTS.integratedInfo, {
    meet,
    rc_date: rcDate,
    rc_no: rcNo,
    numOfRows: 2000,
  });
  return items
    .map(normalizeNumberFields)
    .filter((item) => Number(item.rcDate) === Number(rcDate) && Number(item.rcNo) === Number(rcNo));
}

module.exports = {
  getRaceSchedule,
  getEntryInfo,
  getRaceSummaryResult,
  getRaceResult,
  getIntegratedOdds,
};

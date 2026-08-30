const { XMLParser } = require('fast-xml-parser');
const { kraServiceKey, MEETS } = require('../config');

const BASE_URL = 'https://apis.data.go.kr/B551015';

const ENDPOINTS = {
  racePlan: '/API72_2/racePlan_2',
  entrySheet: '/API26_2/entrySheet_2',
  raceSummaryResult: '/API34_1/raceSummaryResult_1',
  raceResult: '/API4_3/raceResult_3',
  integratedInfo: '/API160_1/integratedInfo_1',
  jockeyChangeDetail: '/API300/Jockey_Change_Detail',
  raceHorseCancelInfo: '/API9_1/raceHorseCancelInfo_1',
  totalHorseInfo: '/API42_1/totalHorseInfo_1',
  trainerInfo: '/API19_1/trainerInfo_1',
  jockeyResult: '/API11_1/jockeyResult_1',
  entryHorseWeightInfo: '/API25_1/entryHorseWeightInfo_1',
  trackInfo: '/API189_1/Track_1',
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

function resultUnit(path) {
  if (path === ENDPOINTS.totalHorseInfo) return '마리';
  if (path === ENDPOINTS.entrySheet) return '두';
  return '건';
}

function meetLabel(meet) {
  const found = MEETS.find((item) => item.apiMeet === String(meet));
  return found ? `${found.name} 경마장 ` : '';
}

function logKraSuccess(purpose, path, params, items) {
  console.info(`📡 API 호출 - ${purpose}. ${meetLabel(params.meet)}${items.length}${resultUnit(path)} 조회 성공`);
}

function logKraError(purpose, error) {
  console.error(`📡 API 호출 오류 - ${purpose} ${error.message}`);
}

async function requestKra(path, params = {}, purpose = 'KRA 데이터 조회') {
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
      const items = extractItems(parseBody(text, response.headers.get('content-type') || ''));
      logKraSuccess(purpose, path, attemptParams, items);
      return items;
    } catch (error) {
      lastError = error;
    }
  }

  logKraError(purpose, lastError);
  throw lastError;
}

function normalizeNumberFields(item) {
  return Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, typeof value === 'number' ? String(value) : value]),
  );
}

async function getRaceSchedule(meet, rcDate, purpose = '경마 일정 조회') {
  const items = await requestKra(ENDPOINTS.racePlan, {
    meet,
    rc_date: rcDate,
    numOfRows: 100,
  }, purpose);
  return items.map(normalizeNumberFields);
}

async function getEntryInfo(meet, rcDate, rcNo, purpose = '경주 출전표 조회') {
  const items = await requestKra(ENDPOINTS.entrySheet, {
    meet,
    rc_date: rcDate,
    numOfRows: 500,
  }, purpose);
  return items
    .map(normalizeNumberFields)
    .filter((item) => Number(item.rcNo) === Number(rcNo))
    .sort((a, b) => Number(a.chulNo) - Number(b.chulNo));
}

async function getRaceSummaryResult(meet, rcDate, rcNo, purpose = '경주 결과 요약 조회') {
  const items = await requestKra(ENDPOINTS.raceSummaryResult, {
    meet,
    rcDate,
    numOfRows: 500,
  }, purpose);
  return items
    .map(normalizeNumberFields)
    .find((item) => Number(item.rcDate) === Number(rcDate) && Number(item.rcNo) === Number(rcNo)) || null;
}

async function getRaceResult(meet, rcDate, rcNo, purpose = '경주 결과 조회') {
  const items = await requestKra(ENDPOINTS.raceResult, {
    meet,
    rc_date: rcDate,
    rc_no: rcNo,
    numOfRows: 100,
  }, purpose);
  return items
    .map(normalizeNumberFields)
    .filter((item) => Number(item.rcDate) === Number(rcDate) && Number(item.rcNo) === Number(rcNo))
    .sort((a, b) => Number(a.ord) - Number(b.ord));
}

async function getIntegratedOdds(meet, rcDate, rcNo, purpose = '통합 배당률 조회') {
  const items = await requestKra(ENDPOINTS.integratedInfo, {
    meet,
    rc_date: rcDate,
    rc_no: rcNo,
    numOfRows: 2000,
  }, purpose);
  return items
    .map(normalizeNumberFields)
    .filter((item) => Number(item.rcDate) === Number(rcDate) && Number(item.rcNo) === Number(rcNo));
}

async function getJockeyChanges(meet, rcDate, rcNo, purpose = '기수 변경 조회') {
  const items = await requestKra(ENDPOINTS.jockeyChangeDetail, {
    meet,
    rc_date: rcDate,
    rc_no: rcNo,
    numOfRows: 100,
  }, purpose);
  return items
    .map(normalizeNumberFields)
    .filter((item) => Number(item.rcDate) === Number(rcDate) && Number(item.rcNo) === Number(rcNo))
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
}

async function getRaceHorseCancels(meet, rcDate, rcNo, purpose = '출전 취소 조회') {
  const items = await requestKra(ENDPOINTS.raceHorseCancelInfo, {
    meet,
    rc_date: rcDate,
    numOfRows: 500,
  }, purpose);
  return items
    .map(normalizeNumberFields)
    .filter((item) => Number(item.rcDate) === Number(rcDate) && Number(item.rcNo) === Number(rcNo))
    .sort((a, b) => Number(a.chulNo || 0) - Number(b.chulNo || 0));
}

async function searchHorseInfoByName(hrName, purpose = '말 정보 검색') {
  const items = await requestKra(ENDPOINTS.totalHorseInfo, {
    hr_name: hrName,
    // 10건 이상이면 선택을 통한 상세 조회를 막으므로, 그 판단에 필요한 11건만 요청한다.
    numOfRows: 11,
  }, purpose);
  return items.map(normalizeNumberFields);
}

async function getHorseInfoByNo(hrNo, purpose = '말 상세 정보 조회') {
  const items = await requestKra(ENDPOINTS.totalHorseInfo, {
    hr_no: hrNo,
    numOfRows: 10,
  }, purpose);
  return items.map(normalizeNumberFields).find((item) => String(item.hrNo) === String(hrNo)) || null;
}

async function getTrainerInfo(meet, trNo, purpose = '조교사 정보 조회') {
  const items = await requestKra(ENDPOINTS.trainerInfo, { meet, tr_no: trNo, numOfRows: 10 }, purpose);
  return items.map(normalizeNumberFields).find((item) => String(item.trNo) === String(trNo)) || null;
}

async function getJockeyResult(meet, jkNo, purpose = '기수 성적 조회') {
  const items = await requestKra(ENDPOINTS.jockeyResult, { meet, jk_no: jkNo, numOfRows: 10 }, purpose);
  return items.map(normalizeNumberFields).find((item) => String(item.jkNo) === String(jkNo)) || null;
}

async function getEntryHorseWeightInfo(meet, rcDate, hrNo, purpose = '출전마 체중 조회') {
  const items = await requestKra(ENDPOINTS.entryHorseWeightInfo, {
    meet,
    hr_no: hrNo,
    rc_date: rcDate,
    numOfRows: 100,
  }, purpose);
  return items.map(normalizeNumberFields).find((item) => String(item.hrNo) === String(hrNo) && Number(item.rcDate) === Number(rcDate)) || null;
}

async function getTrackInfo(meet, rcDate, rcNo, purpose = '주로 정보 조회') {
  const items = await requestKra(ENDPOINTS.trackInfo, {
    meet,
    rc_date_fr: rcDate,
    rc_date_to: rcDate,
    numOfRows: 100,
  }, purpose);
  return items
    .map(normalizeNumberFields)
    .find((item) => Number(item.rcDate) === Number(rcDate) && Number(item.rcNo) === Number(rcNo)) || null;
}

module.exports = {
  getRaceSchedule,
  getEntryInfo,
  getRaceSummaryResult,
  getRaceResult,
  getIntegratedOdds,
  getJockeyChanges,
  getRaceHorseCancels,
  searchHorseInfoByName,
  getHorseInfoByNo,
  getTrainerInfo,
  getJockeyResult,
  getEntryHorseWeightInfo,
  getTrackInfo,
};

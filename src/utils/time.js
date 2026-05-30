const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const KST_ZONE = 'Asia/Seoul';

function nowKST() {
  return dayjs().tz(KST_ZONE);
}

function todayKST() {
  return nowKST().format('YYYYMMDD');
}

function normalizeRaceTime(schStTime) {
  return String(schStTime || '').replace(/\D/g, '').padStart(4, '0').slice(-4);
}

function raceStartAtKST(rcDate, schStTime) {
  const date = String(rcDate);
  const time = normalizeRaceTime(schStTime);
  const isoLike = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}:00`;
  return dayjs.tz(isoLike, KST_ZONE);
}

function formatRaceDate(rcDate) {
  const date = String(rcDate);
  return `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}`;
}

function formatRaceTime(schStTime) {
  const time = normalizeRaceTime(schStTime);
  return `${time.slice(0, 2)}:${time.slice(2, 4)}`;
}

function isPastTicketClose(rcDate, schStTime, closeBeforeStartMinutes) {
  return nowKST().isAfter(raceStartAtKST(rcDate, schStTime).subtract(closeBeforeStartMinutes, 'minute'));
}

function canCheckRaceResult(rcDate, schStTime, delayMinutes) {
  return nowKST().isAfter(raceStartAtKST(rcDate, schStTime).add(delayMinutes, 'minute'));
}

module.exports = {
  KST_ZONE,
  nowKST,
  todayKST,
  normalizeRaceTime,
  raceStartAtKST,
  formatRaceDate,
  formatRaceTime,
  isPastTicketClose,
  canCheckRaceResult,
};

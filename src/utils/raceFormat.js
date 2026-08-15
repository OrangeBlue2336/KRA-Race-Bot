const { formatRaceDate } = require('./time');

function cleanValue(value) {
  if (value === undefined || value === null || value === '' || value === '-') return '미상';
  return String(value);
}

function formatApiDate(value) {
  const date = String(value || '');
  if (!/^\d{8}$/.test(date) || date === '99991231') return '미상';
  return formatRaceDate(date);
}

function formatMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${amount.toLocaleString()}원` : '미상';
}

function compactLines(lines) {
  return lines.filter(Boolean).join('\n').slice(0, 1024) || '미상';
}

module.exports = {
  cleanValue,
  formatApiDate,
  formatMoney,
  compactLines,
};

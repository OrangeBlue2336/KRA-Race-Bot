const config = require('../config');

const RESPONSIBLE_GAMBLING_STATUS = '도박 중독 상담은 국번 없이 1336';

function isDeveloper(userId) {
  return config.developerUserIds.includes(String(userId));
}

function moneyText(amount) {
  return `${Number(amount || 0).toLocaleString()}머니`;
}

function displayUsername(username) {
  return String(username || '알 수 없는 유저').replace(/[\\`*_{}\[\]()<>#+\-.!|]/g, '\\$&');
}

module.exports = {
  RESPONSIBLE_GAMBLING_STATUS,
  isDeveloper,
  moneyText,
  displayUsername,
};

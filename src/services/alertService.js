const { EmbedBuilder } = require('discord.js');
const AlertSubscription = require('../models/AlertSubscription');
const Ticket = require('../models/Ticket');
const kraApi = require('./kraApi');
const { alertCheckIntervalMs, MEET_BY_CODE } = require('../config');
const { formatRaceDate, formatRaceTime } = require('../utils/time');

const ALERT_TYPES = {
  JOCKEY_CHANGE: {
    value: 'JOCKEY_CHANGE',
    label: '기수 변경',
  },
  HORSE_CANCEL: {
    value: 'HORSE_CANCEL',
    label: '출전 취소',
  },
};

let workerTimer = null;
let workerRunning = false;

function alertEventKey(alertType, item) {
  if (alertType === ALERT_TYPES.JOCKEY_CHANGE.value) {
    return [
      'v2',
      alertType,
      item.rcDate,
      item.rcNo,
      item.chulNo,
      item.seq || '',
      item.jkBef || item.jkBefName || '',
      item.jkAft || item.jkAftName || '',
    ].join(':');
  }

  return [
    alertType,
    item.rcDate,
    item.rcNo,
    item.chulNo,
    item.hrNo || item.hrName || '',
    item.reason || '',
  ].join(':');
}

async function fetchAlertItems(alertType, ticket, apiCache = new Map()) {
  const meet = MEET_BY_CODE[ticket.meetCode];
  const apiMeet = meet?.apiMeet || ticket.meet;
  const cacheKey = `${alertType}:${apiMeet}:${ticket.rcDate}:${ticket.rcNo}`;
  if (apiCache.has(cacheKey)) return apiCache.get(cacheKey);

  const items = alertType === ALERT_TYPES.JOCKEY_CHANGE.value
    ? await kraApi.getJockeyChanges(apiMeet, ticket.rcDate, ticket.rcNo)
    : await kraApi.getRaceHorseCancels(apiMeet, ticket.rcDate, ticket.rcNo);

  apiCache.set(cacheKey, items);
  return items;
}

async function getSubscribedAlertTypes(ticket) {
  const subscriptions = await AlertSubscription.find({
    discordId: ticket.discordId,
    meetCode: ticket.meetCode,
  }).lean();

  return subscriptions.map((subscription) => subscription.alertType);
}

function describeJockeyChange(item) {
  const before = `${item.jkBefName || '미상'}${item.befBudam ? ` (${item.befBudam}kg)` : ''}`;
  const after = `${item.jkAftName || '미상'}${item.aftBudam ? ` (${item.aftBudam}kg)` : ''}`;
  return [
    `**출주번호 ${item.chulNo}번 ${item.hrName || '이름 미상'}**`,
    `${before} -> **${after}**`,
    item.reason ? `사유: ${item.reason}` : '',
    item.openTime ? `공지시각: ${item.openTime}` : '',
  ].filter(Boolean).join('\n');
}

function describeHorseCancel(item) {
  return [
    `**출주번호 ${item.chulNo}번 ${item.hrName || '이름 미상'}**`,
    item.reason ? `사유: ${item.reason}` : '',
  ].filter(Boolean).join('\n');
}

function buildAlertEmbed(ticket, alertType, item) {
  const isJockeyChange = alertType === ALERT_TYPES.JOCKEY_CHANGE.value;
  return new EmbedBuilder()
    .setColor(isJockeyChange ? 0xf1c40f : 0xe67e22)
    .setTitle(isJockeyChange ? '🔔 기수 변경 알림' : '⚠️ 출전 취소 알림')
    .setDescription(isJockeyChange ? describeJockeyChange(item) : describeHorseCancel(item))
    .addFields(
      { name: '경주', value: `${ticket.meet} ${ticket.rcNo}경주 (${formatRaceDate(ticket.rcDate)} ${formatRaceTime(ticket.schStTime)})`, inline: false },
      { name: '내 마권', value: `${ticket.betType} / ${ticket.isTest ? 'test' : `${ticket.horses.join(', ')}번`} / ${Number(ticket.amount).toLocaleString()}원`, inline: false },
    )
    .setTimestamp();
}

async function sendAlert(client, ticket, alertType, item) {
  const user = await client.users.fetch(ticket.discordId);
  await user.send({ embeds: [buildAlertEmbed(ticket, alertType, item)] });
}

async function checkTicketAlerts(client, ticket, apiCache = new Map()) {
  const alertTypes = await getSubscribedAlertTypes(ticket);
  if (alertTypes.length === 0) return;

  for (const alertType of alertTypes) {
    const items = await fetchAlertItems(alertType, ticket, apiCache);
    for (const item of items) {
      const key = alertEventKey(alertType, item);
      const reservedTicket = await Ticket.findOneAndUpdate(
        {
          _id: ticket._id,
          alertNotifiedEventKeys: { $ne: key },
        },
        { $addToSet: { alertNotifiedEventKeys: key }, $set: { alertError: '' } },
      );
      if (!reservedTicket) continue;

      try {
        await sendAlert(client, ticket, alertType, item);
      } catch (error) {
        await Ticket.updateOne(
          { _id: ticket._id },
          { $pull: { alertNotifiedEventKeys: key }, $set: { alertError: error.message } },
        );
        throw error;
      }
    }
  }
}

async function checkActiveTicketAlerts(client) {
  if (workerRunning) return;
  workerRunning = true;

  try {
    const tickets = await Ticket.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(200);
    const apiCache = new Map();

    for (const ticket of tickets) {
      try {
        await checkTicketAlerts(client, ticket, apiCache);
      } catch (error) {
        await Ticket.updateOne(
          { _id: ticket._id },
          { $set: { alertError: error.message } },
        );
      }
    }
  } finally {
    workerRunning = false;
  }
}

function startAlertWorker(client) {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    checkActiveTicketAlerts(client).catch((error) => {
      console.error('[alert worker]', error);
    });
  }, alertCheckIntervalMs);

  checkActiveTicketAlerts(client).catch((error) => {
    console.error('[alert worker]', error);
  });
}

module.exports = {
  ALERT_TYPES,
  startAlertWorker,
  checkActiveTicketAlerts,
  checkTicketAlerts,
};

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const Ticket = require('../models/Ticket');
const UserMoney = require('../models/UserMoney');
const kraApi = require('./kraApi');
const { evaluateTicket } = require('../utils/betting');
const { canCheckRaceResult, formatRaceDate, formatRaceTime } = require('../utils/time');
const { MEET_BY_CODE, resultCheckDelayMinutes, resultCheckIntervalMs } = require('../config');

let workerTimer = null;
let workerRunning = false;

function buildVodUrl(meetCode, rcDate, rcNo) {
  const apiMeet = MEET_BY_CODE[meetCode]?.apiMeet;
  if (!apiMeet) return null;
  return `https://kraplayer.starplayer.net/kra/vod/starplayer.php?meet=${apiMeet}&rcdate=${rcDate}&rcno=${rcNo}&vod_type=r`;
}

const PLACE_BADGES = {
  1: '🥇',
  2: '🥈',
  3: '🥉',
};

function getPlaceBadge(place) {
  return PLACE_BADGES[place] || `${place}착`;
}

function normalizeCombo(numbers, ordered = false) {
  const values = numbers.map((number) => String(number));
  return ordered ? values.join('-') : [...values].sort((a, b) => Number(a) - Number(b)).join('-');
}

function findIntegratedOdd(oddsItems, pool, numbers, ordered = false) {
  const target = normalizeCombo(numbers, ordered);
  const item = oddsItems.find((oddsItem) => {
    if (oddsItem.pool !== pool) return false;
    const itemNumbers = [oddsItem.chulNo, oddsItem.chulNo2, oddsItem.chulNo3]
      .map((number) => String(number))
      .filter((number) => number !== '0');
    return normalizeCombo(itemNumbers, ordered) === target;
  });
  return item ? Number(item.odds || 0) : 0;
}

function buildSummaryFromIntegratedOdds(top3, oddsItems) {
  if (top3.length < 3 || oddsItems.length === 0) return null;

  const [first, second, third] = top3.map((result) => String(result.chulNo));
  const qplPairs = [
    [first, second],
    [first, third],
    [second, third],
  ];

  return {
    winChulNo: first,
    winOdds: findIntegratedOdd(oddsItems, '단승식', [first]),
    plcChulNo: [first, second, third].join('-'),
    plcOdds: [first, second, third]
      .map((number) => findIntegratedOdd(oddsItems, '연승식', [number]))
      .join('-'),
    qplChulNo: qplPairs.map((pair) => pair.join('-')).join(','),
    qplOdds: qplPairs
      .map((pair) => findIntegratedOdd(oddsItems, '복연승식', pair, false))
      .join(','),
    qnlChulNo: `${first}-${second}`,
    qnlOdds: findIntegratedOdd(oddsItems, '복승식', [first, second], false),
    exaChulNo: `${first}-${second}`,
    exaOdds: findIntegratedOdd(oddsItems, '쌍승식', [first, second], true),
    tlaChulNo: `${first}-${second}-${third}`,
    tlaOdds: findIntegratedOdd(oddsItems, '삼복승식', [first, second, third], false),
    triChulNo: `${first}-${second}-${third}`,
    triOdds: findIntegratedOdd(oddsItems, '삼쌍승식', [first, second, third], true),
  };
}

function formatTop3(top3) {
  if (!top3.length) return '결과 정보 없음';
  return top3
    .map((result) => `${getPlaceBadge(result.ord)}: ${result.chulNo}번 ${result.hrName || '이름 미상'}`)
    .join('\n');
}

function buildResultEmbed(ticket, evaluation, top3, balance) {
  const selected = ticket.isTest ? 'test' : `${ticket.horses.join(', ')}번`;
  const odds = Number(evaluation.odds || 0);
  const payout = !ticket.isTest && evaluation.won ? Math.floor(ticket.amount * odds) : 0;

  const embed = new EmbedBuilder()
    .setColor(evaluation.won ? 0x2ecc71 : 0xe74c3c)
    .setTitle(evaluation.won ? '💵 마권 적중!' : '💸 마권 적중 실패')
    .setDescription(
      evaluation.won
        ? `${ticket.amount.toLocaleString()}머니 x 배당률 ${odds || 1} = **${payout.toLocaleString()}머니 환급**입니다.`
        : `**${ticket.amount.toLocaleString()}머니**를 잃었습니다!`,
    )
    .addFields(
      { name: '경주', value: `${ticket.meet} ${ticket.rcNo}경주 (${formatRaceDate(ticket.rcDate)} ${formatRaceTime(ticket.schStTime)})`, inline: false },
      { name: '베팅', value: `${ticket.betType} / ${selected} / ${ticket.amount.toLocaleString()}머니`, inline: false },
      { name: '실제 1, 2, 3착', value: formatTop3(top3), inline: false },
    )
    .setTimestamp();

  if (evaluation.note) {
    embed.addFields({ name: '참고', value: evaluation.note, inline: false });
  }

  if (Number.isFinite(balance)) {
    embed.addFields({ name: '현재 보유 머니', value: `${balance.toLocaleString()}머니`, inline: false });
  }

  return {
    embed,
    payout,
    odds,
  };
}

async function notifyUser(client, ticket, evaluation, top3, balance) {
  const { embed, payout, odds } = buildResultEmbed(ticket, evaluation, top3, balance);
  const user = await client.users.fetch(ticket.discordId);

  const vodUrl = buildVodUrl(ticket.meetCode, ticket.rcDate, ticket.rcNo);
  const components = vodUrl
    ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('🎬 경주 영상 보기')
          .setURL(vodUrl)
          .setStyle(ButtonStyle.Link),
      )]
    : [];

  await user.send({ embeds: [embed], components });
  return { payout, odds };
}

async function fetchRaceSettlementData(apiMeet, rcDate, rcNo, apiCache) {
  const cacheKey = `${apiMeet}:${rcDate}:${rcNo}`;
  if (apiCache.has(cacheKey)) return apiCache.get(cacheKey);

  const promise = (async () => {
    const [raceResults, summary] = await Promise.all([
      kraApi.getRaceResult(apiMeet, rcDate, rcNo, '마권 정산 경주 결과 확인'),
      kraApi.getRaceSummaryResult(apiMeet, rcDate, rcNo, '마권 정산 결과 요약 확인'),
    ]);

    const top3 = raceResults
      .filter((result) => Number(result.ord) >= 1 && Number(result.ord) <= 3)
      .slice(0, 3)
      .map((result) => ({
        ord: Number(result.ord),
        chulNo: String(result.chulNo),
        hrName: result.hrName || result.hrNameEn || '',
        winOdds: Number(result.winOdds || 0),
        plcOdds: Number(result.plcOdds || 0),
      }));

    const oddsItems = summary ? [] : await kraApi.getIntegratedOdds(apiMeet, rcDate, rcNo, '마권 정산 배당률 확인');
    const settlementSummary = summary || buildSummaryFromIntegratedOdds(top3, oddsItems);

    return { top3, settlementSummary };
  })();

  apiCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    apiCache.delete(cacheKey); // 실패한 요청은 캐시에서 제거해 다음 티켓에서 재시도
    throw error;
  }
}

async function settleTicket(client, ticket, apiCache) {
  const lockedTicket = await Ticket.findOneAndUpdate(
    { _id: ticket._id, status: 'pending' },
    { $set: { status: 'checking', settlementError: '' } },
    { new: true },
  );

  if (!lockedTicket) return;

  try {
    const apiMeet = MEET_BY_CODE[lockedTicket.meetCode]?.apiMeet || lockedTicket.meet;
    const { top3, settlementSummary } = await fetchRaceSettlementData(
      apiMeet, lockedTicket.rcDate, lockedTicket.rcNo, apiCache,
    );

    if (top3.length < 3 || (!settlementSummary && !lockedTicket.isTest)) {
      await Ticket.updateOne(
        { _id: lockedTicket._id },
        { $set: { status: 'pending', settlementError: '결과 또는 배당 정보가 아직 공개되지 않았습니다.' } },
      );
      return;
    }

    const evaluation = evaluateTicket(lockedTicket, top3, settlementSummary || {});
    const odds = Number(evaluation.odds || 0);
    const payout = !lockedTicket.isTest && evaluation.won ? Math.floor(lockedTicket.amount * odds) : 0;
    const settledTicket = await Ticket.findOneAndUpdate(
      { _id: lockedTicket._id, status: 'checking' },
      {
        $set: {
          status: evaluation.won ? 'won' : 'lost',
          odds,
          payout,
          resultTop3: top3,
          settledAt: new Date(),
          settlementError: '',
        },
      },
      { new: true },
    );
    if (!settledTicket) return;

    let account = await UserMoney.findOne({ discordId: lockedTicket.discordId });
    if (!lockedTicket.isTest && evaluation.won && payout > 0) {
      account = await UserMoney.findOneAndUpdate(
        { discordId: lockedTicket.discordId },
        { $inc: { balance: payout } },
        { new: true },
      );
      await Ticket.updateOne({ _id: lockedTicket._id }, { $set: { moneyRewarded: true } });
    }
    await notifyUser(client, lockedTicket, evaluation, top3, account ? Number(account.balance) : undefined);
  } catch (error) {
    await Ticket.updateOne(
      { _id: lockedTicket._id, status: 'checking' },
      {
        $set: {
          status: 'pending',
          settlementError: error.message,
        },
      },
    );
  }
}

async function checkPendingTickets(client) {
  if (workerRunning) return;
  workerRunning = true;

  try {
    const tickets = await Ticket.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(100);
    const apiCache = new Map();
    for (const ticket of tickets) {
      if (canCheckRaceResult(ticket.rcDate, ticket.schStTime, resultCheckDelayMinutes)) {
        await settleTicket(client, ticket, apiCache);
      }
    }
  } finally {
    workerRunning = false;
  }
}

function startSettlementWorker(client) {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    checkPendingTickets(client).catch((error) => {
      console.error('[settlement worker]', error);
    });
  }, resultCheckIntervalMs);

  checkPendingTickets(client).catch((error) => {
    console.error('[settlement worker]', error);
  });
}

module.exports = {
  startSettlementWorker,
  checkPendingTickets,
};

const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const mongoose = require('mongoose');
const config = require('./config');
const AlertSubscription = require('./models/AlertSubscription');
const Ticket = require('./models/Ticket');
const kraApi = require('./services/kraApi');
const { ALERT_TYPES, checkTicketAlerts, startAlertWorker } = require('./services/alertService');
const { startKeepAlive } = require('./services/keepAliveServer');
const { startSettlementWorker } = require('./services/settlementService');
const {
  parseAmount,
  parseHorseInput,
  validateEntryNumbers,
  validateHorseCount,
} = require('./utils/betting');
const {
  KST_ZONE,
  formatRaceDate,
  formatRaceTime,
  isPastTicketClose,
  normalizeRaceTime,
  nowKST,
  raceStartAtKST,
  todayKST,
} = require('./utils/time');
const dayjs = require('dayjs');

const RESPONSIBLE_GAMBLING_STATUS = '도박 중독 상담은 국번 없이 1336';
const PRESENCE_UPDATE_INTERVAL_MS = 15_000;

const CUSTOM_IDS = {
  meetSelect: 'ticket:meet',
  raceSelect: 'ticket:race',
  betTypeSelect: 'ticket:bet_type',
  horsesInput: 'ticket:horses',
  amountInput: 'ticket:amount',
  modalPrefix: 'ticket:modal:',
  schedulePrevPrefix: 'schedule:prev:',
  scheduleNextPrefix: 'schedule:next:',
  myTicketsPrevPrefix: 'mytickets:prev:',
  myTicketsNextPrefix: 'mytickets:next:',
  alertCancelConfirmPrefix: 'alert:cancel:confirm:',
  alertCancelDismissPrefix: 'alert:cancel:dismiss:',
  horseInfoSelectPrefix: 'horseinfo:select:',
};

const scheduleCache = new Map();

function getCommandData() {
  return [
    new SlashCommandBuilder()
      .setName('마권발매')
      .setDescription('실제 경마 결과와 연동되는 가상 마권을 발매합니다.')
      .addStringOption((option) => option
        .setName('경마장')
        .setDescription('베팅할 경마장을 선택합니다.')
        .setRequired(true)
        .addChoices(
          ...config.MEETS.map((meet) => ({ name: meet.name, value: meet.code })),
        )),
    new SlashCommandBuilder()
      .setName('내마권')
      .setDescription('지금까지 발매한 내 가상 마권 내역을 확인합니다.'),
    new SlashCommandBuilder()
      .setName('경마일정')
      .setDescription('오늘부터 1주일 동안의 경마 일정을 확인합니다.')
      .addStringOption((option) => option
        .setName('경마장')
        .setDescription('일정을 확인할 경마장을 선택합니다.')
        .setRequired(true)
        .addChoices(
          ...config.MEETS.map((meet) => ({ name: meet.name, value: meet.code })),
        )),
    new SlashCommandBuilder()
      .setName('알림구독')
      .setDescription('마권 발매 후 기수 변경 또는 출전 취소 알림을 DM으로 받습니다.')
      .addStringOption((option) => option
        .setName('경마장')
        .setDescription('알림을 받을 경마장을 선택합니다.')
        .setRequired(true)
        .addChoices(
          ...config.MEETS.map((meet) => ({ name: meet.name, value: meet.code })),
        ))
      .addStringOption((option) => option
        .setName('알림종류')
        .setDescription('구독할 알림 종류를 선택합니다.')
        .setRequired(true)
        .addChoices(
          { name: ALERT_TYPES.JOCKEY_CHANGE.label, value: ALERT_TYPES.JOCKEY_CHANGE.value },
          { name: ALERT_TYPES.HORSE_CANCEL.label, value: ALERT_TYPES.HORSE_CANCEL.value },
        )),
    new SlashCommandBuilder()
      .setName('말정보')
      .setDescription('말 이름으로 KRA 마필종합 상세정보를 검색합니다.')
      .addStringOption((option) => option
        .setName('말이름')
        .setDescription('검색할 말 이름을 입력합니다.')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(40)),
  ];
}

function cacheKey(meetCode, rcDate = todayKST()) {
  return `${meetCode}:${rcDate}`;
}

function getCachedSchedule(meetCode, rcDate = todayKST()) {
  const cached = scheduleCache.get(cacheKey(meetCode, rcDate));
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) return null;
  return cached.races;
}

async function loadSchedule(meet, rcDate = todayKST()) {
  const races = await kraApi.getRaceSchedule(meet.apiMeet, rcDate);
  scheduleCache.set(cacheKey(meet.code, rcDate), {
    races,
    expiresAt: Date.now() + 5 * 60_000,
  });
  return races;
}

async function warmScheduleCache() {
  await Promise.allSettled(config.MEETS.map(loadSchedule));
}

function getNextPresenceRaces(races, meetOrder = []) {
  const now = nowKST();
  const futureRaces = races
    .map((race) => ({
      ...race,
      closeAt: raceStartAtKST(race.rcDate, race.schStTime)
        .subtract(config.ticketCloseBeforeStartMinutes, 'minute'),
    }))
    .filter((race) => race.closeAt.isAfter(now))
    .sort((a, b) => {
      const closeDiff = a.closeAt.valueOf() - b.closeAt.valueOf();
      if (closeDiff !== 0) return closeDiff;
      return Number(a.rcNo) - Number(b.rcNo);
    });

  const nextByMeet = new Map();
  futureRaces.forEach((race) => {
    if (!nextByMeet.has(race.meetCode)) {
      nextByMeet.set(race.meetCode, race);
    }
  });

  const orderedRaces = meetOrder
    .filter((meetCode) => nextByMeet.has(meetCode))
    .map((meetCode) => nextByMeet.get(meetCode));
  const newRaces = [...nextByMeet.values()]
    .filter((race) => !meetOrder.includes(race.meetCode));

  return [...orderedRaces, ...newRaces];
}

function formatRacePresenceMessage(race) {
  return `${race.meetName} ${Number(race.rcNo)}R ${race.closeAt.format('HH:mm')} 발매 마감`;
}

async function loadTodayPresenceRaces() {
  const rcDate = todayKST();
  const results = await Promise.allSettled(config.MEETS.map((meet) => loadDaySchedule(meet, rcDate)));
  const rejected = results.filter((result) => result.status === 'rejected');
  if (rejected.length > 0) {
    rejected.forEach((result) => console.error('[presence]', result.reason));
  }

  return results
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value);
}

function startRacePresenceWorker(client) {
  let lastPresenceMessage = '';
  let meetOrder = [];
  let presenceIndex = 0;

  const updatePresence = async () => {
    const races = await loadTodayPresenceRaces();
    const candidates = getNextPresenceRaces(races, meetOrder);
    meetOrder = candidates.map((race) => race.meetCode);

    if (presenceIndex >= candidates.length) {
      presenceIndex = 0;
    }

    const message = candidates.length > 0
      ? formatRacePresenceMessage(candidates[presenceIndex])
      : RESPONSIBLE_GAMBLING_STATUS;
    if (message === lastPresenceMessage) return;

    client.user.setPresence({
      activities: [{ name: message, type: ActivityType.Watching }],
      status: 'online',
    });
    lastPresenceMessage = message;
    presenceIndex = candidates.length > 0 ? (presenceIndex + 1) % candidates.length : 0;
  };

  updatePresence().catch((error) => console.error('[presence]', error));
  return setInterval(() => updatePresence().catch((error) => console.error('[presence]', error)), PRESENCE_UPDATE_INTERVAL_MS);
}

function weekDatesFromToday() {
  const start = dayjs().tz(KST_ZONE);
  return Array.from({ length: 7 }, (_, index) => start.add(index, 'day').format('YYYYMMDD'));
}

async function loadDaySchedule(meet, rcDate) {
  const cached = getCachedSchedule(meet.code, rcDate);
  const races = cached || await loadSchedule(meet, rcDate);

  return races
    .filter((race) => String(race.rcDate) === rcDate)
    .map((race) => ({
      ...race,
      meetCode: meet.code,
      meetName: meet.name,
    }))
    .sort((a, b) => {
      const timeDiff = Number(normalizeRaceTime(a.schStTime)) - Number(normalizeRaceTime(b.schStTime));
      if (timeDiff !== 0) return timeDiff;
      return Number(a.rcNo) - Number(b.rcNo);
    });
}

async function loadWeekSchedule(meetCode) {
  const meet = config.MEET_BY_CODE[meetCode];
  const dates = weekDatesFromToday();
  const days = [];
  for (const rcDate of dates) {
    days.push({
      rcDate,
      races: await loadDaySchedule(meet, rcDate),
    });
  }
  return days;
}

function firstScheduleIndex(days) {
  const todayIndex = 0;
  if (days[todayIndex]?.races.length > 0) return todayIndex;
  const nearest = days.findIndex((day) => day.races.length > 0);
  return nearest === -1 ? todayIndex : nearest;
}

function ticketStatusText(ticket) {
  if (ticket.status === 'pending' || ticket.status === 'checking') return '확인중';
  if (ticket.status === 'won') return `적중 / 배당률 ${ticket.odds || 0} / **환급 ${Number(ticket.payout || 0).toLocaleString()}원**`;
  if (ticket.status === 'lost') return `실패 / **${Number(ticket.amount || 0).toLocaleString()}원을 잃었습니다**`;
  if (ticket.status === 'void') return '무효';
  return ticket.status;
}

function getPlaceBadge(place) {
  const badges = { 1: '🥇', 2: '🥈', 3: '🥉' };
  return badges[place] || `${place}착`;
}

function getStatusEmoji(ticket) {
  if (ticket.status === 'won') return '✅';
  if (ticket.status === 'lost') return '❌';
  return '';
}

function formatTicketLine(ticket, index) {
  const horses = ticket.isTest ? 'test' : `${ticket.horses.join(', ')}번`;
  const result = ticket.resultTop3?.length
    ? `\n결과: ${ticket.resultTop3.map((r) => `${getPlaceBadge(r.ord)} **${r.chulNo}번** ${r.hrName || ''}`.trim()).join(' / ')}`
    : '';
  const statusEmoji = getStatusEmoji(ticket);
  return [
    `**${index}. ${ticket.meet} ${ticket.rcNo}R ${statusEmoji}** (${formatRaceDate(ticket.rcDate)} ${formatRaceTime(ticket.schStTime)})`,
    `${ticket.betType} / ${horses} / **${Number(ticket.amount).toLocaleString()}원**`,
    `상태: ${ticketStatusText(ticket)}${result}`,
  ].join('\n');
}

function buildMyTicketsEmbeds(tickets) {
  if (tickets.length === 0) {
    return [
      new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle('내 마권')
      .setDescription('아직 발매한 마권이 없습니다.')
      .setFooter({ text: '결과가 확정된 마권은 30일 뒤 자동 삭제됩니다.' }),
    ];
  }

  const chunks = [];
  for (let index = 0; index < tickets.length; index += 5) {
    chunks.push(tickets.slice(index, index + 5));
  }

  return chunks.map((chunk, chunkIndex) => (
    new EmbedBuilder()
      .setColor(0x3d8af7)
      .setTitle(chunkIndex === 0 ? '내 마권' : `내 마권 (${chunkIndex + 1}/${chunks.length})`)
      .setDescription(chunk.map((ticket, index) => formatTicketLine(ticket, chunkIndex * 5 + index + 1)).join('\n\n'))
      .setFooter({
        text: `${chunkIndex + 1}/${chunks.length} 페이지 · 총 ${tickets.length}장 · ✅ 적중 ${tickets.filter((t) => t.status === 'won').length}장 / ❌ 실패 ${tickets.filter((t) => t.status === 'lost').length}장 / 무효 ${tickets.filter((t) => t.status === 'void').length}장`,
      })
  ));
}

function buildScheduleMessage(days, index, meetCode) {
  const safeIndex = Math.max(0, Math.min(index, days.length - 1));
  const day = days[safeIndex];
  const meet = config.MEET_BY_CODE[meetCode];
  const isToday = safeIndex === 0;
  const lines = day.races.length
    ? day.races.map((race) => {
      const closed = isPastTicketClose(day.rcDate, race.schStTime, config.ticketCloseBeforeStartMinutes);
      return `${race.rcNo}R ${formatRaceTime(race.schStTime)} / ${race.rank || race.rcName || '경주'} / ${race.rcDist || '-'}m${closed && isToday ? ' / 발매마감' : ''}`;
    })
    : ['이 날짜에는 조회된 경주가 없습니다.'];

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`경마 일정 - ${meet.name} · ${formatRaceDate(day.rcDate)}${isToday ? ' (오늘)' : ''}`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: `오늘부터 1주일 범위 · ${safeIndex + 1}/7` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_IDS.schedulePrevPrefix}${meetCode}:${safeIndex}`)
      .setLabel('이전')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safeIndex === 0),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_IDS.scheduleNextPrefix}${meetCode}:${safeIndex}`)
      .setLabel('다음')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safeIndex === days.length - 1),
  );

  return {
    embeds: [embed],
    components: [row],
  };
}

function availableRacesFor(meetCode) {
  const meet = config.MEET_BY_CODE[meetCode];
  const rcDate = todayKST();
  const races = getCachedSchedule(meetCode, rcDate) || [];

  return races
    .filter((race) => String(race.rcDate) === rcDate)
    .filter((race) => !isPastTicketClose(rcDate, race.schStTime, config.ticketCloseBeforeStartMinutes))
    .sort((a, b) => Number(a.rcNo) - Number(b.rcNo));
}

function createMeetSelectRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(CUSTOM_IDS.meetSelect)
    .setPlaceholder('경마장을 선택하세요')
    .addOptions(
      config.MEETS.map((meet) => (
        new StringSelectMenuOptionBuilder()
          .setLabel(meet.name)
          .setDescription(meet.description)
          .setValue(meet.code)
      )),
    );

  return new ActionRowBuilder().addComponents(menu);
}

function createTicketModal(meetCode, races) {
  const meet = config.MEET_BY_CODE[meetCode];
  const raceOptions = races.slice(0, 25).map((race) => {
    const time = normalizeRaceTime(race.schStTime);
    const label = `${meet.name} ${race.rcNo}R (${formatRaceTime(time)}, ${race.rank || race.rcName || '경주'}, ${race.rcDist || '-'}m)`;
    return new StringSelectMenuOptionBuilder()
      .setLabel(label.slice(0, 100))
      .setValue(`${race.rcDate}|${race.rcNo}|${time}`);
  });

  const betTypeOptions = config.BET_TYPES.map((betType) => (
    new StringSelectMenuOptionBuilder()
      .setLabel(betType.name)
      .setValue(betType.name)
      .setDescription(betType.description.slice(0, 100))
  ));

  return new ModalBuilder()
    .setTitle(`마권 발매 - ${meet.name}`)
    .setCustomId(`${CUSTOM_IDS.modalPrefix}${meetCode}`)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('경기 선택')
        .setDescription('오늘 개최되는 경기 목록입니다. 베팅할 경기를 선택해주세요.')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId(CUSTOM_IDS.raceSelect)
            .setPlaceholder('경기 선택')
            .addOptions(raceOptions),
        ),
    )
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('승식 선택')
        .setDescription('순위를 맞추는 방식을 선택해주세요.')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId(CUSTOM_IDS.betTypeSelect)
            .setPlaceholder('승식 선택')
            .addOptions(betTypeOptions),
        ),
    )
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('예상 마번 입력')
        .setDescription('승식에 맞는 우승 예상 마번을 입력해주세요. 쉼표로 구분 가능합니다.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(CUSTOM_IDS.horsesInput)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('쉼표로 마번 구분 (예: 2,4,9)')
            .setMinLength(1)
            .setMaxLength(30),
        ),
    )
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('베팅 금액 입력')
        .setDescription('베팅할 금액을 입력해주세요. 1회 최소 100원, 최대 100,000원입니다.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(CUSTOM_IDS.amountInput)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('쉼표 없이 입력')
            .setMinLength(3)
            .setMaxLength(6),
        ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder()
        .setContent('한번 발매한 마권은 수정/환불이 불가합니다. 신중하게 작성해주세요.'),
    );
}

function getModalSelectValue(interaction, customId) {
  const field = interaction.fields.getField(customId);
  return field?.values?.[0] || null;
}

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

function alertTypeLabel(alertType) {
  return Object.values(ALERT_TYPES).find((item) => item.value === alertType)?.label || alertType;
}

function buildAlertSubscriptionEmbed(meet, alertType) {
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('알림 구독 완료')
    .setDescription(`${meet.name} 경마장의 ${alertTypeLabel(alertType)} 알림을 구독했습니다.`)
    .addFields({
      name: '알림 방식',
      value: '구독한 경마장의 마권을 발매하면, 해당 경주의 변경 사항을 5분 간격으로 확인해 DM으로 알려드립니다.',
      inline: false,
    })
    .setTimestamp();
}

function buildAlertCancelMessage(meetCode, alertType) {
  const meet = config.MEET_BY_CODE[meetCode];
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('알림 구독 취소')
    .setDescription(`${meet.name} 경마장의 ${alertTypeLabel(alertType)} 알림 구독을 취소할까요?`)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_IDS.alertCancelConfirmPrefix}${meetCode}:${alertType}`)
      .setLabel('취소하기')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_IDS.alertCancelDismissPrefix}${meetCode}:${alertType}`)
      .setLabel('유지하기')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildHorseSearchMessage(horses, userId) {
  const lines = horses.slice(0, 25).map((horse, index) => (
    `**${index + 1}. ${cleanValue(horse.hrNm)}** / 마번 ${cleanValue(horse.hrNo)} / 출생일 ${formatApiDate(horse.birthDt)}`
  ));

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('말 검색 결과')
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: '상세 정보를 볼 말을 선택하세요.' });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${CUSTOM_IDS.horseInfoSelectPrefix}${userId}`)
    .setPlaceholder('말 선택')
    .addOptions(
      horses.slice(0, 25).map((horse) => (
        new StringSelectMenuOptionBuilder()
          .setLabel(cleanValue(horse.hrNm).slice(0, 100))
          .setDescription(`마번 ${cleanValue(horse.hrNo)} · ${formatApiDate(horse.birthDt)}`.slice(0, 100))
          .setValue(String(horse.hrNo))
      )),
    );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

function compactLines(lines) {
  return lines.filter(Boolean).join('\n').slice(0, 1024) || '미상';
}

function buildHorseInfoEmbed(horse) {
  const name = cleanValue(horse.hrNm);
  const englishName = cleanValue(horse.hrEngNm);
  const record = [
    `통산 ${cleanValue(horse.rcCnt)}전 ${cleanValue(horse.fstCnt)}승 / 2착 ${cleanValue(horse.sndCnt)}회 / 3착 ${cleanValue(horse.trdCnt)}회`,
    `승률 ${cleanValue(horse.winRate)}% / 복승률 ${cleanValue(horse.quinRate)}%`,
    `총 수득상금 ${formatMoney(horse.amt)}`,
  ];

  return new EmbedBuilder()
    .setColor(0x3d8af7)
    .setTitle(`🏇 ${name} 말 정보`)
    .setDescription(englishName === '미상' ? `마번 ${cleanValue(horse.hrNo)}` : `${englishName} · 마번 ${cleanValue(horse.hrNo)}`)
    .addFields(
      {
        name: '기본 정보',
        value: compactLines([
          `출생일: ${formatApiDate(horse.birthDt)} / 나이: ${cleanValue(horse.age)}세`,
          `성별: ${cleanValue(horse.sex)} / 모색: ${cleanValue(horse.color)}`,
          `산지: ${cleanValue(horse.prdCty || horse.sanji)} / 품종: ${cleanValue(horse.breed)}`,
        ]),
        inline: false,
      },
      {
        name: '성적',
        value: compactLines(record),
        inline: false,
      },
      {
        name: '관계자',
        value: compactLines([
          `마주: ${cleanValue(horse.owNm)}`,
          `조교사/관리자: ${cleanValue(horse.mgrNm || horse.fmgrNm)}`,
          `소재지: ${cleanValue(horse.poNm || horse.kraPoNm || horse.restAreaNm)}`,
        ]),
        inline: false,
      },
      {
        name: '혈통',
        value: compactLines([
          `부마: ${cleanValue(horse.fhrNm)} (${cleanValue(horse.fhrCty)})`,
          `모마: ${cleanValue(horse.mhrNm)} (${cleanValue(horse.mhrCty)})`,
          `외조부: ${cleanValue(horse.mhrFhrNm)} (${cleanValue(horse.mhrFhrCty)})`,
        ]),
        inline: false,
      },
      {
        name: '최근 정보',
        value: compactLines([
          `데뷔일: ${formatApiDate(horse.fdebutDt)}`,
          `최근 출전일: ${formatApiDate(horse.lchulDt)}`,
          `KRA 입사일: ${formatApiDate(horse.kraInDt)}`,
        ]),
        inline: false,
      },
    )
    .setTimestamp();
}

async function handleTicketCommand(interaction) {
  const meetCode = interaction.options.getString('경마장', true);
  const meet = config.MEET_BY_CODE[meetCode];

  if (!meet) {
    await interaction.reply({ content: '알 수 없는 경마장입니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  let races = availableRacesFor(meetCode);

  if (races.length === 0) {
    try {
      await loadSchedule(meet);
      races = availableRacesFor(meetCode);
    } catch (error) {
      await interaction.reply({
        content: `경주 일정을 불러오지 못했습니다: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (races.length === 0) {
    await interaction.reply({
      content: `${meet.name} 경마장에 현재 베팅 가능한 경주가 없습니다. 오늘 경주가 없거나 발매 마감 시간이 지났습니다.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(createTicketModal(meetCode, races));
}

async function handleMyTicketsCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tickets = await Ticket.find({ discordId: interaction.user.id })
    .sort({ createdAt: -1 })
    .lean();

  const embeds = buildMyTicketsEmbeds(tickets);
  
  if (embeds.length === 1) {
    await interaction.editReply({ embeds });
  } else {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CUSTOM_IDS.myTicketsPrevPrefix}0`)
        .setLabel('이전')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`${CUSTOM_IDS.myTicketsNextPrefix}0`)
        .setLabel('다음')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(embeds.length === 1),
    );
    
    await interaction.editReply({
      embeds: [embeds[0]],
      components: [row],
    });
  }
}

async function handleScheduleCommand(interaction) {
  await interaction.deferReply();

  const meetCode = interaction.options.getString('경마장', true);
  const meet = config.MEET_BY_CODE[meetCode];
  if (!meet) {
    await interaction.editReply('알 수 없는 경마장입니다.');
    return;
  }

  const days = await loadWeekSchedule(meetCode);
  const index = firstScheduleIndex(days);
  await interaction.editReply(buildScheduleMessage(days, index, meetCode));
}

async function handleAlertSubscribeCommand(interaction) {
  const meetCode = interaction.options.getString('경마장', true);
  const alertType = interaction.options.getString('알림종류', true);
  const meet = config.MEET_BY_CODE[meetCode];

  if (!meet || !Object.values(ALERT_TYPES).some((item) => item.value === alertType)) {
    await interaction.reply({ content: '알 수 없는 구독 옵션입니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  const existing = await AlertSubscription.findOne({
    discordId: interaction.user.id,
    meetCode,
    alertType,
  });

  if (existing) {
    await interaction.reply(buildAlertCancelMessage(meetCode, alertType));
    return;
  }

  await AlertSubscription.create({
    discordId: interaction.user.id,
    username: interaction.user.username,
    meetCode,
    meet: meet.name,
    alertType,
  });

  await interaction.reply({
    embeds: [buildAlertSubscriptionEmbed(meet, alertType)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleHorseInfoCommand(interaction) {
  await interaction.deferReply();

  const horseName = interaction.options.getString('말이름', true).trim();
  const horses = await kraApi.searchHorseInfoByName(horseName);

  if (horses.length === 0) {
    await interaction.editReply(`'${horseName}' 검색 결과가 없습니다.`);
    return;
  }

  if (horses.length === 1) {
    await interaction.editReply({ embeds: [buildHorseInfoEmbed(horses[0])] });
    return;
  }

  await interaction.editReply(buildHorseSearchMessage(horses, interaction.user.id));
}

async function handleMyTicketsButton(interaction) {
  const isPrev = interaction.customId.startsWith(CUSTOM_IDS.myTicketsPrevPrefix);
  const prefix = isPrev ? CUSTOM_IDS.myTicketsPrevPrefix : CUSTOM_IDS.myTicketsNextPrefix;
  const currentPageIndex = Number(interaction.customId.slice(prefix.length));
  const nextPageIndex = currentPageIndex + (isPrev ? -1 : 1);

  await interaction.deferUpdate();

  const tickets = await Ticket.find({ discordId: interaction.user.id })
    .sort({ createdAt: -1 })
    .lean();

  const embeds = buildMyTicketsEmbeds(tickets);
  
  if (nextPageIndex < 0 || nextPageIndex >= embeds.length) {
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_IDS.myTicketsPrevPrefix}${nextPageIndex}`)
      .setLabel('이전')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(nextPageIndex === 0),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_IDS.myTicketsNextPrefix}${nextPageIndex}`)
      .setLabel('다음')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(nextPageIndex === embeds.length - 1),
  );

  await interaction.editReply({
    embeds: [embeds[nextPageIndex]],
    components: [row],
  });
}

async function handleScheduleButton(interaction) {
  const isPrev = interaction.customId.startsWith(CUSTOM_IDS.schedulePrevPrefix);
  const prefix = isPrev ? CUSTOM_IDS.schedulePrevPrefix : CUSTOM_IDS.scheduleNextPrefix;
  const [meetCode, indexRaw] = interaction.customId.slice(prefix.length).split(':');
  const meet = config.MEET_BY_CODE[meetCode];

  if (!meet) {
    await interaction.reply({ content: '알 수 없는 경마장입니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();
  const currentIndex = Number(indexRaw);
  const nextIndex = currentIndex + (isPrev ? -1 : 1);
  const days = await loadWeekSchedule(meetCode);
  await interaction.editReply(buildScheduleMessage(days, nextIndex, meetCode));
}

async function handleAlertCancelButton(interaction) {
  const isConfirm = interaction.customId.startsWith(CUSTOM_IDS.alertCancelConfirmPrefix);
  const prefix = isConfirm ? CUSTOM_IDS.alertCancelConfirmPrefix : CUSTOM_IDS.alertCancelDismissPrefix;
  const [meetCode, alertType] = interaction.customId.slice(prefix.length).split(':');
  const meet = config.MEET_BY_CODE[meetCode];

  if (!meet) {
    await interaction.update({ content: '알 수 없는 경마장입니다.', embeds: [], components: [] });
    return;
  }

  if (!isConfirm) {
    await interaction.update({
      content: `${meet.name} ${alertTypeLabel(alertType)} 알림 구독을 유지합니다.`,
      embeds: [],
      components: [],
    });
    return;
  }

  const result = await AlertSubscription.deleteOne({
    discordId: interaction.user.id,
    meetCode,
    alertType,
  });

  await interaction.update({
    content: result.deletedCount > 0
      ? `${meet.name} ${alertTypeLabel(alertType)} 알림 구독을 취소했습니다.`
      : '이미 취소되었거나 찾을 수 없는 구독입니다.',
    embeds: [],
    components: [],
  });
}

async function handleHorseInfoSelect(interaction) {
  const ownerId = interaction.customId.slice(CUSTOM_IDS.horseInfoSelectPrefix.length);
  if (ownerId !== interaction.user.id) {
    await interaction.reply({ content: '이 검색 결과는 명령어를 실행한 사용자만 선택할 수 있습니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();
  const hrNo = interaction.values[0];
  const horse = await kraApi.getHorseInfoByNo(hrNo);

  if (!horse) {
    await interaction.editReply({ content: '선택한 말 정보를 다시 조회하지 못했습니다.', embeds: [], components: [] });
    return;
  }

  await interaction.editReply({
    embeds: [buildHorseInfoEmbed(horse)],
    components: [],
  });
}

async function handleMeetSelect(interaction) {
  const meetCode = interaction.values[0];
  const meet = config.MEET_BY_CODE[meetCode];
  if (!meet) {
    await interaction.update({ content: '알 수 없는 경마장입니다.', components: [] });
    return;
  }

  let races = availableRacesFor(meetCode);
  if (races.length === 0) {
    try {
      await loadSchedule(meet);
      races = availableRacesFor(meetCode);
    } catch (error) {
      await interaction.update({
        content: `경주 일정을 불러오지 못했습니다: ${error.message}`,
        components: [],
      });
      return;
    }
  }

  if (races.length === 0) {
    await interaction.update({
      content: `${meet.name} 경마장에 현재 베팅 가능한 경주가 없습니다. 오늘 경주가 없거나 발매 마감 시간이 지났습니다.`,
      components: [],
    });
    return;
  }

  await interaction.showModal(createTicketModal(meetCode, races));
}

async function handleTicketModal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const meetCode = interaction.customId.slice(CUSTOM_IDS.modalPrefix.length);
  const meet = config.MEET_BY_CODE[meetCode];
  const errors = [];

  if (!meet) {
    await interaction.editReply('알 수 없는 경마장입니다.');
    return;
  }

  const raceValue = getModalSelectValue(interaction, CUSTOM_IDS.raceSelect);
  const betType = getModalSelectValue(interaction, CUSTOM_IDS.betTypeSelect);
  const horsesRaw = interaction.fields.getTextInputValue(CUSTOM_IDS.horsesInput).trim();
  const amountRaw = interaction.fields.getTextInputValue(CUSTOM_IDS.amountInput).trim();

  if (!raceValue) errors.push('경기를 선택해주세요.');
  if (!betType || !config.BET_TYPE_BY_NAME[betType]) errors.push('승식을 선택해주세요.');

  const amount = parseAmount(amountRaw);
  if (!amount || amount < 100 || amount > 100_000) {
    errors.push('베팅 금액은 100원 이상 100,000원 이하의 숫자로 입력해주세요.');
  }

  const parsedHorses = parseHorseInput(horsesRaw);
  errors.push(...parsedHorses.formatErrors);

  const horseCountError = validateHorseCount(betType, parsedHorses.horses, parsedHorses.isTest);
  if (horseCountError) errors.push(horseCountError);

  let rcDate;
  let rcNo;
  let schStTime;
  let entries = [];
  let dusu = 0;

  if (raceValue) {
    [rcDate, rcNo, schStTime] = raceValue.split('|');
    rcNo = Number(rcNo);
    schStTime = normalizeRaceTime(schStTime);

    if (rcDate !== todayKST()) {
      errors.push('오늘 날짜의 경주만 베팅할 수 있습니다.');
    }

    if (isPastTicketClose(rcDate, schStTime, config.ticketCloseBeforeStartMinutes)) {
      errors.push(`선택한 경주는 출발 ${config.ticketCloseBeforeStartMinutes}분 전이 지나 마권 발매가 마감되었습니다.`);
    }

    try {
      entries = await kraApi.getEntryInfo(meet.apiMeet, rcDate, rcNo);
      dusu = entries.length ? Number(entries[0].dusu || entries.length) : 0;
      if (entries.length === 0 && !parsedHorses.isTest) {
        errors.push(`${meet.name} ${rcNo}경주 출전 정보를 찾을 수 없습니다.`);
      }
      errors.push(...validateEntryNumbers(parsedHorses.horses, entries, parsedHorses.isTest));
    } catch (error) {
      if (parsedHorses.isTest) {
        errors.push(`출전마 조회는 실패했지만 test 마권은 발매할 수 있습니다. 저장 후 결과 API로 정산합니다.`);
      } else {
        errors.push(`출전마 조회 실패: ${error.message}`);
      }
    }
  }

  if (errors.some((error) => !error.startsWith('출전마 조회는 실패했지만'))) {
    await interaction.editReply({
      content: `입력 내용을 확인해주세요.\n${errors.map((error) => `- ${error}`).join('\n')}`,
    });
    return;
  }

  await Ticket.deleteOne({
    discordId: interaction.user.id,
    meet: meet.name,
    rcDate,
    rcNo,
    status: 'void',
  });

  const existing = await Ticket.findOne({
    discordId: interaction.user.id,
    meet: meet.name,
    rcDate,
    rcNo,
  });

  if (existing) {
    await interaction.editReply('이미 이 경주에 발매한 마권이 있습니다. 한번 발매한 마권은 수정/환불할 수 없습니다.');
    return;
  }

  const ticket = await Ticket.create({
    discordId: interaction.user.id,
    username: interaction.user.username,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    meetCode,
    meet: meet.name,
    rcDate,
    rcNo,
    schStTime,
    betType,
    horses: parsedHorses.horses,
    amount,
    dusu,
    isTest: parsedHorses.isTest,
  });
  checkTicketAlerts(interaction.client, ticket).catch((error) => {
    console.error('[ticket alert check]', error);
  });

  const embed = new EmbedBuilder()
    .setColor(0x3d8af7)
    .setTitle('마권 발매 완료')
    .setDescription('경주 출발 5분 후부터 결과를 확인해 DM으로 알려드립니다.')
    .addFields(
      { name: '경마장', value: ticket.meet, inline: true },
      { name: '경주', value: `${ticket.rcNo}경주 (${formatRaceDate(ticket.rcDate)} ${formatRaceTime(ticket.schStTime)})`, inline: true },
      { name: '승식', value: ticket.betType, inline: true },
      { name: '마번', value: ticket.isTest ? 'test' : `${ticket.horses.join(', ')}번`, inline: true },
      { name: '베팅 금액', value: `${ticket.amount.toLocaleString()}원`, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function onInteractionCreate(interaction) {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === '마권발매') {
      await handleTicketCommand(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === '내마권') {
      await handleMyTicketsCommand(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === '경마일정') {
      await handleScheduleCommand(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === '알림구독') {
      await handleAlertSubscribeCommand(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === '말정보') {
      await handleHorseInfoCommand(interaction);
      return;
    }

    if (interaction.isButton() && (
      interaction.customId.startsWith(CUSTOM_IDS.schedulePrevPrefix)
      || interaction.customId.startsWith(CUSTOM_IDS.scheduleNextPrefix)
    )) {
      await handleScheduleButton(interaction);
      return;
    }

    if (interaction.isButton() && (
      interaction.customId.startsWith(CUSTOM_IDS.myTicketsPrevPrefix)
      || interaction.customId.startsWith(CUSTOM_IDS.myTicketsNextPrefix)
    )) {
      await handleMyTicketsButton(interaction);
      return;
    }

    if (interaction.isButton() && (
      interaction.customId.startsWith(CUSTOM_IDS.alertCancelConfirmPrefix)
      || interaction.customId.startsWith(CUSTOM_IDS.alertCancelDismissPrefix)
    )) {
      await handleAlertCancelButton(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === CUSTOM_IDS.meetSelect) {
      await handleMeetSelect(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(CUSTOM_IDS.horseInfoSelectPrefix)) {
      await handleHorseInfoSelect(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(CUSTOM_IDS.modalPrefix)) {
      await handleTicketModal(interaction);
    }
  } catch (error) {
    console.error('[interaction]', error);
    const payload = {
      content: `처리 중 오류가 발생했습니다: ${error.message}`,
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
}

async function main() {
  if (!config.discordToken || !config.mongoUri) {
    throw new Error('DISCORD_TOKEN, MONGODB_URI 환경변수가 필요합니다.');
  }

  await warmScheduleCache();
  setInterval(() => warmScheduleCache().catch(console.error), 4 * 60_000);

  startKeepAlive({
    port: config.port,
    url: config.keepAliveUrl,
    intervalMs: config.keepAliveIntervalMs,
  });

  await mongoose.connect(config.mongoUri);
  await Ticket.createIndexes();
  await AlertSubscription.createIndexes();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once('clientReady', () => {
    console.log(`${client.user.tag} 로그인 완료`);
    startRacePresenceWorker(client);
    startSettlementWorker(client);
    startAlertWorker(client);
  });

  client.on('interactionCreate', onInteractionCreate);

  await client.login(config.discordToken);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  getCommandData,
  handleTicketCommand,
  handleMyTicketsCommand,
  handleScheduleCommand,
  handleAlertSubscribeCommand,
  handleHorseInfoCommand,
  handleMeetSelect,
  handleTicketModal,
  getNextPresenceRaces,
  formatRacePresenceMessage,
  startRacePresenceWorker,
};

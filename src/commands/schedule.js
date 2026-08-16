const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const dayjs = require('dayjs');
const config = require('../config');
const kraApi = require('../services/kraApi');
const CUSTOM_IDS = require('../utils/customIds');
const {
  KST_ZONE,
  formatRaceDate,
  formatRaceTime,
  isPastTicketClose,
  normalizeRaceTime,
  todayKST,
} = require('../utils/time');

const scheduleCache = new Map();

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

function getCommandData() {
  return [
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
  ];
}

module.exports = {
  getCommandData,
  getCachedSchedule,
  loadSchedule,
  warmScheduleCache,
  handleScheduleCommand,
  handleScheduleButton,
};

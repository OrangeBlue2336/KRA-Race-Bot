const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const config = require('../config');
const kraApi = require('../services/kraApi');
const CUSTOM_IDS = require('../utils/customIds');
const { formatRaceDate, todayKST } = require('../utils/time');
const { cleanValue, formatMoney, compactLines } = require('../utils/raceFormat');

function normalizeCommandDate(value) {
  const rcDate = String(value || todayKST()).trim();
  return /^\d{8}$/.test(rcDate) ? rcDate : null;
}

function entryHorseName(entry) {
  return cleanValue(entry.hrName || entry.hrNm || entry.horseName);
}

function entryJockeyName(entry) {
  return cleanValue(entry.jkName || entry.jkNm || entry.jockeyName || entry.jk);
}

function buildRaceInfoEmbed(meet, rcDate, rcNo, entries, cancels) {
  const cancelNumbers = new Set(cancels.map((item) => String(item.chulNo)));
  const cancelByNumber = new Map(cancels.map((item) => [String(item.chulNo), item]));
  const lines = entries.map((entry) => {
    const chulNo = cleanValue(entry.chulNo);
    const isCanceled = cancelNumbers.has(String(entry.chulNo));
    const cancel = cancelByNumber.get(String(entry.chulNo));
    const parts = [
      `${isCanceled ? '🚫 ' : ''}**${chulNo}번 ${entryHorseName(entry)}**`,
      `기수: ${entryJockeyName(entry)}`,
      entry.trName || entry.trNm ? `조교사: ${cleanValue(entry.trName || entry.trNm)}` : '',
      entry.wgBudam || entry.budam ? `부담중량: ${cleanValue(entry.wgBudam || entry.budam)}kg` : '',
      isCanceled && cancel?.reason ? `취소사유: ${cleanValue(cancel.reason)}` : '',
    ].filter(Boolean);
    return parts.join(' / ');
  });

  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`${meet.name} ${rcNo}경주 출전표`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .addFields(
      { name: '날짜', value: formatRaceDate(rcDate), inline: true },
      { name: '출전마', value: `${entries.length}두`, inline: true },
      { name: '출전 취소', value: cancels.length ? `🚫 ${cancels.length}두` : '없음', inline: true },
    )
    .setFooter({ text: '🚫 표시는 출전 취소된 말입니다.' })
    .setTimestamp();
}

function formatTrackCondition(trackInfo) {
  if (!trackInfo) return '주로 정보 없음';
  return `날씨: ${cleanValue(trackInfo.weather)} · 경주로 상태: ${cleanValue(trackInfo.track)} · 함수율: ${cleanValue(trackInfo.waterPercent)}%`;
}

async function getDisplayedTrackInfo(meet, rcDate, rcNo) {
  // KRA 주로 API는 당일 경주별 값이 실시간으로 갱신되지 않는다. 당일에는
  // 이미 종료된 가장 최근 경주의 값을 표시하고, 1경주는 해당 경주 값을 사용한다.
  const requestedRaceNo = Number(rcNo);
  const trackRaceNo = String(rcDate) === todayKST() && requestedRaceNo > 1
    ? requestedRaceNo - 1
    : requestedRaceNo;
  return kraApi.getTrackInfo(meet.apiMeet, rcDate, trackRaceNo);
}

function raceAnalysisContext(userId, meetCode, rcDate, rcNo, index) {
  return `${userId}|${meetCode}|${rcDate}|${rcNo}|${index}`;
}

function parseRaceAnalysisContext(value) {
  const [userId, meetCode, rcDate, rcNo, index] = String(value).split('|');
  return { userId, meetCode, rcDate, rcNo: Number(rcNo), index: Number(index) };
}

function raceAnalysisComponents(entries, context) {
  const { userId, meetCode, rcDate, rcNo, index } = context;
  const makeContext = (nextIndex) => raceAnalysisContext(userId, meetCode, rcDate, rcNo, nextIndex);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${CUSTOM_IDS.raceAnalysisSelectPrefix}${makeContext(index)}`)
    .setPlaceholder('경주마 분석: 출전마를 선택하세요')
    .addOptions(entries.slice(0, 25).map((entry) => (
      new StringSelectMenuOptionBuilder()
        .setLabel(`${entry.chulNo}번 ${entryHorseName(entry)}`.slice(0, 100))
        .setValue(String(entry.hrNo))
        .setDefault(entries[index] && String(entries[index].hrNo) === String(entry.hrNo))
    )));
  return [
    new ActionRowBuilder().addComponents(menu),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${CUSTOM_IDS.raceAnalysisPrevPrefix}${makeContext(Math.max(index - 1, 0))}`).setLabel('◀ 이전 말').setStyle(ButtonStyle.Secondary).setDisabled(index <= 0),
      new ButtonBuilder().setCustomId(`${CUSTOM_IDS.raceAnalysisNextPrefix}${makeContext(Math.min(index + 1, entries.length - 1))}`).setLabel('다음 말 ▶').setStyle(ButtonStyle.Secondary).setDisabled(index >= entries.length - 1),
    ),
  ];
}

function percentage(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number}%` : '미상';
}

function buildRaceAnalysisEmbed(meet, rcDate, rcNo, entry, horse, jockey, trainer, weight, trackInfo) {
  const weightValue = Number(weight?.wgHr);
  const difference = Number(weight?.wgHrDiff);
  const bodyWeight = Number.isFinite(weightValue) && weightValue > 0 ? `${weightValue}kg` : '미상';
  const weightDiff = Number.isFinite(difference) ? `${difference > 0 ? '+' : ''}${difference}kg` : '미상';
  const career = [
    `통산 ${cleanValue(horse?.rcCnt)}전 ${cleanValue(horse?.fstCnt)}승 / 2착 ${cleanValue(horse?.sndCnt)}회 / 3착 ${cleanValue(horse?.trdCnt)}회`,
    `승률 ${percentage(horse?.winRate)} / 복승률 ${percentage(horse?.quinRate)}`,
    `통산 상금 ${formatMoney(horse?.amt)}`,
  ];
  return new EmbedBuilder()
    .setColor(0x8e44ad)
    .setTitle(`🏇 ${entry.chulNo}번 ${entryHorseName(entry)} 분석`)
    .setDescription(`${meet.name} ${rcNo}경주 · ${formatRaceDate(rcDate)} · ${cleanValue(entry.sex)} ${cleanValue(entry.age)}세`)
    .addFields(
      { name: '마필 통산 성적', value: compactLines(career), inline: false },
      { name: '기수 정보', value: compactLines([`${entryJockeyName(entry)} (${cleanValue(entry.jkNo)})`, `최근 1년: ${cleanValue(jockey?.rcCntY)}전 ${cleanValue(jockey?.ord1CntY)}승 · 승률 ${percentage(jockey?.winRateY)}`]), inline: true },
      { name: '조교사 정보', value: compactLines([`${cleanValue(entry.trName || entry.trNm)} (${cleanValue(entry.trNo)})`, `최근 1년: ${cleanValue(trainer?.rcCntY)}전 ${cleanValue(trainer?.ord1CntY)}승 · 승률 ${percentage(trainer?.winRateY)}`]), inline: true },
      { name: '마체중', value: `${bodyWeight} (직전 대비 ${weightDiff})`, inline: true },
    )
    .setFooter({ text: formatTrackCondition(trackInfo) })
    .setTimestamp();
}

async function buildRaceAnalysisMessage(context) {
  const meet = config.MEET_BY_CODE[context.meetCode];
  const entries = await kraApi.getEntryInfo(meet.apiMeet, context.rcDate, context.rcNo);
  const index = Math.min(Math.max(context.index, 0), entries.length - 1);
  const entry = entries[index];
  if (!entry) return { content: '출전마 정보를 다시 조회하지 못했습니다.', embeds: [], components: [] };
  const [horse, jockey, trainer, weight, trackInfo] = await Promise.all([
    kraApi.getHorseInfoByNo(entry.hrNo),
    kraApi.getJockeyResult(meet.apiMeet, entry.jkNo),
    kraApi.getTrainerInfo(meet.apiMeet, entry.trNo),
    kraApi.getEntryHorseWeightInfo(meet.apiMeet, context.rcDate, entry.hrNo),
    getDisplayedTrackInfo(meet, context.rcDate, context.rcNo),
  ]);
  const normalizedContext = { ...context, index };
  return { embeds: [buildRaceAnalysisEmbed(meet, context.rcDate, context.rcNo, entry, horse, jockey, trainer, weight, trackInfo)], components: raceAnalysisComponents(entries, normalizedContext) };
}

async function handleRaceInfoCommand(interaction) {
  await interaction.deferReply();

  const meetCode = interaction.options.getString('경마장', true);
  const rcNo = interaction.options.getInteger('경주번호', true);
  const rcDate = normalizeCommandDate(interaction.options.getString('날짜') || todayKST());
  const meet = config.MEET_BY_CODE[meetCode];

  if (!meet) {
    await interaction.editReply('알 수 없는 경마장입니다.');
    return;
  }

  if (!rcDate) {
    await interaction.editReply('날짜는 YYYYMMDD 형식으로 입력해주세요. 예: 20260712');
    return;
  }

  const [entries, cancels, trackInfo] = await Promise.all([
    kraApi.getEntryInfo(meet.apiMeet, rcDate, rcNo),
    kraApi.getRaceHorseCancels(meet.apiMeet, rcDate, rcNo),
    getDisplayedTrackInfo(meet, rcDate, rcNo),
  ]);

  if (entries.length === 0) {
    await interaction.editReply(`${formatRaceDate(rcDate)} ${meet.name} ${rcNo}경주의 출전표를 찾지 못했습니다.`);
    return;
  }

  const embed = buildRaceInfoEmbed(meet, rcDate, rcNo, entries, cancels);
  embed.addFields({ name: '주로 상태', value: formatTrackCondition(trackInfo), inline: false });
  const context = { userId: interaction.user.id, meetCode, rcDate, rcNo, index: 0 };
  await interaction.editReply({ embeds: [embed], components: raceAnalysisComponents(entries, context) });
}

async function handleRaceAnalysisInteraction(interaction) {
  const prefix = interaction.isStringSelectMenu()
    ? CUSTOM_IDS.raceAnalysisSelectPrefix
    : interaction.customId.startsWith(CUSTOM_IDS.raceAnalysisPrevPrefix)
      ? CUSTOM_IDS.raceAnalysisPrevPrefix
      : CUSTOM_IDS.raceAnalysisNextPrefix;
  const context = parseRaceAnalysisContext(interaction.customId.slice(prefix.length));
  if (context.userId !== interaction.user.id) {
    await interaction.reply({ content: '이 경주 분석은 명령어를 실행한 사용자만 조작할 수 있습니다.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.isStringSelectMenu()) {
    const meet = config.MEET_BY_CODE[context.meetCode];
    const entries = await kraApi.getEntryInfo(meet.apiMeet, context.rcDate, context.rcNo);
    const selectedIndex = entries.findIndex((entry) => String(entry.hrNo) === String(interaction.values[0]));
    if (selectedIndex === -1) {
      await interaction.reply({ content: '선택한 출전마 정보를 다시 조회하지 못했습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    context.index = selectedIndex;
  }
  await interaction.deferUpdate();
  await interaction.editReply(await buildRaceAnalysisMessage(context));
}

function getCommandData() {
  return [
    new SlashCommandBuilder()
      .setName('경주정보')
      .setDescription('지정한 경주의 출전마 정보 및 분석 자료를 확인합니다.')
      .addStringOption((option) => option
        .setName('경마장')
        .setDescription('출전표를 확인할 경마장을 선택합니다.')
        .setRequired(true)
        .addChoices(
          ...config.MEETS.map((meet) => ({ name: meet.name, value: meet.code })),
        ))
      .addIntegerOption((option) => option
        .setName('경주번호')
        .setDescription('확인할 경주 번호를 입력합니다.')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(20))
      .addStringOption((option) => option
        .setName('날짜')
        .setDescription('조회할 날짜를 YYYYMMDD 형식으로 입력합니다. 비우면 오늘로 조회합니다.')
        .setRequired(false)
        .setMinLength(8)
        .setMaxLength(8)),
  ];
}

module.exports = {
  getCommandData,
  handleRaceInfoCommand,
  handleRaceAnalysisInteraction,
};

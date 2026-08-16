const {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const kraApi = require('../services/kraApi');
const CUSTOM_IDS = require('../utils/customIds');
const { cleanValue, formatApiDate, formatMoney, compactLines } = require('../utils/raceFormat');

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

function getCommandData() {
  return [
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

module.exports = {
  getCommandData,
  handleHorseInfoCommand,
  handleHorseInfoSelect,
};

const {
  ActionRowBuilder,
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
const Ticket = require('./models/Ticket');
const kraApi = require('./services/kraApi');
const { startSettlementWorker } = require('./services/settlementService');
const {
  parseAmount,
  parseHorseInput,
  validateEntryNumbers,
  validateHorseCount,
} = require('./utils/betting');
const {
  formatRaceDate,
  formatRaceTime,
  isPastTicketClose,
  normalizeRaceTime,
  todayKST,
} = require('./utils/time');

const CUSTOM_IDS = {
  meetSelect: 'ticket:meet',
  raceSelect: 'ticket:race',
  betTypeSelect: 'ticket:bet_type',
  horsesInput: 'ticket:horses',
  amountInput: 'ticket:amount',
  modalPrefix: 'ticket:modal:',
};

const scheduleCache = new Map();

function getCommandData() {
  return new SlashCommandBuilder()
    .setName('마권발매')
    .setDescription('실제 경마 결과와 연동되는 가상 마권을 발매합니다.');
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

async function loadSchedule(meet) {
  const rcDate = todayKST();
  const races = await kraApi.getRaceSchedule(meet.apiMeet, rcDate);
  scheduleCache.set(cacheKey(meet.code, rcDate), {
    races,
    expiresAt: Date.now() + 60_000,
  });
  return races;
}

async function warmScheduleCache() {
  await Promise.allSettled(config.MEETS.map(loadSchedule));
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

async function handleTicketCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await warmScheduleCache();

  await interaction.editReply({
    content: '**마권 발매**\n베팅할 경마장을 선택하세요.',
    components: [createMeetSelectRow()],
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

  const embed = new EmbedBuilder()
    .setColor(0x3d8af7)
    .setTitle('마권 발매 완료')
    .setDescription('경주 출발 10분 후부터 결과를 확인해 DM으로 알려드립니다.')
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

    if (interaction.isStringSelectMenu() && interaction.customId === CUSTOM_IDS.meetSelect) {
      await handleMeetSelect(interaction);
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

  await mongoose.connect(config.mongoUri);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once('clientReady', () => {
    console.log(`${client.user.tag} 로그인 완료`);
    startSettlementWorker(client);
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
  handleMeetSelect,
  handleTicketModal,
};

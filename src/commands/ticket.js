const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
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
const config = require('../config');
const kraApi = require('../services/kraApi');
const Ticket = require('../models/Ticket');
const UserMoney = require('../models/UserMoney');
const CUSTOM_IDS = require('../utils/customIds');
const { moneyText, isDeveloper } = require('../utils/common');
const {
  parseAmount,
  parseHorseInput,
  validateEntryNumbers,
  validateHorseCount,
} = require('../utils/betting');
const {
  formatRaceDate,
  formatRaceTime,
  isPastTicketClose,
  normalizeRaceTime,
  todayKST,
} = require('../utils/time');
const { checkTicketAlerts } = require('../services/alertService');
const { getCachedSchedule, loadSchedule } = require('./schedule');

function ticketConfirmationEmbed(ticket, nextRaceBetAmount) {
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('마권 발매 최종 확인')
    .setDescription('확인을 누르면 베팅 금액이 차감되고 마권이 발매됩니다. 취소하면 발매되지 않습니다.')
    .addFields(
      { name: '경마장', value: ticket.meet, inline: true },
      { name: '경주', value: `${ticket.rcNo}경주 (${formatRaceDate(ticket.rcDate)} ${formatRaceTime(ticket.schStTime)})`, inline: true },
      { name: '승식', value: ticket.betType, inline: true },
      { name: '마번', value: ticket.isTest ? 'test' : `${ticket.horses.join(', ')}번`, inline: true },
      { name: '베팅 금액', value: moneyText(ticket.amount), inline: true },
      { name: '이 경주 누적 베팅', value: `${moneyText(nextRaceBetAmount)} / ${moneyText(config.maxRaceBetAmount)}`, inline: true },
    )
    .setTimestamp();
}

function ticketConfirmationRow(ticketId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${CUSTOM_IDS.ticketConfirmPrefix}${ticketId}`).setLabel('확인').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${CUSTOM_IDS.ticketCancelPrefix}${ticketId}`).setLabel('취소').setStyle(ButtonStyle.Secondary),
  );
}

function ticketStatusText(ticket) {
  if (ticket.status === 'pending' || ticket.status === 'checking') return '확인중';
  if (ticket.status === 'won') return `적중 / 배당률 ${ticket.odds || 0} / **${Number(ticket.payout || 0).toLocaleString()}머니 환급**`;
  if (ticket.status === 'lost') return `실패 / **${Number(ticket.amount || 0).toLocaleString()}머니를 잃었습니다**`;
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
    `${ticket.betType} / ${horses} / **${Number(ticket.amount).toLocaleString()}머니**`,
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
        .setDescription('베팅할 금액을 입력해주세요. 한 경주당 총 100,000머니까지 추가 발매할 수 있습니다.')
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
        .setContent('마권은 같은 경주에 여러 장 발매할 수 있지만, 발매 후 수정/환불은 불가합니다.'),
    );
}

function getModalSelectValue(interaction, customId) {
  const field = interaction.fields.getField(customId);
  return field?.values?.[0] || null;
}

async function sumUserRaceBetAmount(discordId, meetCode, rcDate, rcNo) {
  const [result] = await Ticket.aggregate([
    {
      $match: {
        discordId,
        meetCode,
        rcDate,
        rcNo,
        status: { $in: ['pending', 'checking', 'won', 'lost'] },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' },
      },
    },
  ]);

  return result?.total || 0;
}

async function handleTicketCommand(interaction) {
  const account = await UserMoney.findOne({ discordId: interaction.user.id }).lean();
  if (!account) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('가입이 필요합니다').setDescription('마권을 발매하려면 먼저 `/가입` 명령어를 실행해주세요.')],
    });
    return;
  }

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
    errors.push('베팅 금액은 100머니 이상 100,000머니 이하의 숫자로 입력해주세요.');
  }

  const parsedHorses = parseHorseInput(horsesRaw);
  errors.push(...parsedHorses.formatErrors);

  if (parsedHorses.isTest && !isDeveloper(interaction.user.id)) {
    errors.push('test 마권은 개발자만 발매할 수 있습니다.');
  }

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

  const currentRaceBetAmount = await sumUserRaceBetAmount(interaction.user.id, meetCode, rcDate, rcNo);
  const nextRaceBetAmount = currentRaceBetAmount + amount;

  if (nextRaceBetAmount > config.maxRaceBetAmount) {
    const remainingAmount = Math.max(config.maxRaceBetAmount - currentRaceBetAmount, 0);
    await interaction.editReply(
      `${meet.name} ${rcNo}경주에 이미 ${currentRaceBetAmount.toLocaleString()}머니를 베팅했습니다. `
      + `한 경주당 베팅 한도는 ${config.maxRaceBetAmount.toLocaleString()}머니이므로 `
      + `추가 발매 가능 금액은 ${remainingAmount.toLocaleString()}머니입니다.`,
    );
    return;
  }

  if (!parsedHorses.isTest) {
    const account = await UserMoney.findOne({ discordId: interaction.user.id }).lean();
    if (!account) {
      await interaction.editReply('마권을 발매하려면 먼저 `/가입` 명령어를 실행해주세요.');
      return;
    }
    if (account.balance < amount) {
      await interaction.editReply(`보유 머니가 부족합니다. 현재 보유 머니는 ${moneyText(account.balance)}입니다.`);
      return;
    }
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
    status: 'draft',
  });
  await interaction.editReply({
    embeds: [ticketConfirmationEmbed(ticket, nextRaceBetAmount)],
    components: [ticketConfirmationRow(ticket.id)],
  });
  return;

  checkTicketAlerts(interaction.client, ticket).catch((error) => {
    console.error('[ticket alert check]', error);
  });

  const embed = new EmbedBuilder()
    .setColor(0x3d8af7)
    .setTitle('마권 발매 완료')
    .setDescription('같은 경주에 10만머니까지 추가 발매할 수 있습니다. 경주 출발 5분 후부터 결과를 확인해 DM으로 알려드립니다.')
    .addFields(
      { name: '경마장', value: ticket.meet, inline: true },
      { name: '경주', value: `${ticket.rcNo}경주 (${formatRaceDate(ticket.rcDate)} ${formatRaceTime(ticket.schStTime)})`, inline: true },
      { name: '승식', value: ticket.betType, inline: true },
      { name: '마번', value: ticket.isTest ? 'test' : `${ticket.horses.join(', ')}번`, inline: true },
      { name: '베팅 금액', value: `${ticket.amount.toLocaleString()}머니`, inline: true },
      { name: '이 경주 누적 베팅', value: `${nextRaceBetAmount.toLocaleString()}머니 / ${config.maxRaceBetAmount.toLocaleString()}머니`, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleTicketConfirmation(interaction, confirmed) {
  const prefix = confirmed ? CUSTOM_IDS.ticketConfirmPrefix : CUSTOM_IDS.ticketCancelPrefix;
  const ticketId = interaction.customId.slice(prefix.length);
  const ticket = await Ticket.findOne({ _id: ticketId, discordId: interaction.user.id, status: 'draft' });
  if (!ticket) {
    await interaction.reply({ content: '이미 처리되었거나 만료된 발매 확인입니다.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!confirmed) {
    await Ticket.deleteOne({ _id: ticket._id, status: 'draft' });
    await interaction.update({ content: '마권 발매를 취소했습니다.', embeds: [], components: [] });
    return;
  }
  if (isPastTicketClose(ticket.rcDate, ticket.schStTime, config.ticketCloseBeforeStartMinutes)) {
    await Ticket.deleteOne({ _id: ticket._id, status: 'draft' });
    await interaction.update({ content: '발매 마감 시간이 지나 마권을 발매할 수 없습니다.', embeds: [], components: [] });
    return;
  }
  const lockedTicket = await Ticket.findOneAndUpdate(
    { _id: ticket._id, discordId: interaction.user.id, status: 'draft' },
    { $set: { status: 'checking' } },
    { new: true },
  );
  if (!lockedTicket) {
    await interaction.reply({ content: '이미 처리된 발매 확인입니다.', flags: MessageFlags.Ephemeral });
    return;
  }
  const existingAmount = (await sumUserRaceBetAmount(ticket.discordId, ticket.meetCode, ticket.rcDate, ticket.rcNo)) - ticket.amount;
  if (existingAmount + ticket.amount > config.maxRaceBetAmount) {
    await Ticket.updateOne({ _id: ticket._id, status: 'checking' }, { $set: { status: 'draft' } });
    await interaction.update({ content: '같은 경주의 베팅 한도를 초과하여 발매할 수 없습니다.', embeds: [], components: [ticketConfirmationRow(ticket.id)] });
    return;
  }
  let account = null;
  if (!ticket.isTest) {
    account = await UserMoney.findOneAndUpdate(
      { discordId: ticket.discordId, balance: { $gte: ticket.amount } },
      { $inc: { balance: -ticket.amount }, $set: { username: interaction.user.username } },
      { new: true },
    );
    if (!account) {
      await Ticket.updateOne({ _id: ticket._id, status: 'checking' }, { $set: { status: 'draft' } });
      await interaction.update({ content: '보유 머니가 부족하여 발매할 수 없습니다.', embeds: [], components: [ticketConfirmationRow(ticket.id)] });
      return;
    }
  }
  const issued = await Ticket.findOneAndUpdate({ _id: ticket._id, status: 'checking' }, { $set: { status: 'pending' } }, { new: true });
  if (!issued) {
    if (account) await UserMoney.updateOne({ discordId: ticket.discordId }, { $inc: { balance: ticket.amount } });
    throw new Error('마권 발매 상태를 확정하지 못했습니다.');
  }
  checkTicketAlerts(interaction.client, issued).catch((error) => console.error('[ticket alert check]', error));
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('마권 발매 완료').setDescription(ticket.isTest ? '테스트 마권이 발매되었습니다. 머니에는 영향을 주지 않습니다.' : `마권이 발매되어 ${moneyText(ticket.amount)}가 차감되었습니다.`).addFields({ name: '현재 보유 머니', value: ticket.isTest ? '변동 없음' : moneyText(account.balance) })],
    components: [],
  });
}

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
      .setDescription('지금까지 발매한 내 마권 내역을 확인합니다.'),
  ];
}

module.exports = {
  getCommandData,
  handleTicketCommand,
  handleMyTicketsCommand,
  handleMyTicketsButton,
  handleMeetSelect,
  handleTicketModal,
  handleTicketConfirmation,
};

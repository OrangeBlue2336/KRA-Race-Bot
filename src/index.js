const {
  ActivityType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const mongoose = require('mongoose');
const config = require('./config');
const AlertSubscription = require('./models/AlertSubscription');
const Ticket = require('./models/Ticket');
const UserMoney = require('./models/UserMoney');
const { startAlertWorker } = require('./services/alertService');
const { startKeepAlive } = require('./services/keepAliveServer');
const { startSettlementWorker } = require('./services/settlementService');
const { startStockPriceWorker } = require('./services/stockPriceService');
const { nowKST, todayKST } = require('./utils/time');
const CUSTOM_IDS = require('./utils/customIds');
const { RESPONSIBLE_GAMBLING_STATUS, isDeveloper, moneyText, displayUsername } = require('./utils/common');
const { handleGambleCommand, handleGamblePrefixCommand } = require('./games/gamble');
const { handleBlackjackCommand, handleBlackjackAction } = require('./games/blackjack');
const { handleShoeGameCommand, handleShoeGameAction } = require('./games/shoeGame');
const { handleGiftCommand, handleGiftConfirmation } = require('./games/gift');
const { handleMoneyGiveCommand } = require('./games/moneyGive');
const {
  getCommandData: getStockCommandData,
  handleStockQuoteCommand,
  handleStockQuoteSelect,
  handleStockBuyCommand,
  handleStockSellCommand,
  handleMyStocksCommand,
} = require('./games/stock');
const Stock = require('./models/Stock');
const StockHolding = require('./models/StockHolding');
const {
  getCommandData: getTicketCommandData,
  handleTicketCommand,
  handleMyTicketsCommand,
  handleMyTicketsButton,
  handleTicketModal,
  handleTicketConfirmation,
} = require('./commands/ticket');
const {
  getCommandData: getScheduleCommandData,
  warmScheduleCache,
  handleScheduleCommand,
  handleScheduleButton,
} = require('./commands/schedule');
const {
  getCommandData: getRaceInfoCommandData,
  handleRaceInfoCommand,
  handleRaceAnalysisInteraction,
} = require('./commands/raceInfo');
const {
  getCommandData: getAlertCommandData,
  handleAlertSubscribeCommand,
  handleAlertCancelButton,
} = require('./commands/alert');
const {
  getCommandData: getHorseInfoCommandData,
  handleHorseInfoCommand,
  handleHorseInfoSelect,
} = require('./commands/horseInfo');

function setResponsibleGamblingPresence(client) {
  client.user.setPresence({
    activities: [{ name: RESPONSIBLE_GAMBLING_STATUS, type: ActivityType.Watching }],
    status: 'online',
  });
}

function getCommandData() {
  const [ticketIssueCommand, myTicketsCommand] = getTicketCommandData();
  return [
    ticketIssueCommand,
    new SlashCommandBuilder()
      .setName('가입')
      .setDescription('머니 시스템에 가입하고 가입 보너스를 받습니다.'),
    new SlashCommandBuilder()
      .setName('데일리')
      .setDescription('하루 한 번 데일리 머니를 받습니다.'),
    new SlashCommandBuilder()
      .setName('지갑')
      .setDescription('현재 보유 머니를 확인합니다.'),
    new SlashCommandBuilder()
      .setName('리더보드')
      .setDescription('보유 머니 순위를 확인합니다.')
      .addStringOption((option) => option
        .setName('범위')
        .setDescription('서버 또는 전체 순위를 선택합니다.')
        .setRequired(true)
        .addChoices({ name: '서버', value: 'server' }, { name: '글로벌', value: 'global' })),
    myTicketsCommand,
    ...getScheduleCommandData(),
    ...getRaceInfoCommandData(),
    ...getAlertCommandData(),
    ...getHorseInfoCommandData(),
    ...getStockCommandData(),
    new SlashCommandBuilder()
      .setName('도박')
      .setDescription('도박을 통해 머니를 얻거나 잃습니다. (3초 쿨다운, 성공 확률 50%)')
      .addIntegerOption((option) => option
        .setName('머니')
        .setDescription('도박에 걸 머니를 입력합니다.')
        .setRequired(true)
        .setMinValue(1)),
    new SlashCommandBuilder()
      .setName('블랙잭')
      .setDescription('딜러를 상대로 블랙잭을 플레이합니다.')
      .addStringOption((option) => option
        .setName('머니')
        .setDescription('베팅할 머니 또는 올인을 입력합니다.')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(20)),
    new SlashCommandBuilder()
      .setName('편자강화')
      .setDescription('편자를 강화하여 머니를 얻습니다.')
      .addIntegerOption((option) => option
        .setName('베팅금액')
        .setDescription(`${config.shoeGameMinAmount.toLocaleString()}~${config.shoeGameMaxAmount.toLocaleString()}머니를 베팅합니다.`)
        .setRequired(true)
        .setMinValue(config.shoeGameMinAmount)
        .setMaxValue(config.shoeGameMaxAmount)),
    new SlashCommandBuilder()
      .setName('돈내놔')
      .setDescription(`즉시 ${config.moneyGiveMinAmount.toLocaleString()}~${config.moneyGiveMaxAmount.toLocaleString()}머니를 무작위로 받습니다. (5분 쿨다운)`),
    new SlashCommandBuilder()
      .setName('선물')
      .setDescription('보유한 머니를 다른 사용자에게 선물합니다.')
      .addIntegerOption((option) => option
        .setName('머니')
        .setDescription('선물할 머니 수량을 입력합니다.')
        .setRequired(true)
        .setMinValue(1))
      .addUserOption((option) => option
        .setName('대상')
        .setDescription('머니를 선물할 서버 멤버를 선택합니다.')
        .setRequired(true)),
  ];
}

async function handleSignupCommand(interaction) {
  const existing = await UserMoney.findOne({ discordId: interaction.user.id });
  if (existing) {
    if (interaction.guildId) await UserMoney.updateOne({ _id: existing._id }, { $addToSet: { guildIds: interaction.guildId }, $set: { username: interaction.user.username } });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('이미 가입되어 있습니다').setDescription(`현재 보유 머니는 **${moneyText(existing.balance)}**입니다.`)]});
    return;
  }

  try {
    const account = await UserMoney.create({
      discordId: interaction.user.id,
      username: interaction.user.username,
      balance: config.signupBonusMoney,
      guildIds: interaction.guildId ? [interaction.guildId] : [],
    });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('✅ 가입 완료').setDescription(`가입 기념으로 **${moneyText(config.signupBonusMoney)}**를 지급했습니다.`).addFields({ name: '현재 보유 머니', value: moneyText(account.balance) })]});
  } catch (error) {
    if (error.code !== 11000) throw error;
    await interaction.reply({ content: '이미 가입되어 있습니다.'});
  }
}

async function handleDailyCommand(interaction) {
  const account = await UserMoney.findOne({ discordId: interaction.user.id }).lean();
  if (!account) {
    await interaction.reply({ content: '데일리 머니를 받으려면 먼저 `/가입` 명령어를 실행해주세요.'});
    return;
  }
  const today = todayKST();
  if (account.lastDailyDate === today) {
    await interaction.reply({ content: '오늘의 데일리 머니는 이미 받았습니다. 다음 지급은 자정 이후입니다.'});
    return;
  }
  const yesterday = nowKST().subtract(1, 'day').format('YYYYMMDD');
  // dailyStreak은 출석한 총 일수로 저장한다. 첫 출석은 보너스 0%이며,
  // 그 뒤 5일 연속 출석 시 50%가 되므로 최대 6일까지 기록해야 한다.
  const streak = account.lastDailyDate === yesterday ? Math.min(Number(account.dailyStreak || 0) + 1, 6) : 1;
  const bonusPercent = Math.min((streak - 1) * 10, 50);
  const amount = Math.floor(config.dailyBaseMoney * (1 + bonusPercent / 100));
  const updated = await UserMoney.findOneAndUpdate(
    { _id: account._id, lastDailyDate: { $ne: today } },
    { $inc: { balance: amount }, $set: { lastDailyDate: today, dailyStreak: streak, username: interaction.user.username } },
    { new: true },
  );
  if (!updated) {
    await interaction.reply({ content: '오늘의 데일리 머니는 이미 받았습니다. 다음 지급은 자정 이후입니다.',  });
    return;
  }
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('데일리 지급 완료').setDescription(`**${moneyText(amount)}**를 지급했습니다. (연속 ${Math.max(streak - 1, 0)}일 · 보너스 ${bonusPercent}%)`).addFields({ name: '현재 보유 머니', value: moneyText(updated.balance) })]});
}

async function handleWalletCommand(interaction) {
  const account = await UserMoney.findOne({ discordId: interaction.user.id }).lean();
  if (!account) {
    await interaction.reply({ content: '지갑을 사용하려면 먼저 `/가입` 명령어를 실행해주세요.'});
    return;
  }
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle(`:coin: ${interaction.user.username}님의 지갑`).addFields({ name: '보유 머니', value: `**${moneyText(account.balance)}**` }, { name: '데일리 연속 출석', value: `${Math.max(Number(account.dailyStreak || 0) - 1, 0)}일`, inline: true })]});
}

async function handleLeaderboardCommand(interaction) {
  const scope = interaction.options.getString('범위', true);
  if (scope === 'server' && !interaction.guildId) {
    await interaction.reply({ content: '서버 리더보드는 서버 안에서만 조회할 수 있습니다.'});
    return;
  }
  const filter = scope === 'server' ? { guildIds: interaction.guildId } : {};
  const users = await UserMoney.find(filter).sort({ balance: -1, createdAt: 1 }).limit(25).lean();
  let description = '아직 가입한 유저가 없습니다.';
  if (users.length) {
    if (scope === 'server') {
      const medals = [':first_place:', ':second_place:', ':third_place:'];
      const lines = users.map((user, index) => {
        const rank = medals[index] || `**${index + 1}.**`;
        const star = String(user.discordId) === interaction.user.id ? ' :star:' : '';
        return `${rank} <@${user.discordId}> - ${moneyText(user.balance)}${star}`;
      });
      if (!users.some((user) => String(user.discordId) === interaction.user.id)) {
        const currentUser = await UserMoney.findOne({ ...filter, discordId: interaction.user.id }).lean();
        if (currentUser) {
          const higherCount = await UserMoney.countDocuments({ ...filter, balance: { $gt: currentUser.balance } });
          lines.push(`**내 순위 · ${higherCount + 1}위** <@${currentUser.discordId}> - ${moneyText(currentUser.balance)} :star:`);
        }
      }
      description = lines.join('\n');
    } else {
      description = users.map((user, index) => `**${index + 1}.** ${displayUsername(user.username)} - ${moneyText(user.balance)}`).join('\n');
    }
  }
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle(scope === 'server' ? '📊 서버 머니 리더보드' : '📊 글로벌 머니 리더보드').setDescription(description)] });
}

async function handleDeveloperMoneyCommand(message) {
  if (!isDeveloper(message.author.id)) return;
  const match = message.content.match(/^\.money\s+(add|deduct)\s+(\d{15,22})\s+(\d+)\s*$/i);
  if (!match) return;
  const [, operation, discordId, rawAmount] = match;
  const amount = Number(rawAmount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return;
  const update = operation.toLowerCase() === 'add'
    ? { $inc: { balance: amount } }
    : { $inc: { balance: -amount } };
  const filter = operation.toLowerCase() === 'add' ? { discordId } : { discordId, balance: { $gte: amount } };
  const account = await UserMoney.findOneAndUpdate(filter, update, { new: true });
  await message.reply(account
    ? `${displayUsername(account.username)}님의 잔액을 ${operation.toLowerCase() === 'add' ? '증가' : '차감'}했습니다. 현재 잔액: ${moneyText(account.balance)}`
    : '대상 유저가 가입하지 않았거나 차감할 머니가 부족합니다.');
}

// 슬래시 커맨드 이름 → 핸들러 매핑 테이블. 새 커맨드를 추가하려면 여기에 한 줄만 추가하면 된다.
const CHAT_INPUT_COMMAND_HANDLERS = {
  가입: handleSignupCommand,
  데일리: handleDailyCommand,
  지갑: handleWalletCommand,
  리더보드: handleLeaderboardCommand,
  마권발매: handleTicketCommand,
  내마권: handleMyTicketsCommand,
  경마일정: handleScheduleCommand,
  경주정보: handleRaceInfoCommand,
  알림구독: handleAlertSubscribeCommand,
  말정보: handleHorseInfoCommand,
  도박: handleGambleCommand,
  블랙잭: handleBlackjackCommand,
  편자강화: handleShoeGameCommand,
  돈내놔: handleMoneyGiveCommand,
  선물: handleGiftCommand,
  주식시세: handleStockQuoteCommand,
  주식매수: handleStockBuyCommand,
  주식매도: handleStockSellCommand,
  내주식: handleMyStocksCommand,
};

// 버튼 customId 접두사 → 핸들러 매핑 테이블. 순서는 무관 (접두사끼리 겹치지 않음).
const BUTTON_HANDLERS = [
  { prefix: CUSTOM_IDS.blackjackActionPrefix, handler: handleBlackjackAction },
  { prefix: CUSTOM_IDS.shoeGameActionPrefix, handler: handleShoeGameAction },
  { prefix: CUSTOM_IDS.raceAnalysisPrevPrefix, handler: handleRaceAnalysisInteraction },
  { prefix: CUSTOM_IDS.raceAnalysisNextPrefix, handler: handleRaceAnalysisInteraction },
  { prefix: CUSTOM_IDS.ticketConfirmPrefix, handler: (interaction) => handleTicketConfirmation(interaction, true) },
  { prefix: CUSTOM_IDS.ticketCancelPrefix, handler: (interaction) => handleTicketConfirmation(interaction, false) },
  { prefix: CUSTOM_IDS.schedulePrevPrefix, handler: handleScheduleButton },
  { prefix: CUSTOM_IDS.scheduleNextPrefix, handler: handleScheduleButton },
  { prefix: CUSTOM_IDS.myTicketsPrevPrefix, handler: handleMyTicketsButton },
  { prefix: CUSTOM_IDS.myTicketsNextPrefix, handler: handleMyTicketsButton },
  { prefix: CUSTOM_IDS.alertCancelConfirmPrefix, handler: handleAlertCancelButton },
  { prefix: CUSTOM_IDS.alertCancelDismissPrefix, handler: handleAlertCancelButton },
  { prefix: CUSTOM_IDS.giftConfirmPrefix, handler: (interaction) => handleGiftConfirmation(interaction, true) },
  { prefix: CUSTOM_IDS.giftCancelPrefix, handler: (interaction) => handleGiftConfirmation(interaction, false) },
];

const SELECT_MENU_PREFIX_HANDLERS = [
  { prefix: CUSTOM_IDS.horseInfoSelectPrefix, handler: handleHorseInfoSelect },
  { prefix: CUSTOM_IDS.raceAnalysisSelectPrefix, handler: handleRaceAnalysisInteraction },
  { prefix: CUSTOM_IDS.stockQuoteSelectPrefix, handler: handleStockQuoteSelect },
];

// 모달 제출도 동일한 패턴을 따르도록 테이블화
const MODAL_SUBMIT_HANDLERS = [
  { prefix: CUSTOM_IDS.modalPrefix, handler: handleTicketModal },
];

function findHandlerByPrefix(table, customId) {
  const entry = table.find(({ prefix }) => customId.startsWith(prefix));
  return entry ? entry.handler : null;
}

async function onInteractionCreate(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      const handler = CHAT_INPUT_COMMAND_HANDLERS[interaction.commandName];
      if (handler) await handler(interaction);
      return;
    }

    if (interaction.isButton()) {
      const handler = findHandlerByPrefix(BUTTON_HANDLERS, interaction.customId);
      if (handler) await handler(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const handler = findHandlerByPrefix(SELECT_MENU_PREFIX_HANDLERS, interaction.customId);
      if (handler) await handler(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      const handler = findHandlerByPrefix(MODAL_SUBMIT_HANDLERS, interaction.customId);
      if (handler) await handler(interaction);
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

async function ensureDatabaseIndexes() {
  try {
    await Ticket.collection.dropIndex('discordId_1_meet_1_rcDate_1_rcNo_1');
    console.log('Removed legacy unique ticket index');
  } catch (error) {
    if (error.code !== 26 && error.code !== 27) {
      throw error;
    }
  }

  await Ticket.createIndexes();
  await UserMoney.createIndexes();
  await AlertSubscription.createIndexes();
  await Stock.createIndexes();
  await StockHolding.createIndexes();
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
  await ensureDatabaseIndexes();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.once('clientReady', () => {
    console.log(`${client.user.tag} 로그인 완료`);
    setResponsibleGamblingPresence(client);
    startSettlementWorker(client);
    startAlertWorker(client);
    startStockPriceWorker();
  });

  client.on('interactionCreate', onInteractionCreate);
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    try {
      if (await handleGamblePrefixCommand(message)) return;
    } catch (error) {
      console.error('[gamble prefix]', error);
    }
    handleDeveloperMoneyCommand(message).catch((error) => console.error('[developer money]', error));
  });

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
  handleRaceInfoCommand,
  handleAlertSubscribeCommand,
  handleHorseInfoCommand,
  handleTicketModal,
  handleBlackjackCommand,
  setResponsibleGamblingPresence,
};
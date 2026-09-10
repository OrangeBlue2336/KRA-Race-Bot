const {
  ActivityType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const mongoose = require('mongoose');
const config = require('./config');
const AlertSubscription = require('./models/AlertSubscription');
const GameHold = require('./models/GameHold');
const Ticket = require('./models/Ticket');
const UserMoney = require('./models/UserMoney');
const { startAlertWorker } = require('./services/alertService');
const { refundOrphanedGameHolds } = require('./services/gameHoldService');
const { startKeepAlive } = require('./services/keepAliveServer');
const { startSettlementWorker } = require('./services/settlementService');
const { startStockPriceWorker } = require('./services/stockPriceService');
const CUSTOM_IDS = require('./utils/customIds');
const { RESPONSIBLE_GAMBLING_STATUS } = require('./utils/common');
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
const {
  getCommandData: getMoneyCommandData,
  handleSignupCommand,
  handleDailyCommand,
  handleWalletCommand,
  handleLeaderboardCommand,
  handleDeveloperMoneyCommand,
  handleDeveloperMoneyBulkConfirmation,
} = require('./commands/money');

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
    ...getMoneyCommandData(),
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

// 슬래시 커맨드 이름 → 핸들러 매핑 테이블. 새 커맨드를 추가하려면 여기에 한 줄만 추가하면 된다.
const CHAT_INPUT_COMMAND_HANDLERS = {
  가입: handleSignupCommand,
  데일리: handleDailyCommand,
  지갑: handleWalletCommand,
  리더보드: handleLeaderboardCommand,
  마권발매: handleTicketCommand,
  내마권: handleMyTicketsCommand,
  경주일정: handleScheduleCommand,
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
  { prefix: CUSTOM_IDS.moneyBulkConfirmPrefix, handler: (interaction) => handleDeveloperMoneyBulkConfirmation(interaction, true) },
  { prefix: CUSTOM_IDS.moneyBulkCancelPrefix, handler: (interaction) => handleDeveloperMoneyBulkConfirmation(interaction, false) },
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
  await GameHold.createIndexes();
}

async function main() {
  if (!config.discordToken || !config.mongoUri) {
    throw new Error('DISCORD_TOKEN, MONGODB_URI 환경변수가 필요합니다.');
  }

  await warmScheduleCache();
  setInterval(() => warmScheduleCache().catch(console.error), 15 * 60_000);

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
    refundOrphanedGameHolds(client).catch((error) => console.error('[gameHold] 시작 시 환불 처리 실패', error));
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


// deploy-commands.js가 슬래시 커맨드를 Discord에 등록할 때 getCommandData()만 가져다 쓴다.
// 다른 핸들러들은 index.js 안의 라우팅 테이블(CHAT_INPUT_COMMAND_HANDLERS 등)에서만 쓰이므로
// 굳이 함께 export할 필요가 없다(2026-09-07 정리 — 예전에는 여기 더 많은 핸들러가 나열돼 있었음).
module.exports = {
  getCommandData,
};
const {
  ActionRowBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const config = require('../config');
const Stock = require('../models/Stock');
const StockHolding = require('../models/StockHolding');
const UserMoney = require('../models/UserMoney');
const CUSTOM_IDS = require('../utils/customIds');
const { moneyText } = require('../utils/common');
const { renderStockChart } = require('../utils/stockChart');

function stockCodes() {
  return config.STOCKS.map((stock) => stock.code);
}

async function loadStocks() {
  return Stock.find({ code: { $in: stockCodes() } }).sort({ code: 1 }).lean();
}

function changeRate(stock) {
  if (!stock.previousPrice) return 0;
  return ((stock.price - stock.previousPrice) / stock.previousPrice) * 100;
}

function changeText(stock) {
  const rate = changeRate(stock);
  const arrow = rate > 0 ? '🔺' : rate < 0 ? '🔻' : '⏸️';
  return `${arrow} ${rate > 0 ? '+' : ''}${rate.toFixed(2)}%`;
}

// Discord는 코드블록에 ```ansi 언어 태그를 붙이면 ANSI 색상 코드를 해석해 글자색을 입혀준다.
// 1;32 = 굵은 초록, 1;31 = 굵은 빨강, 0 = 리셋.
function ansiColor(code, text) {
  return `\u001b[${code}m${text}\u001b[0m`;
}

// 시세 목록을 코드블록 한 줄씩으로 정리한다. (순번 / 종목명 / 화살표+현재가 / 변동폭·변동률)
function buildStockListLines(stocks) {
  const nameWidth = Math.max(...stocks.map((stock) => stock.name.length)) + 2;
  return stocks.map((stock, index) => {
    const diff = Math.round(stock.price - stock.previousPrice);
    const rate = changeRate(stock);
    const isUp = diff > 0;
    const isDown = diff < 0;
    const arrow = isUp ? '▲' : isDown ? '▼' : '■';
    const colorCode = isUp ? '1;32' : isDown ? '1;31' : '1;30';
    const diffText = `${diff > 0 ? '+' : ''}${diff.toLocaleString()} (${rate > 0 ? '+' : ''}${rate.toFixed(2)}%)`;
    const priceText = `${arrow} ${stock.price.toLocaleString()}  ${diffText}`;
    const label = `${index + 1}. ${stock.name}`.padEnd(nameWidth + 3, ' ');
    return `${label}${ansiColor(colorCode, priceText)}`;
  });
}

function buildStockListEmbed(stocks) {
  const latestUpdatedAt = stocks.reduce((latest, stock) => {
    const at = stock.updatedAt ? new Date(stock.updatedAt).getTime() : 0;
    return Math.max(latest, at);
  }, 0) || Date.now();
  const unixSeconds = Math.floor(latestUpdatedAt / 1000);
  const nextUpdateSeconds = Math.max(
    0,
    Math.round((latestUpdatedAt + config.stockPriceIntervalMs - Date.now()) / 1000),
  );

  const description = [
    `📊 주식 정보는 <t:${unixSeconds}:R>에 변동됐습니다. (<t:${unixSeconds}:f>)`,
    '```ansi',
    ...buildStockListLines(stocks),
    '```',
  ].join('\n');

  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📈 주식 시세')
    .setDescription(description)
    .setFooter({ text: `다음 변동까지 약 ${nextUpdateSeconds}초 · 종목을 선택하면 그래프를 볼 수 있습니다.` });
}

// 종목 코드별로 config.js에 등록된 그래프 색상을 사용한다.
function buildStockChartAttachment(stock) {
  const definition = config.STOCK_BY_CODE[stock.code];
  const color = definition ? definition.color : '#3498db';
  const buffer = renderStockChart(stock, color);
  return new AttachmentBuilder(buffer, { name: `stock-${stock.code}.png` });
}

function buildStockDetailEmbed(stock, attachmentName) {
  const definition = config.STOCK_BY_CODE[stock.code];
  const color = definition ? definition.color.replace('#', '0x') : '0x3498db';
  return new EmbedBuilder()
    .setColor(Number(color))
    .setTitle(`${stock.name} 시세 그래프`)
    .addFields(
      { name: '현재가', value: moneyText(stock.price), inline: true },
      { name: '등락률', value: changeText(stock), inline: true },
    )
    .setImage(`attachment://${attachmentName}`);
}

function stockSelectRow(stocks, selectedCode) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(CUSTOM_IDS.stockQuoteSelectPrefix)
    .setPlaceholder('그래프를 볼 종목을 선택하세요')
    .addOptions(stocks.map((stock) => new StringSelectMenuOptionBuilder()
      .setLabel(`${stock.code}. ${stock.name}`)
      .setValue(stock.code)
      .setDefault(stock.code === selectedCode)));
  return new ActionRowBuilder().addComponents(menu);
}

async function handleStockQuoteCommand(interaction) {
  await interaction.deferReply();
  const stocks = await loadStocks();
  if (stocks.length === 0) {
    await interaction.editReply('주식 시세를 아직 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
    return;
  }
  await interaction.editReply({ embeds: [buildStockListEmbed(stocks)], components: [stockSelectRow(stocks, null)] });
}

async function handleStockQuoteSelect(interaction) {
  const stocks = await loadStocks();
  const selectedCode = interaction.values[0];
  const stock = stocks.find((item) => item.code === selectedCode);
  if (!stock) {
    await interaction.reply({ content: '알 수 없는 종목입니다.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferUpdate();
  const attachment = buildStockChartAttachment(stock);
  await interaction.editReply({
    embeds: [buildStockListEmbed(stocks), buildStockDetailEmbed(stock, attachment.name)],
    components: [stockSelectRow(stocks, selectedCode)],
    files: [attachment],
  });
}

async function handleStockBuyCommand(interaction) {
  const stockCode = interaction.options.getString('종목', true);
  const quantity = interaction.options.getInteger('수량', true);
  const definition = config.STOCK_BY_CODE[stockCode];
  if (!definition) {
    await interaction.reply({ content: '알 수 없는 종목입니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  const stock = await Stock.findOne({ code: stockCode }).lean();
  if (!stock) {
    await interaction.reply({ content: '주식 시세를 아직 불러오지 못했습니다. 잠시 후 다시 시도해주세요.', flags: MessageFlags.Ephemeral });
    return;
  }

  const account = await UserMoney.findOne({ discordId: interaction.user.id }).lean();
  if (!account) {
    await interaction.reply({ content: '주식을 거래하려면 먼저 `/가입` 명령어를 실행해주세요.', flags: MessageFlags.Ephemeral });
    return;
  }

  const cost = stock.price * quantity;
  // 방식 B: "현재 잔액의 최대 N%까지만 한 번에 매수 가능" (기본 50%, config.stockHoldingLimitRatio)
  const limit = Math.floor(account.balance * config.stockHoldingLimitRatio);
  if (cost > limit) {
    const maxQuantity = Math.max(Math.floor(limit / stock.price), 0);
    await interaction.reply({
      content: `한 번에 매수 가능한 금액은 현재 잔액의 ${Math.round(config.stockHoldingLimitRatio * 100)}%(${moneyText(limit)})까지입니다. 이 종목은 최대 ${maxQuantity.toLocaleString()}주까지 매수할 수 있습니다.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const updatedAccount = await UserMoney.findOneAndUpdate(
    { discordId: interaction.user.id, balance: { $gte: cost } },
    { $inc: { balance: -cost }, $set: { username: interaction.user.username } },
    { new: true },
  );
  if (!updatedAccount) {
    await interaction.reply({ content: '보유 머니가 부족합니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  const holding = await StockHolding.findOneAndUpdate(
    { discordId: interaction.user.id, stockCode },
    { $inc: { quantity, totalCost: cost }, $set: { username: interaction.user.username } },
    { upsert: true, new: true },
  );

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`✅ ${definition.name} 매수 완료`)
      .setDescription(`${moneyText(stock.price)} × ${quantity.toLocaleString()}주 = **${moneyText(cost)}**`)
      .addFields(
        { name: '보유 수량', value: `${holding.quantity.toLocaleString()}주`, inline: true },
        { name: '평균 단가', value: moneyText(Math.round(holding.totalCost / holding.quantity)), inline: true },
        { name: '현재 보유 머니', value: moneyText(updatedAccount.balance), inline: true },
      )
      .setTimestamp()],
  });
}

async function handleStockSellCommand(interaction) {
  const stockCode = interaction.options.getString('종목', true);
  const quantity = interaction.options.getInteger('수량', true);
  const definition = config.STOCK_BY_CODE[stockCode];
  if (!definition) {
    await interaction.reply({ content: '알 수 없는 종목입니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  const stock = await Stock.findOne({ code: stockCode }).lean();
  if (!stock) {
    await interaction.reply({ content: '주식 시세를 아직 불러오지 못했습니다. 잠시 후 다시 시도해주세요.', flags: MessageFlags.Ephemeral });
    return;
  }

  const holding = await StockHolding.findOne({ discordId: interaction.user.id, stockCode }).lean();
  if (!holding || holding.quantity < quantity) {
    await interaction.reply({
      content: `보유 수량이 부족합니다. (보유: ${holding ? holding.quantity.toLocaleString() : 0}주)`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const avgPrice = holding.totalCost / holding.quantity;
  const costBasisRemoved = Math.round(avgPrice * quantity);
  const proceeds = stock.price * quantity;

  const updatedHolding = await StockHolding.findOneAndUpdate(
    { discordId: interaction.user.id, stockCode, quantity: { $gte: quantity } },
    { $inc: { quantity: -quantity, totalCost: -costBasisRemoved } },
    { new: true },
  );
  if (!updatedHolding) {
    await interaction.reply({ content: '보유 수량이 부족합니다.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (updatedHolding.quantity <= 0) {
    await StockHolding.deleteOne({ _id: updatedHolding._id });
  }

  const account = await UserMoney.findOneAndUpdate(
    { discordId: interaction.user.id },
    { $inc: { balance: proceeds }, $set: { username: interaction.user.username } },
    { new: true },
  );

  const profit = proceeds - costBasisRemoved;
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(profit >= 0 ? 0x2ecc71 : 0xe74c3c)
      .setTitle(`✅ ${definition.name} 매도 완료`)
      .setDescription(`${moneyText(stock.price)} × ${quantity.toLocaleString()}주 = **${moneyText(proceeds)}**`)
      .addFields(
        { name: '실현 손익', value: `${profit >= 0 ? '+' : ''}${moneyText(profit)}`, inline: true },
        { name: '남은 보유 수량', value: `${Math.max(updatedHolding.quantity, 0).toLocaleString()}주`, inline: true },
        { name: '현재 보유 머니', value: moneyText(account.balance), inline: true },
      )
      .setTimestamp()],
  });
}

async function handleMyStocksCommand(interaction) {
  const holdings = await StockHolding.find({ discordId: interaction.user.id, quantity: { $gt: 0 } }).lean();
  if (holdings.length === 0) {
    await interaction.reply({ content: '보유 중인 주식이 없습니다. `/주식매수`로 첫 종목을 사보세요.', flags: MessageFlags.Ephemeral });
    return;
  }

  const stocks = await Stock.find({ code: { $in: holdings.map((holding) => holding.stockCode) } }).lean();
  const stockByCode = Object.fromEntries(stocks.map((stock) => [stock.code, stock]));

  const lines = holdings.map((holding) => {
    const stock = stockByCode[holding.stockCode];
    const avgPrice = Math.round(holding.totalCost / holding.quantity);
    const currentPrice = stock ? stock.price : avgPrice;
    const valuation = currentPrice * holding.quantity;
    const profit = valuation - holding.totalCost;
    const profitRate = holding.totalCost ? (profit / holding.totalCost) * 100 : 0;
    const name = config.STOCK_BY_CODE[holding.stockCode]?.name || holding.stockCode;
    return `**${name}** — 보유 ${holding.quantity.toLocaleString()}주 / 평균단가 ${moneyText(avgPrice)}\n`
      + `평가금액 ${moneyText(valuation)} · 평가손익 ${profit >= 0 ? '+' : ''}${moneyText(profit)} (${profitRate >= 0 ? '+' : ''}${profitRate.toFixed(1)}%)`;
  });

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`📋 ${interaction.user.username}님의 보유 주식`)
      .setDescription(lines.join('\n\n'))
      .setTimestamp()],
    flags: MessageFlags.Ephemeral,
  });
}

function stockChoices() {
  return config.STOCKS.map((stock) => ({ name: stock.name, value: stock.code }));
}

function getCommandData() {
  return [
    new SlashCommandBuilder()
      .setName('주식시세')
      .setDescription('가상 주식 5종목의 현재 시세를 확인합니다.'),
    new SlashCommandBuilder()
      .setName('주식매수')
      .setDescription('가상 주식을 매수합니다.')
      .addStringOption((option) => option
        .setName('종목')
        .setDescription('매수할 종목을 선택합니다.')
        .setRequired(true)
        .addChoices(...stockChoices()))
      .addIntegerOption((option) => option
        .setName('수량')
        .setDescription('매수할 수량을 입력합니다.')
        .setRequired(true)
        .setMinValue(1)),
    new SlashCommandBuilder()
      .setName('주식매도')
      .setDescription('보유 중인 가상 주식을 매도합니다.')
      .addStringOption((option) => option
        .setName('종목')
        .setDescription('매도할 종목을 선택합니다.')
        .setRequired(true)
        .addChoices(...stockChoices()))
      .addIntegerOption((option) => option
        .setName('수량')
        .setDescription('매도할 수량을 입력합니다.')
        .setRequired(true)
        .setMinValue(1)),
    new SlashCommandBuilder()
      .setName('내주식')
      .setDescription('내가 보유한 주식 목록과 평가손익을 확인합니다.'),
  ];
}

module.exports = {
  getCommandData,
  handleStockQuoteCommand,
  handleStockQuoteSelect,
  handleStockBuyCommand,
  handleStockSellCommand,
  handleMyStocksCommand,
};
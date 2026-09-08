const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const config = require('../config');
const UserMoney = require('../models/UserMoney');
const CUSTOM_IDS = require('../utils/customIds');
const { isDeveloper, moneyText, displayUsername } = require('../utils/common');
const { nowKST, todayKST } = require('../utils/time');
const { createGameId, createGameSessionStore } = require('../utils/gameSession');

function getCommandData() {
  return [
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

// .money add/deduct everyone (머니) 확인 대기열. TTL 5분, 확인/취소 버튼을 누르면 즉시 소모됨.
const pendingBulkMoneyActions = createGameSessionStore(5 * 60_000);

async function handleDeveloperMoneyCommand(message) {
  if (!isDeveloper(message.author.id)) return;
  const match = message.content.match(/^\.money\s+(add|deduct)\s+(everyone|\d{15,22})\s+(\d+)\s*$/i);
  if (!match) return;
  const [, operationRaw, target, rawAmount] = match;
  const operation = operationRaw.toLowerCase();
  const amount = Number(rawAmount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return;

  if (target.toLowerCase() === 'everyone') {
    await handleDeveloperMoneyEveryoneCommand(message, operation, amount);
    return;
  }

  const discordId = target;
  const update = operation === 'add'
    ? { $inc: { balance: amount } }
    : { $inc: { balance: -amount } };
  const filter = operation === 'add' ? { discordId } : { discordId, balance: { $gte: amount } };
  const account = await UserMoney.findOneAndUpdate(filter, update, { new: true });
  await message.reply(account
    ? `${displayUsername(account.username)}님의 잔액을 ${operation === 'add' ? '증가' : '차감'}했습니다. 현재 잔액: ${moneyText(account.balance)}`
    : '대상 유저가 가입하지 않았거나 차감할 머니가 부족합니다.');
}

// .money add/deduct everyone (머니): 실행 즉시 지급/차감하지 않고 확인/취소 버튼으로 재확인을 받는다.
async function handleDeveloperMoneyEveryoneCommand(message, operation, amount) {
  const bulkId = createGameId();
  pendingBulkMoneyActions.add({
    id: bulkId,
    developerId: message.author.id,
    operation,
    amount,
  });
  const verb = operation === 'add' ? '지급' : '차감';
  await message.reply({
    content: `⚠️ 가입된 **모든 사용자**에게 **${moneyText(amount)}**를 ${verb}할까요?`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${CUSTOM_IDS.moneyBulkConfirmPrefix}${bulkId}`).setLabel('확인').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${CUSTOM_IDS.moneyBulkCancelPrefix}${bulkId}`).setLabel('취소').setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function handleDeveloperMoneyBulkConfirmation(interaction, confirmed) {
  if (!isDeveloper(interaction.user.id)) {
    await interaction.reply({ content: '이 작업은 개발자만 수행할 수 있습니다.', flags: MessageFlags.Ephemeral });
    return;
  }
  const prefix = confirmed ? CUSTOM_IDS.moneyBulkConfirmPrefix : CUSTOM_IDS.moneyBulkCancelPrefix;
  const bulkId = interaction.customId.slice(prefix.length);
  const pending = pendingBulkMoneyActions.get(bulkId);
  if (!pending || pending.developerId !== interaction.user.id) {
    await interaction.reply({ content: '올바르지 않거나 만료된 요청입니다.', flags: MessageFlags.Ephemeral });
    return;
  }
  pendingBulkMoneyActions.delete(bulkId);

  if (!confirmed) {
    await interaction.update({ content: '취소되었습니다.', embeds: [], components: [] });
    return;
  }

  const { operation, amount } = pending;
  const filter = operation === 'add' ? {} : { balance: { $gte: amount } };
  const update = operation === 'add' ? { $inc: { balance: amount } } : { $inc: { balance: -amount } };
  const result = await UserMoney.updateMany(filter, update);
  const verb = operation === 'add' ? '지급' : '차감';
  await interaction.update({
    content: `✅ 가입된 사용자 **${result.modifiedCount}명**에게 **${moneyText(amount)}**를 ${verb}했습니다.`,
    components: [],
  });
}

module.exports = {
  getCommandData,
  handleSignupCommand,
  handleDailyCommand,
  handleWalletCommand,
  handleLeaderboardCommand,
  handleDeveloperMoneyCommand,
  handleDeveloperMoneyBulkConfirmation,
};

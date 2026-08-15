const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const UserMoney = require('../models/UserMoney');
const { parseAmount } = require('../utils/betting');
const { moneyText, RESPONSIBLE_GAMBLING_STATUS } = require('../utils/common');
const { createCooldownManager } = require('../utils/gameSession');

const gambleCooldowns = createCooldownManager({ autoCleanup: true });

async function performGamble(userId, username, amount) {
  const remaining = gambleCooldowns.getRemainingSeconds(userId);
  if (remaining > 0) {
    return { embeds: [new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('도박 쿨다운')
      .setDescription(`도박은 한 번 실행할 때마다 ${config.gambleCooldownSeconds}초를 기다려야 합니다. **${remaining}초** 뒤에 다시 시도해주세요.`)
      .setFooter({ text: RESPONSIBLE_GAMBLING_STATUS })] };
  }
  const account = await UserMoney.findOne({ discordId: userId }).lean();
  if (!account) {
    return { content: '도박을 하려면 먼저 `/가입` 명령어를 실행해주세요.' };
  }
  if (!Number.isFinite(amount) || amount < config.gambleMinAmount || !Number.isInteger(amount)) {
    return { content: `도박 금액은 ${config.gambleMinAmount.toLocaleString()}머니 이상의 정수로 입력해주세요.` };
  }
  if (account.balance < amount) {
    return { embeds: [new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('머니 부족')
      .setDescription(`보유 머니가 부족합니다.`)
      .addFields(
        { name: '도박 금액', value: moneyText(amount), inline: true },
        { name: '현재 보유 머니', value: moneyText(account.balance), inline: true },
      )
      .setFooter({ text: RESPONSIBLE_GAMBLING_STATUS })] };
  }

  const won = Math.random() < config.gambleWinChance;
  gambleCooldowns.set(userId, config.gambleCooldownSeconds);

  if (won) {
    const updated = await UserMoney.findOneAndUpdate(
      { discordId: userId },
      { $inc: { balance: amount }, $set: { username } },
      { new: true },
    );
    return { embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('🎰 도박 성공!')
      .setDescription(`**${moneyText(amount)}**를 얻었습니다!`)
      .addFields(
        { name: '현재 보유 머니', value: moneyText(updated.balance), inline: true },
      )
      .setFooter({ text: RESPONSIBLE_GAMBLING_STATUS })
      .setTimestamp()] };
  }

  const updated = await UserMoney.findOneAndUpdate(
    { discordId: userId, balance: { $gte: amount } },
    { $inc: { balance: -amount }, $set: { username } },
    { new: true },
  );
  if (!updated) {
    return { embeds: [new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('머니 부족')
      .setDescription(`보유 머니가 부족합니다.`)
      .setFooter({ text: RESPONSIBLE_GAMBLING_STATUS })] };
  }
  return { embeds: [new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('🎰 도박 실패...')
    .setDescription(`**${moneyText(amount)}**를 잃었습니다.`)
    .addFields({ name: '현재 보유 머니', value: moneyText(updated.balance), inline: true })
    .setFooter({ text: RESPONSIBLE_GAMBLING_STATUS })
    .setTimestamp()] };
}

async function handleGambleCommand(interaction) {
  const amount = interaction.options.getInteger('머니', true);
  const payload = await performGamble(interaction.user.id, interaction.user.username, amount);
  await interaction.reply(payload);
}

async function handleGamblePrefixCommand(message) {
  const match = message.content.match(/^\s*\.도박\s+([\d,]+)\s*$/);
  if (!match) return false;
  const amount = parseAmount(match[1]);
  const payload = await performGamble(message.author.id, message.author.username, amount);
  await message.reply(payload);
  return true;
}

module.exports = {
  handleGambleCommand,
  handleGamblePrefixCommand,
};

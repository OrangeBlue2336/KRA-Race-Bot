const { EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const UserMoney = require('../models/UserMoney');
const { moneyText } = require('../utils/common');
const { createCooldownManager } = require('../utils/gameSession');

const moneyGiveCooldown = createCooldownManager({ autoCleanup: true });

function randomMoneyGiveAmount() {
  const { moneyGiveMinAmount, moneyGiveMaxAmount, moneyGiveStep } = config;
  const steps = Math.floor((moneyGiveMaxAmount - moneyGiveMinAmount) / moneyGiveStep) + 1;
  return moneyGiveMinAmount + Math.floor(Math.random() * steps) * moneyGiveStep;
}

async function handleMoneyGiveCommand(interaction) {
  const until = moneyGiveCooldown.getUntil(interaction.user.id);
  if (until > Date.now()) {
    const unixSeconds = Math.floor(until / 1000);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('아직 받을 수 없습니다')
        .setDescription(`<t:${unixSeconds}:R>에 다시 지급 받을 수 있습니다. (<t:${unixSeconds}:T>)`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const account = await UserMoney.findOne({ discordId: interaction.user.id }).lean();
  if (!account) {
    await interaction.reply({ content: '먼저 `/가입` 명령어를 실행해주세요.', flags: MessageFlags.Ephemeral });
    return;
  }

  const amount = randomMoneyGiveAmount();
  moneyGiveCooldown.set(interaction.user.id, config.moneyGiveCooldownSeconds);
  const updated = await UserMoney.findOneAndUpdate(
    { discordId: interaction.user.id },
    { $inc: { balance: amount }, $set: { username: interaction.user.username } },
    { new: true },
  );

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('💵 돈내놔!')
      .setDescription(`**${moneyText(amount)}**를 받았습니다!`)
      .addFields({ name: '현재 보유 머니', value: moneyText(updated.balance), inline: true })
      .setTimestamp()],
  });
}

module.exports = {
  handleMoneyGiveCommand,
};

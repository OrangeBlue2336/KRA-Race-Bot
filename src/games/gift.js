const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const UserMoney = require('../models/UserMoney');
const CUSTOM_IDS = require('../utils/customIds');
const { moneyText, displayUsername } = require('../utils/common');

const pendingGifts = new Map();

function createGiftId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function handleGiftCommand(interaction) {
  const amount = interaction.options.getInteger('머니', true);
  const target = interaction.options.getUser('대상', true);

  if (target.id === interaction.user.id) {
    await interaction.reply({ content: '자기 자신에게는 선물할 수 없습니다.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (target.bot) {
    await interaction.reply({ content: '봇에게는 선물할 수 없습니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  const sender = await UserMoney.findOne({ discordId: interaction.user.id }).lean();
  if (!sender) {
    await interaction.reply({ content: '선물을 보내려면 먼저 `/가입` 명령어를 실행해주세요.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (sender.balance < amount) {
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('머니 부족')
        .setDescription('보유 머니가 부족하여 선물할 수 없습니다.')
        .addFields(
          { name: '선물 금액', value: moneyText(amount), inline: true },
          { name: '현재 보유 머니', value: moneyText(sender.balance), inline: true },
        )],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const receiver = await UserMoney.findOne({ discordId: target.id }).lean();
  if (!receiver) {
    await interaction.reply({ content: '대상자가 머니 시스템에 가입되어 있지 않습니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  const giftId = createGiftId();
  pendingGifts.set(giftId, {
    fromId: interaction.user.id,
    toId: target.id,
    toUsername: target.username,
    amount,
    expiresAt: Date.now() + 5 * 60_000,
  });
  setTimeout(() => pendingGifts.delete(giftId), 5 * 60_000 + 100);

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle('🎁 머니 선물 확인')
      .setDescription(`**${displayUsername(target.username)}**님에게 **${moneyText(amount)}**를 선물하시겠습니까?`)
      .addFields({ name: '현재 보유 머니', value: moneyText(sender.balance), inline: true })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${CUSTOM_IDS.giftConfirmPrefix}${giftId}`).setLabel('확인').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${CUSTOM_IDS.giftCancelPrefix}${giftId}`).setLabel('취소').setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function handleGiftConfirmation(interaction, confirmed) {
  const prefix = confirmed ? CUSTOM_IDS.giftConfirmPrefix : CUSTOM_IDS.giftCancelPrefix;
  const giftId = interaction.customId.slice(prefix.length);
  const gift = pendingGifts.get(giftId);
  if (!gift || gift.fromId !== interaction.user.id) {
    await interaction.reply({ content: '올바르지 않은 선물 요청입니다.', flags: MessageFlags.Ephemeral });
    return;
  }
  pendingGifts.delete(giftId);

  if (!confirmed) {
    await interaction.update({ content: '선물을 취소했습니다.', embeds: [], components: [] });
    return;
  }

  const sender = await UserMoney.findOneAndUpdate(
    { discordId: gift.fromId, balance: { $gte: gift.amount } },
    { $inc: { balance: -gift.amount }, $set: { username: interaction.user.username } },
    { new: true },
  );
  if (!sender) {
    await interaction.update({ content: '보유 머니가 부족하여 선물을 보낼 수 없습니다.', embeds: [], components: [] });
    return;
  }
  const receiver = await UserMoney.findOneAndUpdate({ discordId: gift.toId }, { $inc: { balance: gift.amount } }, { new: true });
  if (!receiver) {
    await UserMoney.updateOne({ discordId: gift.fromId }, { $inc: { balance: gift.amount } });
    await interaction.update({ content: '대상자가 머니 시스템에서 확인되지 않아 선물을 취소했습니다.', embeds: [], components: [] });
    return;
  }

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('🎁 선물 완료')
      .setDescription(`**${gift.toUsername}**님에게 **${moneyText(gift.amount)}**를 선물했습니다.`)
      .addFields({ name: '현재 보유 머니', value: moneyText(sender.balance), inline: true })],
    components: [],
  });
}

module.exports = {
  handleGiftCommand,
  handleGiftConfirmation,
};

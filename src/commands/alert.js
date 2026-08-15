const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const config = require('../config');
const AlertSubscription = require('../models/AlertSubscription');
const { ALERT_TYPES } = require('../services/alertService');
const CUSTOM_IDS = require('../utils/customIds');

function alertTypeLabel(alertType) {
  return Object.values(ALERT_TYPES).find((item) => item.value === alertType)?.label || alertType;
}

function buildAlertSubscriptionEmbed(meet, alertType) {
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('알림 구독 완료')
    .setDescription(`${meet.name} 경마장의 ${alertTypeLabel(alertType)} 알림을 구독했습니다.`)
    .addFields({
      name: '알림 방식',
      value: '구독한 경마장의 마권을 발매하면, 해당 경주의 변경 사항을 5분 간격으로 확인해 DM으로 알려드립니다.',
      inline: false,
    })
    .setTimestamp();
}

function buildAlertCancelMessage(meetCode, alertType) {
  const meet = config.MEET_BY_CODE[meetCode];
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('알림 구독 취소')
    .setDescription(`${meet.name} 경마장의 ${alertTypeLabel(alertType)} 알림 구독을 취소할까요?`)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_IDS.alertCancelConfirmPrefix}${meetCode}:${alertType}`)
      .setLabel('취소하기')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_IDS.alertCancelDismissPrefix}${meetCode}:${alertType}`)
      .setLabel('유지하기')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

async function handleAlertSubscribeCommand(interaction) {
  const meetCode = interaction.options.getString('경마장', true);
  const alertType = interaction.options.getString('알림종류', true);
  const meet = config.MEET_BY_CODE[meetCode];

  if (!meet || !Object.values(ALERT_TYPES).some((item) => item.value === alertType)) {
    await interaction.reply({ content: '알 수 없는 구독 옵션입니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  const existing = await AlertSubscription.findOne({
    discordId: interaction.user.id,
    meetCode,
    alertType,
  });

  if (existing) {
    await interaction.reply(buildAlertCancelMessage(meetCode, alertType));
    return;
  }

  await AlertSubscription.create({
    discordId: interaction.user.id,
    username: interaction.user.username,
    meetCode,
    meet: meet.name,
    alertType,
  });

  await interaction.reply({
    embeds: [buildAlertSubscriptionEmbed(meet, alertType)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleAlertCancelButton(interaction) {
  const isConfirm = interaction.customId.startsWith(CUSTOM_IDS.alertCancelConfirmPrefix);
  const prefix = isConfirm ? CUSTOM_IDS.alertCancelConfirmPrefix : CUSTOM_IDS.alertCancelDismissPrefix;
  const [meetCode, alertType] = interaction.customId.slice(prefix.length).split(':');
  const meet = config.MEET_BY_CODE[meetCode];

  if (!meet) {
    await interaction.update({ content: '알 수 없는 경마장입니다.', embeds: [], components: [] });
    return;
  }

  if (!isConfirm) {
    await interaction.update({
      content: `${meet.name} ${alertTypeLabel(alertType)} 알림 구독을 유지합니다.`,
      embeds: [],
      components: [],
    });
    return;
  }

  const result = await AlertSubscription.deleteOne({
    discordId: interaction.user.id,
    meetCode,
    alertType,
  });

  await interaction.update({
    content: result.deletedCount > 0
      ? `${meet.name} ${alertTypeLabel(alertType)} 알림 구독을 취소했습니다.`
      : '이미 취소되었거나 찾을 수 없는 구독입니다.',
    embeds: [],
    components: [],
  });
}

function getCommandData() {
  return [
    new SlashCommandBuilder()
      .setName('알림구독')
      .setDescription('마권 발매 후 기수 변경 또는 출전 취소 알림을 DM으로 받습니다.')
      .addStringOption((option) => option
        .setName('경마장')
        .setDescription('알림을 받을 경마장을 선택합니다.')
        .setRequired(true)
        .addChoices(
          ...config.MEETS.map((meet) => ({ name: meet.name, value: meet.code })),
        ))
      .addStringOption((option) => option
        .setName('알림종류')
        .setDescription('구독할 알림 종류를 선택합니다.')
        .setRequired(true)
        .addChoices(
          { name: ALERT_TYPES.JOCKEY_CHANGE.label, value: ALERT_TYPES.JOCKEY_CHANGE.value },
          { name: ALERT_TYPES.HORSE_CANCEL.label, value: ALERT_TYPES.HORSE_CANCEL.value },
        )),
  ];
}

module.exports = {
  getCommandData,
  handleAlertSubscribeCommand,
  handleAlertCancelButton,
};

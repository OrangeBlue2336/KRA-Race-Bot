const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const config = require('../config');
const UserMoney = require('../models/UserMoney');
const CUSTOM_IDS = require('../utils/customIds');
const { moneyText } = require('../utils/common');

const SHOE_GAME_ASSET_DIR = 'assets/img/ShoeGame';
const shoeGames = new Map();
const shoeGameUserIds = new Map();
const shoeGameCooldowns = new Map();

function createShoeGameId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function shoeGameCooldownUntil(userId) {
  return shoeGameCooldowns.get(String(userId)) || 0;
}

function finishShoeGame(game) {
  game.status = 'completed';
  shoeGames.delete(game.id);
  shoeGameUserIds.delete(game.discordId);
  shoeGameCooldowns.set(game.discordId, Date.now() + config.shoeGameCooldownSeconds * 1000);
}

function shoeGameStage(level) {
  if (level === 0) {
    return { level: 0, multiplier: 1, grade: '은편자', image: '은편자.png' };
  }
  return config.SHOE_GAME_STAGES[level - 1];
}

function shoeGameImageFile(stage, destroyed = false) {
  const filename = destroyed ? stage.image.replace('.png', '_파괴.png') : stage.image;
  return new AttachmentBuilder(`${SHOE_GAME_ASSET_DIR}/${filename}`, { name: shoeGameAttachmentName(stage, destroyed) });
}

function shoeGameAttachmentName(stage, destroyed = false) {
  const gradeName = {
    '은편자.png': 'silver',
    '금편자.png': 'gold',
    '무지개_편자.png': 'rainbow',
  }[stage.image];
  return `shoe-${gradeName}${destroyed ? '-destroyed' : ''}.png`;
}

function shoeGameButtons(game) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${CUSTOM_IDS.shoeGameActionPrefix}${game.id}:enhance`).setLabel('🔨 강화 시도').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${CUSTOM_IDS.shoeGameActionPrefix}${game.id}:claim`).setLabel('💰 수령하기').setStyle(ButtonStyle.Success),
  )];
}

function shoeGameEmbed(game, { result = 'active', balance = null } = {}) {
  const stage = shoeGameStage(game.stage);
  const payout = Math.floor(game.amount * stage.multiplier);
  const fields = [
    { name: '현재 단계', value: `${stage.level}단계 · ${stage.grade}`, inline: true },
    { name: '현재 배당', value: `×${stage.multiplier}`, inline: true },
    { name: '실수령액 계산', value: `${moneyText(game.amount)} × ${stage.multiplier} = **${moneyText(payout)}**`, inline: true },
  ];

  if (result === 'active' || result === 'success') {
    const nextStage = config.SHOE_GAME_STAGES[game.stage];
    if (nextStage) {
      fields.push(
        { name: '다음 강화', value: `${nextStage.level}단계 · ×${nextStage.multiplier}`, inline: true },
        { name: '강화 실패 확률', value: `${Math.round((1 - nextStage.successChance) * 100)}%`, inline: true },
      );
    }
  }
  if (balance !== null) fields.push({ name: '현재 보유 머니', value: moneyText(balance), inline: true });

  const embed = new EmbedBuilder().setTimestamp().addFields(fields);
  if (result === 'failed') {
    return embed
      .setColor(0xe74c3c)
      .setTitle('강화 실패')
      .setDescription(`힘 조절을 잘못하여 강화중인 편자가 파괴되었습니다.. **${moneyText(game.amount)}를 잃었습니다.**`)
      .setImage(`attachment://${shoeGameAttachmentName(stage, true)}`);
  }
  if (result === 'claimed') {
    return embed
      .setColor(0x2ecc71)
      .setTitle('💰 수령 완료')
      .setDescription(`**${stage.level}단계 ${stage.grade}**의 배당을 수령했습니다.`)
      .setImage(`attachment://${shoeGameAttachmentName(stage)}`);
  }
  if (result === 'max') {
    return embed
      .setColor(0x2ecc71)
      .setTitle('🎉 최종 강화 성공!')
      .setDescription(`10단계 강화에 성공하여 **${moneyText(payout)}**가 자동으로 적립되었습니다.`)
      .setImage(`attachment://${shoeGameAttachmentName(stage)}`);
  }
  return embed
    .setColor(result === 'success' ? 0x2ecc71 : 0x3498db)
    .setTitle(result === 'success' ? '🔨 강화 성공!' : '🔨 편자 강화')
    .setDescription(result === 'success'
      ? `**${stage.level}단계 ${stage.grade}** 강화에 성공했습니다! 계속 강화하거나 지금 수령하세요.`
      : `베팅한 **${moneyText(game.amount)}**로 0단계 은편자 강화에 도전합니다.`)
    .setImage(`attachment://${shoeGameAttachmentName(stage)}`);
}

async function handleShoeGameCommand(interaction) {
  const userId = interaction.user.id;
  const until = shoeGameCooldownUntil(userId);
  if (until > Date.now()) {
    return interaction.reply({
      content: `편자강화는 게임 종료 후 ${config.shoeGameCooldownSeconds}초를 기다려야 합니다. <t:${Math.ceil(until / 1000)}:R>에 다시 시도해주세요.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (shoeGameUserIds.has(userId)) {
    return interaction.reply({ content: '진행 중인 편자강화 게임이 있습니다. 해당 게임을 끝낸 뒤 다시 시도해주세요.', flags: MessageFlags.Ephemeral });
  }

  const amount = interaction.options.getInteger('베팅금액', true);
  if (amount < config.shoeGameMinAmount || amount > config.shoeGameMaxAmount) {
    return interaction.reply({ content: `베팅 금액은 ${moneyText(config.shoeGameMinAmount)} 이상 ${moneyText(config.shoeGameMaxAmount)} 이하의 정수로 입력해주세요.`, flags: MessageFlags.Ephemeral });
  }
  const account = await UserMoney.findOneAndUpdate(
    { discordId: userId, balance: { $gte: amount } },
    { $inc: { balance: -amount }, $set: { username: interaction.user.username } },
    { new: true },
  );
  if (!account) return interaction.reply({ content: '가입되어 있지 않거나 보유 머니가 부족합니다. 먼저 `/가입` 및 `/지갑`을 확인해주세요.', flags: MessageFlags.Ephemeral });

  const game = { id: createShoeGameId(), discordId: userId, username: interaction.user.username, amount, stage: 0, status: 'active', locked: false };
  shoeGames.set(game.id, game);
  shoeGameUserIds.set(userId, game.id);
  const stage = shoeGameStage(game.stage);
  await interaction.reply({ embeds: [shoeGameEmbed(game, { balance: account.balance })], components: shoeGameButtons(game), files: [shoeGameImageFile(stage)] });
}

async function handleShoeGameAction(interaction) {
  const [, gameId, action] = interaction.customId.split(':');
  const game = shoeGames.get(gameId);
  if (!game || game.discordId !== interaction.user.id || game.status !== 'active') {
    return interaction.reply({ content: '이미 종료되었거나 만료된 편자강화 게임입니다.', flags: MessageFlags.Ephemeral });
  }
  if (game.locked) return interaction.reply({ content: '이전 강화 요청을 처리 중입니다.', flags: MessageFlags.Ephemeral });
  game.locked = true;
  try {
    if (action === 'claim') {
      const stage = shoeGameStage(game.stage);
      const payout = Math.floor(game.amount * stage.multiplier);
      const account = await UserMoney.findOneAndUpdate({ discordId: game.discordId }, { $inc: { balance: payout }, $set: { username: interaction.user.username } }, { new: true });
      if (!account) throw new Error('머니 계정을 찾을 수 없습니다.');
      finishShoeGame(game);
      await interaction.update({ embeds: [shoeGameEmbed(game, { result: 'claimed', balance: account.balance })], components: [], files: [shoeGameImageFile(stage)] });
      return;
    }
    if (action !== 'enhance') throw new Error('알 수 없는 편자강화 동작입니다.');

    const nextStage = config.SHOE_GAME_STAGES[game.stage];
    if (!nextStage) throw new Error('더 이상 강화할 수 없습니다.');
    if (Math.random() >= nextStage.successChance) {
      const stage = shoeGameStage(game.stage);
      finishShoeGame(game);
      const account = await UserMoney.findOne({ discordId: game.discordId }).lean();
      await interaction.update({ embeds: [shoeGameEmbed(game, { result: 'failed', balance: account ? account.balance : null })], components: [], files: [shoeGameImageFile(stage, true)] });
      return;
    }

    game.stage += 1;
    const stage = shoeGameStage(game.stage);
    if (game.stage === config.SHOE_GAME_STAGES.length) {
      const payout = Math.floor(game.amount * stage.multiplier);
      const account = await UserMoney.findOneAndUpdate({ discordId: game.discordId }, { $inc: { balance: payout }, $set: { username: interaction.user.username } }, { new: true });
      if (!account) throw new Error('머니 계정을 찾을 수 없습니다.');
      finishShoeGame(game);
      await interaction.update({ embeds: [shoeGameEmbed(game, { result: 'max', balance: account.balance })], components: [], files: [shoeGameImageFile(stage)] });
      return;
    }
    game.locked = false;
    await interaction.update({ embeds: [shoeGameEmbed(game, { result: 'success' })], components: shoeGameButtons(game), files: [shoeGameImageFile(stage)] });
  } catch (error) {
    game.locked = false;
    throw error;
  }
}

module.exports = {
  handleShoeGameCommand,
  handleShoeGameAction,
};

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const config = require('../config');
const UserMoney = require('../models/UserMoney');
const CUSTOM_IDS = require('../utils/customIds');
const { moneyText } = require('../utils/common');

const BLACKJACK_SUITS = ['hearts', 'clubs', 'diamonds', 'spades'];
const BLACKJACK_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const BLACKJACK_GAME_TTL_MS = 15 * 60_000;
const blackjackGames = new Map();

function createBlackjackGameId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function addBlackjackGame(game) {
  blackjackGames.set(game.id, game);
  setTimeout(() => {
    if (blackjackGames.get(game.id) === game) blackjackGames.delete(game.id);
  }, BLACKJACK_GAME_TTL_MS);
}

function blackjackDeck() {
  const deck = BLACKJACK_SUITS.flatMap((suit) => BLACKJACK_RANKS.map((rank) => ({ suit, rank })));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[nextIndex]] = [deck[nextIndex], deck[index]];
  }
  return deck;
}

function blackjackDraw(game) {
  const card = game.deck.pop();
  if (!card) throw new Error('카드 덱이 부족합니다. 새 게임을 시작해주세요.');
  return card;
}

function blackjackCardValue(rank) {
  if (rank === 'A') return 11;
  if (['10', 'J', 'Q', 'K'].includes(rank)) return 10;
  return Number(rank);
}

function blackjackScore(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === 'A') {
      total += 11;
      aces += 1;
    } else total += ['K', 'Q', 'J'].includes(card.rank) ? 10 : Number(card.rank);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

function blackjackCardsText(cards) {
  return cards.map((card) => `:${card.suit}: ${card.rank}`).join(' + ');
}

function blackjackHandText(hand) {
  const score = blackjackScore(hand.cards).total;
  return `${blackjackCardsText(hand.cards)}\n**합계: ${score}${score > 21 ? ' (버스트)' : ''}**`;
}

function blackjackOutcomeText(hand) {
  if (!hand.result) return '';
  const netAmount = Number(hand.payout || 0) - Number(hand.bet || 0);
  const moneyResult = netAmount > 0
    ? `\n**${moneyText(netAmount)}를 얻었습니다.**`
    : (netAmount < 0 ? `\n**${moneyText(Math.abs(netAmount))}를 잃었습니다.**` : '\n**머니 변동이 없습니다.**');
  return `\n**결과: ${hand.result}**\n${moneyResult}`;
}

function blackjackButtons(game) {
  const hand = game.hands[game.activeHandIndex];
  if (!hand || game.status !== 'active') return [];
  const canDouble = hand.cards.length === 2 && !hand.doubled;
  const canSplit = game.hands.length === 1 && hand.cards.length === 2
    && blackjackCardValue(hand.cards[0].rank) === blackjackCardValue(hand.cards[1].rank);
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${CUSTOM_IDS.blackjackActionPrefix}${game.id}:hit`).setLabel('힛').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${CUSTOM_IDS.blackjackActionPrefix}${game.id}:stand`).setLabel('스탠드').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${CUSTOM_IDS.blackjackActionPrefix}${game.id}:double`).setLabel('더블 다운').setStyle(ButtonStyle.Primary).setDisabled(!canDouble),
    new ButtonBuilder().setCustomId(`${CUSTOM_IDS.blackjackActionPrefix}${game.id}:split`).setLabel('스플릿').setStyle(ButtonStyle.Primary).setDisabled(!canSplit),
  )];
}

function blackjackEmbed(game, { revealDealer = false, completedHandIndex = null } = {}) {
  const activeHand = game.hands[game.activeHandIndex];
  const dealerValue = revealDealer
    ? `${blackjackCardsText(game.dealerCards)}\n**합계: ${blackjackScore(game.dealerCards).total}**`
    : `${blackjackCardsText([game.dealerCards[0]])} + ?\n**합계: ${blackjackScore([game.dealerCards[0]]).total} + ?**`;
  const split = game.hands.length > 1;
  const fields = [{ name: '딜러 카드', value: dealerValue }];
  game.hands.forEach((hand, index) => {
    if (completedHandIndex !== null && index !== completedHandIndex) return;
    const name = split ? `손 ${index + 1}` : '내 카드';
    const isCompleted = completedHandIndex === index;
    const marker = game.status === 'active' && index === game.activeHandIndex ? ' ← 진행 중' : '';
    const result = isCompleted ? blackjackOutcomeText(hand) : '';
    fields.push({ name: `${name}${marker}`, value: `${blackjackHandText(hand)}${result}`, inline: false });
  });
  const description = game.status === 'active'
    ? `베팅: **${moneyText(activeHand.bet)}** · 행동을 선택해주세요.`
    : '게임이 종료되었습니다.';
  const outcome = completedHandIndex === null ? null : game.hands[completedHandIndex].result;
  const color = game.status === 'active'
    ? 0x3498db
    : (outcome === '승리' || outcome === '블랙잭!' ? 0x2ecc71 : (outcome === '패배' ? 0xe74c3c : 0x3498db));
  return new EmbedBuilder()
    .setColor(color)
    .setTitle('🃏 블랙잭')
    .setDescription(description)
    .addFields(fields)
    .setFooter({ text: `딜러는 소프트 17에서 스탠드 · 블랙잭 배당 3:2` })
    .setTimestamp();
}

function blackjackDealerPlay(game) {
  while (blackjackScore(game.dealerCards).total < 17) game.dealerCards.push(blackjackDraw(game));
}

async function blackjackFinish(game) {
  blackjackDealerPlay(game);
  const dealerScore = blackjackScore(game.dealerCards).total;
  let payout = 0;
  for (const hand of game.hands) {
    const score = blackjackScore(hand.cards).total;
    if (score > 21) {
      hand.result = '패배';
      hand.payout = 0;
    } else if (dealerScore > 21 || score > dealerScore) {
      hand.result = '승리';
      hand.payout = hand.bet * 2;
    } else if (score === dealerScore) {
      hand.result = '무승부';
      hand.payout = hand.bet;
    } else {
      hand.result = '패배';
      hand.payout = 0;
    }
    payout += hand.payout;
  }
  game.status = 'completed';
  if (payout) await UserMoney.updateOne({ discordId: game.discordId }, { $inc: { balance: payout }, $set: { username: game.username } });
}

async function blackjackSettleInitialNaturals(game) {
  const playerBlackjack = blackjackScore(game.hands[0].cards).total === 21;
  const dealerBlackjack = blackjackScore(game.dealerCards).total === 21;
  if (!playerBlackjack && !dealerBlackjack) return false;
  const hand = game.hands[0];
  if (playerBlackjack && !dealerBlackjack) {
    hand.result = '블랙잭!';
    hand.payout = Math.floor(hand.bet * 2.5);
  } else if (playerBlackjack) {
    hand.result = '무승부';
    hand.payout = hand.bet;
  } else {
    hand.result = '패배';
    hand.payout = 0;
  }
  game.status = 'completed';
  if (hand.payout) await UserMoney.updateOne({ discordId: game.discordId }, { $inc: { balance: hand.payout }, $set: { username: game.username } });
  return true;
}

function parseBlackjackAmount(raw, balance) {
  const value = raw.trim();
  if (value === '올인') return balance;
  if (!/^\d[\d,]*$/.test(value)) return null;
  return Number(value.replaceAll(',', ''));
}

async function handleBlackjackCommand(interaction) {
  const account = await UserMoney.findOne({ discordId: interaction.user.id }).lean();
  if (!account) return interaction.reply({ content: '블랙잭을 하려면 먼저 `/가입` 명령어를 실행해주세요.', flags: MessageFlags.Ephemeral });
  const amount = parseBlackjackAmount(interaction.options.getString('머니', true), account.balance);
  if (!Number.isSafeInteger(amount) || amount < config.blackjackMinAmount) {
    return interaction.reply({ content: `베팅 금액은 ${moneyText(config.blackjackMinAmount)} 이상의 정수 또는 \`올인\`으로 입력해주세요.`, flags: MessageFlags.Ephemeral });
  }
  const charged = await UserMoney.findOneAndUpdate(
    { discordId: interaction.user.id, balance: { $gte: amount } },
    { $inc: { balance: -amount }, $set: { username: interaction.user.username } },
    { new: true },
  );
  if (!charged) return interaction.reply({ content: '보유 머니가 부족합니다.', flags: MessageFlags.Ephemeral });
  const game = {
    id: createBlackjackGameId(),
    discordId: interaction.user.id,
    username: interaction.user.username,
    deck: blackjackDeck(),
    dealerCards: [],
    hands: [{ cards: [], bet: amount, doubled: false, stood: false }],
    activeHandIndex: 0,
    status: 'active',
    locked: false,
  };
  game.hands[0].cards.push(blackjackDraw(game));
  game.dealerCards.push(blackjackDraw(game));
  game.hands[0].cards.push(blackjackDraw(game));
  game.dealerCards.push(blackjackDraw(game));
  const completed = await blackjackSettleInitialNaturals(game);
  if (!completed) addBlackjackGame(game);
  await interaction.reply({ embeds: [blackjackEmbed(game, { revealDealer: completed, completedHandIndex: completed ? 0 : null })], components: completed ? [] : blackjackButtons(game) });
}

async function handleBlackjackAction(interaction) {
  const [, gameId, action] = interaction.customId.split(':');
  const game = blackjackGames.get(gameId);
  if (!game || game.discordId !== interaction.user.id || game.status !== 'active') {
    return interaction.reply({ content: '이미 종료되었거나 만료된 블랙잭 게임입니다.', flags: MessageFlags.Ephemeral });
  }
  if (game.locked) return interaction.reply({ content: '이 블랙잭 게임의 이전 행동을 처리 중입니다.', flags: MessageFlags.Ephemeral });
  game.locked = true;
  try {
    const hand = game.hands[game.activeHandIndex];
    if (!hand) throw new Error('진행할 손을 찾을 수 없습니다.');
    if (action === 'hit') {
      hand.cards.push(blackjackDraw(game));
      if (blackjackScore(hand.cards).total >= 21) hand.stood = true;
    } else if (action === 'stand') {
      hand.stood = true;
    } else if (action === 'double') {
      if (hand.cards.length !== 2 || hand.doubled) throw new Error('더블 다운은 처음 받은 두 장의 카드에서만 가능합니다.');
      const account = await UserMoney.findOneAndUpdate({ discordId: game.discordId, balance: { $gte: hand.bet } }, { $inc: { balance: -hand.bet }, $set: { username: interaction.user.username } }, { new: true });
      if (!account) throw new Error('더블 다운에 필요한 머니가 부족합니다.');
      hand.bet *= 2;
      hand.doubled = true;
      hand.cards.push(blackjackDraw(game));
      hand.stood = true;
    } else if (action === 'split') {
      if (game.hands.length !== 1 || hand.cards.length !== 2
        || blackjackCardValue(hand.cards[0].rank) !== blackjackCardValue(hand.cards[1].rank)) {
        throw new Error('스플릿은 같은 점수 값의 처음 두 카드에서 한 번만 가능합니다.');
      }
      const account = await UserMoney.findOneAndUpdate({ discordId: game.discordId, balance: { $gte: hand.bet } }, { $inc: { balance: -hand.bet }, $set: { username: interaction.user.username } }, { new: true });
      if (!account) throw new Error('스플릿에 필요한 머니가 부족합니다.');
      const secondHand = { cards: [hand.cards.pop()], bet: hand.bet, doubled: false, stood: false };
      hand.cards.push(blackjackDraw(game));
      secondHand.cards.push(blackjackDraw(game));
      if (hand.cards[0].rank === 'A') {
        hand.stood = true;
        secondHand.stood = true;
      }
      game.hands.push(secondHand);
    } else throw new Error('알 수 없는 블랙잭 행동입니다.');

    while (game.activeHandIndex < game.hands.length && game.hands[game.activeHandIndex].stood) game.activeHandIndex += 1;
    if (game.activeHandIndex >= game.hands.length) await blackjackFinish(game);
    game.locked = false;
    if (game.status === 'active') {
      await interaction.update({ embeds: [blackjackEmbed(game)], components: blackjackButtons(game) });
      return;
    }
    blackjackGames.delete(game.id);
    const finalEmbeds = game.hands.map((_, index) => blackjackEmbed(game, { revealDealer: true, completedHandIndex: index }));
    await interaction.update({ embeds: [finalEmbeds[0]], components: [] });
    for (const embed of finalEmbeds.slice(1)) await interaction.followUp({ embeds: [embed] });
  } catch (error) {
    game.locked = false;
    throw error;
  }
}

module.exports = {
  handleBlackjackCommand,
  handleBlackjackAction,
};

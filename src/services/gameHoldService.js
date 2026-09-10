const { EmbedBuilder } = require('discord.js');
const GameHold = require('../models/GameHold');
const UserMoney = require('../models/UserMoney');
const { moneyText } = require('../utils/common');

// 게임 시작 시(베팅액을 UserMoney에서 차감한 직후) 호출한다.
// gameId는 games/* 도메인 파일이 이미 만들어 쓰고 있는 createGameId() 값을 그대로 재사용하면 된다.
async function recordGameHold({ gameId, discordId, username, gameType, amount }) {
  await GameHold.create({ gameId, discordId, username, gameType, amount });
}

// 더블다운/스플릿처럼 게임 진행 중 추가로 베팅액이 차감될 때, 보관된 금액도 함께 늘린다.
// (실제 UserMoney 차감은 각 게임 파일에서 이미 처리한 뒤 이 함수를 호출한다.)
async function increaseGameHold(gameId, extraAmount) {
  if (!extraAmount) return;
  await GameHold.updateOne({ gameId }, { $inc: { amount: extraAmount } });
}

// 게임이 정상적으로 끝났을 때(수령, 승패 정산 등 — 결과와 무관하게 게임이 종료되는 모든 경우) 호출한다.
// 반드시 게임을 인메모리 세션(gameSession.js 스토어)에서 지우는 시점과 함께 호출해야 한다.
async function releaseGameHold(gameId) {
  await GameHold.deleteOne({ gameId });
}

// 봇 시작 시 1회만 호출한다. 남아있는 보관 기록은 지난 실행에서 게임이 끝나기 전에
// 봇이 재시작/종료된 경우이므로, 차감됐던 금액을 그대로 환불하고 DM으로 알린다.
async function refundOrphanedGameHolds(client) {
  const holds = await GameHold.find().lean();
  if (holds.length === 0) return;

  console.log(`[gameHold] 비정상 종료된 게임 ${holds.length}건을 환불합니다.`);

  for (const hold of holds) {
    try {
      // findOneAndDelete로 원자적으로 선점한다 — 만에 하나 이 함수가 중복 실행되더라도
      // 같은 기록이 두 번 환불되는 것을 막는다.
      const claimed = await GameHold.findOneAndDelete({ _id: hold._id });
      if (!claimed) continue;

      const account = await UserMoney.findOneAndUpdate(
        { discordId: claimed.discordId },
        { $inc: { balance: claimed.amount } },
        { new: true },
      );

      if (!account) {
        console.error(`[gameHold] 환불 대상 유저 계정을 찾을 수 없습니다 (discordId=${claimed.discordId}, gameId=${claimed.gameId})`);
        continue;
      }

      try {
        const user = await client.users.fetch(claimed.discordId);
        await user.send({
          embeds: [new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle('⚠️ 진행 중이던 게임이 중단되어 환불되었습니다')
            .setDescription(
              `봇 재시작으로 인해 진행 중이던 **${claimed.gameType}** 게임이 중단되어, `
              + `걸었던 **${moneyText(claimed.amount)}**를 전액 환불해드렸습니다.`,
            )
            .addFields({ name: '현재 보유 머니', value: moneyText(account.balance), inline: true })
            .setTimestamp()],
        });
      } catch (dmError) {
        console.error(`[gameHold] 환불 DM 발송 실패 (discordId=${claimed.discordId})`, dmError);
      }
    } catch (error) {
      console.error(`[gameHold] 환불 처리 실패 (gameId=${hold.gameId})`, error);
    }
  }
}

module.exports = {
  recordGameHold,
  increaseGameHold,
  releaseGameHold,
  refundOrphanedGameHolds,
};

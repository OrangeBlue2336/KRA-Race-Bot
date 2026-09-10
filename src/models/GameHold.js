const mongoose = require('mongoose');

// 편자강화·블랙잭처럼 여러 번의 상호작용(버튼 클릭)에 걸쳐 진행되는 실시간 게임이
// 진행되는 동안, 이미 차감된 베팅액을 "누가/어떤 게임/얼마" 형태로 임시 보관하는 기록.
// - 게임 시작 시(베팅액 차감 직후) 생성한다.
// - 게임이 정상적으로 끝나면(수령/승패 정산 등) 즉시 삭제한다.
// - 봇이 재시작됐는데도 이 기록이 남아있다면, 지난 세션에서 게임이 비정상 종료된 것으로
//   간주해 봇 시작 시 자동으로 환불한다 (src/services/gameHoldService.js 참고).
// 새로운 실시간 게임을 추가할 때도 이 모델/서비스를 그대로 재사용하세요 — 게임별로
// 별도 스키마를 새로 만들지 마세요.
const gameHoldSchema = new mongoose.Schema(
  {
    gameId: { type: String, required: true, unique: true, index: true },
    discordId: { type: String, required: true, index: true },
    username: { type: String, required: true },
    // 예: '블랙잭', '편자강화' 등 사용자에게 보여줄 한국어 게임 이름.
    gameType: { type: String, required: true },
    // 현재 이 게임에 걸려 있는(차감된) 총 금액. 더블다운/스플릿처럼 진행 중
    // 추가로 차감되는 경우 gameHoldService.increaseGameHold로 갱신한다.
    amount: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('GameHold', gameHoldSchema);

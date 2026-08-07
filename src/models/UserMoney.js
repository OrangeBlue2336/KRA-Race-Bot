const mongoose = require('mongoose');

const userMoneySchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    balance: { type: Number, required: true, default: 0, min: 0 },
    guildIds: [{ type: String }],
    lastDailyDate: { type: String, default: '' },
    dailyStreak: { type: Number, default: 0 },
  },
  { timestamps: true },
);

userMoneySchema.index({ balance: -1 });
userMoneySchema.index({ guildIds: 1, balance: -1 });

module.exports = mongoose.model('UserMoney', userMoneySchema);

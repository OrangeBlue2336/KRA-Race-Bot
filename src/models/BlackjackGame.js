const mongoose = require('mongoose');

const blackjackGameSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, index: true },
    username: { type: String, required: true },
    deck: { type: [mongoose.Schema.Types.Mixed], required: true },
    dealerCards: { type: [mongoose.Schema.Types.Mixed], required: true },
    hands: { type: [mongoose.Schema.Types.Mixed], required: true },
    activeHandIndex: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'completed'], default: 'active', index: true },
    locked: { type: Boolean, default: false },
  },
  { timestamps: true },
);

blackjackGameSchema.index({ discordId: 1, status: 1 });

module.exports = mongoose.model('BlackjackGame', blackjackGameSchema);

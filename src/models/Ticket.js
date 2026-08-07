const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, index: true },
    username: { type: String, required: true },
    guildId: { type: String },
    channelId: { type: String },

    meetCode: { type: String, required: true },
    meet: { type: String, required: true },
    rcDate: { type: String, required: true, index: true },
    rcNo: { type: Number, required: true },
    schStTime: { type: String, required: true },

    betType: { type: String, required: true },
    horses: [{ type: String, required: true }],
    amount: { type: Number, required: true },
    dusu: { type: Number, default: 0 },
    isTest: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ['draft', 'pending', 'checking', 'won', 'lost', 'void'],
      default: 'pending',
      index: true,
    },
    odds: { type: Number, default: 0 },
    payout: { type: Number, default: 0 },
    moneyRewarded: { type: Boolean, default: false },
    resultTop3: [
      {
        ord: Number,
        chulNo: String,
        hrName: String,
      },
    ],
    alertNotifiedEventKeys: [{ type: String }],
    voidNotifiedEventKeys: [{ type: String }],
    voidReason: { type: String },
    alertError: { type: String },
    settlementError: { type: String },
    settledAt: { type: Date },
  },
  {
    timestamps: true,
  },
);

ticketSchema.index({ discordId: 1, meetCode: 1, rcDate: 1, rcNo: 1, status: 1 });

ticketSchema.index({ status: 1, createdAt: 1 });

ticketSchema.index(
  { settledAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);

module.exports = mongoose.model('Ticket', ticketSchema);

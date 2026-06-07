const mongoose = require('mongoose');

const alertSubscriptionSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, index: true },
    username: { type: String, required: true },
    meetCode: { type: String, required: true, index: true },
    meet: { type: String, required: true },
    alertType: {
      type: String,
      enum: ['JOCKEY_CHANGE', 'HORSE_CANCEL'],
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

alertSubscriptionSchema.index(
  { discordId: 1, meetCode: 1, alertType: 1 },
  { unique: true },
);

module.exports = mongoose.model('AlertSubscription', alertSubscriptionSchema);

const mongoose = require('mongoose');

const stockPriceHistorySchema = new mongoose.Schema(
  {
    price: { type: Number, required: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const stockSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 1 },
    previousPrice: { type: Number, required: true, min: 1 },
    priceHistory: [stockPriceHistorySchema],
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model('Stock', stockSchema);
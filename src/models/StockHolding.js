const mongoose = require('mongoose');

const stockHoldingSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, index: true },
    username: { type: String, required: true },
    stockCode: { type: String, required: true, index: true },
    quantity: { type: Number, required: true, default: 0, min: 0 },
    // 평균단가를 직접 저장하지 않고 매입원가 합계만 저장한다. 매수 시 $inc로 원자적으로
    // 누적하고, 표시할 때 totalCost / quantity로 평균단가를 계산한다.
    totalCost: { type: Number, required: true, default: 0, min: 0 },
  },
  {
    timestamps: true,
  },
);

stockHoldingSchema.index({ discordId: 1, stockCode: 1 }, { unique: true });

module.exports = mongoose.model('StockHolding', stockHoldingSchema);

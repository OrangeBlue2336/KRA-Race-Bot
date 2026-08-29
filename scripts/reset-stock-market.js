require('dotenv').config();

const mongoose = require('mongoose');
const config = require('../src/config');
const Stock = require('../src/models/Stock');
const StockHolding = require('../src/models/StockHolding');
const UserMoney = require('../src/models/UserMoney');

const EXECUTE_FLAG = '--execute';
const CONFIRMATION_VALUE = 'RESET_ALL_STOCKS';

function buildSeedStocks() {
  const now = new Date();
  return config.STOCKS.map((definition) => ({
    code: definition.code,
    name: definition.name,
    price: definition.initialPrice,
    previousPrice: definition.initialPrice,
    priceHistory: [{ price: definition.initialPrice, at: now }],
  }));
}

async function buildSummary() {
  const [stocks, holdings] = await Promise.all([
    Stock.find({}).lean(),
    StockHolding.find({ quantity: { $gt: 0 } }).lean(),
  ]);
  const refunds = new Map();
  for (const holding of holdings) {
    refunds.set(holding.discordId, (refunds.get(holding.discordId) || 0) + holding.totalCost);
  }
  return {
    stockCount: stocks.length,
    holdingCount: holdings.length,
    userCount: refunds.size,
    refundTotal: [...refunds.values()].reduce((total, amount) => total + amount, 0),
    refunds,
  };
}

function printSummary(summary, databaseName) {
  console.log(`대상 DB: ${databaseName}`);
  console.log(`현재 종목: ${summary.stockCount}개`);
  console.log(`삭제할 보유 내역: ${summary.holdingCount}건`);
  console.log(`환불 대상 사용자: ${summary.userCount}명`);
  console.log(`환불할 총 매입원가: ${summary.refundTotal.toLocaleString()}머니`);
}

async function resetStockMarket(summary) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const discordIds = [...summary.refunds.keys()];
      const accounts = await UserMoney.find({ discordId: { $in: discordIds } }).session(session).lean();
      const accountIds = new Set(accounts.map((account) => account.discordId));
      const missingAccountIds = discordIds.filter((discordId) => !accountIds.has(discordId));
      if (missingAccountIds.length > 0) {
        throw new Error(`보유 내역과 연결되지 않은 사용자 계정 ${missingAccountIds.length}개가 있습니다. 리셋을 중단합니다.`);
      }

      if (summary.refunds.size > 0) {
        await UserMoney.bulkWrite(
          [...summary.refunds].map(([discordId, refund]) => ({
            updateOne: { filter: { discordId }, update: { $inc: { balance: refund } } },
          })),
          { session },
        );
      }

      await StockHolding.deleteMany({}, { session });
      await Stock.deleteMany({}, { session });
      await Stock.insertMany(buildSeedStocks(), { session });
    });
  } finally {
    await session.endSession();
  }
}

async function main() {
  if (!config.mongoUri) throw new Error('MONGODB_URI가 설정되어 있지 않습니다.');
  await mongoose.connect(config.mongoUri);
  try {
    const summary = await buildSummary();
    printSummary(summary, mongoose.connection.name);

    if (!process.argv.includes(EXECUTE_FLAG)) {
      console.log('검증 모드입니다. 변경하지 않았습니다. 운영 DB에서 실행하려면 --execute와 확인 환경변수를 함께 지정하세요.');
      return;
    }
    if (process.env.NODE_ENV !== 'production') {
      throw new Error('실행 모드는 NODE_ENV=production 환경에서만 허용됩니다.');
    }
    if (process.env.STOCK_MARKET_RESET_CONFIRM !== CONFIRMATION_VALUE) {
      throw new Error(`실행하려면 STOCK_MARKET_RESET_CONFIRM=${CONFIRMATION_VALUE}를 설정해야 합니다.`);
    }

    await resetStockMarket(summary);
    console.log('주식 시장을 초기화했습니다. 보유 주식은 매입원가만큼 환불했고, 모든 종목은 초기 가격과 새 그래프로 재생성했습니다.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error('[stock market reset]', error);
  process.exitCode = 1;
});

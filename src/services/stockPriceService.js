const Stock = require('../models/Stock');
const config = require('../config');

let workerTimer = null;
let workerRunning = false;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

// 봇이 처음 켜졌을 때(또는 DB가 비어있을 때) config.STOCKS에 정의된 5개 종목을 생성한다.
// 이미 존재하는 종목은 건드리지 않으므로 재시작해도 가격이 초기화되지 않는다.
async function ensureStocksSeeded() {
  for (const definition of config.STOCKS) {
    const exists = await Stock.findOne({ code: definition.code }).lean();
    if (exists) continue;
    await Stock.create({
      code: definition.code,
      name: definition.name,
      price: definition.initialPrice,
      previousPrice: definition.initialPrice,
      priceHistory: [{ price: definition.initialPrice, at: new Date() }],
    });
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// 종목별 변동성과 기준가 복귀를 조합해 다음 가격을 계산한다.
// 순수 랜덤워크는 변동성이 클수록 장기적으로 바닥에 쏠리므로, initialPrice에서
// 멀어진 정도에 비례한 작은 보정과 종목별 가격 밴드를 함께 적용한다.
function nextPrice(stock, definition) {
  const direction = Math.random() < 0.5 ? -1 : 1;
  const randomPercent = randomBetween(definition.minChangePercent, definition.maxChangePercent) * direction;
  const distanceFromInitialPercent = ((definition.initialPrice - stock.price) / definition.initialPrice) * 100;
  const meanReversionPercent = clamp(
    distanceFromInitialPercent * config.stockMeanReversionStrength,
    -config.stockMaxMeanReversionPercent,
    config.stockMaxMeanReversionPercent,
  );
  const raw = Math.round(stock.price * (1 + (randomPercent + meanReversionPercent) / 100));
  const minPrice = Math.max(config.stockMinPrice, Math.round(definition.initialPrice * definition.minPriceRatio));
  const maxPrice = Math.round(definition.initialPrice * definition.maxPriceRatio);
  return clamp(raw, minPrice, maxPrice);
}

async function tickStock(definition) {
  const stock = await Stock.findOne({ code: definition.code });
  if (!stock) return;

  const price = nextPrice(stock, definition);
  stock.previousPrice = stock.price;
  stock.price = price;
  stock.priceHistory.push({ price, at: new Date() });
  if (stock.priceHistory.length > config.stockHistoryLength) {
    stock.priceHistory = stock.priceHistory.slice(-config.stockHistoryLength);
  }
  await stock.save();
}

async function tickAllStocks() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    await ensureStocksSeeded();
    for (const definition of config.STOCKS) {
      await tickStock(definition);
    }
  } finally {
    workerRunning = false;
  }
}

function startStockPriceWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    tickAllStocks().catch((error) => console.error('[stock price worker]', error));
  }, config.stockPriceIntervalMs);

  tickAllStocks().catch((error) => console.error('[stock price worker]', error));
}

module.exports = {
  startStockPriceWorker,
  ensureStocksSeeded,
  tickAllStocks,
  nextPrice,
};

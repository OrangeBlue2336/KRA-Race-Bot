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

// 종목별 변동성(definition)을 기반으로 다음 가격을 계산한다.
// minChangePercent~maxChangePercent 사이의 랜덤워크만 적용한다 (급등락 이벤트 없음).
function nextPrice(stock, definition) {
  const direction = Math.random() < 0.5 ? -1 : 1;
  const percent = randomBetween(definition.minChangePercent, definition.maxChangePercent) * direction;
  const raw = Math.round(stock.price * (1 + percent / 100));
  const price = Math.max(config.stockMinPrice, raw);
  return price;
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
};
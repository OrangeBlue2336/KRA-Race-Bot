const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// 프로젝트에 내장된 한글 폰트를 등록한다. 서버(OS)에 한글 폰트가 없어도
// 그래프의 한글(종목명 등)이 네모(□)로 깨지지 않도록 하기 위함.
// 이미 등록되어 있으면 다시 등록하지 않는다 (핫리로드/재호출 대비).
const FONT_FAMILY = 'GyeonggiTitleM';
if (!GlobalFonts.has(FONT_FAMILY)) {
  GlobalFonts.registerFromPath(
    path.join(__dirname, '..', '..', 'assets', 'fonts', '경기천년제목_M.woff2'),
    FONT_FAMILY,
  );
}

const CHART_WIDTH = 800;
const CHART_HEIGHT = 420;
const PADDING = {
  top: 30, right: 30, bottom: 46, left: 96,
};

const BACKGROUND_COLOR = '#111318';
const GRID_COLOR = 'rgba(255, 255, 255, 0.08)';
const AXIS_TEXT_COLOR = '#9aa0ab';
const LEGEND_TEXT_COLOR = '#e4e6eb';

// 가격 범위를 보기 좋은 눈금 간격(1/2/5/10의 배수)으로 반올림한다.
function niceStep(range, targetSteps = 6) {
  if (range <= 0) return 1;
  const rough = range / targetSteps;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  let step;
  if (normalized < 1.5) step = 1;
  else if (normalized < 3) step = 2;
  else if (normalized < 7) step = 5;
  else step = 10;
  return step * magnitude;
}

function formatTime(value) {
  const date = new Date(value);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// stock: { name, price, priceHistory: [{ price, at }] }, color: '#rrggbb'
function renderStockChart(stock, color) {
  const history = stock.priceHistory && stock.priceHistory.length
    ? stock.priceHistory
    : [{ price: stock.price, at: new Date() }];

  const canvas = createCanvas(CHART_WIDTH, CHART_HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(0, 0, CHART_WIDTH, CHART_HEIGHT);

  const prices = history.map((point) => point.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const step = niceStep(maxPrice - minPrice || Math.max(maxPrice * 0.05, 1));
  const yMin = Math.max(0, Math.floor(minPrice / step) * step - step);
  const yMax = Math.ceil(maxPrice / step) * step + step;

  const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

  const toX = (index) => PADDING.left + (history.length === 1
    ? plotWidth / 2
    : (index / (history.length - 1)) * plotWidth);
  const toY = (price) => PADDING.top + plotHeight - ((price - yMin) / (yMax - yMin)) * plotHeight;

  // 가로 그리드 라인 + Y축(가격) 라벨
  ctx.font = `16px ${FONT_FAMILY}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let value = yMin; value <= yMax + 0.0001; value += step) {
    const y = toY(value);
    ctx.strokeStyle = GRID_COLOR;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(CHART_WIDTH - PADDING.right, y);
    ctx.stroke();
    ctx.fillStyle = AXIS_TEXT_COLOR;
    ctx.fillText(Math.round(value).toLocaleString(), PADDING.left - 12, y);
  }
  ctx.setLineDash([]);

  // X축(시간) 라벨 — 최대 8개, 마지막 라벨과 너무 가까우면 겹치므로 건너뛴다.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const maxLabels = Math.min(8, history.length);
  const labelStep = Math.max(1, Math.round((history.length - 1) / Math.max(maxLabels - 1, 1)));
  const minLabelGapPx = 50;
  const lastIndex = history.length - 1;
  const lastX = toX(lastIndex);
  for (let index = 0; index < history.length; index += labelStep) {
    const x = toX(index);
    if (index !== lastIndex && Math.abs(lastX - x) < minLabelGapPx) continue;
    ctx.fillStyle = AXIS_TEXT_COLOR;
    ctx.fillText(formatTime(history[index].at || Date.now()), x, CHART_HEIGHT - PADDING.bottom + 12);
  }
  ctx.fillStyle = AXIS_TEXT_COLOR;
  ctx.fillText(formatTime(history[lastIndex].at || Date.now()), lastX, CHART_HEIGHT - PADDING.bottom + 12);

  // 가격 선 그래프
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  history.forEach((point, index) => {
    const x = toX(index);
    const y = toY(point.price);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 마지막 지점 강조 점
  const lastPoint = history[lastIndex];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(toX(lastIndex), toY(lastPoint.price), 5, 0, Math.PI * 2);
  ctx.fill();

  // 범례 (좌하단 색상 박스 + 종목명)
  ctx.fillStyle = color;
  ctx.fillRect(PADDING.left, 6, 14, 14);
  ctx.fillStyle = LEGEND_TEXT_COLOR;
  ctx.font = `16px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(stock.name, PADDING.left + 20, 13);

  return canvas.toBuffer('image/png');
}

module.exports = {
  renderStockChart,
};

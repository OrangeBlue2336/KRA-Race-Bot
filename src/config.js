require('dotenv').config();

const BET_TYPES = [
  {
    name: '단승식',
    horseCount: 1,
    description: '1등으로 도착할 말 1두를 적중시키는 방식입니다.',
  },
  {
    name: '연승식',
    horseCount: 1,
    description: '1~3등 안에 들어올 말 1두를 적중시키는 방식입니다. 출전두수 7두 이하일 때는 2등 이내입니다.',
  },
  {
    name: '복연승식',
    horseCount: 2,
    description: '1~3등 안에 들어올 말 2두를 순서에 상관없이 적중시키는 방식입니다.',
  },
  {
    name: '복승식',
    horseCount: 2,
    description: '1등과 2등으로 들어올 말 2두를 순서에 상관없이 적중시키는 방식입니다.',
  },
  {
    name: '쌍승식',
    horseCount: 2,
    description: '1등과 2등으로 들어올 말 2두를 순서대로 적중시키는 방식입니다.',
  },
  {
    name: '삼복승식',
    horseCount: 3,
    description: '1등, 2등 및 3등으로 들어올 말 3두를 순서에 상관없이 적중시키는 방식입니다.',
  },
  {
    name: '삼쌍승식',
    horseCount: 3,
    description: '1등, 2등, 3등으로 들어올 말 3두를 순서대로 적중시키는 방식입니다.',
  },
];

const BET_TYPE_BY_NAME = Object.fromEntries(BET_TYPES.map((betType) => [betType.name, betType]));

const MEETS = [
  {
    code: 'SEOUL',
    apiMeet: '1',
    name: '서울',
    description: '서울경마공원',
  },
  {
    code: 'BUSAN',
    apiMeet: '3',
    name: '부산경남',
    description: '부산경남경마공원',
  },
  {
    code: 'JEJU',
    apiMeet: '2',
    name: '제주',
    description: '제주경마공원',
  },
];

const MEET_BY_CODE = Object.fromEntries(MEETS.map((meet) => [meet.code, meet]));
const renderExternalUrl = process.env.RENDER_EXTERNAL_URL
  || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '');

module.exports = {
  discordToken: process.env.DISCORD_TOKEN,
  discordClientId: process.env.DISCORD_CLIENT_ID,
  discordGuildId: process.env.DISCORD_GUILD_ID || '',
  mongoUri: process.env.MONGODB_URI,
  kraServiceKey: process.env.KRA_SERVICE_KEY,
  nodeEnv: process.env.NODE_ENV || 'development',
  resultCheckIntervalMs: Number(process.env.RESULT_CHECK_INTERVAL_MS || 60_000),
  resultCheckDelayMinutes: Number(process.env.RESULT_CHECK_DELAY_MINUTES || 10),
  alertCheckIntervalMs: Number(process.env.ALERT_CHECK_INTERVAL_MS || 5 * 60_000),
  ticketCloseBeforeStartMinutes: Number(process.env.TICKET_CLOSE_BEFORE_START_MINUTES || 5),
  maxRaceBetAmount: Number(process.env.MAX_RACE_BET_AMOUNT || 100_000),
  port: Number(process.env.PORT || 3000),
  keepAliveUrl: process.env.KEEP_ALIVE_URL || renderExternalUrl,
  keepAliveIntervalMs: Number(process.env.KEEP_ALIVE_INTERVAL_MS || 10 * 60_000),
  BET_TYPES,
  BET_TYPE_BY_NAME,
  MEETS,
  MEET_BY_CODE,
};

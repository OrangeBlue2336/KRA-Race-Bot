const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const config = require('./config');

const commands = [
  new SlashCommandBuilder()
  .setName('마권발매')
  .setDescription('실제 경마 결과와 연동되는 가상 마권을 발매합니다.')
  .addStringOption((option) => option
    .setName('경마장')
    .setDescription('베팅할 경마장을 선택합니다.')
    .setRequired(true)
    .addChoices(
      ...config.MEETS.map((meet) => ({ name: meet.name, value: meet.code })),
    ))
  .toJSON(),
  new SlashCommandBuilder()
    .setName('내마권')
    .setDescription('지금까지 발매한 내 가상 마권 내역을 확인합니다.')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('경마일정')
    .setDescription('오늘부터 1주일 동안의 경마 일정을 확인합니다.')
    .addStringOption((option) => option
      .setName('경마장')
      .setDescription('일정을 확인할 경마장을 선택합니다.')
      .setRequired(true)
      .addChoices(
        ...config.MEETS.map((meet) => ({ name: meet.name, value: meet.code })),
      ))
    .toJSON(),
];

async function main() {
  if (!config.discordToken || !config.discordClientId) {
    throw new Error('DISCORD_TOKEN, DISCORD_CLIENT_ID 환경변수가 필요합니다.');
  }

  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  if (config.discordGuildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
      { body: commands },
    );
    console.log(`길드 명령어 등록 완료: ${config.discordGuildId}`);
    return;
  }

  await rest.put(
    Routes.applicationCommands(config.discordClientId),
    { body: commands },
  );
  console.log('전역 명령어 등록 완료');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

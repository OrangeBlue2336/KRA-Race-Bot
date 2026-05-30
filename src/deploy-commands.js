const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const config = require('./config');

const commands = [
  new SlashCommandBuilder()
    .setName('마권발매')
    .setDescription('실제 경마 결과와 연동되는 가상 마권을 발매합니다.')
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

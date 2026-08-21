"use strict";

const {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
} = require("discord.js");

const STRUCTURE = [
  ["🌐 투자위원회", ["라운지", "시장-브리핑", "종목-토론", "라운드테이블"]],
  ["🇺🇸 미국주식", ["미국-전체신호", "미국-관찰신호", "미국-진입신호", "미국-청산신호", "미국-매매신호"]],
  ["🇰🇷 국내주식", ["국장-전체신호", "국장-관찰신호", "국장-진입신호", "국장-청산신호", "국장-매매신호"]],
  ["📚 투자기록", ["관심종목", "알람설정", "매매일지", "전략-연구", "주요인사-포트폴리오", "기관-포트폴리오", "내-포트폴리오"]],
  ["🤖 주문관리", ["주문승인", "체결로그", "시스템상태"]],
];

const CATEGORY_RENAMES = new Map([
  ["💬 투자위원회", "🌐 투자위원회"],
  ["🤖 자동매매", "🤖 주문관리"],
]);

const token = process.env.DISCORD_TOKEN_DRUCKENMILLER;
const configuredGuildId = process.env.DISCORD_GUILD_ID;

if (!token) {
  console.error("DISCORD_TOKEN_DRUCKENMILLER 환경변수가 필요합니다. 먼저 source .env를 실행하세요.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    const guild = selectGuild();
    const member = await guild.members.fetchMe();
    if (!member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      throw new Error(`'${guild.name}' 서버에서 드러켄밀러 봇에 '채널 관리' 권한이 없습니다.`);
    }

    for (const [oldName, newName] of CATEGORY_RENAMES) {
      const oldCategory = guild.channels.cache.find(
        (channel) => channel.type === ChannelType.GuildCategory && channel.name === oldName,
      );
      const newCategory = guild.channels.cache.find(
        (channel) => channel.type === ChannelType.GuildCategory && channel.name === newName,
      );
      if (oldCategory && !newCategory) await oldCategory.setName(newName);
    }

    const oldSignalChannel = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === "매매신호",
    );
    if (oldSignalChannel) await oldSignalChannel.setName("매매신호-이전기록");

    for (const [categoryName, channelNames] of STRUCTURE) {
      let category = guild.channels.cache.find(
        (channel) => channel.type === ChannelType.GuildCategory && channel.name === categoryName,
      );
      if (!category) {
        category = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
        console.log(`생성: ${categoryName}`);
      } else {
        console.log(`존재: ${categoryName}`);
      }

      for (const channelName of channelNames) {
        let channel = guild.channels.cache.find(
          (candidate) => candidate.type === ChannelType.GuildText && candidate.name === channelName,
        );
        if (!channel) {
          channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category.id,
          });
          console.log(`  생성: #${channelName}`);
        } else {
          if (channel.parentId !== category.id) await channel.setParent(category.id);
          console.log(`  존재: #${channelName}`);
        }
      }
    }
    console.log(`완료: '${guild.name}' 서버 채널 구성을 만들었습니다.`);
  } catch (error) {
    console.error(`설정 실패: ${error.message}`);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

function selectGuild() {
  if (configuredGuildId) {
    const guild = client.guilds.cache.get(configuredGuildId);
    if (!guild) throw new Error(`DISCORD_GUILD_ID=${configuredGuildId} 서버를 찾지 못했습니다.`);
    return guild;
  }
  if (client.guilds.cache.size !== 1) {
    throw new Error("봇이 여러 서버에 있습니다. .env에 DISCORD_GUILD_ID를 지정하세요.");
  }
  return client.guilds.cache.first();
}

client.login(token).catch((error) => {
  console.error(`Discord 로그인 실패: ${error.message}`);
  process.exitCode = 1;
});

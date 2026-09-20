"use strict";

const {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
} = require("discord.js");
const { US_CHANNELS } = require("../src/discord/us-signal-cards");

const STRUCTURE = [
  ["🌐 투자위원회", ["라운지", "시장-브리핑", "종목-토론"]],
  ["🇺🇸 미국주식", US_CHANNELS],
  ["🇰🇷 국내주식", ["국장-전체신호", "국장-관찰신호", "국장-진입신호", "국장-청산신호", "국장-매매신호"]],
  ["📚 투자기록", ["관심종목", "알람설정", "어닝-캘린더", "매매일지", "전략-연구", "주요인사-포트폴리오", "기관-포트폴리오", "내-포트폴리오"]],
  ["🤖 주문관리", ["주문승인", "체결로그", "시스템상태", "미국-매매신호"]],
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
    if (process.argv.includes("--us-only")) {
      await migrateUsChannels(guild, process.argv.includes("--apply"));
      return;
    }
    if (["🇺🇸 미국주식", "🤖 주문관리", "📚 투자기록"].every(name => guild.channels.cache.some(c => c.name === name))) await migrateUsChannels(guild, true);

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

async function migrateUsChannels(guild, apply) {
  await guild.channels.fetch();
  const find = name => guild.channels.cache.find(c => c.name === name);
  const category = find("🇺🇸 미국주식"), operations = find("🤖 주문관리"), archive = find("📚 투자기록");
  if (![category, operations, archive].every(c => c?.type === ChannelType.GuildCategory)) throw new Error("기존 미국주식·주문관리·투자기록 카테고리를 확인해야 합니다.");
  const renames = [["미국-관찰신호", "관찰"], ["미국-진입신호", "진입"], ["미국-청산신호", "청산"]];
  for (const name of US_CHANNELS) if (find(name) && find(name).parentId !== category.id) throw new Error(`다른 카테고리의 동명 채널: ${name}`);
  for (const [oldName, newName] of renames) {
    const old = find(oldName), existing = find(newName);
    if (old && existing && old.id !== existing.id) throw new Error(`중복 채널 확인 필요: ${newName}`);
    if (existing && existing.parentId !== category.id) throw new Error(`다른 카테고리의 동명 채널: ${newName}`);
    if (old && old.parentId !== category.id) throw new Error(`기존 채널 위치 확인 필요: ${oldName}`);
    if (old) { console.log(`${apply ? "변경" : "예정"}: ${oldName} → ${newName} (ID·권한·기록 유지)`); if (apply) await old.setName(newName); }
  }
  const transport = find("미국-매매신호");
  if (!transport) throw new Error("기존 미국 주문 전달 채널이 없습니다. 자동 생성하지 않습니다.");
  const transportId = transport.id, permissions = JSON.stringify(transport.permissionOverwrites.cache.toJSON());
  for (const [name, parent] of [["미국-매매신호", operations], ["미국-전체신호", archive]]) {
    const channel = find(name);
    if (channel && channel.parentId !== parent.id) {
      console.log(`${apply ? "이동" : "예정"}: ${name} → ${parent.name} (기록·권한 유지)`);
      if (apply) await channel.setParent(parent.id, { lockPermissions: false });
    }
  }
  for (const name of US_CHANNELS) {
    const existing = find(name) || (!apply && find(renames.find(pair => pair[1] === name)?.[0]));
    if (existing && existing.parentId !== category.id) throw new Error(`다른 위치의 동명 채널: ${name}`);
    if (!existing) {
      console.log(`${apply ? "생성" : "예정"}: ${name}`);
      if (apply) await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id,
        permissionOverwrites: category.permissionOverwrites.cache.map(p => ({ id: p.id, type: p.type, allow: p.allow.bitfield, deny: p.deny.bitfield })) });
    }
  }
  if (apply) {
    await guild.channels.setPositions(US_CHANNELS.map((name, position) => ({ channel: find(name).id, position })));
    await guild.channels.fetch();
    const preserved = find("미국-매매신호");
    if (preserved.id !== transportId || JSON.stringify(preserved.permissionOverwrites.cache.toJSON()) !== permissions) throw new Error("주문 전달 채널 ID/권한 보존 검증 실패");
    const children = [...guild.channels.cache.values()].filter((c: any) => c.parentId === category.id).sort((a: any, b: any) => a.position - b.position).map((c: any) => c.name);
    if (JSON.stringify(children) !== JSON.stringify(US_CHANNELS)) throw new Error("미국주식 10개 채널/순서 검증 실패");
    console.log("검증 완료: 미국주식 10개 채널 · 주문 전달 ID/권한 유지 · 삭제 없음");
  }
}

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

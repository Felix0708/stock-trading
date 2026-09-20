"use strict";

const {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
} = require("discord.js");
const { SIGNAL_CHANNELS, SIGNAL_MARKETS, marketChannelName } = require("../src/signals/signal-market");

const STRUCTURE = [
  ["🌐 투자위원회", ["라운지", "시장-브리핑", "종목-토론"]],
  ...SIGNAL_MARKETS.map(m => [m.category, SIGNAL_CHANNELS.map(n => marketChannelName(m, n))]),
  ["📚 투자기록", ["관심종목", "알람설정", "어닝-캘린더", "매매일지", "전략-연구", "주요인사-포트폴리오", "기관-포트폴리오", "내-포트폴리오"]],
  ["🤖 주문관리", ["주문승인", "체결로그", "시스템상태", "미국-매매신호", "국장-매매신호"]],
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
    if (process.argv.includes("--us-only") || process.argv.includes("--markets")) {
      await migrateMarketChannels(guild, process.argv.includes("--apply"), process.argv.includes("--us-only") ? SIGNAL_MARKETS.slice(0, 1) : SIGNAL_MARKETS);
      return;
    }
    if (["🇺🇸 미국주식", "🤖 주문관리", "📚 투자기록"].every(name => guild.channels.cache.some(c => c.name === name))) await migrateMarketChannels(guild, true);

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
          (candidate) => candidate.type === ChannelType.GuildText && candidate.name === channelName && candidate.parentId === category.id,
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

async function migrateMarketChannels(guild, apply, markets = SIGNAL_MARKETS) {
  await guild.channels.fetch();
  const find = (name, parentId = undefined) => {
    const matches = guild.channels.cache.filter(c => c.name === name && (!parentId || c.parentId === parentId));
    if (matches.size > 1) throw new Error(`동명 채널 중복 확인 필요: ${name}`);
    return matches.first();
  };
  const operations = find("🤖 주문관리"), archive = find("📚 투자기록"), template = find("🇺🇸 미국주식");
  if (![operations, archive, template].every(c => c?.type === ChannelType.GuildCategory)) throw new Error("기존 시장·주문관리·투자기록 카테고리를 확인해야 합니다.");
  const permissions = c => c.permissionOverwrites.cache.map(p => ({ id: p.id, type: p.type, allow: p.allow.bitfield, deny: p.deny.bitfield }));
  const fingerprint = c => JSON.stringify(permissions(c).map(p => ({ ...p, allow: String(p.allow), deny: String(p.deny) })).sort((a, b) => a.id.localeCompare(b.id)));
  const preserved = [];
  // Preflight all markets before any write. Never recreate a missing order transport.
  for (const market of markets) {
    const category = find(market.category);
    if (category && category.type !== ChannelType.GuildCategory) throw new Error(`카테고리 유형 불일치: ${market.category}`);
    if (market.transport) {
      const transport = find(market.transport);
      if (transport?.type !== ChannelType.GuildText) throw new Error(`기존 주문 전달 채널 확인 필요: ${market.transport}`);
      preserved.push({ id: transport.id, name: transport.name, permissions: fingerprint(transport) });
    }
    for (const name of SIGNAL_CHANNELS) {
      const target = marketChannelName(market, name), existing = find(target);
      if (existing && existing.parentId !== category?.id) throw new Error(`다른 위치의 채널: ${target}`);
      const oldNames = [name, ...(market.legacy && ["관찰", "진입", "청산"].includes(name) ? [`${market.legacy}-${name}신호`] : [])];
      const candidates = category ? oldNames.map(n => find(n, category.id)).filter(Boolean) : [];
      if (candidates.length + Number(Boolean(existing)) > 1) throw new Error(`병합 대신 확인 필요: ${target}`);
    }
  }
  const removeUsAll = process.argv.includes("--delete-us-all");
  const obsolete = find("미국-전체신호");
  if (removeUsAll && obsolete && (obsolete.type !== ChannelType.GuildText || ![template.id, archive.id, operations.id].includes(obsolete.parentId))) throw new Error("미국 전체신호 삭제 대상 위치 확인 필요");
  for (const market of markets) {
    let category = find(market.category);
    if (!category) {
      console.log(`${apply ? "생성" : "예정"}: ${market.category}`);
      if (apply) category = await guild.channels.create({ name: market.category, type: ChannelType.GuildCategory, permissionOverwrites: permissions(template) });
    }
    for (const [name, parent] of [[market.transport, operations], [market.legacy && `${market.legacy}-전체신호`, archive]]) {
      const channel = name && find(name);
      if (removeUsAll && channel?.id === obsolete?.id) continue;
      if (channel && channel.parentId !== parent.id) {
        console.log(`${apply ? "이동" : "예정"}: ${name} → ${parent.name} (기록·권한 유지)`);
        if (apply) await channel.setParent(parent.id, { lockPermissions: false });
      }
    }
    for (const name of SIGNAL_CHANNELS) {
      const target = marketChannelName(market, name);
      if (find(target)) continue;
      const old = category && (find(name, category.id) || (market.legacy && ["관찰", "진입", "청산"].includes(name) && find(`${market.legacy}-${name}신호`, category.id)));
      console.log(`${apply ? old ? "변경" : "생성" : "예정"}: ${old ? `${old.name} → ` : ""}${target}`);
      if (apply) {
        if (old) await old.setName(target);
        else await guild.channels.create({ name: target, type: ChannelType.GuildText, parent: category.id, permissionOverwrites: permissions(category) });
      }
    }
    if (apply) {
      const names = SIGNAL_CHANNELS.map(n => marketChannelName(market, n));
      await guild.channels.setPositions(names.map((name, position) => ({ channel: find(name, category.id).id, position })));
      await guild.channels.fetch();
      const children = [...guild.channels.cache.values()].filter((c: any) => c.parentId === category.id).sort((a: any, b: any) => a.position - b.position).map((c: any) => c.name);
      if (JSON.stringify(children) !== JSON.stringify(names)) throw new Error(`${market.category} 10개 채널/순서 검증 실패`);
      console.log(`검증 완료: ${market.category} 10개 채널`);
    }
  }
  if (apply) for (const original of preserved) {
    const channel = find(original.name);
    if (channel?.id !== original.id || fingerprint(channel) !== original.permissions) throw new Error("주문 전달 채널 ID/권한 보존 검증 실패");
  }
  if (removeUsAll && obsolete) {
    console.log(`${apply ? "삭제" : "삭제 예정"}: 미국-전체신호 (과거 메시지도 삭제, 복구 불가)`);
    if (apply) { await obsolete.delete("사용자 요청: 미국 전체신호 제거, 매매신호 보존"); await guild.channels.fetch(); if (find("미국-전체신호")) throw new Error("삭제 검증 실패"); }
  }
  console.log(apply ? "완료: 기존 주문 전달 ID·권한 보존, 일본 자동주문 추가 없음" : "읽기 전용 확인 완료 · --apply로 적용");
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

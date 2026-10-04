import { ChannelType, PermissionFlagsBits } from "discord.js";
import {
  ensureDefaultDepartment,
  ensureValidDefaultDepartmentId,
  extractRoleIds,
  SUPPORT_DEFAULT_DEPARTMENT_ID
} from "./config.js";

async function resolveChannel(guild, channelId, expectedType) {
  if (!channelId) {
    return null;
  }

  const channel = guild.channels.cache.get(channelId)
    || (await guild.channels.fetch(channelId).catch(() => null));

  if (!channel || channel.type !== expectedType) {
    return null;
  }

  return channel;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Discord normalisiert Kanalnamen je nach Typ unterschiedlich (Text-Channels
 * werden kleingeschrieben und Leerzeichen zu Bindestrichen). Deshalb wird
 * gegen beide Schreibweisen verglichen.
 */
function matchesChannelName(channel, wantedName) {
  const wanted = normalizeName(wantedName);
  if (!wanted) {
    return false;
  }

  const actual = normalizeName(channel.name);
  return actual === wanted || actual === wanted.replace(/\s+/g, "-");
}

function findChannelByName(guild, name, expectedType) {
  return [...guild.channels.cache.values()]
    .find((channel) => channel.type === expectedType && matchesChannelName(channel, name)) || null;
}

/**
 * Sucht einen Kanal zuerst über die gespeicherte ID und – falls die ins Leere
 * läuft – über den konfigurierten Namen. Ohne diesen zweiten Schritt würde der
 * Bot bei jedem Start ein Duplikat anlegen, sobald die ID einmal verloren geht.
 */
async function adoptOrCreateChannel(guild, { channelId, name, type, createOptions, label }, logger) {
  const byId = await resolveChannel(guild, channelId, type);
  if (byId) {
    return { channel: byId, changed: false };
  }

  const byName = findChannelByName(guild, name, type);
  if (byName) {
    logger.info(`${label} wurde anhand des Namens übernommen`, {
      guildId: guild.id,
      channelId: byName.id,
      previousChannelId: channelId || null
    });
    return { channel: byName, changed: true };
  }

  try {
    const created = await guild.channels.create({ name, type, ...createOptions });
    logger.info(`${label} wurde neu erstellt`, {
      guildId: guild.id,
      channelId: created.id,
      previousChannelId: channelId || null
    });
    return { channel: created, changed: true };
  } catch (error) {
    logger.warn(`${label} konnte nicht erstellt werden`, {
      guildId: guild.id,
      error: String(error)
    });
    return { channel: null, changed: false };
  }
}

function normalizeTalkChannelCount(rawCount) {
  const parsed = Number(rawCount);
  if (!Number.isInteger(parsed)) {
    return 3;
  }

  return Math.max(1, Math.min(parsed, 10));
}

function normalizeTalkChannelPrefix(prefix) {
  const text = String(prefix || "support-talk").trim();
  return text || "support-talk";
}

function talkChannelIndex(channel, prefix) {
  const match = new RegExp(`^${prefix}-(\\d+)$`, "i").exec(normalizeName(channel.name));
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Sammelt alle bereits vorhandenen Talk-Channels: erst die gespeicherten IDs,
 * danach alles, was namentlich zum Schema `<prefix>-<n>` passt. Damit werden
 * auch Kanäle wiedergefunden, die im laufenden Betrieb zusätzlich angelegt
 * wurden oder deren ID nicht mehr in der Konfiguration steht.
 */
async function collectTalkChannels(guild, { knownIds, prefix, categoryId }) {
  const found = new Map();

  for (const channelId of knownIds) {
    const channel = await resolveChannel(guild, channelId, ChannelType.GuildVoice);
    if (channel) {
      found.set(channel.id, channel);
    }
  }

  const byName = [...guild.channels.cache.values()]
    .filter((channel) => channel.type === ChannelType.GuildVoice
      && talkChannelIndex(channel, prefix) !== null
      && (!categoryId || channel.parentId === categoryId))
    .sort((a, b) => talkChannelIndex(a, prefix) - talkChannelIndex(b, prefix));

  for (const channel of byName) {
    if (!found.has(channel.id)) {
      found.set(channel.id, channel);
    }
  }

  return [...found.values()];
}

function nextTalkChannelName(existingChannels, prefix) {
  const usedIndexes = new Set(
    existingChannels.map((channel) => talkChannelIndex(channel, prefix)).filter((index) => index !== null)
  );

  for (let index = 1; index <= 100; index += 1) {
    if (!usedIndexes.has(index)) {
      return `${prefix}-${index}`;
    }
  }

  return `${prefix}-${existingChannels.length + 1}`;
}

export async function ensureSupportDefaults(client, guild) {
  const { settingsStore, env, logger } = client.botContext;
  const supportState = settingsStore.getModuleState(guild.id, "support");

  if (!supportState || !supportState.enabled) {
    return supportState;
  }

  const currentConfig = supportState.config || {};
  const updates = {};

  const waiting = await adoptOrCreateChannel(guild, {
    channelId: currentConfig.waitingChannelId,
    name: env.supportWaitingChannelName,
    type: ChannelType.GuildVoice,
    createOptions: { reason: "Standard-Warteraum für Support-Modul" },
    label: "Support-Warteraum"
  }, logger);

  if (waiting.channel && waiting.changed) {
    updates.waitingChannelId = waiting.channel.id;
  }

  const management = await adoptOrCreateChannel(guild, {
    channelId: currentConfig.managementChannelId,
    name: env.supportManagementChannelName,
    type: ChannelType.GuildText,
    createOptions: {
      topic: "Support-Fälle, Claims, Eskalation und Transkripte",
      reason: "Standard-Verwaltungskanal für Support-Modul"
    },
    label: "Support-Verwaltungskanal"
  }, logger);

  if (management.channel && management.changed) {
    updates.managementChannelId = management.channel.id;
  }

  const talkCategory = await adoptOrCreateChannel(guild, {
    channelId: currentConfig.talkCategoryId,
    name: env.supportTalkCategoryName,
    type: ChannelType.GuildCategory,
    createOptions: { reason: "Kategorie für Support-Talk-Channels" },
    label: "Support-Talk-Kategorie"
  }, logger);

  if (talkCategory.channel && talkCategory.changed) {
    updates.talkCategoryId = talkCategory.channel.id;
  }

  const ticketCategory = await adoptOrCreateChannel(guild, {
    channelId: currentConfig.ticketCategoryId,
    name: env.supportTicketCategoryName,
    type: ChannelType.GuildCategory,
    createOptions: { reason: "Kategorie für Support-Tickets" },
    label: "Support-Ticket-Kategorie"
  }, logger);

  if (ticketCategory.channel && ticketCategory.changed) {
    updates.ticketCategoryId = ticketCategory.channel.id;
  }

  const talkPrefix = normalizeTalkChannelPrefix(env.supportTalkChannelPrefix);
  const talkTargetCount = normalizeTalkChannelCount(env.supportTalkChannelCount);

  const talkChannels = await collectTalkChannels(guild, {
    knownIds: Array.isArray(currentConfig.talkChannelIds) ? currentConfig.talkChannelIds : [],
    prefix: talkPrefix,
    categoryId: talkCategory.channel?.id || null
  });

  while (talkChannels.length < talkTargetCount) {
    const name = nextTalkChannelName(talkChannels, talkPrefix);

    let createdChannel;
    try {
      createdChannel = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: talkCategory.channel?.id || null,
        reason: "Automatisch erstellter Support-Talk"
      });

      logger.info("Support-Talk-Channel wurde neu erstellt", {
        guildId: guild.id,
        channelId: createdChannel.id,
        name
      });
    } catch (error) {
      logger.warn("Support-Talk-Channel konnte nicht erstellt werden", {
        guildId: guild.id,
        error: String(error)
      });
      break;
    }

    talkChannels.push(createdChannel);
  }

  const talkChannelIds = talkChannels.map((channel) => channel.id);
  const knownTalkIds = Array.isArray(currentConfig.talkChannelIds) ? currentConfig.talkChannelIds : [];

  if (talkChannelIds.length > 0 && talkChannelIds.join(",") !== knownTalkIds.join(",")) {
    updates.talkChannelIds = talkChannelIds;
  }

  const defaultRoleIds = extractRoleIds(env.supportDefaultDepartmentRoleIdsRaw || "");
  const departments = ensureDefaultDepartment(
    currentConfig.departments,
    env.supportDefaultDepartmentName,
    defaultRoleIds
  );

  const defaultDepartmentId = ensureValidDefaultDepartmentId(
    departments,
    currentConfig.defaultDepartmentId || SUPPORT_DEFAULT_DEPARTMENT_ID
  );

  const nextConfig = {
    ...currentConfig,
    ...updates,
    departments,
    defaultDepartmentId,
    transcriptTextChannelId: currentConfig.transcriptTextChannelId || updates.managementChannelId || currentConfig.managementChannelId || ""
  };

  settingsStore.setModuleConfig(guild.id, "support", nextConfig);

  if (management.channel) {
    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    const permissions = me ? management.channel.permissionsFor(me) : null;

    if (!permissions || !permissions.has(PermissionFlagsBits.SendMessages)) {
      logger.warn("Support-Verwaltungskanal ist vorhanden, aber Bot kann keine Nachrichten senden", {
        guildId: guild.id,
        channelId: management.channel.id
      });
    }
  }

  return settingsStore.getModuleState(guild.id, "support");
}

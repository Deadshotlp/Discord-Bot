import { EmbedBuilder } from "discord.js";
import { resolveTextAnnouncementChannel } from "../../../core/discordUtil.js";
import { pruneHistory, recordSample } from "./history.js";
import { closeOpenSessions, syncPlayerSessions } from "./playtime.js";
import { buildPanelPayload, upsertPanelMessage } from "./panel.js";
import { queryServer } from "./protocols/index.js";
import { listAllEnabledServers, listServers, patchServerMeta } from "./servers.js";
import { normalizeMonitoringConfig } from "./config.js";

const JOB_PREFIX = "monitoring";

// Zustandswechsel werden im Speicher gehalten, damit ein Neustart nicht
// sofort eine Flut an Benachrichtigungen auslöst.
const lastOnlineState = new Map();

function serverJobName(serverId) {
  return `${JOB_PREFIX}:server:${serverId}`;
}

function panelJobName(guildId) {
  return `${JOB_PREFIX}:panel:${guildId}`;
}

/**
 * Löscht die vorherige Statusmeldung desselben Servers, damit sich im
 * Benachrichtigungs-Channel nicht bei jedem Wechsel eine weitere Nachricht
 * ansammelt. Die ID wird am Server hinterlegt und übersteht so einen Neustart.
 */
async function removePreviousAlert(guild, server) {
  const { alertMessageId, alertChannelId } = server.meta || {};
  if (!alertMessageId || !alertChannelId) {
    return;
  }

  const channel = await resolveTextAnnouncementChannel(guild, alertChannelId);
  if (!channel) {
    return;
  }

  const message = await channel.messages.fetch(alertMessageId).catch(() => null);
  await message?.delete().catch(() => null);
}

async function announceStateChange(client, server, online, config) {
  const alertChannelId = config.alertChannelId || config.statusChannelId;
  if (!alertChannelId) {
    return;
  }

  const guild = client.guilds.cache.get(server.guildId);
  if (!guild) {
    return;
  }

  const channel = await resolveTextAnnouncementChannel(guild, alertChannelId);
  if (!channel) {
    return;
  }

  await removePreviousAlert(guild, server);

  const embed = new EmbedBuilder()
    .setColor(online ? "#57f287" : "#ed4245")
    .setTitle(online ? `🟢 ${server.name} ist wieder online` : `🔴 ${server.name} ist offline`)
    .setDescription(`\`${server.host}:${server.port}\``)
    .setTimestamp(new Date());

  const content = !online && config.alertRoleId ? `<@&${config.alertRoleId}>` : undefined;

  const message = await channel.send({ content, embeds: [embed] }).catch(() => null);

  patchServerMeta(server.id, {
    alertMessageId: message?.id || "",
    alertChannelId: message ? channel.id : ""
  });
}

async function pollServer(client, server) {
  const { logger, settingsStore } = client.botContext;
  const result = await queryServer(server);

  recordSample(server.id, result);

  if (Array.isArray(result.playerList) && result.playerList.length > 0) {
    syncPlayerSessions(server.id, result.playerList);
  } else if (!result.online) {
    closeOpenSessions(server.id);
  }

  const previous = lastOnlineState.get(server.id);
  lastOnlineState.set(server.id, result.online);

  if (previous !== undefined && previous !== result.online) {
    const config = normalizeMonitoringConfig(
      settingsStore.getModuleState(server.guildId, "monitoring")?.config
    );

    if (config.alertOnStateChange) {
      await announceStateChange(client, server, result.online, config).catch((error) => {
        logger.warn("Status-Benachrichtigung fehlgeschlagen", {
          serverId: server.id,
          error: String(error)
        });
      });
    }
  }

  return result;
}

async function refreshPanel(client, guildId) {
  const { settingsStore, logger } = client.botContext;

  if (!settingsStore.isModuleEnabled(guildId, "monitoring")) {
    return;
  }

  const config = normalizeMonitoringConfig(settingsStore.getModuleState(guildId, "monitoring")?.config);
  if (!config.statusChannelId) {
    return;
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return;
  }

  const channel = await resolveTextAnnouncementChannel(guild, config.statusChannelId);
  if (!channel) {
    return;
  }

  const servers = listServers(guildId).filter((server) => server.enabled);
  const payload = buildPanelPayload(servers, {
    chartRange: config.chartRange,
    showHourProfile: config.showHourProfile
  });

  const message = await upsertPanelMessage(channel, payload, config.statusMessageId).catch((error) => {
    logger.warn("Monitoring-Panel konnte nicht aktualisiert werden", {
      guildId,
      error: String(error)
    });
    return null;
  });

  if (message && message.id !== config.statusMessageId) {
    settingsStore.setModuleConfig(guildId, "monitoring", { statusMessageId: message.id });
  }
}

/**
 * Richtet für jeden aktiven Server einen eigenen Job ein.
 * Wird nach jeder Änderung (Web-Dashboard oder Slash-Command) erneut aufgerufen,
 * damit neue Server sofort im laufenden Betrieb mitlaufen.
 */
export function syncPollJobs(client) {
  const { scheduler, settingsStore, logger } = client.botContext;
  const servers = listAllEnabledServers().filter((server) => client.guilds.cache.has(server.guildId));
  const wanted = new Set();

  for (const server of servers) {
    if (!settingsStore.isModuleEnabled(server.guildId, "monitoring")) {
      continue;
    }

    const jobName = serverJobName(server.id);
    wanted.add(jobName);

    const existing = scheduler.jobs.get(jobName);
    if (existing && existing.intervalMs === server.intervalSeconds * 1000) {
      continue;
    }

    scheduler.every(jobName, server.intervalSeconds * 1000, async () => {
      // Serverdaten frisch lesen, damit Änderungen ohne Neustart greifen.
      const current = listAllEnabledServers().find((entry) => entry.id === server.id);
      if (!current) {
        scheduler.cancel(jobName);
        return;
      }

      await pollServer(client, current);
    });

    logger.debug?.("Monitoring-Job gestartet", { server: server.name, interval: server.intervalSeconds });
  }

  const guildIds = new Set(servers.map((server) => server.guildId));
  for (const guildId of guildIds) {
    const config = normalizeMonitoringConfig(settingsStore.getModuleState(guildId, "monitoring")?.config);
    const jobName = panelJobName(guildId);
    wanted.add(jobName);

    const existing = scheduler.jobs.get(jobName);
    if (existing && existing.intervalMs === config.panelIntervalSeconds * 1000) {
      continue;
    }

    scheduler.every(jobName, config.panelIntervalSeconds * 1000, () => refreshPanel(client, guildId), {
      runImmediately: false
    });
  }

  for (const jobName of [...scheduler.jobs.keys()]) {
    if (jobName.startsWith(`${JOB_PREFIX}:`) && !wanted.has(jobName)) {
      scheduler.cancel(jobName);
    }
  }

  scheduler.every(`${JOB_PREFIX}:prune`, 6 * 60 * 60 * 1000, () => {
    const removed = pruneHistory();
    logger.info("Monitoring-Verlauf bereinigt", removed);
  }, { runImmediately: false });
}

export function stopPollJobs(client) {
  client.botContext.scheduler.cancelPrefix(`${JOB_PREFIX}:`);
  lastOnlineState.clear();
}

export { announceStateChange, pollServer, refreshPanel };

import { EmbedBuilder } from "discord.js";
import { resolveTextAnnouncementChannel } from "../../../core/discordUtil.js";
import { resolveReminderChannelId } from "./config.js";
import { listWeeklyReportsForWeek, markWeekPublished } from "./reports.js";
import { formatWeekDateRange, formatWeekLabel } from "./week.js";

const SUBMITTED_COLOR = 0x1f6feb;
const MISSING_COLOR = 0x6e7681;

// Discord-Limits: max. 10 Embeds pro Nachricht, max. 6000 Zeichen über alle
// Embeds einer Nachricht. Wir bleiben mit Puffer darunter.
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_CHARS_PER_MESSAGE = 5000;

function buildDepartmentEmbed(department, report) {
  const embed = new EmbedBuilder().setTitle(department.name.slice(0, 256));

  if (report) {
    const description = [
      report.content.slice(0, 3900),
      "",
      `— abgegeben von <@${report.authorId}>`
    ].join("\n");

    embed.setColor(SUBMITTED_COLOR).setDescription(description);
  } else {
    embed.setColor(MISSING_COLOR).setDescription("_Keine Abgabe._");
  }

  return embed;
}

function estimateEmbedLength(embed) {
  const data = embed.toJSON();
  return String(data.title || "").length + String(data.description || "").length;
}

export function buildWeeklyReportMessages(weekKey, departments, reports) {
  const reportsByDepartment = new Map(reports.map((report) => [report.departmentId, report]));

  const headerLines = [
    `📋 **Wochenbericht ${formatWeekLabel(weekKey)}**`,
    formatWeekDateRange(weekKey)
  ].filter(Boolean);

  const embeds = departments.map((department) => (
    buildDepartmentEmbed(department, reportsByDepartment.get(department.id) || null)
  ));

  const messages = [];
  let currentEmbeds = [];
  let currentChars = 0;

  for (const embed of embeds) {
    const length = estimateEmbedLength(embed);
    const wouldOverflow = currentEmbeds.length >= MAX_EMBEDS_PER_MESSAGE
      || (currentEmbeds.length > 0 && currentChars + length > MAX_EMBED_CHARS_PER_MESSAGE);

    if (wouldOverflow) {
      messages.push({ embeds: currentEmbeds });
      currentEmbeds = [];
      currentChars = 0;
    }

    currentEmbeds.push(embed);
    currentChars += length;
  }

  if (currentEmbeds.length > 0) {
    messages.push({ embeds: currentEmbeds });
  }

  if (messages.length === 0) {
    messages.push({ embeds: [] });
  }

  messages[0].content = headerLines.join("\n");
  return messages;
}

export async function publishWeeklyReport(client, guild, weekKey, departments, config) {
  const { settingsStore, logger } = client.botContext;

  const channel = await resolveTextAnnouncementChannel(guild, config.publishChannelId);
  if (!channel) {
    logger.warn("Wochenbericht: Publish-Channel nicht verfügbar", {
      guildId: guild.id,
      channelId: config.publishChannelId,
      week: weekKey
    });
    return false;
  }

  const reports = listWeeklyReportsForWeek(guild.id, weekKey);
  const messages = buildWeeklyReportMessages(weekKey, departments, reports);

  for (const message of messages) {
    await channel.send({ ...message, allowedMentions: { parse: [] } });
  }

  markWeekPublished(guild.id, weekKey);
  settingsStore.setModuleConfig(guild.id, "weekly-report", {
    ...config,
    lastPublishedWeek: weekKey
  });

  logger.info("Wochenbericht veröffentlicht", {
    guildId: guild.id,
    week: weekKey,
    departments: departments.length,
    submissions: reports.length
  });

  return true;
}

export function buildReminderMessage(weekKey, missingDepartments, publishMoment) {
  const departmentList = missingDepartments
    .map((department) => {
      const mentions = (department.leadRoleIds || []).map((roleId) => `<@&${roleId}>`).join(" ");
      return mentions ? `- ${department.name}: ${mentions}` : `- ${department.name}`;
    })
    .join("\n");

  const publishTimestamp = Math.floor(publishMoment.getTime() / 1000);

  return {
    content: [
      `⏰ **Erinnerung: Wochenbericht ${formatWeekLabel(weekKey)}**`,
      `Veröffentlichung: <t:${publishTimestamp}:F>`,
      "",
      "Folgende Departments haben noch keinen Bericht abgegeben:",
      departmentList,
      "",
      "Abgabe über `/wochenbericht abgeben`."
    ].join("\n"),
    allowedMentions: {
      roles: [...new Set(missingDepartments.flatMap((department) => department.leadRoleIds || []))]
    }
  };
}

export async function sendWeeklyReminder(client, guild, weekKey, departments, config, publishMoment) {
  const { settingsStore, logger } = client.botContext;

  const reminderChannelId = resolveReminderChannelId(config);
  const channel = await resolveTextAnnouncementChannel(guild, reminderChannelId);
  if (!channel) {
    logger.warn("Wochenbericht: Erinnerungs-Channel nicht verfügbar", {
      guildId: guild.id,
      channelId: reminderChannelId,
      week: weekKey
    });
    return false;
  }

  const reports = listWeeklyReportsForWeek(guild.id, weekKey);
  const submittedIds = new Set(reports.map((report) => report.departmentId));
  const missingDepartments = departments.filter((department) => !submittedIds.has(department.id));

  settingsStore.setModuleConfig(guild.id, "weekly-report", {
    ...config,
    lastReminderWeek: weekKey
  });

  if (missingDepartments.length === 0) {
    return false;
  }

  await channel.send(buildReminderMessage(weekKey, missingDepartments, publishMoment));

  logger.info("Wochenbericht-Erinnerung gesendet", {
    guildId: guild.id,
    week: weekKey,
    channelId: channel.id,
    missing: missingDepartments.length
  });

  return true;
}

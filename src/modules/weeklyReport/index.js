import { MessageFlags } from "discord.js";
import { canManageServer } from "../../core/permissions.js";
import { getDepartmentById, isDepartmentLead } from "../support/services/config.js";
import {
  buildWeeklyReportSubmitModal,
  WEEKLY_REPORT_CONTENT_INPUT_ID,
  WEEKLY_REPORT_DEPT_SELECT_ID,
  WEEKLY_REPORT_SUBMIT_MODAL_PREFIX
} from "./services/panel.js";
import { publishWeeklyReport, sendWeeklyReminder } from "./services/publisher.js";
import {
  closeWeeklyReportsDb,
  deleteWeeklyReport,
  getWeeklyReport,
  hasUnpublishedReports,
  upsertWeeklyReport
} from "./services/reports.js";
import {
  formatWeekLabel,
  getIsoWeekKey,
  getPreviousWeekKey,
  getPublishMoment,
  getTargetWeekKey
} from "./services/week.js";
import {
  getGuildDepartments,
  getSubmittableDepartments,
  getWeeklyReportConfig,
  weeklyReportCommand
} from "./commands/weeklyReport.js";

const CHECK_INTERVAL_MS = 60 * 1000;

const runtime = {
  timer: null,
  running: false
};

async function processGuildTick(client, guild, now) {
  const config = getWeeklyReportConfig(client, guild.id);
  if (!config.publishChannelId) {
    return;
  }

  const currentWeek = getIsoWeekKey(now);
  const publishMoment = getPublishMoment(now, config);
  const departments = getGuildDepartments(client, guild.id);

  if (
    config.reminderHoursBefore > 0
    && config.lastReminderWeek !== currentWeek
    && config.lastPublishedWeek !== currentWeek
    && now.getTime() >= publishMoment.getTime() - config.reminderHoursBefore * 60 * 60 * 1000
    && now.getTime() < publishMoment.getTime()
  ) {
    await sendWeeklyReminder(client, guild, currentWeek, departments, config, publishMoment);
    return;
  }

  if (now.getTime() >= publishMoment.getTime()) {
    if (config.lastPublishedWeek !== currentWeek) {
      await publishWeeklyReport(client, guild, currentWeek, departments, config);
    }
    return;
  }

  // Katchup: Der Termin der Vorwoche wurde verpasst (Bot war offline),
  // aber es liegen noch unveröffentlichte Abgaben vor.
  const previousWeek = getPreviousWeekKey(now);
  if (config.lastPublishedWeek !== previousWeek && hasUnpublishedReports(guild.id, previousWeek)) {
    await publishWeeklyReport(client, guild, previousWeek, departments, config);
  }
}

async function runWeeklyReportCycle(client) {
  if (runtime.running) {
    return;
  }

  runtime.running = true;
  try {
    const now = new Date();
    for (const guild of client.guilds.cache.values()) {
      if (!client.botContext.settingsStore.isModuleEnabled(guild.id, "weekly-report")) {
        continue;
      }

      await processGuildTick(client, guild, now).catch((error) => {
        client.botContext.logger.warn("Wochenbericht-Zyklus fehlgeschlagen", {
          guildId: guild.id,
          error: String(error)
        });
      });
    }
  } finally {
    runtime.running = false;
  }
}

async function handleWeeklyReportReady({ client }) {
  if (runtime.timer) {
    return;
  }

  await runWeeklyReportCycle(client);

  runtime.timer = setInterval(() => {
    runWeeklyReportCycle(client).catch((error) => {
      client.botContext.logger.warn("Wochenbericht-Zyklus fehlgeschlagen", {
        error: String(error)
      });
    });
  }, CHECK_INTERVAL_MS);
}

async function handleWeeklyReportShutdown() {
  if (runtime.timer) {
    clearInterval(runtime.timer);
    runtime.timer = null;
  }

  closeWeeklyReportsDb();
}

handleWeeklyReportShutdown.alwaysAvailable = true;

async function handleDepartmentSelect({ client, interaction }) {
  const departments = getSubmittableDepartments(client, interaction.guildId, interaction.member);
  const selectedId = interaction.values?.[0] || "";
  const department = departments.find((entry) => entry.id === selectedId);

  if (!department) {
    await interaction.reply({
      content: "Für dieses Department darfst du keinen Bericht abgeben.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const config = getWeeklyReportConfig(client, interaction.guildId);
  const targetWeek = getTargetWeekKey(new Date(), config);
  const existing = getWeeklyReport(interaction.guildId, targetWeek, department.id);

  await interaction.showModal(
    buildWeeklyReportSubmitModal(department, formatWeekLabel(targetWeek), existing?.content || "")
  );
}

async function handleSubmitModal({ client, interaction }) {
  const departmentId = interaction.customId.slice(WEEKLY_REPORT_SUBMIT_MODAL_PREFIX.length);
  const departments = getGuildDepartments(client, interaction.guildId);
  const department = getDepartmentById(departments, departmentId);

  if (!department) {
    await interaction.reply({
      content: "Department nicht gefunden.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!canManageServer(interaction.member) && !isDepartmentLead(interaction.member, department)) {
    await interaction.reply({
      content: "Für dieses Department darfst du keinen Bericht abgeben.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const config = getWeeklyReportConfig(client, interaction.guildId);
  const targetWeek = getTargetWeekKey(new Date(), config);
  const content = interaction.fields.getTextInputValue(WEEKLY_REPORT_CONTENT_INPUT_ID)?.trim() || "";

  if (!content) {
    const removed = deleteWeeklyReport(interaction.guildId, targetWeek, department.id);
    await interaction.reply({
      content: removed
        ? `Abgabe für ${department.name} (${formatWeekLabel(targetWeek)}) wurde gelöscht.`
        : `Keine Abgabe für ${department.name} (${formatWeekLabel(targetWeek)}) vorhanden.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  upsertWeeklyReport({
    guildId: interaction.guildId,
    week: targetWeek,
    departmentId: department.id,
    authorId: interaction.user.id,
    content
  });

  await interaction.reply({
    content: [
      `Bericht für **${department.name}** (${formatWeekLabel(targetWeek)}) gespeichert.`,
      "Er kann bis zur Veröffentlichung über `/wochenbericht abgeben` bearbeitet werden."
    ].join("\n"),
    flags: MessageFlags.Ephemeral
  });
}

async function handleWeeklyReportInteraction({ client, interaction }) {
  if (!interaction.inGuild()) {
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === WEEKLY_REPORT_DEPT_SELECT_ID) {
    await handleDepartmentSelect({ client, interaction });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(WEEKLY_REPORT_SUBMIT_MODAL_PREFIX)) {
    await handleSubmitModal({ client, interaction });
  }
}

handleWeeklyReportInteraction.alwaysAvailable = true;

export const weeklyReportModule = {
  name: "weekly-report",
  defaultEnabled: false,
  defaultConfig: {
    publishChannelId: "",
    reminderChannelId: "",
    publishWeekday: 7,
    publishHour: 18,
    publishMinute: 0,
    reminderHoursBefore: 24,
    lastPublishedWeek: "",
    lastReminderWeek: ""
  },
  commands: [weeklyReportCommand],
  events: {
    ready: [handleWeeklyReportReady],
    interactionCreate: [handleWeeklyReportInteraction],
    shutdown: [handleWeeklyReportShutdown]
  }
};

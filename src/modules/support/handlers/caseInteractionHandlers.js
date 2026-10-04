import { AttachmentBuilder, MessageFlags } from "discord.js";
import { canManageServer } from "../../../core/permissions.js";
import { getDepartmentById, hasDepartmentAccess } from "../services/config.js";
import {
  getSupportConfig,
  resolveExistingRoleIds,
  resolveGuildMember,
  resolveTextChannel,
  resolveTranscriptChannel
} from "../services/channelResolvers.js";
import { findFreeTalkChannel } from "../services/ticketChannelFactory.js";
import {
  addSupportCaseAction,
  claimSupportCase,
  closeSupportCase,
  escalateSupportCase,
  getSupportCase
} from "../services/cases.js";
import {
  buildCaseTranscript,
  buildEscalationSelectPayload
} from "../services/panel.js";
import { canEscalateCase, canHandleCase } from "../services/supportPermissions.js";
import { updateCaseMessage } from "./voiceCaseHandlers.js";
import { offerRecordingConsent } from "./recordingHandlers.js";
import { finalizeVoiceTranscript } from "../services/voiceTranscript.js";
import { getRecordingSession } from "../services/voiceRecording.js";

export async function handleClaimInteraction({ client, interaction, caseId }) {
  const { settingsStore, env } = client.botContext;
  const config = getSupportConfig(settingsStore, interaction.guildId, env);
  const caseData = getSupportCase(interaction.guildId, caseId);

  if (!caseData || caseData.status !== "open") {
    await interaction.reply({
      content: "Dieser Fall ist nicht mehr offen.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const department = getDepartmentById(config.departments, caseData.departmentId);
  if (!hasDepartmentAccess(interaction.member, department) && !canManageServer(interaction.member)) {
    await interaction.reply({
      content: "Du hast keine Berechtigung für dieses Department.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const supporterMember = await resolveGuildMember(interaction.guild, interaction.user.id);
  if (!supporterMember?.voice?.channelId) {
    await interaction.reply({
      content: "Bitte zuerst einem Voice-Channel beitreten, dann den Fall claimen.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const userMember = await resolveGuildMember(interaction.guild, caseData.userId);
  if (!userMember?.voice?.channelId) {
    await interaction.reply({
      content: "Der Nutzer ist aktuell nicht in einem Voice-Channel.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const talkChannel = await findFreeTalkChannel(client, interaction.guild, config);
  if (!talkChannel) {
    await interaction.reply({
      content: "Kein freier Talk-Channel verfügbar und es konnte kein neuer erstellt werden.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  let movedSuccessfully = true;
  await Promise.all([
    supporterMember.voice.setChannel(talkChannel, "Support-Fall geclaimed"),
    userMember.voice.setChannel(talkChannel, "Support-Fall geclaimed")
  ]).catch(async () => {
    movedSuccessfully = false;
    await interaction.reply({
      content: "Verschieben in den Talk-Channel fehlgeschlagen. Prüfe Bot-Rechte (Mitglieder verschieben).",
      flags: MessageFlags.Ephemeral
    });
  });

  if (!movedSuccessfully) {
    return;
  }

  const claimedCase = claimSupportCase(interaction.guildId, caseId, interaction.user.id, talkChannel.id);
  if (!claimedCase) {
    return;
  }

  await updateCaseMessage(interaction.guild, claimedCase, config);

  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({
      content: `Fall übernommen. Nutzer und Supporter wurden nach <#${talkChannel.id}> verschoben.`,
      flags: MessageFlags.Ephemeral
    });
  }

  await offerRecordingConsent(client, interaction.guild, claimedCase, talkChannel);
}

export async function handleEscalateInteraction({ client, interaction, caseId }) {
  const caseData = getSupportCase(interaction.guildId, caseId);

  if (!caseData || caseData.status !== "claimed") {
    await interaction.reply({
      content: "Eskalation ist nur bei aktiven Fällen möglich.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const config = getSupportConfig(client.botContext.settingsStore, interaction.guildId, client.botContext.env);
  const currentDepartment = getDepartmentById(config.departments, caseData.departmentId);

  if (!canEscalateCase(interaction, currentDepartment)) {
    await interaction.reply({
      content: "Nur Mitglieder des aktuellen Departments dürfen diesen Fall eskalieren.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const departments = config.departments || [];

  if (departments.length <= 1) {
    await interaction.reply({
      content: "Es gibt kein weiteres Department für eine Eskalation.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply({
    ...buildEscalationSelectPayload(caseData, departments),
    flags: MessageFlags.Ephemeral
  });
}

export async function handleEscalationSelectInteraction({ client, interaction, caseId }) {
  const caseData = getSupportCase(interaction.guildId, caseId);

  if (!caseData || caseData.status === "closed") {
    await interaction.reply({
      content: "Dieser Fall ist nicht mehr aktiv.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const config = getSupportConfig(client.botContext.settingsStore, interaction.guildId, client.botContext.env);
  const currentDepartment = getDepartmentById(config.departments, caseData.departmentId);

  if (!canEscalateCase(interaction, currentDepartment)) {
    await interaction.reply({
      content: "Nur Mitglieder des aktuellen Departments dürfen diesen Fall eskalieren.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const selectedDepartmentId = interaction.values?.[0] || "";
  const selectedDepartment = getDepartmentById(config.departments, selectedDepartmentId);

  if (!selectedDepartment) {
    await interaction.reply({
      content: "Gewähltes Department wurde nicht gefunden.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const escalatedCase = escalateSupportCase(interaction.guildId, caseId, selectedDepartmentId, interaction.user.id);
  if (!escalatedCase) {
    return;
  }

  const managementChannel = await resolveTextChannel(interaction.guild, config.managementChannelId);
  if (managementChannel) {
    const validRoleIds = await resolveExistingRoleIds(interaction.guild, selectedDepartment.roleIds);
    const pingMentions = validRoleIds.length > 0
      ? validRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")
      : "@here";

    await managementChannel.send({
      content: `${pingMentions}\nFall ${caseId} wurde eskaliert von <@${interaction.user.id}> auf ${selectedDepartment.name}.`,
      allowedMentions: {
        parse: validRoleIds.length > 0 ? [] : ["everyone"],
        roles: validRoleIds
      }
    });
  }

  await updateCaseMessage(interaction.guild, escalatedCase, config);

  await interaction.update({
    content: `Eskalation durchgeführt: ${selectedDepartment.name}`,
    components: []
  });
}

export async function handleCloseInteraction({ client, interaction, caseId }) {
  const caseData = getSupportCase(interaction.guildId, caseId);

  if (!caseData || caseData.status === "closed") {
    await interaction.reply({
      content: "Dieser Fall ist bereits geschlossen.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!canHandleCase(interaction, caseData)) {
    await interaction.reply({
      content: "Du darfst diesen Fall nicht schließen.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const config = getSupportConfig(client.botContext.settingsStore, interaction.guildId, client.botContext.env);
  const hasRecording = Boolean(getRecordingSession(interaction.guildId, caseId));
  let transcriptPosted = false;

  if (hasRecording) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Transkript erstellen, solange die Teilnehmer noch im Voice-Channel sind.
    transcriptPosted = await finalizeVoiceTranscript(client, interaction.guild, caseData, config);
  }

  const userMember = await resolveGuildMember(interaction.guild, caseData.userId);
  const supporterMember = caseData.supporterId
    ? await resolveGuildMember(interaction.guild, caseData.supporterId)
    : null;

  await Promise.all([
    userMember?.voice?.setChannel(null, "Support-Fall geschlossen").catch(() => null),
    supporterMember?.voice?.setChannel(null, "Support-Fall geschlossen").catch(() => null)
  ]);

  const closedCase = closeSupportCase(interaction.guildId, caseId, interaction.user.id);
  if (!closedCase) {
    return;
  }

  await updateCaseMessage(interaction.guild, closedCase, config);

  const closeMessage = transcriptPosted
    ? "Fall wurde geschlossen. Gesprächstranskript wurde erstellt; Nutzer und Supporter wurden aus Voice entfernt."
    : "Fall wurde geschlossen. Nutzer und Supporter wurden aus Voice entfernt.";

  if (interaction.deferred) {
    await interaction.editReply({ content: closeMessage });
  } else {
    await interaction.reply({ content: closeMessage, flags: MessageFlags.Ephemeral });
  }
}

export async function handleTranscriptInteraction({ client, interaction, caseId }) {
  const caseData = getSupportCase(interaction.guildId, caseId);
  if (!caseData || caseData.status === "closed") {
    await interaction.reply({
      content: "Transkript nur für aktive Fälle verfügbar.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!canHandleCase(interaction, caseData)) {
    await interaction.reply({
      content: "Du darfst dieses Transkript nicht erstellen.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  addSupportCaseAction(interaction.guildId, caseId, `Transkript angefordert von ${interaction.user.id}`);
  const config = getSupportConfig(client.botContext.settingsStore, interaction.guildId, client.botContext.env);
  const department = getDepartmentById(config.departments, caseData.departmentId);
  const transcriptContent = buildCaseTranscript(caseData, department?.name || "");

  const transcriptChannel = await resolveTranscriptChannel(interaction.guild, config);

  if (!transcriptChannel) {
    await interaction.reply({
      content: "Transkript-Channel ist nicht verfügbar.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const attachment = new AttachmentBuilder(Buffer.from(transcriptContent, "utf8"), {
    name: `support-case-${caseId}.txt`
  });

  await transcriptChannel.send({
    content: `Transkript für Fall ${caseId} (angefordert von <@${interaction.user.id}>)`,
    files: [attachment]
  });

  await interaction.reply({
    content: "Transkript wurde erstellt und im Verwaltungs-Channel gepostet.",
    flags: MessageFlags.Ephemeral
  });
}

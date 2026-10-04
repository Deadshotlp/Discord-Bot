import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder
} from "discord.js";
import { formatLocalTimestamp } from "../../../config/timezone.js";
import { formatDepartmentRoleMentions } from "./config.js";

export const SUPPORT_CLAIM_PREFIX = "support_claim:";
export const SUPPORT_ESCALATE_PREFIX = "support_escalate:";
export const SUPPORT_CLOSE_PREFIX = "support_close:";
export const SUPPORT_TRANSCRIPT_PREFIX = "support_transcript:";
export const SUPPORT_ESCALATE_SELECT_PREFIX = "support_escalate_select:";

function formatStatus(caseData) {
  if (caseData.status === "claimed") {
    return "In Bearbeitung";
  }

  if (caseData.status === "closed") {
    return "Geschlossen";
  }

  return "Offen";
}

function toRelativeTimestamp(timestamp) {
  const seconds = Math.floor((timestamp || Date.now()) / 1000);
  return `<t:${seconds}:R>`;
}

export function buildSupportCaseEmbed(caseData, department, supporterId = "") {
  const embed = new EmbedBuilder()
    .setColor(caseData.status === "closed" ? 0x57606a : (caseData.status === "claimed" ? 0x2ea043 : 0xf1c40f))
    .setTitle(`Support-Fall ${caseData.id}`)
    .addFields(
      { name: "Status", value: formatStatus(caseData), inline: true },
      { name: "Nutzer", value: `<@${caseData.userId}>`, inline: true },
      { name: "Department", value: department ? `${department.name} (${department.id})` : caseData.departmentId, inline: true },
      { name: "Supporter", value: supporterId ? `<@${supporterId}>` : (caseData.supporterId ? `<@${caseData.supporterId}>` : "(nicht geclaimed)"), inline: true },
      { name: "Erstellt", value: toRelativeTimestamp(caseData.createdAt), inline: true },
      { name: "Benachrichtigung", value: formatDepartmentRoleMentions(department), inline: false }
    );

  if (caseData.talkChannelId) {
    embed.addFields({ name: "Talk", value: `<#${caseData.talkChannelId}>`, inline: true });
  }

  return embed;
}

export function buildSupportOpenCaseMessage(caseData, department) {
  const embed = buildSupportCaseEmbed(caseData, department);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SUPPORT_CLAIM_PREFIX}${caseData.id}`)
      .setLabel("Fall claimen")
      .setStyle(ButtonStyle.Success)
  );

  const pingMentions = Array.isArray(department?.roleIds) && department.roleIds.length > 0
    ? department.roleIds.map((roleId) => `<@&${roleId}>`).join(" ")
    : "@here";

  const roleIds = Array.isArray(department?.roleIds) ? department.roleIds : [];
  const allowedMentions = roleIds.length > 0
    ? {
      parse: [],
      roles: roleIds
    }
    : {
      parse: ["everyone"]
    };

  return {
    content: `${pingMentions}\nNeuer Supportfall von <@${caseData.userId}>`,
    embeds: [embed],
    components: [row],
    allowedMentions
  };
}

export function buildSupportClaimedMessage(caseData, department) {
  const embed = buildSupportCaseEmbed(caseData, department, caseData.supporterId);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SUPPORT_ESCALATE_PREFIX}${caseData.id}`)
      .setLabel("Eskalieren")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${SUPPORT_CLOSE_PREFIX}${caseData.id}`)
      .setLabel("Fall schließen")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${SUPPORT_TRANSCRIPT_PREFIX}${caseData.id}`)
      .setLabel("Transkript")
      .setStyle(ButtonStyle.Primary)
  );

  return {
    content: `Fall geclaimed von <@${caseData.supporterId}>`,
    embeds: [embed],
    components: [row]
  };
}

export function buildSupportClosedMessage(caseData, department) {
  const embed = buildSupportCaseEmbed(caseData, department, caseData.supporterId);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`support_closed:${caseData.id}`)
      .setLabel("Geschlossen")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  return {
    content: `Fall wurde geschlossen${caseData.supporterId ? ` von <@${caseData.supporterId}>` : ""}.`,
    embeds: [embed],
    components: [row]
  };
}

export function buildEscalationSelectPayload(caseData, departments) {
  const options = departments
    .filter((department) => department.id !== caseData.departmentId)
    .map((department) => ({
      label: department.name.slice(0, 100),
      value: department.id,
      description: `ID: ${department.id}`.slice(0, 100)
    }))
    .slice(0, 25);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${SUPPORT_ESCALATE_SELECT_PREFIX}${caseData.id}`)
    .setPlaceholder("Department wählen")
    .addOptions(options);

  return {
    content: "Wähle das Department für die Eskalation:",
    components: [new ActionRowBuilder().addComponents(select)]
  };
}

export function buildCaseTranscript(caseData, departmentName = "") {
  const lines = [
    `Support-Fall: ${caseData.id}`,
    `Status: ${caseData.status}`,
    `Nutzer: ${caseData.userId}`,
    `Supporter: ${caseData.supporterId || "-"}`,
    `Department: ${departmentName || caseData.departmentId}`,
    `Warte-Channel: ${caseData.waitingChannelId || "-"}`,
    `Talk-Channel: ${caseData.talkChannelId || "-"}`,
    `Erstellt: ${formatLocalTimestamp(caseData.createdAt)}`,
    `Geschlossen: ${caseData.closedAt ? formatLocalTimestamp(caseData.closedAt) : "-"}`,
    "",
    "Timeline:"
  ];

  for (const action of caseData.actions || []) {
    lines.push(`- ${formatLocalTimestamp(action.at)} | ${action.text}`);
  }

  return `${lines.join("\n")}\n`;
}

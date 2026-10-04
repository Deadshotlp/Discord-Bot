import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { formatLocalTimestamp } from "../../../config/timezone.js";
import { getDepartmentById } from "./config.js";
import {
  resolveExistingRoleIds,
  resolveTextChannel,
  resolveTranscriptChannel
} from "./channelResolvers.js";
import { scheduleClosedTicketChannelDeletion } from "./closedTicketCleanup.js";
import { closeSupportTicket, escalateSupportTicket } from "./tickets.js";

export const TICKET_REPLY_COLOR = 0x5865f2;
const TICKET_REPLY_MAX_LENGTH = 2000;
const TRANSCRIPT_FETCH_PAGES = 10;

/**
 * Gemeinsame Ticket-Aktionen für Discord-Buttons und Web-Dashboard.
 * Die Funktionen kennen bewusst keine Interaction, sondern nur Guild und
 * Akteur-ID, damit beide Oberflächen dieselbe Logik nutzen.
 */

export async function buildTicketTranscriptContent(ticketChannel, ticket, departmentName) {
  const collected = [];
  let before;

  for (let index = 0; index < TRANSCRIPT_FETCH_PAGES; index += 1) {
    const fetched = await ticketChannel.messages.fetch({
      limit: 100,
      before
    }).catch(() => null);

    if (!fetched || fetched.size === 0) {
      break;
    }

    collected.push(...fetched.values());

    const lastMessage = fetched.last();
    if (!lastMessage) {
      break;
    }

    before = lastMessage.id;
  }

  const ordered = collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lines = [
    `Ticket: ${ticket.id}`,
    `Status: ${ticket.status}`,
    `Nutzer: ${ticket.userId}`,
    `Department: ${departmentName || ticket.departmentId}`,
    `Channel: ${ticket.channelId}`,
    `Titel: ${ticket.ticketName || "-"}`,
    `Erstellt: ${ticket.createdAt ? formatLocalTimestamp(ticket.createdAt) : "-"}`,
    `Geschlossen: ${ticket.closedAt ? formatLocalTimestamp(ticket.closedAt) : "-"}`,
    `Geschlossen von: ${ticket.closedById || "-"}`,
    "",
    "Beschreibung:",
    ticket.ticketDescription || "-",
    "",
    "Nachrichtenverlauf:"
  ];

  for (const message of ordered) {
    const author = message.author?.tag || message.author?.username || message.author?.id || "Unbekannt";
    const timestamp = formatLocalTimestamp(message.createdAt || new Date());
    const content = (message.content || "").trim();
    const text = content || "(kein Text)";

    lines.push(`[${timestamp}] ${author}: ${text}`);

    if (message.attachments.size > 0) {
      const files = Array.from(message.attachments.values())
        .map((file) => file.url)
        .join(" | ");
      lines.push(`  Anhänge: ${files}`);
    }

    if (message.embeds.length > 0) {
      lines.push(`  Embeds: ${message.embeds.length}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function postTicketTranscript({ guild, ticketChannel, ticket, config, departmentName }) {
  const channel = ticketChannel || (await resolveTextChannel(guild, ticket.channelId));
  if (!channel) {
    return false;
  }

  const transcriptChannel = await resolveTranscriptChannel(guild, config);
  if (!transcriptChannel) {
    return false;
  }

  const transcriptContent = await buildTicketTranscriptContent(channel, ticket, departmentName);
  const attachment = new AttachmentBuilder(Buffer.from(transcriptContent, "utf8"), {
    name: `support-ticket-${ticket.id}.txt`
  });

  const sentMessage = await transcriptChannel.send({
    content: `Transkript für Ticket ${ticket.id} (geschlossen von <@${ticket.closedById || "system"}>)`,
    files: [attachment],
    allowedMentions: { parse: [] }
  }).catch(() => null);

  return Boolean(sentMessage);
}

/**
 * Schließt ein Ticket: Datenbank, Kanalrechte, Umbenennung, Transkript,
 * Löschtimer und Meldung im Verwaltungskanal.
 */
export async function closeTicket({ client, guild, ticket, config, actorId, ticketChannel = null }) {
  const department = getDepartmentById(config.departments, ticket.departmentId);
  const closedTicket = closeSupportTicket(guild.id, ticket.id, actorId);

  if (!closedTicket) {
    return null;
  }

  const channel = ticketChannel || (await resolveTextChannel(guild, ticket.channelId));

  if (channel) {
    await channel.permissionOverwrites.edit(ticket.userId, {
      ViewChannel: false,
      SendMessages: false
    }).catch(() => null);

    const nextName = channel.name.startsWith("geschlossen-")
      ? channel.name
      : `geschlossen-${channel.name}`.slice(0, 100);

    await channel.setName(nextName).catch(() => null);
    await channel.send({
      content: `Ticket geschlossen von <@${actorId}>. Dieser Kanal wird in 24 Stunden automatisch geloescht.`
    }).catch(() => null);
  }

  scheduleClosedTicketChannelDeletion({ client, ticket: closedTicket });

  const transcriptCreated = await postTicketTranscript({
    guild,
    ticketChannel: channel,
    ticket: closedTicket,
    config,
    departmentName: department?.name || ""
  });

  const managementChannel = await resolveTextChannel(guild, config.managementChannelId);
  if (managementChannel) {
    await managementChannel.send({
      content: transcriptCreated
        ? `Ticket ${ticket.id} wurde geschlossen von <@${actorId}>. Transkript wurde erstellt.`
        : `Ticket ${ticket.id} wurde geschlossen von <@${actorId}>. Transkript konnte nicht erstellt werden.`,
      allowedMentions: { parse: [] }
    }).catch(() => null);
  }

  return { ticket: closedTicket, transcriptCreated };
}

/**
 * Verschiebt ein Ticket in ein anderes Department und zieht die
 * Kanalberechtigungen entsprechend um.
 */
export async function escalateTicket({
  guild,
  ticket,
  config,
  actorId,
  currentDepartment,
  targetDepartment,
  ticketChannel = null
}) {
  const escalatedTicket = escalateSupportTicket(guild.id, ticket.id, targetDepartment.id, actorId);
  if (!escalatedTicket || escalatedTicket.status !== "open") {
    return null;
  }

  const channel = ticketChannel || (await resolveTextChannel(guild, ticket.channelId));

  if (channel) {
    const currentRoleIds = await resolveExistingRoleIds(guild, currentDepartment?.roleIds || []);
    const nextRoleIds = await resolveExistingRoleIds(guild, targetDepartment.roleIds || []);

    for (const roleId of currentRoleIds) {
      if (!nextRoleIds.includes(roleId)) {
        await channel.permissionOverwrites.delete(roleId).catch(() => null);
      }
    }

    for (const roleId of nextRoleIds) {
      await channel.permissionOverwrites.edit(roleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      }).catch(() => null);
    }

    const pingMentions = nextRoleIds.length > 0
      ? nextRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")
      : "@here";

    await channel.send({
      content: `${pingMentions}\nTicket ${ticket.id} wurde von <@${actorId}> auf ${targetDepartment.name} eskaliert.`,
      allowedMentions: {
        parse: nextRoleIds.length > 0 ? [] : ["everyone"],
        roles: nextRoleIds
      }
    }).catch(() => null);
  }

  const managementChannel = await resolveTextChannel(guild, config.managementChannelId);
  if (managementChannel) {
    await managementChannel.send({
      content: `Ticket ${ticket.id} wurde von <@${actorId}> auf ${targetDepartment.name} eskaliert: <#${ticket.channelId}>`,
      allowedMentions: { parse: [] }
    }).catch(() => null);
  }

  return escalatedTicket;
}

/**
 * Antwort aus dem Web-Dashboard. Sie wird bewusst als Bot-Embed mit
 * Absenderangabe gepostet, damit im Ticket nachvollziehbar bleibt,
 * dass die Nachricht nicht direkt in Discord geschrieben wurde.
 */
export async function sendTicketReply({ guild, ticket, author, content }) {
  const text = String(content || "").trim();
  if (!text) {
    return null;
  }

  const channel = await resolveTextChannel(guild, ticket.channelId);
  if (!channel) {
    return null;
  }

  const embed = new EmbedBuilder()
    .setColor(TICKET_REPLY_COLOR)
    .setAuthor({
      name: author.name,
      iconURL: author.avatarUrl || undefined
    })
    .setDescription(text.slice(0, TICKET_REPLY_MAX_LENGTH))
    .setFooter({ text: "Antwort aus dem Dashboard" })
    .setTimestamp(new Date());

  return channel.send({
    content: `<@${ticket.userId}>`,
    embeds: [embed],
    allowedMentions: { users: [ticket.userId] }
  });
}

function serializeEmbed(embed) {
  return {
    author: embed.author?.name || "",
    title: embed.title || "",
    description: embed.description || ""
  };
}

/**
 * Liest den Nachrichtenverlauf eines Tickets für die Dashboard-Ansicht,
 * älteste Nachricht zuerst.
 */
export async function listTicketMessages({ guild, ticket, limit = 100 }) {
  const channel = await resolveTextChannel(guild, ticket.channelId);
  if (!channel) {
    return { available: false, messages: [] };
  }

  const fetched = await channel.messages
    .fetch({ limit: Math.min(100, Math.max(1, limit)) })
    .catch(() => null);

  if (!fetched) {
    return { available: false, messages: [] };
  }

  const messages = [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((message) => ({
      id: message.id,
      authorId: message.author?.id || "",
      authorName: message.member?.displayName || message.author?.username || "Unbekannt",
      authorAvatarUrl: message.author?.displayAvatarURL({ size: 64 }) || "",
      fromBot: Boolean(message.author?.bot),
      content: message.content || "",
      createdAt: message.createdTimestamp,
      attachments: [...message.attachments.values()].map((file) => ({
        name: file.name,
        url: file.url
      })),
      embeds: message.embeds.map(serializeEmbed)
    }));

  return { available: true, messages };
}

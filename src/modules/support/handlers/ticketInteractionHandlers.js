import { AttachmentBuilder, ChannelType, MessageFlags } from "discord.js";
import { formatLocalTimestamp } from "../../../config/timezone.js";
import { getDepartmentById, normalizeDepartments } from "../services/config.js";
import {
  getSupportConfig,
  resolveExistingRoleIds,
  resolveTextChannel,
  resolveTranscriptChannel
} from "../services/channelResolvers.js";
import { createTicketChannel } from "../services/ticketChannelFactory.js";
import { scheduleClosedTicketChannelDeletion } from "../services/closedTicketCleanup.js";
import {
  closeSupportTicket,
  createSupportTicket,
  escalateSupportTicket,
  getOpenTicketByUser,
  getSupportTicket
} from "../services/tickets.js";
import { canEscalateTicket, canHandleTicket } from "../services/supportPermissions.js";
import {
  buildSupportTicketEscalationSelectPayload,
  buildSupportTicketDepartmentSelectPayload,
  buildSupportTicketOpenMessage,
  SUPPORT_TICKET_DESCRIPTION_INPUT_ID,
  SUPPORT_TICKET_NAME_INPUT_ID,
  SUPPORT_TICKET_OPEN_MODAL_PREFIX,
  buildSupportTicketOpenModal
} from "../services/ticketPanel.js";

async function buildTicketTranscriptContent(ticketChannel, ticket, departmentName) {
  const collected = [];
  let before;

  for (let index = 0; index < 10; index += 1) {
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

async function postTicketTranscript({ interaction, ticket, config, departmentName }) {
  const ticketChannel = interaction.channel && interaction.channel.type === ChannelType.GuildText
    ? interaction.channel
    : (await resolveTextChannel(interaction.guild, ticket.channelId));

  if (!ticketChannel) {
    return false;
  }

  const transcriptChannel = await resolveTranscriptChannel(interaction.guild, config);

  if (!transcriptChannel) {
    return false;
  }

  const transcriptContent = await buildTicketTranscriptContent(ticketChannel, ticket, departmentName);
  const attachment = new AttachmentBuilder(Buffer.from(transcriptContent, "utf8"), {
    name: `support-ticket-${ticket.id}.txt`
  });

  const sentMessage = await transcriptChannel.send({
    content: `Transkript für Ticket ${ticket.id} (geschlossen von <@${ticket.closedById || "system"}>)`,
    files: [attachment],
    allowedMentions: {
      parse: []
    }
  }).catch(() => null);

  return Boolean(sentMessage);
}

export async function handleTicketOpenButtonInteraction({ client, interaction }) {
  const supportState = client.botContext.settingsStore.getModuleState(interaction.guildId, "support");
  const config = supportState?.config || {};
  const departments = normalizeDepartments(config.departments);

  if (departments.length === 0) {
    await interaction.reply({
      content: "Es sind aktuell keine Departments konfiguriert.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply({
    ...buildSupportTicketDepartmentSelectPayload(departments),
    flags: MessageFlags.Ephemeral
  });
}

export async function handleTicketDepartmentSelectInteraction({ client, interaction }) {
  const selectedDepartmentId = interaction.values?.[0] || "";
  if (!selectedDepartmentId) {
    await interaction.reply({
      content: "Bitte wähle ein gültiges Department aus.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const supportState = client.botContext.settingsStore.getModuleState(interaction.guildId, "support");
  const config = supportState?.config || {};
  const department = getDepartmentById(config.departments, selectedDepartmentId);

  if (!department) {
    await interaction.reply({
      content: "Das gewählte Department wurde nicht gefunden.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.showModal(buildSupportTicketOpenModal(department.id, department.name));
}

function getDepartmentIdFromModalCustomId(customId) {
  if (!customId.startsWith(SUPPORT_TICKET_OPEN_MODAL_PREFIX)) {
    return "";
  }

  return customId.slice(SUPPORT_TICKET_OPEN_MODAL_PREFIX.length);
}

export async function handleTicketOpenModalInteraction({ client, interaction }) {
  const departmentId = getDepartmentIdFromModalCustomId(interaction.customId || "");
  if (!departmentId) {
    await interaction.reply({
      content: "Ungültige Ticket-Anfrage. Bitte erneut versuchen.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const ticketName = interaction.fields.getTextInputValue(SUPPORT_TICKET_NAME_INPUT_ID)?.trim() || "";
  const ticketDescription = interaction.fields.getTextInputValue(SUPPORT_TICKET_DESCRIPTION_INPUT_ID)?.trim() || "";

  if (!ticketName || !ticketDescription) {
    await interaction.reply({
      content: "Bitte gib einen Ticket-Namen und eine Beschreibung an.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const { settingsStore, env, logger } = client.botContext;
  const config = getSupportConfig(settingsStore, interaction.guildId, env);
  const department = getDepartmentById(config.departments, departmentId);

  if (!department) {
    await interaction.reply({
      content: "Das gewählte Department wurde nicht gefunden.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const activeTicket = getOpenTicketByUser(interaction.guildId, interaction.user.id);
  if (activeTicket) {
    const existingChannel = await resolveTextChannel(interaction.guild, activeTicket.channelId);
    if (existingChannel) {
      await interaction.reply({
        content: `Du hast bereits ein offenes Ticket: <#${activeTicket.channelId}>`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const autoClosedTicket = closeSupportTicket(interaction.guildId, activeTicket.id, "system");
    if (autoClosedTicket) {
      scheduleClosedTicketChannelDeletion({ client, ticket: autoClosedTicket });
    }
  }

  const ticketChannelResult = await createTicketChannel({
    guild: interaction.guild,
    user: interaction.user,
    department,
    config,
    logger,
    ticketName
  });

  const ticketChannel = ticketChannelResult?.channel || null;

  if (!ticketChannel) {
    if (ticketChannelResult?.errorCode === "missing_manage_channels") {
      await interaction.reply({
        content: "Ticket konnte nicht erstellt werden: Dem Bot fehlt die Berechtigung `Kanäle verwalten`.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (ticketChannelResult?.errorCode === "missing_manage_roles") {
      await interaction.reply({
        content: "Ticket konnte nicht erstellt werden: Dem Bot fehlt die Berechtigung `Rollen verwalten` für private Ticket-Rechte.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (ticketChannelResult?.errorCode === "missing_permissions_discord") {
      await interaction.reply({
        content: "Ticket konnte nicht erstellt werden: Dem Bot fehlen Rechte im Zielbereich (Kategorie/Channel-Rechte). Bitte Bot-Rollenrechte und Kategorie-Berechtigungen prüfen.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.reply({
      content: "Ticket konnte nicht erstellt werden. Bitte Team informieren.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const { ticket, created } = createSupportTicket({
    guildId: interaction.guildId,
    channelId: ticketChannel.id,
    userId: interaction.user.id,
    departmentId: department.id,
    ticketName,
    ticketDescription
  });

  if (!created || !ticket) {
    await ticketChannel.delete("Ticket konnte nicht gespeichert werden").catch(() => null);

    const existingTicket = getOpenTicketByUser(interaction.guildId, interaction.user.id);
    if (existingTicket) {
      await interaction.reply({
        content: `Du hast bereits ein offenes Ticket: <#${existingTicket.channelId}>`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.reply({
      content: "Ticket konnte nicht gespeichert werden. Bitte Team informieren.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await ticketChannel.send(buildSupportTicketOpenMessage(ticket, department));

  const managementChannel = await resolveTextChannel(interaction.guild, config.managementChannelId);
  if (managementChannel) {
    await managementChannel.send({
      content: `Neues Ticket ${ticket.id} von <@${ticket.userId}> im Department ${department.name}: <#${ticket.channelId}>\nTitel: ${ticket.ticketName}`,
      allowedMentions: {
        parse: []
      }
    });
  }

  await interaction.reply({
    content: `Dein Ticket wurde erstellt: <#${ticket.channelId}>`,
    flags: MessageFlags.Ephemeral
  });
}

export async function handleTicketEscalateInteraction({ client, interaction, ticketId }) {
  const ticket = getSupportTicket(interaction.guildId, ticketId);
  if (!ticket || ticket.status !== "open") {
    await interaction.reply({
      content: "Dieses Ticket ist bereits geschlossen oder ungültig.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const config = getSupportConfig(client.botContext.settingsStore, interaction.guildId, client.botContext.env);
  const departments = normalizeDepartments(config.departments);
  const currentDepartment = getDepartmentById(departments, ticket.departmentId);

  if (!canEscalateTicket(interaction, currentDepartment)) {
    await interaction.reply({
      content: "Nur Mitglieder des aktuellen Departments dürfen dieses Ticket eskalieren.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const alternativeDepartments = departments.filter((department) => department.id !== ticket.departmentId);
  if (alternativeDepartments.length === 0) {
    await interaction.reply({
      content: "Es gibt kein weiteres Department für die Eskalation.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply({
    ...buildSupportTicketEscalationSelectPayload(ticket, departments),
    flags: MessageFlags.Ephemeral
  });
}

export async function handleTicketEscalationSelectInteraction({ client, interaction, ticketId }) {
  const ticket = getSupportTicket(interaction.guildId, ticketId);
  if (!ticket || ticket.status !== "open") {
    await interaction.reply({
      content: "Dieses Ticket ist bereits geschlossen oder ungültig.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const selectedDepartmentId = interaction.values?.[0] || "";
  const config = getSupportConfig(client.botContext.settingsStore, interaction.guildId, client.botContext.env);
  const departments = normalizeDepartments(config.departments);
  const currentDepartment = getDepartmentById(departments, ticket.departmentId);

  if (!canEscalateTicket(interaction, currentDepartment)) {
    await interaction.reply({
      content: "Nur Mitglieder des aktuellen Departments dürfen dieses Ticket eskalieren.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!selectedDepartmentId || selectedDepartmentId === ticket.departmentId) {
    await interaction.update({
      content: "Bitte wähle ein anderes Department.",
      components: []
    });
    return;
  }

  const selectedDepartment = getDepartmentById(departments, selectedDepartmentId);
  if (!selectedDepartment) {
    await interaction.reply({
      content: "Gewähltes Department wurde nicht gefunden.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const escalatedTicket = escalateSupportTicket(
    interaction.guildId,
    ticket.id,
    selectedDepartmentId,
    interaction.user.id
  );
  if (!escalatedTicket || escalatedTicket.status !== "open") {
    await interaction.reply({
      content: "Ticket konnte nicht eskaliert werden.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const ticketChannel = interaction.channel && interaction.channel.type === ChannelType.GuildText
    ? interaction.channel
    : (await resolveTextChannel(interaction.guild, ticket.channelId));

  if (ticketChannel) {
    const currentRoleIds = await resolveExistingRoleIds(interaction.guild, currentDepartment?.roleIds || []);
    const nextRoleIds = await resolveExistingRoleIds(interaction.guild, selectedDepartment.roleIds || []);

    for (const roleId of currentRoleIds) {
      if (!nextRoleIds.includes(roleId)) {
        await ticketChannel.permissionOverwrites.delete(roleId).catch(() => null);
      }
    }

    for (const roleId of nextRoleIds) {
      await ticketChannel.permissionOverwrites.edit(roleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      }).catch(() => null);
    }

    const pingMentions = nextRoleIds.length > 0
      ? nextRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")
      : "@here";

    await ticketChannel.send({
      content: `${pingMentions}\nTicket ${ticket.id} wurde von <@${interaction.user.id}> auf ${selectedDepartment.name} eskaliert.`,
      allowedMentions: {
        parse: nextRoleIds.length > 0 ? [] : ["everyone"],
        roles: nextRoleIds
      }
    }).catch(() => null);
  }

  const managementChannel = await resolveTextChannel(interaction.guild, config.managementChannelId);
  if (managementChannel) {
    await managementChannel.send({
      content: `Ticket ${ticket.id} wurde von <@${interaction.user.id}> auf ${selectedDepartment.name} eskaliert: <#${ticket.channelId}>`,
      allowedMentions: {
        parse: []
      }
    }).catch(() => null);
  }

  await interaction.update({
    content: `Ticket wurde eskaliert auf ${selectedDepartment.name}.`,
    components: []
  });
}

export async function handleTicketCloseInteraction({ client, interaction, ticketId }) {
  const ticket = getSupportTicket(interaction.guildId, ticketId);
  if (!ticket || ticket.status !== "open") {
    await interaction.reply({
      content: "Dieses Ticket ist bereits geschlossen oder ungültig.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const config = getSupportConfig(client.botContext.settingsStore, interaction.guildId, client.botContext.env);
  const department = getDepartmentById(config.departments, ticket.departmentId);

  if (!canHandleTicket(interaction, ticket, department)) {
    await interaction.reply({
      content: "Du darfst dieses Ticket nicht schließen.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const closedTicket = closeSupportTicket(interaction.guildId, ticket.id, interaction.user.id);
  if (!closedTicket) {
    await interaction.reply({
      content: "Dieses Ticket ist nicht mehr offen.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.update({
    content: `Ticket wurde geschlossen von <@${interaction.user.id}>.`,
    components: []
  });

  const ticketChannel = interaction.channel && interaction.channel.type === ChannelType.GuildText
    ? interaction.channel
    : (await resolveTextChannel(interaction.guild, ticket.channelId));

  if (ticketChannel) {
    await ticketChannel.permissionOverwrites.edit(ticket.userId, {
      ViewChannel: false,
      SendMessages: false
    }).catch(() => null);

    const nextName = ticketChannel.name.startsWith("geschlossen-")
      ? ticketChannel.name
      : `geschlossen-${ticketChannel.name}`.slice(0, 100);

    await ticketChannel.setName(nextName).catch(() => null);
    await ticketChannel.send({
      content: `Ticket geschlossen von <@${interaction.user.id}>. Dieser Kanal wird in 24 Stunden automatisch geloescht.`
    }).catch(() => null);
  }

  scheduleClosedTicketChannelDeletion({ client, ticket: closedTicket });

  const transcriptCreated = await postTicketTranscript({
    interaction,
    ticket: closedTicket,
    config,
    departmentName: department?.name || ""
  });

  const managementChannel = await resolveTextChannel(interaction.guild, config.managementChannelId);
  if (managementChannel) {
    await managementChannel.send({
      content: transcriptCreated
        ? `Ticket ${ticket.id} wurde geschlossen von <@${interaction.user.id}>. Transkript wurde erstellt.`
        : `Ticket ${ticket.id} wurde geschlossen von <@${interaction.user.id}>. Transkript konnte nicht erstellt werden.`
    }).catch(() => null);
  }
}

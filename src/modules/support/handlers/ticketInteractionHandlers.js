import { ChannelType, MessageFlags } from "discord.js";
import { getDepartmentById, normalizeDepartments } from "../services/config.js";
import {
  getSupportConfig,
  resolveTextChannel
} from "../services/channelResolvers.js";
import { createTicketChannel } from "../services/ticketChannelFactory.js";
import { closeTicket, escalateTicket } from "../services/ticketActions.js";
import { scheduleClosedTicketChannelDeletion } from "../services/closedTicketCleanup.js";
import {
  closeSupportTicket,
  createSupportTicket,
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

  const escalatedTicket = await escalateTicket({
    guild: interaction.guild,
    ticket,
    config,
    actorId: interaction.user.id,
    currentDepartment,
    targetDepartment: selectedDepartment,
    ticketChannel: interaction.channel?.type === ChannelType.GuildText ? interaction.channel : null
  });

  if (!escalatedTicket) {
    await interaction.reply({
      content: "Ticket konnte nicht eskaliert werden.",
      flags: MessageFlags.Ephemeral
    });
    return;
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

  // Die Antwort muss vor den langlaufenden Kanal-Operationen raus,
  // sonst läuft das 3-Sekunden-Fenster der Interaction ab.
  await interaction.update({
    content: `Ticket wurde geschlossen von <@${interaction.user.id}>.`,
    components: []
  });

  const result = await closeTicket({
    client,
    guild: interaction.guild,
    ticket,
    config,
    actorId: interaction.user.id,
    ticketChannel: interaction.channel?.type === ChannelType.GuildText ? interaction.channel : null
  });

  if (!result) {
    await interaction.followUp({
      content: "Dieses Ticket ist nicht mehr offen.",
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
  }
}

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { resolveVoiceChannel } from "./channelResolvers.js";

function toChannelSlug(input, fallback = "ticket", maxLength = 24) {
  const normalized = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength);

  return normalized || fallback;
}

function buildTicketChannelName(user, department, ticketName) {
  const ticketPart = toChannelSlug(ticketName, "anliegen", 24);
  const departmentPart = toChannelSlug(department?.name, "support", 18);
  const idPart = String(user?.id || "xxxx").slice(-4);
  return `ticket-${departmentPart}-${ticketPart}-${idPart}`.slice(0, 100);
}

export async function createTicketChannel({ guild, user, department, config, logger, ticketName }) {
  const isMissingPermissionsError = (error) => {
    const apiCode = error?.code;
    return apiCode === 50013 || String(error || "").includes("Missing Permissions");
  };

  const roleIds = Array.isArray(department?.roleIds) ? department.roleIds : [];
  const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  const canManageChannels = Boolean(me?.permissions?.has(PermissionFlagsBits.ManageChannels));
  const canManageRoles = Boolean(me?.permissions?.has(PermissionFlagsBits.ManageRoles));
  const isAdministrator = Boolean(me?.permissions?.has(PermissionFlagsBits.Administrator));

  if (!canManageChannels) {
    logger.warn("Ticket-Channel konnte nicht erstellt werden: fehlende Rechte", {
      guildId: guild.id,
      requiredPermission: "ManageChannels",
      botPermissions: {
        administrator: isAdministrator,
        manageChannels: canManageChannels,
        manageRoles: canManageRoles
      }
    });

    return {
      channel: null,
      errorCode: "missing_manage_channels"
    };
  }

  if (!canManageRoles) {
    logger.warn("Ticket-Channel konnte nicht erstellt werden: fehlende Rechte für private Overwrites", {
      guildId: guild.id,
      requiredPermission: "ManageRoles",
      botPermissions: {
        administrator: isAdministrator,
        manageChannels: canManageChannels,
        manageRoles: canManageRoles
      }
    });

    return {
      channel: null,
      errorCode: "missing_manage_roles"
    };
  }

  let parentCategoryId = null;
  if (config.ticketCategoryId) {
    const parent = guild.channels.cache.get(config.ticketCategoryId)
      || (await guild.channels.fetch(config.ticketCategoryId).catch(() => null));

    if (parent && parent.type === ChannelType.GuildCategory) {
      const parentPerms = parent.permissionsFor(me);
      const canUseParent = parentPerms
        && parentPerms.has(PermissionFlagsBits.ViewChannel)
        && parentPerms.has(PermissionFlagsBits.ManageChannels);

      if (canUseParent) {
        parentCategoryId = parent.id;
      } else {
        logger.warn("Ticket-Kategorie kann nicht verwendet werden, fallback ohne Kategorie", {
          guildId: guild.id,
          categoryId: parent.id
        });
      }
    }
  }

  const validRoleIds = [];
  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));
    if (role) {
      validRoleIds.push(role.id);
    }
  }

  const basePermissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    }
  ];

  basePermissionOverwrites.push({
    id: me.id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory
    ]
  });

  const departmentPermissionOverwrites = [];
  for (const roleId of validRoleIds) {
    departmentPermissionOverwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    });
  }

  const attempts = [
    {
      id: "category_with_department_roles",
      parent: parentCategoryId,
      permissionOverwrites: [...basePermissionOverwrites, ...departmentPermissionOverwrites]
    },
    {
      id: "root_with_department_roles",
      parent: null,
      permissionOverwrites: [...basePermissionOverwrites, ...departmentPermissionOverwrites]
    },
    {
      id: "root_minimal_permissions",
      parent: null,
      permissionOverwrites: [...basePermissionOverwrites]
    }
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      const channel = await guild.channels.create({
        name: buildTicketChannelName(user, department, ticketName),
        type: ChannelType.GuildText,
        parent: attempt.parent,
        topic: `Support-Ticket für ${user.id} | Department: ${department?.id || "unbekannt"} | Titel: ${ticketName}`.slice(0, 1024),
        permissionOverwrites: attempt.permissionOverwrites,
        reason: `Support-Ticket erstellt von ${user.id}`
      });

      return {
        channel,
        errorCode: ""
      };
    } catch (error) {
      lastError = error;

      logger.warn("Ticket-Channel-Erstellung fehlgeschlagen (Retry folgt)", {
        guildId: guild.id,
        userId: user.id,
        departmentId: department?.id || "",
        attempt: attempt.id,
        error: String(error)
      });
    }
  }

  return {
    channel: null,
    errorCode: isMissingPermissionsError(lastError) ? "missing_permissions_discord" : "create_failed"
  };
}

function buildExtraTalkChannelName(guild, prefix, startIndex) {
  const takenNames = new Set(
    [...guild.channels.cache.values()].map((channel) => channel.name.toLowerCase())
  );

  for (let index = startIndex; index <= startIndex + 100; index += 1) {
    const candidate = `${prefix}-${index}`;
    if (!takenNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return `${prefix}-${Date.now().toString(36)}`;
}

export async function findFreeTalkChannel(client, guild, config) {
  const { settingsStore, env, logger } = client.botContext;
  const talkIds = Array.isArray(config.talkChannelIds) ? config.talkChannelIds : [];

  for (const channelId of talkIds) {
    const channel = await resolveVoiceChannel(guild, channelId);
    if (!channel) {
      continue;
    }

    const nonBotMemberCount = channel.members.filter((member) => !member.user.bot).size;
    if (nonBotMemberCount === 0) {
      return channel;
    }
  }

  const talkCategoryId = config.talkCategoryId || null;
  const parent = talkCategoryId ? guild.channels.cache.get(talkCategoryId) : null;
  const prefix = String(env.supportTalkChannelPrefix || "support-talk").trim() || "support-talk";

  try {
    const channel = await guild.channels.create({
      name: buildExtraTalkChannelName(guild, prefix, talkIds.length + 1),
      type: ChannelType.GuildVoice,
      parent: parent?.id || null,
      reason: "Zusätzlicher freier Support-Talk wurde benötigt"
    });

    // Ohne diesen Schritt kennt die Provisionierung den Kanal beim nächsten
    // Start nicht und legt daneben einen weiteren an.
    settingsStore.setModuleConfig(guild.id, "support", {
      talkChannelIds: [...talkIds, channel.id]
    });

    return channel;
  } catch (error) {
    logger.warn("Zusätzlicher Support-Talk konnte nicht erstellt werden", {
      guildId: guild.id,
      error: String(error)
    });
    return null;
  }
}

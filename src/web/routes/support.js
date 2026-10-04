import { ACCESS_LEVELS, requireLevel } from "../auth.js";
import { HttpError, sendJson } from "../http.js";
import { recordAudit } from "../../core/audit.js";
import { buildTeamStats } from "../../core/staffEvents.js";
import { getDepartmentById, normalizeDepartments } from "../../modules/support/services/config.js";
import { getSupportConfig } from "../../modules/support/services/channelResolvers.js";
import {
  closeTicket,
  escalateTicket,
  listTicketMessages,
  sendTicketReply
} from "../../modules/support/services/ticketActions.js";
import {
  getSupportTicket,
  getSupportTicketStats,
  listSupportTickets
} from "../../modules/support/services/tickets.js";
import { getSupportCaseStats, listSupportCases } from "../../modules/support/services/cases.js";
import { listWeeklyReportsForWeek } from "../../modules/weeklyReport/services/reports.js";
import { formatWeekLabel, getIsoWeekKey } from "../../modules/weeklyReport/services/week.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseRange(searchParams) {
  const days = Number(searchParams.get("days") || 30);
  const safeDays = Number.isFinite(days) ? Math.min(365, Math.max(1, days)) : 30;
  return { from: Date.now() - safeDays * DAY_MS, to: Date.now(), days: safeDays };
}

// Staff sieht nur die eigenen Departments, Leads ihre Bereiche, Admins alles.
function visibleDepartmentFilter(access) {
  if (access.level >= ACCESS_LEVELS.admin) {
    return null;
  }

  return new Set([...access.departments, ...access.leadDepartments]);
}

async function decorateUsers(guild, entries, keys) {
  const ids = new Set();
  for (const entry of entries) {
    for (const key of keys) {
      if (entry[key]) {
        ids.add(entry[key]);
      }
    }
  }

  const users = {};
  for (const id of ids) {
    const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
    users[id] = {
      id,
      name: member?.displayName || member?.user?.username || id,
      avatarUrl: member?.displayAvatarURL({ size: 64 }) || ""
    };
  }

  return users;
}

export function registerSupportRoutes(router, { client }) {
  router.get("/api/guilds/:guildId/tickets", async (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.staff);

    const filter = visibleDepartmentFilter(ctx.access);
    let tickets = listSupportTickets(ctx.params.guildId, {
      status: ctx.url.searchParams.get("status") || "",
      departmentId: ctx.url.searchParams.get("department") || "",
      limit: Number(ctx.url.searchParams.get("limit") || 200)
    });

    if (filter) {
      tickets = tickets.filter((ticket) => filter.has(ticket.departmentId));
    }

    const departments = normalizeDepartments(
      client.botContext.settingsStore.getModuleState(ctx.params.guildId, "support")?.config?.departments
    );

    sendJson(ctx.res, 200, {
      tickets,
      departments,
      users: await decorateUsers(ctx.access.guild, tickets, ["userId", "closedById"])
    });
  });

  // Lädt ein Ticket und prüft dabei, ob der Anfragende dessen Department sehen darf.
  function loadAccessibleTicket(ctx, { requireOpen = false } = {}) {
    requireLevel(ctx.access, ACCESS_LEVELS.staff);

    const ticket = getSupportTicket(ctx.params.guildId, ctx.params.ticketId);
    if (!ticket) {
      throw new HttpError(404, "Ticket nicht gefunden");
    }

    const filter = visibleDepartmentFilter(ctx.access);
    if (filter && !filter.has(ticket.departmentId)) {
      throw new HttpError(403, "Kein Zugriff auf dieses Department");
    }

    if (requireOpen && ticket.status !== "open") {
      throw new HttpError(409, "Dieses Ticket ist bereits geschlossen");
    }

    return ticket;
  }

  router.get("/api/guilds/:guildId/tickets/:ticketId", (ctx) => {
    sendJson(ctx.res, 200, loadAccessibleTicket(ctx));
  });

  router.get("/api/guilds/:guildId/tickets/:ticketId/messages", async (ctx) => {
    const ticket = loadAccessibleTicket(ctx);
    const history = await listTicketMessages({
      guild: ctx.access.guild,
      ticket,
      limit: Number(ctx.url.searchParams.get("limit") || 100)
    });

    sendJson(ctx.res, 200, { ticket, ...history });
  });

  router.post("/api/guilds/:guildId/tickets/:ticketId/messages", async (ctx) => {
    const ticket = loadAccessibleTicket(ctx, { requireOpen: true });
    const content = String(ctx.body.content || "").trim();

    if (!content) {
      throw new HttpError(400, "Nachricht ist leer");
    }

    const member = ctx.access.member;
    const message = await sendTicketReply({
      guild: ctx.access.guild,
      ticket,
      author: {
        name: member?.displayName || ctx.session.displayName || ctx.session.username,
        avatarUrl: member?.displayAvatarURL({ size: 64 }) || ""
      },
      content
    });

    if (!message) {
      throw new HttpError(502, "Der Ticket-Channel ist nicht erreichbar");
    }

    recordAudit({
      guildId: ctx.params.guildId,
      actorId: ctx.session.discordId,
      actorName: ctx.session.username,
      action: "ticket.reply",
      detail: { ticketId: ticket.id, length: content.length }
    });

    sendJson(ctx.res, 201, { ok: true, messageId: message.id });
  });

  router.post("/api/guilds/:guildId/tickets/:ticketId/close", async (ctx) => {
    const ticket = loadAccessibleTicket(ctx, { requireOpen: true });
    const config = getSupportConfig(client.botContext.settingsStore, ctx.params.guildId, client.botContext.env);

    const result = await closeTicket({
      client,
      guild: ctx.access.guild,
      ticket,
      config,
      actorId: ctx.session.discordId
    });

    if (!result) {
      throw new HttpError(409, "Dieses Ticket ist nicht mehr offen");
    }

    recordAudit({
      guildId: ctx.params.guildId,
      actorId: ctx.session.discordId,
      actorName: ctx.session.username,
      action: "ticket.close",
      detail: { ticketId: ticket.id, transcript: result.transcriptCreated }
    });

    sendJson(ctx.res, 200, result.ticket);
  });

  router.post("/api/guilds/:guildId/tickets/:ticketId/escalate", async (ctx) => {
    const ticket = loadAccessibleTicket(ctx, { requireOpen: true });
    const config = getSupportConfig(client.botContext.settingsStore, ctx.params.guildId, client.botContext.env);
    const departments = normalizeDepartments(config.departments);

    const targetDepartment = getDepartmentById(departments, ctx.body.departmentId);
    if (!targetDepartment) {
      throw new HttpError(404, "Department nicht gefunden");
    }

    if (targetDepartment.id === ticket.departmentId) {
      throw new HttpError(400, "Das Ticket liegt bereits in diesem Department");
    }

    const escalated = await escalateTicket({
      guild: ctx.access.guild,
      ticket,
      config,
      actorId: ctx.session.discordId,
      currentDepartment: getDepartmentById(departments, ticket.departmentId),
      targetDepartment
    });

    if (!escalated) {
      throw new HttpError(409, "Ticket konnte nicht eskaliert werden");
    }

    recordAudit({
      guildId: ctx.params.guildId,
      actorId: ctx.session.discordId,
      actorName: ctx.session.username,
      action: "ticket.escalate",
      detail: { ticketId: ticket.id, departmentId: targetDepartment.id }
    });

    sendJson(ctx.res, 200, escalated);
  });

  router.get("/api/guilds/:guildId/cases", async (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.staff);

    const filter = visibleDepartmentFilter(ctx.access);
    let cases = listSupportCases(ctx.params.guildId, {
      status: ctx.url.searchParams.get("status") || "",
      limit: Number(ctx.url.searchParams.get("limit") || 200)
    });

    if (filter) {
      cases = cases.filter((entry) => filter.has(entry.departmentId));
    }

    sendJson(ctx.res, 200, {
      cases,
      users: await decorateUsers(ctx.access.guild, cases, ["userId", "supporterId"])
    });
  });

  router.get("/api/guilds/:guildId/stats/support", (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.staff);

    const range = parseRange(ctx.url.searchParams);
    sendJson(ctx.res, 200, {
      range,
      tickets: getSupportTicketStats(ctx.params.guildId, range.from),
      cases: getSupportCaseStats(ctx.params.guildId, range.from)
    });
  });

  router.get("/api/guilds/:guildId/stats/team", async (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.lead);

    const range = parseRange(ctx.url.searchParams);
    const stats = buildTeamStats(ctx.params.guildId, range);
    const departments = normalizeDepartments(
      client.botContext.settingsStore.getModuleState(ctx.params.guildId, "support")?.config?.departments
    );

    sendJson(ctx.res, 200, {
      range,
      departments,
      members: stats,
      users: await decorateUsers(ctx.access.guild, stats, ["userId"])
    });
  });

  router.get("/api/guilds/:guildId/weekly-reports", (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.lead);

    const week = ctx.url.searchParams.get("week") || getIsoWeekKey();
    const reports = listWeeklyReportsForWeek(ctx.params.guildId, week);

    sendJson(ctx.res, 200, {
      week,
      label: formatWeekLabel(week),
      reports
    });
  });
}

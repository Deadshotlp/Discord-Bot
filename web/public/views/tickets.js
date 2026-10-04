import { ACCESS, api } from "../lib/api.js";
import {
  badge,
  card,
  clear,
  confirmDialog,
  formatDateTime,
  formatMs,
  formatRelative,
  h,
  select,
  spinner,
  stat,
  table,
  toast
} from "../lib/ui.js";
import { barChart } from "../lib/charts.js";

// Der Verlauf wird nachgeladen, solange die Detailansicht sichtbar ist.
const THREAD_POLL_MS = 15000;

function userCell(users, userId) {
  const user = users[userId];
  if (!user) {
    return h("span.mono", {}, userId || "–");
  }

  return h("div.user-cell", {},
    user.avatarUrl ? h("img", { src: user.avatarUrl, alt: "" }) : null,
    user.name);
}

function statusBadge(status) {
  if (status === "open") {
    return badge("offen", "warning");
  }

  if (status === "claimed") {
    return badge("in Bearbeitung", "info");
  }

  return badge("geschlossen", "success");
}

function discordChannelUrl(guildId, channelId) {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

function messageBubble(message) {
  const embedBlocks = message.embeds
    .filter((embed) => embed.description || embed.title || embed.author)
    .map((embed) => h("div.thread-embed", {},
      embed.author ? h("div.thread-embed-author", {}, embed.author) : null,
      embed.title ? h("strong", {}, embed.title) : null,
      embed.description ? h("div", {}, embed.description) : null));

  return h("div.thread-message", {},
    message.authorAvatarUrl
      ? h("img.thread-avatar", { src: message.authorAvatarUrl, alt: "" })
      : h("div.thread-avatar.placeholder", {}, (message.authorName || "?").slice(0, 1)),

    h("div.thread-body", {},
      h("div.thread-meta", {},
        h("strong", {}, message.authorName),
        message.fromBot ? badge("Bot", "neutral") : null,
        h("span.muted", {}, formatDateTime(message.createdAt))),

      message.content ? h("div.thread-text", {}, message.content) : null,
      ...embedBlocks,

      ...message.attachments.map((file) =>
        h("a.thread-attachment", { href: file.url, target: "_blank", rel: "noreferrer" }, `📎 ${file.name}`))));
}

async function renderTicketDetail({ guildId, guild, ticket, departments, users, onBack }) {
  const container = h("div.stack");
  const isOpen = ticket.status === "open";
  const canManage = guild.accessLevel >= ACCESS.STAFF;

  const departmentName = (id) =>
    departments.find((department) => department.id === id)?.name || id || "–";

  const threadBox = h("div.thread", {}, spinner("Verlauf wird geladen …"));

  async function loadThread() {
    try {
      const history = await api.ticketMessages(guildId, ticket.id);

      if (!history.available) {
        clear(threadBox).append(
          h("p.muted", {}, "Der Discord-Channel dieses Tickets existiert nicht mehr. "
            + "Der Verlauf steht nur noch im Transkript zur Verfügung."));
        return;
      }

      if (history.messages.length === 0) {
        clear(threadBox).append(h("p.muted", {}, "Noch keine Nachrichten."));
        return;
      }

      const atBottom = threadBox.scrollTop + threadBox.clientHeight >= threadBox.scrollHeight - 40;
      clear(threadBox).append(...history.messages.map(messageBubble));

      if (atBottom) {
        threadBox.scrollTop = threadBox.scrollHeight;
      }
    } catch (error) {
      clear(threadBox).append(h("p.muted", {}, error.message));
    }
  }

  function schedulePoll() {
    setTimeout(async () => {
      // Beim Wechsel auf eine andere Seite hängt der Knoten nicht mehr im DOM.
      if (!container.isConnected) {
        return;
      }

      await loadThread();
      schedulePoll();
    }, THREAD_POLL_MS);
  }

  const replyInput = h("textarea.input", {
    placeholder: "Antwort an das Mitglied schreiben …",
    rows: 3
  });

  const replyForm = h("form.stack", {
    onSubmit: async (event) => {
      event.preventDefault();

      const content = replyInput.value.trim();
      if (!content) {
        return;
      }

      const submitButton = replyForm.querySelector("button[type=submit]");
      submitButton.disabled = true;

      try {
        await api.sendTicketMessage(guildId, ticket.id, content);
        replyInput.value = "";
        await loadThread();
        threadBox.scrollTop = threadBox.scrollHeight;
      } catch (error) {
        toast(error.message, "error");
      } finally {
        submitButton.disabled = false;
      }
    }
  },
  replyInput,
  h("div.row-between", {},
    h("span.muted", { style: { fontSize: "12px" } },
      "Wird als Bot-Nachricht mit deinem Namen im Ticket-Channel gepostet."),
    h("button.btn.btn-primary.btn-sm", { type: "submit" }, "Senden")));

  const otherDepartments = departments.filter((department) => department.id !== ticket.departmentId);
  const escalateSelect = select(
    [{ value: "", label: "– Department wählen –" },
      ...otherDepartments.map((department) => ({ value: department.id, label: department.name }))],
    {}
  );

  const actionsRow = h("div.row", { style: { flexWrap: "wrap", gap: "8px", alignItems: "center" } },
    h("a.btn.btn-ghost.btn-sm", {
      href: discordChannelUrl(guildId, ticket.channelId),
      target: "_blank",
      rel: "noreferrer"
    }, "In Discord öffnen"),

    isOpen && canManage && otherDepartments.length > 0 ? escalateSelect : null,
    isOpen && canManage && otherDepartments.length > 0
      ? h("button.btn.btn-sm", {
        onClick: async (event) => {
          const target = escalateSelect.value;
          if (!target) {
            toast("Bitte zuerst ein Department wählen.", "error");
            return;
          }

          event.target.disabled = true;
          try {
            await api.escalateTicket(guildId, ticket.id, target);
            toast("Ticket wurde verschoben.", "success");
            await onBack();
          } catch (error) {
            event.target.disabled = false;
            toast(error.message, "error");
          }
        }
      }, "Verschieben")
      : null,

    isOpen && canManage
      ? h("button.btn.btn-danger.btn-sm", {
        onClick: async (event) => {
          if (!confirmDialog(`Ticket „${ticket.ticketName || ticket.id}“ schließen?`)) {
            return;
          }

          event.target.disabled = true;
          try {
            await api.closeTicket(guildId, ticket.id);
            toast("Ticket geschlossen. Der Channel wird in 24 h gelöscht.", "success");
            await onBack();
          } catch (error) {
            event.target.disabled = false;
            toast(error.message, "error");
          }
        }
      }, "Ticket schließen")
      : null);

  container.append(
    h("div.page-header", {},
      h("div.row", { style: { alignItems: "center", gap: "10px" } },
        h("button.btn.btn-ghost.btn-sm", { onClick: () => onBack() }, "← Zurück"),
        h("h1", {}, ticket.ticketName || "Ticket"),
        statusBadge(ticket.status))),

    card("Übersicht",
      table(["Ersteller", "Department", "Erstellt", "Geschlossen von", "Dauer"], [[
        userCell(users, ticket.userId),
        departmentName(ticket.departmentId),
        formatDateTime(ticket.createdAt),
        ticket.closedById ? userCell(users, ticket.closedById) : "–",
        ticket.closedAt ? formatMs(ticket.closedAt - ticket.createdAt) : formatRelative(ticket.createdAt)
      ]]),
      ticket.ticketDescription
        ? h("div", { style: { marginTop: "12px" } },
          h("div.field-label", {}, "Beschreibung"),
          h("p", {}, ticket.ticketDescription))
        : null,
      actionsRow),

    card("Verlauf", threadBox),

    isOpen
      ? card("Antworten", replyForm)
      : card("Antworten", h("p.muted", {}, "Das Ticket ist geschlossen – es kann nicht mehr geantwortet werden.")));

  await loadThread();
  threadBox.scrollTop = threadBox.scrollHeight;
  schedulePoll();

  return container;
}

export async function renderTickets({ guildId, guild }) {
  const container = h("div.stack");
  const filters = { status: "", department: "", days: 30 };
  let selectedTicketId = "";

  async function refresh() {
    clear(container).append(spinner());

    const query = new URLSearchParams();
    if (filters.status) {
      query.set("status", filters.status);
    }

    if (filters.department) {
      query.set("department", filters.department);
    }

    const [ticketData, caseData, stats] = await Promise.all([
      api.tickets(guildId, query.toString() ? `?${query}` : ""),
      api.cases(guildId).catch(() => ({ cases: [], users: {} })),
      api.supportStats(guildId, filters.days).catch(() => null)
    ]);

    const departmentName = (id) =>
      ticketData.departments.find((department) => department.id === id)?.name || id || "–";

    if (selectedTicketId) {
      const ticket = ticketData.tickets.find((entry) => entry.id === selectedTicketId);

      if (ticket) {
        clear(container).append(await renderTicketDetail({
          guildId,
          guild,
          ticket,
          departments: ticketData.departments,
          users: ticketData.users,
          onBack: async () => {
            selectedTicketId = "";
            await refresh();
          }
        }));
        return;
      }

      // Ticket passt nicht mehr zum Filter (z. B. nach dem Schließen).
      selectedTicketId = "";
    }

    const openDetail = (ticketId) => {
      selectedTicketId = ticketId;
      refresh().catch((error) => toast(error.message, "error"));
    };

    clear(container).append(
      h("div.page-header", {},
        h("h1", {}, "Tickets"),
        h("div.page-actions", {},
          select([
            { value: "", label: "Alle Status" },
            { value: "open", label: "Nur offene" },
            { value: "closed", label: "Nur geschlossene" }
          ], {
            value: filters.status,
            onChange: (event) => { filters.status = event.target.value; refresh(); }
          }),
          select([
            { value: "", label: "Alle Departments" },
            ...ticketData.departments.map((department) => ({ value: department.id, label: department.name }))
          ], {
            value: filters.department,
            onChange: (event) => { filters.department = event.target.value; refresh(); }
          }),
          select([
            { value: "7", label: "7 Tage" },
            { value: "30", label: "30 Tage" },
            { value: "90", label: "90 Tage" },
            { value: "365", label: "1 Jahr" }
          ], {
            value: String(filters.days),
            onChange: (event) => { filters.days = Number(event.target.value); refresh(); }
          }))),

      stats
        ? h("div.grid.grid-4", {},
          stat("Tickets gesamt", String(stats.tickets.total), `${filters.days} Tage`),
          stat("Offen", String(stats.tickets.open)),
          stat("Ø Bearbeitungsdauer", stats.tickets.averageDurationMs ? formatMs(stats.tickets.averageDurationMs) : "–"),
          stat("Sprach-Fälle", String(stats.cases.total),
            stats.cases.averageClaimWaitMs ? `Ø Wartezeit ${formatMs(stats.cases.averageClaimWaitMs)}` : null))
        : null,

      stats && stats.tickets.perDay.length > 0
        ? card("Tickets pro Tag",
          barChart(stats.tickets.perDay.map((entry) => ({
            label: entry.day.slice(8),
            value: entry.total
          })), { height: 170 }))
        : null,

      stats && stats.tickets.perDepartment.length > 0
        ? card("Verteilung nach Department",
          table(["Department", "Tickets"], stats.tickets.perDepartment.map((entry) => [
            departmentName(entry.departmentId), String(entry.total)
          ])))
        : null,

      card(`Tickets (${ticketData.tickets.length})`,
        table(
          ["Status", "Titel", "Ersteller", "Department", "Erstellt", "Geschlossen von", "Dauer", ""],
          ticketData.tickets.map((ticket) => [
            statusBadge(ticket.status),
            h("div.link-cell", { onClick: () => openDetail(ticket.id) },
              h("strong", {}, ticket.ticketName || "(ohne Titel)"),
              ticket.ticketDescription
                ? h("div.muted", { style: { fontSize: "12px" } }, ticket.ticketDescription.slice(0, 90))
                : null),
            userCell(ticketData.users, ticket.userId),
            departmentName(ticket.departmentId),
            formatDateTime(ticket.createdAt),
            ticket.closedById ? userCell(ticketData.users, ticket.closedById) : "–",
            ticket.closedAt ? formatMs(ticket.closedAt - ticket.createdAt) : "–",
            h("button.btn.btn-sm", { onClick: () => openDetail(ticket.id) }, "Öffnen")
          ]),
          { empty: "Keine Tickets im gewählten Filter." })),

      card(`Sprach-Fälle (${caseData.cases.length})`,
        table(
          ["Status", "Nutzer", "Supporter", "Department", "Erstellt", "Wartezeit"],
          caseData.cases.slice(0, 100).map((entry) => [
            statusBadge(entry.status),
            userCell(caseData.users, entry.userId),
            entry.supporterId ? userCell(caseData.users, entry.supporterId) : "–",
            departmentName(entry.departmentId),
            formatDateTime(entry.createdAt),
            entry.claimedAt ? formatMs(entry.claimedAt - entry.createdAt) : "–"
          ]),
          { empty: "Keine Sprach-Fälle." })));
  }

  await refresh();
  return container;
}

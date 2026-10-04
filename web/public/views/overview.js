import { ACCESS, api } from "../lib/api.js";
import { badge, card, formatDate, formatDateTime, formatRelative, h, stat, table, todayIso } from "../lib/ui.js";
import { lineChart } from "../lib/charts.js";

function serverTile(summary) {
  const current = summary.current;
  const online = Boolean(current?.online) && !current?.stale;

  return h("a.stat", { href: `#/g/${summary.server.id ? "" : ""}`, style: { display: "block" } },
    h("div.server-head", {},
      h("span.dot", { class: online ? "online" : "offline" }),
      h("strong", {}, summary.server.name)),
    h("div.stat-value", { style: { fontSize: "22px", marginTop: "8px" } },
      online ? `${current.players} / ${current.maxPlayers}` : "offline"),
    h("div.stat-hint", {},
      online
        ? `${current.map || "–"} · Ø 24 h ${summary.averages.last24h} · Peak ${summary.peaks.last24h.peak}`
        : `Letzte Messung ${formatRelative(current?.takenAt)}`));
}

export async function renderOverview({ guildId, guild }) {
  const isStaff = guild.accessLevel >= ACCESS.STAFF;

  const [servers, absences, meetings, supportStats] = await Promise.all([
    api.servers(guildId).catch(() => []),
    api.absences(guildId).catch(() => ({ absences: [], users: {}, departments: [] })),
    api.meetings(guildId).catch(() => []),
    isStaff ? api.supportStats(guildId, 30).catch(() => null) : Promise.resolve(null)
  ]);

  const today = todayIso();
  const currentlyAway = absences.absences.filter((absence) =>
    absence.status === "active" && absence.startsOn <= today && absence.endsOn >= today);

  const onlineServers = servers.filter((summary) => summary.current?.online && !summary.current?.stale);
  const totalPlayers = onlineServers.reduce((sum, summary) => sum + Number(summary.current.players || 0), 0);

  const nextMeeting = meetings
    .filter((meeting) => meeting.nextOccurrence)
    .sort((a, b) => a.nextOccurrence - b.nextOccurrence)[0];

  const primary = servers.find((summary) => summary.current) || servers[0];
  let primarySeries = null;
  if (primary) {
    primarySeries = await api.series(guildId, primary.server.id, "24h").catch(() => null);
  }

  return h("div.stack", {},
    h("div.page-header", {}, h("h1", {}, "Übersicht")),

    h("div.grid.grid-4", {},
      stat("Server online", `${onlineServers.length} / ${servers.length}`),
      stat("Spieler gerade", String(totalPlayers)),
      stat("Heute abgemeldet", String(currentlyAway.length),
        currentlyAway.length > 0 ? currentlyAway.slice(0, 3).map((entry) => absences.users[entry.userId]?.name || "?").join(", ") : null),
      isStaff && supportStats
        ? stat("Offene Tickets", String(supportStats.tickets.open), `${supportStats.tickets.total} in 30 Tagen`)
        : stat("Nächstes Meeting", nextMeeting ? formatDateTime(nextMeeting.nextOccurrence) : "–", nextMeeting?.name)),

    primary && primarySeries
      ? card(h("span", {}, `Spielerverlauf · ${primary.server.name} · 24 Stunden`),
        lineChart(primarySeries.points, { color: primary.server.color }),
        h("div.chart-legend", {},
          h("span", {}, h("span.legend-swatch", { style: { background: primary.server.color } }), "Ø Spieler"),
          h("span", {}, h("span.legend-swatch", { style: { background: "var(--text-muted)" } }), "Peak"),
          h("span", {}, h("span.legend-swatch", { style: { background: "var(--danger)" } }), "Slots")))
      : null,

    servers.length > 0
      ? card("Server", h("div.grid.grid-3", {}, ...servers.map(serverTile)))
      : null,

    h("div.grid.grid-2", {},
      card("Aktuell abgemeldet",
        table(["Wer", "Zeitraum", "Art"],
          currentlyAway.slice(0, 8).map((absence) => [
            h("div.user-cell", {},
              absences.users[absence.userId]?.avatarUrl
                ? h("img", { src: absences.users[absence.userId].avatarUrl, alt: "" })
                : null,
              absences.users[absence.userId]?.name || absence.userId),
            `${formatDate(absence.startsOn)} – ${formatDate(absence.endsOn)}`,
            badge(absence.kind, "info")
          ]),
          { empty: "Heute ist niemand abgemeldet. 🎉" })),

      card("Nächste Meetings",
        table(["Meeting", "Termin", "Themen"],
          meetings
            .filter((meeting) => meeting.nextOccurrence)
            .sort((a, b) => a.nextOccurrence - b.nextOccurrence)
            .slice(0, 6)
            .map((meeting) => [
              meeting.name,
              formatDateTime(meeting.nextOccurrence),
              String(meeting.topics?.length || 0)
            ]),
          { empty: "Keine Meetings konfiguriert." }))));
}

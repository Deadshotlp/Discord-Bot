export const DEFAULT_TIMEZONE = "Europe/Berlin";

function isKnownTimezone(zone) {
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Setzt die Zeitzone des Prozesses. Der gesamte Bot rechnet mit lokaler Zeit –
 * Tagesgrenzen von Abmeldungen, Meeting-Termine, Wochenberichte, Tagesprofile
 * im Monitoring. Im Container ist die Systemzeit üblicherweise UTC, wodurch
 * alles um eine bis zwei Stunden verschoben wäre.
 *
 * Node übernimmt eine Änderung von process.env.TZ zur Laufzeit, solange sie
 * vor der ersten Datumsberechnung erfolgt. Deshalb wird das hier beim Laden
 * der Konfiguration erledigt.
 *
 * Bewusst eine Zeitzone statt eines festen Versatzes: "Europe/Berlin" deckt
 * MEZ (+1) und MESZ (+2) samt Umstellungsterminen ab, "+01:00" wäre im Sommer
 * eine Stunde daneben.
 */
export function applyTimezone(rawValue) {
  const requested = String(rawValue ?? "").trim() || DEFAULT_TIMEZONE;
  const valid = isKnownTimezone(requested);
  const timezone = valid ? requested : DEFAULT_TIMEZONE;

  process.env.TZ = timezone;

  return { timezone, requested, valid };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/** Versatz der Ortszeit zu UTC, z. B. "+02:00". */
export function formatOffset(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/**
 * Ortszeit mit Versatz, z. B. "2026-10-04 14:23:05 +02:00". Für Logs und
 * Transkripte – toISOString() liefert immer UTC und wirkt dadurch, als ginge
 * der Bot zwei Stunden nach.
 */
export function formatLocalTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${formatOffset(date)}`;
}

export function describeTimezone(timezone = process.env.TZ) {
  const now = new Date();

  return {
    timezone,
    offset: formatOffset(now),
    localTime: new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(now)
  };
}

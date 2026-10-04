import "dotenv/config";

export const DEFAULT_TIMEZONE = "Europe/Berlin";

// Diese Werte setzen Container-Umgebungen (u. a. Pterodactyl) von sich aus.
// Sie sagen nichts darüber, in welcher Zeitzone der Bot rechnen soll.
const CONTAINER_DEFAULT_TIMEZONES = new Set(["utc", "etc/utc", "gmt", "etc/gmt", "universal", "zulu", ":utc"]);

function isValidTimezone(name) {
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Legt die Zeitzone des Prozesses fest.
 *
 * Terminlogik (Meetings, Wochenberichte, Abmeldungen) und die Tagesbuckets der
 * Statistiken rechnen mit `setHours()` bzw. SQLite-`localtime` und richten sich
 * damit nach der Prozess-Zeitzone. Container laufen ohne gesetztes TZ auf UTC,
 * wodurch ein auf 16:00 gestelltes Meeting in Discord als 18:00 erscheint.
 *
 * Ein vom Container vorgegebenes `TZ=UTC` wird bewusst nicht übernommen:
 * Pterodactyl reicht es an jeden Server durch, und genau dadurch lief der Bot
 * trotz dieser Funktion weiter zwei Stunden nach. Wer wirklich UTC will,
 * setzt `BOT_TIMEZONE=UTC`.
 *
 * Ein zur Laufzeit gesetztes `process.env.TZ` wirkt in Node ab v16 sowohl auf
 * Date/Intl als auch auf die libc – und damit auf better-sqlite3.
 */
export function applyTimezone(rawTimezone = process.env.BOT_TIMEZONE, currentTz = process.env.TZ) {
  const requested = String(rawTimezone || "").trim();
  const inherited = String(currentTz || "").trim();
  const usableInherited = CONTAINER_DEFAULT_TIMEZONES.has(inherited.toLowerCase()) ? "" : inherited;

  let timezone = requested || usableInherited || DEFAULT_TIMEZONE;
  let source = requested ? "BOT_TIMEZONE" : (usableInherited ? "TZ" : "Standard");
  let warning = "";

  if (!isValidTimezone(timezone)) {
    warning = `Unbekannte Zeitzone "${timezone}", es wird ${DEFAULT_TIMEZONE} verwendet.`;
    timezone = DEFAULT_TIMEZONE;
    source = "Standard";
  }

  process.env.TZ = timezone;

  return {
    timezone,
    source,
    warning,
    containerTz: inherited,
    resolved: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
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

export const timezoneInfo = applyTimezone();

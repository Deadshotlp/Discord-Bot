import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { DEFAULT_TIMEZONE, applyTimezone, formatLocalTimestamp } from "../src/config/timezone.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Die Zeitzone wirkt prozessweit, deshalb laeuft die Terminberechnung in einem
// eigenen Node-Prozess mit der Umgebung eines Containers (TZ nicht gesetzt).
function runInChildProcess(env) {
  const script = `
    import { timezoneInfo } from "./src/config/timezone.js";
    const { getNextOccurrence } = await import("./src/modules/meeting/services/schedule.js");

    const config = { anchorDate: "2026-08-01", intervalWeeks: 2, weekday: 6, hour: 16, minute: 0 };
    const next = getNextOccurrence(new Date("2026-07-30T18:00:00Z"), config);

    console.log(JSON.stringify({
      timezone: timezoneInfo.timezone,
      source: timezoneInfo.source,
      warning: timezoneInfo.warning,
      resolved: Intl.DateTimeFormat().resolvedOptions().timeZone,
      berlin: new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short"
      }).format(next)
    }));
  `;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, TZ: undefined, BOT_TIMEZONE: undefined, ...env }
  });

  return JSON.parse(output.trim().split("\n").at(-1));
}

test("Ohne TZ faellt der Bot auf Europe/Berlin zurueck statt auf UTC", () => {
  const result = runInChildProcess({});

  assert.equal(result.timezone, DEFAULT_TIMEZONE);
  assert.equal(result.source, "Standard");
  assert.equal(result.resolved, DEFAULT_TIMEZONE);
});

test("Ein auf 16:00 gestelltes Meeting erscheint auch im UTC-Container als 16:00", () => {
  const result = runInChildProcess({});

  assert.match(result.berlin, /16:00/);
  assert.match(result.berlin, /01\.08\.26/);
});

test("BOT_TIMEZONE hat Vorrang vor einem gesetzten TZ", () => {
  const result = runInChildProcess({ TZ: "UTC", BOT_TIMEZONE: "Europe/Berlin" });

  assert.equal(result.timezone, "Europe/Berlin");
  assert.equal(result.source, "BOT_TIMEZONE");
  assert.match(result.berlin, /16:00/);
});

test("Ein gesetztes TZ wird uebernommen, wenn BOT_TIMEZONE fehlt", () => {
  const result = runInChildProcess({ TZ: "America/New_York" });

  assert.equal(result.timezone, "America/New_York");
  assert.equal(result.source, "TZ");
});

test("Ein vom Container vorgegebenes TZ=UTC wird ignoriert", () => {
  // Pterodactyl setzt TZ=UTC fuer jeden Server – das war der Grund, warum der
  // Bot trotz Zeitzonen-Fix zwei Stunden nachging.
  for (const containerTz of ["UTC", "Etc/UTC", "GMT"]) {
    const result = runInChildProcess({ TZ: containerTz });

    assert.equal(result.timezone, DEFAULT_TIMEZONE, containerTz);
    assert.equal(result.source, "Standard", containerTz);
    assert.match(result.berlin, /16:00/, containerTz);
  }
});

test("UTC bleibt moeglich, wenn es ausdruecklich gewuenscht ist", () => {
  const result = runInChildProcess({ TZ: "UTC", BOT_TIMEZONE: "UTC" });

  assert.equal(result.timezone, "UTC");
  assert.equal(result.source, "BOT_TIMEZONE");
});

test("Zeitstempel fuer Logs zeigen Ortszeit mit Versatz statt UTC", () => {
  applyTimezone("Europe/Berlin", "");

  assert.equal(formatLocalTimestamp(new Date("2026-07-15T12:30:05Z")), "2026-07-15 14:30:05 +02:00");
  assert.equal(formatLocalTimestamp(new Date("2026-01-15T12:30:05Z")), "2026-01-15 13:30:05 +01:00");
  assert.equal(formatLocalTimestamp("kein Datum"), "-");
});

test("Eine unbekannte Zeitzone faellt mit Warnung auf den Standard zurueck", () => {
  const result = applyTimezone("Nicht/Existent", "");

  assert.equal(result.timezone, DEFAULT_TIMEZONE);
  assert.match(result.warning, /Nicht\/Existent/);
});

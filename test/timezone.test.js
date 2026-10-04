import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TIMEZONE, applyTimezone, describeTimezone } from "../src/config/timezone.js";

const ORIGINAL = process.env.TZ;

test.after(() => {
  if (ORIGINAL === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL;
  }
});

test("ohne Angabe gilt Europe/Berlin", () => {
  const result = applyTimezone(undefined);

  assert.equal(result.timezone, DEFAULT_TIMEZONE);
  assert.equal(result.valid, true);
  assert.equal(process.env.TZ, DEFAULT_TIMEZONE);
});

test("leere Angaben zählen wie keine Angabe", () => {
  assert.equal(applyTimezone("").timezone, DEFAULT_TIMEZONE);
  assert.equal(applyTimezone("   ").timezone, DEFAULT_TIMEZONE);
});

test("eine gültige Zeitzone wird übernommen", () => {
  const result = applyTimezone("America/New_York");

  assert.equal(result.timezone, "America/New_York");
  assert.equal(result.valid, true);
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "America/New_York");
});

test("eine unbekannte Zeitzone fällt auf die Vorgabe zurück und meldet das", () => {
  const result = applyTimezone("Mittelerde/Auenland");

  assert.equal(result.valid, false);
  assert.equal(result.requested, "Mittelerde/Auenland");
  assert.equal(result.timezone, DEFAULT_TIMEZONE);
  assert.equal(process.env.TZ, DEFAULT_TIMEZONE);
});

test("Winter- und Sommerzeit werden unterschieden", () => {
  applyTimezone("Europe/Berlin");

  // 20:30 UTC entspricht 21:30 MEZ im Januar und 22:30 MESZ im Juli.
  assert.equal(new Date("2026-01-15T20:30:00Z").getHours(), 21, "MEZ (+1)");
  assert.equal(new Date("2026-07-15T20:30:00Z").getHours(), 22, "MESZ (+2)");
});

test("Tagesgrenzen verschieben sich mit der Zeitzone", () => {
  // 23:30 UTC am 5. Mai ist in Deutschland bereits der 6. Mai.
  applyTimezone("UTC");
  assert.equal(new Date("2026-05-05T23:30:00Z").getDate(), 5);

  applyTimezone("Europe/Berlin");
  assert.equal(new Date("2026-05-05T23:30:00Z").getDate(), 6);
});

test("die Beschreibung nennt Zone, Versatz und Ortszeit", () => {
  applyTimezone("Europe/Berlin");
  const beschreibung = describeTimezone();

  assert.equal(beschreibung.timezone, "Europe/Berlin");
  assert.match(beschreibung.offset, /^\+0[12]:00$/);
  assert.match(beschreibung.localTime, /\d{2}\.\d{2}\.\d{2},? \d{2}:\d{2}/);
});

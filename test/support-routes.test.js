import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "support-routes-test-"));
process.env.DATA_DIR = path.join(tempDir, "data");

const { Router } = await import("../src/web/http.js");
const { registerSupportRoutes } = await import("../src/web/routes/support.js");

const GUILD = "320000000000000001";
const TICKET_ID = "mabc123-9f2x";

const router = new Router();
registerSupportRoutes(router, { client: { botContext: {} } });

function match(method, pathname) {
  return router.match(method, pathname);
}

test("Ticket-Detailrouten werden nicht von der Listenroute verdeckt", () => {
  const list = match("GET", `/api/guilds/${GUILD}/tickets`);
  const detail = match("GET", `/api/guilds/${GUILD}/tickets/${TICKET_ID}`);
  const messages = match("GET", `/api/guilds/${GUILD}/tickets/${TICKET_ID}/messages`);

  assert.ok(list, "Listenroute vorhanden");
  assert.ok(detail, "Detailroute vorhanden");
  assert.ok(messages, "Verlaufsroute vorhanden");

  assert.equal(detail.params.ticketId, TICKET_ID);
  assert.equal(messages.params.ticketId, TICKET_ID);
  assert.notEqual(detail.handler, messages.handler);
});

test("Schreibende Ticket-Routen sind registriert", () => {
  for (const suffix of ["messages", "close", "escalate"]) {
    const route = match("POST", `/api/guilds/${GUILD}/tickets/${TICKET_ID}/${suffix}`);
    assert.ok(route, `POST .../${suffix} vorhanden`);
    assert.equal(route.params.guildId, GUILD);
    assert.equal(route.params.ticketId, TICKET_ID);
  }
});

test("Ticket-Routen greifen nicht bei anderen Pfaden", () => {
  assert.equal(match("POST", `/api/guilds/${GUILD}/tickets`), null);
  assert.equal(match("DELETE", `/api/guilds/${GUILD}/tickets/${TICKET_ID}`), null);
});

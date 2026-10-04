import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monitoring-alerts-test-"));
process.env.DATA_DIR = path.join(tempDir, "data");

const { createServer, getServer } = await import("../src/modules/monitoring/services/servers.js");
const { announceStateChange } = await import("../src/modules/monitoring/services/poller.js");

const GUILD = "310000000000000001";
const CHANNEL_ID = "310000000000000002";

// Alarm-Channel, der sich merkt, welche Nachrichten gesendet und gelöscht wurden.
function createFakeChannel() {
  const messages = new Map();
  let nextId = 0;

  return {
    id: CHANNEL_ID,
    type: ChannelType.GuildText,
    sent: [],
    deleted: [],
    messages: {
      fetch: async (messageId) => messages.get(messageId) || Promise.reject(new Error("Unknown Message"))
    },
    send: async (payload) => {
      const id = `9${String(nextId += 1).padStart(18, "0")}`;
      const message = {
        id,
        payload,
        delete: async () => {
          messages.delete(id);
          return message;
        }
      };

      messages.set(id, message);
      return message;
    }
  };
}

function createFakeClient(channel) {
  const guild = {
    id: GUILD,
    channels: {
      cache: new Map([[channel.id, channel]]),
      fetch: async (channelId) => (channelId === channel.id ? channel : null)
    },
    members: { me: null, fetchMe: async () => null }
  };

  return { guilds: { cache: new Map([[GUILD, guild]]) } };
}

const config = {
  statusChannelId: CHANNEL_ID,
  alertChannelId: CHANNEL_ID,
  alertRoleId: "",
  alertOnStateChange: true
};

test("Statuswechsel ersetzt die vorherige Meldung statt sie zu stapeln", async () => {
  const channel = createFakeChannel();
  const client = createFakeClient(channel);

  const server = createServer(GUILD, { name: "TR Server", host: "127.0.0.1", port: 27015 });

  await announceStateChange(client, getServer(server.id), false, config);
  const afterOffline = getServer(server.id);
  assert.ok(afterOffline.meta.alertMessageId, "Nachricht-ID wird am Server hinterlegt");
  assert.equal(afterOffline.meta.alertChannelId, CHANNEL_ID);

  const firstMessageId = afterOffline.meta.alertMessageId;

  await announceStateChange(client, afterOffline, true, config);
  const afterOnline = getServer(server.id);

  // Die alte Nachricht ist weg, nur die neue steht noch im Channel.
  await assert.rejects(() => channel.messages.fetch(firstMessageId));
  assert.notEqual(afterOnline.meta.alertMessageId, firstMessageId);
  assert.ok(await channel.messages.fetch(afterOnline.meta.alertMessageId));
});

test("Fehlende Vorgängernachricht bricht die Benachrichtigung nicht ab", async () => {
  const channel = createFakeChannel();
  const client = createFakeClient(channel);

  const server = createServer(GUILD, { name: "Zweiter Server", host: "127.0.0.2", port: 27015 });

  await announceStateChange(client, {
    ...getServer(server.id),
    meta: { alertMessageId: "999999999999999999", alertChannelId: CHANNEL_ID }
  }, false, config);

  const updated = getServer(server.id);
  assert.ok(updated.meta.alertMessageId);
  assert.ok(await channel.messages.fetch(updated.meta.alertMessageId));
});

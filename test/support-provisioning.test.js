import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "support-provisioning-test-"));
process.env.DATA_DIR = path.join(tempDir, "data");

const { ensureSupportDefaults } = await import("../src/modules/support/services/provisioning.js");

const GUILD_ID = "410000000000000001";

const env = {
  supportWaitingChannelName: "support-warteraum",
  supportManagementChannelName: "support-verwaltung",
  supportTalkCategoryName: "Support Talk",
  supportTicketCategoryName: "Support Tickets",
  supportTalkChannelPrefix: "support-talk",
  supportTalkChannelCount: 3,
  supportDefaultDepartmentName: "Support",
  supportDefaultDepartmentRoleIdsRaw: ""
};

// Minimaler Guild-Ersatz: zählt jede Kanalerstellung mit, damit der Test
// wirklich prüft, ob beim zweiten Lauf noch etwas angelegt wird.
function createFakeGuild() {
  const channels = new Map();
  let nextId = 1;

  const guild = {
    id: GUILD_ID,
    createdChannels: [],
    members: { me: null, fetchMe: async () => null },
    channels: {
      cache: channels,
      fetch: async (channelId) => channels.get(channelId) || null,
      create: async ({ name, type, parent = null }) => {
        const id = `9${String(nextId += 1).padStart(18, "0")}`;
        const channel = { id, name, type, parentId: parent };
        channels.set(id, channel);
        guild.createdChannels.push(channel);
        return channel;
      }
    }
  };

  return guild;
}

function createContext(initialConfig = {}) {
  const state = { enabled: true, config: { ...initialConfig } };

  return {
    botContext: {
      env,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      settingsStore: {
        getModuleState: () => ({ enabled: state.enabled, config: { ...state.config } }),
        setModuleConfig: (_guildId, _moduleName, fields) => {
          state.config = { ...state.config, ...fields };
          return state;
        }
      }
    },
    state
  };
}

test("Erster Lauf legt Warteraum, Kategorien und Talk-Channels an", async () => {
  const client = createContext();
  const guild = createFakeGuild();

  await ensureSupportDefaults(client, guild);

  const talkChannels = guild.createdChannels.filter((channel) => channel.name.startsWith("support-talk-"));
  assert.equal(talkChannels.length, 3);
  assert.equal(client.state.config.talkChannelIds.length, 3);
  assert.ok(client.state.config.waitingChannelId);
  assert.ok(client.state.config.talkCategoryId);
});

test("Zweiter Lauf erstellt nichts erneut", async () => {
  const client = createContext();
  const guild = createFakeGuild();

  await ensureSupportDefaults(client, guild);
  const afterFirstRun = guild.createdChannels.length;

  await ensureSupportDefaults(client, guild);

  assert.equal(guild.createdChannels.length, afterFirstRun);
});

test("Verlorene Kanal-IDs werden am Namen wiedererkannt statt neu angelegt", async () => {
  const client = createContext();
  const guild = createFakeGuild();

  await ensureSupportDefaults(client, guild);
  const afterFirstRun = guild.createdChannels.length;
  const previousTalkIds = [...client.state.config.talkChannelIds];

  // Simuliert einen Konfigurationsverlust: die Kanäle existieren weiter,
  // aber der Bot kennt ihre IDs nicht mehr.
  client.state.config = { departments: client.state.config.departments };

  await ensureSupportDefaults(client, guild);

  assert.equal(guild.createdChannels.length, afterFirstRun);
  assert.deepEqual([...client.state.config.talkChannelIds].sort(), [...previousTalkIds].sort());
});

test("Fehlende Talk-Channels werden auf die Zielanzahl aufgefüllt", async () => {
  const client = createContext();
  const guild = createFakeGuild();

  await ensureSupportDefaults(client, guild);

  // Ein Talk-Channel wird in Discord gelöscht.
  const removedId = client.state.config.talkChannelIds[1];
  guild.channels.cache.delete(removedId);

  await ensureSupportDefaults(client, guild);

  const remaining = client.state.config.talkChannelIds;
  assert.equal(remaining.length, 3);
  assert.ok(!remaining.includes(removedId));
  assert.ok(remaining.every((channelId) => guild.channels.cache.has(channelId)));
});

test("Talk-Channels werden nur innerhalb der Talk-Kategorie übernommen", async () => {
  const client = createContext();
  const guild = createFakeGuild();

  // Gleichnamiger Kanal außerhalb der Kategorie darf nicht mitgezählt werden.
  await guild.channels.create({ name: "support-talk-1", type: ChannelType.GuildVoice, parent: null });
  guild.createdChannels.length = 0;

  await ensureSupportDefaults(client, guild);

  assert.equal(client.state.config.talkChannelIds.length, 3);
  const categoryId = client.state.config.talkCategoryId;
  assert.ok(client.state.config.talkChannelIds.every((channelId) =>
    guild.channels.cache.get(channelId).parentId === categoryId));
});

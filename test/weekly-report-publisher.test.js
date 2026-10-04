import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReminderMessage, buildWeeklyReportMessages } from "../src/modules/weeklyReport/services/publisher.js";
import { normalizeWeeklyReportConfig, resolveReminderChannelId } from "../src/modules/weeklyReport/services/config.js";

function makeDepartments(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `dept-${index + 1}`,
    name: `Department ${index + 1}`,
    roleIds: [],
    leadRoleIds: []
  }));
}

test("buildWeeklyReportMessages puts the header on the first message", () => {
  const messages = buildWeeklyReportMessages("2026-W27", makeDepartments(2), []);

  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /Wochenbericht KW 27 \/ 2026/);
  assert.equal(messages[0].embeds.length, 2);
});

test("buildWeeklyReportMessages marks departments without submission", () => {
  const departments = makeDepartments(2);
  const reports = [{
    departmentId: "dept-1",
    authorId: "user1",
    content: "Bericht Inhalt"
  }];

  const messages = buildWeeklyReportMessages("2026-W27", departments, reports);
  const [submitted, missing] = messages[0].embeds.map((embed) => embed.toJSON());

  assert.match(submitted.description, /Bericht Inhalt/);
  assert.match(submitted.description, /<@user1>/);
  assert.match(missing.description, /Keine Abgabe/);
});

test("buildWeeklyReportMessages splits after 10 embeds", () => {
  const messages = buildWeeklyReportMessages("2026-W27", makeDepartments(12), []);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].embeds.length, 10);
  assert.equal(messages[1].embeds.length, 2);
  assert.ok(messages[0].content);
  assert.equal(messages[1].content, undefined);
});

test("buildWeeklyReportMessages splits when the embed character budget is exceeded", () => {
  const departments = makeDepartments(2);
  const longContent = "x".repeat(3900);
  const reports = departments.map((department) => ({
    departmentId: department.id,
    authorId: "user1",
    content: longContent
  }));

  const messages = buildWeeklyReportMessages("2026-W27", departments, reports);
  assert.equal(messages.length, 2);
});

test("resolveReminderChannelId prefers the dedicated reminder channel", () => {
  const config = normalizeWeeklyReportConfig({
    publishChannelId: "111111111111111111",
    reminderChannelId: "222222222222222222"
  });

  assert.equal(resolveReminderChannelId(config), "222222222222222222");
});

test("resolveReminderChannelId falls back to the publish channel", () => {
  const config = normalizeWeeklyReportConfig({ publishChannelId: "111111111111111111" });

  assert.equal(config.reminderChannelId, "");
  assert.equal(resolveReminderChannelId(config), "111111111111111111");
});

test("buildReminderMessage pings lead roles of missing departments only", () => {
  const missing = [
    { id: "d1", name: "Technik", leadRoleIds: ["111111111111111111"] },
    { id: "d2", name: "Events", leadRoleIds: [] }
  ];

  const message = buildReminderMessage("2026-W27", missing, new Date(2026, 6, 5, 18, 0));

  assert.match(message.content, /Technik: <@&111111111111111111>/);
  assert.match(message.content, /- Events/);
  assert.deepEqual(message.allowedMentions.roles, ["111111111111111111"]);
});

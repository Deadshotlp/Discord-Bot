import { WEEKDAY_NAMES } from "./week.js";

function safeString(value) {
  return String(value || "").trim();
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}

export function normalizeWeeklyReportConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};

  return {
    publishChannelId: safeString(config.publishChannelId),
    // Leer = Erinnerung landet im Veröffentlichungs-Channel.
    reminderChannelId: safeString(config.reminderChannelId),
    publishWeekday: clampInteger(config.publishWeekday, 1, 7, 7),
    publishHour: clampInteger(config.publishHour, 0, 23, 18),
    publishMinute: clampInteger(config.publishMinute, 0, 59, 0),
    reminderHoursBefore: clampInteger(config.reminderHoursBefore, 0, 168, 24),
    lastPublishedWeek: safeString(config.lastPublishedWeek),
    lastReminderWeek: safeString(config.lastReminderWeek)
  };
}

// Akzeptiert 1-7 oder deutsche Wochentagsnamen (auch abgekürzt, z. B. "So").
export function parseWeekdayInput(value) {
  const text = safeString(value).toLowerCase();
  if (!text) {
    return null;
  }

  const asNumber = Number.parseInt(text, 10);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= 7) {
    return asNumber;
  }

  const index = WEEKDAY_NAMES.findIndex((name) => name.toLowerCase().startsWith(text.slice(0, 2)));
  return index >= 0 ? index + 1 : null;
}

// Akzeptiert "18", "18:30" oder "18.30".
export function parseTimeInput(value) {
  const text = safeString(value);
  if (!text) {
    return null;
  }

  const match = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(text);
  if (!match) {
    return null;
  }

  const hour = Number.parseInt(match[1], 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

export function resolveReminderChannelId(config) {
  return safeString(config?.reminderChannelId) || safeString(config?.publishChannelId);
}

export function formatPublishSchedule(config) {
  const weekdayName = WEEKDAY_NAMES[config.publishWeekday - 1] || "?";
  const time = `${String(config.publishHour).padStart(2, "0")}:${String(config.publishMinute).padStart(2, "0")}`;
  return `${weekdayName}, ${time} Uhr`;
}

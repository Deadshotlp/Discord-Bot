import { formatLocalTimestamp } from "../config/timezone.js";

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function normalizeLevel(level) {
  const lower = String(level || "info").toLowerCase();
  return LEVELS[lower] ? lower : "info";
}

function formatMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) {
    return "";
  }

  return ` ${JSON.stringify(meta)}`;
}

export function createLogger(level = "info") {
  const minLevel = normalizeLevel(level);

  function canLog(targetLevel) {
    return LEVELS[targetLevel] >= LEVELS[minLevel];
  }

  function log(targetLevel, message, meta = undefined) {
    if (!canLog(targetLevel)) {
      return;
    }

    const line = `[${formatLocalTimestamp()}] [${targetLevel.toUpperCase()}] ${message}${formatMeta(meta)}`;

    if (targetLevel === "error") {
      console.error(line);
      return;
    }

    if (targetLevel === "warn") {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  return {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta)
  };
}

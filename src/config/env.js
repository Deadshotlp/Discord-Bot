import "dotenv/config";
import { parseSnowflakeList } from "../core/discordUtil.js";

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return parsed;
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Umgebungsvariable fehlt: ${name}`);
  }

  return value;
}

const webPort = parseInteger(process.env.WEB_PORT, 8080);
const webBaseUrl = String(process.env.WEB_BASE_URL || `http://localhost:${webPort}`).replace(/\/+$/, "");

export const env = {
  discordToken: getRequiredEnv("DISCORD_TOKEN"),
  logLevel: process.env.LOG_LEVEL || "info",

  // Privilegiertes Intent, nötig zum Auflisten aller Servermitglieder (Teamliste).
  // Muss zusätzlich im Discord Developer Portal freigeschaltet sein – sonst
  // verweigert Discord die Anmeldung mit "Used disallowed intents".
  guildMembersIntent: parseBoolean(process.env.GUILD_MEMBERS_INTENT, false),

  // Web-Dashboard
  webEnabled: parseBoolean(process.env.WEB_ENABLED, true),
  webPort,
  webHost: process.env.WEB_HOST || "0.0.0.0",
  webBaseUrl,
  discordClientId: process.env.DISCORD_CLIENT_ID || "",
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || "",

  // Content-Creator-Benachrichtigungen
  youtubeApiKey: process.env.YOUTUBE_API_KEY || "",
  twitchClientId: process.env.TWITCH_CLIENT_ID || "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET || "",
  creatorPollIntervalSeconds: parseInteger(process.env.CREATOR_POLL_INTERVAL_SECONDS, 180),

  // Sprach-Transkripte
  whisperBinaryPath: process.env.WHISPER_BINARY_PATH || "",
  whisperModelPath: process.env.WHISPER_MODEL_PATH || "",
  whisperLibDir: process.env.WHISPER_LIB_DIR || "",
  whisperThreads: parseInteger(process.env.WHISPER_THREADS, 2),
  whisperLanguage: process.env.WHISPER_LANGUAGE || "de",

  // Support-Grundeinstellungen (nur als Startwerte beim ersten Setup)
  supportWaitingChannelName: process.env.SUPPORT_WAITING_CHANNEL_NAME || "support-warteraum",
  supportManagementChannelName: process.env.SUPPORT_MANAGEMENT_CHANNEL_NAME || "support-verwaltung",
  supportTalkCategoryName: process.env.SUPPORT_TALK_CATEGORY_NAME || "Support Talk",
  supportTicketCategoryName: process.env.SUPPORT_TICKET_CATEGORY_NAME || "Support Tickets",
  supportTalkChannelPrefix: process.env.SUPPORT_TALK_CHANNEL_PREFIX || "support-talk",
  supportTalkChannelCount: parseInteger(process.env.SUPPORT_TALK_CHANNEL_COUNT, 3),
  supportDefaultDepartmentName: process.env.SUPPORT_DEFAULT_DEPARTMENT_NAME || "Support",
  supportDefaultDepartmentRoleIdsRaw: process.env.SUPPORT_DEFAULT_DEPARTMENT_ROLE_IDS || "",
  supportDefaultDepartmentRoleIds: parseSnowflakeList(process.env.SUPPORT_DEFAULT_DEPARTMENT_ROLE_IDS || ""),

  verifyDefaultRoleName: process.env.VERIFY_DEFAULT_ROLE_NAME || "Verifiziert",
  verifyDefaultChannelName: process.env.VERIFY_DEFAULT_CHANNEL_NAME || "verify",

  githubToken: process.env.GITHUB_TOKEN || "",
  updatesPollIntervalMinutes: parseInteger(process.env.UPDATES_POLL_INTERVAL_MINUTES, 15)
};

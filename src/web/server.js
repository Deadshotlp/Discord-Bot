import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACCESS_LEVELS, SESSION_COOKIE, getSession, resolveGuildAccess } from "./auth.js";
import {
  HttpError,
  Router,
  createStaticHandler,
  parseCookies,
  readJsonBody,
  sendJson,
  sendText
} from "./http.js";
import { registerAbsenceRoutes } from "./routes/absences.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCreatorRoutes } from "./routes/creators.js";
import { registerGuildRoutes } from "./routes/guild.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerMeetingRoutes } from "./routes/meetings.js";
import { registerMonitoringRoutes } from "./routes/monitoring.js";
import { registerSteamRoutes } from "./routes/steam.js";
import { registerSupportRoutes } from "./routes/support.js";
import { registerTeamListRoutes } from "./routes/teamList.js";
import { registerUpdatesRoutes } from "./routes/updates.js";

const publicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "web",
  "public"
);

const GUILD_ROUTE_PATTERN = /^\/api\/guilds\/(\d{16,20})(\/|$)/;
const PUBLIC_API_PREFIXES = ["/api/auth/", "/api/ingest/", "/api/health", "/api/server-kinds", "/api/absence-kinds"];

function isPublicApi(pathname) {
  return PUBLIC_API_PREFIXES.some((prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix));
}

export function createWebServer(client) {
  const { env, logger } = client.botContext;
  const router = new Router();
  const serveStatic = createStaticHandler(publicDir);

  router.get("/api/health", (ctx) => {
    sendJson(ctx.res, 200, {
      ok: true,
      bot: client.user?.tag || null,
      guilds: client.guilds.cache.size,
      uptimeSeconds: Math.round(process.uptime())
    });
  });

  registerAuthRoutes(router, { client, env });
  registerIngestRoutes(router, { client });
  registerGuildRoutes(router, { client });
  registerMonitoringRoutes(router, { client });
  registerSupportRoutes(router, { client });
  registerTeamListRoutes(router, { client });
  registerAbsenceRoutes(router, { client });
  registerMeetingRoutes(router, { client });
  registerSteamRoutes(router, { client });
  registerCreatorRoutes(router, { client });
  registerUpdatesRoutes(router, { client });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, env.webBaseUrl);
    const pathname = url.pathname;

    try {
      if (!pathname.startsWith("/api/")) {
        if (!serveStatic(req, res, pathname)) {
          sendText(res, 404, "Not Found");
        }

        return;
      }

      const match = router.match(req.method, pathname);
      if (!match) {
        throw new HttpError(404, "Endpunkt nicht gefunden");
      }

      const cookies = parseCookies(req);
      const session = getSession(cookies[SESSION_COOKIE]);
      const body = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method)
        ? await readJsonBody(req)
        : {};

      // Einfacher CSRF-Schutz: schreibende Aufrufe müssen aus dem Dashboard kommen.
      // Das Ingest-Addon authentifiziert sich stattdessen per Token.
      if (req.method !== "GET" && !pathname.startsWith("/api/ingest/")) {
        if (req.headers["x-requested-with"] !== "dashboard") {
          throw new HttpError(403, "Ungültige Anfrage-Herkunft");
        }
      }

      const ctx = {
        client,
        req,
        res,
        url,
        cookies,
        session,
        body,
        params: match.params,
        access: null
      };

      if (!isPublicApi(pathname)) {
        if (!session) {
          throw new HttpError(401, "Nicht angemeldet");
        }

        const guildMatch = GUILD_ROUTE_PATTERN.exec(pathname);
        if (guildMatch) {
          ctx.access = await resolveGuildAccess(client, guildMatch[1], session.discordId);
          if (ctx.access.level < ACCESS_LEVELS.member) {
            throw new HttpError(403, "Kein Zugriff auf diesen Server");
          }
        }
      }

      await match.handler(ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message, detail: error.detail });
        return;
      }

      logger.warn("Web-Request fehlgeschlagen", {
        method: req.method,
        path: pathname,
        error: String(error?.stack || error)
      });

      if (!res.headersSent) {
        sendJson(res, 500, { error: "Interner Fehler" });
      }
    }
  });

  return server;
}

export function startWebServer(client) {
  const { env, logger } = client.botContext;

  if (!env.webEnabled) {
    logger.info("Web-Dashboard ist deaktiviert (WEB_ENABLED=false)");
    return null;
  }

  if (!env.discordClientId || !env.discordClientSecret) {
    logger.warn("Web-Dashboard startet nicht: DISCORD_CLIENT_ID/DISCORD_CLIENT_SECRET fehlen");
    return null;
  }

  const server = createWebServer(client);

  server.listen(env.webPort, env.webHost, () => {
    logger.info("Web-Dashboard läuft", {
      url: env.webBaseUrl,
      port: env.webPort
    });
  });

  server.on("error", (error) => {
    logger.error("Web-Dashboard-Fehler", { error: String(error) });
  });

  return server;
}

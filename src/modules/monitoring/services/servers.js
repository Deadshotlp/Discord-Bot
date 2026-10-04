import { db } from "../../../core/db.js";
import { createId } from "../../../core/ids.js";
import { SERVER_KINDS } from "./protocols/index.js";

const HOST_PATTERN = /^[a-z0-9._-]+$/i;

const MIN_INTERVAL_SECONDS = 15;
const MAX_INTERVAL_SECONDS = 3600;

function safeString(value) {
  return String(value ?? "").trim();
}

export function normalizeHost(value) {
  const text = safeString(value)
    .replace(/^[a-z]+:\/\//i, "")
    .split("/")[0]
    .split(":")[0];

  return HOST_PATTERN.test(text) ? text : "";
}

export function normalizePort(value, fallback = 27015) {
  const parsed = Number.parseInt(safeString(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }

  return parsed;
}

export function normalizeInterval(value, fallback = 30) {
  const parsed = Number.parseInt(safeString(value), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, parsed));
}

const selectByGuildStmt = db.prepare(`
  SELECT * FROM monitor_servers
  WHERE guild_id = ?
  ORDER BY sort_order ASC, created_at ASC
`);

const selectEnabledStmt = db.prepare(`
  SELECT * FROM monitor_servers
  WHERE enabled = 1
  ORDER BY guild_id ASC, sort_order ASC
`);

const selectByIdStmt = db.prepare("SELECT * FROM monitor_servers WHERE id = ?");

const insertStmt = db.prepare(`
  INSERT INTO monitor_servers (
    id, guild_id, name, kind, host, port, query_port, enabled, interval_seconds,
    connect_url, color, sort_order, created_at, created_by, meta_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateStmt = db.prepare(`
  UPDATE monitor_servers SET
    name = ?, kind = ?, host = ?, port = ?, query_port = ?, enabled = ?,
    interval_seconds = ?, connect_url = ?, color = ?, sort_order = ?, meta_json = ?
  WHERE id = ?
`);

const deleteStmt = db.prepare("DELETE FROM monitor_servers WHERE id = ?");
const maxOrderStmt = db.prepare(
  "SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM monitor_servers WHERE guild_id = ?"
);

function toServer(row) {
  if (!row) {
    return null;
  }

  let meta;
  try {
    meta = JSON.parse(row.meta_json || "{}");
  } catch {
    meta = {};
  }

  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    kind: row.kind,
    host: row.host,
    port: Number(row.port),
    queryPort: row.query_port ? Number(row.query_port) : Number(row.port),
    enabled: Boolean(row.enabled),
    intervalSeconds: Number(row.interval_seconds),
    connectUrl: row.connect_url || "",
    color: row.color || "#5865f2",
    sortOrder: Number(row.sort_order || 0),
    createdAt: Number(row.created_at || 0),
    createdBy: row.created_by || "",
    meta
  };
}

export function listServers(guildId) {
  return selectByGuildStmt.all(String(guildId)).map(toServer);
}

export function listAllEnabledServers() {
  return selectEnabledStmt.all().map(toServer);
}

export function getServer(serverId) {
  return toServer(selectByIdStmt.get(String(serverId)));
}

export function createServer(guildId, input, createdBy = "") {
  const kind = SERVER_KINDS[input?.kind] ? input.kind : "source";
  const host = normalizeHost(input?.host);
  if (!host) {
    throw new Error("Ungültiger Host");
  }

  const port = normalizePort(input?.port, SERVER_KINDS[kind].defaultPort);
  const id = createId("srv");
  const sortOrder = Number(maxOrderStmt.get(String(guildId))?.maxOrder || 0) + 1;

  insertStmt.run(
    id,
    String(guildId),
    safeString(input?.name).slice(0, 80) || host,
    kind,
    host,
    port,
    normalizePort(input?.queryPort, port),
    input?.enabled === false ? 0 : 1,
    normalizeInterval(input?.intervalSeconds, 30),
    safeString(input?.connectUrl).slice(0, 300),
    safeString(input?.color) || "#5865f2",
    sortOrder,
    Date.now(),
    String(createdBy || ""),
    JSON.stringify(input?.meta || {})
  );

  return getServer(id);
}

export function updateServer(serverId, input) {
  const existing = getServer(serverId);
  if (!existing) {
    return null;
  }

  const kind = SERVER_KINDS[input?.kind] ? input.kind : existing.kind;
  const host = input?.host === undefined ? existing.host : normalizeHost(input.host);
  if (!host) {
    throw new Error("Ungültiger Host");
  }

  const port = input?.port === undefined ? existing.port : normalizePort(input.port, existing.port);

  updateStmt.run(
    input?.name === undefined ? existing.name : safeString(input.name).slice(0, 80) || existing.name,
    kind,
    host,
    port,
    input?.queryPort === undefined ? existing.queryPort : normalizePort(input.queryPort, port),
    input?.enabled === undefined ? (existing.enabled ? 1 : 0) : (input.enabled ? 1 : 0),
    input?.intervalSeconds === undefined
      ? existing.intervalSeconds
      : normalizeInterval(input.intervalSeconds, existing.intervalSeconds),
    input?.connectUrl === undefined ? existing.connectUrl : safeString(input.connectUrl).slice(0, 300),
    input?.color === undefined ? existing.color : safeString(input.color) || existing.color,
    input?.sortOrder === undefined ? existing.sortOrder : Number(input.sortOrder) || existing.sortOrder,
    JSON.stringify(input?.meta === undefined ? existing.meta : input.meta || {}),
    existing.id
  );

  return getServer(existing.id);
}

const updateMetaStmt = db.prepare("UPDATE monitor_servers SET meta_json = ? WHERE id = ?");

/**
 * Schreibt nur das Meta-Feld, ohne die restlichen Spalten anzufassen.
 * Wird vom Poller für flüchtigen Zustand genutzt (z. B. die ID der zuletzt
 * gesendeten Status-Benachrichtigung).
 */
export function patchServerMeta(serverId, patch) {
  const existing = getServer(serverId);
  if (!existing) {
    return null;
  }

  const meta = { ...existing.meta, ...patch };
  updateMetaStmt.run(JSON.stringify(meta), existing.id);
  return meta;
}

export function deleteServer(serverId) {
  const existing = getServer(serverId);
  if (!existing) {
    return false;
  }

  const remove = db.transaction(() => {
    db.prepare("DELETE FROM monitor_samples WHERE server_id = ?").run(existing.id);
    db.prepare("DELETE FROM monitor_rollups WHERE server_id = ?").run(existing.id);
    db.prepare("DELETE FROM monitor_player_samples WHERE server_id = ?").run(existing.id);
    db.prepare("DELETE FROM play_sessions WHERE server_id = ?").run(existing.id);
    db.prepare("DELETE FROM ingest_tokens WHERE server_id = ?").run(existing.id);
    deleteStmt.run(existing.id);
  });

  remove();
  return true;
}

export { MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS };

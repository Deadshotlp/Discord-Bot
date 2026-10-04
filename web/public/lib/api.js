// Schmaler Fetch-Wrapper. Der Header x-requested-with dient als CSRF-Schutz;
// der Server lehnt schreibende Aufrufe ohne ihn ab.
async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-requested-with": "dashboard"
    },
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (response.status === 204) {
    return null;
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(payload?.error || `Fehler ${response.status}`);
    error.status = response.status;
    error.detail = payload?.detail;
    throw error;
  }

  return payload;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body ?? {}),
  patch: (path, body) => request("PATCH", path, body ?? {}),
  del: (path) => request("DELETE", path, {}),

  me: () => request("GET", "/api/auth/me"),
  logout: () => request("POST", "/api/auth/logout", {}),

  guild: (guildId) => request("GET", `/api/guilds/${guildId}`),
  modules: (guildId) => request("GET", `/api/guilds/${guildId}/modules`),
  updateModule: (guildId, moduleName, patch) =>
    request("PATCH", `/api/guilds/${guildId}/modules/${moduleName}`, patch),

  servers: (guildId) => request("GET", `/api/guilds/${guildId}/servers`),
  serverKinds: () => request("GET", "/api/server-kinds"),
  createServer: (guildId, data) => request("POST", `/api/guilds/${guildId}/servers`, data),
  updateServer: (guildId, serverId, data) =>
    request("PATCH", `/api/guilds/${guildId}/servers/${serverId}`, data),
  deleteServer: (guildId, serverId) => request("DELETE", `/api/guilds/${guildId}/servers/${serverId}`, {}),
  series: (guildId, serverId, range) =>
    request("GET", `/api/guilds/${guildId}/servers/${serverId}/series?range=${range}`),
  probe: (guildId, serverId) => request("POST", `/api/guilds/${guildId}/servers/${serverId}/probe`, {}),
  testServer: (guildId, data) => request("POST", `/api/guilds/${guildId}/servers/test`, data),
  serverPlayers: (guildId, serverId, range) =>
    request("GET", `/api/guilds/${guildId}/servers/${serverId}/players?range=${range}`),
  createIngestToken: (guildId, serverId, label) =>
    request("POST", `/api/guilds/${guildId}/servers/${serverId}/tokens`, { label }),
  listIngestTokens: (guildId, serverId) =>
    request("GET", `/api/guilds/${guildId}/servers/${serverId}/tokens`),

  tickets: (guildId, query = "") => request("GET", `/api/guilds/${guildId}/tickets${query}`),
  ticketMessages: (guildId, ticketId) =>
    request("GET", `/api/guilds/${guildId}/tickets/${ticketId}/messages`),
  sendTicketMessage: (guildId, ticketId, content) =>
    request("POST", `/api/guilds/${guildId}/tickets/${ticketId}/messages`, { content }),
  closeTicket: (guildId, ticketId) =>
    request("POST", `/api/guilds/${guildId}/tickets/${ticketId}/close`, {}),
  escalateTicket: (guildId, ticketId, departmentId) =>
    request("POST", `/api/guilds/${guildId}/tickets/${ticketId}/escalate`, { departmentId }),
  cases: (guildId) => request("GET", `/api/guilds/${guildId}/cases`),
  supportStats: (guildId, days) => request("GET", `/api/guilds/${guildId}/stats/support?days=${days}`),
  teamStats: (guildId, days) => request("GET", `/api/guilds/${guildId}/stats/team?days=${days}`),
  teamRoster: (guildId, { refresh = false } = {}) =>
    request("GET", `/api/guilds/${guildId}/team/roster${refresh ? "?refresh=1" : ""}`),

  absences: (guildId) => request("GET", `/api/guilds/${guildId}/absences`),
  absenceKinds: () => request("GET", "/api/absence-kinds"),
  createAbsence: (guildId, data) => request("POST", `/api/guilds/${guildId}/absences`, data),
  updateAbsence: (guildId, id, data) => request("PATCH", `/api/guilds/${guildId}/absences/${id}`, data),
  deleteAbsence: (guildId, id) => request("DELETE", `/api/guilds/${guildId}/absences/${id}`, {}),

  meetings: (guildId) => request("GET", `/api/guilds/${guildId}/meetings`),
  createMeeting: (guildId, data) => request("POST", `/api/guilds/${guildId}/meetings`, data),
  updateMeeting: (guildId, id, data) => request("PATCH", `/api/guilds/${guildId}/meetings/${id}`, data),
  deleteMeeting: (guildId, id) => request("DELETE", `/api/guilds/${guildId}/meetings/${id}`, {}),
  addTopic: (guildId, meetingId, data) =>
    request("POST", `/api/guilds/${guildId}/meetings/${meetingId}/topics`, data),
  updateTopic: (guildId, meetingId, topicId, data) =>
    request("PATCH", `/api/guilds/${guildId}/meetings/${meetingId}/topics/${topicId}`, data),
  deleteTopic: (guildId, meetingId, topicId) =>
    request("DELETE", `/api/guilds/${guildId}/meetings/${meetingId}/topics/${topicId}`, {}),

  departments: (guildId) => request("GET", `/api/guilds/${guildId}/departments`),
  createDepartment: (guildId, data) => request("POST", `/api/guilds/${guildId}/departments`, data),
  updateDepartment: (guildId, id, data) => request("PATCH", `/api/guilds/${guildId}/departments/${id}`, data),
  deleteDepartment: (guildId, id) => request("DELETE", `/api/guilds/${guildId}/departments/${id}`, {}),
  reorderDepartments: (guildId, ids) => request("POST", `/api/guilds/${guildId}/departments/order`, { ids }),

  steamMe: (guildId) => request("GET", `/api/guilds/${guildId}/steam/me`),
  steamUnlinkMe: (guildId) => request("DELETE", `/api/guilds/${guildId}/steam/me`, {}),
  steamLinks: (guildId) => request("GET", `/api/guilds/${guildId}/steam/links`),
  steamUnlink: (guildId, discordId) => request("DELETE", `/api/guilds/${guildId}/steam/links/${discordId}`, {}),

  updateRepos: (guildId) => request("GET", `/api/guilds/${guildId}/updates/repos`),
  addUpdateRepo: (guildId, data) => request("POST", `/api/guilds/${guildId}/updates/repos`, data),
  removeUpdateRepo: (guildId, slug) => request("DELETE", `/api/guilds/${guildId}/updates/repos/${slug}`, {}),
  forkCandidates: (guildId, slug) => request("GET", `/api/guilds/${guildId}/updates/repos/${slug}/fork-candidates`),
  setUpdateRepoBranch: (guildId, slug, branch) =>
    request("PATCH", `/api/guilds/${guildId}/updates/repos/${slug}`, { branch }),
  githubBranches: (guildId, repo) =>
    request("GET", `/api/guilds/${guildId}/updates/branches?repo=${encodeURIComponent(repo)}`),
  updateBranches: (guildId, slug, fork = "") =>
    request("GET", `/api/guilds/${guildId}/updates/repos/${slug}/branches?fork=${encodeURIComponent(fork)}`),
  addUpdateFork: (guildId, slug, data) => request("POST", `/api/guilds/${guildId}/updates/repos/${slug}/forks`, data),
  removeUpdateFork: (guildId, slug, fork) =>
    request("DELETE", `/api/guilds/${guildId}/updates/repos/${slug}/forks/${encodeURIComponent(fork)}`, {}),

  audit: (guildId) => request("GET", `/api/guilds/${guildId}/audit`)
};

export const ACCESS = { NONE: 0, MEMBER: 1, STAFF: 2, LEAD: 3, ADMIN: 4 };

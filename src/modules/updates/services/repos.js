import {
  fetchBranch,
  fetchForks,
  fetchLatestCommit,
  fetchLatestUpdate,
  fetchRepoInfo,
  parseRepoSlug
} from "./github.js";

const LABEL_MAX_LENGTH = 80;
const FORK_CACHE_TTL_MS = 5 * 60 * 1000;

/** Fehler mit einer Meldung, die direkt an Nutzer gehen darf. */
export class RepoConfigError extends Error {}

function sameName(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function cleanLabel(value) {
  return String(value || "").trim().slice(0, LABEL_MAX_LENGTH);
}

function normalizeFork(raw) {
  if (!raw?.owner || !raw?.repo) {
    return null;
  }

  return {
    owner: String(raw.owner),
    repo: String(raw.repo),
    branch: String(raw.branch || ""),
    label: cleanLabel(raw.label),
    lastSeenId: String(raw.lastSeenId || "")
  };
}

export function normalizeRepos(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry) => entry?.owner && entry?.repo)
    .map((entry) => ({
      ...entry,
      label: cleanLabel(entry.label),
      lastSeenId: String(entry.lastSeenId || ""),
      forks: (Array.isArray(entry.forks) ? entry.forks : []).map(normalizeFork).filter(Boolean)
    }));
}

export function getRepos(settingsStore, guildId) {
  return normalizeRepos(settingsStore.getModuleState(guildId, "updates")?.config?.repos);
}

export function saveRepos(settingsStore, guildId, repos) {
  settingsStore.setModuleConfig(guildId, "updates", { repos });
}

export function repoKey(entry) {
  return `${entry.owner}/${entry.repo}`;
}

export function forkKey(fork) {
  return `${fork.owner}/${fork.repo}@${fork.branch}`;
}

export function findRepoIndex(repos, owner, repo) {
  return repos.findIndex((entry) => sameName(entry.owner, owner) && sameName(entry.repo, repo));
}

function findWatchedRepo(repos, input) {
  const slug = parseRepoSlug(input);
  const index = slug ? findRepoIndex(repos, slug.owner, slug.repo) : -1;

  if (index === -1) {
    throw new RepoConfigError(`\`${String(input || "").trim()}\` wird nicht beobachtet. Füge es zuerst als Repo hinzu.`);
  }

  return index;
}

/**
 * Akzeptiert für einen Fork: "benutzer" (Fork mit gleichem Repo-Namen, so legt
 * GitHub ihn standardmäßig an), "benutzer/repo" oder einen GitHub-Link.
 */
export function parseForkInput(raw, parent) {
  const text = String(raw || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");

  if (/^[\w.-]+$/.test(text)) {
    return { owner: text, repo: parent.repo };
  }

  return parseRepoSlug(text);
}

/**
 * Wählt aus den Fork-eigenen Commits (älteste zuerst, so liefert sie die
 * Compare-API) die seit dem letzten Stand neuen aus. Liegt der letzte Stand
 * nicht darin, war er ein Upstream-Commit – dann ist alles Eigene neu.
 */
export function selectNewForkCommits(ownCommits, lastSeenId) {
  const index = ownCommits.findIndex((commit) => commit.sha === lastSeenId);
  return index === -1 ? ownCommits : ownCommits.slice(index + 1);
}

export async function addRepo({ settingsStore, guildId, token, input, label }) {
  const slug = parseRepoSlug(input);

  if (!slug) {
    throw new RepoConfigError("Bitte gib das Repo im Format `owner/repo` an, z.B. `torvalds/linux`.");
  }

  if (findRepoIndex(getRepos(settingsStore, guildId), slug.owner, slug.repo) !== -1) {
    throw new RepoConfigError(`\`${slug.owner}/${slug.repo}\` wird bereits beobachtet.`);
  }

  const info = await fetchRepoInfo(slug.owner, slug.repo, token).catch(() => null);
  if (!info) {
    throw new RepoConfigError(`Repo \`${slug.owner}/${slug.repo}\` wurde auf GitHub nicht gefunden.`);
  }

  // Bei umbenannten Repos gleich den aktuellen Namen speichern.
  const owner = info.owner?.login || slug.owner;
  const repo = info.name || slug.repo;
  const baseline = await fetchLatestUpdate(owner, repo, token).catch(() => null);

  const repos = getRepos(settingsStore, guildId);
  if (findRepoIndex(repos, owner, repo) !== -1) {
    throw new RepoConfigError(`\`${owner}/${repo}\` wird bereits beobachtet.`);
  }

  const entry = { owner, repo, label: cleanLabel(label), lastSeenId: baseline?.id || "", forks: [] };
  saveRepos(settingsStore, guildId, [...repos, entry]);
  return entry;
}

export function removeRepo({ settingsStore, guildId, input }) {
  const repos = getRepos(settingsStore, guildId);
  const [removed] = repos.splice(findWatchedRepo(repos, input), 1);
  saveRepos(settingsStore, guildId, repos);
  return removed;
}

export async function addFork({ settingsStore, guildId, token, parentInput, forkInput, branch, label }) {
  const watched = getRepos(settingsStore, guildId);
  const parent = watched[findWatchedRepo(watched, parentInput)];
  const slug = parseForkInput(forkInput, parent);

  if (!slug) {
    throw new RepoConfigError("Bitte gib den Fork als `benutzer`, `benutzer/repo` oder GitHub-Link an.");
  }

  const [parentInfo, forkInfo] = await Promise.all([
    fetchRepoInfo(parent.owner, parent.repo, token).catch(() => null),
    fetchRepoInfo(slug.owner, slug.repo, token).catch(() => null)
  ]);

  if (!parentInfo) {
    throw new RepoConfigError(`\`${repoKey(parent)}\` ist auf GitHub gerade nicht erreichbar.`);
  }

  if (!forkInfo) {
    throw new RepoConfigError(`Fork \`${slug.owner}/${slug.repo}\` wurde auf GitHub nicht gefunden.`);
  }

  // Auch Forks von Forks zählen, solange sie im selben Netzwerk hängen.
  if (!forkInfo.fork || (forkInfo.parent?.id !== parentInfo.id && forkInfo.source?.id !== parentInfo.id)) {
    throw new RepoConfigError(`\`${forkInfo.full_name}\` ist kein Fork von \`${parentInfo.full_name}\`.`);
  }

  const requestedBranch = String(branch || "").trim();
  const fork = {
    owner: forkInfo.owner.login,
    repo: forkInfo.name,
    branch: requestedBranch || forkInfo.default_branch,
    label: cleanLabel(label),
    lastSeenId: ""
  };

  if (requestedBranch && !(await fetchBranch(fork.owner, fork.repo, fork.branch, token).catch(() => null))) {
    throw new RepoConfigError(`Branch \`${fork.branch}\` gibt es in \`${forkInfo.full_name}\` nicht.`);
  }

  // Nur was ab jetzt passiert wird gepostet.
  const baseline = await fetchLatestCommit(fork.owner, fork.repo, token, fork.branch).catch(() => null);
  fork.lastSeenId = baseline?.sha || "";

  // Nach den API-Aufrufen frisch lesen – parallel kann sich die Liste geändert haben.
  const repos = getRepos(settingsStore, guildId);
  const target = repos[findWatchedRepo(repos, repoKey(parent))];

  if (target.forks.some((existing) => sameName(forkKey(existing), forkKey(fork)))) {
    throw new RepoConfigError(`\`${forkKey(fork)}\` wird bereits beobachtet.`);
  }

  target.forks.push(fork);
  saveRepos(settingsStore, guildId, repos);
  return { parent: target, fork };
}

/**
 * Entfernt einen Fork. "benutzer/repo@branch" trifft genau einen Eintrag,
 * "benutzer/repo" oder "benutzer" alle beobachteten Branches dieses Forks.
 */
export function removeFork({ settingsStore, guildId, parentInput, forkInput }) {
  const repos = getRepos(settingsStore, guildId);
  const parent = repos[findWatchedRepo(repos, parentInput)];
  const [slugPart, branch] = String(forkInput || "").trim().split("@");
  const slug = parseForkInput(slugPart, parent);

  const matches = (fork) => Boolean(slug)
    && sameName(fork.owner, slug.owner)
    && sameName(fork.repo, slug.repo)
    && (branch === undefined || fork.branch === branch);

  const removed = parent.forks.filter(matches);
  if (removed.length === 0) {
    throw new RepoConfigError(`\`${String(forkInput || "").trim()}\` ist bei \`${repoKey(parent)}\` nicht hinterlegt.`);
  }

  parent.forks = parent.forks.filter((fork) => !matches(fork));
  saveRepos(settingsStore, guildId, repos);
  return removed;
}

const forkCache = new Map();

/** Forks eines Repos laut GitHub, für Autovervollständigung und Dashboard. */
export async function listForkCandidates(owner, repo, token) {
  const key = `${owner}/${repo}`.toLowerCase();
  const cached = forkCache.get(key);

  if (cached && Date.now() - cached.at < FORK_CACHE_TTL_MS) {
    return cached.forks;
  }

  const forks = (await fetchForks(owner, repo, token)).map((fork) => ({
    slug: fork.full_name,
    owner: fork.owner?.login || "",
    defaultBranch: fork.default_branch || "",
    pushedAt: fork.pushed_at || null
  }));

  forkCache.set(key, { at: Date.now(), forks });
  return forks;
}

import {
  fetchBranch,
  fetchBranches,
  fetchForks,
  fetchLatestCommit,
  fetchLatestReleaseUpdate,
  fetchLatestUpdate,
  fetchRepoInfo,
  parseRepoSlug
} from "./github.js";

const LABEL_MAX_LENGTH = 80;
const GITHUB_CACHE_TTL_MS = 5 * 60 * 1000;

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
      branch: String(entry.branch || ""),
      lastSeenId: String(entry.lastSeenId || ""),
      lastSeenCommit: String(entry.lastSeenCommit || ""),
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

/**
 * Markiert "Repo hatte beim Festlegen des Stands kein Release". So wird das
 * erste Release später gepostet, während ein leerer Wert ("Stand noch
 * unbekannt") nur still übernommen wird.
 */
export const NO_RELEASE = "keins";

/**
 * Ausgangsstand, ab dem gepostet wird. Ohne Branch wie gehabt: neuestes
 * Release, sonst neuester Commit des Haupt-Branches. Mit Branch werden
 * Releases und Commits auf dem Branch getrennt verfolgt.
 */
async function repoBaseline(owner, repo, branch, token) {
  if (!branch) {
    const latest = await fetchLatestUpdate(owner, repo, token).catch(() => null);
    return { lastSeenId: latest?.id || "", lastSeenCommit: "" };
  }

  const [release, commit] = await Promise.all([
    // undefined = Abruf fehlgeschlagen, null = es gibt kein Release.
    fetchLatestReleaseUpdate(owner, repo, token).catch(() => undefined),
    fetchLatestCommit(owner, repo, token, branch).catch(() => null)
  ]);

  return {
    lastSeenId: release === undefined ? "" : (release?.id || NO_RELEASE),
    lastSeenCommit: commit?.sha || ""
  };
}

async function requireBranch(owner, repo, branch, token) {
  if (branch && !(await fetchBranch(owner, repo, branch, token).catch(() => null))) {
    throw new RepoConfigError(`Branch \`${branch}\` gibt es in \`${owner}/${repo}\` nicht.`);
  }
}

/**
 * Ein schon beobachtetes Repo erneut hinzuzufügen heißt: die mitgegebenen
 * Angaben übernehmen. Wer "add" mit Branch tippt, will genau das – eine
 * Fehlermeldung "wird bereits beobachtet" hilft da nicht weiter.
 */
async function updateWatchedRepo({ settingsStore, guildId, token, current, label, branch }) {
  const branchName = String(branch || "").trim();
  const labelText = cleanLabel(label);

  if (!branchName && !labelText) {
    const onBranch = current.branch ? ` (Branch \`${current.branch}\`)` : "";
    throw new RepoConfigError(`\`${repoKey(current)}\` wird bereits beobachtet${onBranch}. `
      + "Gib einen Branch oder Anzeigenamen an, um ihn zu ändern.");
  }

  if (branchName && branchName !== current.branch) {
    await setRepoBranch({ settingsStore, guildId, token, input: repoKey(current), branch: branchName });
  }

  const repos = getRepos(settingsStore, guildId);
  const entry = repos[findWatchedRepo(repos, repoKey(current))];

  if (labelText) {
    entry.label = labelText;
    saveRepos(settingsStore, guildId, repos);
  }

  return { entry, updated: true };
}

/**
 * Beobachtet ein neues Repo oder aktualisiert ein schon beobachtetes.
 * `updated` sagt, welcher Fall eingetreten ist.
 */
export async function addRepo({ settingsStore, guildId, token, input, label, branch }) {
  const slug = parseRepoSlug(input);

  if (!slug) {
    throw new RepoConfigError("Bitte gib das Repo im Format `owner/repo` an, z.B. `torvalds/linux`.");
  }

  const info = await fetchRepoInfo(slug.owner, slug.repo, token).catch(() => null);
  if (!info) {
    throw new RepoConfigError(`Repo \`${slug.owner}/${slug.repo}\` wurde auf GitHub nicht gefunden.`);
  }

  // Bei umbenannten Repos gleich den aktuellen Namen speichern.
  const owner = info.owner?.login || slug.owner;
  const repo = info.name || slug.repo;

  // Gesucht wird unter beiden Namen: eingetragen sein kann noch der alte.
  const findExisting = () => {
    const repos = getRepos(settingsStore, guildId);
    const index = [findRepoIndex(repos, owner, repo), findRepoIndex(repos, slug.owner, slug.repo)]
      .find((candidate) => candidate !== -1);
    return index === undefined ? null : repos[index];
  };

  const existing = findExisting();
  if (existing) {
    return updateWatchedRepo({ settingsStore, guildId, token, current: existing, label, branch });
  }

  const branchName = String(branch || "").trim();
  await requireBranch(owner, repo, branchName, token);
  const baseline = await repoBaseline(owner, repo, branchName, token);

  // Während der Abrufe kann dasselbe Repo parallel angelegt worden sein.
  const raced = findExisting();
  if (raced) {
    return updateWatchedRepo({ settingsStore, guildId, token, current: raced, label, branch });
  }

  const entry = { owner, repo, label: cleanLabel(label), branch: branchName, ...baseline, forks: [] };
  saveRepos(settingsStore, guildId, [...getRepos(settingsStore, guildId), entry]);
  return { entry, updated: false };
}

/**
 * Setzt oder entfernt (leerer Branch) den beobachteten Branch eines Repos.
 * Der Ausgangsstand wird neu gesetzt, damit der Wechsel keine alten Commits
 * in den Kanal spült.
 */
export async function setRepoBranch({ settingsStore, guildId, token, input, branch }) {
  const watched = getRepos(settingsStore, guildId);
  const current = watched[findWatchedRepo(watched, input)];
  const branchName = String(branch || "").trim();

  await requireBranch(current.owner, current.repo, branchName, token);
  const baseline = await repoBaseline(current.owner, current.repo, branchName, token);

  const repos = getRepos(settingsStore, guildId);
  const target = repos[findWatchedRepo(repos, repoKey(current))];
  Object.assign(target, { branch: branchName, ...baseline });
  saveRepos(settingsStore, guildId, repos);
  return target;
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

// Discord gibt Autovervollständigungen nur drei Sekunden; Listen von GitHub
// werden deshalb kurz zwischengespeichert. Das schont auch das API-Kontingent.
const githubCache = new Map();

async function cached(key, load) {
  const entry = githubCache.get(key);

  if (entry && Date.now() - entry.at < GITHUB_CACHE_TTL_MS) {
    return entry.value;
  }

  const value = await load();
  githubCache.set(key, { at: Date.now(), value });
  return value;
}

/** Forks eines Repos laut GitHub, für Autovervollständigung und Dashboard. */
export function listForkCandidates(owner, repo, token) {
  return cached(`forks:${owner}/${repo}`.toLowerCase(), async () =>
    (await fetchForks(owner, repo, token)).map((fork) => ({
      slug: fork.full_name,
      owner: fork.owner?.login || "",
      defaultBranch: fork.default_branch || "",
      pushedAt: fork.pushed_at || null
    })));
}

/** Haupt-Branch zuerst, danach alphabetisch. */
export function sortBranches(names, defaultBranch) {
  return [...names].sort((a, b) => {
    if (a === defaultBranch) {
      return -1;
    }

    if (b === defaultBranch) {
      return 1;
    }

    return a.localeCompare(b, "de");
  });
}

/**
 * Branches eines Repos laut GitHub, Haupt-Branch zuerst. GitHub liefert pro
 * Abruf höchstens 100 – für Auswahllisten reicht das.
 */
export function listBranches(owner, repo, token) {
  return cached(`branches:${owner}/${repo}`.toLowerCase(), async () => {
    const [info, branches] = await Promise.all([
      fetchRepoInfo(owner, repo, token),
      fetchBranches(owner, repo, token).catch(() => [])
    ]);

    if (!info) {
      throw new RepoConfigError(`\`${owner}/${repo}\` wurde auf GitHub nicht gefunden.`);
    }

    const defaultBranch = info.default_branch || "";
    return {
      repo: info.full_name,
      defaultBranch,
      branches: sortBranches(branches.map((branch) => branch.name), defaultBranch)
    };
  });
}

/**
 * Branches des Forks, den jemand gerade eingibt – ohne Fork-Angabe die des
 * beobachteten Repos selbst.
 */
export async function listBranchesFor({ settingsStore, guildId, token, parentInput, forkInput }) {
  const repos = getRepos(settingsStore, guildId);
  const parent = repos[findWatchedRepo(repos, parentInput)];
  const target = String(forkInput || "").trim() ? parseForkInput(forkInput, parent) : parent;

  if (!target) {
    throw new RepoConfigError("Bitte gib den Fork als `benutzer`, `benutzer/repo` oder GitHub-Link an.");
  }

  return listBranches(target.owner, target.repo, token);
}

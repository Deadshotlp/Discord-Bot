const GITHUB_API_BASE = "https://api.github.com";

export function parseRepoSlug(raw) {
  const text = String(raw || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");
  const match = text.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) {
    return null;
  }

  return { owner: match[1], repo: match[2] };
}

/**
 * Liest owner/repo aus einer GitHub-Web-URL. Nach einer Umbenennung leitet
 * GitHub die alte API-Adresse weiter, die URLs in der Antwort tragen aber
 * schon den neuen Namen – so erkennt der Bot Umbenennungen ohne Zusatzabfrage.
 */
export function repoSlugFromHtmlUrl(url) {
  const match = String(url || "").match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:[/?#]|$)/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}

function buildHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "discord-bot"
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

// Branch-Namen dürfen "/" enthalten, das muss im Pfad erhalten bleiben.
function encodeRef(ref) {
  return String(ref).split("/").map(encodeURIComponent).join("/");
}

async function githubGet(path, token, { allowNotFound = false } = {}) {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    headers: buildHeaders(token)
  });

  if (allowNotFound && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub API Fehler (${response.status})`);
  }

  return response.json();
}

export function fetchRepoInfo(owner, repo, token) {
  return githubGet(`/repos/${owner}/${repo}`, token, { allowNotFound: true });
}

export function fetchBranch(owner, repo, branch, token) {
  return githubGet(`/repos/${owner}/${repo}/branches/${encodeRef(branch)}`, token, { allowNotFound: true });
}

export async function fetchBranches(owner, repo, token) {
  const branches = await githubGet(`/repos/${owner}/${repo}/branches?per_page=100`, token);
  return Array.isArray(branches) ? branches : [];
}

export async function fetchForks(owner, repo, token) {
  const forks = await githubGet(`/repos/${owner}/${repo}/forks?sort=newest&per_page=100`, token);
  return Array.isArray(forks) ? forks : [];
}

/**
 * Vergleicht zwei Stände im selben Fork-Netzwerk. `head` darf auf einen Fork
 * zeigen ("benutzer:branch"). `commits` enthält dann genau die Commits, die
 * im Fork liegen, im Original aber nicht.
 */
export function fetchCompare(owner, repo, base, head, token) {
  return githubGet(`/repos/${owner}/${repo}/compare/${encodeRef(base)}...${encodeRef(head)}`, token);
}

function fetchLatestRelease(owner, repo, token) {
  return githubGet(`/repos/${owner}/${repo}/releases/latest`, token, { allowNotFound: true });
}

export async function fetchLatestCommit(owner, repo, token, branch = "") {
  const query = branch ? `&sha=${encodeURIComponent(branch)}` : "";
  const commits = await githubGet(`/repos/${owner}/${repo}/commits?per_page=1${query}`, token);
  return commits?.[0] || null;
}

export function toCommitUpdate(commit) {
  return {
    type: "commit",
    id: commit.sha,
    title: (commit.commit?.message || "").split("\n")[0] || commit.sha.slice(0, 7),
    version: commit.sha.slice(0, 7),
    url: commit.html_url,
    body: commit.commit?.message || "",
    author: commit.commit?.author?.name || commit.author?.login || "",
    publishedAt: commit.commit?.author?.date || null
  };
}

/** Neuestes Release oder null, wenn das Repo keine hat. Wirft bei API-Fehlern. */
export async function fetchLatestReleaseUpdate(owner, repo, token) {
  const release = await fetchLatestRelease(owner, repo, token);
  if (!release) {
    return null;
  }

  return {
    type: "release",
    id: String(release.id),
    title: release.name || release.tag_name,
    version: release.tag_name || "",
    url: release.html_url,
    body: release.body || "",
    author: release.author?.login || "",
    publishedAt: release.published_at || release.created_at || null
  };
}

export async function fetchLatestUpdate(owner, repo, token) {
  const release = await fetchLatestReleaseUpdate(owner, repo, token);
  if (release) {
    return release;
  }

  const commit = await fetchLatestCommit(owner, repo, token);
  return commit ? toCommitUpdate(commit) : null;
}

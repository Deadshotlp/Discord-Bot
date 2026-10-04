import { ACCESS_LEVELS, requireLevel } from "../auth.js";
import { HttpError, sendJson } from "../http.js";
import { recordAudit } from "../../core/audit.js";
import { parseRepoSlug } from "../../modules/updates/services/github.js";
import {
  RepoConfigError,
  addFork,
  addRepo,
  findRepoIndex,
  getRepos,
  listBranches,
  listBranchesFor,
  listForkCandidates,
  removeFork,
  removeRepo,
  setRepoBranch
} from "../../modules/updates/services/repos.js";

// Die gesehenen IDs sind interner Polling-Stand und gehen das Dashboard nichts an.
function publicRepos(repos) {
  return repos.map((entry) => ({
    owner: entry.owner,
    repo: entry.repo,
    label: entry.label,
    branch: entry.branch,
    forks: entry.forks.map((fork) => ({ owner: fork.owner, repo: fork.repo, branch: fork.branch, label: fork.label }))
  }));
}

async function run(action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RepoConfigError) {
      throw new HttpError(400, error.message);
    }

    throw error;
  }
}

export function registerUpdatesRoutes(router, { client }) {
  const { settingsStore, env } = client.botContext;

  const audit = (ctx, action, detail) => recordAudit({
    guildId: ctx.params.guildId,
    actorId: ctx.session.discordId,
    actorName: ctx.session.username,
    action,
    detail
  });

  router.get("/api/guilds/:guildId/updates/repos", (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.lead);
    sendJson(ctx.res, 200, publicRepos(getRepos(settingsStore, ctx.params.guildId)));
  });

  router.post("/api/guilds/:guildId/updates/repos", async (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.admin);

    const { entry, updated } = await run(() => addRepo({
      settingsStore,
      guildId: ctx.params.guildId,
      token: env.githubToken,
      input: ctx.body.repo,
      label: ctx.body.label,
      branch: ctx.body.branch
    }));

    audit(ctx, updated ? "updates.repo.update" : "updates.repo.add", { repo: `${entry.owner}/${entry.repo}`, branch: entry.branch });
    sendJson(ctx.res, 200, publicRepos(getRepos(settingsStore, ctx.params.guildId)));
  });

  // Branch eines beobachteten Repos setzen; leer = zurück zum Standard.
  router.patch("/api/guilds/:guildId/updates/repos/:owner/:repo", async (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.admin);

    const slug = `${ctx.params.owner}/${ctx.params.repo}`;
    const entry = await run(() => setRepoBranch({
      settingsStore,
      guildId: ctx.params.guildId,
      token: env.githubToken,
      input: slug,
      branch: ctx.body.branch
    }));

    audit(ctx, "updates.repo.branch", { repo: slug, branch: entry.branch });
    sendJson(ctx.res, 200, publicRepos(getRepos(settingsStore, ctx.params.guildId)));
  });

  // Branches eines beliebigen Repos – für den Dialog "Repo beobachten", in dem
  // das Repo noch nicht in der Liste steht.
  router.get("/api/guilds/:guildId/updates/branches", async (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.admin);

    const slug = parseRepoSlug(ctx.url.searchParams.get("repo"));
    if (!slug) {
      throw new HttpError(400, "Repo bitte als owner/repo angeben");
    }

    sendJson(ctx.res, 200, await run(() => listBranches(slug.owner, slug.repo, env.githubToken)));
  });

  router.delete("/api/guilds/:guildId/updates/repos/:owner/:repo", async (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.admin);

    const slug = `${ctx.params.owner}/${ctx.params.repo}`;
    await run(() => removeRepo({ settingsStore, guildId: ctx.params.guildId, input: slug }));

    audit(ctx, "updates.repo.remove", { repo: slug });
    sendJson(ctx.res, 200, publicRepos(getRepos(settingsStore, ctx.params.guildId)));
  });

  // Vorschläge für das Fork-Formular. Gecacht, damit das Öffnen des Dialogs
  // nicht jedes Mal das GitHub-Kontingent belastet.
  router.get("/api/guilds/:guildId/updates/repos/:owner/:repo/fork-candidates", async (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.admin);

    const repos = getRepos(settingsStore, ctx.params.guildId);
    const index = findRepoIndex(repos, ctx.params.owner, ctx.params.repo);

    if (index === -1) {
      throw new HttpError(404, "Repo wird nicht beobachtet");
    }

    const candidates = await listForkCandidates(repos[index].owner, repos[index].repo, env.githubToken)
      .catch(() => []);
    sendJson(ctx.res, 200, candidates);
  });

  // Branches des eingegebenen Forks (?fork=benutzer), ohne Angabe die des Repos.
  router.get("/api/guilds/:guildId/updates/repos/:owner/:repo/branches", async (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.admin);

    const result = await run(() => listBranchesFor({
      settingsStore,
      guildId: ctx.params.guildId,
      token: env.githubToken,
      parentInput: `${ctx.params.owner}/${ctx.params.repo}`,
      forkInput: ctx.url.searchParams.get("fork") || ""
    }));

    sendJson(ctx.res, 200, result);
  });

  router.post("/api/guilds/:guildId/updates/repos/:owner/:repo/forks", async (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.admin);

    const { parent, fork } = await run(() => addFork({
      settingsStore,
      guildId: ctx.params.guildId,
      token: env.githubToken,
      parentInput: `${ctx.params.owner}/${ctx.params.repo}`,
      forkInput: ctx.body.fork,
      branch: ctx.body.branch,
      label: ctx.body.label
    }));

    audit(ctx, "updates.fork.add", { repo: `${parent.owner}/${parent.repo}`, fork: `${fork.owner}/${fork.repo}@${fork.branch}` });
    sendJson(ctx.res, 200, publicRepos(getRepos(settingsStore, ctx.params.guildId)));
  });

  router.delete("/api/guilds/:guildId/updates/repos/:owner/:repo/forks/:fork", async (ctx) => {
    requireLevel(ctx.access, ACCESS_LEVELS.admin);

    const slug = `${ctx.params.owner}/${ctx.params.repo}`;
    await run(() => removeFork({
      settingsStore,
      guildId: ctx.params.guildId,
      parentInput: slug,
      forkInput: ctx.params.fork
    }));

    audit(ctx, "updates.fork.remove", { repo: slug, fork: ctx.params.fork });
    sendJson(ctx.res, 200, publicRepos(getRepos(settingsStore, ctx.params.guildId)));
  });
}

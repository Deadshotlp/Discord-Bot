import { ACCESS_LEVELS, requireLevel } from "../auth.js";
import { HttpError, sendJson } from "../http.js";
import { recordAudit } from "../../core/audit.js";
import {
  RepoConfigError,
  addFork,
  addRepo,
  findRepoIndex,
  getRepos,
  listForkCandidates,
  removeFork,
  removeRepo
} from "../../modules/updates/services/repos.js";

// Die gesehenen IDs sind interner Polling-Stand und gehen das Dashboard nichts an.
function publicRepos(repos) {
  return repos.map((entry) => ({
    owner: entry.owner,
    repo: entry.repo,
    label: entry.label,
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

    const entry = await run(() => addRepo({
      settingsStore,
      guildId: ctx.params.guildId,
      token: env.githubToken,
      input: ctx.body.repo,
      label: ctx.body.label
    }));

    audit(ctx, "updates.repo.add", { repo: `${entry.owner}/${entry.repo}` });
    sendJson(ctx.res, 200, publicRepos(getRepos(settingsStore, ctx.params.guildId)));
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

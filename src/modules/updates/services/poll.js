import {
  fetchCompare,
  fetchLatestCommit,
  fetchLatestReleaseUpdate,
  fetchLatestUpdate,
  fetchRepoInfo,
  repoSlugFromHtmlUrl
} from "./github.js";
import { buildBranchUpdateEmbed, buildForkUpdateEmbed, buildRepoUpdateEmbed } from "./embeds.js";
import { NO_RELEASE, forkKey, getRepos, normalizeRepos, repoKey, saveRepos, selectNewForkCommits } from "./repos.js";

/**
 * Übernimmt einen neuen Namen, wenn GitHub das Repo inzwischen unter anderem
 * Namen ausliefert (Umbenennung oder Besitzerwechsel).
 */
function followRename(entry, url, logger, guildId) {
  const current = repoSlugFromHtmlUrl(url);

  if (!current || (current.owner === entry.owner && current.repo === entry.repo)) {
    return false;
  }

  logger.info("GitHub-Repo wurde umbenannt, Eintrag angepasst", {
    guildId,
    von: repoKey(entry),
    nach: repoKey(current)
  });

  entry.owner = current.owner;
  entry.repo = current.repo;
  return true;
}

/** Neue Commits auf dem Branch seit dem letzten Stand, älteste zuerst. */
async function collectBranchChanges(entry, latest, token) {
  try {
    const comparison = await fetchCompare(entry.owner, entry.repo, entry.lastSeenCommit, entry.branch, token);
    return { commits: comparison.commits || [], compareUrl: comparison.html_url || "" };
  } catch {
    // Alter Stand nicht mehr auffindbar (z. B. nach Force-Push) – dann
    // wenigstens den neuesten Commit melden.
    return { commits: [latest], compareUrl: "" };
  }
}

/**
 * Repo mit gewähltem Branch: Releases werden weiter gemeldet, neue Commits auf
 * dem Branch zusätzlich – gesammelt in einem Post je Durchlauf.
 */
async function pollRepoBranch({ channel, entry, env, logger, guildId }) {
  const token = env.githubToken;
  let changed = false;

  const release = await fetchLatestReleaseUpdate(entry.owner, entry.repo, token);
  if (release) {
    changed = followRename(entry, release.url, logger, guildId) || changed;

    if (release.id !== entry.lastSeenId) {
      // Leer heißt "Stand unbekannt" – dann nur übernehmen. NO_RELEASE heißt,
      // es gab bisher keins: dieses ist das erste und wird gepostet.
      if (entry.lastSeenId) {
        await channel.send({ embeds: [buildRepoUpdateEmbed(entry, release)] });
      }

      entry.lastSeenId = release.id;
      changed = true;
    }
  } else if (!entry.lastSeenId) {
    entry.lastSeenId = NO_RELEASE;
    changed = true;
  }

  const latest = await fetchLatestCommit(entry.owner, entry.repo, token, entry.branch);
  if (!latest) {
    return changed;
  }

  changed = followRename(entry, latest.html_url, logger, guildId) || changed;

  if (latest.sha === entry.lastSeenCommit) {
    return changed;
  }

  if (entry.lastSeenCommit) {
    const changes = await collectBranchChanges(entry, latest, token);

    if (changes.commits.length > 0) {
      await channel.send({ embeds: [buildBranchUpdateEmbed(entry, changes)] });
    }
  }

  entry.lastSeenCommit = latest.sha;
  return true;
}

export async function pollRepo({ channel, entry, env, logger, guildId }) {
  if (entry.branch) {
    return pollRepoBranch({ channel, entry, env, logger, guildId });
  }

  const update = await fetchLatestUpdate(entry.owner, entry.repo, env.githubToken);
  if (!update) {
    return false;
  }

  const renamed = followRename(entry, update.url, logger, guildId);

  if (update.id === entry.lastSeenId) {
    return renamed;
  }

  if (entry.lastSeenId) {
    await channel.send({ embeds: [buildRepoUpdateEmbed(entry, update)] });
  }

  entry.lastSeenId = update.id;
  return true;
}

/**
 * Nur die Commits des Forks, die es im Original nicht gibt. Holt der Fork bloß
 * den Stand des Originals nach, wird nichts gepostet – das stand ja schon im
 * Kanal.
 */
async function collectForkChanges(entry, fork, latest, token) {
  try {
    // Verglichen wird mit dem Branch, den das Original beobachtet.
    const baseBranch = entry.branch || (await fetchRepoInfo(entry.owner, entry.repo, token)).default_branch;
    const comparison = await fetchCompare(
      entry.owner,
      entry.repo,
      baseBranch,
      `${fork.owner}:${fork.branch}`,
      token
    );

    return {
      commits: selectNewForkCommits(comparison.commits || [], fork.lastSeenId),
      aheadBy: Number(comparison.ahead_by) || 0,
      compareUrl: comparison.html_url || ""
    };
  } catch {
    // Vergleich nicht möglich (z. B. Branch umbenannt) – dann wenigstens den
    // neuesten Commit melden statt still zu bleiben.
    return { commits: [latest], aheadBy: null, compareUrl: "" };
  }
}

async function pollFork({ channel, entry, fork, env, logger, guildId }) {
  const latest = await fetchLatestCommit(fork.owner, fork.repo, env.githubToken, fork.branch);
  if (!latest) {
    return false;
  }

  const renamed = followRename(fork, latest.html_url, logger, guildId);

  if (latest.sha === fork.lastSeenId) {
    return renamed;
  }

  if (fork.lastSeenId) {
    const changes = await collectForkChanges(entry, fork, latest, env.githubToken);

    if (changes.commits.length > 0) {
      await channel.send({ embeds: [buildForkUpdateEmbed(entry, fork, changes)] });
    }
  }

  fork.lastSeenId = latest.sha;
  return true;
}

/**
 * Überträgt den Polling-Stand (gesehene IDs, neue Namen) auf die aktuelle
 * Liste. Ein Durchlauf dauert einige Sekunden; wer in der Zeit im Dashboard
 * einen Fork hinzufügt oder entfernt, soll das nicht verlieren.
 */
function mergePollState(current, polled, originalKeys) {
  const byOriginalKey = new Map(polled.map((entry) => [originalKeys.get(entry).toLowerCase(), entry]));

  for (const entry of current) {
    const source = byOriginalKey.get(repoKey(entry).toLowerCase());
    if (!source) {
      continue;
    }

    const forksByOriginalKey = new Map(source.forks.map((fork) => [originalKeys.get(fork).toLowerCase(), fork]));
    Object.assign(entry, { owner: source.owner, repo: source.repo });

    // Wurde der Branch währenddessen umgestellt, gehört der gepollte Stand zum
    // alten Branch – dann gilt der beim Umstellen frisch gesetzte.
    if (source.branch === entry.branch) {
      Object.assign(entry, { lastSeenId: source.lastSeenId, lastSeenCommit: source.lastSeenCommit });
    }

    for (const fork of entry.forks) {
      const polledFork = forksByOriginalKey.get(forkKey(fork).toLowerCase());
      if (polledFork) {
        Object.assign(fork, { owner: polledFork.owner, repo: polledFork.repo, lastSeenId: polledFork.lastSeenId });
      }
    }
  }

  return current;
}

async function pollGuild(client, guild) {
  const { settingsStore, logger, env } = client.botContext;

  if (!settingsStore.isModuleEnabled(guild.id, "updates")) {
    return;
  }

  const config = settingsStore.getModuleState(guild.id, "updates")?.config || {};
  const channelId = config.channelId;
  const repos = normalizeRepos(config.repos);

  if (!channelId || repos.length === 0) {
    return;
  }

  const channel = guild.channels.cache.get(channelId)
    || (await guild.channels.fetch(channelId).catch(() => null));

  if (!channel || !channel.isTextBased()) {
    return;
  }

  const originalKeys = new Map();
  for (const entry of repos) {
    originalKeys.set(entry, repoKey(entry));
    for (const fork of entry.forks) {
      originalKeys.set(fork, forkKey(fork));
    }
  }

  let changed = false;

  for (const entry of repos) {
    try {
      changed = (await pollRepo({ channel, entry, env, logger, guildId: guild.id })) || changed;
    } catch (error) {
      logger.warn("Update-Check fehlgeschlagen", {
        guildId: guild.id,
        repo: repoKey(entry),
        error: String(error)
      });
    }

    for (const fork of entry.forks) {
      try {
        changed = (await pollFork({ channel, entry, fork, env, logger, guildId: guild.id })) || changed;
      } catch (error) {
        logger.warn("Fork-Check fehlgeschlagen", {
          guildId: guild.id,
          repo: repoKey(entry),
          fork: forkKey(fork),
          error: String(error)
        });
      }
    }
  }

  if (changed) {
    saveRepos(settingsStore, guild.id, mergePollState(getRepos(settingsStore, guild.id), repos, originalKeys));
  }
}

async function runPollCycle(client) {
  for (const guild of client.guilds.cache.values()) {
    await pollGuild(client, guild);
  }
}

export function startUpdatesPolling(client) {
  const { logger, env } = client.botContext;
  const intervalMs = Math.max(5, env.updatesPollIntervalMinutes) * 60 * 1000;

  const runSafely = () => {
    runPollCycle(client).catch((error) => {
      logger.warn("Update-Polling fehlgeschlagen", { error: String(error) });
    });
  };

  runSafely();
  setInterval(runSafely, intervalMs);
}

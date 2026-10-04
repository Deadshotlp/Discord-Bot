import { test } from "node:test";
import assert from "node:assert/strict";

import { NO_RELEASE, addRepo, setRepoBranch } from "../src/modules/updates/services/repos.js";
import { pollRepo } from "../src/modules/updates/services/poll.js";

const SLUG = "Deadshotlp/gamemodes";

function commit(sha, message = `Commit ${sha}`) {
  return {
    sha,
    html_url: `https://github.com/${SLUG}/commit/${sha}`,
    commit: { message, author: { name: "Deadshot", date: "2026-10-04T12:00:00Z" } }
  };
}

function release(id, tag) {
  return { id, tag_name: tag, name: tag, html_url: `https://github.com/${SLUG}/releases/tag/${tag}`, body: "" };
}

/**
 * Nachgebildete GitHub-API. `state` lässt sich zwischen zwei Abrufen ändern,
 * wie es auf GitHub zwischen zwei Polling-Durchläufen passieren würde.
 */
function mockGitHub(t, state) {
  t.mock.method(globalThis, "fetch", async (url) => {
    const path = String(url).replace("https://api.github.com", "");
    const respond = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

    if (path === `/repos/${SLUG}`) {
      return respond({ full_name: SLUG, name: "gamemodes", owner: { login: "Deadshotlp" }, default_branch: "main" });
    }

    if (path === `/repos/${SLUG}/releases/latest`) {
      return state.release ? respond(state.release) : respond({ message: "Not Found" }, 404);
    }

    const branchMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/branches\/(.+)$/);
    if (branchMatch) {
      return state.branches[decodeURIComponent(branchMatch[1])] ? respond({}) : respond({}, 404);
    }

    const commitsMatch = path.match(/\/commits\?per_page=1(?:&sha=(.+))?$/);
    if (commitsMatch) {
      const branch = decodeURIComponent(commitsMatch[1] || "main");
      const history = state.branches[branch] || [];
      return respond(history.length ? [history[history.length - 1]] : []);
    }

    const compareMatch = path.match(/\/compare\/(.+)\.\.\.(.+)$/);
    if (compareMatch) {
      const history = state.branches[decodeURIComponent(compareMatch[2])] || [];
      const base = history.findIndex((entry) => entry.sha === compareMatch[1]);
      return respond({ commits: history.slice(base + 1), html_url: `https://github.com/${SLUG}/compare/x` });
    }

    throw new Error(`Unerwarteter Abruf: ${path}`);
  });
}

function fakeStore(repos = []) {
  let config = { repos };
  return {
    getModuleState: () => ({ config }),
    setModuleConfig: (_guildId, _module, fields) => {
      config = { ...config, ...fields };
    },
    get repos() {
      return config.repos;
    }
  };
}

function fakeChannel() {
  const sent = [];
  return { sent, send: async (payload) => sent.push(payload.embeds[0].toJSON()) };
}

const env = { githubToken: "" };
const logger = { info() {} };

test("Repo mit Branch: Ausgangsstand ist neuester Branch-Commit, ohne Release markiert", async (t) => {
  mockGitHub(t, { release: null, branches: { main: [commit("m1")], dev: [commit("d1"), commit("d2")] } });
  const store = fakeStore();

  const entry = await addRepo({ settingsStore: store, guildId: "g", token: "", input: SLUG, branch: "dev" });

  assert.equal(entry.branch, "dev");
  assert.equal(entry.lastSeenCommit, "d2");
  assert.equal(entry.lastSeenId, NO_RELEASE);
});

test("Ein unbekannter Branch wird beim Anlegen abgelehnt", async (t) => {
  mockGitHub(t, { release: null, branches: { main: [commit("m1")] } });

  await assert.rejects(
    addRepo({ settingsStore: fakeStore(), guildId: "g", token: "", input: SLUG, branch: "gibts-nicht" }),
    /Branch `gibts-nicht` gibt es/
  );
});

test("Polling mit Branch: neue Commits gesammelt, erstes Release gepostet, nichts doppelt", async (t) => {
  const state = { release: null, branches: { main: [commit("m1")], dev: [commit("d1")] } };
  mockGitHub(t, state);
  const store = fakeStore();
  const entry = await addRepo({ settingsStore: store, guildId: "g", token: "", input: SLUG, branch: "dev" });
  const channel = fakeChannel();

  // Nichts Neues: kein Post.
  await pollRepo({ channel, entry, env, logger, guildId: "g" });
  assert.equal(channel.sent.length, 0);

  // Zwei Commits auf dev, ein Commit auf main (darf nicht auftauchen), erstes Release.
  state.branches.dev.push(commit("d2", "Balancing angepasst"), commit("d3", "Neue Waffe"));
  state.branches.main.push(commit("m2", "Nur auf main"));
  state.release = release(7, "v1.0.0");

  await pollRepo({ channel, entry, env, logger, guildId: "g" });

  assert.equal(channel.sent.length, 2);
  const [releasePost, branchPost] = channel.sent;
  assert.match(releasePost.title, /Neues Release/);
  assert.match(branchPost.title, /2 neue Commits auf dev/);
  assert.match(branchPost.description, /Neue Waffe[\s\S]*Balancing angepasst/);
  assert.doesNotMatch(branchPost.description, /Nur auf main/);

  // Gleicher Stand erneut: nichts doppelt.
  await pollRepo({ channel, entry, env, logger, guildId: "g" });
  assert.equal(channel.sent.length, 2);
});

test("Branch umstellen setzt den Stand neu, leer stellt den Standard wieder her", async (t) => {
  const state = { release: release(3, "v0.3.0"), branches: { main: [commit("m1")], dev: [commit("d1")] } };
  mockGitHub(t, state);
  const store = fakeStore();
  await addRepo({ settingsStore: store, guildId: "g", token: "", input: SLUG });

  assert.equal(store.repos[0].branch, "");
  assert.equal(store.repos[0].lastSeenId, "3");

  await setRepoBranch({ settingsStore: store, guildId: "g", token: "", input: SLUG, branch: "dev" });
  assert.equal(store.repos[0].branch, "dev");
  assert.equal(store.repos[0].lastSeenCommit, "d1");

  await setRepoBranch({ settingsStore: store, guildId: "g", token: "", input: SLUG, branch: "" });
  assert.equal(store.repos[0].branch, "");
  assert.equal(store.repos[0].lastSeenCommit, "");
  assert.equal(store.repos[0].lastSeenId, "3");
});

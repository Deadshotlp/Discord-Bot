import { test } from "node:test";
import assert from "node:assert/strict";

import { repoSlugFromHtmlUrl } from "../src/modules/updates/services/github.js";
import {
  forkKey,
  listBranchesFor,
  normalizeRepos,
  parseForkInput,
  removeFork,
  selectNewForkCommits,
  sortBranches
} from "../src/modules/updates/services/repos.js";
import { buildForkUpdateEmbed } from "../src/modules/updates/services/embeds.js";

const parent = { owner: "Deadshotlp", repo: "gamemodes" };

function fakeStore(repos) {
  let config = { channelId: "1", repos };
  return {
    getModuleState: () => ({ config }),
    setModuleConfig: (_guildId, _module, fields) => {
      config = { ...config, ...fields };
    },
    get config() {
      return config;
    }
  };
}

function commit(sha, message = `Commit ${sha}`) {
  return {
    sha: sha.padEnd(40, "0"),
    html_url: `https://github.com/someone/gamemodes/commit/${sha}`,
    commit: { message, author: { name: "Someone", date: "2026-10-04T12:00:00Z" } }
  };
}

test("ein Fork lässt sich als Benutzername, Slug oder Link angeben", () => {
  assert.deepEqual(parseForkInput("Bob", parent), { owner: "Bob", repo: "gamemodes" });
  assert.deepEqual(parseForkInput("Bob/gm-fork", parent), { owner: "Bob", repo: "gm-fork" });
  assert.deepEqual(parseForkInput("https://github.com/Bob/gm-fork/", parent), { owner: "Bob", repo: "gm-fork" });
  assert.equal(parseForkInput("kein gültiger fork", parent), null);
});

test("alte Einträge ohne Forks werden ergänzt, kaputte verworfen", () => {
  const repos = normalizeRepos([
    { owner: "a", repo: "b", lastSeenId: "x" },
    { owner: "", repo: "b" },
    { owner: "c", repo: "d", forks: [{ owner: "e", repo: "d", branch: "main" }, { repo: "ohne-owner" }] }
  ]);

  assert.equal(repos.length, 2);
  assert.deepEqual(repos[0].forks, []);
  assert.equal(repos[1].forks.length, 1);
  assert.equal(forkKey(repos[1].forks[0]), "e/d@main");
});

test("nur Commits nach dem letzten Stand gelten als neu", () => {
  const own = [commit("a"), commit("b"), commit("c")];

  assert.deepEqual(selectNewForkCommits(own, own[0].sha).map((c) => c.sha), [own[1].sha, own[2].sha]);
  assert.deepEqual(selectNewForkCommits(own, own[2].sha), []);
  // Letzter Stand war ein Upstream-Commit: alles Eigene ist neu.
  assert.equal(selectNewForkCommits(own, "upstream").length, 3);
});

test("Fork entfernen: mit Branch genau einer, ohne Branch alle", () => {
  const store = fakeStore([{
    ...parent,
    forks: [
      { owner: "Bob", repo: "gamemodes", branch: "main" },
      { owner: "Bob", repo: "gamemodes", branch: "dev" },
      { owner: "Eve", repo: "gamemodes", branch: "main" }
    ]
  }]);

  removeFork({ settingsStore: store, guildId: "g", parentInput: "deadshotlp/gamemodes", forkInput: "Bob/gamemodes@dev" });
  assert.deepEqual(store.config.repos[0].forks.map(forkKey), ["Bob/gamemodes@main", "Eve/gamemodes@main"]);

  removeFork({ settingsStore: store, guildId: "g", parentInput: "Deadshotlp/gamemodes", forkInput: "bob" });
  assert.deepEqual(store.config.repos[0].forks.map(forkKey), ["Eve/gamemodes@main"]);
  assert.equal(store.config.channelId, "1", "andere Einstellungen bleiben erhalten");

  assert.throws(
    () => removeFork({ settingsStore: store, guildId: "g", parentInput: "Deadshotlp/gamemodes", forkInput: "Bob" }),
    /nicht hinterlegt/
  );
});

test("Umbenennungen werden an der GitHub-URL erkannt", () => {
  assert.deepEqual(
    repoSlugFromHtmlUrl("https://github.com/Deadshotlp/Discord-Bot/commit/abc"),
    { owner: "Deadshotlp", repo: "Discord-Bot" }
  );
  assert.deepEqual(
    repoSlugFromHtmlUrl("https://github.com/Deadshotlp/Discord-Bot/releases/tag/v2.0.0"),
    { owner: "Deadshotlp", repo: "Discord-Bot" }
  );
  assert.equal(repoSlugFromHtmlUrl("https://example.com/x/y"), null);
});

test("das Fork-Embed listet mehrere Commits, neueste zuerst", () => {
  const fork = { owner: "Bob", repo: "gamemodes", branch: "dev", label: "" };
  const embed = buildForkUpdateEmbed({ ...parent, label: "Gamemode" }, fork, {
    commits: [commit("a", "Erster"), commit("b", "Zweiter")],
    aheadBy: 5,
    compareUrl: "https://github.com/Deadshotlp/gamemodes/compare/main...Bob:dev"
  }).toJSON();

  assert.equal(embed.title, "Gamemode · Fork von Bob — 2 neue Commits");
  assert.equal(embed.url, "https://github.com/Deadshotlp/gamemodes/compare/main...Bob:dev");
  assert.ok(embed.description.indexOf("Zweiter") < embed.description.indexOf("Erster"));
  assert.equal(embed.fields.find((f) => f.name === "Vorsprung").value, "5 Commits");
});

test("Branches: Haupt-Branch zuerst, Rest alphabetisch", () => {
  assert.deepEqual(sortBranches(["feature/z", "dev", "main", "Alpha"], "main"), ["main", "Alpha", "dev", "feature/z"]);
});

test("Branch-Abfrage fragt den eingegebenen Fork ab, ohne Fork das Repo selbst", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    const body = String(url).endsWith("/branches?per_page=100")
      ? [{ name: "dev" }, { name: "master" }, { name: "balance" }]
      : { full_name: String(url).split("/repos/")[1], default_branch: "master" };
    return { ok: true, status: 200, json: async () => body };
  });

  const store = fakeStore([{ ...parent, forks: [] }]);
  const forkResult = await listBranchesFor({
    settingsStore: store, guildId: "g", token: "", parentInput: "Deadshotlp/gamemodes", forkInput: "Branchtester"
  });

  assert.equal(forkResult.repo, "Branchtester/gamemodes");
  assert.deepEqual(forkResult.branches, ["master", "balance", "dev"]);
  assert.ok(requested.every((url) => url.includes("/repos/Branchtester/gamemodes")));

  const ownResult = await listBranchesFor({
    settingsStore: store, guildId: "g", token: "", parentInput: "Deadshotlp/gamemodes", forkInput: ""
  });
  assert.equal(ownResult.repo, "Deadshotlp/gamemodes");

  await assert.rejects(
    listBranchesFor({ settingsStore: store, guildId: "g", token: "", parentInput: "x/y", forkInput: "Bob" }),
    /nicht beobachtet/
  );
});

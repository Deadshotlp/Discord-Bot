import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { canManageServer } from "../../../core/permissions.js";
import { parseRepoSlug } from "../services/github.js";
import {
  RepoConfigError,
  addFork,
  addRepo,
  findRepoIndex,
  forkKey,
  getRepos,
  listForkCandidates,
  removeFork,
  removeRepo,
  repoKey
} from "../services/repos.js";

const AUTOCOMPLETE_LIMIT = 25;

function choices(values, focused) {
  const needle = focused.toLowerCase();
  return values
    .filter((value) => value.toLowerCase().includes(needle))
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map((value) => ({ name: value, value }));
}

function watchedParent(repos, interaction) {
  const slug = parseRepoSlug(interaction.options.getString("repo"));
  const index = slug ? findRepoIndex(repos, slug.owner, slug.repo) : -1;
  return index === -1 ? null : repos[index];
}

async function handleAdd({ interaction, settingsStore, env }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const entry = await addRepo({
    settingsStore,
    guildId: interaction.guildId,
    token: env.githubToken,
    input: interaction.options.getString("repo", true),
    label: interaction.options.getString("label")
  });

  await interaction.editReply({
    content: `\`${repoKey(entry)}\` wird jetzt beobachtet. Nur zukünftige Updates werden gepostet.\n`
      + "Forks dazu hinterlegst du mit `/updates-repo fork-add`."
  });
}

async function handleRemove({ interaction, settingsStore }) {
  const removed = removeRepo({
    settingsStore,
    guildId: interaction.guildId,
    input: interaction.options.getString("repo", true)
  });

  const forkNote = removed.forks.length > 0 ? ` (samt ${removed.forks.length} Fork(s))` : "";
  await interaction.reply({
    content: `\`${repoKey(removed)}\`${forkNote} wurde entfernt.`,
    flags: MessageFlags.Ephemeral
  });
}

async function handleForkAdd({ interaction, settingsStore, env }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { parent, fork } = await addFork({
    settingsStore,
    guildId: interaction.guildId,
    token: env.githubToken,
    parentInput: interaction.options.getString("repo", true),
    forkInput: interaction.options.getString("fork", true),
    branch: interaction.options.getString("branch"),
    label: interaction.options.getString("label")
  });

  await interaction.editReply({
    content: `Fork \`${fork.owner}/${fork.repo}\` (Branch \`${fork.branch}\`) wird zu \`${repoKey(parent)}\` beobachtet.\n`
      + "Gepostet werden nur eigene Commits des Forks – reines Nachziehen des Originals bleibt still."
  });
}

async function handleForkRemove({ interaction, settingsStore }) {
  const removed = removeFork({
    settingsStore,
    guildId: interaction.guildId,
    parentInput: interaction.options.getString("repo", true),
    forkInput: interaction.options.getString("fork", true)
  });

  await interaction.reply({
    content: `Entfernt: ${removed.map((fork) => `\`${forkKey(fork)}\``).join(", ")}`,
    flags: MessageFlags.Ephemeral
  });
}

async function handleList({ interaction, settingsStore }) {
  const repos = getRepos(settingsStore, interaction.guildId);

  if (repos.length === 0) {
    await interaction.reply({
      content: "Aktuell wird kein Repo beobachtet. Füge eins mit `/updates-repo add` hinzu.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const lines = repos.flatMap((entry) => [
    `• \`${repoKey(entry)}\`${entry.label ? ` (${entry.label})` : ""}`,
    ...entry.forks.map((fork) => `  ↳ Fork \`${fork.owner}/${fork.repo}\` · Branch \`${fork.branch}\`${fork.label ? ` (${fork.label})` : ""}`)
  ]);

  await interaction.reply({
    content: [`Beobachtete Repos (${repos.length}):`, ...lines].join("\n").slice(0, 2000),
    flags: MessageFlags.Ephemeral
  });
}

const HANDLERS = {
  add: handleAdd,
  remove: handleRemove,
  "fork-add": handleForkAdd,
  "fork-remove": handleForkRemove,
  list: handleList
};

const watchedRepoOption = (option) =>
  option.setName("repo").setDescription("Beobachtetes Repo").setRequired(true).setAutocomplete(true);

export const updatesRepoCommand = {
  data: new SlashCommandBuilder()
    .setName("updates-repo")
    .setDescription("Verwaltet die beobachteten GitHub-Repos und Forks für automatische Updates.")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Fügt ein Repo zur Update-Liste hinzu.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo, z.B. torvalds/linux").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("label").setDescription("Anzeigename für die Update-Posts (optional)").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Entfernt ein Repo samt seinen Forks von der Update-Liste.")
        .addStringOption(watchedRepoOption)
    )
    .addSubcommand((sub) =>
      sub
        .setName("fork-add")
        .setDescription("Beobachtet zusätzlich einen bestimmten Fork eines Repos.")
        .addStringOption(watchedRepoOption)
        .addStringOption((option) =>
          option
            .setName("fork")
            .setDescription("Fork als benutzer oder benutzer/repo")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((option) =>
          option.setName("branch").setDescription("Branch im Fork (Standard: Haupt-Branch des Forks)").setRequired(false)
        )
        .addStringOption((option) =>
          option.setName("label").setDescription("Anzeigename für die Posts (optional)").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("fork-remove")
        .setDescription("Entfernt einen hinterlegten Fork.")
        .addStringOption(watchedRepoOption)
        .addStringOption((option) =>
          option.setName("fork").setDescription("Hinterlegter Fork").setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("Zeigt alle beobachteten Repos und Forks.")),

  async autocomplete({ client, interaction }) {
    if (!interaction.inGuild()) {
      await interaction.respond([]);
      return;
    }

    const { settingsStore, env } = client.botContext;
    const repos = getRepos(settingsStore, interaction.guildId);
    const focused = interaction.options.getFocused(true);

    if (focused.name === "repo") {
      await interaction.respond(choices(repos.map(repoKey), focused.value));
      return;
    }

    const parent = watchedParent(repos, interaction);
    if (!parent) {
      await interaction.respond([]);
      return;
    }

    if (interaction.options.getSubcommand() === "fork-remove") {
      await interaction.respond(choices(parent.forks.map(forkKey), focused.value));
      return;
    }

    // Discord wartet nur drei Sekunden; die Fork-Liste ist deshalb gecacht.
    const candidates = await listForkCandidates(parent.owner, parent.repo, env.githubToken).catch(() => []);
    await interaction.respond(choices(candidates.map((fork) => fork.slug), focused.value));
  },

  async execute({ client, interaction }) {
    if (!canManageServer(interaction.member)) {
      await interaction.reply({
        content: "Diesen Befehl dürfen nur Admins oder Mitglieder mit Server-verwalten nutzen.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const { settingsStore, env } = client.botContext;
    const handler = HANDLERS[interaction.options.getSubcommand()] || handleList;

    try {
      await handler({ interaction, settingsStore, env });
    } catch (error) {
      if (!(error instanceof RepoConfigError)) {
        throw error;
      }

      const reply = { content: error.message, flags: MessageFlags.Ephemeral };
      await (interaction.deferred ? interaction.editReply({ content: error.message }) : interaction.reply(reply));
    }
  }
};

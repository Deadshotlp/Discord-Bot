import { EmbedBuilder } from "discord.js";

const DESCRIPTION_MAX_LENGTH = 4000;

export function buildRepoUpdateEmbed(repoEntry, update) {
  const displayName = repoEntry.label || `${repoEntry.owner}/${repoEntry.repo}`;
  const kindLabel = update.type === "release" ? "Neues Release" : "Neuer Commit";

  const embed = new EmbedBuilder()
    .setColor(0x2ea043)
    .setTitle(`${displayName} — ${kindLabel}`)
    .setURL(update.url)
    .addFields({ name: "Version", value: update.version || "-", inline: true })
    .setFooter({ text: `${repoEntry.owner}/${repoEntry.repo}` });

  if (update.author) {
    embed.addFields({ name: "Autor", value: update.author, inline: true });
  }

  if (update.body) {
    embed.setDescription(update.body.slice(0, DESCRIPTION_MAX_LENGTH));
  }

  if (update.publishedAt) {
    embed.setTimestamp(new Date(update.publishedAt));
  }

  return embed;
}

const COMMIT_LIST_LIMIT = 10;

function commitHeadline(commit) {
  return (commit.commit?.message || "").split("\n")[0] || commit.sha.slice(0, 7);
}

function commitCountLabel(count) {
  return count === 1 ? "Neuer Commit" : `${count} neue Commits`;
}

/**
 * Gemeinsamer Teil für Commit-Posts: Link, Beschreibung, Autor, Zeitpunkt.
 * `commits` sind älteste zuerst, so liefert sie die Compare-API.
 */
function applyCommits(embed, commits, compareUrl) {
  const newest = commits[commits.length - 1];
  const single = commits.length === 1;

  embed.setURL(single || !compareUrl ? newest.html_url : compareUrl);

  if (single) {
    const author = newest.commit?.author?.name || newest.author?.login;
    if (author) {
      embed.addFields({ name: "Autor", value: author, inline: true });
    }

    embed.setDescription(`[\`${newest.sha.slice(0, 7)}\`](${newest.html_url}) ${newest.commit?.message || ""}`
      .slice(0, DESCRIPTION_MAX_LENGTH));
  } else {
    // Neueste zuerst, wie man es von einem Changelog erwartet.
    const shown = commits.slice(-COMMIT_LIST_LIMIT).reverse();
    const lines = shown.map((commit) => {
      const author = commit.commit?.author?.name || commit.author?.login;
      return `[\`${commit.sha.slice(0, 7)}\`](${commit.html_url}) ${commitHeadline(commit)}${author ? ` — ${author}` : ""}`;
    });

    if (commits.length > shown.length) {
      lines.push(`… und ${commits.length - shown.length} weitere`);
    }

    embed.setDescription(lines.join("\n").slice(0, DESCRIPTION_MAX_LENGTH));
  }

  const date = newest.commit?.author?.date;
  if (date) {
    embed.setTimestamp(new Date(date));
  }

  return embed;
}

/** Neue Commits auf dem gewählten Branch eines beobachteten Repos. */
export function buildBranchUpdateEmbed(repoEntry, { commits, compareUrl = "" }) {
  const displayName = repoEntry.label || `${repoEntry.owner}/${repoEntry.repo}`;

  const embed = new EmbedBuilder()
    .setColor(0x2ea043)
    .setTitle(`${displayName} — ${commitCountLabel(commits.length)} auf ${repoEntry.branch}`)
    .addFields({ name: "Branch", value: repoEntry.branch, inline: true })
    .setFooter({ text: `${repoEntry.owner}/${repoEntry.repo}` });

  return applyCommits(embed, commits, compareUrl);
}

/**
 * `commits` sind die neuen Fork-eigenen Commits, älteste zuerst. `aheadBy`
 * ist der gesamte Vorsprung des Forks vor dem Original (null = unbekannt).
 */
export function buildForkUpdateEmbed(repoEntry, fork, { commits, aheadBy = null, compareUrl = "" }) {
  const parentName = repoEntry.label || `${repoEntry.owner}/${repoEntry.repo}`;
  const displayName = fork.label || `${parentName} · Fork von ${fork.owner}`;

  const embed = new EmbedBuilder()
    .setColor(0x8957e5)
    .setTitle(`${displayName} — ${commitCountLabel(commits.length)}`)
    .addFields(
      { name: "Fork von", value: `${repoEntry.owner}/${repoEntry.repo}`, inline: true },
      { name: "Branch", value: fork.branch || "-", inline: true }
    )
    .setFooter({ text: `${fork.owner}/${fork.repo}` });

  if (aheadBy !== null) {
    embed.addFields({ name: "Vorsprung", value: `${aheadBy} Commit${aheadBy === 1 ? "" : "s"}`, inline: true });
  }

  return applyCommits(embed, commits, compareUrl);
}

const ROMAN_NUMERALS = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
  [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
  [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]
];

export function toRomanNumeral(value) {
  let remaining = value;
  let result = "";

  for (const [amount, symbol] of ROMAN_NUMERALS) {
    while (remaining >= amount) {
      result += symbol;
      remaining -= amount;
    }
  }

  return result || String(value);
}

export function formatChangelogDate(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getFullYear()}`;
}

const ANSI_RESET = "[0m";
const ANSI_GREEN = "[0;32m";
const ANSI_YELLOW = "[0;33m";
const ANSI_RED = "[0;31m";

function colorizeChangelogLine(line) {
  if (line.startsWith("+")) {
    return `${ANSI_GREEN}${line}${ANSI_RESET}`;
  }

  if (line.startsWith("~")) {
    return `${ANSI_YELLOW}${line}${ANSI_RESET}`;
  }

  if (line.startsWith("-")) {
    return `${ANSI_RED}${line}${ANSI_RESET}`;
  }

  return line;
}

export function colorizeChangelogNotes(notes) {
  return notes
    .split("\n")
    .map((line) => colorizeChangelogLine(line))
    .join("\n");
}

export function buildChangelogEmbed({ category, notes, sequence, date, author, authorAvatarUrl, noteText }) {
  const coloredNotes = colorizeChangelogNotes(notes);
  const descriptionParts = [
    `${formatChangelogDate(date)} — Nr. ${toRomanNumeral(sequence)}`,
    "",
    `\`\`\`ansi\n${coloredNotes}\n\`\`\``
  ];

  if (noteText) {
    descriptionParts.push("", noteText);
  }

  const description = descriptionParts.join("\n").slice(0, DESCRIPTION_MAX_LENGTH);

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(category)
    .setDescription(description)
    .setTimestamp(date);

  if (author) {
    embed.setFooter({ text: `Erstellt von ${author}`, iconURL: authorAvatarUrl || undefined });
  }

  return embed;
}

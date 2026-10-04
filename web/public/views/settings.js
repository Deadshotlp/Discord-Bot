import { ACCESS, api } from "../lib/api.js";
import {
  badge,
  card,
  clear,
  confirmDialog,
  field,
  h,
  modal,
  select,
  spinner,
  table,
  toast
} from "../lib/ui.js";

// Feldbeschreibungen je Modul. Daraus wird das Formular gebaut –
// neue Optionen brauchen nur einen Eintrag hier plus den Default im Modul.
const MODULE_FIELDS = {
  monitoring: [
    { key: "statusChannelId", label: "Status-Panel-Channel", type: "channel", hint: "Hier hält der Bot ein Live-Panel aktuell" },
    { key: "panelIntervalSeconds", label: "Panel-Aktualisierung (Sek.)", type: "number", min: 30, max: 3600 },
    { key: "chartRange", label: "Diagramm-Zeitraum im Panel", type: "select", options: [
      { value: "24h", label: "24 Stunden" }, { value: "7d", label: "7 Tage" }, { value: "30d", label: "30 Tage" }
    ] },
    { key: "showHourProfile", label: "Tagesprofil im Panel anzeigen", type: "bool" },
    { key: "alertOnStateChange", label: "Bei Online-/Offline-Wechsel benachrichtigen", type: "bool" },
    { key: "alertChannelId", label: "Benachrichtigungs-Channel", type: "channel", hint: "Leer = Status-Panel-Channel" },
    { key: "alertRoleId", label: "Ping-Rolle bei Ausfall", type: "role" }
  ],
  absence: [
    { key: "panelChannelId", label: "Abmelde-Panel-Channel", type: "channel",
      hint: "Dort stellt der Bot ein Panel mit Button zum Abmelden bereit" },
    { key: "announceChannelId", label: "Ankündigungs-Channel", type: "channel" },
    { key: "overviewChannelId", label: "Übersichts-Channel", type: "channel", hint: "Dauerhaft aktualisierte Wer-ist-weg-Nachricht" },
    { key: "overviewDays", label: "Vorschau in Tagen", type: "number", min: 7, max: 120 },
    { key: "maxDays", label: "Maximale Abwesenheitsdauer (Tage)", type: "number", min: 1, max: 365 },
    { key: "requireApproval", label: "Freigabe durch Bereichsleitung nötig", type: "bool" },
    { key: "allowSelfService", label: "Mitglieder dürfen sich selbst abmelden", type: "bool" },
    { key: "notifyRoleIds", label: "Ping-Rollen bei neuer Abmeldung", type: "roles" }
  ],
  teamList: [
    { key: "panelChannelId", label: "Teamlisten-Channel", type: "channel",
      hint: "Der Bot hält dort eine Nachricht mit der Teamliste aktuell. Leer = nur der Befehl /team liste" },
    { key: "refreshMinutes", label: "Auffrischung (Min.)", type: "number", min: 5, max: 1440,
      hint: "Zusätzlich zu den sofortigen Aktualisierungen bei Rollenänderungen" }
  ],
  support: [
    { key: "waitingChannelId", label: "Support-Warteraum (Voice)", type: "voice" },
    { key: "managementChannelId", label: "Verwaltungs-Channel", type: "channel" },
    { key: "transcriptTextChannelId", label: "Transkript-Channel", type: "channel" },
    { key: "talkCategoryId", label: "Kategorie Support-Talks", type: "category" },
    { key: "ticketCategoryId", label: "Kategorie Tickets", type: "category" }
  ],
  verify: [
    { key: "roleId", label: "Verify-Rolle", type: "role" },
    { key: "channelId", label: "Verify-Channel", type: "channel" },
    { key: "rulesText", label: "Regeltext", type: "textarea" }
  ],
  updates: [
    { key: "channelId", label: "Updates-Channel", type: "channel" },
    { key: "changelogPingRoleId", label: "Ping-Rolle für Changelogs", type: "role" },
    { key: "changelogRoleIds", label: "Rollen, die /changelog nutzen dürfen", type: "roles" },
    { key: "changelogNoteText", label: "Hinweistext unter Changelogs", type: "textarea" }
  ],
  "weekly-report": [
    { key: "publishChannelId", label: "Veröffentlichungs-Channel", type: "channel" },
    { key: "publishWeekday", label: "Wochentag", type: "select", options: [
      "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"
    ].map((label, index) => ({ value: index + 1, label })) },
    { key: "publishHour", label: "Stunde", type: "number", min: 0, max: 23 },
    { key: "publishMinute", label: "Minute", type: "number", min: 0, max: 59 },
    { key: "reminderHoursBefore", label: "Erinnerung (Std. vorher, 0 = aus)", type: "number", min: 0, max: 168 },
    { key: "reminderChannelId", label: "Erinnerungs-Channel", type: "channel", hint: "Leer = Veröffentlichungs-Channel" }
  ],
  "steam-link": [
    { key: "ingameCommand", label: "Chat-Befehl im Spiel", type: "text", hint: "Standard: !discord" },
    { key: "linkedRoleId", label: "Rolle für verknüpfte Mitglieder", type: "role" },
    { key: "announceChannelId", label: "Channel für Verknüpfungs-Meldungen", type: "channel" },
    { key: "trackPlaytime", label: "Spielzeit erfassen", type: "bool" }
  ],
  meeting: [],
  "reaction-role": [],
  "content-creator": [],
  system: [],
  dashboard: []
};

function channelOptions(channels) {
  return [
    { value: "", label: "– nicht gesetzt –" },
    ...channels.map((channel) => ({
      value: channel.id,
      label: channel.parent ? `${channel.parent} / ${channel.name}` : channel.name
    }))
  ];
}

function roleOptions(roles) {
  return [{ value: "", label: "– nicht gesetzt –" }, ...roles.map((role) => ({ value: role.id, label: role.name }))];
}

function buildControl(guild, spec, value) {
  switch (spec.type) {
    case "channel":
      return select(channelOptions(guild.channels.text), { name: spec.key, value: value || "" });
    case "voice":
      return select(channelOptions(guild.channels.voice), { name: spec.key, value: value || "" });
    case "category":
      return select(channelOptions(guild.channels.category), { name: spec.key, value: value || "" });
    case "role":
      return select(roleOptions(guild.roles), { name: spec.key, value: value || "" });
    case "roles": {
      const chosen = new Set(Array.isArray(value) ? value : []);
      return h("div", { style: { maxHeight: "160px", overflowY: "auto", display: "grid", gap: "4px" } },
        ...guild.roles.slice(0, 100).map((role) =>
          h("label.switch", { style: { fontSize: "13px" } },
            h("input", {
              type: "checkbox", name: spec.key, value: role.id, checked: chosen.has(role.id),
              style: { width: "16px", height: "16px", appearance: "auto" }
            }),
            role.name)));
    }
    case "bool":
      return h("label.switch", {},
        h("input", { type: "checkbox", name: spec.key, checked: Boolean(value) }),
        h("span.muted", { style: { fontSize: "13px" } }, "aktiviert"));
    case "number":
      return h("input.input", { name: spec.key, type: "number", min: spec.min, max: spec.max, value: value ?? "" });
    case "select":
      return select(spec.options, { name: spec.key, value: value ?? "" });
    case "textarea":
      return h("textarea.input", { name: spec.key, value: value ?? "" });
    default:
      return h("input.input", { name: spec.key, value: value ?? "" });
  }
}

function readValue(form, spec) {
  if (spec.type === "bool") {
    return form.querySelector(`[name="${spec.key}"]`).checked;
  }

  if (spec.type === "roles") {
    return [...form.querySelectorAll(`input[name="${spec.key}"]:checked`)].map((input) => input.value);
  }

  const element = form.querySelector(`[name="${spec.key}"]`);
  if (!element) {
    return undefined;
  }

  if (spec.type === "number") {
    return element.value === "" ? undefined : Number(element.value);
  }

  return element.value;
}

function moduleCard(guildId, guild, moduleInfo, refresh) {
  const isAdmin = guild.accessLevel >= ACCESS.ADMIN;
  const fields = MODULE_FIELDS[moduleInfo.name] || [];

  const form = h("form.stack", {
    onSubmit: async (event) => {
      event.preventDefault();

      const config = {};
      for (const spec of fields) {
        const value = readValue(form, spec);
        if (value !== undefined) {
          config[spec.key] = value;
        }
      }

      try {
        await api.updateModule(guildId, moduleInfo.name, { config });
        toast(`${moduleInfo.label} gespeichert.`, "success");
        await refresh();
      } catch (error) {
        toast(error.message, "error");
      }
    }
  },
  ...fields.map((spec) => field(spec.label, buildControl(guild, spec, moduleInfo.config[spec.key]), spec.hint)),
  fields.length > 0 && isAdmin
    ? h("div.row", {}, h("button.btn.btn-primary.btn-sm", { type: "submit" }, "Speichern"))
    : null);

  if (!isAdmin) {
    for (const control of form.querySelectorAll("input, select, textarea")) {
      control.disabled = true;
    }
  }

  return card(
    h("div.row-between", { style: { width: "100%" } },
      h("span", {}, moduleInfo.label, " ",
        moduleInfo.enabled ? badge("aktiv", "success") : badge("aus", "neutral")),
      isAdmin
        ? h("label.switch", {},
          h("input", {
            type: "checkbox",
            checked: moduleInfo.enabled,
            onChange: async (event) => {
              await api.updateModule(guildId, moduleInfo.name, { enabled: event.target.checked });
              toast(`${moduleInfo.label} ${event.target.checked ? "aktiviert" : "deaktiviert"}.`, "success");
              await refresh();
            }
          }))
        : null),

    moduleInfo.description ? h("p.muted", { style: { fontSize: "13px" } }, moduleInfo.description) : null,
    moduleInfo.commands.length > 0
      ? h("p.muted", { style: { fontSize: "12px" } }, "Befehle: ",
        ...moduleInfo.commands.map((name) => h("code", { style: { marginRight: "6px" } }, `/${name}`)))
      : null,
    fields.length > 0 ? form : null);
}

function departmentsCard(guildId, guild, departments, refresh) {
  const isAdmin = guild.accessLevel >= ACCESS.ADMIN;

  const departmentForm = (values = {}) => h("div", {},
    field("Name", h("input.input", { name: "name", required: true, value: values.name || "" })),
    field("Mitglieder-Rollen", buildControl(guild, { key: "roleIds", type: "roles" }, values.roleIds),
      "Wer diese Rollen hat, darf Tickets des Departments bearbeiten"),
    field("Leitungs-Rollen", buildControl(guild, { key: "leadRoleIds", type: "roles" }, values.leadRoleIds),
      "Leitung darf Wochenberichte abgeben, Abmeldungen freigeben und Statistiken sehen"));

  const readDepartment = (data, form) => ({
    name: data.name,
    roleIds: [...form.querySelectorAll('input[name="roleIds"]:checked')].map((input) => input.value),
    leadRoleIds: [...form.querySelectorAll('input[name="leadRoleIds"]:checked')].map((input) => input.value)
  });

  // Reihenfolge wird als komplette ID-Liste geschickt; der Server ordnet danach.
  const move = async (index, direction) => {
    const ids = departments.map((department) => department.id);
    const target = index + direction;

    if (target < 0 || target >= ids.length) {
      return;
    }

    [ids[index], ids[target]] = [ids[target], ids[index]];

    await api.reorderDepartments(guildId, ids);
    await refresh();
  };

  return card(
    h("div.row-between", { style: { width: "100%" } },
      h("span", {}, "Departments"),
      isAdmin
        ? h("button.btn.btn-sm.btn-primary", {
          onClick: () => modal("Department anlegen", departmentForm(), {
            submitLabel: "Anlegen",
            onSubmit: async (data, form) => {
              await api.createDepartment(guildId, readDepartment(data, form));
              toast("Department angelegt.", "success");
              await refresh();
            }
          })
        }, "+ Department")
        : null),

    h("p.muted", { style: { fontSize: "13px" } },
      "Departments strukturieren Tickets, Wochenberichte und Abmeldungen gleichermaßen. "
      + "Die Reihenfolge hier bestimmt auch die Reihenfolge in der Teamliste."),

    table(["#", "Name", "ID", "Mitglieder-Rollen", "Leitungs-Rollen", ""],
      departments.map((department, index) => [
        isAdmin
          ? h("div.row", {},
            h("button.btn.btn-sm", {
              disabled: index === 0,
              title: "Nach oben",
              onClick: () => move(index, -1)
            }, "↑"),
            h("button.btn.btn-sm", {
              disabled: index === departments.length - 1,
              title: "Nach unten",
              onClick: () => move(index, 1)
            }, "↓"))
          : String(index + 1),
        h("strong", {}, department.name),
        h("span.mono", { style: { fontSize: "12px" } }, department.id),
        department.roleIds.map((id) => guild.roles.find((role) => role.id === id)?.name || id).join(", ") || "–",
        department.leadRoleIds.map((id) => guild.roles.find((role) => role.id === id)?.name || id).join(", ") || "–",
        isAdmin
          ? h("div.row", {},
            h("button.btn.btn-sm", {
              onClick: () => modal(`${department.name} bearbeiten`, departmentForm(department), {
                onSubmit: async (data, form) => {
                  await api.updateDepartment(guildId, department.id, readDepartment(data, form));
                  toast("Gespeichert.", "success");
                  await refresh();
                }
              })
            }, "Bearbeiten"),
            h("button.btn.btn-sm.btn-danger", {
              onClick: async () => {
                if (!confirmDialog(`Department „${department.name}“ löschen?`)) {
                  return;
                }

                await api.deleteDepartment(guildId, department.id);
                await refresh();
              }
            }, "Löschen"))
          : "–"
      ]),
      { empty: "Noch keine Departments angelegt." }));
}

function creatorsCard(guildId, guild, creators, refresh) {
  const isAdmin = guild.accessLevel >= ACCESS.ADMIN;

  const form = h("form.stack", {
    onSubmit: async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());

      const parseLines = (text) => String(text || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [profile, ...rest] = line.split("|");
          return { profile: profile.trim(), announceTemplate: rest.join("|").trim() };
        });

      try {
        const result = await api.post(`/api/guilds/${guildId}/creators`, {
          notifyChannelId: data.notifyChannelId,
          youtubeRoleId: data.youtubeRoleId,
          twitchRoleId: data.twitchRoleId,
          youtubeChannels: parseLines(data.youtube),
          twitchChannels: parseLines(data.twitch)
        });

        toast(result.warnings.length > 0 ? result.warnings.join(" ") : "Gespeichert.",
          result.warnings.length > 0 ? "error" : "success");
        await refresh();
      } catch (error) {
        toast(error.message, "error");
      }
    }
  },
  field("Ankündigungs-Channel", select(channelOptions(guild.channels.text), {
    name: "notifyChannelId", value: creators.notifyChannelId
  })),
  h("div.field-row", {},
    field("YouTube Ping-Rolle", select(roleOptions(guild.roles), { name: "youtubeRoleId", value: creators.youtubeRoleId })),
    field("Twitch Ping-Rolle", select(roleOptions(guild.roles), { name: "twitchRoleId", value: creators.twitchRoleId }))),
  field(`YouTube-Kanäle${creators.youtubeReady ? "" : " (YOUTUBE_API_KEY fehlt)"}`,
    h("textarea.input", {
      name: "youtube",
      value: creators.youtubeChannels.map((entry) =>
        `${entry.channelId}${entry.announceTemplate ? ` | ${entry.announceTemplate}` : ""}`).join("\n")
    }),
    "Eine Zeile je Kanal: Kanal-ID, @handle oder Link. Optional „| Ankündigungstext“."),
  field(`Twitch-Kanäle${creators.twitchReady ? "" : " (TWITCH_CLIENT_ID/SECRET fehlt)"}`,
    h("textarea.input", {
      name: "twitch",
      value: creators.twitchChannels.map((entry) =>
        `${entry.login}${entry.announceTemplate ? ` | ${entry.announceTemplate}` : ""}`).join("\n")
    }),
    "Eine Zeile je Streamer-Login. Optional „| Ankündigungstext“."),
  isAdmin ? h("div.row", {}, h("button.btn.btn-primary.btn-sm", { type: "submit" }, "Speichern")) : null);

  if (!isAdmin) {
    for (const control of form.querySelectorAll("input, select, textarea")) {
      control.disabled = true;
    }
  }

  return card("Content-Creator-Benachrichtigungen", form);
}

let branchPickerCount = 0;

/**
 * Branch-Eingabe mit Vorschlagsliste von GitHub. `load(value)` holt die
 * Branches zu dem, was gerade im zugehörigen Feld steht; `refresh(value)` wird
 * aufgerufen, sobald das feststeht (Fork oder Repo eingegeben).
 */
function branchPicker({ load, value = "", placeholder, idleHint }) {
  const listId = `branch-options-${++branchPickerCount}`;
  const list = h("datalist", { id: listId });
  const hint = h("span", {}, idleHint);
  const input = h("input.input", { name: "branch", list: listId, placeholder, value });

  let loadedFor = null;
  const refresh = async (source) => {
    const key = String(source ?? "").trim();
    if (key === loadedFor) {
      return;
    }

    loadedFor = key;
    clear(list);
    hint.textContent = "Lade Branches …";

    try {
      const result = await load(key);
      if (loadedFor !== key) {
        return;
      }

      list.append(...result.branches.map((name) =>
        h("option", { value: name, label: name === result.defaultBranch ? `${name} (Haupt-Branch)` : name })));
      hint.textContent = `${result.branches.length} Branch(es) in ${result.repo} – Haupt-Branch: ${result.defaultBranch}`;
    } catch (error) {
      if (loadedFor === key) {
        hint.textContent = error.message;
      }
    }
  };

  return { element: h("div", {}, field("Branch", input, hint), list), refresh };
}

function updatesReposCard(guildId, guild, repos, refresh) {
  const isAdmin = guild.accessLevel >= ACCESS.ADMIN;
  const slugOf = (entry) => `${entry.owner}/${entry.repo}`;

  const submit = async (action, message) => {
    await action();
    toast(message, "success");
    await refresh();
  };

  const addRepo = () => {
    const picker = branchPicker({
      load: (repo) => api.githubBranches(guildId, repo),
      placeholder: "leer = nur Releases bzw. Haupt-Branch",
      idleHint: "Optional: neue Commits auf diesem Branch zusätzlich zu Releases posten"
    });

    modal("Repo beobachten", h("div", {},
      field("Repo", h("input.input", {
        name: "repo",
        required: true,
        placeholder: "owner/repo oder GitHub-Link",
        onChange: (event) => event.target.value.trim() && picker.refresh(event.target.value)
      })),
      picker.element,
      field("Anzeigename", h("input.input", { name: "label", maxLength: 80 }), "Optional, erscheint im Titel der Posts")), {
      submitLabel: "Hinzufügen",
      onSubmit: (data) => submit(() => api.addUpdateRepo(guildId, data), "Repo gespeichert.")
    });
  };

  const editBranch = (entry) => {
    const picker = branchPicker({
      load: () => api.updateBranches(guildId, slugOf(entry)),
      value: entry.branch,
      placeholder: "leer = Standard (Releases bzw. Haupt-Branch)",
      idleHint: ""
    });

    modal(`Branch für ${slugOf(entry)}`, h("div", {},
      h("p.muted", { style: { fontSize: "13px" } },
        "Mit Branch werden Releases weiter gepostet und neue Commits auf dem Branch zusätzlich. "
        + "Ohne Branch: neue Releases, bei Repos ohne Releases Commits auf dem Haupt-Branch."),
      picker.element), {
      onSubmit: (data) => submit(
        () => api.setUpdateRepoBranch(guildId, slugOf(entry), data.branch),
        data.branch ? `Branch ${data.branch} wird beobachtet.` : "Zurück zum Standard.")
    });

    picker.refresh("");
  };

  const addFork = async (entry) => {
    const listId = `fork-candidates-${entry.owner}-${entry.repo}`.replace(/[^\w-]/g, "_");
    const candidates = h("datalist", { id: listId });
    const picker = branchPicker({
      load: (fork) => api.updateBranches(guildId, slugOf(entry), fork),
      placeholder: "leer = Haupt-Branch des Forks",
      idleHint: "Erst Fork wählen – dann stehen hier seine Branches zur Auswahl"
    });

    modal(`Fork zu ${slugOf(entry)} hinterlegen`, h("div", {},
      field("Fork", h("input.input", {
        name: "fork",
        required: true,
        list: listId,
        placeholder: "benutzer oder benutzer/repo",
        // Branches erst laden, wenn feststeht, welcher Fork gemeint ist.
        onChange: (event) => event.target.value.trim() && picker.refresh(event.target.value)
      }), "Gepostet werden nur Commits, die es im Original nicht gibt"),
      candidates,
      picker.element,
      field("Anzeigename", h("input.input", { name: "label", maxLength: 80 }))), {
      submitLabel: "Hinterlegen",
      onSubmit: (data) => submit(() => api.addUpdateFork(guildId, slugOf(entry), data), "Fork hinterlegt.")
    });

    // Vorschläge nachladen, der Dialog ist sofort bedienbar.
    const forks = await api.forkCandidates(guildId, slugOf(entry)).catch(() => []);
    candidates.append(...forks.map((fork) => h("option", { value: fork.slug })));
  };

  const rows = repos.flatMap((entry) => [
    [
      h("strong", {}, slugOf(entry)),
      entry.label || "–",
      entry.branch
        ? h("span.mono", { style: { fontSize: "12px" } }, entry.branch)
        : h("span.muted", {}, "Releases / Haupt-Branch"),
      isAdmin
        ? h("div.row", {},
          h("button.btn.btn-sm", { onClick: () => editBranch(entry) }, "Branch"),
          h("button.btn.btn-sm", { onClick: () => addFork(entry) }, "+ Fork"),
          h("button.btn.btn-sm.btn-danger", {
            onClick: async () => {
              if (confirmDialog(`${slugOf(entry)} samt Forks nicht mehr beobachten?`)) {
                await submit(() => api.removeUpdateRepo(guildId, slugOf(entry)), "Repo entfernt.");
              }
            }
          }, "Entfernen"))
        : "–"
    ],
    ...entry.forks.map((fork) => [
      h("span", { style: { paddingLeft: "18px" } }, `↳ ${fork.owner}/${fork.repo}`),
      fork.label || "–",
      h("span.mono", { style: { fontSize: "12px" } }, fork.branch),
      isAdmin
        ? h("button.btn.btn-sm.btn-danger", {
          onClick: () => submit(
            () => api.removeUpdateFork(guildId, slugOf(entry), `${fork.owner}/${fork.repo}@${fork.branch}`),
            "Fork entfernt.")
        }, "Entfernen")
        : "–"
    ])
  ]);

  return card(
    h("div.row-between", { style: { width: "100%" } },
      h("span", {}, "GitHub-Updates"),
      isAdmin ? h("button.btn.btn-sm.btn-primary", { onClick: addRepo }, "+ Repo") : null),
    h("p.muted", { style: { fontSize: "13px" } },
      "Neue Releases bzw. Commits landen im Updates-Channel. Je Repo lässt sich ein Branch wählen, dessen "
      + "Commits zusätzlich gepostet werden, und es lassen sich bestimmte Forks hinterlegen."),
    table(["Repo / Fork", "Anzeigename", "Branch", ""], rows, { empty: "Noch kein Repo hinterlegt." }));
}

export async function renderSettings({ guildId, guild }) {
  const container = h("div.stack");

  async function refresh() {
    clear(container).append(spinner());

    const [modules, departments, creators, updateRepos] = await Promise.all([
      api.modules(guildId),
      api.departments(guildId),
      api.get(`/api/guilds/${guildId}/creators`).catch(() => null),
      api.updateRepos(guildId).catch(() => null)
    ]);

    clear(container).append(
      h("div.page-header", {},
        h("h1", {}, "Einstellungen"),
        guild.accessLevel < ACCESS.ADMIN
          ? h("span.muted", {}, "Nur Lesezugriff – Änderungen benötigen „Server verwalten“.")
          : null),

      departmentsCard(guildId, guild, departments, refresh),

      h("div.grid.grid-2", {}, ...modules
        .filter((moduleInfo) => moduleInfo.name !== "dashboard" && moduleInfo.name !== "system")
        .map((moduleInfo) => moduleCard(guildId, guild, moduleInfo, refresh))),

      updateRepos ? updatesReposCard(guildId, guild, updateRepos, refresh) : null,
      creators ? creatorsCard(guildId, guild, creators, refresh) : null);
  }

  await refresh();
  return container;
}

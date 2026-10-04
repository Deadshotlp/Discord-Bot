// Minimaler DOM-Helfer statt Framework: h("div.card", {...}, children)
export function h(selector, props = {}, ...children) {
  const [tagAndId, ...classes] = String(selector).split(".");
  const [tag, id] = tagAndId.split("#");
  const element = document.createElement(tag || "div");

  if (id) {
    element.id = id;
  }

  if (classes.length > 0) {
    element.className = classes.join(" ");
  }

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) {
      continue;
    }

    if (key === "class") {
      element.className = `${element.className} ${value}`.trim();
    } else if (key === "style" && typeof value === "object") {
      Object.assign(element.style, value);
    } else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "html") {
      element.innerHTML = value;
    } else if (key in element && key !== "list") {
      element[key] = value;
    } else {
      element.setAttribute(key, value === true ? "" : value);
    }
  }

  appendChildren(element, children);
  return element;
}

function appendChildren(element, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) {
      continue;
    }

    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(element) {
  while (element.firstChild) {
    element.firstChild.remove();
  }

  return element;
}

export function icon(name) {
  return h("span.icon", { "aria-hidden": "true" }, name);
}

// --- Formatierung ----------------------------------------------------------

const dateFormatter = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
const dateTimeFormatter = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
});
const timeFormatter = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });

export function formatDate(value) {
  if (!value) {
    return "–";
  }

  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`)
    : new Date(Number(value) || value);

  return Number.isNaN(date.getTime()) ? "–" : dateFormatter.format(date);
}

export function formatDateTime(value) {
  if (!value) {
    return "–";
  }

  const date = new Date(Number(value) || value);
  return Number.isNaN(date.getTime()) ? "–" : dateTimeFormatter.format(date);
}

export function formatTime(value) {
  const date = new Date(Number(value) || value);
  return Number.isNaN(date.getTime()) ? "–" : timeFormatter.format(date);
}

export function formatRelative(value) {
  if (!value) {
    return "–";
  }

  const diff = Date.now() - Number(value);
  const minutes = Math.round(diff / 60000);

  if (Math.abs(minutes) < 1) {
    return "gerade eben";
  }

  if (Math.abs(minutes) < 60) {
    return minutes > 0 ? `vor ${minutes} min` : `in ${-minutes} min`;
  }

  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) {
    return hours > 0 ? `vor ${hours} h` : `in ${-hours} h`;
  }

  const days = Math.round(hours / 24);
  return days > 0 ? `vor ${days} Tagen` : `in ${-days} Tagen`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (hours >= 24) {
    return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  }

  if (hours > 0) {
    return `${hours} h ${minutes} min`;
  }

  return `${minutes} min`;
}

export function formatMs(ms) {
  return formatDuration(Math.round(Number(ms || 0) / 1000));
}

export function todayIso(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  // Bewusst lokal: toISOString() wäre UTC und zwischen 0 und 2 Uhr noch der Vortag.
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// --- Bausteine -------------------------------------------------------------

export function card(title, ...children) {
  return h("section.card", {},
    title ? h("h2.card-title", {}, title) : null,
    ...children);
}

export function stat(label, value, hint) {
  return h("div.stat", {},
    h("div.stat-value", {}, value),
    h("div.stat-label", {}, label),
    hint ? h("div.stat-hint", {}, hint) : null);
}

export function badge(text, tone = "neutral") {
  return h(`span.badge.badge-${tone}`, {}, text);
}

export function button(label, { onClick, tone = "ghost", type = "button", disabled = false } = {}) {
  return h(`button.btn.btn-${tone}`, { type, disabled, onClick });
}

export function field(label, control, hint) {
  return h("label.field", {},
    h("span.field-label", {}, label),
    control,
    hint ? h("span.field-hint", {}, hint) : null);
}

export function select(options, { value, onChange, name } = {}) {
  const element = h("select.input", { name, onChange });

  for (const option of options) {
    element.append(h("option", {
      value: option.value,
      selected: String(option.value) === String(value)
    }, option.label));
  }

  return element;
}

export function table(headers, rows, { empty = "Keine Einträge." } = {}) {
  if (rows.length === 0) {
    return h("p.muted", {}, empty);
  }

  return h("div.table-wrap", {},
    h("table.table", {},
      h("thead", {}, h("tr", {}, ...headers.map((header) => h("th", {}, header)))),
      h("tbody", {}, ...rows.map((cells) => h("tr", {}, ...cells.map((cell) => h("td", {}, cell)))))));
}

export function spinner(text = "Lade …") {
  return h("div.loading", {}, h("div.spinner"), h("span", {}, text));
}

let toastTimer = null;

export function toast(message, tone = "info") {
  let host = document.getElementById("toast");
  if (!host) {
    host = h("div#toast.toast");
    document.body.append(host);
  }

  host.className = `toast toast-${tone} visible`;
  host.textContent = message;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove("visible"), 4000);
}

export function confirmDialog(message) {
  return window.confirm(message);
}

export function modal(title, content, { onSubmit, submitLabel = "Speichern" } = {}) {
  const overlay = h("div.modal-overlay", {
    onClick: (event) => {
      if (event.target === overlay) {
        overlay.remove();
      }
    }
  });

  const form = h("form.modal", {
    onSubmit: async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());

      try {
        await onSubmit?.(data, form);
        overlay.remove();
      } catch (error) {
        toast(error.message, "error");
      }
    }
  },
  h("h2.modal-title", {}, title),
  h("div.modal-body", {}, content),
  h("div.modal-actions", {},
    h("button.btn.btn-ghost", { type: "button", onClick: () => overlay.remove() }, "Abbrechen"),
    h("button.btn.btn-primary", { type: "submit" }, submitLabel)));

  overlay.append(form);
  document.body.append(overlay);
  form.querySelector("input, select, textarea")?.focus();
  return overlay;
}

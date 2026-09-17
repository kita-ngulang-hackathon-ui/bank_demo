/** Browser-side helpers. No ADA credentials live here - the browser only ever
 *  talks to bank_demo's own API, which does the ADA call server side. */

export function makeApi(base) {
  async function request(path, { method = "GET", body } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const err = new Error(data?.message ?? `Request failed (${response.status})`);
      err.status = response.status;
      err.code = data?.error;
      throw err;
    }
    return data;
  }

  return {
    get: (path) => request(path),
    post: (path, body) => request(path, { method: "POST", body }),
    del: (path) => request(path, { method: "DELETE" }),
  };
}

export const idr = (value) =>
  new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(value ?? 0)
  );

export const idrPlain = (value) => new Intl.NumberFormat("id-ID").format(Number(value ?? 0));

export const timeShort = (iso) =>
  new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

export const dateLong = (iso) =>
  new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });

export const initials = (name) =>
  String(name ?? "")
    .split(" ")
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

/** Escapes text before it goes into innerHTML. Demo data is ours, but a
 *  transfer note is free text and this costs nothing. */
export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );

export function parseAmount(input) {
  const digits = String(input ?? "").replace(/[^\d]/g, "");
  return digits ? Number.parseInt(digits, 10) : 0;
}

/** Live thousand-separator formatting for amount inputs. */
export function attachAmountMask(input) {
  input.addEventListener("input", () => {
    const value = parseAmount(input.value);
    input.value = value ? idrPlain(value) : "";
  });
}

export function toast(message, tone = "info") {
  let host = document.querySelector(".toast-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast toast--${tone}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast--out");
    setTimeout(() => el.remove(), 350);
  }, 3200);
}

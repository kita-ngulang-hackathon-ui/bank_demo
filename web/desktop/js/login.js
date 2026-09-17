import { makeApi, esc, initials, toast } from "/shared/js/api.js";

const api = makeApi("/api/desktop");
const demoApi = makeApi("/api/demo");

const form = document.querySelector("#loginForm");
const errorBox = document.querySelector("#loginError");
const usernameInput = document.querySelector("#username");
const pinInput = document.querySelector("#pin");
const submitButton = document.querySelector("#loginSubmit");

/** Already signed in on this surface? Skip the form. */
api.get("/session").then(() => { window.location.href = "/app.html"; }).catch(() => {});

/** The portal redirects here with ?expired=1 after an idle logout. */
if (new URLSearchParams(window.location.search).has("expired")) {
  errorBox.textContent = "Sesi Anda berakhir karena tidak ada aktivitas. Silakan masuk kembali.";
  errorBox.classList.add("is-visible");
}

demoApi
  .get("/config")
  .then(({ brand, demo }) => {
    document.title = `Internet Banking — ${brand.bankName}`;
    if (!brand.showDemoBanner) document.querySelector("#demoBanner").remove();
    document.querySelector(".promo__copy h1").innerHTML =
      `Internet Banking<br />${esc(brand.bankName)}`;
    document.querySelector(".footer-note").textContent =
      `bank_demo — client surface for ADA Solutions (${demo.tenantSlug}) at ${demo.adaBaseUrl}. Placeholder branding.`;
  })
  .catch(() => {});

demoApi
  .get("/users")
  .then(({ items }) => {
    const host = document.querySelector("#demoUsers");
    host.innerHTML = items
      .map(
        (user) => `
        <button type="button" data-username="${esc(user.username)}">
          <span class="avatar" style="background:${esc(user.avatarColor)}">${esc(initials(user.name))}</span>
          <span>
            <strong>${esc(user.name)}</strong><br />
            <span class="muted">${esc(user.username)} · ${esc(user.attributes.segment)}</span>
          </span>
        </button>`
      )
      .join("");

    host.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-username]");
      if (!button) return;
      usernameInput.value = button.dataset.username;
      pinInput.value = "123456";
      form.requestSubmit();
    });
  })
  .catch(() => {});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.classList.remove("is-visible");
  submitButton.disabled = true;
  submitButton.textContent = "Memproses...";

  try {
    // The session-open event goes to ADA from the server during this call.
    await api.post("/session", {
      username: usernameInput.value.trim().toLowerCase(),
      pin: pinInput.value.trim(),
    });
    window.location.href = "/app.html";
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.add("is-visible");
    toast(err.message, "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Masuk";
  }
});

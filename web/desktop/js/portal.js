import {
  makeApi,
  idr,
  idrPlain,
  esc,
  initials,
  timeShort,
  dateLong,
  parseAmount,
  attachAmountMask,
  toast,
} from "/shared/js/api.js";

const api = makeApi("/api/desktop");
const demoApi = makeApi("/api/demo");

let state = {
  user: null,
  balances: {},
  transactions: [],
  splits: [],
  offers: [],
  contacts: [],
  favourites: [],
  schedules: [],
  billers: [],
  merchants: [],
  catalog: { banks: [], networks: [], pulsa: [], tokenDenoms: [], ewallets: [], frequencies: [] },
  loginActivity: [],
  session: { remainingMs: 0, idleTimeoutMs: 900000 },
  wire: [],
};

let brand = { bankName: "Bank Demo Nusantara", mobileAppName: "wndr" };

// ============================================================ navigation ===

document.querySelectorAll(".rail__item").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

function showView(name) {
  document.querySelectorAll(".rail__item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${name}`));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "statement") loadStatement();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
    document
      .querySelectorAll(".tab-body")
      .forEach((body) => body.classList.toggle("is-active", body.id === `tab-${tab.dataset.tab}`));
  });
});

document.querySelector("#logoutButton").addEventListener("click", logout);

async function logout() {
  await api.del("/session").catch(() => {});
  window.location.href = "/";
}

// ================================================================ modals ===

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => closeModal(button.dataset.close));
});

const openModal = (id) => document.querySelector(`#${id}`).classList.add("is-open");
const closeModal = (id) => document.querySelector(`#${id}`).classList.remove("is-open");

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  ["confirmModal", "receiptModal"].forEach(closeModal);
});

// ============================================ two-step transaction flow ====

/** The pending challenge: what we prepared, and how to describe the result. */
let challenge = null;
let tokenTimer = null;

/**
 * Step 1 of every money movement on this surface. Nothing has moved yet and
 * nothing has reached ADA - `/tx/prepare` only prices the transaction and
 * issues a token challenge.
 */
async function prepare(kind, request, { receiptTitle } = {}) {
  try {
    const prepared = await api.post("/tx/prepare", { kind, request });
    challenge = { ...prepared, kind, receiptTitle };
    renderChallenge();
    openModal("confirmModal");
  } catch (err) {
    handleApiError(err);
  }
}

function renderChallenge() {
  document.querySelector("#confirmTitle").textContent = challenge.summary.title;
  document.querySelector("#confirmList").innerHTML = challenge.summary.lines
    .map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`)
    .join("");
  document.querySelector("#challengeNumber").textContent = challenge.challengeNumber;

  const codeEl = document.querySelector("#tokenCode");
  if (challenge.token) {
    codeEl.textContent = challenge.token;
  } else {
    codeEl.textContent = "••••••";
    document.querySelector("#tokenDevice").title = "DEMO_SHOW_TOKEN=false — kode tidak ditampilkan";
  }

  const input = document.querySelector("#tokenInput");
  input.value = "";
  input.focus();
  startTokenCountdown();
}

function startTokenCountdown() {
  clearInterval(tokenTimer);
  const countdown = document.querySelector("#tokenCountdown");
  const render = () => {
    const remaining = Math.max(0, Date.parse(challenge.expiresAt) - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    countdown.textContent = `Berlaku ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    countdown.classList.toggle("is-urgent", seconds <= 30);
    if (remaining === 0) {
      clearInterval(tokenTimer);
      closeModal("confirmModal");
      toast("Kode konfirmasi kedaluwarsa. Ulangi transaksi.", "error");
    }
  };
  render();
  tokenTimer = setInterval(render, 1000);
}

document.querySelector("#tokenInput").addEventListener("input", (event) => {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
});

document.querySelector("#confirmSubmit").addEventListener("click", async (event) => {
  if (!challenge) return;
  const token = document.querySelector("#tokenInput").value.trim();
  if (token.length !== 6) return toast("Masukkan 6 digit kode token.", "error");

  event.target.disabled = true;
  try {
    const result = await api.post("/tx/confirm", { challengeId: challenge.challengeId, token });
    clearInterval(tokenTimer);
    closeModal("confirmModal");
    showReceipt(result, challenge);
    clearForm(challenge.kind);
    challenge = null;
    await refresh();
  } catch (err) {
    // A wrong code keeps the dialog open so the user can retry.
    if (err.code === "BAD_TOKEN") {
      toast(err.message, "error");
    } else {
      clearInterval(tokenTimer);
      closeModal("confirmModal");
      handleApiError(err);
    }
  } finally {
    event.target.disabled = false;
  }
});

/** Empties the amount fields of whichever form was just submitted, so a
 *  second transaction does not inherit the first one's numbers. */
function clearForm(kind) {
  const clear = (selector) => {
    const el = document.querySelector(selector);
    if (el) el.value = "";
  };
  if (kind === "transfer") {
    clear("#transferAmount");
    clear("#transferNote");
  }
  if (kind === "transferInterbank") {
    clear("#ibAmount");
    clear("#ibNote");
  }
  if (kind === "ewallet") clear("#ewAmount");
  if (kind === "topup") clear("#topupAmount");
  if (kind === "withdraw") clear("#withdrawAmount");
  if (kind === "pulsa") clear("#pulsaMsisdn");
  if (kind === "split") {
    selectedParticipants.clear();
    document.querySelector("#splitForm").reset();
    document.querySelectorAll("#splitParticipants .chip").forEach((chip) => chip.classList.remove("is-active"));
  }
}

// =============================================================== receipt ===

const KIND_TITLES = {
  transfer: "Transfer Antar Rekening",
  transferInterbank: "Transfer Antar Bank",
  bill: "Pembayaran Tagihan",
  pulsa: "Pembelian Pulsa",
  token: "Pembelian Token Listrik",
  ewallet: "Top Up e-Wallet",
  topup: "Top Up Saldo",
  withdraw: "Tarik Tunai Tanpa Kartu",
  split: "Split Bill",
  splitSettle: "Pembayaran Share Split Bill",
  qr: "Pembayaran Merchant",
};

function showReceipt({ receipt, kind, tracked }, context = {}) {
  const rows = [];
  const push = (label, value) => {
    if (value !== undefined && value !== null && value !== "") rows.push([label, value]);
  };

  push("Nomor Referensi", receipt.reference);
  push("Waktu", `${dateLong(receipt.at ?? receipt.createdAt)} ${timeShort(receipt.at ?? receipt.createdAt)} WIB`);
  push("Jenis Transaksi", KIND_TITLES[kind] ?? kind);

  if (receipt.recipient) push("Rekening Tujuan", `${receipt.recipient.name} — ${receipt.recipient.accountNumber}`);
  if (receipt.bank) push("Bank Tujuan", receipt.bank.name);
  if (receipt.accountNumber && receipt.beneficiaryName) {
    push("Rekening Tujuan", `${receipt.accountNumber} — ${receipt.beneficiaryName}`);
  }
  if (receipt.network) push("Jenis Transfer", `${receipt.network.name} (${receipt.network.sla})`);
  if (receipt.biller) push("Penyedia", receipt.biller.name);
  if (receipt.product) push("Provider", receipt.product.provider);
  if (receipt.msisdn) push("Nomor Handphone", receipt.msisdn);
  if (receipt.meterNumber) push("ID Pelanggan", receipt.meterNumber);
  if (receipt.token) push("Nomor Token", receipt.token);
  if (receipt.wallet) push("e-Wallet", receipt.wallet.name);
  if (receipt.merchant) push("Merchant", receipt.merchant.name);
  if (receipt.code) push("Kode Tarik Tunai", receipt.code);
  if (receipt.title && receipt.participants) {
    push("Judul", receipt.title);
    push("Total Tagihan", idr(receipt.total));
    push("Per Orang", idr(receipt.share));
    push("Peserta", String(receipt.participants.length));
  }

  if (receipt.amount) push("Nominal", idr(receipt.amount));
  if (receipt.fee) push("Biaya", idr(receipt.fee));
  if (receipt.total && !receipt.participants) push("Total Debet", idr(receipt.total));
  if (receipt.note) push("Berita", receipt.note);
  if (receipt.balances?.checking !== undefined) push("Saldo Akhir", idr(receipt.balances.checking));

  const sent = Array.isArray(tracked) ? tracked.every((t) => t?.sent) : tracked?.sent;
  const eventCount = Array.isArray(tracked) ? tracked.length : 1;

  document.querySelector("#receiptBody").innerHTML = `
    <div class="receipt-doc">
      <div class="receipt-doc__head">
        <img src="/shared/assets/logo.svg" alt="${esc(brand.bankName)}" />
        <div>
          ${esc(brand.bankName)}<br />
          Internet Banking Personal
        </div>
      </div>
      <div class="receipt-doc__status">✓ Transaksi Berhasil</div>
      <dl>
        ${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("")}
      </dl>
      <div class="receipt-doc__foot">
        Bukti ini sah tanpa tanda tangan. Simpan nomor referensi untuk keperluan konfirmasi.<br />
        Integrasi ADA: ${eventCount} event dikirim via direct API —
        status ${sent ? "terkirim" : "gagal, lihat log event"}.
      </div>
    </div>`;

  openModal("receiptModal");
}

document.querySelector("#printReceipt").addEventListener("click", () => window.print());

// ========================================================= session timer ===

let sessionDeadline = Date.now() + 15 * 60 * 1000;
let sessionWarningShown = false;

function setSessionRemaining(ms) {
  sessionDeadline = Date.now() + ms;
  if (ms > 60_000) {
    sessionWarningShown = false;
    closeModal("sessionModal");
  }
}

function renderSessionTimer() {
  const remaining = Math.max(0, sessionDeadline - Date.now());
  const seconds = Math.floor(remaining / 1000);
  const label = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  document.querySelector("#sessionRemaining").textContent = label;
  document.querySelector("#sessionTimer").classList.toggle("is-warning", remaining <= 120_000);

  if (remaining <= 60_000 && remaining > 0 && !sessionWarningShown) {
    sessionWarningShown = true;
    openModal("sessionModal");
  }
  if (sessionWarningShown) document.querySelector("#sessionCountdown").textContent = String(seconds);
  if (remaining === 0) {
    closeModal("sessionModal");
    window.location.href = "/?expired=1";
  }
}
setInterval(renderSessionTimer, 1000);

document.querySelector("#sessionExtend").addEventListener("click", async () => {
  try {
    const { remainingMs } = await api.post("/session/extend");
    setSessionRemaining(remainingMs);
    closeModal("sessionModal");
    toast("Sesi diperpanjang.", "success");
  } catch (err) {
    handleApiError(err);
  }
});

document.querySelector("#sessionLogout").addEventListener("click", logout);

// ================================================================= data ====

function handleApiError(err) {
  if (err.status === 401) {
    window.location.href = err.code === "SESSION_EXPIRED" ? "/?expired=1" : "/";
    return;
  }
  toast(err.message, "error");
}

async function refresh() {
  try {
    state = await api.get("/home");
  } catch (err) {
    handleApiError(err);
    return;
  }
  setSessionRemaining(state.session.remainingMs);
  renderHeader();
  renderAccounts();
  renderTransactions();
  renderSplits();
  renderOffers();
  renderWire();
  renderFavourites();
  renderSchedules();
  renderActivity();
  fillPickers();
}

function renderHeader() {
  document.querySelector("#userName").textContent = state.user.name;
  document.querySelector("#userMeta").textContent =
    `${state.user.accountNumber} · ${state.user.attributes.region} · ${state.user.attributes.segment}`;
}

function renderAccounts() {
  document.querySelector("#accountHint").textContent = `Diperbarui ${timeShort(new Date().toISOString())} WIB`;
  document.querySelector("#accountCards").innerHTML = `
    <div class="acct__card">
      <div class="acct__label">Taplus — Rekening Utama</div>
      <div class="acct__no">${esc(state.user.accountNumber)}</div>
      <div class="acct__amount">${idr(state.balances.checking)}</div>
    </div>
    <div class="acct__card acct__card--orange">
      <div class="acct__label">Tabungan Berjangka</div>
      <div class="acct__no">•••• ${esc(state.user.cardLast4)}</div>
      <div class="acct__amount">${idr(state.balances.savings)}</div>
    </div>`;

  document.querySelector("#balanceHint").textContent = `Per ${dateLong(new Date().toISOString())}`;
  document.querySelector("#balanceTable").innerHTML = `
    <thead><tr><th>Jenis Rekening</th><th>Nomor</th><th>Mata Uang</th><th style="text-align:right">Saldo Efektif</th></tr></thead>
    <tbody>
      <tr>
        <td>Taplus (Rekening Utama)</td><td>${esc(state.user.accountNumber)}</td><td>IDR</td>
        <td style="text-align:right"><b>${idr(state.balances.checking)}</b></td>
      </tr>
      <tr>
        <td>Tabungan Berjangka</td><td>${esc(state.user.accountNumber)}-02</td><td>IDR</td>
        <td style="text-align:right"><b>${idr(state.balances.savings)}</b></td>
      </tr>
    </tbody>`;

  document.querySelector("#cardInfo").innerHTML = `
    <div class="receipt">
      <dl>
        <dt>Nama pada kartu</dt><dd>${esc(state.user.name.toUpperCase())}</dd>
        <dt>Nomor kartu</dt><dd>•••• •••• •••• ${esc(state.user.cardLast4)}</dd>
        <dt>Jenis</dt><dd>Debit GPN</dd>
        <dt>Status</dt><dd>Aktif</dd>
        <dt>Circle transaksi</dt><dd>${esc(state.user.circle)}</dd>
      </dl>
    </div>`;
}

const LABELS = {
  TRANSFER_OUT: "Transfer keluar",
  TRANSFER_IN: "Transfer masuk",
  TRANSFER_INTERBANK: "Transfer antar bank",
  SPLIT_CREATED: "Split bill dibuat",
  SPLIT_SETTLED: "Bayar share",
  SPLIT_RECEIVED: "Terima share",
  BILL_PAYMENT: "Pembayaran tagihan",
  TOPUP: "Top up",
  EWALLET_TOPUP: "Top up e-wallet",
  PULSA_PURCHASE: "Pembelian pulsa",
  PLN_TOKEN: "Token listrik",
  QR_PAYMENT: "Pembayaran QRIS",
  WITHDRAWAL: "Tarik tunai",
};
const labelFor = (kind) => LABELS[kind] ?? kind;

function txRows(list) {
  if (!list.length) return `<tbody><tr><td class="empty">Belum ada transaksi.</td></tr></tbody>`;
  return `
    <thead><tr><th>Waktu</th><th>Referensi</th><th>Jenis</th><th>Keterangan</th><th style="text-align:right">Nominal</th></tr></thead>
    <tbody>
      ${list
        .map(
          (tx) => `
        <tr>
          <td class="muted">${dateLong(tx.at)}<br /><span class="muted">${timeShort(tx.at)}</span></td>
          <td class="muted">${esc(tx.reference ?? "-")}</td>
          <td>${esc(labelFor(tx.kind))}</td>
          <td>${esc(tx.counterpartyName ?? "-")}<br /><span class="muted">${esc(tx.note ?? "")}</span></td>
          <td style="text-align:right" class="${tx.direction === "credit" ? "amount-credit" : tx.direction === "debit" ? "amount-debit" : "muted"}">
            ${tx.direction === "credit" ? "+" : tx.direction === "debit" ? "−" : ""} ${idr(tx.amount)}
            ${tx.fee ? `<br /><span class="muted" style="font-weight:400">biaya ${idr(tx.fee)}</span>` : ""}
          </td>
        </tr>`
        )
        .join("")}
    </tbody>`;
}

function renderTransactions() {
  document.querySelector("#homeTx").innerHTML = txRows(state.transactions.slice(0, 8));
  document.querySelector("#homeTxHint").textContent = `${state.transactions.length} transaksi`;
}

function renderSplits() {
  const host = document.querySelector("#splitList");
  if (!state.splits.length) {
    host.innerHTML = `<div class="empty">Belum ada split bill.</div>`;
    return;
  }
  host.innerHTML = state.splits
    .map((split) => {
      const mine = split.participants.find((p) => p.ref === state.user.ref);
      const settled = split.participants.filter((p) => p.settled).length;
      return `
        <div class="receipt" style="margin-bottom:12px">
          <dl>
            <dt>Judul</dt><dd>${esc(split.title)}</dd>
            <dt>Total</dt><dd>${idr(split.total)}</dd>
            <dt>Per orang</dt><dd>${idr(split.share)}</dd>
            <dt>Status</dt><dd>${settled}/${split.participants.length} sudah bayar</dd>
          </dl>
          ${
            mine && !mine.settled
              ? `<button class="btn btn--primary" style="margin-top:12px" data-settle="${esc(split.id)}">Bayar share saya (${idr(mine.share)})</button>`
              : ""
          }
        </div>`;
    })
    .join("");

  host.querySelectorAll("[data-settle]").forEach((button) => {
    button.addEventListener("click", () => prepare("splitSettle", { splitId: button.dataset.settle }));
  });
}

function offerCard(offer) {
  return `
    <div class="offer">
      <div class="offer__body">
        <span class="offer__tag">${esc(offer.incentiveCode)}</span>
        <div class="offer__title">${esc(offer.copy.title)}</div>
        <div>${esc(offer.copy.body)}</div>
        ${offer.reasonText ? `<div class="offer__reason">Alasan ADA: ${esc(offer.reasonText)}</div>` : ""}
        <div class="offer__reason">
          Biaya insentif ${idr(offer.costIdr)} · subjek ${esc(offer.subjectType)}
          ${offer.targetUserRef ? "· ditujukan untuk Anda" : "· kotak bersama"}
        </div>
      </div>
      <button class="btn btn--primary" data-claim="${esc(offer.recommendationId)}">${esc(offer.copy.cta)}</button>
    </div>`;
}

function renderOffers() {
  const list = document.querySelector("#offersList");
  const homeCard = document.querySelector("#homeOffersCard");
  const homeHost = document.querySelector("#homeOffers");
  const badge = document.querySelector("#offerBadge");

  badge.hidden = state.offers.length === 0;
  badge.textContent = String(state.offers.length);

  if (!state.offers.length) {
    list.innerHTML = `<div class="empty">Belum ada rekomendasi yang disetujui. Jalankan pipeline ADA lalu setujui di console.</div>`;
    homeCard.hidden = true;
    return;
  }

  list.innerHTML = state.offers.map(offerCard).join("");
  homeHost.innerHTML = state.offers.slice(0, 2).map(offerCard).join("");
  homeCard.hidden = false;

  document.querySelectorAll("[data-claim]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api.post(`/offers/${button.dataset.claim}/claim`);
        toast("Penawaran diklaim.", "success");
      } catch (err) {
        handleApiError(err);
      } finally {
        button.disabled = false;
      }
    });
  });
}

function wireHtml(rows) {
  if (!rows.length) return `<div class="empty">Belum ada event terkirim.</div>`;
  return rows
    .map(
      (row) => `
      <div class="wire__row">
        <span class="muted">${timeShort(row.at)}</span>
        <span class="status status--${esc(row.status)}">${esc(row.status)}</span>
        <span>${esc(row.eventType)}</span>
        <span class="muted">${esc(row.error ?? row.clientEventId ?? "")}</span>
      </div>`
    )
    .join("");
}

function renderWire() {
  document.querySelector("#wireFeed").innerHTML = wireHtml(state.wire);
  document.querySelector("#wireFeedFull").innerHTML = wireHtml(state.wire);
}

function renderActivity() {
  const rows = state.loginActivity ?? [];
  document.querySelector("#activityTable").innerHTML = rows.length
    ? `
      <thead><tr><th>Waktu</th><th>Kanal</th><th>Alamat IP</th><th>Perangkat</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (row) => `
          <tr>
            <td>${dateLong(row.at)} ${timeShort(row.at)}</td>
            <td>${esc(row.surface === "desktop" ? "Internet Banking" : "Mobile App")}</td>
            <td class="muted">${esc(row.ip ?? "-")}</td>
            <td class="muted">${esc((row.userAgent ?? "").slice(0, 60))}</td>
          </tr>`
          )
          .join("")}
      </tbody>`
    : `<tbody><tr><td class="empty">Belum ada aktivitas login.</td></tr></tbody>`;
}

function renderFavourites() {
  const rows = state.favourites ?? [];
  const html = rows.length
    ? rows
        .map(
          (fav) => `
        <div class="row-item">
          <span class="avatar" style="background:${esc(colourFor(fav))}">${esc(initials(fav.beneficiaryName))}</span>
          <div class="row-item__body">
            <b>${esc(fav.alias)}</b>
            <small>${esc(fav.accountNumber)} · ${esc(fav.bankName ?? brand.bankName)}</small>
          </div>
          <div class="row-item__actions">
            ${fav.targetRef ? `<button class="btn btn--ghost btn--sm" data-fav-use="${esc(fav.targetRef)}">Transfer</button>` : ""}
            <button class="btn btn--danger btn--sm" data-fav-del="${esc(fav.id)}">Hapus</button>
          </div>
        </div>`
        )
        .join("")
    : `<div class="empty">Belum ada rekening favorit.</div>`;

  document.querySelector("#favouriteList").innerHTML = html;
  document.querySelector("#favouriteQuickList").innerHTML = html;

  document.querySelectorAll("[data-fav-del]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api.del(`/favourites/${button.dataset.favDel}`);
        toast("Rekening favorit dihapus.");
        await refresh();
      } catch (err) {
        handleApiError(err);
      }
    });
  });

  document.querySelectorAll("[data-fav-use]").forEach((button) => {
    button.addEventListener("click", () => {
      showView("tf-internal");
      document.querySelector("#transferRecipient").value = button.dataset.favUse;
      document.querySelector("#transferAmount").focus();
    });
  });
}

const colourFor = (fav) => {
  const contact = state.contacts.find((c) => c.ref === fav.targetRef);
  return contact?.avatarColor ?? "#00787a";
};

function renderSchedules() {
  const rows = state.schedules ?? [];
  document.querySelector("#scheduleList").innerHTML = rows.length
    ? rows
        .map(
          (row) => `
        <div class="row-item">
          <div class="row-item__body">
            <b>${esc(row.recipientName)} — ${idr(row.amount)}</b>
            <small>
              ${esc(row.frequencyName)} · berikutnya ${dateLong(row.nextRunAt)} ·
              ${row.runCount} kali dijalankan${row.lastRunAt ? ` · terakhir ${dateLong(row.lastRunAt)}` : ""}
            </small>
          </div>
          <div class="row-item__actions">
            <span class="pill-status pill-status--${esc(row.status)}">${esc(row.status)}</span>
            ${row.status === "ACTIVE" ? `<button class="btn btn--ghost btn--sm" data-sch-run="${esc(row.id)}">Jalankan sekarang</button>` : ""}
            ${row.status === "ACTIVE" ? `<button class="btn btn--danger btn--sm" data-sch-del="${esc(row.id)}">Batalkan</button>` : ""}
          </div>
        </div>`
        )
        .join("")
    : `<div class="empty">Belum ada transfer terjadwal.</div>`;

  document.querySelectorAll("[data-sch-run]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const result = await api.post(`/schedules/${button.dataset.schRun}/run`);
        showReceipt({ ...result, kind: "transfer" });
        toast("Jadwal dijalankan.", "success");
        await refresh();
      } catch (err) {
        handleApiError(err);
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll("[data-sch-del]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api.del(`/schedules/${button.dataset.schDel}`);
        toast("Jadwal dibatalkan.");
        await refresh();
      } catch (err) {
        handleApiError(err);
      }
    });
  });
}

// ============================================================== pickers ====

function fillPickers() {
  const transferOptions = [
    ...state.contacts.map((c) => ({ ref: c.ref, label: `${c.name} — ${c.accountNumber}` })),
    ...state.favourites
      .filter((f) => f.targetRef && !state.contacts.some((c) => c.ref === f.targetRef))
      .map((f) => ({ ref: f.targetRef, label: `${f.alias} — ${f.accountNumber}` })),
  ];

  setOptions("#transferRecipient", transferOptions.map((o) => [o.ref, o.label]));
  setOptions("#schRecipient", transferOptions.map((o) => [o.ref, o.label]));
  setOptions(
    "#favUser",
    state.contacts.map((c) => [c.ref, `${c.name} — ${c.accountNumber}`])
  );

  // Rebuilt on every refresh, so the current selection is re-applied rather
  // than silently lost mid-form.
  document.querySelector("#splitParticipants").innerHTML = state.contacts
    .map(
      (c) =>
        `<button type="button" class="chip${selectedParticipants.has(c.ref) ? " is-active" : ""}" data-ref="${esc(c.ref)}">${esc(initials(c.name))} ${esc(c.name)}</button>`
    )
    .join("");

  setOptions(
    "#billPayee",
    state.billers.map((b) => [b.ref, `${b.name} — ${b.category}`]),
    (option, biller) => option.setAttribute("data-amount", biller.defaultAmount),
    state.billers
  );
  syncBillAmount();

  setOptions(
    "#ibBank",
    state.catalog.banks.map((b) => [b.code, `${b.name} (${b.code})`])
  );
  setOptions(
    "#ibNetwork",
    state.catalog.networks.map((n) => [n.code, `${n.name} — biaya ${idrPlain(n.fee)}`])
  );
  syncNetworkNotice();

  setOptions(
    "#pulsaProvider",
    state.catalog.pulsa.map((p) => [p.ref, p.provider])
  );
  renderPulsaDenoms();

  renderTokenDenoms();

  setOptions(
    "#ewWallet",
    state.catalog.ewallets.map((w) => [w.ref, w.name])
  );

  setOptions(
    "#schFrequency",
    state.catalog.frequencies.map((f) => [f.code, f.name])
  );

  const startInput = document.querySelector("#schStart");
  if (!startInput.value) startInput.value = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

/** Keeps the current selection when the option list is rebuilt on refresh. */
function setOptions(selector, pairs, decorate, sourceList) {
  const select = document.querySelector(selector);
  const previous = select.value;
  select.innerHTML = pairs.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
  if (decorate && sourceList) {
    [...select.options].forEach((option, index) => decorate(option, sourceList[index]));
  }
  if (previous && pairs.some(([value]) => value === previous)) select.value = previous;
}

/** Rebuilds only when the list actually changed, so the background refresh
 *  does not wipe the amount the user just picked. */
function renderDenoms(hostSelector, amounts) {
  const host = document.querySelector(hostSelector);
  const signature = amounts.join(",");
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  host.innerHTML = amounts
    .map((amount) => `<button type="button" class="denom" data-amount="${amount}">${idrPlain(amount)}</button>`)
    .join("");
}

function renderPulsaDenoms() {
  const product = state.catalog.pulsa.find((p) => p.ref === document.querySelector("#pulsaProvider").value);
  renderDenoms("#pulsaDenoms", product?.denominations ?? []);
}

function renderTokenDenoms() {
  renderDenoms("#tokenDenoms", state.catalog.tokenDenoms ?? []);
}

/** Single-select denomination grids. Returns the chosen amount. */
function denomGroup(hostSelector) {
  const host = document.querySelector(hostSelector);
  let selected = null;
  host.addEventListener("click", (event) => {
    const button = event.target.closest("[data-amount]");
    if (!button) return;
    selected = Number(button.dataset.amount);
    host.querySelectorAll(".denom").forEach((d) => d.classList.toggle("is-active", d === button));
  });
  return () => selected;
}

const pulsaAmount = denomGroup("#pulsaDenoms");
const tokenAmount = denomGroup("#tokenDenoms");

// ============================================================== actions ====

["#transferAmount", "#splitTotal", "#billAmount", "#topupAmount", "#withdrawAmount", "#ibAmount", "#ewAmount", "#schAmount"].forEach(
  (selector) => attachAmountMask(document.querySelector(selector))
);

const QUICK_AMOUNTS = [50_000, 100_000, 250_000, 500_000, 1_000_000];

function quickChips(hostSelector, targetSelector) {
  const host = document.querySelector(hostSelector);
  host.innerHTML = QUICK_AMOUNTS.map((a) => `<button type="button" class="chip" data-amount="${a}">${idrPlain(a)}</button>`).join("");
  host.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-amount]");
    if (!chip) return;
    document.querySelector(targetSelector).value = idrPlain(Number(chip.dataset.amount));
  });
}
quickChips("#transferChips", "#transferAmount");
quickChips("#topupChips", "#topupAmount");
quickChips("#ewChips", "#ewAmount");

// -- internal transfer ------------------------------------------------------

document.querySelector("#transferForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const recipientRef = document.querySelector("#transferRecipient").value;
  const amount = parseAmount(document.querySelector("#transferAmount").value);
  const note = document.querySelector("#transferNote").value.trim();

  if (document.querySelector("#transferSaveFav").checked) {
    await api.post("/favourites", { userRef: recipientRef }).catch(() => {});
    document.querySelector("#transferSaveFav").checked = false;
  }
  prepare("transfer", { recipientRef, amount, note });
});

// -- interbank transfer -----------------------------------------------------

document.querySelector("#ibNetwork").addEventListener("change", syncNetworkNotice);

function syncNetworkNotice() {
  const select = document.querySelector("#ibNetwork");
  const network = state.catalog.networks.find((n) => n.code === select.value);
  if (!network) return;
  document.querySelector("#networkHint").textContent = `${network.name} · ${network.sla}`;
  document.querySelector("#ibFeeNotice").innerHTML = `
    Biaya <b>${idr(network.fee)}</b> per transaksi · limit ${idr(network.limit)}
    ${network.minAmount ? `· minimum ${idr(network.minAmount)}` : ""} · ${esc(network.sla)}`;
}

document.querySelector("#interbankForm").addEventListener("submit", (event) => {
  event.preventDefault();
  prepare("transferInterbank", {
    bankCode: document.querySelector("#ibBank").value,
    accountNumber: document.querySelector("#ibAccount").value.trim(),
    beneficiaryName: document.querySelector("#ibName").value.trim(),
    networkCode: document.querySelector("#ibNetwork").value,
    amount: parseAmount(document.querySelector("#ibAmount").value),
    note: document.querySelector("#ibNote").value.trim(),
  });
});

// -- favourites -------------------------------------------------------------

document.querySelector("#favouriteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api.post("/favourites", {
      userRef: document.querySelector("#favUser").value,
      alias: document.querySelector("#favAlias").value.trim(),
    });
    document.querySelector("#favAlias").value = "";
    toast("Rekening favorit disimpan.", "success");
    await refresh();
  } catch (err) {
    handleApiError(err);
  }
});

// -- schedules --------------------------------------------------------------

document.querySelector("#scheduleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api.post("/schedules", {
      recipientRef: document.querySelector("#schRecipient").value,
      amount: parseAmount(document.querySelector("#schAmount").value),
      frequency: document.querySelector("#schFrequency").value,
      startDate: document.querySelector("#schStart").value,
      note: document.querySelector("#schNote").value.trim(),
    });
    document.querySelector("#schAmount").value = "";
    toast("Jadwal transfer disimpan.", "success");
    await refresh();
  } catch (err) {
    handleApiError(err);
  }
});

// -- split ------------------------------------------------------------------

const selectedParticipants = new Set();
document.querySelector("#splitParticipants").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-ref]");
  if (!chip) return;
  const ref = chip.dataset.ref;
  if (selectedParticipants.has(ref)) selectedParticipants.delete(ref);
  else selectedParticipants.add(ref);
  chip.classList.toggle("is-active", selectedParticipants.has(ref));
});

document.querySelector("#splitForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (selectedParticipants.size === 0) return toast("Pilih minimal satu peserta.", "error");
  prepare("split", {
    title: document.querySelector("#splitTitle").value.trim(),
    total: parseAmount(document.querySelector("#splitTotal").value),
    participantRefs: [...selectedParticipants],
  });
});

// -- bills ------------------------------------------------------------------

function syncBillAmount() {
  const select = document.querySelector("#billPayee");
  const option = select.selectedOptions[0];
  if (option?.dataset.amount) document.querySelector("#billAmount").value = idrPlain(Number(option.dataset.amount));
}
document.querySelector("#billPayee").addEventListener("change", syncBillAmount);

document.querySelector("#billForm").addEventListener("submit", (event) => {
  event.preventDefault();
  prepare("bill", {
    payeeRef: document.querySelector("#billPayee").value,
    amount: parseAmount(document.querySelector("#billAmount").value),
    auto: true,
  });
});

// -- purchases --------------------------------------------------------------

document.querySelector("#pulsaProvider").addEventListener("change", renderPulsaDenoms);

document.querySelector("#pulsaForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const amount = pulsaAmount();
  if (!amount) return toast("Pilih nominal pulsa.", "error");
  prepare("pulsa", {
    productRef: document.querySelector("#pulsaProvider").value,
    msisdn: document.querySelector("#pulsaMsisdn").value.trim(),
    amount,
  });
});

document.querySelector("#tokenForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const amount = tokenAmount();
  if (!amount) return toast("Pilih nominal token.", "error");
  prepare("token", { meterNumber: document.querySelector("#tokenMeter").value.trim(), amount });
});

document.querySelector("#ewalletForm").addEventListener("submit", (event) => {
  event.preventDefault();
  prepare("ewallet", {
    walletRef: document.querySelector("#ewWallet").value,
    phone: document.querySelector("#ewPhone").value.trim(),
    amount: parseAmount(document.querySelector("#ewAmount").value),
  });
});

// -- cash -------------------------------------------------------------------

document.querySelector("#topupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  prepare("topup", { amount: parseAmount(document.querySelector("#topupAmount").value), source: "savings" });
});

document.querySelector("#withdrawForm").addEventListener("submit", (event) => {
  event.preventDefault();
  prepare("withdraw", { amount: parseAmount(document.querySelector("#withdrawAmount").value) });
});

// -- PIN --------------------------------------------------------------------

document.querySelector("#pinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api.post("/profile/pin", {
      currentPin: document.querySelector("#pinCurrent").value,
      newPin: document.querySelector("#pinNew").value,
      confirmPin: document.querySelector("#pinConfirm").value,
    });
    event.target.reset();
    toast("PIN berhasil diubah.", "success");
  } catch (err) {
    handleApiError(err);
  }
});

// ============================================================= statement ===

document.querySelector("#statementFilters").addEventListener("submit", (event) => {
  event.preventDefault();
  loadStatement();
});

function statementQuery() {
  const params = new URLSearchParams();
  const from = document.querySelector("#stFrom").value;
  const to = document.querySelector("#stTo").value;
  const direction = document.querySelector("#stDirection").value;
  const q = document.querySelector("#stQuery").value.trim();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (direction) params.set("direction", direction);
  if (q) params.set("q", q);
  return params.toString();
}

async function loadStatement() {
  try {
    const data = await api.get(`/statement?${statementQuery()}`);
    document.querySelector("#statementCount").textContent = `${data.count} transaksi`;
    document.querySelector("#statementSummary").innerHTML = `
      <div><small>Total Kredit</small><b class="amount-credit">${idr(data.summary.credit)}</b></div>
      <div><small>Total Debet</small><b class="amount-debit">${idr(data.summary.debit)}</b></div>
      <div><small>Saldo Akhir</small><b>${idr(data.balances.checking)}</b></div>`;
    document.querySelector("#statementTable").innerHTML = txRows(data.items);
  } catch (err) {
    handleApiError(err);
  }
}

document.querySelector("#stDownload").addEventListener("click", () => {
  window.location.href = `/api/desktop/statement.csv?${statementQuery()}`;
});

// ============================================================= lifecycle ===

/** The markup carries `${BANK}` placeholders so the bank name lives in one
 *  place (the .env brand values) instead of being retyped in every heading. */
function applyBrand() {
  document.title = `Internet Banking — ${brand.bankName}`;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue.includes("${BANK}")) targets.push(walker.currentNode);
  }
  for (const node of targets) node.nodeValue = node.nodeValue.replaceAll("${BANK}", brand.bankName);
}

demoApi
  .get("/config")
  .then((config) => {
    brand = config.brand;
    applyBrand();
    if (!brand.showDemoBanner) document.querySelector("#demoBanner")?.remove();
  })
  .catch(() => applyBrand());

refresh();
setInterval(refresh, 12000); // keeps offers, schedules and the wire feed live

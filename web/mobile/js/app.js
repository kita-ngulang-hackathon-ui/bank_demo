import {
  makeApi,
  idr,
  idrPlain,
  esc,
  initials,
  timeShort,
  dateLong,
  parseAmount,
  toast,
} from "/shared/js/api.js";

const api = makeApi("/api/mobile");
const demoApi = makeApi("/api/demo");

let state = null;
let selectedSplitPeople = new Set();

/** 401 handling shared by every awaited call: an expired or missing session
 *  drops back to the login tab, with a toast only for the "was logged in,
 *  then wasn't" case - a first load with no session yet is silent. */
function handleApiError(err, { silent401 = false } = {}) {
  if (err.status === 401) {
    if (!silent401 && err.code === "SESSION_EXPIRED") toast("Sesi berakhir. Silakan masuk kembali.", "error");
    state = null;
    closeSheet();
    document.querySelector("#bottomNav").hidden = true;
    showTab("login");
    return;
  }
  toast(err.message, "error");
}

// ------------------------------------------------------------------ chrome --

const tick = () => {
  document.querySelector("#clock").textContent = new Date().toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });
};
tick();
setInterval(tick, 20000);

function showTab(name) {
  document.querySelectorAll(".tab-page").forEach((page) => {
    page.classList.toggle("is-active", page.id === `page-${name}`);
    if (page.id === "page-login") page.style.display = page.id === `page-${name}` ? "flex" : "none";
  });
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.tab === name);
  });
}

document.querySelector("#bottomNav").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) showTab(tab.dataset.tab);
  const sheet = event.target.closest("[data-sheet]");
  if (sheet) openSheet(sheet.dataset.sheet);
});

document.querySelectorAll("[data-sheet]").forEach((button) => {
  button.addEventListener("click", () => openSheet(button.dataset.sheet));
});

document.querySelector("#offersButton").addEventListener("click", () => openSheet("offers"));

document.querySelector("#logoutButton").addEventListener("click", async () => {
  await api.del("/session").catch(() => {});
  state = null;
  document.querySelector("#bottomNav").hidden = true;
  showTab("login");
});

// ------------------------------------------------------------------- sheet --

const backdrop = document.querySelector("#sheetBackdrop");
const sheet = document.querySelector("#sheet");
const sheetContent = document.querySelector("#sheetContent");

backdrop.addEventListener("click", closeSheet);

function closeSheet() {
  sheet.classList.remove("is-open");
  backdrop.classList.remove("is-open");
}

function renderSheet(html) {
  sheetContent.innerHTML = html;
  sheet.classList.add("is-open");
  backdrop.classList.add("is-open");
  sheet.scrollTop = 0;
}

const QUICK = [50_000, 100_000, 250_000, 500_000];
const quickChips = () =>
  `<div class="chips">${QUICK.map((a) => `<button type="button" data-quick="${a}">${idrPlain(a)}</button>`).join("")}</div>`;

function peopleRow(selectedRef) {
  return `<div class="people">${state.contacts
    .map(
      (c) => `
      <button type="button" class="person ${c.ref === selectedRef ? "is-active" : ""}" data-person="${esc(c.ref)}">
        <span class="avatar" style="background:${esc(c.avatarColor)}">${esc(initials(c.name))}</span>
        ${esc(c.name.split(" ")[0])}
      </button>`
    )
    .join("")}</div>`;
}

function wireQuick(root = sheetContent) {
  root.querySelectorAll("[data-quick]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const input = root.querySelector("input.amount");
      input.value = idrPlain(Number(chip.dataset.quick));
    });
  });
  root.querySelectorAll("input.amount").forEach((input) => {
    input.addEventListener("input", () => {
      const value = parseAmount(input.value);
      input.value = value ? idrPlain(value) : "";
    });
  });
}

function successSheet({ title, lines, note }) {
  renderSheet(`
    <div class="success">
      <div class="success__ring">✓</div>
      <h2>${esc(title)}</h2>
      <p class="sub">Transaksi selesai.</p>
      <div class="kv">${lines.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div>
      <div class="sdk-note">${note}</div>
      <button class="btn-ghost" id="sheetClose">Tutup</button>
    </div>`);
  sheetContent.querySelector("#sheetClose").addEventListener("click", closeSheet);
}

// ------------------------------------------------------------------ sheets --

const SHEETS = {
  transfer() {
    const first = state.contacts[0];
    renderSheet(`
      <h2>Transfer</h2>
      <p class="sub">Kirim ke sesama pengguna demo.</p>
      <div class="m-field"><label>Penerima</label>${peopleRow(first?.ref)}</div>
      <div class="m-field">
        <label>Nominal</label>
        <input class="amount" inputmode="numeric" placeholder="0" />
        ${quickChips()}
      </div>
      <div class="m-field"><label>Catatan</label><input id="note" maxlength="40" placeholder="Bayar kopi" /></div>
      <button class="btn-primary" id="submit">Kirim sekarang</button>
      <div class="sdk-note">Event <code>wallet.transfer.sent</code> masuk antrean SDK setelah transaksi berhasil.</div>`);

    let recipient = first?.ref ?? null;
    sheetContent.querySelectorAll("[data-person]").forEach((button) => {
      button.addEventListener("click", () => {
        recipient = button.dataset.person;
        sheetContent.querySelectorAll(".person").forEach((p) => p.classList.remove("is-active"));
        button.classList.add("is-active");
      });
    });
    wireQuick();

    sheetContent.querySelector("#submit").addEventListener("click", async (event) => {
      const amount = parseAmount(sheetContent.querySelector("input.amount").value);
      event.target.disabled = true;
      try {
        const { receipt } = await api.post("/transfer", {
          recipientRef: recipient,
          amount,
          note: sheetContent.querySelector("#note").value.trim(),
        });
        await refresh();
        successSheet({
          title: "Transfer berhasil",
          lines: [
            ["Penerima", receipt.recipient.name],
            ["Nominal", idr(receipt.amount)],
            ["Sisa saldo", idr(receipt.balances.checking)],
          ],
          note: "wallet.transfer.sent → antrean SDK → POST /v1/events:batch",
        });
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },

  split() {
    selectedSplitPeople = new Set();
    renderSheet(`
      <h2>Split Bill</h2>
      <p class="sub">Bagi tagihan dengan circle kamu.</p>
      <div class="m-field"><label>Bagi dengan (bisa lebih dari satu)</label>${peopleRow(null)}</div>
      <div class="m-field"><label>Judul</label><input id="title" placeholder="Makan malam" /></div>
      <div class="m-field"><label>Total tagihan</label><input class="amount" inputmode="numeric" placeholder="0" />${quickChips()}</div>
      <button class="btn-primary" id="submit">Buat split bill</button>
      <div class="sdk-note">Satu event <code>wallet.split.created</code> per peserta — itulah edge yang dibaca graph ADA.</div>`);

    sheetContent.querySelectorAll("[data-person]").forEach((button) => {
      button.addEventListener("click", () => {
        const ref = button.dataset.person;
        if (selectedSplitPeople.has(ref)) selectedSplitPeople.delete(ref);
        else selectedSplitPeople.add(ref);
        button.classList.toggle("is-active", selectedSplitPeople.has(ref));
      });
    });
    wireQuick();

    sheetContent.querySelector("#submit").addEventListener("click", async (event) => {
      if (selectedSplitPeople.size === 0) return toast("Pilih minimal satu orang.", "error");
      event.target.disabled = true;
      try {
        const { receipt } = await api.post("/split", {
          title: sheetContent.querySelector("#title").value.trim() || "Split bill",
          total: parseAmount(sheetContent.querySelector("input.amount").value),
          participantRefs: [...selectedSplitPeople],
        });
        await refresh();
        successSheet({
          title: "Split bill dibuat",
          lines: [
            ["Judul", receipt.title],
            ["Total", idr(receipt.total)],
            ["Per orang", idr(receipt.share)],
            ["Peserta", String(receipt.participants.length)],
          ],
          note: `${receipt.participants.length} event wallet.split.created dikirim lewat SDK`,
        });
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },

  splits() {
    const owed = state.splits.filter((s) => s.participants.some((p) => p.ref === state.user.ref && !p.settled));
    if (!owed.length) {
      renderSheet(`<h2>Bayar share</h2><p class="sub">Tidak ada share yang belum dibayar.</p>
        <button class="btn-ghost" id="sheetClose">Tutup</button>`);
      sheetContent.querySelector("#sheetClose").addEventListener("click", closeSheet);
      return;
    }
    renderSheet(`
      <h2>Bayar share</h2>
      <p class="sub">Tagihan split bill yang menunggu kamu.</p>
      ${owed
        .map((split) => {
          const mine = split.participants.find((p) => p.ref === state.user.ref);
          return `
          <div class="list-item">
            <div class="list-item__icon">👥</div>
            <div class="list-item__body"><b>${esc(split.title)}</b><small>Total ${idr(split.total)}</small></div>
            <button class="btn-primary" style="width:auto;padding:9px 14px;margin:0" data-settle="${esc(split.id)}">${idr(mine.share)}</button>
          </div>`;
        })
        .join("")}`);

    sheetContent.querySelectorAll("[data-settle]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const { receipt } = await api.post(`/split/${button.dataset.settle}/settle`);
          await refresh();
          successSheet({
            title: "Share dibayar",
            lines: [["Split", receipt.split.title], ["Nominal", idr(receipt.amount)]],
            note: "wallet.split.settled → antrean SDK",
          });
        } catch (err) {
          handleApiError(err);
          button.disabled = false;
        }
      });
    });
  },

  topup() {
    renderSheet(`
      <h2>Top Up</h2>
      <p class="sub">Pindahkan dana dari tabungan ke saldo utama.</p>
      <div class="m-field"><label>Nominal</label><input class="amount" inputmode="numeric" placeholder="0" />${quickChips()}</div>
      <button class="btn-primary" id="submit">Top up</button>
      <div class="sdk-note">Event <code>wallet.topup.completed</code>.</div>`);
    wireQuick();
    sheetContent.querySelector("#submit").addEventListener("click", async (event) => {
      event.target.disabled = true;
      try {
        const { receipt } = await api.post("/topup", {
          amount: parseAmount(sheetContent.querySelector("input.amount").value),
          source: "savings",
        });
        await refresh();
        successSheet({
          title: "Top up berhasil",
          lines: [["Nominal", idr(receipt.amount)], ["Saldo utama", idr(receipt.balances.checking)]],
          note: "wallet.topup.completed → antrean SDK",
        });
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },

  qr() {
    renderSheet(`
      <h2>Bayar QRIS</h2>
      <p class="sub">Pilih merchant (simulasi hasil pemindaian).</p>
      <div class="m-field">
        <label>Merchant</label>
        <select id="merchant">
          ${state.merchants.map((m) => `<option value="${esc(m.ref)}" data-amount="${m.typicalAmount}">${esc(m.name)}</option>`).join("")}
        </select>
      </div>
      <div class="m-field"><label>Nominal</label><input class="amount" inputmode="numeric" /></div>
      <button class="btn-primary" id="submit">Bayar</button>
      <div class="sdk-note">Event <code>wallet.payment.merchant</code>.</div>`);
    wireQuick();

    const merchantSelect = sheetContent.querySelector("#merchant");
    const amountInput = sheetContent.querySelector("input.amount");
    const sync = () => {
      amountInput.value = idrPlain(Number(merchantSelect.selectedOptions[0].dataset.amount));
    };
    merchantSelect.addEventListener("change", sync);
    sync();

    sheetContent.querySelector("#submit").addEventListener("click", async (event) => {
      event.target.disabled = true;
      try {
        const { receipt } = await api.post("/qr", {
          merchantRef: merchantSelect.value,
          amount: parseAmount(amountInput.value),
        });
        await refresh();
        successSheet({
          title: "Pembayaran berhasil",
          lines: [["Merchant", receipt.merchant.name], ["Nominal", idr(receipt.amount)]],
          note: "wallet.payment.merchant → antrean SDK",
        });
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },

  bill() {
    renderSheet(`
      <h2>Tagihan</h2>
      <p class="sub">Bayar tagihan rutin (autodebet).</p>
      <div class="m-field">
        <label>Penyedia</label>
        <select id="payee">
          ${state.billers.map((b) => `<option value="${esc(b.ref)}" data-amount="${b.defaultAmount}">${esc(b.name)}</option>`).join("")}
        </select>
      </div>
      <div class="m-field"><label>Nominal</label><input class="amount" inputmode="numeric" /></div>
      <button class="btn-primary" id="submit">Bayar tagihan</button>
      <div class="sdk-note">Event <code>wallet.bill.autopay</code>.</div>`);
    wireQuick();

    const payee = sheetContent.querySelector("#payee");
    const amountInput = sheetContent.querySelector("input.amount");
    const sync = () => {
      amountInput.value = idrPlain(Number(payee.selectedOptions[0].dataset.amount));
    };
    payee.addEventListener("change", sync);
    sync();

    sheetContent.querySelector("#submit").addEventListener("click", async (event) => {
      event.target.disabled = true;
      try {
        const { receipt } = await api.post("/bill", {
          payeeRef: payee.value,
          amount: parseAmount(amountInput.value),
          auto: true,
        });
        await refresh();
        successSheet({
          title: "Tagihan dibayar",
          lines: [["Penyedia", receipt.biller.name], ["Nominal", idr(receipt.amount)]],
          note: "wallet.bill.autopay → antrean SDK",
        });
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },

  withdraw() {
    renderSheet(`
      <h2>Tarik tunai</h2>
      <p class="sub">Tanpa kartu, minimum Rp 50.000.</p>
      <div class="m-field"><label>Nominal</label><input class="amount" inputmode="numeric" placeholder="0" />${quickChips()}</div>
      <button class="btn-primary" id="submit">Buat kode</button>
      <div class="sdk-note">Event <code>wallet.withdraw.completed</code>.</div>`);
    wireQuick();
    sheetContent.querySelector("#submit").addEventListener("click", async (event) => {
      event.target.disabled = true;
      try {
        const { receipt } = await api.post("/withdraw", {
          amount: parseAmount(sheetContent.querySelector("input.amount").value),
        });
        await refresh();
        successSheet({
          title: "Kode tarik tunai",
          lines: [["Kode", receipt.code], ["Nominal", idr(receipt.amount)]],
          note: "wallet.withdraw.completed → antrean SDK",
        });
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },

  offers() {
    if (!state.offers.length) {
      renderSheet(`<h2>Penawaran</h2>
        <p class="sub">Belum ada rekomendasi yang disetujui di ADA Console.</p>
        <button class="btn-ghost" id="sheetClose">Tutup</button>`);
      sheetContent.querySelector("#sheetClose").addEventListener("click", closeSheet);
      return;
    }
    renderSheet(`
      <h2>Penawaran untukmu</h2>
      <p class="sub">Ditarik dari GET /v1/recommendations?status=APPROVED.</p>
      ${state.offers.map(offerCardHtml).join("")}`);
    bindClaims(sheetContent);
  },

  // -- secondary menu -------------------------------------------------------

  lainnya() {
    const items = [
      ["transferInterbank", "⇉", "Transfer Antar Bank", "BI-FAST, Kliring, RTGS"],
      ["pulsa", "📱", "Pulsa & Data", "Isi ulang prabayar"],
      ["token", "⚡", "Token Listrik", "PLN Prabayar"],
      ["ewallet", "👛", "Top Up e-Wallet", "GoPay, OVO, DANA, ShopeePay"],
      ["favourites", "★", "Rekening Favorit", "Penerima transfer tersimpan"],
      ["schedules", "⏱", "Transfer Terjadwal", "Instruksi berulang"],
    ];
    renderSheet(`
      <h2>Lainnya</h2>
      <p class="sub">Fitur tambahan.</p>
      <div class="menu-list">
        ${items
          .map(
            ([key, icon, title, sub]) => `
          <button type="button" data-open="${key}">
            <span class="icon">${icon}</span>
            <span><b style="display:block">${esc(title)}</b><small>${esc(sub)}</small></span>
          </button>`
          )
          .join("")}
      </div>`);
    sheetContent.querySelectorAll("[data-open]").forEach((button) => {
      button.addEventListener("click", () => openSheet(button.dataset.open));
    });
  },

  // -- interbank transfer ----------------------------------------------------

  transferInterbank() {
    const banks = state.catalog.banks;
    const networks = state.catalog.networks;
    renderSheet(`
      <h2>Transfer Antar Bank</h2>
      <p class="sub">Ke rekening bank lain.</p>
      <div class="m-field"><label>Bank Tujuan</label>
        <select id="bank">${banks.map((b) => `<option value="${esc(b.code)}">${esc(b.name)}</option>`).join("")}</select>
      </div>
      <div class="m-field"><label>Nomor Rekening</label><input id="account" inputmode="numeric" placeholder="1234567890" /></div>
      <div class="m-field"><label>Nama Penerima</label><input id="name" placeholder="Nama sesuai rekening" /></div>
      <div class="m-field"><label>Jenis Transfer</label>
        <select id="network">${networks.map((n) => `<option value="${esc(n.code)}">${esc(n.name)} — biaya ${idrPlain(n.fee)}</option>`).join("")}</select>
      </div>
      <div class="m-field"><label>Nominal</label><input class="amount" inputmode="numeric" placeholder="0" />${quickChips()}</div>
      <div class="m-field"><label>Catatan</label><input id="note" maxlength="40" placeholder="Pembayaran invoice" /></div>
      <div class="sdk-note" id="feeNote"></div>
      <button class="btn-primary" id="submit" style="margin-top:6px">Kirim sekarang</button>
      <div class="sdk-note">Event <code>wallet.transfer.sent</code> dengan biaya jaringan, masuk antrean SDK.</div>`);
    wireQuick();

    const networkSelect = sheetContent.querySelector("#network");
    const syncFee = () => {
      const network = networks.find((n) => n.code === networkSelect.value);
      sheetContent.querySelector("#feeNote").textContent = network
        ? `Biaya ${idr(network.fee)} · ${network.sla}${network.minAmount ? ` · minimum ${idr(network.minAmount)}` : ""}`
        : "";
    };
    networkSelect.addEventListener("change", syncFee);
    syncFee();

    sheetContent.querySelector("#submit").addEventListener("click", async (event) => {
      const amount = parseAmount(sheetContent.querySelector("input.amount").value);
      event.target.disabled = true;
      try {
        const { receipt } = await api.post("/transfer/interbank", {
          bankCode: sheetContent.querySelector("#bank").value,
          accountNumber: sheetContent.querySelector("#account").value.trim(),
          beneficiaryName: sheetContent.querySelector("#name").value.trim(),
          networkCode: networkSelect.value,
          amount,
          note: sheetContent.querySelector("#note").value.trim(),
        });
        await refresh();
        successSheet({
          title: "Transfer terkirim",
          lines: [
            ["Bank", receipt.bank.name],
            ["Rekening", `${receipt.accountNumber} — ${receipt.beneficiaryName}`],
            ["Nominal", idr(receipt.amount)],
            ["Biaya", idr(receipt.fee)],
            ["Sisa saldo", idr(receipt.balances.checking)],
          ],
          note: "wallet.transfer.sent → antrean SDK",
        });
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },

  // -- prepaid ----------------------------------------------------------------

  pulsa() {
    const products = state.catalog.pulsa;
    let amount = null;

    const denomsHtml = (product) =>
      `<div class="m-denoms" id="denoms">${(product?.denominations ?? [])
        .map((d) => `<button type="button" data-amount="${d}">${idrPlain(d)}</button>`)
        .join("")}</div>`;

    renderSheet(`
      <h2>Pulsa & Data</h2>
      <p class="sub">Isi ulang prabayar.</p>
      <div class="m-field"><label>Provider</label>
        <select id="provider">${products.map((p) => `<option value="${esc(p.ref)}">${esc(p.provider)}</option>`).join("")}</select>
      </div>
      <div class="m-field"><label>Nomor Handphone</label><input id="msisdn" inputmode="numeric" placeholder="08123456789" /></div>
      <div class="m-field"><label>Nominal</label>${denomsHtml(products[0])}</div>
      <button class="btn-primary" id="submit">Beli sekarang</button>
      <div class="sdk-note">Event <code>wallet.payment.merchant</code>.</div>`);

    const bindDenoms = () => {
      sheetContent.querySelectorAll("#denoms [data-amount]").forEach((button) => {
        button.addEventListener("click", () => {
          amount = Number(button.dataset.amount);
          sheetContent.querySelectorAll("#denoms button").forEach((b) => b.classList.toggle("is-active", b === button));
        });
      });
    };
    bindDenoms();

    sheetContent.querySelector("#provider").addEventListener("change", (event) => {
      const product = products.find((p) => p.ref === event.target.value);
      amount = null;
      sheetContent.querySelector("#denoms").outerHTML = denomsHtml(product);
      bindDenoms();
    });

    sheetContent.querySelector("#submit").addEventListener("click", async (event) => {
      if (!amount) return toast("Pilih nominal pulsa.", "error");
      event.target.disabled = true;
      try {
        const { receipt } = await api.post("/purchase/pulsa", {
          productRef: sheetContent.querySelector("#provider").value,
          msisdn: sheetContent.querySelector("#msisdn").value.trim(),
          amount,
        });
        await refresh();
        successSheet({
          title: "Pulsa berhasil dibeli",
          lines: [["Provider", receipt.product.provider], ["Nomor", receipt.msisdn], ["Nominal", idr(receipt.amount)]],
          note: "wallet.payment.merchant → antrean SDK",
        });
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },

  token() {
    const denoms = state.catalog.tokenDenoms ?? [];
    let amount = null;

    renderSheet(`
      <h2>Token Listrik</h2>
      <p class="sub">PLN Prabayar.</p>
      <div class="m-field"><label>ID Pelanggan / Nomor Meter</label><input id="meter" inputmode="numeric" value="14021234567890" /></div>
      <div class="m-field"><label>Nominal</label>
        <div class="m-denoms">${denoms.map((d) => `<button type="button" data-amount="${d}">${idrPlain(d)}</button>`).join("")}</div>
      </div>
      <button class="btn-primary" id="submit">Beli token</button>
      <div class="sdk-note">Event <code>wallet.payment.merchant</code>.</div>`);

    sheetContent.querySelectorAll(".m-denoms [data-amount]").forEach((button) => {
      button.addEventListener("click", () => {
        amount = Number(button.dataset.amount);
        sheetContent.querySelectorAll(".m-denoms button").forEach((b) => b.classList.toggle("is-active", b === button));
      });
    });

    sheetContent.querySelector("#submit").addEventListener("click", async (event) => {
      if (!amount) return toast("Pilih nominal token.", "error");
      event.target.disabled = true;
      try {
        const { receipt } = await api.post("/purchase/token", {
          meterNumber: sheetContent.querySelector("#meter").value.trim(),
          amount,
        });
        await refresh();
        successSheet({
          title: "Token berhasil dibeli",
          lines: [["ID Pelanggan", receipt.meterNumber], ["Nominal", idr(receipt.amount)], ["Nomor Token", receipt.token]],
          note: "wallet.payment.merchant → antrean SDK",
        });
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },

  ewallet() {
    const wallets = state.catalog.ewallets;
    renderSheet(`
      <h2>Top Up e-Wallet</h2>
      <p class="sub">Isi saldo dompet digital dari rekening.</p>
      <div class="m-field"><label>e-Wallet</label>
        <select id="wallet">${wallets.map((w) => `<option value="${esc(w.ref)}">${esc(w.name)}</option>`).join("")}</select>
      </div>
      <div class="m-field"><label>Nomor Terdaftar</label><input id="phone" inputmode="numeric" placeholder="08123456789" /></div>
      <div class="m-field"><label>Nominal</label><input class="amount" inputmode="numeric" placeholder="0" />${quickChips()}</div>
      <button class="btn-primary" id="submit">Top up</button>
      <div class="sdk-note">Event <code>wallet.topup.completed</code>.</div>`);
    wireQuick();

    sheetContent.querySelector("#submit").addEventListener("click", async (event) => {
      const amount = parseAmount(sheetContent.querySelector("input.amount").value);
      event.target.disabled = true;
      try {
        const { receipt } = await api.post("/topup/ewallet", {
          walletRef: sheetContent.querySelector("#wallet").value,
          phone: sheetContent.querySelector("#phone").value.trim(),
          amount,
        });
        await refresh();
        successSheet({
          title: "Top up berhasil",
          lines: [["e-Wallet", receipt.wallet.name], ["Nominal", idr(receipt.amount)], ["Sisa saldo", idr(receipt.balances.checking)]],
          note: "wallet.topup.completed → antrean SDK",
        });
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },

  // -- favourites --------------------------------------------------------------

  favourites() {
    const rows = state.favourites ?? [];
    renderSheet(`
      <h2>Rekening Favorit</h2>
      <p class="sub">Penerima transfer tersimpan.</p>
      ${
        rows.length
          ? rows
              .map(
                (fav) => `
        <div class="sheet-list-item">
          <span class="avatar" style="background:#00787a">${esc(initials(fav.beneficiaryName))}</span>
          <div class="sheet-list-item__body"><b>${esc(fav.alias)}</b><small>${esc(fav.accountNumber)} · ${esc(fav.bankName ?? "")}</small></div>
          <div class="sheet-list-item__actions">
            ${fav.targetRef ? `<button class="btn-tiny" data-use="${esc(fav.targetRef)}">Transfer</button>` : ""}
            <button class="btn-tiny danger" data-del="${esc(fav.id)}">Hapus</button>
          </div>
        </div>`
              )
              .join("")
          : `<div class="empty-dark">Belum ada rekening favorit.</div>`
      }
      <div class="m-divider">
        <label style="display:block;font-size:11.5px;color:var(--app-muted);margin-bottom:8px">Tambah dari circle</label>
        <div class="m-field"><label>Nasabah</label>
          <select id="favUser">${state.contacts.map((c) => `<option value="${esc(c.ref)}">${esc(c.name)}</option>`).join("")}</select>
        </div>
        <div class="m-field"><label>Nama Alias</label><input id="favAlias" placeholder="Bella - kost" /></div>
        <button class="btn-ghost" id="addFav">Simpan Favorit</button>
      </div>`);

    sheetContent.querySelectorAll("[data-del]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await api.del(`/favourites/${button.dataset.del}`);
          toast("Rekening favorit dihapus.");
          await refresh();
          SHEETS.favourites();
        } catch (err) {
          handleApiError(err);
        }
      });
    });

    sheetContent.querySelectorAll("[data-use]").forEach((button) => {
      button.addEventListener("click", () => {
        closeSheet();
        SHEETS.transfer();
        const target = button.dataset.use;
        const personButton = sheetContent.querySelector(`[data-person="${target}"]`);
        personButton?.click();
      });
    });

    sheetContent.querySelector("#addFav").addEventListener("click", async (event) => {
      event.target.disabled = true;
      try {
        await api.post("/favourites", {
          userRef: sheetContent.querySelector("#favUser").value,
          alias: sheetContent.querySelector("#favAlias").value.trim(),
        });
        toast("Rekening favorit disimpan.", "success");
        await refresh();
        SHEETS.favourites();
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },

  // -- scheduled transfers -------------------------------------------------

  schedules() {
    const rows = state.schedules ?? [];
    const frequencies = state.catalog.frequencies;
    renderSheet(`
      <h2>Transfer Terjadwal</h2>
      <p class="sub">Instruksi berulang ke sesama nasabah.</p>
      ${
        rows.length
          ? rows
              .map(
                (row) => `
        <div class="sheet-list-item">
          <div class="sheet-list-item__body">
            <b>${esc(row.recipientName)} — ${idr(row.amount)}</b>
            <small>${esc(row.frequencyName)} · ${row.status} · berikutnya ${new Date(row.nextRunAt).toLocaleDateString("id-ID")}</small>
          </div>
          <div class="sheet-list-item__actions">
            ${row.status === "ACTIVE" ? `<button class="btn-tiny" data-run="${esc(row.id)}">Jalankan</button>` : ""}
            ${row.status === "ACTIVE" ? `<button class="btn-tiny danger" data-cancel="${esc(row.id)}">Batal</button>` : ""}
          </div>
        </div>`
              )
              .join("")
          : `<div class="empty-dark">Belum ada transfer terjadwal.</div>`
      }
      <div class="m-divider">
        <label style="display:block;font-size:11.5px;color:var(--app-muted);margin-bottom:8px">Buat jadwal baru</label>
        <div class="m-field"><label>Penerima</label>${peopleRow(null)}</div>
        <div class="m-field"><label>Nominal</label><input class="amount" inputmode="numeric" placeholder="0" />${quickChips()}</div>
        <div class="m-field"><label>Frekuensi</label>
          <select id="freq">${frequencies.map((f) => `<option value="${esc(f.code)}">${esc(f.name)}</option>`).join("")}</select>
        </div>
        <div class="m-field"><label>Mulai</label><input id="start" type="date" /></div>
        <div class="m-field"><label>Catatan</label><input id="schNote" maxlength="40" placeholder="Uang kos" /></div>
        <button class="btn-ghost" id="addSchedule">Simpan Jadwal</button>
      </div>`);
    wireQuick();

    const startInput = sheetContent.querySelector("#start");
    startInput.value = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    let recipient = null;
    sheetContent.querySelectorAll("[data-person]").forEach((button) => {
      button.addEventListener("click", () => {
        recipient = button.dataset.person;
        sheetContent.querySelectorAll(".person").forEach((p) => p.classList.remove("is-active"));
        button.classList.add("is-active");
      });
    });

    sheetContent.querySelectorAll("[data-run]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const { receipt } = await api.post(`/schedules/${button.dataset.run}/run`);
          await refresh();
          successSheet({
            title: "Jadwal dijalankan",
            lines: [["Referensi", receipt.reference], ["Nominal", idr(receipt.amount)]],
            note: "wallet.transfer.sent → antrean SDK",
          });
        } catch (err) {
          handleApiError(err);
          button.disabled = false;
        }
      });
    });

    sheetContent.querySelectorAll("[data-cancel]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await api.del(`/schedules/${button.dataset.cancel}`);
          toast("Jadwal dibatalkan.");
          await refresh();
          SHEETS.schedules();
        } catch (err) {
          handleApiError(err);
        }
      });
    });

    sheetContent.querySelector("#addSchedule").addEventListener("click", async (event) => {
      if (!recipient) return toast("Pilih penerima.", "error");
      event.target.disabled = true;
      try {
        await api.post("/schedules", {
          recipientRef: recipient,
          amount: parseAmount(sheetContent.querySelector("input.amount").value),
          frequency: sheetContent.querySelector("#freq").value,
          startDate: startInput.value,
          note: sheetContent.querySelector("#schNote").value.trim(),
        });
        toast("Jadwal transfer disimpan.", "success");
        await refresh();
        SHEETS.schedules();
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },

  // -- security -------------------------------------------------------------

  pin() {
    renderSheet(`
      <h2>Ubah PIN</h2>
      <p class="sub">PIN transaksi 6 digit.</p>
      <div class="m-field"><label>PIN Saat Ini</label><input id="current" type="password" inputmode="numeric" maxlength="6" /></div>
      <div class="m-field"><label>PIN Baru</label><input id="next" type="password" inputmode="numeric" maxlength="6" /></div>
      <div class="m-field"><label>Konfirmasi PIN Baru</label><input id="confirm" type="password" inputmode="numeric" maxlength="6" /></div>
      <button class="btn-primary" id="submit">Simpan PIN</button>`);

    sheetContent.querySelector("#submit").addEventListener("click", async (event) => {
      event.target.disabled = true;
      try {
        await api.post("/profile/pin", {
          currentPin: sheetContent.querySelector("#current").value,
          newPin: sheetContent.querySelector("#next").value,
          confirmPin: sheetContent.querySelector("#confirm").value,
        });
        successSheet({
          title: "PIN berhasil diubah",
          lines: [],
          note: "PIN baru berlaku untuk login berikutnya di kedua surface.",
        });
      } catch (err) {
        handleApiError(err);
        event.target.disabled = false;
      }
    });
  },
};

function openSheet(name) {
  if (!state) return;
  const builder = SHEETS[name];
  if (builder) builder();
}

// ----------------------------------------------------------------- render --

function offerCardHtml(offer) {
  return `
    <div class="offer-card">
      <span class="offer-card__tag">${esc(offer.incentiveCode)}</span>
      <h3>${esc(offer.copy.title)}</h3>
      <p>${esc(offer.copy.body)}</p>
      ${offer.reasonText ? `<div class="offer-card__reason">${esc(offer.reasonText)}</div>` : ""}
      <button data-claim="${esc(offer.recommendationId)}">${esc(offer.copy.cta)}</button>
    </div>`;
}

function bindClaims(root) {
  root.querySelectorAll("[data-claim]").forEach((button) => {
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

const ICONS = {
  TRANSFER_OUT: "⇄",
  TRANSFER_IN: "⇆",
  TRANSFER_INTERBANK: "⇉",
  SPLIT_CREATED: "👥",
  SPLIT_SETTLED: "♺",
  SPLIT_RECEIVED: "♺",
  BILL_PAYMENT: "🧾",
  TOPUP: "＋",
  EWALLET_TOPUP: "👛",
  PULSA_PURCHASE: "📱",
  PLN_TOKEN: "⚡",
  QR_PAYMENT: "▢",
  WITHDRAWAL: "🏧",
};

function activityHtml(list) {
  if (!list.length) return `<div class="empty-dark">Belum ada aktivitas.</div>`;
  return list
    .map(
      (tx) => `
      <div class="list-item">
        <div class="list-item__icon">${ICONS[tx.kind] ?? "•"}</div>
        <div class="list-item__body">
          <b>${esc(tx.counterpartyName ?? tx.kind)}</b>
          <small>${esc(tx.note ?? "")} · ${timeShort(tx.at)}</small>
        </div>
        <div class="list-item__amount ${tx.direction === "credit" ? "amt-credit" : tx.direction === "debit" ? "amt-debit" : "amt-info"}">
          ${tx.direction === "credit" ? "+" : tx.direction === "debit" ? "−" : ""}${idr(tx.amount)}
        </div>
      </div>`
    )
    .join("");
}

function render() {
  document.querySelector("#greetName").textContent = state.user.name.split(" ")[0];
  document.querySelector("#greetLabel").textContent = greetingFor(new Date());
  document.querySelector("#balanceMain").textContent = idr(state.balances.checking);
  document.querySelector("#balanceSavings").textContent = idr(state.balances.savings);
  document.querySelector("#balanceAccount").textContent = `${state.user.accountNumber} · ${state.user.attributes.segment}`;
  document.querySelector("#circleName").textContent = state.user.circle;

  document.querySelector("#offerCount").textContent = state.offers.length ? `${state.offers.length} aktif` : "";
  document.querySelector("#offersButton").classList.toggle("has-dot", state.offers.length > 0);
  document.querySelector("#offerRail").innerHTML = state.offers.length
    ? state.offers.map(offerCardHtml).join("")
    : `<div class="empty-dark">Belum ada penawaran. Jalankan pipeline ADA lalu setujui rekomendasinya.</div>`;
  bindClaims(document.querySelector("#offerRail"));

  document.querySelector("#activityList").innerHTML = activityHtml(state.transactions.slice(0, 6));
  document.querySelector("#activityHint").textContent = `${state.transactions.length} transaksi`;
  applyActivityFilter();

  document.querySelector("#circleList").innerHTML = state.contacts
    .map(
      (c) => `
      <div class="list-item">
        <div class="list-item__icon" style="background:${esc(c.avatarColor)}">${esc(initials(c.name))}</div>
        <div class="list-item__body"><b>${esc(c.name)}</b><small>${esc(c.circle)} · ${esc(c.attributes.region)}</small></div>
      </div>`
    )
    .join("");

  document.querySelector("#splitBoard").innerHTML = state.splits.length
    ? state.splits
        .map((split) => {
          const settled = split.participants.filter((p) => p.settled).length;
          return `
          <div class="list-item">
            <div class="list-item__icon">👥</div>
            <div class="list-item__body"><b>${esc(split.title)}</b><small>${settled}/${split.participants.length} sudah bayar</small></div>
            <div class="list-item__amount amt-info">${idr(split.total)}</div>
          </div>`;
        })
        .join("")
    : `<div class="empty-dark">Belum ada split bill.</div>`;

  document.querySelector("#profileList").innerHTML = `
    <div class="list-item">
      <div class="list-item__icon" style="background:${esc(state.user.avatarColor)}">${esc(initials(state.user.name))}</div>
      <div class="list-item__body"><b>${esc(state.user.name)}</b><small>${esc(state.user.ref)} · ${esc(state.user.attributes.cohort)}</small></div>
    </div>
    <div class="list-item"><div class="list-item__icon">◎</div><div class="list-item__body"><b>Region</b><small>${esc(state.user.attributes.region)}</small></div></div>
    <div class="list-item"><div class="list-item__icon">★</div><div class="list-item__body"><b>Tenure</b><small>${esc(state.user.attributes.tenure_months)} bulan</small></div></div>`;

  document.querySelector("#wireList").innerHTML = state.wire.length
    ? state.wire
        .map(
          (row) => `
        <div class="list-item">
          <div class="list-item__icon">↑</div>
          <div class="list-item__body"><b>${esc(row.eventType)}</b><small>${timeShort(row.at)} · ${esc(row.status)}</small></div>
        </div>`
        )
        .join("")
    : `<div class="empty-dark">Belum ada event terkirim.</div>`;

  const activity = state.loginActivity ?? [];
  document.querySelector("#loginActivityList").innerHTML = activity.length
    ? activity
        .map(
          (row) => `
        <div class="list-item">
          <div class="list-item__icon">${row.surface === "desktop" ? "🖥" : "📱"}</div>
          <div class="list-item__body">
            <b>${esc(row.surface === "desktop" ? "Internet Banking" : "Mobile App")}</b>
            <small>${dateLong(row.at)} ${timeShort(row.at)} · ${esc(row.ip ?? "-")}</small>
          </div>
        </div>`
        )
        .join("")
    : `<div class="empty-dark">Belum ada aktivitas login.</div>`;
}

/** Filters state.transactions client-side by the same fields the desktop
 *  statement filters on - direction and free text - and keeps whatever the
 *  user already typed across the background refresh. */
function applyActivityFilter() {
  const directionEl = document.querySelector("#actDirection");
  const queryEl = document.querySelector("#actQuery");
  const direction = directionEl?.value ?? "all";
  const needle = (queryEl?.value ?? "").trim().toLowerCase();

  const items = state.transactions.filter((tx) => {
    if (direction !== "all" && tx.direction !== direction) return false;
    if (needle) {
      const haystack = `${tx.counterpartyName ?? ""} ${tx.note ?? ""} ${tx.kind} ${tx.reference ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  document.querySelector("#fullActivityList").innerHTML = activityHtml(items);
  document.querySelector("#activityFullHint").textContent = `${items.length} transaksi`;
}

document.querySelector("#actDirection").addEventListener("change", applyActivityFilter);
document.querySelector("#actQuery").addEventListener("input", applyActivityFilter);

function greetingFor(date) {
  const hour = date.getHours();
  if (hour < 11) return "Selamat pagi,";
  if (hour < 15) return "Selamat siang,";
  if (hour < 19) return "Selamat sore,";
  return "Selamat malam,";
}

async function refresh() {
  try {
    state = await api.get("/home");
  } catch (err) {
    handleApiError(err, { silent401: true });
    return;
  }
  document.querySelector("#bottomNav").hidden = false;
  render();
}

// ------------------------------------------------------------------ login --

demoApi.get("/users").then(({ items }) => {
  document.querySelector("#loginUsers").innerHTML = items
    .map(
      (user) => `
      <button class="list-item" style="width:100%;text-align:left" data-username="${esc(user.username)}">
        <div class="list-item__icon" style="background:${esc(user.avatarColor)}">${esc(initials(user.name))}</div>
        <div class="list-item__body"><b>${esc(user.name)}</b><small>${esc(user.attributes.segment)} · ${esc(user.circle)}</small></div>
      </button>`
    )
    .join("");

  document.querySelector("#loginUsers").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-username]");
    if (!button) return;
    button.disabled = true;
    try {
      await api.post("/session", { username: button.dataset.username, pin: "123456" });
      await refresh();
      showTab("home");
    } catch (err) {
      handleApiError(err);
      button.disabled = false;
    }
  });
});

document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.toggle("is-active", t === tab));
    document
      .querySelectorAll(".auth-panel")
      .forEach((panel) => panel.classList.toggle("is-active", panel.id === `panel-${tab.dataset.auth}`));
    document.querySelector("#loginError").classList.remove("is-visible");
  });
});

document.querySelector("#registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorBox = document.querySelector("#loginError");
  errorBox.classList.remove("is-visible");
  const submitButton = document.querySelector("#registerSubmit");
  submitButton.disabled = true;

  try {
    // Creates the account and signs in with one call, queued through the
    // SDK exactly like every other mobile action.
    await api.post("/register", {
      name: document.querySelector("#regName").value.trim(),
      username: document.querySelector("#regUsername").value.trim().toLowerCase(),
      pin: document.querySelector("#regPin").value.trim(),
      confirmPin: document.querySelector("#regPinConfirm").value.trim(),
    });
    await refresh();
    showTab("home");
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.add("is-visible");
  } finally {
    submitButton.disabled = false;
  }
});

api
  .get("/session")
  .then(async () => {
    await refresh();
    showTab("home");
  })
  .catch(() => showTab("login"));

setInterval(() => {
  if (state) refresh();
}, 12000);

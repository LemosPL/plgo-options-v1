"use strict";

// ─── State ──────────────────────────────────────────────────
let currentAsset = "ETH";  // "ETH" or "FIL"
let ethSpot = null;
let optionChain = [];   // OptionTicker[]
let legs = [];          // {side, type, strike, premium, quantity}
let volSurface = null;  // cached Deribit vol surface {eth_spot, smiles: [{expiry_code, dte, strikes, ivs}]}

// ─── Asset-aware formatting helpers ─────────────────────────
const fmtSpot = (v) => currentAsset === "FIL" ? Number(v).toFixed(2) : Number(v).toFixed(0);
const fmtStrike = (v) => currentAsset === "FIL" ? Number(v).toFixed(2) : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtPrem = (v) => {
  const n = Number(v);
  if (currentAsset === "FIL") return n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  if (Math.abs(n) < 0.01) return n.toPrecision(2);
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtPremTotal = (v) => {
  const d = currentAsset === "FIL" ? 4 : 2;
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
};

function updateVolSpreadHint(inputId, hintId) {
  const pts = parseFloat(document.getElementById(inputId).value) || 0;
  const $hint = document.getElementById(hintId);
  if (pts <= 0) {
    $hint.textContent = "Mid pricing (no spread)";
  } else {
    $hint.innerHTML = `Buy @ mid+${pts} &nbsp;|&nbsp; Sell @ mid\u2212${pts}`;
  }
}

// ─── DOM refs ───────────────────────────────────────────────
const $spot       = document.getElementById("eth-spot");
const $expSel     = document.getElementById("expiry-select");
const $btnLoad    = document.getElementById("btn-load-chain");
const $legsBody   = document.getElementById("legs-body");
const $btnAdd     = document.getElementById("btn-add-leg");
const $btnCompute = document.getElementById("btn-compute");
const $btnRepl    = document.getElementById("btn-replicate");
const $spotMin    = document.getElementById("spot-min");
const $spotMax    = document.getElementById("spot-max");
const $chainSec   = document.getElementById("chain-section");
const $chainExp   = document.getElementById("chain-expiry");
const $chainBody  = document.getElementById("chain-body");

// ─── Chart theme helper ────────────────────────────────────
function chartColors() {
  const light = document.documentElement.dataset.theme === "light";
  return light
    ? { paper: "#ffffff", plot: "#f6f8fa", text: "#1f2328", muted: "#656d76", grid: "#d0d7de", zeroline: "#afb8c1", legendBg: "rgba(255,255,255,0.8)", legendBorder: "#d0d7de" }
    : { paper: "#161b22", plot: "#0d1117", text: "#e6edf3", muted: "#8b949e", grid: "#21262d", zeroline: "#30363d", legendBg: "rgba(22,27,34,0.8)", legendBorder: "#30363d" };
}

// ─── API helpers ────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    // Surface the server's error body (FastAPI puts the traceback in `detail`)
    // so callers can show/copy it — not just "500 Internal Server Error".
    let detail = "";
    try {
      const txt = await res.text();
      try { detail = JSON.parse(txt).detail ?? txt; } catch { detail = txt; }
    } catch { /* ignore */ }
    const err = new Error(`${res.status} ${res.statusText}${detail ? "\n" + detail : ""}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json();
}

const get  = (path) => api("GET", path);
const post = (path, body) => api("POST", path, body);

// Show the deployed build number (derived from the app.js cache-buster ?v=N) in
// the sidebar, so it's obvious whether a user is on the latest deployed version.
(function showAppVersion() {
  try {
    const s = document.querySelector('script[src*="app.js"]');
    const m = s && s.src.match(/[?&]v=(\d+)/);
    const el = document.getElementById("app-version");
    if (el) el.textContent = m ? `build ${m[1]}` : "build ?";
  } catch (e) { /* ignore */ }
})();

// ─── Vol surface helpers (for pricer) ────────────────────────
// Parse expiry code to Date
function _parseExpiryCode(code) {
  // "13APR26" -> Date
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const m = code.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const d = parseInt(m[1]), mon = months[m[2]], y = 2000 + parseInt(m[3]);
  if (mon === undefined) return null;
  return new Date(y, mon, d);
}

// Compute DTE from expiry code
function _expiryCodeToDte(code) {
  const d = _parseExpiryCode(code);
  if (!d) return null;
  return Math.max(0, Math.round((d - new Date()) / 86400000));
}

// Interpolate IV between two smile surfaces for a non-standard expiry
function _interpolateSmileIv(expiryCode, strike) {
  if (!volSurface || !volSurface.smiles || volSurface.smiles.length < 2) return null;
  const targetDte = _expiryCodeToDte(expiryCode);
  if (targetDte == null) return null;

  // Sort smiles by DTE
  const sorted = [...volSurface.smiles].sort((a, b) => a.dte - b.dte);

  // Find bracketing smiles
  let before = null, after = null;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].dte <= targetDte) before = sorted[i];
    if (sorted[i].dte >= targetDte && !after) after = sorted[i];
  }

  if (!before && !after) return null;
  if (!before) before = after;
  if (!after) after = before;
  if (before === after) {
    // Only one smile available, use it directly
    return _lookupIvInSmile(before, strike);
  }

  // Linear interpolation in DTE between the two smiles
  const range = after.dte - before.dte;
  const w = range > 0 ? (targetDte - before.dte) / range : 0.5;
  const ivBefore = _lookupIvInSmile(before, strike);
  const ivAfter = _lookupIvInSmile(after, strike);
  if (ivBefore == null || ivAfter == null) return ivBefore || ivAfter;
  return ivBefore * (1 - w) + ivAfter * w;
}

// Lookup IV in a single smile (strike interpolation)
function _lookupIvInSmile(smile, strike) {
  const { strikes, ivs } = smile;
  if (!strikes || strikes.length === 0) return null;
  if (strike <= strikes[0]) return ivs[0];
  if (strike >= strikes[strikes.length - 1]) return ivs[ivs.length - 1];
  for (let i = 0; i < strikes.length - 1; i++) {
    if (strike >= strikes[i] && strike <= strikes[i + 1]) {
      const t = (strike - strikes[i]) / (strikes[i + 1] - strikes[i]);
      return ivs[i] + t * (ivs[i + 1] - ivs[i]);
    }
  }
  return ivs[ivs.length - 1];
}

function lookupSmileIv(expiryCode, strike) {
  if (!volSurface || !volSurface.smiles) return null;
  const smile = volSurface.smiles.find(s => s.expiry_code === expiryCode);
  if (smile) return _lookupIvInSmile(smile, strike);
  // No exact match — interpolate between nearest expiries
  return _interpolateSmileIv(expiryCode, strike);
}

function getSmileForExpiry(expiryCode) {
  if (!volSurface || !volSurface.smiles) return null;
  const exact = volSurface.smiles.find(s => s.expiry_code === expiryCode);
  if (exact) return exact;
  // Build a synthetic smile for non-standard expiries via interpolation
  const targetDte = _expiryCodeToDte(expiryCode);
  if (targetDte == null) return null;
  // Use the nearest smile's strikes as reference points
  const sorted = [...volSurface.smiles].sort((a, b) => Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte));
  const ref = sorted[0];
  if (!ref) return null;
  const syntheticIvs = ref.strikes.map(k => _interpolateSmileIv(expiryCode, k));
  if (syntheticIvs.some(v => v == null)) return null;
  return { expiry_code: expiryCode, dte: targetDte, strikes: [...ref.strikes], ivs: syntheticIvs, _synthetic: true };
}

// Simple BS for the pricer (reusing the one from portfolio section causes ordering issues)
function pricerBs(S, K, T, r, sigma, type) {
  if (T <= 0) return type === "C" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  // normCdf defined later in file, use inline Horner approx
  function _ncdf(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
  }
  if (type === "C") return S * _ncdf(d1) - K * Math.exp(-r * T) * _ncdf(d2);
  return K * Math.exp(-r * T) * _ncdf(-d2) - S * _ncdf(-d1);
}

// Per-contract BS delta. Call ∈ [0,1], Put ∈ [-1,0]. At/past expiry → intrinsic delta.
function pricerDelta(S, K, T, r, sigma, type) {
  if (T <= 0 || sigma <= 0) {
    if (type === "C") return S > K ? 1 : 0;
    return S < K ? -1 : 0;
  }
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return type === "C" ? normCdf(d1) : normCdf(d1) - 1;
}

// ─── Counterparty pricing methodologies ─────────────────────
// Each counterparty quotes off its own vol/skew, not the mid vol surface.
// We calibrate a methodology per counterparty AS WE TRADE with them, per asset.
// Anything left blank falls back to the mid vol surface (theoretical fair value).
//
// Flowdesk (FIL) was reverse-engineered from the 28 Aug 26 structure (44d):
//   • Out-of-the-money legs → a flat, elevated wing vol (~95%), ignoring your skew.
//   • In-the-money legs      → intrinsic value only (no time premium), with the
//                              forward shaded a few % AGAINST the option they trade
//                              (down for a call they buy from you, up for a put).
const CPTY_PRICING = {
  flowdesk: {
    name: "Flowdesk",
    byAsset: {
      FIL: {
        otmFlatVol: 95,          // flat wing vol (%) applied to every OTM leg
        itmForwardLeanPct: 4.5,  // forward shaded against the traded option on ITM legs
        calibratedNote: "Calibrated from your 28 Aug 26 FIL structure (44d).",
      },
      // ETH: not calibrated yet — fill in as you trade ETH with Flowdesk.
    },
  },
  keyrock: { name: "Keyrock", byAsset: {} },  // not calibrated yet
  wave:    { name: "Wave",    byAsset: {} },  // not calibrated yet
  g20:     { name: "G20",     byAsset: {} },  // not calibrated yet
};

// Resolve the methodology for a counterparty + asset.
// Returns null for "no counterparty selected"; {uncalibrated:true} when the
// counterparty exists but we haven't calibrated it for this asset yet.
function getCptyMethod(cptyKey, asset) {
  if (!cptyKey) return null;
  const cp = CPTY_PRICING[cptyKey];
  if (!cp) return null;
  const m = cp.byAsset[asset];
  return m ? { name: cp.name, ...m } : { name: cp.name, uncalibrated: true };
}

// Apply a calibrated counterparty methodology to one leg.
// Returns { prem, ivShown, mode } or null if it can't be applied.
function applyCptyPricing(method, { spot, K, T, type, side }) {
  if (!method || method.uncalibrated) return null;
  const intrinsic = type === "C" ? Math.max(spot - K, 0) : Math.max(K - spot, 0);
  if (intrinsic <= 0) {
    // OTM leg → flat elevated wing vol (their skew, not yours)
    const sig = method.otmFlatVol / 100;
    return { prem: pricerBs(spot, K, T, 0, sig, type), ivShown: method.otmFlatVol, mode: "otm" };
  }
  // ITM leg → intrinsic only (no time value), forward leaned in their favour.
  // Call value rises with forward, put value falls. They shade the forward so
  // whatever they're trading is worth less to you:
  //   buy call → fwd up   sell call → fwd down
  //   buy put  → fwd down  sell put  → fwd up
  const lean = (method.itmForwardLeanPct || 0) / 100;
  const sign = type === "C" ? (side === "buy" ? +1 : -1) : (side === "buy" ? -1 : +1);
  const fLean = spot * (1 + sign * lean);
  const prem = type === "C" ? Math.max(fLean - K, 0) : Math.max(K - fLean, 0);
  return { prem, ivShown: 0, mode: "itm" };
}

// Plain-English methodology description shown under the selector.
function cptyMethodBoxHtml(cptyKey, asset) {
  const method = getCptyMethod(cptyKey, asset);
  if (!method) return "";
  if (method.uncalibrated) {
    return `<strong>${method.name}</strong> — no pricing methodology calibrated for ` +
      `${asset} yet. Legs are priced at the <strong>mid vol surface</strong> ` +
      `(theoretical fair value). We'll fill this in as you trade ${asset} with them.`;
  }
  return `<strong>${method.name} methodology</strong> — ${method.calibratedNote}` +
    `<ul style="margin:.35rem 0 0 .9rem;padding:0;list-style:disc">` +
    `<li><strong>Out-of-the-money legs:</strong> priced at a flat <strong>~${method.otmFlatVol}% vol</strong> ` +
    `— they quote one elevated wing vol across strikes and ignore your skew, so options cost more.</li>` +
    `<li><strong>In-the-money legs:</strong> priced at <strong>intrinsic value only</strong> (no time premium), ` +
    `with the forward shaded <strong>~${method.itmForwardLeanPct}% against you</strong> ` +
    `(down for calls they buy, up for puts they buy).</li>` +
    `</ul>`;
}

function updateCptyMethodBox() {
  const sel = document.getElementById("cpty-pricing-select");
  const box = document.getElementById("cpty-method-box");
  if (!sel || !box) return;
  const html = cptyMethodBoxHtml(sel.value, currentAsset);
  box.innerHTML = html;
  box.style.display = html ? "block" : "none";

  // Lock the manual Vol Spread when a calibrated counterparty is driving the
  // vol/skew — their methodology replaces it entirely, so it must not be editable.
  const calibrated = !!getCptyMethod(sel.value, currentAsset) && !getCptyMethod(sel.value, currentAsset).uncalibrated;
  const vs = document.getElementById("pricing-vol-spread");
  if (vs) {
    vs.disabled = calibrated;
    const wrap = vs.closest("label");
    if (wrap) { wrap.style.opacity = calibrated ? "0.4" : ""; wrap.style.pointerEvents = calibrated ? "none" : ""; }
    vs.title = calibrated
      ? `Locked — ${getCptyMethod(sel.value, currentAsset).name} pricing sets the vol/skew`
      : "Bid/ask vol spread in IV points";
  }
  const hint = document.getElementById("pricing-vol-spread-hint");
  if (hint && calibrated) hint.textContent = `set by ${getCptyMethod(sel.value, currentAsset).name} pricing`;
  else updateVolSpreadHint("pricing-vol-spread", "pricing-vol-spread-hint");
}

// ─── Bootstrap ──────────────────────────────────────────────
async function init() {
  // Fetch spot + vol surface in parallel
  const spotP = get(`/api/market/spot?asset=${currentAsset}`).catch(e => { console.error("Spot fetch failed:", e); return null; });
  const volP = get(`/api/market/vol-surface?asset=${currentAsset}`).catch(e => { console.error("Vol surface fetch failed:", e); return null; });
  const expP = get("/api/market/expirations").catch(e => { console.error("Expiry fetch failed:", e); return null; });

  const [spotData, volData, expiries] = await Promise.all([spotP, volP, expP]);

  // Spot
  if (spotData) {
    ethSpot = spotData.eth_spot || spotData.fil_spot;
    const fracDigits = currentAsset === "FIL" ? 2 : 2;
    $spot.textContent = `$${ethSpot.toLocaleString(undefined, { maximumFractionDigits: fracDigits })}`;
    $spotMin.value = currentAsset === "FIL" ? 0.2 : Math.round(ethSpot * 0.4);
    $spotMax.value = currentAsset === "FIL" ? 3.0 : Math.round(ethSpot * 2.0);
    // Set default vol spread based on asset
    const defaultSpread = currentAsset === "FIL" ? 3 : 1;
    document.getElementById("pricing-vol-spread").value = defaultSpread;
    document.getElementById("sb-vol-spread").value = defaultSpread;
    updateVolSpreadHint("pricing-vol-spread", "pricing-vol-spread-hint");
    updateVolSpreadHint("sb-vol-spread", "sb-vol-spread-hint");
  } else {
    $spot.textContent = "Error";
  }

  // Vol surface cache
  if (volData) {
    volSurface = volData;
    console.log(`Vol surface loaded: ${volData.smiles.length} expiries`);
  }

  // Expirations dropdown — prefer vol surface expiries (only ones with smile data)
  if (volData && volData.smiles.length > 0) {
    $expSel.innerHTML = "";
    for (const s of volData.smiles) {
      const opt = document.createElement("option");
      opt.value = s.expiry_code;
      opt.textContent = `${s.expiry_code} (${s.dte}d)`;
      $expSel.appendChild(opt);
    }
    $btnLoad.disabled = false;
  } else if (expiries) {
    $expSel.innerHTML = "";
    for (const exp of expiries) {
      const opt = document.createElement("option");
      opt.value = exp;
      opt.textContent = exp;
      $expSel.appendChild(opt);
    }
    $btnLoad.disabled = false;
  } else {
    $expSel.innerHTML = '<option value="">Failed to load</option>';
  }

  renderLegs();
  drawEmptyChart();

  // Load trade management on startup (it's the default page)
  tmLoad();
}

// ─── Payoff chart ───────────────────────────────────────────
function drawEmptyChart() {
  const layout = chartLayout();
  Plotly.newPlot("payoff-chart", [], layout, { responsive: true });
}

function chartLayout() {
  const cc = chartColors();
  return {
    title: { text: "Strategy Payoff at Expiry", font: { color: cc.text, size: 16 } },
    paper_bgcolor: cc.paper,
    plot_bgcolor:  cc.plot,
    xaxis: {
      title: currentAsset + " Spot Price (USD) — log scale",
      type: "log",
      color: cc.muted,
      gridcolor: cc.grid,
      zerolinecolor: cc.zeroline,
    },
    yaxis: {
      title: "P&L (USD)",
      color: cc.muted,
      gridcolor: cc.grid,
      zerolinecolor: "#f85149",
      zerolinewidth: 2,
    },
    margin: { t: 50, r: 30, b: 50, l: 60 },
    showlegend: true,
    legend: { font: { color: cc.muted } },
  };
}

async function computePayoff() {
  if (legs.length === 0) return;
  $btnCompute.classList.add("loading");

  const apiLegs = legs.map(l => ({
    strike:  parseFloat(l.strike),
    type:    l.type,
    premium: parseFloat(l.premium),
    quantity: parseFloat(l.quantity),
    is_long: l.side === "buy",
  }));

  try {
    const data = await post("/api/pricing/payoff", {
      spot_min: parseFloat($spotMin.value),
      spot_max: parseFloat($spotMax.value),
      legs: apiLegs,
      num_points: 500,
    });

    const traces = [
      {
        x: data.spots,
        y: data.pnl,
        type: "scatter",
        mode: "lines",
        name: "Total P&L",
        line: { color: "#58a6ff", width: 2.5 },
        fill: "tozeroy",
        fillcolor: "rgba(88,166,255,0.08)",
      },
    ];

    const uniqueStrikes = [...new Set(legs.map(l => parseFloat(l.strike)))];
    for (const k of uniqueStrikes) {
      traces.push({
        x: [k, k],
        y: [Math.min(...data.pnl), Math.max(...data.pnl)],
        type: "scatter",
        mode: "lines",
        name: `K=${k}`,
        line: { color: "#d29922", width: 1, dash: "dot" },
        showlegend: false,
      });
    }

    if (ethSpot) {
      traces.push({
        x: [ethSpot, ethSpot],
        y: [Math.min(...data.pnl), Math.max(...data.pnl)],
        type: "scatter",
        mode: "lines",
        name: `Spot $${fmtSpot(ethSpot)}`,
        line: { color: "#3fb950", width: 1.5, dash: "dash" },
      });
    }

    Plotly.react("payoff-chart", traces, chartLayout(), { responsive: true });
  } catch (e) {
    console.error("Payoff compute failed:", e);
    alert("Failed to compute payoff — check console.");
  } finally {
    $btnCompute.classList.remove("loading");
  }
}

// ─── Legs management ────────────────────────────────────────
function getDefaultExpiry() {
  return $expSel.value || (volSurface && volSurface.smiles.length > 0 ? volSurface.smiles[0].expiry_code : "");
}

function addLeg(side = "buy", type = "C", strike = "", premium = "0", quantity = "1", expiry = null) {
  legs.push({ side, type, strike: String(strike), premium: String(premium), quantity: String(quantity), expiry: expiry || getDefaultExpiry() });
  renderLegs();
}

function removeLeg(idx) {
  legs.splice(idx, 1);
  renderLegs();
}

function renderLegs() {
  $legsBody.innerHTML = "";
  const vsExpiries = volSurface && volSurface.smiles
    ? volSurface.smiles.map(s => s.expiry_code)
    : [];
  // Include custom expiries from legs that aren't in the vol surface (e.g., OTC dates)
  const legExpiries = legs.map(l => l.expiry).filter(e => e && !vsExpiries.includes(e));
  const expiryOptions = [...vsExpiries, ...new Set(legExpiries)];

  legs.forEach((leg, i) => {
    const expOpts = expiryOptions.map(e =>
      `<option value="${e}" ${leg.expiry === e ? "selected" : ""}>${e}</option>`
    ).join("");

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <select data-i="${i}" data-field="expiry" style="font-size:.72rem">${expOpts}</select>
      </td>
      <td class="side-type-cell">
        <select data-i="${i}" data-field="side" style="width:48%">
          <option value="buy"  ${leg.side === "buy"  ? "selected" : ""}>Buy</option>
          <option value="sell" ${leg.side === "sell" ? "selected" : ""}>Sell</option>
        </select>
        <select data-i="${i}" data-field="type" style="width:48%">
          <option value="C" ${leg.type === "C" ? "selected" : ""}>Call</option>
          <option value="P" ${leg.type === "P" ? "selected" : ""}>Put</option>
          <option value="PERP" ${leg.type === "PERP" ? "selected" : ""}>Perp</option>
        </select>
      </td>
      <td><input type="number" data-i="${i}" data-field="strike" value="${leg.strike}" step="10" ${leg.type === "PERP" ? 'title="Entry price"' : ""}></td>
      <td><input type="number" data-i="${i}" data-field="quantity" value="${leg.quantity}" step="1" min="1"></td>
      <td><button class="btn-remove" data-i="${i}">✕</button></td>
    `;
    $legsBody.appendChild(tr);
  });

  $legsBody.querySelectorAll("select, input").forEach(el => {
    el.addEventListener("change", () => {
      const idx = parseInt(el.dataset.i);
      legs[idx][el.dataset.field] = el.value;
    });
  });

  $legsBody.querySelectorAll(".btn-remove").forEach(btn => {
    btn.addEventListener("click", () => removeLeg(parseInt(btn.dataset.i)));
  });
}

// ─── Strategy templates ─────────────────────────────────────
function applyTemplate(name) {
  const isFil = currentAsset === "FIL";
  const s = isFil
    ? (ethSpot ? Math.round(ethSpot * 20) / 20 : 1.0)
    : (ethSpot ? Math.round(ethSpot / 100) * 100 : 2800);
  // Strike offsets scaled per asset
  const w = isFil ? 0.1 : 200;   // wing width (narrow spread)
  const W = isFil ? 0.25 : 500;  // wing width (wide spread)
  const ww = isFil ? 0.3 : 600;  // iron condor outer wing
  const r = (v) => isFil ? Math.round(v * 100) / 100 : Math.round(v);
  legs = [];

  switch (name) {
    case "long_call":
      addLeg("buy", "C", r(s), "0");
      break;
    case "long_put":
      addLeg("buy", "P", r(s), "0");
      break;
    case "bull_call_spread":
      addLeg("buy",  "C", r(s),       "0");
      addLeg("sell", "C", r(s + W),   "0");
      break;
    case "bear_put_spread":
      addLeg("buy",  "P", r(s),       "0");
      addLeg("sell", "P", r(s - W),   "0");
      break;
    case "straddle":
      addLeg("buy", "C", r(s), "0");
      addLeg("buy", "P", r(s), "0");
      break;
    case "strangle":
      addLeg("buy", "C", r(s + w), "0");
      addLeg("buy", "P", r(s - w), "0");
      break;
    case "iron_condor":
      addLeg("buy",  "P", r(s - ww), "0");
      addLeg("sell", "P", r(s - w),  "0");
      addLeg("sell", "C", r(s + w),  "0");
      addLeg("buy",  "C", r(s + ww), "0");
      break;
    case "long_perp":
      addLeg("buy", "PERP", r(s), "0");
      break;
    case "short_perp":
      addLeg("sell", "PERP", r(s), "0");
      break;
  }
  renderLegs();

  document.querySelectorAll(".btn-template").forEach(b => b.classList.remove("active"));
  const active = document.querySelector(`.btn-template[data-strategy="${name}"]`);
  if (active) active.classList.add("active");
}

// ─── Option chain loading ───────────────────────────────────
async function loadChain() {
  const expiry = $expSel.value;
  if (!expiry) return;

  $btnLoad.disabled = true;
  $btnLoad.textContent = "Loading…";

  try {
    optionChain = await get(`/api/market/options?expiry=${expiry}`);

    optionChain.sort((a, b) => {
      const sa = parseFloat(a.instrument_name.split("-")[2]);
      const sb = parseFloat(b.instrument_name.split("-")[2]);
      if (sa !== sb) return sa - sb;
      return a.instrument_name < b.instrument_name ? -1 : 1;
    });

    $chainExp.textContent = expiry;
    $chainBody.innerHTML = "";

    for (const opt of optionChain) {
      const parts = opt.instrument_name.split("-");
      const strike = parts[2];
      const optType = parts[3];
      const isCall = optType === "C";

      const tr = document.createElement("tr");
      tr.className = isCall ? "call-row" : "put-row";
      tr.innerHTML = `
        <td style="text-align:left; font-family:monospace; font-size:.72rem">${opt.instrument_name}</td>
        <td style="text-align:center; color:${isCall ? 'var(--green)' : 'var(--red)'}">${optType}</td>
        <td>${strike}</td>
        <td>${opt.mark_price != null ? opt.mark_price.toFixed(4) : "—"}</td>
        <td>${opt.mark_iv != null ? opt.mark_iv.toFixed(1) : "—"}</td>
        <td>${opt.delta != null ? opt.delta.toFixed(3) : "—"}</td>
        <td>${opt.gamma != null ? opt.gamma.toFixed(5) : "—"}</td>
        <td>${opt.theta != null ? opt.theta.toFixed(4) : "—"}</td>
        <td>${opt.vega != null ? opt.vega.toFixed(4) : "—"}</td>
        <td>${opt.best_bid != null ? opt.best_bid.toFixed(4) : "—"}</td>
        <td>${opt.best_ask != null ? opt.best_ask.toFixed(4) : "—"}</td>
        <td><button class="btn-add-chain" data-name="${opt.instrument_name}">+ Add</button></td>
      `;
      $chainBody.appendChild(tr);
    }

    $chainBody.querySelectorAll(".btn-add-chain").forEach(btn => {
      btn.addEventListener("click", () => addFromChain(btn.dataset.name));
    });

    $chainSec.style.display = "block";
  } catch (e) {
    console.error("Chain load failed:", e);
    alert("Failed to load option chain. See console.");
  } finally {
    $btnLoad.disabled = false;
    $btnLoad.textContent = "Load Option Chain";
  }
}

function addFromChain(instrumentName) {
  const opt = optionChain.find(o => o.instrument_name === instrumentName);
  if (!opt) return;

  const parts = instrumentName.split("-");
  const chainExpiry = parts[1];  // e.g. "27JUN25"
  const strike = parts[2];
  const type = parts[3];
  const premiumEth = opt.mark_price || 0;
  const premiumUsd = ethSpot ? fmtPrem(premiumEth * ethSpot) : premiumEth.toFixed(4);

  addLeg("buy", type, strike, premiumUsd, "1", chainExpiry);
}

// ─── Deribit Replication Pricing (client-side, uses cached vol surface) ──
let lastReplPremiums = [];

function replicateStrategy() {
  if (legs.length === 0) { alert("Add at least one leg."); return; }
  for (const l of legs) {
    const s = parseFloat(l.strike);
    if (isNaN(s) || s <= 0) { alert("Each leg must have a valid strike price."); return; }
    if (!l.expiry) { alert("Each leg must have an expiry selected."); return; }
  }
  if (!volSurface) { alert("Vol surface not loaded yet — wait for page init."); return; }

  // Validate all expiries have smile data (exact or interpolated)
  const uniqueExpiries = [...new Set(legs.map(l => l.expiry))];
  for (const exp of uniqueExpiries) {
    const smile = getSmileForExpiry(exp);
    if (!smile) {
      alert(`Cannot price expiry ${exp} — no vol smile data available and cannot interpolate. Need at least 2 Deribit expiries to bracket this date.`);
      return;
    }
    if (smile._synthetic) {
      console.log(`Using interpolated vol smile for ${exp} (DTE ${smile.dte}d) — no exact Deribit match`);
    }
  }

  const spot = ethSpot;
  const spotMin = parseFloat($spotMin.value);
  const spotMax = parseFloat($spotMax.value);
  const nPts = 500;
  const spots = [];
  for (let i = 0; i < nPts; i++) spots.push(spotMin + (spotMax - spotMin) * i / (nPts - 1));

  // P&L at all-expired (every leg at intrinsic)
  const pnlAllExpired = new Array(nPts).fill(0);
  // P&L now (BS value with each leg's own T)
  const pnlNow = new Array(nPts).fill(0);
  // P&L at first expiry (near-term legs at intrinsic, far legs at BS with remaining T)
  const sortedExpiries = uniqueExpiries.map(e => ({ code: e, dte: getSmileForExpiry(e).dte })).sort((a, b) => a.dte - b.dte);
  const firstDte = sortedExpiries[0].dte;
  const lastDte = sortedExpiries[sortedExpiries.length - 1].dte;
  const pnlFirstExpiry = new Array(nPts).fill(0);

  const legDetails = [];

  const volSpreadPts = parseFloat(document.getElementById("pricing-vol-spread").value) || 0;

  // Counterparty pricing methodology (Flowdesk, etc.). When one is selected and
  // calibrated for this asset, it overrides the quoted premium + reported IV per
  // leg (payoff curves stay on the fair mid, like the vol-spread does).
  const cptyKey = (document.getElementById("cpty-pricing-select") || {}).value || "";
  const cptyMethod = getCptyMethod(cptyKey, currentAsset);
  const cptyCalibrated = !!(cptyMethod && !cptyMethod.uncalibrated);

  for (const l of legs) {
    const K = parseFloat(l.strike);
    const qty = parseFloat(l.quantity);
    const dir = l.side === "buy" ? 1 : -1;
    const smile = getSmileForExpiry(l.expiry);
    const dte = smile.dte;
    const T = Math.max(dte, 0) / 365.25;
    let ivPct = lookupSmileIv(l.expiry, K);
    if (ivPct == null) { alert(`Cannot interpolate IV for strike ${K} on ${l.expiry}.`); return; }
    const sigma = ivPct / 100;  // mid IV — used to mark fair value & report

    // MID premium (fair value) — this is what the PAYOFF CURVES use, so the
    // diagram stays clean (breakevens at fair value, "P&L now" through ~0 at
    // the current spot). The bid/ask spread only affects the cost summary below.
    const premMid = pricerBs(spot, K, T, 0, sigma, l.type);

    // Executed (bid/ask) premium for the cost summary + per-leg table. Centred
    // on the mid, half-width = local vega × spread (a bid/ask quoted in vol,
    // converted to a premium spread). Applying ±spread to IV and repricing was
    // convex — it inflated buy premiums and collapsed OTM sell premiums to 0.
    let prem = premMid;
    let ivDisplay = ivPct;   // IV shown in the per-leg table
    let cpMode = null;       // "otm" | "itm" when a counterparty methodology applied
    if (cptyCalibrated) {
      // Counterparty marks replace both the mid vol-spread and the reported IV.
      const cpRes = applyCptyPricing(cptyMethod, { spot, K, T, type: l.type, side: l.side });
      if (cpRes) { prem = cpRes.prem; ivDisplay = cpRes.ivShown; cpMode = cpRes.mode; }
    } else if (volSpreadPts > 0) {
      const vegaPt = Math.abs(pricerBs(spot, K, T, 0, (ivPct + 1) / 100, l.type)
                            - pricerBs(spot, K, T, 0, Math.max(ivPct - 1, 1) / 100, l.type)) / 2;
      const halfWidth = vegaPt * volSpreadPts;
      prem = l.side === "buy" ? premMid + halfWidth : Math.max(premMid - halfWidth, 0);
    }
    const premEth = spot > 0 ? prem / spot : 0;

    // Delta this position creates: per-contract delta × signed quantity (underlying units).
    const deltaPer = pricerDelta(spot, K, T, 0, sigma, l.type);
    const posDelta = dir * qty * deltaPer;

    // Cost basis for the payoff curves. With a counterparty selected the
    // breakevens must reflect what you actually transact at (their premium).
    // On mid fair value we keep the clean MID premium (unbiased by bid/ask).
    const costBasis = cptyCalibrated ? prem : premMid;

    for (let i = 0; i < nPts; i++) {
      const intrinsic = l.type === "C" ? Math.max(spots[i] - K, 0) : Math.max(K - spots[i], 0);

      // All expired
      pnlAllExpired[i] += dir * qty * (intrinsic - costBasis);

      // Now (full BS value)
      const valNow = pricerBs(spots[i], K, T, 0, sigma, l.type);
      pnlNow[i] += dir * qty * (valNow - costBasis);

      // At first expiry: legs expiring then → intrinsic, others → BS with remaining time
      const remainingDte = dte - firstDte;
      if (remainingDte <= 0) {
        pnlFirstExpiry[i] += dir * qty * (intrinsic - costBasis);
      } else {
        const Tremain = remainingDte / 365.25;
        const valRemain = pricerBs(spots[i], K, Tremain, 0, sigma, l.type);
        pnlFirstExpiry[i] += dir * qty * (valRemain - costBasis);
      }
    }

    const isSynthetic = !!(smile && smile._synthetic);
    legDetails.push({
      expiry: l.expiry, dte, strike: K, type: l.type, side: l.side, quantity: qty,
      iv_pct: ivPct, iv_display: ivDisplay, sigma, bs_premium_usd: prem, bs_premium_eth: premEth,
      delta_per: deltaPer, position_delta: posDelta,
      _synthetic: isSynthetic, cp_mode: cpMode,
    });
  }

  lastReplPremiums = legDetails.map(l => l.bs_premium_usd);

  // Total cost breakdown: pay (buys) vs receive (sells)
  let totalPay = 0, totalReceive = 0;
  for (const d of legDetails) {
    const amt = d.quantity * d.bs_premium_usd;
    if (d.side === "buy") totalPay += amt;
    else totalReceive += amt;
  }
  const net = totalReceive - totalPay;
  const netEth = spot > 0 ? net / spot : 0;

  // Net delta the whole structure creates, in underlying units and USD notional.
  const totalDelta = legDetails.reduce((s, d) => s + d.position_delta, 0);
  const totalDeltaUsd = totalDelta * spot;

  // Summary
  const expiryLabel = uniqueExpiries.length === 1
    ? uniqueExpiries[0]
    : uniqueExpiries.join(" / ");
  // Show sub-dollar precision for small amounts (FIL per-contract premiums are
  // fractions of a dollar — rounding to whole dollars was showing a real credit
  // as "$0"); whole dollars once the amount is material.
  const fmtUsd = v => {
    const a = Math.abs(v);
    const dp = a === 0 ? 0 : a < 1000 ? (currentAsset === "FIL" ? 4 : 2) : 0;
    return "$" + a.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  };
  const payColor = totalPay > 0 ? "var(--red)" : "var(--muted)";
  const rcvColor = totalReceive > 0 ? "var(--green)" : "var(--muted)";
  const netLabel = net >= 0 ? "Rcv" : "Pay";
  const netColor = net >= 0 ? "var(--green)" : "var(--red)";
  // Determine pricing source
  const hasSynthetic = legDetails.some(d => d._synthetic);
  const allSynthetic = legDetails.every(d => d._synthetic);
  let sourceNote = "";
  if (cptyCalibrated) {
    sourceNote = `<div style="margin-top:4px;font-size:.7rem;color:#58a6ff;line-height:1.35">` +
      `Prices: <strong>${cptyMethod.name} counterparty marks</strong> — OTM legs at a flat ` +
      `~${cptyMethod.otmFlatVol}% wing vol, ITM legs at intrinsic (forward shaded ` +
      `~${cptyMethod.itmForwardLeanPct}%). See methodology above the legs.</div>`;
  } else if (cptyMethod && cptyMethod.uncalibrated) {
    sourceNote = `<div style="margin-top:4px;font-size:.7rem;color:#f0883e;line-height:1.35">` +
      `<strong>${cptyMethod.name}</strong> has no methodology calibrated for ${currentAsset} yet — ` +
      `showing <strong>mid vol surface</strong> fair values. We'll fill it in as you trade ${currentAsset} with them.</div>`;
  } else if (allSynthetic) {
    sourceNote = `<div style="margin-top:4px;font-size:.7rem;color:#f0883e;line-height:1.3">` +
      `Prices: <strong>BS model with interpolated vol surface</strong> — no exact Deribit expiry match. ` +
      `These are theoretical fair values, not live market quotes. Execution prices (bid/ask) will differ.</div>`;
  } else if (hasSynthetic) {
    sourceNote = `<div style="margin-top:4px;font-size:.7rem;color:#f0883e;line-height:1.3">` +
      `Some expiries use <strong>interpolated vol</strong> (marked with *). ` +
      `These are theoretical BS values — execution prices from the Workbench (live Deribit) are more accurate.</div>`;
  } else {
    sourceNote = `<div style="margin-top:4px;font-size:.7rem;color:var(--muted);line-height:1.3">` +
      `Prices: <strong>BS model with Deribit vol surface</strong> — theoretical fair values. ` +
      `For execution prices, use the Optimizer Workbench (live bid/ask).</div>`;
  }

  const $summary = document.getElementById("repl-summary");
  $summary.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">` +
    `<span>Expiry: <strong>${expiryLabel}</strong> &nbsp;|&nbsp; ${currentAsset} = $${fmtSpot(spot)}</span>` +
    `<span style="display:flex;gap:1rem;font-size:.95rem">` +
    `<span>Pay: <strong style="color:${payColor}">${fmtUsd(totalPay)}</strong></span>` +
    `<span>Receive: <strong style="color:${rcvColor}">${fmtUsd(totalReceive)}</strong></span>` +
    `<span>Net: <strong style="color:${netColor}">${netLabel} ${fmtUsd(net)}</strong> (${netEth.toFixed(4)} ${currentAsset})</span>` +
    `<span>Net Δ: <strong style="color:${totalDelta >= 0 ? 'var(--green)' : 'var(--red)'}">${totalDelta >= 0 ? '+' : ''}${totalDelta.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${currentAsset}</strong> <span style="color:var(--muted)">(${fmtUsd(totalDeltaUsd)})</span></span>` +
    (!cptyCalibrated && volSpreadPts > 0 ? `<span style="font-size:.7rem;color:var(--muted)">vol &plusmn;${volSpreadPts}pts</span>` : "") +
    `</span></div>` + sourceNote;

  // Per-leg table
  const $body = document.getElementById("repl-body");
  $body.innerHTML = "";
  for (const d of legDetails) {
    const tr = document.createElement("tr");
    const sideColor = d.side === "buy" ? "var(--accent)" : "var(--orange)";
    const typeColor = d.type === "C" ? "var(--green)" : "var(--red)";
    let srcLabel;
    if (d.cp_mode) {
      const cpName = cptyMethod.name;
      srcLabel = d.cp_mode === "otm"
        ? `<span style="color:#58a6ff;font-weight:600" title="${cpName} marks OTM legs at a flat wing vol">${cpName} · flat vol</span>`
        : `<span style="color:#58a6ff;font-weight:600" title="${cpName} marks ITM legs at intrinsic, forward shaded against you">${cpName} · intrinsic</span>`;
    } else if (d._synthetic) {
      srcLabel = `<span style="color:#f0883e;font-weight:600" title="Vol interpolated between nearest Deribit expiries — theoretical, not live">Interpolated*</span>`;
    } else {
      srcLabel = `<span style="color:var(--muted)" title="Vol from Deribit vol surface — theoretical BS fair value">Vol Surface</span>`;
    }
    const ivCell = d.cp_mode === "itm"
      ? `<span title="Intrinsic value only — no time premium">intr</span>`
      : `${(d.iv_display).toFixed(1)}%`;
    tr.innerHTML = `
      <td style="font-size:.75rem">${d.expiry}</td>
      <td style="color:${sideColor}">${d.side.toUpperCase()}</td>
      <td style="color:${typeColor}">${d.type === "C" ? "Call" : "Put"}</td>
      <td>${fmtStrike(d.strike)}</td>
      <td>${d.dte}d</td>
      <td>${ivCell}</td>
      <td style="font-family:monospace">${d.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
      <td style="font-family:monospace">$${fmtPrem(d.bs_premium_usd)}</td>
      <td style="font-family:monospace;color:${d.side === 'sell' ? 'var(--green)' : 'var(--red)'}">$${fmtPremTotal(d.quantity * d.bs_premium_usd)}</td>
      <td style="font-family:monospace;color:var(--muted)">${d.delta_per.toFixed(3)}</td>
      <td style="font-family:monospace;color:${d.position_delta >= 0 ? 'var(--green)' : 'var(--red)'}">${d.position_delta >= 0 ? '+' : ''}${d.position_delta.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
      <td style="font-size:.68rem">${srcLabel}</td>
    `;
    $body.appendChild(tr);
  }
  // Totals footer — net delta across all priced legs
  const $foot = document.createElement("tr");
  $foot.style.borderTop = "2px solid var(--border)";
  $foot.style.fontWeight = "600";
  $foot.innerHTML =
    `<td colspan="8" style="text-align:right;color:var(--muted)">Total position delta &rarr;</td>` +
    `<td></td><td></td>` +
    `<td style="font-family:monospace;color:${totalDelta >= 0 ? 'var(--green)' : 'var(--red)'}">${totalDelta >= 0 ? '+' : ''}${totalDelta.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${currentAsset}</td>` +
    `<td style="font-size:.68rem;color:var(--muted)">${fmtUsd(totalDeltaUsd)}</td>`;
  $body.appendChild($foot);
  document.getElementById("repl-results-section").style.display = "block";

  // Payoff chart
  const allPnl = [...pnlAllExpired, ...pnlNow, ...pnlFirstExpiry];
  const yMin = Math.min(...allPnl);
  const yMax = Math.max(...allPnl);

  const traces = [];

  // If multi-expiry, show first expiry curve
  const isMultiExpiry = uniqueExpiries.length > 1;
  if (isMultiExpiry) {
    traces.push({ x: spots, y: pnlFirstExpiry, type: "scatter", mode: "lines",
      name: `P&L at 1st Expiry (${sortedExpiries[0].code}, ${firstDte}d)`,
      line: { color: "#bc8cff", width: 2, dash: "dash" } });
  }

  traces.push({ x: spots, y: pnlAllExpired, type: "scatter", mode: "lines",
    name: isMultiExpiry ? `P&L All Expired (${sortedExpiries[sortedExpiries.length-1].code})` : "P&L at Expiry",
    line: { color: "#58a6ff", width: 2.5 } });

  traces.push({ x: spots, y: pnlNow, type: "scatter", mode: "lines",
    name: "P&L Now", line: { color: "#d29922", width: 2, dash: "dash" } });

  const uniqueStrikes = [...new Set(legDetails.map(l => l.strike))];
  for (const k of uniqueStrikes) {
    traces.push({ x: [k, k], y: [yMin, yMax], type: "scatter", mode: "lines",
      name: `K=${fmtStrike(k)}`, showlegend: false, line: { color: "#8b949e", width: 1, dash: "dot" } });
  }

  traces.push({ x: [spot, spot], y: [yMin, yMax], type: "scatter", mode: "lines",
    name: `Spot $${fmtSpot(spot)}`, line: { color: "#3fb950", width: 1.5, dash: "dash" } });

  Plotly.react("payoff-chart", traces, chartLayout(), { responsive: true });

  // Vol smile chart — show the first expiry's smile with all legs marked
  const primarySmile = getSmileForExpiry(sortedExpiries[0].code);
  drawSmileChart(primarySmile, legDetails);
}

function drawSmileChart(smile, pricedLegs) {
  const $el = document.getElementById("smile-chart");
  $el.style.display = "block";

  // smile can be either {smile_strikes, smile_ivs, observed_strikes, observed_ivs} (old backend format)
  // or {strikes, ivs, expiry_code, dte} (new cached format)
  const obsStrikes = smile.observed_strikes || smile.strikes || [];
  const obsIvs = smile.observed_ivs || smile.ivs || [];

  // Generate a dense interpolated curve from the observed points
  let interpStrikes = obsStrikes;
  let interpIvs = obsIvs;
  if (smile.smile_strikes) {
    interpStrikes = smile.smile_strikes;
    interpIvs = smile.smile_ivs;
  } else if (obsStrikes.length >= 2) {
    // Linearly interpolate a dense curve
    const lo = obsStrikes[0] * 0.85;
    const hi = obsStrikes[obsStrikes.length - 1] * 1.15;
    interpStrikes = [];
    interpIvs = [];
    for (let k = lo; k <= hi; k += (hi - lo) / 200) {
      interpStrikes.push(k);
      interpIvs.push(lookupSmileIv(smile.expiry_code, k) ?? obsIvs[0]);
    }
  }

  const traces = [
    {
      x: interpStrikes, y: interpIvs,
      type: "scatter", mode: "lines",
      name: "Vol Smile (interpolated)",
      line: { color: "#58a6ff", width: 2 },
    },
    {
      x: obsStrikes, y: obsIvs,
      type: "scatter", mode: "markers",
      name: currentAsset === "FIL" ? "Proxy IV (ETH-scaled)" : "Deribit Market IV",
      marker: { color: "#e6edf3", size: 5, symbol: "circle", opacity: 0.6 },
    },
  ];

  for (const leg of pricedLegs) {
    traces.push({
      x: [leg.strike], y: [leg.iv_pct],
      type: "scatter", mode: "markers+text",
      name: `${leg.side.toUpperCase()} ${leg.type} ${leg.strike}`,
      marker: {
        color: leg.type === "C" ? "#3fb950" : "#f85149",
        size: 12,
        symbol: leg.side === "buy" ? "triangle-up" : "triangle-down",
        line: { color: "#fff", width: 1 },
      },
      text: [`${leg.iv_pct.toFixed(1)}%`],
      textposition: "top center",
      textfont: { color: chartColors().text, size: 10 },
    });
  }

  const smileLabel = currentAsset === "FIL" ? "Proxy IV Smile (ETH-scaled)" : "Deribit IV Smile";
  const title = smile.expiry_code
    ? `${smileLabel} — ${smile.expiry_code} (${smile.dte}d)`
    : smileLabel;

  const cc = chartColors();
  const layout = {
    title: { text: title, font: { color: cc.text, size: 16 } },
    paper_bgcolor: cc.paper,
    plot_bgcolor: cc.plot,
    xaxis: { title: "Strike (USD)", color: cc.muted, gridcolor: cc.grid },
    yaxis: { title: "Implied Volatility (%)", color: cc.muted, gridcolor: cc.grid },
    margin: { t: 50, r: 30, b: 50, l: 60 },
    showlegend: true,
    legend: { font: { color: cc.muted } },
  };

  Plotly.react("smile-chart", traces, layout, { responsive: true });
}

function applyReplPremiums() {
  if (lastReplPremiums.length !== legs.length) return;
  for (let i = 0; i < legs.length; i++) {
    legs[i].premium = fmtPrem(lastReplPremiums[i]);
  }
  renderLegs();
  document.getElementById("repl-results-section").style.display = "none";
}

// ─── Event binding ──────────────────────────────────────────
$btnAdd.addEventListener("click", () => addLeg());
$btnCompute.addEventListener("click", computePayoff);
$btnRepl.addEventListener("click", replicateStrategy);
document.getElementById("pricing-vol-spread").addEventListener("input", () => updateVolSpreadHint("pricing-vol-spread", "pricing-vol-spread-hint"));
updateVolSpreadHint("pricing-vol-spread", "pricing-vol-spread-hint");
document.getElementById("cpty-pricing-select").addEventListener("change", () => {
  updateCptyMethodBox();
  // Re-price immediately if results are already on screen.
  if (document.getElementById("repl-results-section").style.display === "block") replicateStrategy();
});
updateCptyMethodBox();
document.getElementById("btn-apply-repl").addEventListener("click", applyReplPremiums);

// Send Pricing legs → Strategy Builder
document.getElementById("btn-send-to-sb").addEventListener("click", () => {
  if (legs.length === 0) { alert("No legs to send — add legs first."); return; }
  for (const l of legs) {
    sbAddLeg(l.side, l.type, parseFloat(l.strike) || 0, parseFloat(l.quantity) || 1000, l.expiry || "");
  }
  // Switch to Strategy Builder tab
  document.querySelector('[data-page="structurer"]').click();
  sbRenderLegs();
});
$btnLoad.addEventListener("click", loadChain);

document.querySelectorAll(".btn-template").forEach(btn => {
  btn.addEventListener("click", () => applyTemplate(btn.dataset.strategy));
});

[$spotMin, $spotMax].forEach(el => {
  el.addEventListener("keydown", e => { if (e.key === "Enter") computePayoff(); });
});

// ─── Asset switcher ─────────────────────────────────────────
document.querySelectorAll(".asset-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const asset = btn.dataset.asset;
    if (asset === currentAsset) return;
    currentAsset = asset;
    document.querySelectorAll(".asset-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("asset-label").textContent = asset;

    // Optimizer V2 Max Qty default is asset-scaled — FIL trades in much
    // larger contract counts at a much smaller unit price than ETH.
    const $optv2MaxQty = document.getElementById("optv2-max-qty");
    if ($optv2MaxQty) $optv2MaxQty.value = asset === "FIL" ? 5000000 : 5000;

    // Delta rehedge band is likewise asset-scaled (same ~1000x factor as Max
    // Qty above) — 75 is calibrated for ETH; left at that for FIL it's ~$52
    // of notional, trivial next to real FIL position sizes, so the rehedge
    // would fire on virtually any nonzero mismatch and fully flatten delta
    // every time instead of acting as an actual band.
    const $optv2DeltaBand = document.getElementById("optv2-delta-band");
    if ($optv2DeltaBand) $optv2DeltaBand.value = asset === "FIL" ? 75000 : 75;

    // Reset all page caches so they reload with new asset
    tmLoaded = false;
    portfolioLoaded = false;
    dealsLoaded = false;
    sbLoaded = false;
    pfData = null;

    // Optimizer chat: clear cached portfolio data, baseline, chat history,
    // workbench, and added/closed trade state — they're asset-specific.
    if (typeof opt2Loaded !== "undefined") opt2Loaded = false;
    if (typeof opt2Data !== "undefined") opt2Data = null;
    if (typeof opt2Baseline !== "undefined") opt2Baseline = null;
    if (typeof opt2ChatHistory !== "undefined") opt2ChatHistory = [];
    if (typeof opt2WbLegs !== "undefined") opt2WbLegs = [];
    if (typeof opt2AddedTrades !== "undefined") opt2AddedTrades = [];
    if (typeof opt2ClosedTradeIds !== "undefined") opt2ClosedTradeIds = [];
    if (typeof opt2ScenarioTrades !== "undefined") opt2ScenarioTrades = [];
    const $log = document.getElementById("opt2-chat-log");
    if ($log) $log.innerHTML = "";

    // Fetch spot + vol surface for the new asset, then reload page
    Promise.all([
      get(`/api/market/spot?asset=${asset}`).catch(() => null),
      get(`/api/market/vol-surface?asset=${asset}`).catch(() => null),
    ]).then(([spotData, volData]) => {
      if (spotData) {
        ethSpot = spotData.eth_spot || spotData.fil_spot;
        document.getElementById("eth-spot").textContent = `$${ethSpot.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
        // Update pricer spot range for the asset
        $spotMin.value = asset === "FIL" ? 0.2 : Math.round(ethSpot * 0.4);
        $spotMax.value = asset === "FIL" ? 3.0 : Math.round(ethSpot * 2.0);
        // Default vol spread: wider for FIL (illiquid OTC), tighter for ETH
        const defaultSpread = asset === "FIL" ? 3 : 1;
        document.getElementById("pricing-vol-spread").value = defaultSpread;
        document.getElementById("sb-vol-spread").value = defaultSpread;
        updateVolSpreadHint("pricing-vol-spread", "pricing-vol-spread-hint");
        updateVolSpreadHint("sb-vol-spread", "sb-vol-spread-hint");
        updateCptyMethodBox();  // methodology text is asset-specific
      }
      if (volData) {
        volSurface = volData;
      }
      // Reload current page after data is ready
      const activePage = document.querySelector(".nav-item.active");
      if (activePage) activePage.click();
    });
  });
});

// ─── Sidebar page switching ─────────────────────────────────
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    item.classList.add("active");
    const page = document.getElementById(`page-${item.dataset.page}`);
    if (page) page.classList.add("active");

    const pg = item.dataset.page;

    // Show/hide FIL banners and Deribit-only elements
    const isFil = currentAsset === "FIL";
    const pricingBanner = document.getElementById("pricing-fil-banner");
    const rollBanner = document.getElementById("roll-fil-banner");
    if (pricingBanner) pricingBanner.style.display = "none";  // no longer needed — FIL pricer works
    if (rollBanner) rollBanner.style.display = "none";

    // Hide Deribit option chain for FIL (no exchange-listed FIL options)
    const chainBtn = document.getElementById("btn-load-chain");
    const chainSec = document.getElementById("chain-section");
    if (chainBtn) chainBtn.style.display = isFil ? "none" : "";
    if (chainSec && isFil) chainSec.style.display = "none";

    // Show/hide FIL proxy IV methodology banner
    const proxyBanner = document.getElementById("pricing-proxy-banner");
    if (proxyBanner) proxyBanner.style.display = (isFil && pg === "pricing") ? "flex" : "none";

    // Lazy-load pages
    if (pg === "trades" && !tmLoaded) tmLoad();
    if (pg === "pricing") {
      // Plotly may have rendered at 0 width while page was hidden — trigger resize
      setTimeout(() => {
        const pc = document.getElementById("payoff-chart");
        const sc = document.getElementById("smile-chart");
        if (pc && pc.data) Plotly.Plots.resize(pc);
        if (sc && sc.data) Plotly.Plots.resize(sc);
      }, 50);
    }
    if (pg === "portfolio" && !portfolioLoaded) loadPortfolio();
    if (pg === "deals" && !dealsLoaded) dealsInit();
    if (pg === "deals") {
      setTimeout(() => {
        const dc = document.getElementById("deals-payoff-chart");
        if (dc && dc.data) Plotly.Plots.resize(dc);
      }, 50);
    }
    if (pg === "roll" && !rollLoaded && !isFil) rollInit();
    if (pg === "optv3" && !optv3Loaded) optv3Init();
    if (pg === "optv3") {
      setTimeout(() => { const c = document.getElementById("optv3-payoff-chart"); if (c && c.data) Plotly.Plots.resize(c); }, 50);
    }
    if (pg === "structurer" && !sbLoaded) sbInit();
    if (pg === "volcurve" && !vcLoaded) vcInit();
    if (pg === "volcurve") {
      setTimeout(() => {
        const vc = document.getElementById("volcurve-chart");
        if (vc && vc.data) Plotly.Plots.resize(vc);
      }, 50);
    }
    if (pg === "mtmhistory") {
      mtmhLoadPage();
      setTimeout(() => {
        const c = document.getElementById("mtmh-chart");
        if (c && c.data) Plotly.Plots.resize(c);
      }, 60);
    }
    if (pg === "collateral") { collatLoad(); }
    // execution is now a subtab inside structurer, not a standalone page
  });
});

// ─── Sub-tab switching (Roll & Optimizer page) ──────────────
document.querySelectorAll(".sub-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const parent = btn.closest(".page");
    parent.querySelectorAll(".sub-tab-btn").forEach(b => b.classList.remove("active"));
    parent.querySelectorAll(".sub-tab-pane").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    const pane = document.getElementById(`subtab-${btn.dataset.subtab}`);
    if (pane) pane.classList.add("active");

    // Lazy-load optimizer
    if (btn.dataset.subtab === "optimizer" && !opt2Loaded) opt2Init();
    if (btn.dataset.subtab === "optimizer") {
      setTimeout(() => { const el = document.getElementById("opt2-ask"); if (el) el.focus(); }, 100);
      optv2LoadSnapshots();
    }
    if (btn.dataset.subtab === "sb-execution" && !execLoaded) execInit();

    // Populate recon counterparties when switching to recon tab
    if (btn.dataset.subtab === "tm-recon") {
      rcPopulateCounterparties();
      rcLoadHistory();
      const lbl = document.getElementById("rc-asset-label");
      if (lbl) lbl.textContent = currentAsset;
      if (rcTheirTrades.length === 0) rcAddRow();
    }
  });
});

// ─── Theme toggle ───────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem("plgo-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  updateThemeIcons();
})();

document.getElementById("btn-theme-toggle").addEventListener("click", () => {
  const current = document.documentElement.dataset.theme;
  const next = current === "light" ? "dark" : "light";
  if (next === "dark") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = next;
  }
  localStorage.setItem("plgo-theme", next);
  updateThemeIcons();
  recolorCharts();
});

function updateThemeIcons() {
  const isLight = document.documentElement.dataset.theme === "light";
  document.getElementById("icon-moon").style.display = isLight ? "none" : "block";
  document.getElementById("icon-sun").style.display = isLight ? "block" : "none";
}

function recolorCharts() {
  const cc = chartColors();
  const update = {
    paper_bgcolor: cc.paper,
    plot_bgcolor: cc.plot,
    "title.font.color": cc.text,
    "xaxis.color": cc.muted,
    "xaxis.gridcolor": cc.grid,
    "yaxis.color": cc.muted,
    "yaxis.gridcolor": cc.grid,
    "legend.font.color": cc.muted,
    "legend.bgcolor": cc.legendBg,
    "legend.bordercolor": cc.legendBorder,
    "xaxis.zerolinecolor": cc.zeroline,
    "xaxis.tickfont.color": cc.muted,
    "yaxis.tickfont.color": cc.muted,
  };
  document.querySelectorAll(".js-plotly-plot").forEach(el => {
    Plotly.relayout(el, update).catch(() => {});
  });
}

// ─── Trade Management ───────────────────────────────────────
let tmTrades = [];
let tmEnriched = [];
let tmLoaded = false;
let tmShowExpired = false;
let tmSortCol = "expiry";
let tmSortAsc = true;

async function tmLoad() {
  const tmBody = document.getElementById("tm-body");
  tmBody.innerHTML = '<tr><td colspan="22" style="text-align:center;padding:2rem;color:var(--muted)">Loading trades...</td></tr>';
  tmSelected.clear();

  try {
    // Fetch trades from DB
    const includeExp = document.getElementById("tm-show-expired").checked;
    const data = await get(`/api/trades/?include_expired=${includeExp}&asset=${currentAsset}`);
    tmTrades = data.trades || [];

    // Fetch enriched data from portfolio endpoint for live Greeks/MTM
    let enriched = [];
    try {
      const pfData = await get(`/api/portfolio/pnl?asset=${currentAsset}&include_expired=${includeExp}`);
      enriched = pfData.positions || [];
      ethSpot = pfData.eth_spot;
      document.getElementById("eth-spot").textContent = `$${ethSpot.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    } catch (e) {
      console.warn("Could not fetch enriched data:", e);
    }

    // Merge DB trades with enriched data
    tmEnriched = tmTrades.map(t => {
      // Find matching enriched position by DB id
      const match = enriched.find(e => e.id === t.id);
      if (match) {
        return { ...t, ...match, db_id: t.id, db_status: t.status };
      }
      // No enrichment — fill defaults
      return {
        ...t,
        db_id: t.id,
        db_status: t.status,
        days_remaining: 0,
        pct_otm_live: 0,
        iv_pct: 0,
        delta: null, gamma: null, theta: null, vega: null,
        mark_price_usd: 0,
        current_mtm: 0,
      };
    });

    tmLoaded = true;
    tmRender();
  } catch (e) {
    tmBody.innerHTML = `<tr><td colspan="22" style="text-align:center;padding:2rem;color:var(--red)">Error: ${e.message}</td></tr>`;
  }
}

function tmRender() {
  tmRenderTable();
  tmRenderSummary();
  tmRenderInsights();
  tmUpdateBadge();
}

function tmRenderSummary() {
  const active = tmEnriched.filter(t => t.db_status === "active");
  // Compute notional live: qty * ethSpot / 1e6
  const totalNotional = active.reduce((s, t) => s + ((t.qty || 0) * (ethSpot || 0) / 1e6), 0);
  const totalMtm = active.reduce((s, t) => s + (t.current_mtm || 0), 0);
  const totalDelta = active.reduce((s, t) => s + ((t.delta || 0) * (t.net_qty || 0)), 0);
  const totalGamma = active.reduce((s, t) => s + ((t.gamma || 0) * (t.net_qty || 0)), 0);
  const totalTheta = active.reduce((s, t) => s + ((t.theta || 0) * (t.net_qty || 0)), 0);
  const totalVega = active.reduce((s, t) => s + ((t.vega || 0) * (t.net_qty || 0)), 0);

  document.getElementById("tm-count").textContent = active.length;

  // Format notional: qty * ethSpot / 1e6 in $mm
  const $notional = document.getElementById("tm-notional");
  if (Math.abs(totalNotional) >= 1) {
    $notional.textContent = `$${totalNotional.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}mm`;
  } else {
    const fullUsd = totalNotional * 1e6;
    $notional.textContent = `$${fullUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }

  const $mtm = document.getElementById("tm-mtm");
  $mtm.textContent = `$${totalMtm.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  $mtm.style.color = totalMtm >= 0 ? "var(--green)" : "var(--red)";
  // Fire-and-forget: pull Δ1d / Δ7d from the snapshot history
  refreshMtmDeltas();

  const $delta = document.getElementById("tm-delta");
  $delta.textContent = totalDelta.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $delta.style.color = totalDelta >= 0 ? "var(--green)" : "var(--red)";

  const $gamma = document.getElementById("tm-gamma");
  $gamma.textContent = totalGamma.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });

  const $theta = document.getElementById("tm-theta");
  $theta.textContent = totalTheta.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $theta.style.color = totalTheta >= 0 ? "var(--green)" : "var(--red)";

  const $vega = document.getElementById("tm-vega");
  $vega.textContent = totalVega.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function tmRenderTable() {
  const tbody = document.getElementById("tm-body");
  let rows = [...tmEnriched];

  // Filters
  const fExpiry = document.getElementById("tm-filter-expiry").value;
  const fType = document.getElementById("tm-filter-type").value;
  const fSide = document.getElementById("tm-filter-side").value;
  const fSearch = document.getElementById("tm-search").value.toLowerCase().trim();

  if (fExpiry) rows = rows.filter(r => r.expiry === fExpiry);
  if (fType) rows = rows.filter(r => r.option_type === fType);
  if (fSide) rows = rows.filter(r => r.side === fSide);
  if (fSearch) rows = rows.filter(r =>
    (r.counterparty || "").toLowerCase().includes(fSearch) ||
    (r.instrument || "").toLowerCase().includes(fSearch) ||
    (r.trade_id || "").toLowerCase().includes(fSearch)
  );

  // Sort
  rows.sort((a, b) => {
    let va = a[tmSortCol], vb = b[tmSortCol];
    if (va == null) va = "";
    if (vb == null) vb = "";
    if (typeof va === "number" && typeof vb === "number") return tmSortAsc ? va - vb : vb - va;
    return tmSortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
  });

  // Populate expiry filter
  const expiries = [...new Set(tmEnriched.map(t => t.expiry))].sort();
  const expSel = document.getElementById("tm-filter-expiry");
  const curExp = expSel.value;
  expSel.innerHTML = '<option value="">All</option>';
  expiries.forEach(e => {
    const o = document.createElement("option");
    o.value = e; o.textContent = e;
    if (e === curExp) o.selected = true;
    expSel.appendChild(o);
  });

  document.getElementById("tm-table-count").textContent = `(${rows.length})`;

  const isFil = currentAsset === "FIL";
  const priceDec = isFil ? 2 : 0;
  const fmt = (v, d = 2) => v != null && v !== "" ? Number(v).toFixed(d) : "--";
  const fmtK = (v) => v != null && v !== "" ? Number(v).toLocaleString(undefined, { maximumFractionDigits: priceDec }) : "--";
  const fmtMoney = (v) => v != null && v !== "" ? `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: priceDec })}` : "--";
  const fmtMm = (v) => v != null && v !== "" ? `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}mm` : "--";

  tbody.innerHTML = rows.map(t => {
    const tid = t.db_id || t.id;
    const isExpired = t.db_status === "expired";
    const isSelected = tmSelected.has(tid);
    const rowClass = isExpired ? "tm-row-expired" : isSelected ? "tm-row-selected" : "";
    const statusClass = t.db_status === "active" ? "status-active" : t.db_status === "expired" ? "status-expired" : "status-deleted";
    const mtmColor = (t.current_mtm || 0) >= 0 ? "mtm-pos" : "mtm-neg";
    const sideColor = (t.side || "").toLowerCase().includes("buy") || (t.side || "").toLowerCase().includes("long") ? "qty-long" : "qty-short";

    return `<tr class="${rowClass}" data-tid="${tid}">
      <td><input type="checkbox" class="tm-row-check" data-tid="${tid}" ${isSelected ? "checked" : ""} ${isExpired ? "disabled" : ""}></td>
      <td><span class="status-dot ${statusClass}"></span></td>
      <td style="text-align:left">${t.counterparty || ""}</td>
      <td>${t.trade_date || ""}</td>
      <td style="text-align:left" class="${sideColor}">${t.side || ""}</td>
      <td style="text-align:left">${t.option_type || ""}</td>
      <td style="text-align:left">${t.instrument || ""}</td>
      <td>${t.expiry || ""}</td>
      <td>${t.days_remaining || 0}</td>
      <td>${fmtK(t.strike)}</td>
      <td>${fmt(t.pct_otm_live, 1)}%</td>
      <td>${fmtK(t.qty)}</td>
      <td>${fmtMm((t.qty || 0) * (ethSpot || 0) / 1e6)}</td>
      <td>${fmtMoney(t.premium_usd)}</td>
      <td>${fmt(t.iv_pct, 1)}</td>
      <td>${fmt(t.delta, 4)}</td>
      <td>${fmt(t.gamma, 6)}</td>
      <td>${fmt(t.theta, 4)}</td>
      <td>${fmt(t.vega, 4)}</td>
      <td>${fmtMoney(t.mark_price_usd)}</td>
      <td class="${mtmColor}">${fmtMoney(t.current_mtm)}</td>
      <td>
        <div class="tm-actions">
          <button class="tm-action-btn" onclick="tmEditTrade(${t.db_id})" title="Edit">&#9998;</button>
          ${t.db_status === "active" ? `<button class="tm-action-btn btn-expire" onclick="tmExpireTrade(${t.db_id})" title="Expire">&#9201;</button>` : ""}
          <button class="tm-action-btn btn-delete" onclick="tmDeleteTrade(${t.db_id})" title="Delete">&#10005;</button>
          <button class="tm-action-btn" onclick="tmShowHistory(${t.db_id})" title="History">&#128336;</button>
        </div>
      </td>
    </tr>`;
  }).join("");

  // Wire row checkboxes
  tbody.querySelectorAll(".tm-row-check").forEach(cb => {
    cb.addEventListener("change", () => {
      const tid = parseInt(cb.dataset.tid);
      if (cb.checked) tmSelected.add(tid); else tmSelected.delete(tid);
      const row = cb.closest("tr");
      row.classList.toggle("tm-row-selected", cb.checked);
      tmUpdateBulkUI();
    });
  });
  tmUpdateBulkUI();
}

function tmRenderInsights() {
  const container = document.getElementById("tm-insights");
  const active = tmEnriched.filter(t => t.db_status === "active");
  const insights = [];

  // Upcoming expiries
  const expiringSoon = active.filter(t => t.days_remaining > 0 && t.days_remaining <= 7);
  const expiringMed = active.filter(t => t.days_remaining > 7 && t.days_remaining <= 14);
  if (expiringSoon.length > 0) {
    insights.push({
      type: "danger",
      title: "Expiring within 7 days",
      body: expiringSoon.map(t => `${t.instrument} (${t.days_remaining}d)`).join(", ")
    });
  }
  if (expiringMed.length > 0) {
    insights.push({
      type: "warning",
      title: "Expiring within 14 days",
      body: expiringMed.map(t => `${t.instrument} (${t.days_remaining}d)`).join(", ")
    });
  }

  // Concentrated positions (computed notional = qty * ethSpot / 1e6)
  const calcNotional = t => (t.qty || 0) * (ethSpot || 0) / 1e6;
  const totalNotionalIns = active.reduce((s, t) => s + Math.abs(calcNotional(t)), 0);
  if (totalNotionalIns > 0) {
    const concentrated = active.filter(t => Math.abs(calcNotional(t)) / totalNotionalIns > 0.25);
    if (concentrated.length > 0) {
      insights.push({
        type: "warning",
        title: "Concentrated positions (>25% of notional)",
        body: concentrated.map(t => `${t.instrument}: $${calcNotional(t).toFixed(2)}mm (${(Math.abs(calcNotional(t)) / totalNotionalIns * 100).toFixed(0)}%)`).join(", ")
      });
    }
  }

  // Large unrealized P&L
  const largePnl = active.filter(t => t.premium_usd && Math.abs(t.current_mtm || 0) > 0.5 * Math.abs(t.premium_usd));
  if (largePnl.length > 0) {
    insights.push({
      type: "info",
      title: "Large unrealized P&L (>50% of premium)",
      body: largePnl.map(t => `${t.instrument}: MTM $${(t.current_mtm || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} vs premium $${(t.premium_usd || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`).join("; ")
    });
  }

  // High IV
  const highIv = active.filter(t => (t.iv_pct || 0) > 100);
  if (highIv.length > 0) {
    insights.push({
      type: "info",
      title: "High IV trades (>100%)",
      body: highIv.map(t => `${t.instrument}: ${(t.iv_pct || 0).toFixed(1)}%`).join(", ")
    });
  }

  if (insights.length === 0) {
    insights.push({ type: "info", title: "No alerts", body: "All positions within normal parameters." });
  }

  container.innerHTML = insights.map(i => `
    <div class="insight-card insight-${i.type}">
      <div class="insight-title">${i.title}</div>
      <div class="insight-body">${i.body}</div>
    </div>
  `).join("");
}

function tmUpdateBadge() {
  const badge = document.getElementById("nav-badge-trades");
  const active = tmEnriched.filter(t => t.db_status === "active");
  badge.textContent = active.length || "";
}

// Sort handler for TM table
document.getElementById("tm-table").addEventListener("click", e => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const col = th.dataset.col;
  if (tmSortCol === col) {
    tmSortAsc = !tmSortAsc;
  } else {
    tmSortCol = col;
    tmSortAsc = true;
  }
  // Update sort indicators
  document.querySelectorAll("#tm-table th.sortable").forEach(h => {
    h.classList.remove("sort-asc", "sort-desc");
  });
  th.classList.add(tmSortAsc ? "sort-asc" : "sort-desc");
  tmRenderTable();
});

// Filter handlers
["tm-filter-expiry", "tm-filter-type", "tm-filter-side"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => tmRenderTable());
});
document.getElementById("tm-search").addEventListener("input", () => tmRenderTable());
document.getElementById("tm-show-expired").addEventListener("change", () => tmLoad());
document.getElementById("btn-tm-refresh").addEventListener("click", () => tmLoad());

// ─── Trade CRUD ─────────────────────────────────────────────
document.getElementById("btn-tm-new").addEventListener("click", () => tmOpenModal());
document.getElementById("btn-modal-cancel").addEventListener("click", () => tmCloseModal());

// ─── Multi-leg state ────────────────────────────────────────
let tfPreset = "single";
let tfLegs = []; // [{side, type, strike, premium_per, premium_usd}]

const TF_PRESETS = {
  single:       null,
  put_spread:   [{ side: "Buy", type: "Put", strike: 0 }, { side: "Sell", type: "Put", strike: 0 }],
  call_spread:  [{ side: "Buy", type: "Call", strike: 0 }, { side: "Sell", type: "Call", strike: 0 }],
  straddle:     [{ side: "Buy", type: "Call", strike: 0 }, { side: "Buy", type: "Put", strike: 0 }],
  strangle:     [{ side: "Buy", type: "Call", strike: 0 }, { side: "Buy", type: "Put", strike: 0 }],
  iron_condor:  [
    { side: "Buy", type: "Put", strike: 0 },
    { side: "Sell", type: "Put", strike: 0 },
    { side: "Sell", type: "Call", strike: 0 },
    { side: "Buy", type: "Call", strike: 0 },
  ],
};

// Preset buttons
document.querySelectorAll(".tf-preset").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tf-preset").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    tfPreset = btn.dataset.preset;
    tfApplyPreset();
  });
});

function tfApplyPreset() {
  const isSingle = tfPreset === "single";
  document.getElementById("tf-single-section").style.display = isSingle ? "" : "none";
  document.getElementById("tf-multi-section").style.display = isSingle ? "none" : "";

  if (!isSingle) {
    const template = TF_PRESETS[tfPreset];
    const spot = ethSpot || 0;
    // Pre-fill strikes relative to spot
    tfLegs = template.map((leg, i) => {
      let strike = leg.strike;
      if (spot > 0 && strike === 0) {
        if (tfPreset === "put_spread") strike = i === 0 ? Math.round(spot * 0.9) : Math.round(spot * 0.8);
        else if (tfPreset === "call_spread") strike = i === 0 ? Math.round(spot * 1.1) : Math.round(spot * 1.2);
        else if (tfPreset === "straddle") strike = Math.round(spot / 50) * 50;
        else if (tfPreset === "strangle") strike = i === 0 ? Math.round(spot * 1.1) : Math.round(spot * 0.9);
        else if (tfPreset === "iron_condor") {
          const offsets = [0.85, 0.9, 1.1, 1.15];
          strike = Math.round(spot * offsets[i]);
        }
      }
      return { ...leg, strike, qty: 1000, premium_per: 0, premium_usd: 0 };
    });
    tfRenderLegs();
  }
}

function tfRenderLegs() {
  const tbody = document.getElementById("tf-legs-body");
  tbody.innerHTML = tfLegs.map((leg, i) => `<tr>
    <td style="color:var(--muted)">${i + 1}</td>
    <td><select class="tf-leg-side" data-idx="${i}">
      <option value="Buy" ${leg.side === "Buy" ? "selected" : ""}>Buy</option>
      <option value="Sell" ${leg.side === "Sell" ? "selected" : ""}>Sell</option>
    </select></td>
    <td><select class="tf-leg-type" data-idx="${i}">
      <option value="Call" ${leg.type === "Call" ? "selected" : ""}>Call</option>
      <option value="Put" ${leg.type === "Put" ? "selected" : ""}>Put</option>
    </select></td>
    <td><input type="number" class="tf-leg-strike" data-idx="${i}" value="${leg.strike}" step="any" min="0"></td>
    <td><input type="number" class="tf-leg-qty" data-idx="${i}" value="${leg.qty ?? 1000}" step="100" min="0"></td>
    <td><input type="number" class="tf-leg-prem" data-idx="${i}" value="${leg.premium_per}" step="0.01"></td>
    <td><input type="number" class="tf-leg-premusd" data-idx="${i}" value="${leg.premium_usd}" step="0.01" readonly></td>
    <td><button type="button" class="tf-leg-remove" data-idx="${i}">&times;</button></td>
  </tr>`).join("");

  // Wire leg inputs
  tbody.querySelectorAll(".tf-leg-side").forEach(el => el.addEventListener("change", () => {
    const idx = el.dataset.idx;
    tfLegs[idx].side = el.value;
    // Re-apply sign convention to existing premium when side changes
    const signed = tfSignedPremium(el.value, tfLegs[idx].premium_per);
    tfLegs[idx].premium_per = signed;
    tfRecomputeLegUsd(idx);
    tfRenderLegs();
  }));
  tbody.querySelectorAll(".tf-leg-type").forEach(el => el.addEventListener("change", () => { tfLegs[el.dataset.idx].type = el.value; }));
  tbody.querySelectorAll(".tf-leg-strike").forEach(el => el.addEventListener("input", () => { tfLegs[el.dataset.idx].strike = parseFloat(el.value) || 0; }));
  tbody.querySelectorAll(".tf-leg-qty").forEach(el => el.addEventListener("input", () => {
    const idx = el.dataset.idx;
    tfLegs[idx].qty = parseFloat(el.value) || 0;
    tfRecomputeLegUsd(idx);
    const usdEl = tbody.querySelector(`.tf-leg-premusd[data-idx="${idx}"]`);
    if (usdEl) usdEl.value = tfLegs[idx].premium_usd;
  }));
  tbody.querySelectorAll(".tf-leg-prem").forEach(el => {
    el.addEventListener("input", () => {
      const idx = el.dataset.idx;
      tfLegs[idx].premium_per = parseFloat(el.value) || 0;
      tfRecomputeLegUsd(idx);
      // Update USD cell live without re-rendering the row (keeps focus)
      const usdEl = tbody.querySelector(`.tf-leg-premusd[data-idx="${idx}"]`);
      if (usdEl) usdEl.value = tfLegs[idx].premium_usd;
    });
    el.addEventListener("change", () => {
      const idx = el.dataset.idx;
      const signed = tfSignedPremium(tfLegs[idx].side, parseFloat(el.value) || 0);
      tfLegs[idx].premium_per = signed;
      tfRecomputeLegUsd(idx);
      tfRenderLegs();
    });
  });
  tbody.querySelectorAll(".tf-leg-remove").forEach(el => el.addEventListener("click", () => {
    tfLegs.splice(parseInt(el.dataset.idx), 1);
    tfRenderLegs();
  }));
}

// Recompute a single leg's premium_usd = signed premium_per × per-leg qty.
function tfRecomputeLegUsd(idx) {
  const leg = tfLegs[idx];
  if (!leg) return;
  const qty = parseFloat(leg.qty) || 0;
  const signed = tfSignedPremium(leg.side, leg.premium_per);
  leg.premium_per = signed;
  leg.premium_usd = +(signed * qty).toFixed(2);
}

// Recompute USD across all legs.
function tfRecomputeAllLegsUsd() {
  for (let i = 0; i < tfLegs.length; i++) tfRecomputeLegUsd(i);
  tfRenderLegs();
}

document.getElementById("btn-tf-add-leg").addEventListener("click", () => {
  // Default leg strike at-the-money, rounded sensibly per asset.
  const spot = ethSpot || (currentAsset === "FIL" ? 2.5 : 2000);
  const strike = currentAsset === "FIL" ? Math.round(spot * 20) / 20 : Math.round(spot);
  tfLegs.push({ side: "Buy", type: "Call", strike, qty: 1000, premium_per: 0, premium_usd: 0 });
  tfRenderLegs();
});

// Premium-sign convention: Buy → negative, Sell/Unwind → positive.
function tfSignedPremium(side, premium) {
  const abs = Math.abs(parseFloat(premium) || 0);
  return side === "Buy" ? -abs : abs;
}

// Recompute USD = signed premium × qty, without rewriting the premium input
// (so the user can keep typing). Sign is enforced separately on `change`.
function tfRecalcPremiumUsd() {
  const side = document.getElementById("tf-side").value;
  const $perEl = document.getElementById("tf-premium-per");
  const $usdEl = document.getElementById("tf-premium-usd");
  const qty = parseFloat(document.getElementById("tf-qty").value) || 0;
  const raw = parseFloat($perEl.value);
  if (isNaN(raw)) { $usdEl.value = ""; return; }
  $usdEl.value = (tfSignedPremium(side, raw) * qty).toFixed(2);
}

// Enforce premium-per sign based on current side. Run on blur/change/side-switch.
function tfEnforcePremiumSign() {
  const side = document.getElementById("tf-side").value;
  const $perEl = document.getElementById("tf-premium-per");
  const raw = parseFloat($perEl.value);
  if (isNaN(raw) || raw === 0) return;
  $perEl.value = tfSignedPremium(side, raw);
  tfRecalcPremiumUsd();
}

// Populate counterparty datalist from currently loaded trades.
function optv2PopulateCounterparties() {
  const select = document.getElementById("optv2-counterparties");
  if (!select || !optv2Data) return;

  const counterparties = [...new Set(
    (optv2Data.positions || [])
      .filter(p => (p.db_status || p.status || "active") !== "expired")
      .map(p => (p.counterparty || "").trim())
      .filter(Boolean)
  )].sort();

  console.log("[OPT-FE] counterparties:", counterparties);

  select.innerHTML =
    `<option value="ALL" selected>ALL</option>` +
    counterparties.map(c => `<option value="${c.replace(/"/g, "&quot;")}">${c}</option>`).join("");
}

// Make a "<select multiple>" of counterparties toggle on plain click (no Ctrl/Cmd needed),
// and wire up its "Select All" / "Clear" buttons. Shared by the Optimizer v2 and v3 tabs.
function wireCounterpartyMultiSelect(selectId, selectAllBtnId, clearBtnId) {
  const select = document.getElementById(selectId);
  if (!select) return;

  const fireChange = () => select.dispatchEvent(new Event("change", { bubbles: true }));

  // Native <select multiple> only lets you add to the selection with Ctrl/Cmd-click.
  // Intercept the mousedown and toggle the clicked option ourselves instead.
  select.addEventListener("mousedown", (e) => {
    if (e.target.tagName !== "OPTION") return;
    e.preventDefault();
    const opt = e.target;
    opt.selected = !opt.selected;
    const allOpt = select.querySelector('option[value="ALL"]');
    if (opt.value === "ALL" && opt.selected) {
      // Picking ALL clears any specific counterparties.
      Array.from(select.options).forEach(o => { if (o !== opt) o.selected = false; });
    } else if (opt.value !== "ALL" && opt.selected && allOpt) {
      // Picking a specific counterparty drops ALL.
      allOpt.selected = false;
    }
    // Never leave the box with nothing highlighted — fall back to ALL.
    if (allOpt && !Array.from(select.options).some(o => o.selected)) allOpt.selected = true;
    select.focus();
    fireChange();
  });

  document.getElementById(selectAllBtnId)?.addEventListener("click", () => {
    Array.from(select.options).forEach(o => { o.selected = o.value !== "ALL"; });
    fireChange();
  });
  document.getElementById(clearBtnId)?.addEventListener("click", () => {
    Array.from(select.options).forEach(o => { o.selected = o.value === "ALL"; });
    fireChange();
  });
}
wireCounterpartyMultiSelect("optv2-counterparties", "optv2-cpty-select-all", "optv2-cpty-clear");
wireCounterpartyMultiSelect("optv3-counterparties", "optv3-cpty-select-all", "optv3-cpty-clear");

// Auto-fill ref spot and compute % OTM / notional when strike or qty changes
function tfAutoCalc() {
  const spot = parseFloat(document.getElementById("tf-ref-spot").value) || 0;
  const strike = parseFloat(document.getElementById("tf-strike").value) || 0;
  const qty = parseFloat(document.getElementById("tf-qty").value) || 0;
  if (spot > 0 && strike > 0) {
    const otm = ((strike / spot) - 1) * 100;
    document.getElementById("tf-pct-otm").value = otm.toFixed(2);
  }
  if (spot > 0 && qty > 0) {
    document.getElementById("tf-notional").value = ((qty * spot) / 1e6).toFixed(4);
  }
  tfRecalcPremiumUsd();
}
["tf-strike", "tf-qty", "tf-ref-spot"].forEach(id => {
  document.getElementById(id).addEventListener("input", tfAutoCalc);
});
document.getElementById("tf-side").addEventListener("change", tfEnforcePremiumSign);
document.getElementById("tf-premium-per").addEventListener("input", tfRecalcPremiumUsd);
document.getElementById("tf-premium-per").addEventListener("change", tfEnforcePremiumSign);

// Populate the trade-modal counterparty datalist from currently loaded trades.
function tfPopulateCounterparties() {
  const list = document.getElementById("tf-counterparty-list");
  if (!list) return;
  const counterparties = [...new Set(
    (tmTrades || [])
      .map(t => (t.counterparty || "").trim())
      .filter(Boolean)
  )].sort();
  list.innerHTML = counterparties
    .map(c => `<option value="${c.replace(/"/g, "&quot;")}"></option>`)
    .join("");
}

function tmOpenModal(trade = null) {
  const modal = document.getElementById("modal-trade");
  const title = document.getElementById("modal-trade-title");
  const form = document.getElementById("trade-form");
  const stratBar = document.getElementById("tf-strategy-bar");

  tfPopulateCounterparties();

  // Qty is denominated in the current asset's units.
  const qtyUnit = document.getElementById("tf-qty-unit");
  if (qtyUnit) qtyUnit.textContent = currentAsset;

  if (trade) {
    // Edit mode — single leg only, hide strategy bar
    title.textContent = `Edit Trade #${trade.id}`;
    stratBar.style.display = "none";
    document.getElementById("tf-single-section").style.display = "";
    document.getElementById("tf-multi-section").style.display = "none";
    tfPreset = "single";

    document.getElementById("tf-id").value = trade.db_id || trade.id;
    document.getElementById("tf-counterparty").value = trade.counterparty || "";
    document.getElementById("tf-trade-date").value = trade.trade_date || "";
    // Normalize side/type to match dropdown values (Buy/Sell, Call/Put)
    const editSide = (trade.side_raw || trade.side || "Buy").trim();
    const sLower = editSide.toLowerCase();
    document.getElementById("tf-side").value = ["buy","long","bought"].includes(sLower) ? "Buy" : ["sell","short","sold"].includes(sLower) ? "Sell" : editSide;
    const editType = (trade.option_type || "Call").trim();
    const tLower = editType.toLowerCase();
    document.getElementById("tf-option-type").value = ["call","calls","c"].includes(tLower) ? "Call" : ["put","puts","p"].includes(tLower) ? "Put" : editType;
    document.getElementById("tf-expiry").value = trade.expiry || "";
    document.getElementById("tf-strike").value = trade.strike || "";
    document.getElementById("tf-qty").value = trade.qty || "";
    document.getElementById("tf-ref-spot").value = trade.ref_spot || "";
    document.getElementById("tf-premium-per").value = trade.premium_per || "";
    document.getElementById("tf-premium-usd").value = trade.premium_usd || "";
    document.getElementById("tf-notional").value = trade.notional_mm || "";
    document.getElementById("tf-pct-otm").value = trade.pct_otm || "";
    // Apply Buy=negative / Sell=positive convention and recompute USD
    tfEnforcePremiumSign();
  } else {
    // New trade mode — show strategy bar, default to single
    title.textContent = "New Trade";
    form.reset();
    stratBar.style.display = "";
    document.getElementById("tf-id").value = "";
    document.getElementById("tf-trade-date").value = new Date().toISOString().split("T")[0];
    // Auto-fill ref spot from live price
    if (ethSpot) document.getElementById("tf-ref-spot").value = ethSpot;
    // Reset to single preset
    document.querySelectorAll(".tf-preset").forEach(b => b.classList.remove("active"));
    document.querySelector('.tf-preset[data-preset="single"]').classList.add("active");
    tfPreset = "single";
    tfLegs = [];
    document.getElementById("tf-single-section").style.display = "";
    document.getElementById("tf-multi-section").style.display = "none";
  }

  modal.style.display = "flex";
}

function tmCloseModal() {
  document.getElementById("modal-trade").style.display = "none";
}

document.getElementById("trade-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  // Enforce sign rule + USD recompute in case user clicks Save without blurring fields.
  tfEnforcePremiumSign();
  if (tfPreset !== "single") tfRecomputeAllLegsUsd();
  const id = document.getElementById("tf-id").value;
  const counterparty = document.getElementById("tf-counterparty").value;
  const trade_date = document.getElementById("tf-trade-date").value;
  const expiry = document.getElementById("tf-expiry").value;
  const ref_spot = parseFloat(document.getElementById("tf-ref-spot").value) || 0;

  // Basic validation
  if (tfPreset === "single" || id) {
    const strike = parseFloat(document.getElementById("tf-strike").value);
    const qty = parseFloat(document.getElementById("tf-qty").value);
    if (!strike || strike <= 0) { alert("Strike is required"); return; }
    if (!qty || qty <= 0) { alert("Qty is required"); return; }
  } else {
    if (tfLegs.length === 0) { alert("Add at least one leg"); return; }
    if (tfLegs.some(l => !l.strike || l.strike <= 0)) { alert("All legs need a strike"); return; }
    if (tfLegs.some(l => !l.qty || l.qty <= 0)) { alert("All legs need a qty"); return; }
  }
  if (!expiry) { alert("Expiry date is required"); return; }

  try {
    if (id) {
      // Edit single trade
      const data = {
        counterparty, trade_date, expiry, ref_spot,
        side: document.getElementById("tf-side").value,
        option_type: document.getElementById("tf-option-type").value,
        strike: parseFloat(document.getElementById("tf-strike").value) || 0,
        qty: parseFloat(document.getElementById("tf-qty").value) || 0,
        premium_per: parseFloat(document.getElementById("tf-premium-per").value) || 0,
        premium_usd: parseFloat(document.getElementById("tf-premium-usd").value) || 0,
        notional_mm: parseFloat(document.getElementById("tf-notional").value) || 0,
        pct_otm: parseFloat(document.getElementById("tf-pct-otm").value) || 0,
      };
      await api("PUT", `/api/trades/${id}`, data);
    } else if (tfPreset === "single") {
      // Create single leg
      const data = {
        asset: currentAsset, counterparty, trade_date, expiry, ref_spot,
        side: document.getElementById("tf-side").value,
        option_type: document.getElementById("tf-option-type").value,
        strike: parseFloat(document.getElementById("tf-strike").value) || 0,
        qty: parseFloat(document.getElementById("tf-qty").value) || 0,
        premium_per: parseFloat(document.getElementById("tf-premium-per").value) || 0,
        premium_usd: parseFloat(document.getElementById("tf-premium-usd").value) || 0,
        notional_mm: parseFloat(document.getElementById("tf-notional").value) || 0,
        pct_otm: parseFloat(document.getElementById("tf-pct-otm").value) || 0,
      };
      await post("/api/trades/", data);
    } else {
      // Create multi-leg strategy — one trade per leg, each with its own qty
      for (const leg of tfLegs) {
        const legQty = parseFloat(leg.qty) || 0;
        const otm = ref_spot > 0 ? ((leg.strike / ref_spot) - 1) * 100 : 0;
        const notional = ref_spot > 0 ? (legQty * ref_spot) / 1e6 : 0;
        await post("/api/trades/", {
          asset: currentAsset, counterparty, trade_date, expiry, ref_spot,
          side: leg.side,
          option_type: leg.type,
          strike: leg.strike,
          qty: legQty,
          premium_per: leg.premium_per,
          premium_usd: leg.premium_usd,
          notional_mm: notional,
          pct_otm: otm,
        });
      }
    }
    tmCloseModal();
    tmInvalidatePortfolio();
    tmLoad();
  } catch (err) {
    alert("Failed to save trade: " + err.message);
  }
});

async function tmEditTrade(id) {
  // Look up from raw trades first, then enriched as fallback
  let trade = tmTrades.find(t => t.id === id || t.id === Number(id));
  if (!trade) trade = tmEnriched.find(t => (t.db_id || t.id) === id || (t.db_id || t.id) === Number(id));
  if (!trade) {
    // Last resort: fetch directly from API
    try {
      trade = await get(`/api/trades/${id}`);
    } catch (e) {
      alert(`Could not load trade #${id}: ${e.message}`);
      return;
    }
  }
  if (trade) tmOpenModal(trade);
}

async function tmExpireTrade(id) {
  if (!confirm("Mark this trade as expired?")) return;
  try {
    await post(`/api/trades/${id}/expire`);
    tmInvalidatePortfolio();
    tmLoad();
  } catch (err) {
    alert("Failed to expire trade: " + err.message);
  }
}

async function tmDeleteTrade(id) {
  if (!confirm("Delete this trade? (soft delete)")) return;
  try {
    await api("DELETE", `/api/trades/${id}`);
    tmInvalidatePortfolio();
    tmLoad();
  } catch (err) {
    alert("Failed to delete trade: " + err.message);
  }
}

/** Invalidate cached portfolio/strategy builder so they re-fetch from DB on next visit. */
function tmInvalidatePortfolio() {
  portfolioLoaded = false;
  sbLoaded = false;
  pfData = null;
}

// ─── Bulk select & actions ──────────────────────────────────
let tmSelected = new Set();

function tmUpdateBulkUI() {
  const n = tmSelected.size;
  document.getElementById("btn-tm-bulk-expire").style.display = n > 0 ? "" : "none";
  document.getElementById("btn-tm-bulk-delete").style.display = n > 0 ? "" : "none";
  document.getElementById("btn-tm-bulk-expire").textContent = `Expire Selected (${n})`;
  document.getElementById("btn-tm-bulk-delete").textContent = `Delete Selected (${n})`;
  // Update header checkbox
  const visibleActive = tmEnriched.filter(t => t.db_status === "active");
  const allChecked = visibleActive.length > 0 && visibleActive.every(t => tmSelected.has(t.db_id || t.id));
  document.getElementById("tm-check-all").checked = allChecked;
}

document.getElementById("tm-check-all").addEventListener("change", (e) => {
  const visibleActive = tmEnriched.filter(t => t.db_status === "active");
  if (e.target.checked) {
    visibleActive.forEach(t => tmSelected.add(t.db_id || t.id));
  } else {
    tmSelected.clear();
  }
  tmRenderTable();
  tmUpdateBulkUI();
});

document.getElementById("btn-tm-bulk-expire").addEventListener("click", async () => {
  const ids = [...tmSelected];
  if (!confirm(`Expire ${ids.length} trade(s)?`)) return;
  try {
    await post("/api/trades/bulk-expire", { ids });
    tmSelected.clear();
    tmInvalidatePortfolio();
    tmLoad();
  } catch (err) {
    alert("Bulk expire failed: " + err.message);
  }
});

document.getElementById("btn-tm-bulk-delete").addEventListener("click", async () => {
  const ids = [...tmSelected];
  if (!confirm(`Delete ${ids.length} trade(s)?`)) return;
  try {
    for (const id of ids) await api("DELETE", `/api/trades/${id}`);
    tmSelected.clear();
    tmInvalidatePortfolio();
    tmLoad();
  } catch (err) {
    alert("Bulk delete failed: " + err.message);
  }
});

async function tmShowHistory(id) {
  const modal = document.getElementById("modal-history");
  document.getElementById("history-trade-id").textContent = `#${id}`;
  const tbody = document.getElementById("history-body");
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:1rem;color:var(--muted)">Loading...</td></tr>';
  modal.style.display = "flex";

  try {
    const data = await get(`/api/trades/${id}/history`);
    const history = data.history || [];
    if (history.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No history found</td></tr>';
      return;
    }
    tbody.innerHTML = history.map(h => {
      const cls = `history-${h.action}`;
      return `<tr>
        <td style="text-align:left">${h.timestamp || ""}</td>
        <td style="text-align:left" class="${cls}">${h.action}</td>
        <td style="text-align:left">${h.field_changed || "--"}</td>
        <td style="text-align:left">${h.old_value || "--"}</td>
        <td style="text-align:left">${h.new_value || "--"}</td>
        <td style="text-align:left">${h.changed_by || ""}</td>
      </tr>`;
    }).join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--red)">${err.message}</td></tr>`;
  }
}

document.getElementById("btn-history-close").addEventListener("click", () => {
  document.getElementById("modal-history").style.display = "none";
});

// Close modals on overlay click
["modal-trade", "modal-history"].forEach(id => {
  document.getElementById(id).addEventListener("click", e => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = "none";
  });
});

// Export trades to Excel
document.getElementById("btn-tm-export").addEventListener("click", () => {
  if (!tmEnriched.length) return;
  const ws = XLSX.utils.json_to_sheet(tmEnriched.map(t => ({
    ID: t.db_id,
    Status: t.db_status,
    Counterparty: t.counterparty,
    "Trade Date": t.trade_date,
    Side: t.side,
    Type: t.option_type,
    Instrument: t.instrument,
    Expiry: t.expiry,
    DTE: t.days_remaining,
    Strike: t.strike,
    "% OTM": t.pct_otm_live,
    Qty: t.qty,
    "Notional ($mm)": t.notional_mm,
    "Premium USD": t.premium_usd,
    "IV%": t.iv_pct,
    Delta: t.delta,
    Gamma: t.gamma,
    Theta: t.theta,
    Vega: t.vega,
    "Mark Price": t.mark_price_usd,
    MTM: t.current_mtm,
  })));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Trades");
  XLSX.writeFile(wb, `PLGO_Trades_${new Date().toISOString().split("T")[0]}.xlsx`);
});

// ─── Counterparty Reconciliation ────────────────────────────
let rcTheirTrades = [];

function rcAddRow(data) {
  const d = data || { trade_id: "", trade_date: "", side: "Buy", option_type: "Call", strike: "", expiry: "", qty: "", premium_usd: "" };
  rcTheirTrades.push(d);
  rcRenderRows();
}

function rcRenderRows() {
  const tbody = document.getElementById("rc-their-body");
  document.getElementById("rc-their-count").textContent = rcTheirTrades.length;
  tbody.innerHTML = rcTheirTrades.map((t, i) => `<tr>
    <td><input type="text" class="rc-field" data-idx="${i}" data-col="trade_id" value="${t.trade_id || ""}" style="width:100%;font-size:.78rem"></td>
    <td><input type="text" class="rc-field" data-idx="${i}" data-col="trade_date" value="${t.trade_date || ""}" placeholder="YYYY-MM-DD" style="width:100px;font-size:.78rem"></td>
    <td><select class="rc-field" data-idx="${i}" data-col="side" style="font-size:.78rem">
      <option value="Buy" ${(t.side || "").toUpperCase() === "BUY" ? "selected" : ""}>Buy</option>
      <option value="Sell" ${(t.side || "").toUpperCase() === "SELL" ? "selected" : ""}>Sell</option>
    </select></td>
    <td><select class="rc-field" data-idx="${i}" data-col="option_type" style="font-size:.78rem">
      <option value="Call" ${(t.option_type || "").toUpperCase() === "CALL" ? "selected" : ""}>Call</option>
      <option value="Put" ${(t.option_type || "").toUpperCase() === "PUT" ? "selected" : ""}>Put</option>
    </select></td>
    <td><input type="number" class="rc-field" data-idx="${i}" data-col="strike" value="${t.strike || ""}" step="any" style="width:80px;font-size:.78rem"></td>
    <td><input type="text" class="rc-field" data-idx="${i}" data-col="expiry" value="${t.expiry || ""}" placeholder="YYYY-MM-DD" style="width:100px;font-size:.78rem"></td>
    <td><input type="number" class="rc-field" data-idx="${i}" data-col="qty" value="${t.qty || ""}" step="any" style="width:80px;font-size:.78rem"></td>
    <td><input type="number" class="rc-field" data-idx="${i}" data-col="premium_usd" value="${t.premium_usd || ""}" step="any" style="width:100px;font-size:.78rem"></td>
    <td><button class="tm-action-btn btn-delete rc-remove" data-idx="${i}" title="Remove">&times;</button></td>
  </tr>`).join("");

  tbody.querySelectorAll(".rc-field").forEach(el => {
    el.addEventListener("change", () => {
      const idx = parseInt(el.dataset.idx);
      const col = el.dataset.col;
      rcTheirTrades[idx][col] = el.value;
    });
  });
  tbody.querySelectorAll(".rc-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      rcTheirTrades.splice(parseInt(btn.dataset.idx), 1);
      rcRenderRows();
    });
  });
}

async function rcPopulateCounterparties() {
  const sel = document.getElementById("rc-counterparty");
  const existing = new Set();

  // If tmEnriched is empty, fetch trades directly
  if (tmEnriched.length === 0) {
    try {
      const data = await get(`/api/trades/?include_expired=true&asset=${currentAsset}`);
      (data.trades || []).forEach(t => { if (t.counterparty) existing.add(t.counterparty); });
    } catch (e) { /* ignore */ }
  } else {
    tmEnriched.forEach(t => { if (t.counterparty) existing.add(t.counterparty); });
  }

  const cur = sel.value;
  sel.innerHTML = '<option value="">-- Select --</option>';
  [...existing].sort().forEach(cp => {
    const o = document.createElement("option");
    o.value = cp; o.textContent = cp;
    if (cp === cur) o.selected = true;
    sel.appendChild(o);
  });
}

// Template download (CSV)
document.getElementById("rc-download-csv").addEventListener("click", (e) => {
  e.preventDefault();
  const header = "trade_id,trade_date,side,option_type,strike,expiry,qty,premium_usd,price_per_option";
  const blob = new Blob([header + "\n"], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "Trades_Position_Collateral.csv";
  a.click();
});

// Template download (XLSX) — two sheets: Eth, Fil
document.getElementById("rc-download-xlsx").addEventListener("click", (e) => {
  e.preventDefault();
  const cols = ["trade_id", "trade_date", "side", "option_type", "strike", "expiry", "qty", "premium_usd", "price per option"];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols]), "Eth");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols]), "Fil");
  XLSX.writeFile(wb, "Trades_Position_Collateral.xlsx");
});

// Upload handler
function rcNormSide(s) {
  s = (s || "").trim().toUpperCase();
  if (["BUY","BUYS","BOUGHT","LONG","B","L"].includes(s)) return "Buy";
  if (["SELL","SELLS","SOLD","SHORT","S"].includes(s)) return "Sell";
  // Phrases like "Buy to unwind" / "Sell to close" (e.g. Wave's Buy/Sell/Unwind column)
  if (s.includes("BUY")) return "Buy";
  if (s.includes("SELL")) return "Sell";
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function rcNormType(t) {
  t = (t || "").trim().toUpperCase();
  if (["C","CALL","CALLS"].includes(t)) return "Call";
  if (["P","PUT","PUTS"].includes(t)) return "Put";
  return t.charAt(0) + t.slice(1).toLowerCase();
}

function rcNormDate(v) {
  if (v == null || v === "") return "";
  // Excel serial date (number like 46185 = days since 1899-12-30)
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!isNaN(n) && n > 30000 && n < 60000) {
    // Use a UTC epoch (Dec 30 1899) so the result is timezone-independent — a local
    // `new Date(1899,11,30)` shifts the date back a day under positive UTC offsets.
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
    return d.toISOString().split("T")[0];
  }
  const s = String(v).trim();
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  // DDMMMYY e.g. 04AUG26
  const m = s.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/i);
  if (m) {
    const months = {JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12"};
    const mon = months[m[2].toUpperCase()];
    if (mon) return `20${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
  }
  // Timestamp with space
  if (s.includes(" ")) return s.split(" ")[0];
  return s;
}

function rcParseRow(row) {
  const pf = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  return {
    trade_id: String(row.trade_id || row.Trade_ID || row["Trade ID"] || row["Trade_ID"] || ""),
    trade_date: rcNormDate(row.trade_date || row.Trade_Date || row["Trade Date"] || row.Date || ""),
    side: rcNormSide(row.side || row.Side || row["Buy / Sell"] || row["Buy/Sell"] || row["Direction"] || ""),
    option_type: rcNormType(row.option_type || row.Option_Type || row.Type || row["Option Type"] || row["Option_Type"] || row["Instrument Type"] || ""),
    strike: pf(row.strike ?? row.Strike ?? row["Strike Price"] ?? row["Strike_Price"] ?? 0),
    expiry: rcNormDate(row.expiry ?? row.Expiry ?? row["Expiry Date"] ?? row["Expiry_Date"] ?? row["Option Expiry Date"] ?? ""),
    qty: pf(row.qty ?? row.Qty ?? row.Quantity ?? row["ETH Options"] ?? row["Quantity"] ?? row["Size"] ?? 0),
    premium_usd: pf(row.premium_usd ?? row.Premium_USD ?? row["Premium USD"] ?? row["Premium_USD"] ?? row["Premium"] ?? 0),
  };
}

function rcGuessAsset(trades) {
  // FIL strikes are typically < $50, ETH strikes > $100
  if (trades.length === 0) return null;
  const avgStrike = trades.reduce((s, t) => s + Math.abs(t.strike || 0), 0) / trades.length;
  return avgStrike < 50 ? "FIL" : "ETH";
}

// ── Wave counterparty format ────────────────────────────────
// Wave sends one sheet per asset ("FIL Option Positions" / "ETH Option Positions")
// with 2-3 metadata rows above the header, a full trade HISTORY (incl. expired /
// unwound legs), the option type in an unlabelled column (FIL) or none at all (ETH,
// all calls), and the real trading venue in the Counterparty column (Orbit Markets,
// Genesis, …) — which we book under a single "Wave" counterparty. Returns rows in the
// same shape as rcParseRow, filtered to OPEN positions only so it lines up with our
// book (which excludes expired legs). A leg is OPEN when its "Days Remaining to
// Expiry" cell shows a plain day-count number — expired legs read "Expired", closed
// legs are blank, and some junk rows carry a date there (a huge Excel serial).
function rcDetectWaveSheetName(wb, asset) {
  return wb.SheetNames.find(sn => {
    const lc = sn.toLowerCase();
    return lc.includes("option position") && lc.includes(asset.toLowerCase());
  });
}

function rcParseWaveSheet(sheet) {
  const pf = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false, defval: null });

  // Locate the header row (the one whose first cells include "Counterparty").
  let hdr = -1;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const row = aoa[i] || [];
    if (row.some(c => String(c == null ? "" : c).trim().toLowerCase() === "counterparty")) { hdr = i; break; }
  }
  if (hdr < 0) return [];

  const header = (aoa[hdr] || []).map(c => String(c == null ? "" : c).trim().toLowerCase());
  const find = (pred) => header.findIndex(pred);
  const cpIdx     = find(h => h === "counterparty");
  const bsIdx     = find(h => h.includes("buy/sell") || h.includes("buy / sell"));
  const tdIdx     = find(h => h.includes("trade date"));
  const expIdx    = find(h => h.includes("expiry date") || h.includes("expiry"));
  const strikeIdx = find(h => h.includes("strike"));
  const qtyIdx    = find(h => h.includes("options"));  // "# of FIL Options" / "# of ETH Options"
  const daysIdx   = find(h => h.includes("days remaining"));
  const premIdx   = find(h => h.includes("premium") && (h.includes("total") || h.includes("received") || h.includes("paid")));
  // Option type: FIL keeps it in an unlabelled column between Counterparty and Buy/Sell;
  // ETH has no type column at all (the book is all calls).
  const typeIdx = (cpIdx >= 0 && bsIdx - cpIdx === 2) ? cpIdx + 1 : -1;

  const at = (row, idx) => (idx >= 0 && idx < row.length) ? row[idx] : null;
  const todayISO = new Date().toISOString().split("T")[0];
  const out = [];
  for (let i = hdr + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    // OPEN only: keep rows whose "Days Remaining to Expiry" is a plain day-count.
    // Excludes "Expired" / blank, and date-valued junk rows (serials in the 30k-60k range).
    // Fallback to an expiry>=today check if that column is ever absent.
    if (daysIdx >= 0) {
      const dr = at(row, daysIdx);
      if (!(typeof dr === "number" && isFinite(dr) && dr > 0 && dr < 3650)) continue;
    } else {
      const e = rcNormDate(at(row, expIdx));
      if (!e || e < todayISO) continue;
    }
    const side = rcNormSide(String(at(row, bsIdx) == null ? "" : at(row, bsIdx)).trim());
    if (side !== "Buy" && side !== "Sell") continue;   // skip section/junk rows
    const strike = pf(at(row, strikeIdx));
    const expiry = rcNormDate(at(row, expIdx));
    if (!expiry || strike <= 0) continue;
    out.push({
      trade_id: "",
      trade_date: rcNormDate(at(row, tdIdx)),
      side,
      option_type: typeIdx >= 0 ? rcNormType(String(at(row, typeIdx) || "")) : "Call",
      strike,
      expiry,
      qty: Math.abs(pf(at(row, qtyIdx))),
      premium_usd: pf(at(row, premIdx)),
    });
  }
  return out;
}

document.getElementById("rc-upload").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const wb = XLSX.read(evt.target.result, { type: "array" });

      // Strategy 0: Wave format — per-asset "FIL/ETH Option Positions" sheet with
      // metadata rows above the header and full trade history. Parsed specially and
      // filtered to open legs. Take this branch before the generic strategies.
      const waveName = rcDetectWaveSheetName(wb, currentAsset);
      if (waveName) {
        rcTheirTrades = rcParseWaveSheet(wb.Sheets[waveName]);
        rcRenderRows();
        alert(`Wave file detected — sheet "${waveName}".\n\nImported ${rcTheirTrades.length} open ${currentAsset} position(s). Expired/closed legs and other-asset sheets were excluded.\n\nMake sure the counterparty is set to "Wave" before running.`);
        e.target.value = "";
        return;
      }

      // Strategy 1: find sheet named after current asset
      let sheetName = wb.SheetNames.find(s => s.toLowerCase() === currentAsset.toLowerCase());

      if (sheetName) {
        // Exact sheet match for current asset
        const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
        rcTheirTrades = data.map(rcParseRow);
      } else if (wb.SheetNames.length === 1) {
        // Single sheet — parse all rows, then filter by strike-based asset guess
        const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        const allTrades = data.map(rcParseRow);
        const guessed = rcGuessAsset(allTrades);
        if (guessed && guessed !== currentAsset) {
          // All trades look like the other asset
          alert(`These trades appear to be ${guessed} (avg strike ${guessed === "FIL" ? "< $50" : "> $100"}) but you're on the ${currentAsset} view.\n\nSwitch to ${guessed} first, or the reconciliation will not match.`);
        }
        rcTheirTrades = allTrades;
      } else {
        // Multiple sheets but none match current asset — try to find one by guessing content
        let found = false;
        for (const sn of wb.SheetNames) {
          const data = XLSX.utils.sheet_to_json(wb.Sheets[sn]);
          const trades = data.map(rcParseRow);
          const guessed = rcGuessAsset(trades);
          if (guessed === currentAsset) {
            rcTheirTrades = trades;
            sheetName = sn;
            found = true;
            break;
          }
        }
        if (!found) {
          // Fallback: use first sheet
          const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
          rcTheirTrades = data.map(rcParseRow);
          sheetName = wb.SheetNames[0];
          alert(`No sheet found matching ${currentAsset}. Using sheet "${sheetName}". Verify the trades are correct.`);
        }
      }

      rcRenderRows();
    } catch (err) {
      alert("Error parsing file: " + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
  e.target.value = "";
});

document.getElementById("rc-add-row").addEventListener("click", () => rcAddRow());
document.getElementById("rc-clear-rows").addEventListener("click", () => {
  rcTheirTrades = [];
  rcRenderRows();
});

// Run reconciliation
document.getElementById("rc-run").addEventListener("click", async () => {
  const counterparty = document.getElementById("rc-counterparty").value;
  if (!counterparty) { alert("Please select a counterparty"); return; }

  const btn = document.getElementById("rc-run");
  const resultsSection = document.getElementById("rc-results-section");
  const resultsContainer = document.getElementById("rc-results");

  // Show progress log
  btn.disabled = true;
  btn.textContent = "Running...";
  resultsSection.style.display = "";
  resultsContainer.innerHTML = `
    <div id="rc-log" style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;font-family:monospace;font-size:.78rem;max-height:300px;overflow-y:auto">
      <div style="color:var(--muted)">[${new Date().toLocaleTimeString()}] Starting reconciliation...</div>
      <div style="color:var(--muted)">[${new Date().toLocaleTimeString()}] Counterparty: <b>${counterparty}</b></div>
      <div style="color:var(--muted)">[${new Date().toLocaleTimeString()}] Asset: <b>${currentAsset}</b></div>
      <div style="color:var(--muted)">[${new Date().toLocaleTimeString()}] Their trades: <b>${rcTheirTrades.length}</b></div>
      <div style="color:var(--accent)">[${new Date().toLocaleTimeString()}] Fetching our book & comparing trades...</div>
      <div id="rc-log-spinner" style="color:var(--accent);margin-top:.5rem">&#9203; Please wait...</div>
    </div>`;
  resultsSection.scrollIntoView({ behavior: "smooth" });

  const payload = {
    counterparty,
    asset: currentAsset,
    their_trades: rcTheirTrades,
    their_collateral: {
      ETH: parseFloat(document.getElementById("rc-coll-eth").value) || 0,
      FIL: parseFloat(document.getElementById("rc-coll-fil").value) || 0,
      USD: parseFloat(document.getElementById("rc-coll-usd").value) || 0,
      USDC: parseFloat(document.getElementById("rc-coll-usdc").value) || 0,
    },
  };

  try {
    const res = await post("/api/trades/reconcile", payload);

    // Append completion to log, then render results after a brief pause
    const log = document.getElementById("rc-log");
    const spinner = document.getElementById("rc-log-spinner");
    if (spinner) spinner.remove();
    if (log) {
      const s = res.summary;
      log.innerHTML += `<div style="color:var(--green)">[${new Date().toLocaleTimeString()}] Reconciliation complete.</div>`;
      log.innerHTML += `<div style="color:var(--muted)">[${new Date().toLocaleTimeString()}] Our trades: ${s.our_count} | Their trades: ${s.their_count}</div>`;
      log.innerHTML += `<div style="color:var(--green)">[${new Date().toLocaleTimeString()}] Matched: ${s.matched}</div>`;
      if (s.breaks > 0) log.innerHTML += `<div style="color:var(--orange)">[${new Date().toLocaleTimeString()}] Breaks: ${s.breaks}</div>`;
      if (s.only_ours > 0) log.innerHTML += `<div style="color:var(--red)">[${new Date().toLocaleTimeString()}] Only ours: ${s.only_ours}</div>`;
      if (s.only_theirs > 0) log.innerHTML += `<div style="color:var(--red)">[${new Date().toLocaleTimeString()}] Only theirs: ${s.only_theirs}</div>`;
      log.innerHTML += `<div style="color:var(--muted)">[${new Date().toLocaleTimeString()}] Rendering results...</div>`;
    }

    setTimeout(() => rcRenderResults(res), 600);
    // Refresh history table
    rcLoadHistory();
  } catch (err) {
    const log = document.getElementById("rc-log");
    const spinner = document.getElementById("rc-log-spinner");
    if (spinner) spinner.remove();
    if (log) {
      log.innerHTML += `<div style="color:var(--red)">[${new Date().toLocaleTimeString()}] ERROR: ${err.message}</div>`;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Run reconciliation";
  }
});

// ─── Reconciliation History ─────────────────────────────────
async function rcLoadHistory() {
  try {
    const data = await get(`/api/trades/recon-history?asset=${currentAsset}`);
    rcRenderHistory(data.history || []);
  } catch (e) {
    const tbody = document.getElementById("rc-history-body");
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:1rem;color:var(--muted)">No history yet</td></tr>`;
  }
}

function rcRenderHistory(history) {
  const tbody = document.getElementById("rc-history-body");
  if (!tbody) return;

  if (history.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:1.5rem;color:var(--muted)">No reconciliation runs yet. Upload a counterparty file and run reconciliation above.</td></tr>`;
    return;
  }

  tbody.innerHTML = history.map(h => {
    const statusColor = h.status === "clean" ? "var(--green)"
                      : h.status === "breaks" ? "var(--orange)"
                      : "var(--red)";
    const statusLabel = h.status === "clean" ? "Clean"
                      : h.status === "breaks" ? "Breaks"
                      : "Mismatches";
    const statusIcon = h.status === "clean" ? "&#10003;"
                     : h.status === "breaks" ? "&#9888;"
                     : "&#10007;";
    // Format date nicely
    const d = new Date(h.run_date + (h.run_date.includes("Z") || h.run_date.includes("+") ? "" : "Z"));
    const dateStr = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    const timeStr = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

    const hasIssues = h.breaks > 0 || h.only_ours > 0 || h.only_theirs > 0;

    return `<tr>
      <td style="white-space:nowrap">${dateStr} <span style="color:var(--muted)">${timeStr}</span></td>
      <td style="text-align:left;font-weight:600">${h.counterparty}</td>
      <td>${h.asset}</td>
      <td>${h.our_count}</td>
      <td>${h.their_count}</td>
      <td style="color:var(--green);font-weight:600">${h.matched}</td>
      <td style="color:${h.breaks > 0 ? 'var(--orange)' : 'var(--muted)'};font-weight:${h.breaks > 0 ? '700' : '400'}">${h.breaks}</td>
      <td style="color:${h.only_ours > 0 ? 'var(--red)' : 'var(--muted)'};font-weight:${h.only_ours > 0 ? '700' : '400'}">${h.only_ours}</td>
      <td style="color:${h.only_theirs > 0 ? 'var(--red)' : 'var(--muted)'};font-weight:${h.only_theirs > 0 ? '700' : '400'}">${h.only_theirs}</td>
      <td style="color:${statusColor};font-weight:700">${statusIcon} ${statusLabel}</td>
    </tr>`;
  }).join("");
}

function rcRenderResults(res) {
  const section = document.getElementById("rc-results-section");
  const container = document.getElementById("rc-results");
  section.style.display = "";

  const s = res.summary;
  const fmtMoney = (v) => v != null && v !== 0 ? `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "--";
  const fmtQty = (v) => v != null && v !== 0 ? Math.abs(Number(v)).toLocaleString() : "--";

  let html = `
    <div class="risk-grid" style="margin-bottom:1rem">
      <div class="risk-metric"><span class="risk-label">Our Trades</span><span class="risk-value">${s.our_count}</span></div>
      <div class="risk-metric"><span class="risk-label">Their Trades</span><span class="risk-value">${s.their_count}</span></div>
      <div class="risk-metric"><span class="risk-label" style="color:var(--green)">Matched</span><span class="risk-value" style="color:var(--green)">${s.matched}</span></div>
      <div class="risk-metric"><span class="risk-label" style="color:var(--orange)">Breaks</span><span class="risk-value" style="color:var(--orange)">${s.breaks}</span></div>
      <div class="risk-metric"><span class="risk-label" style="color:var(--red)">Only Ours</span><span class="risk-value" style="color:var(--red)">${s.only_ours}</span></div>
      <div class="risk-metric"><span class="risk-label" style="color:var(--red)">Only Theirs</span><span class="risk-value" style="color:var(--red)">${s.only_theirs}</span></div>
    </div>`;

  // Build unified rows: [{status, ours, theirs, diffs}]
  const rows = [];
  res.matched.forEach(m => rows.push({ status: "match", ours: m.ours, theirs: m.theirs, diffs: {} }));
  res.breaks.forEach(b => rows.push({ status: "break", ours: b.ours, theirs: b.theirs, diffs: b.diffs }));
  res.only_ours.forEach(t => rows.push({ status: "only_ours", ours: t, theirs: null, diffs: {} }));
  res.only_theirs.forEach(t => rows.push({ status: "only_theirs", ours: null, theirs: t, diffs: {} }));

  // Sort: breaks first, then only_ours, only_theirs, then matched
  const order = { break: 0, only_ours: 1, only_theirs: 2, match: 3 };
  rows.sort((a, b) => order[a.status] - order[b.status]);

  const statusIcon = { match: "&#10003;", break: "&#9888;", only_ours: "&#8592;", only_theirs: "&#8594;" };
  const statusColor = { match: "var(--green)", break: "var(--orange)", only_ours: "var(--red)", only_theirs: "var(--red)" };
  const statusLabel = { match: "Match", break: "Break", only_ours: "Only Ours", only_theirs: "Only Theirs" };

  function cellStyle(field, row) {
    if (row.diffs && row.diffs[field]) return ' style="background:rgba(210,153,34,0.15);font-weight:600"';
    return "";
  }

  // Store rows for action handlers
  rows.forEach((r, i) => r._idx = i);
  container._reconRows = rows;
  container._reconCounterparty = res.counterparty;

  const ourCols = 7, theirCols = 7;
  html += `<div style="max-height:700px;overflow:auto;margin-top:1rem;border:1px solid var(--border);border-radius:var(--radius)">
  <table style="font-size:.76rem;border-collapse:collapse;width:100%;table-layout:fixed" id="rc-results-table">
    <thead style="position:sticky;top:0;z-index:2;background:var(--surface)">
      <tr style="border-bottom:2px solid var(--border)">
        <th rowspan="2" style="width:95px;position:sticky;top:0;background:var(--surface)">Status</th>
        <th colspan="${ourCols}" style="text-align:center;border-bottom:2px solid var(--accent);padding:.5rem;font-size:.82rem;background:var(--surface)">OUR BOOK</th>
        <th rowspan="2" style="width:3px;background:var(--border);padding:0"></th>
        <th colspan="${theirCols}" style="text-align:center;border-bottom:2px solid var(--orange);padding:.5rem;font-size:.82rem;background:var(--surface)">THEIR BOOK</th>
        <th rowspan="2" style="width:120px;background:var(--surface)">Action</th>
      </tr><tr style="background:var(--surface)">
        <th style="background:var(--surface)">Side</th><th style="background:var(--surface)">Type</th><th style="background:var(--surface)">Strike</th><th style="background:var(--surface)">Expiry</th><th style="background:var(--surface)">Trade Date</th><th style="background:var(--surface)">Qty</th><th style="background:var(--surface)">Premium</th>
        <th style="background:var(--surface)">Side</th><th style="background:var(--surface)">Type</th><th style="background:var(--surface)">Strike</th><th style="background:var(--surface)">Expiry</th><th style="background:var(--surface)">Trade Date</th><th style="background:var(--surface)">Qty</th><th style="background:var(--surface)">Premium</th>
      </tr>
    </thead><tbody>`;

  rows.forEach((r, i) => {
    const o = r.ours || {};
    const t = r.theirs || {};
    const color = statusColor[r.status];
    const empty = '<td style="color:var(--muted);text-align:center">—</td>';
    const sep = '<td style="background:var(--border);padding:0"></td>';
    const cs = "padding:.5rem .4rem";

    html += `<tr id="rc-row-${i}" style="border-bottom:1px solid var(--row-border)">`;
    html += `<td style="color:${color};white-space:nowrap;font-weight:600;${cs}" title="${statusLabel[r.status]}">${statusIcon[r.status]} ${statusLabel[r.status]}</td>`;

    // Our side — show absolute values for qty & premium
    if (r.ours) {
      html += `<td${cellStyle("side", r)} style="${cs}">${o.side || ""}</td>`;
      html += `<td${cellStyle("option_type", r)} style="${cs}">${o.option_type || ""}</td>`;
      html += `<td${cellStyle("strike", r)} style="${cs}">${o.strike || ""}</td>`;
      html += `<td${cellStyle("expiry", r)} style="${cs}">${o.expiry_norm || o.expiry || ""}</td>`;
      html += `<td${cellStyle("trade_date", r)} style="${cs}">${o.trade_date_norm || o.trade_date || ""}</td>`;
      html += `<td${cellStyle("qty", r)} style="${cs}">${fmtQty(o.qty)}</td>`;
      html += `<td${cellStyle("premium_usd", r)} style="${cs}">${fmtMoney(Math.abs(o.premium_usd || 0))}</td>`;
    } else {
      html += empty.repeat(ourCols);
    }

    html += sep;

    // Their side — show absolute values for qty & premium
    if (r.theirs) {
      html += `<td${cellStyle("side", r)} style="${cs}">${t.side || ""}</td>`;
      html += `<td${cellStyle("option_type", r)} style="${cs}">${t.option_type || ""}</td>`;
      html += `<td${cellStyle("strike", r)} style="${cs}">${t.strike || ""}</td>`;
      html += `<td${cellStyle("expiry", r)} style="${cs}">${t.expiry_norm || t.expiry || ""}</td>`;
      html += `<td${cellStyle("trade_date", r)} style="${cs}">${t.trade_date_norm || t.trade_date || ""}</td>`;
      html += `<td${cellStyle("qty", r)} style="${cs}">${fmtQty(t.qty)}</td>`;
      html += `<td${cellStyle("premium_usd", r)} style="${cs}">${fmtMoney(Math.abs(t.premium_usd || 0))}</td>`;
    } else {
      html += empty.repeat(theirCols);
    }

    // Action column
    html += `<td style="white-space:nowrap;${cs};text-align:center">`;
    if (r.status === "only_ours") {
      html += `<button class="btn-secondary btn-delete rc-action" data-action="remove" data-idx="${i}" style="font-size:.68rem;padding:.2rem .4rem;width:auto" title="Remove from our book">Remove</button>`;
    } else if (r.status === "only_theirs") {
      html += `<button class="btn-primary rc-action" data-action="add" data-idx="${i}" style="font-size:.68rem;padding:.2rem .4rem;width:auto" title="Add to our book">Add</button>`;
    } else if (r.status === "break") {
      html += `<button class="btn-secondary rc-action" data-action="update" data-idx="${i}" style="font-size:.68rem;padding:.2rem .4rem;width:auto;color:var(--orange);border-color:var(--orange)" title="Update ours to match theirs">Align</button> `;
      html += `<button class="btn-secondary rc-action" data-action="keep" data-idx="${i}" style="font-size:.68rem;padding:.2rem .4rem;width:auto;color:var(--accent);border-color:var(--accent)" title="Keep our values">Keep Ours</button>`;
    } else {
      html += `<span style="color:var(--green);font-size:.8rem">&#10003;</span>`;
    }
    html += `</td></tr>`;

    // If there are field-level diffs, show detail row
    if (Object.keys(r.diffs).length > 0) {
      const diffText = Object.entries(r.diffs).map(([f, v]) =>
        `<b>${f}</b>: ours=${v.ours}, theirs=${v.theirs}`
      ).join(" &nbsp;&bull;&nbsp; ");
      html += `<tr id="rc-diff-${i}" style="border-bottom:1px solid var(--row-border)"><td></td><td colspan="${ourCols + theirCols + 1}" style="font-size:.72rem;color:var(--orange);padding:.2rem .5rem;background:rgba(210,153,34,0.05)">${diffText}</td><td></td></tr>`;
    }
  });

  html += `</tbody></table></div>`;

  // Collateral
  const coll = res.collateral;
  html += `<h3 style="margin:1rem 0 .5rem">Reported Collateral</h3>
  <table style="max-width:250px"><thead><tr><th>Asset</th><th>Quantity</th></tr></thead><tbody>
    <tr><td>ETH</td><td>${coll.ETH}</td></tr>
    <tr><td>FIL</td><td>${coll.FIL}</td></tr>
    <tr><td>USD</td><td>${coll.USD}</td></tr>
    <tr><td>USDC</td><td>${coll.USDC}</td></tr>
  </tbody></table>`;

  container.innerHTML = html;
  container._lastResult = res;

  // Wire action buttons
  container.querySelectorAll(".rc-action").forEach(btn => {
    btn.addEventListener("click", () => rcHandleAction(btn.dataset.action, parseInt(btn.dataset.idx)));
  });
}

async function rcHandleAction(action, idx) {
  const container = document.getElementById("rc-results");
  const rows = container._reconRows;
  const counterparty = container._reconCounterparty;
  const r = rows[idx];
  if (!r) return;

  try {
    if (action === "remove") {
      // Delete trade from our book
      const dbId = r.ours.id || r.ours.db_id;
      if (!dbId) { alert("Cannot find trade ID to remove"); return; }
      if (!confirm(`Remove ${r.ours.side} ${r.ours.option_type} ${r.ours.strike} ${r.ours.expiry} from our book?`)) return;
      await api("DELETE", `/api/trades/${dbId}`);
      rcMarkRowDone(idx, "Removed");

    } else if (action === "add") {
      // Add their trade to our book — normalize values to match our conventions
      const t = r.theirs;
      if (!confirm(`Add ${t.side} ${t.option_type} ${t.strike} ${t.expiry} x${Math.abs(t.qty)} to our book?`)) return;
      // Normalize side: Buy/Sell (title case)
      const rawSide = (t.side || "").trim().toLowerCase();
      const normSide = ["buy","buys","bought","long","b","l"].includes(rawSide) ? "Buy"
                     : ["sell","sells","sold","short","s"].includes(rawSide) ? "Sell" : t.side;
      // Normalize option type: Call/Put (title case)
      const rawType = (t.option_type || "").trim().toLowerCase();
      const normType = ["c","call","calls"].includes(rawType) ? "Call"
                     : ["p","put","puts"].includes(rawType) ? "Put" : t.option_type;
      // Normalize counterparty: match existing case from our trades if possible
      const cpLower = counterparty.toLowerCase();
      const existingCp = (tmTrades || []).find(x => (x.counterparty || "").toLowerCase() === cpLower);
      const normCp = existingCp ? existingCp.counterparty : counterparty;
      // Normalize dates to YYYY-MM-DD
      const normExpiry = rcNormDate(t.expiry);
      const normTradeDate = rcNormDate(t.trade_date);
      // Build instrument name from expiry/strike/type (e.g. ETH-26JUN26-2375-P)
      const strikeVal = parseFloat(t.strike) || 0;
      const optCode = normType === "Put" ? "P" : "C";
      let instrument = "";
      if (normExpiry && strikeVal > 0) {
        const ed = new Date(normExpiry + "T00:00:00");
        const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
        const prefix = currentAsset === "FIL" ? "FIL" : "ETH";
        instrument = `${prefix}-${ed.getDate()}${months[ed.getMonth()]}${String(ed.getFullYear()).slice(2)}-${Math.round(strikeVal)}-${optCode}`;
      }
      await post("/api/trades/", {
        asset: currentAsset,
        counterparty: normCp,
        trade_id: "",
        trade_date: normTradeDate,
        side: normSide,
        option_type: normType,
        instrument: instrument,
        expiry: normExpiry,
        strike: strikeVal,
        qty: Math.abs(parseFloat(t.qty) || 0),
        premium_usd: parseFloat(t.premium_usd) || 0,
      });
      rcMarkRowDone(idx, "Added");

    } else if (action === "update") {
      // Update our trade to match theirs
      const dbId = r.ours.id || r.ours.db_id;
      if (!dbId) { alert("Cannot find trade ID to update"); return; }
      const diffs = r.diffs;
      const changes = {};
      for (const [field, vals] of Object.entries(diffs)) {
        changes[field] = vals.theirs;
      }
      const diffDesc = Object.entries(diffs).map(([f, v]) => `${f}: ${v.ours} → ${v.theirs}`).join(", ");
      if (!confirm(`Align trade to counterparty's values?\n${diffDesc}`)) return;
      await api("PUT", `/api/trades/${dbId}`, changes);
      rcMarkRowDone(idx, "Aligned");

    } else if (action === "keep") {
      // Accept our side as correct — just mark the row resolved
      rcMarkRowDone(idx, "Kept Ours");
    }

    // Refresh trade management data in background
    tmLoaded = false;
  } catch (err) {
    alert(`Action failed: ${err.message}`);
  }
}

function rcMarkRowDone(idx, label) {
  const row = document.getElementById(`rc-row-${idx}`);
  if (!row) return;
  // Replace action button with done label
  const actionCell = row.querySelector("td:last-child");
  if (actionCell) {
    actionCell.innerHTML = `<span style="color:var(--green);font-size:.7rem;font-weight:600">&#10003; ${label}</span>`;
  }
  row.style.opacity = "0.5";
  // Also dim the diff row if present
  const diffRow = document.getElementById(`rc-diff-${idx}`);
  if (diffRow) diffRow.style.opacity = "0.5";
}

// Download report as .md
document.getElementById("rc-download-report").addEventListener("click", (e) => {
  e.preventDefault();
  const container = document.getElementById("rc-results");
  const res = container._lastResult;
  if (!res) { alert("Run reconciliation first"); return; }

  const s = res.summary;
  const fmtMoney = (v) => v != null ? `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "--";
  const today = new Date().toISOString().split("T")[0];

  let md = `# Counterparty Reconciliation Report\n\n`;
  md += `**Counterparty:** ${res.counterparty}  \n`;
  md += `**Asset:** ${res.asset}  \n`;
  md += `**Date:** ${today}  \n\n`;
  md += `## Summary\n\n`;
  md += `| Metric | Count |\n|--------|-------|\n`;
  md += `| Our trades | ${s.our_count} |\n`;
  md += `| Their trades | ${s.their_count} |\n`;
  md += `| Matched | ${s.matched} |\n`;
  md += `| Breaks | ${s.breaks} |\n`;
  md += `| Only ours | ${s.only_ours} |\n`;
  md += `| Only theirs | ${s.only_theirs} |\n\n`;

  md += `## Trade-by-Trade Comparison\n\n`;
  md += `| Status | Our Side | Our Type | Our Strike | Our Expiry | Our Date | Our Qty | Our Premium | Their Side | Their Type | Their Strike | Their Expiry | Their Date | Their Qty | Their Premium |\n`;
  md += `|--------|----------|----------|------------|------------|----------|---------|-------------|------------|------------|--------------|--------------|------------|-----------|---------------|\n`;

  const allRows = [];
  res.matched.forEach(m => allRows.push({ status: "Match", ours: m.ours, theirs: m.theirs, diffs: {} }));
  res.breaks.forEach(b => allRows.push({ status: "Break", ours: b.ours, theirs: b.theirs, diffs: b.diffs }));
  res.only_ours.forEach(t => allRows.push({ status: "Only Ours", ours: t, theirs: null, diffs: {} }));
  res.only_theirs.forEach(t => allRows.push({ status: "Only Theirs", ours: null, theirs: t, diffs: {} }));
  const mdOrder = { Break: 0, "Only Ours": 1, "Only Theirs": 2, Match: 3 };
  allRows.sort((a, b) => mdOrder[a.status] - mdOrder[b.status]);

  allRows.forEach(r => {
    const o = r.ours || {};
    const t = r.theirs || {};
    const oExp = o.expiry_norm || o.expiry || "—";
    const oDate = o.trade_date_norm || o.trade_date || "—";
    const tExp = t.expiry_norm || t.expiry || "—";
    const tDate = t.trade_date_norm || t.trade_date || "—";
    md += `| ${r.status} | ${o.side || "—"} | ${o.option_type || "—"} | ${o.strike || "—"} | ${oExp} | ${oDate} | ${o.qty ? Math.abs(o.qty) : "—"} | ${fmtMoney(o.premium_usd)} | ${t.side || "—"} | ${t.option_type || "—"} | ${t.strike || "—"} | ${tExp} | ${tDate} | ${t.qty ? Math.abs(t.qty) : "—"} | ${fmtMoney(t.premium_usd)} |\n`;
    if (Object.keys(r.diffs).length > 0) {
      const diffDetail = Object.entries(r.diffs).map(([f, v]) => `${f}: ours=${v.ours}, theirs=${v.theirs}`).join("; ");
      md += `| | *${diffDetail}* | | | | | | | | | | | | | |\n`;
    }
  });
  md += "\n";

  const coll = res.collateral;
  md += `## Reported Collateral\n\n| Asset | Quantity |\n|-------|----------|\n`;
  md += `| ETH | ${coll.ETH} |\n| FIL | ${coll.FIL} |\n| USD | ${coll.USD} |\n| USDC | ${coll.USDC} |\n`;

  const blob = new Blob([md], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `Recon_${res.counterparty}_${today}.md`;
  a.click();
});

// ─── Positions / Risk ───────────────────────────────────────
let positionsLoaded = false;

async function loadPositions() {
  try {
    const [trades, summary] = await Promise.all([
      get("/api/positions/trades"),
      get("/api/positions/summary"),
    ]);

    const t = summary.totals;

    // Totals banner
    document.getElementById("tot-positions").textContent = t.positions_count;
    document.getElementById("tot-trades").textContent    = t.trades_count;
    document.getElementById("tot-long").textContent      = t.long_count;
    document.getElementById("tot-short").textContent     = t.short_count;
    document.getElementById("tot-net-qty").textContent   = t.total_net_qty.toLocaleString(undefined, { maximumFractionDigits: 2 });
    document.getElementById("tot-premium").textContent   = `$${t.total_premium_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    document.getElementById("tot-notional").textContent  = `$${t.total_notional_mm.toFixed(2)}mm`;

    // Positions table
    const $posBody = document.getElementById("positions-body");
    $posBody.innerHTML = "";

    for (const p of summary.positions) {
      const sideClass = p.side === "Long" ? "qty-long" : p.side === "Short" ? "qty-short" : "qty-flat";
      const typeColor = (p.option_type || "").toUpperCase().includes("CALL") ? "var(--green)" : "var(--red)";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="text-align:left" class="${sideClass}"><strong>${p.side}</strong></td>
        <td style="text-align:left; color:${typeColor}">${p.option_type}</td>
        <td>${fmtStrike(p.strike)}</td>
        <td>${p.expiry}</td>
        <td>${p.days_remaining.toFixed(0)}</td>
        <td>${(p.pct_otm * 100).toFixed(1)}%</td>
        <td class="${sideClass}" style="font-family:monospace">${p.net_qty.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
        <td style="font-family:monospace">$${p.avg_premium_per_contract.toFixed(2)}</td>
        <td style="font-family:monospace">$${p.total_premium_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
        <td style="font-family:monospace">$${p.total_notional_mm.toFixed(2)}mm</td>
        <td>${p.trade_count}</td>
        <td style="text-align:left; font-size:.7rem">${p.counterparties.join(", ")}</td>
      `;
      $posBody.appendChild(tr);
    }

    // Exposure chart
    drawExposureChart(summary.positions);

    // Raw trades table
    document.getElementById("trades-count").textContent = `(${trades.length} trades)`;
    if (trades.length > 0) {
      const displayCols = [
        "Counterparty", "Initial Trade Date", "Buy / Sell / Unwind",
        "Option Type", "Option Expiry Date", "Days Remaining to Expiry",
        "Strike", "Ref. Spot Price", "% OTM", "ETH Options",
        "$ Notional (mm)", "Premium per Contract", "Premium USD",
      ];
      const keys = displayCols.filter(k => k in trades[0]);

      const $thead = document.getElementById("trades-thead");
      $thead.innerHTML = "<tr>" + keys.map(k => `<th>${k}</th>`).join("") + "</tr>";

      const $tbody = document.getElementById("trades-body");
      $tbody.innerHTML = "";
      for (const row of trades) {
        const tr = document.createElement("tr");
        tr.innerHTML = keys.map(k => {
          let v = row[k];
          if (v == null) return "<td>—</td>";
          if (typeof v === "number") {
            if (Math.abs(v) >= 1000) v = v.toLocaleString(undefined, { maximumFractionDigits: 2 });
            else v = v.toFixed(4);
          }
          return `<td>${v}</td>`;
        }).join("");
        $tbody.appendChild(tr);
      }
    }

    positionsLoaded = true;
  } catch (e) {
    console.error("Failed to load positions:", e);
    alert("Failed to load positions — check console.\n" + e.message);
  }
}

function drawExposureChart(positions) {
  const calls = positions.filter(p => (p.option_type || "").toUpperCase().includes("CALL"));
  const puts  = positions.filter(p => (p.option_type || "").toUpperCase().includes("PUT"));

  const traces = [];

  if (calls.length) {
    traces.push({
      x: calls.map(p => `${p.strike}`),
      y: calls.map(p => p.net_qty),
      type: "bar",
      name: "Calls",
      marker: { color: "#3fb950" },
      text: calls.map(p => p.expiry),
      hovertemplate: "Strike %{x}<br>Qty: %{y}<br>Expiry: %{text}<extra>Call</extra>",
    });
  }

  if (puts.length) {
    traces.push({
      x: puts.map(p => `${p.strike}`),
      y: puts.map(p => p.net_qty),
      type: "bar",
      name: "Puts",
      marker: { color: "#f85149" },
      text: puts.map(p => p.expiry),
      hovertemplate: "Strike %{x}<br>Qty: %{y}<br>Expiry: %{text}<extra>Put</extra>",
    });
  }

  const cc = chartColors();
  const layout = {
    title: { text: "Net Exposure by Strike", font: { color: cc.text, size: 16 } },
    paper_bgcolor: cc.paper,
    plot_bgcolor: cc.plot,
    barmode: "group",
    xaxis: {
      title: "Strike (USD)",
      color: cc.muted,
      gridcolor: cc.grid,
      type: "category",
    },
    yaxis: {
      title: "Net Quantity (ETH Options)",
      color: cc.muted,
      gridcolor: cc.grid,
      zerolinecolor: "#f85149",
      zerolinewidth: 2,
    },
    margin: { t: 50, r: 30, b: 60, l: 60 },
    showlegend: true,
    legend: { font: { color: cc.muted } },
  };

  Plotly.newPlot("exposure-chart", traces, layout, { responsive: true });
}

// ─── Portfolio P&L (interactive) ───────────────────────────
let portfolioLoaded = false;
let pfData = null;              // raw API response
let pfCollateralMap = null;     // /api/collateral/map response (posted collateral by counterparty × token)
// Portfolio P&L collateral overlay draws the slice matching the page's asset
// (currentAsset) — the ETH/FIL split is set entirely on the Collateral page.
let pfSelected = new Set();     // selected position indices
let pfRolled = new Map();       // idx → { newDte }
let pfSortCol = "expiry";
let pfSortAsc = true;

// ── JS Black-Scholes ──────────────────────────────────────
function normCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function bsPrice(S, K, T, r, sigma, type) {
  if (T <= 0) return type === "C" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (type === "C") return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

function bsVec(spots, K, T, r, sigma, type) {
  return spots.map(S => bsPrice(S, K, T, r, sigma, type));
}

// ── Vol surface lookup for rolls ─────────────────────────
// Given a target DTE and strike, find the closest Deribit expiry smile
// and interpolate IV at that strike. Returns IV in % (e.g. 80.0).
function pfLookupIv(targetDte, strike) {
  if (!pfData || !pfData.vol_surface || pfData.vol_surface.length === 0) return null;
  const surface = pfData.vol_surface;

  // Find the closest expiry by DTE
  let best = surface[0];
  let bestDiff = Math.abs(best.dte - targetDte);
  for (const entry of surface) {
    const diff = Math.abs(entry.dte - targetDte);
    if (diff < bestDiff) { bestDiff = diff; best = entry; }
  }

  // Interpolate IV at the given strike using the smile's strikes/ivs arrays
  const strikes = best.strikes;
  const ivs = best.ivs;
  if (!strikes || strikes.length === 0) return null;
  if (strike <= strikes[0]) return ivs[0];
  if (strike >= strikes[strikes.length - 1]) return ivs[ivs.length - 1];

  // Linear interpolation between the two bracketing strikes
  for (let i = 0; i < strikes.length - 1; i++) {
    if (strike >= strikes[i] && strike <= strikes[i + 1]) {
      const t = (strike - strikes[i]) / (strikes[i + 1] - strikes[i]);
      return ivs[i] + t * (ivs[i + 1] - ivs[i]);
    }
  }
  return ivs[ivs.length - 1];
}

// ── Compare mode state ────────────────────────────────────
let pfCompareMode = false;
let pfExpiredData = null; // portfolio data including expired trades (for compare)
let pfOldSet = new Set();  // trade IDs in old portfolio (user-selected)
let pfNewSet = new Set();  // trade IDs in new portfolio (user-selected)

// ── Load ──────────────────────────────────────────────────
async function loadPortfolio() {
  const $btn = document.getElementById("btn-refresh-portfolio");
  $btn.classList.add("loading");
  $btn.textContent = "Loading…";

  const includeExpired = document.getElementById("pf-include-expired").checked;

  try {
    pfData = await get(`/api/portfolio/pnl?asset=${currentAsset}&include_expired=${includeExpired}`);
    pfSelected = new Set(pfData.positions.filter(p => p.db_status === "active").map(p => p.id));
    pfRolled = new Map();

    // Posted-collateral overlay data — sourced from the Collateral Map
    // (counterparty_collateral), the same table the Collateral tab edits.
    // Best-effort: a failure here must not break the P&L page.
    try {
      pfCollateralMap = await get("/api/collateral/map");
    } catch (e) {
      console.warn("Collateral map unavailable for overlay:", e);
      pfCollateralMap = null;
    }

    // Default: expired → Old only, active → both Old AND New
    pfOldSet = new Set();
    pfNewSet = new Set();
    for (const p of pfData.positions) {
      if (p.db_status === "expired") {
        pfOldSet.add(p.id);
      } else {
        pfOldSet.add(p.id);
        pfNewSet.add(p.id);
      }
    }

    // Populate counterparty filter
    const cptys = [...new Set(pfData.positions.map(p => p.counterparty || "").filter(Boolean))].sort();
    const $cpF = document.getElementById("pf-filter-cpty");
    $cpF.innerHTML = '<option value="">All</option>';
    cptys.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c; opt.textContent = c;
      $cpF.appendChild(opt);
    });

    // Populate expiry filter
    const expiries = [...new Set(pfData.positions.map(p => p.expiry.split("T")[0]))].sort();
    const $expF = document.getElementById("pf-filter-expiry");
    $expF.innerHTML = '<option value="">All</option>';
    expiries.forEach(e => {
      const opt = document.createElement("option");
      opt.value = e; opt.textContent = e;
      $expF.appendChild(opt);
    });

    // Show/hide no-live-data banner for FIL
    const banner = document.getElementById("pf-no-live-banner");
    if (banner) banner.style.display = pfData.no_live_data ? "" : "none";
    // Show/hide stale-spot banner — live feed down (e.g. Deribit maintenance),
    // eth_spot fell back to the most recent trade's own reference spot.
    const staleSpotBanner = document.getElementById("pf-stale-spot-banner");
    if (staleSpotBanner) staleSpotBanner.style.display = pfData.stale_spot ? "" : "none";
    document.getElementById("pf-spot-label").textContent = `${currentAsset} Spot`;

    pfRenderAll();
    portfolioLoaded = true;
  } catch (e) {
    console.error("Failed to load portfolio:", e);
    if (e.message && e.message.includes("404")) {
      // No trades for this asset yet
      const banner = document.getElementById("pf-no-live-banner");
      if (banner) banner.style.display = "none";
      portfolioLoaded = true;
      return;
    }
    alert("Failed to load portfolio P&L — check console.\n" + e.message);
  } finally {
    $btn.classList.remove("loading");
    $btn.textContent = "Refresh";
  }
}

// ── Render all ────────────────────────────────────────────
function pfRenderAll() {
  if (!pfData) return;
  pfRenderSummary();
  pfRenderTable();
  pfRenderPayoffChart();
  pfRenderMtmGrid();
}

// ── Summary banner ────────────────────────────────────────
function pfRenderSummary() {
  const all = pfData.positions;
  const sel = all.filter(p => pfSelected.has(p.id));

  document.getElementById("pf-spot").textContent =
    `$${pfData.eth_spot.toLocaleString(undefined, { maximumFractionDigits: currentAsset === "FIL" ? 2 : 0 })}`;
  document.getElementById("pf-count").textContent = all.length;
  document.getElementById("pf-selected-count").textContent = sel.length;

  const baselineMtm = all.reduce((s, p) => s + p.current_mtm, 0);
  const scenarioMtm = pfCalcScenarioMtm();
  const delta = scenarioMtm - baselineMtm;

  document.getElementById("pf-entry-prem").textContent =
    `$${sel.reduce((s, p) => s + Math.abs(p.premium_usd), 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const mtmTotal = sel.reduce((s, p) => s + (p.current_mtm || 0), 0);
  const $remPrem = document.getElementById("pf-remaining-prem");
  $remPrem.textContent = `$${mtmTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  $remPrem.className = `risk-value ${mtmTotal >= 0 ? "mtm-pos" : "mtm-neg"}`;

  const $base = document.getElementById("pf-baseline-mtm");
  $base.textContent = `$${baselineMtm.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  $base.className = `risk-value ${baselineMtm >= 0 ? "mtm-pos" : "mtm-neg"}`;

  const $scen = document.getElementById("pf-scenario-mtm");
  $scen.textContent = `$${scenarioMtm.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  $scen.className = `risk-value ${scenarioMtm >= 0 ? "mtm-pos" : "mtm-neg"}`;

  const $delta = document.getElementById("pf-delta-mtm");
  $delta.textContent = `${delta >= 0 ? "+" : ""}$${delta.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  $delta.className = `risk-value ${delta >= 0 ? "mtm-pos" : "mtm-neg"}`;

  // Portfolio greeks totals
  if (pfData.totals) {
    const t = pfData.totals;
    document.getElementById("pf-total-delta").textContent = t.portfolio_delta != null ? t.portfolio_delta.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "--";
    document.getElementById("pf-total-gamma").textContent = t.portfolio_gamma != null ? t.portfolio_gamma.toFixed(4) : "--";
    document.getElementById("pf-total-theta").textContent = t.portfolio_theta != null ? t.portfolio_theta.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "--";
    document.getElementById("pf-total-vega").textContent = t.portfolio_vega != null ? t.portfolio_vega.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "--";
  }
}

function pfCalcScenarioMtm() {
  let total = 0;
  for (const p of pfData.positions) {
    if (!pfSelected.has(p.id)) continue;
    if (pfRolled.has(p.id)) {
      const newDte = pfRolled.get(p.id).newDte;
      const T = Math.max(newDte, 0) / 365.25;
      const rollIvPct = pfLookupIv(newDte, p.strike) ?? p.iv_pct;
      const sigma = rollIvPct / 100;
      const val = bsPrice(pfData.eth_spot, p.strike, T, 0, sigma, p.opt);
      total += p.net_qty * val;
    } else {
      total += p.current_mtm;
    }
  }
  return total;
}

// ── Position table ────────────────────────────────────────
function pfUpdateOldNewHeaders() {
  const visible = pfGetFilteredPositions();
  document.getElementById("pf-old-all").checked = visible.length > 0 && visible.every(p => pfOldSet.has(p.id));
  document.getElementById("pf-new-all").checked = visible.length > 0 && visible.every(p => pfNewSet.has(p.id));
}

function pfGetFilteredPositions() {
  const fCpty = document.getElementById("pf-filter-cpty").value;
  const fExpiry = document.getElementById("pf-filter-expiry").value;
  const fType = document.getElementById("pf-filter-type").value;
  const fSide = document.getElementById("pf-filter-side").value;

  let list = [...pfData.positions];
  if (fCpty) list = list.filter(p => (p.counterparty || "") === fCpty);
  if (fExpiry) list = list.filter(p => p.expiry.split("T")[0] === fExpiry);
  if (fType) list = list.filter(p => p.opt === fType);
  if (fSide) list = list.filter(p => p.side === fSide);

  // Sort
  if (pfSortCol) {
    list.sort((a, b) => {
      let va = a[pfSortCol], vb = b[pfSortCol];
      if (typeof va === "string") { va = va.toLowerCase(); vb = (vb || "").toLowerCase(); }
      if (va < vb) return pfSortAsc ? -1 : 1;
      if (va > vb) return pfSortAsc ? 1 : -1;
      return 0;
    });
  }
  return list;
}

function pfRenderTable() {
  const list = pfGetFilteredPositions();
  document.getElementById("pf-table-count").textContent = `(${list.length} shown)`;

  // Update sort indicators
  document.querySelectorAll("#pf-positions-table .sortable").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.col === pfSortCol) {
      th.classList.add(pfSortAsc ? "sort-asc" : "sort-desc");
    }
  });

  // Update header checkboxes
  const allVisibleOld = list.length > 0 && list.every(p => pfOldSet.has(p.id));
  const allVisibleNew = list.length > 0 && list.every(p => pfNewSet.has(p.id));
  document.getElementById("pf-old-all").checked = allVisibleOld;
  document.getElementById("pf-new-all").checked = allVisibleNew;

  const $tbody = document.getElementById("pf-positions-body");
  $tbody.innerHTML = "";

  for (const pos of list) {
    const checked = pfSelected.has(pos.id);
    const rolled = pfRolled.has(pos.id);
    const typeColor = pos.opt === "C" ? "var(--green)" : "var(--red)";
    const sideClass = pos.side === "Long" ? "qty-long" : pos.side === "Short" ? "qty-short" : "";
    const isExpired = pos.db_status === "expired";
    const rowClass = (isExpired ? "pf-row-expired " : "") + (!checked ? "pf-row-excluded" : "") + (rolled ? " pf-row-rolled" : "");
    const rollDte = rolled ? pfRolled.get(pos.id).newDte : Math.round(pos.days_remaining + 90);
    const _sd = currentAsset === "FIL" ? 2 : 0;
    const fmtNum = (v, d=0) => v != null ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : "—";
    const otmClass = pos.pct_otm_live > 0 ? "mtm-neg" : pos.pct_otm_live < 0 ? "mtm-pos" : "";
    const fmtGreek = (v, d) => v != null ? v.toFixed(d) : "—";

    // Roll cost: close current + open new
    // = signed_qty * (current_mark - new_mark)
    // negative = pay, positive = receive
    let rollCostHtml = "—";
    let rollCurMarkHtml = "—";
    let rollNewMarkHtml = "—";
    let rollIvHtml = "—";
    if (rolled) {
      const newDte = pfRolled.get(pos.id).newDte;
      const T = Math.max(newDte, 0) / 365.25;
      const rollIvPct = pfLookupIv(newDte, pos.strike) ?? pos.iv_pct;
      const sigma = rollIvPct / 100;
      const newMark = bsPrice(pfData.eth_spot, pos.strike, T, 0, sigma, pos.opt);
      const curMark = pos.mark_price_usd ?? 0;
      const cost = pos.net_qty * (curMark - newMark);
      const rounded = Math.round(cost);
      const cls = rounded >= 0 ? "mtm-pos" : "mtm-neg";
      const label = rounded >= 0 ? "Receive" : "Pay";
      rollCostHtml = `<span class="${cls}">${label} $${Math.abs(rounded).toLocaleString()}</span>`;
      rollCurMarkHtml = `$${curMark.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
      rollNewMarkHtml = `$${newMark.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
      rollIvHtml = `${rollIvPct.toFixed(1)}%`;
    }

    const isOld = pfOldSet.has(pos.id);
    const isNew = pfNewSet.has(pos.id);
    const tr = document.createElement("tr");
    tr.className = rowClass + (!isOld && !isNew ? " pf-row-excluded" : "");
    tr.innerHTML =
      `<td><input type="checkbox" class="pf-old-check" data-id="${pos.id}" ${isOld ? "checked" : ""} style="accent-color:#f0883e"></td>` +
      `<td><input type="checkbox" class="pf-new-check" data-id="${pos.id}" ${isNew ? "checked" : ""} style="accent-color:var(--accent)"></td>` +
      `<td style="text-align:left">${pos.counterparty}</td>` +
      `<td>${pos.trade_id ?? ""}</td>` +
      `<td>${pos.trade_date}</td>` +
      `<td style="text-align:left" class="${sideClass}">${pos.side_raw}</td>` +
      `<td style="text-align:left;color:${typeColor}">${pos.option_type}</td>` +
      `<td style="text-align:left;font-size:.8rem">${pos.instrument}</td>` +
      `<td>${pos.expiry}</td>` +
      `<td>${Math.round(pos.days_remaining)}</td>` +
      `<td style="font-family:monospace">${fmtNum(pos.strike, _sd)}</td>` +
      `<td class="${otmClass}">${pos.pct_otm_live}%</td>` +
      `<td style="font-family:monospace">${fmtNum(pos.qty)}</td>` +
      `<td style="font-family:monospace">${fmtNum(pos.premium_per, 2)}</td>` +
      `<td style="font-family:monospace">$${fmtNum(pos.premium_usd)}</td>` +
      `<td>${pos.iv_pct.toFixed(1)}%</td>` +
      `<td class="${pos.current_mtm >= 0 ? 'mtm-pos' : 'mtm-neg'}" style="font-family:monospace">` +
        `$${fmtNum(pos.current_mtm)}</td>` +
      `<td class="${(pos.collateral_call_usd || 0) > 0 ? 'mtm-neg' : ''}" style="font-family:monospace" ` +
        `title="Collateral the counterparty would call on this position">` +
        `${(pos.collateral_call_usd || 0) > 0 ? '$' + fmtNum(pos.collateral_call_usd) : '—'}</td>` +
      `<td style="text-align:center"><input type="checkbox" class="pf-roll" data-id="${pos.id}" ${rolled ? "checked" : ""}></td>` +
      `<td><input type="number" class="roll-dte-input" data-id="${pos.id}" value="${rollDte}" ` +
        `${rolled ? "" : "disabled"} min="1" step="1"></td>` +
      `<td style="font-family:monospace;white-space:nowrap">${rollCurMarkHtml}</td>` +
      `<td style="font-family:monospace;white-space:nowrap">${rollNewMarkHtml}</td>` +
      `<td style="font-family:monospace;white-space:nowrap">${rollIvHtml}</td>` +
      `<td style="font-family:monospace;white-space:nowrap">${rollCostHtml}</td>`;
    $tbody.appendChild(tr);
  }

  // Wire Old checkboxes (independent — a trade can be in both Old and New)
  $tbody.querySelectorAll(".pf-old-check").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) pfOldSet.add(id); else pfOldSet.delete(id);
      pfUpdateOldNewHeaders();
      pfOnSelectionChange();
    });
  });

  // Wire New checkboxes (independent)
  $tbody.querySelectorAll(".pf-new-check").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) pfNewSet.add(id); else pfNewSet.delete(id);
      pfUpdateOldNewHeaders();
      pfOnSelectionChange();
    });
  });

  $tbody.querySelectorAll(".pf-roll").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = parseInt(cb.dataset.id);
      const pos = pfData.positions.find(p => p.id === id);
      const dteInput = $tbody.querySelector(`.roll-dte-input[data-id="${id}"]`);
      if (cb.checked) {
        pfRolled.set(id, { newDte: parseInt(dteInput.value) || Math.round(pos.days_remaining + 90) });
        dteInput.disabled = false;
      } else {
        pfRolled.delete(id);
        dteInput.disabled = true;
      }
      // Full re-render to update roll cost column
      pfRenderTable();
      pfOnSelectionChange();
    });
  });

  $tbody.querySelectorAll(".roll-dte-input").forEach(inp => {
    inp.addEventListener("change", () => {
      const id = parseInt(inp.dataset.id);
      if (pfRolled.has(id)) {
        pfRolled.get(id).newDte = parseInt(inp.value) || 90;
        // Full re-render to update roll cost column
        pfRenderTable();
        pfOnSelectionChange();
      }
    });
  });
}

function pfOnSelectionChange() {
  // Update pfSelected to union of old + new for summary/roll compat
  pfSelected = new Set([...pfOldSet, ...pfNewSet]);
  pfRenderSummary();
  pfRenderPayoffChart();
  pfRenderMtmGrid();
}

// ── Curve helpers ─────────────────────────────────────────
function pfSumCurves(positionIds, horizon) {
  const key = String(horizon);
  const spots = pfData.spot_ladder;
  const result = new Array(spots.length).fill(0);

  for (const p of pfData.positions) {
    if (!positionIds.has(p.id)) continue;

    if (pfRolled.has(p.id) && horizon !== "__baseline__") {
      // Rolled: recompute with new DTE using vol surface IV
      const newDte = pfRolled.get(p.id).newDte;
      const T = Math.max(newDte - horizon, 0) / 365.25;
      const rollIvPct = pfLookupIv(newDte, p.strike) ?? p.iv_pct;
      const sigma = rollIvPct / 100;
      for (let i = 0; i < spots.length; i++) {
        const val = bsPrice(spots[i], p.strike, T, 0, sigma, p.opt);
        result[i] += p.net_qty * val;
      }
    } else {
      // Use pre-computed curves
      const curve = p.payoff_by_horizon[key];
      if (curve) {
        for (let i = 0; i < spots.length; i++) result[i] += curve[i];
      }
    }
  }
  return result;
}

function pfBaselineCurve(horizon) {
  // All positions, no rolls, using pre-computed data
  const key = String(horizon);
  const spots = pfData.spot_ladder;
  const result = new Array(spots.length).fill(0);
  for (const p of pfData.positions) {
    const curve = p.payoff_by_horizon[key];
    if (curve) for (let i = 0; i < spots.length; i++) result[i] += curve[i];
  }
  return result;
}

// ── Payoff chart ──────────────────────────────────────────

function pfSumCurveForSet(positionIds, horizon) {
  const key = String(horizon);
  const spots = pfData.spot_ladder;
  const result = new Array(spots.length).fill(0);
  for (const p of pfData.positions) {
    if (!positionIds.has(p.id)) continue;
    const curve = p.payoff_by_horizon[key];
    if (curve) for (let i = 0; i < spots.length; i++) result[i] += curve[i];
  }
  return result;
}

/** Initialize compare sets with sensible defaults:
 *  Old = expired trades, New = active trades. User can override.
 */
function pfInitCompareSets() {
  pfOldSet = new Set();
  pfNewSet = new Set();
  for (const p of pfData.positions) {
    if (p.db_status === "expired") {
      pfOldSet.add(p.id);
    } else {
      pfNewSet.add(p.id);
    }
  }
}

// ── Posted-collateral overlay ─────────────────────────────
// Values one counterparty's posted collateral (token qtys from the Collateral
// Map) across the spot ladder. The token matching the page's current asset
// (ETH on the ETH page, FIL on the FIL page) is re-valued at each ladder spot;
// every other token is held at its effective map price (USDC = 1). So an
// ETH-collateralised holding slopes up with spot while a USDC holding reads flat.

// Posted collateral is split per options book (ETH / FIL) in the Collateral
// Map (each counterparty carries `books: {ETH:{...}, FIL:{...}}`). The Portfolio
// P&L overlay uses the slice matching the page's asset (currentAsset) directly —
// no manual scope selection, no hardcoded split. Edit the split on the
// Collateral page and it flows straight through here.
function pfBookQtysFor(cp) {
  return (cp && cp.books && cp.books[currentAsset]) || {};
}

function pfCollMapValueAt(qtys, spot, applyHaircut) {
  const prices = pfCollateralMap.prices || {};
  const hc = pfCollateralMap.haircuts || {};
  let sum = 0;
  for (const asset of Object.keys(qtys)) {
    const q = qtys[asset] || 0;
    if (!q) continue;
    const px = asset === currentAsset ? spot
      : asset === "USDC" ? 1
      : (prices[asset] || 0);
    const cut = applyHaircut ? (1 - (hc[asset] || 0)) : 1;
    sum += q * px * cut;
  }
  return sum;
}

function pfCollMapCurve(cptys, spots, applyHaircut) {
  return spots.map(s => cptys.reduce((sum, c) =>
    sum + pfCollMapValueAt(pfBookQtysFor(c), s, applyHaircut), 0));
}

// Counterparties with any collateral allocated to the current book.
function pfBookCptys() {
  const cps = (pfCollateralMap && pfCollateralMap.counterparties) || [];
  return cps.filter(c => Object.values(pfBookQtysFor(c)).some(Boolean));
}

// On-screen note describing the current book's allocation (from the Collateral Map).
function pfCollateralNoteText() {
  const fmtQ = q => {
    const bits = [];
    if (q.ETH) bits.push(`${q.ETH.toLocaleString()} ETH`);
    if (q.FIL) bits.push(`${q.FIL.toLocaleString()} FIL`);
    if (q.BTC) bits.push(`${q.BTC.toLocaleString()} BTC`);
    if (q.USDC) bits.push(`$${q.USDC.toLocaleString()} USDC`);
    return bits.join(" + ");
  };
  const parts = pfBookCptys().map(c => `${c.counterparty} ${fmtQ(pfBookQtysFor(c))}`);
  const body = parts.length ? parts.join("; ") : "none allocated";
  return `${currentAsset} book collateral (from Collateral Map) — ${body}. `
    + `${currentAsset} revalues with spot; USDC held at $1. Edit the split on the Collateral page.`;
}

// Multi-line hover tooltip: current book collateral per counterparty + total $.
function pfBookTooltip() {
  const lines = [`${currentAsset} book collateral (from Collateral Map):`];
  const prices = (pfCollateralMap && pfCollateralMap.prices) || {};
  const fmtTok = (a, q) => a === "USDC" ? `$${q.toLocaleString()} USDC` : `${q.toLocaleString()} ${a}`;
  const totals = {};
  for (const c of pfBookCptys()) {
    const q = pfBookQtysFor(c);
    const bits = [];
    Object.keys(q).forEach(a => {
      if (!q[a]) return;
      bits.push(fmtTok(a, q[a]));
      totals[a] = (totals[a] || 0) + q[a];
    });
    if (bits.length) lines.push(`  • ${c.counterparty}: ${bits.join(" + ")}`);
  }
  if (!Object.keys(totals).length) { lines.push("  (nothing allocated to this book)"); return lines.join("\n"); }
  lines.push(`Total: ${Object.entries(totals).map(([a, q]) => fmtTok(a, q)).join(" + ")}`);
  const totalUsd = Object.entries(totals).reduce((s, [a, q]) =>
    s + q * (a === "USDC" ? 1 : (prices[a] || 0)), 0);
  if (totalUsd) lines.push(`≈ $${Math.round(totalUsd).toLocaleString()}`);
  lines.push(`${currentAsset} revalues with spot; USDC held at $1.`);
  return lines.join("\n");
}

// Counterparties in scope for the overlay, honouring the Counterparty filter.
function pfCollateralActiveCptys() {
  if (!pfCollateralMap || !Array.isArray(pfCollateralMap.counterparties)) return [];
  const fCpty = document.getElementById("pf-filter-cpty").value;
  if (fCpty) return pfCollateralMap.counterparties.filter(c =>
    (c.counterparty || "").toLowerCase() === fCpty.toLowerCase());
  return pfCollateralMap.counterparties;
}

/** Positive posted-collateral curve for the active filter + scope + haircut,
 *  or null when nothing is posted. Shared by the collateral line and the
 *  residual (collateral + payoff) overlay. */
function pfCollateralSumCurve(spots) {
  const cptys = pfCollateralActiveCptys();
  if (!cptys.length) return null;
  const applyHaircut = document.getElementById("pf-collateral-haircut")?.checked || false;
  const curve = pfCollMapCurve(cptys, spots, applyHaircut);
  return curve.every(v => Math.abs(v) < 1) ? null : curve;
}

/** Build the posted-collateral overlay trace from the Collateral Map. Plotted
 *  on the SAME (left) axis as the payoff profile so the two are directly
 *  comparable in USD; negated when "invert" is on so the cushion dives
 *  alongside the (negative) liability payoff. Returns [] when off/empty. */
function pfCollateralTraces(spots) {
  const toggle = document.getElementById("pf-show-collateral");
  if (!toggle || !toggle.checked) return [];
  const curve = pfCollateralSumCurve(spots);
  if (!curve) return [];

  const invert = document.getElementById("pf-collateral-invert")?.checked ?? true;
  const applyHaircut = document.getElementById("pf-collateral-haircut")?.checked || false;
  const fCpty = document.getElementById("pf-filter-cpty").value;
  const name = (fCpty ? `${fCpty} collateral` : "Collateral posted")
    + ` · ${currentAsset} book` + (applyHaircut ? " (post-haircut)" : "");

  // customdata keeps the true (positive) posted $ for the hover.
  return [{
    x: spots, y: invert ? curve.map(v => -v) : curve, type: "scatter", mode: "lines",
    name,
    customdata: curve,
    line: { color: "#d29922", width: 2, dash: "dash" },
    legendgroup: "collateral",
    hovertemplate: name + ": $%{customdata:,.0f} posted<extra></extra>",
  }];
}

function pfRenderPayoffChart() {
  const spots = pfData.spot_ladder;
  const allHorizons = pfData.chart_horizons;

  const oldColors = ["#f0883e", "#da3633", "#d29922", "#e3b341", "#f78166", "#bc8cff"];
  const newColors = ["#58a6ff", "#3fb950", "#bc8cff", "#79c0ff", "#56d364", "#d2a8ff"];
  const traces = [];

  const oldPositions = pfData.positions.filter(p => pfOldSet.has(p.id));
  const newPositions = pfData.positions.filter(p => pfNewSet.has(p.id));

  // Filter horizons: skip horizons beyond the max DTE of selected positions
  // (otherwise they just duplicate the expiry curve and are misleading)
  function relevantHorizons(positions) {
    if (positions.length === 0) return allHorizons;
    const maxDte = Math.max(...positions.map(p => p.days_remaining || 0));
    // Always include h=0 (expiry/spot). Only include h>0 if at least one position lives past it.
    return allHorizons.filter(h => h === 0 || h < maxDte);
  }

  function horizonLabel(prefix, h) {
    return h === 0 ? `${prefix}: Spot (at expiry)` : `${prefix}: T+${h}d`;
  }

  // Old portfolio curves (dotted)
  if (oldPositions.length > 0) {
    const oldH = relevantHorizons(oldPositions);
    oldH.forEach((h, i) => {
      const curve = pfSumCurveForSet(pfOldSet, h);
      traces.push({
        x: spots, y: curve, type: "scatter", mode: "lines",
        name: horizonLabel("Old", h),
        line: { color: oldColors[i % oldColors.length], width: 2, dash: "dot" },
        legendgroup: `old_h${h}`,
      });
    });
  }

  // New portfolio curves (solid)
  if (newPositions.length > 0) {
    const newH = relevantHorizons(newPositions);
    newH.forEach((h, i) => {
      const curve = pfSumCurves(pfNewSet, h);
      traces.push({
        x: spots, y: curve, type: "scatter", mode: "lines",
        name: horizonLabel("New", h),
        line: { color: newColors[i % newColors.length], width: 2.5 },
        legendgroup: `new_h${h}`,
      });
    });
  }

  // Posted-collateral overlay (dashed lines on the right axis, honours filter)
  const collTraces = pfCollateralTraces(spots);
  const collInvert = document.getElementById("pf-collateral-invert")?.checked ?? true;

  // Residual (collateral + payoff at expiry) overlay — optional, right axis.
  if (document.getElementById("pf-collateral-residual")?.checked) {
    const collCurve = pfCollateralSumCurve(spots);
    let payoffCurve = null, plabel = "";
    if (newPositions.length > 0) { payoffCurve = pfSumCurves(pfNewSet, 0); plabel = "New"; }
    else if (oldPositions.length > 0) { payoffCurve = pfSumCurveForSet(pfOldSet, 0); plabel = "Old"; }
    if (collCurve && payoffCurve) {
      // Always POSITIVE collateral + payoff — the true net coverage. Never the
      // inverted collateral (that would sum two negatives). Not affected by the
      // invert toggle, so it always reads as the real signed residual.
      const residual = collCurve.map((c, i) => c + (payoffCurve[i] || 0));
      collTraces.push({
        x: spots, y: residual, type: "scatter", mode: "lines",
        name: `Residual (collateral + ${plabel} payoff @ expiry)`,
        customdata: residual,
        line: { color: "#2dd4bf", width: 2.5, dash: "dashdot" },
        legendgroup: "collateral",
        hovertemplate: "Residual: $%{customdata:,.0f}<extra></extra>",
      });
    }
  }

  // Spot line — span the full left-axis range (payoff + collateral overlays)
  // including zero, so it reaches the $0 line even when everything is negative
  // (e.g. the FIL book). Collateral now shares this axis, so include it.
  const allY = [...traces.flatMap(t => t.y), ...collTraces.flatMap(t => t.y)];
  if (allY.length > 0) {
    traces.push({
      x: [pfData.eth_spot, pfData.eth_spot],
      y: [Math.min(0, ...allY), Math.max(0, ...allY)],
      type: "scatter", mode: "lines",
      name: `Spot $${fmtSpot(pfData.eth_spot)}`,
      line: { color: "#3fb950", width: 1.5, dash: "dashdot" },
      legendgroup: "spot",
    });
  }
  traces.push(...collTraces);

  const cc = chartColors();
  const assetLabel = currentAsset + " Spot Price (USD)";
  const titleText = `Portfolio Payoff — Old (${oldPositions.length}) vs New (${newPositions.length})`;
  const layout = {
    title: { text: titleText, font: { color: cc.text, size: 16 } },
    paper_bgcolor: cc.paper, plot_bgcolor: cc.plot,
    xaxis: { title: assetLabel + " — log scale", type: "log", color: cc.muted, gridcolor: cc.grid, zerolinecolor: cc.zeroline },
    yaxis: {
      title: "Portfolio P&L / Collateral (USD" + (collInvert ? ", collateral negative)" : ")"),
      color: cc.muted, gridcolor: cc.grid, zerolinecolor: "#f85149", zerolinewidth: 2,
      tickformat: "$,.2s", rangemode: "tozero",
    },
    margin: { t: 50, r: 200, b: 50, l: 80 },
    showlegend: true,
    legend: {
      font: { color: cc.muted, size: 10 },
      orientation: "v", x: 1.13, y: 1,
      xanchor: "left", yanchor: "top",
      bgcolor: cc.legendBg, bordercolor: cc.legendBorder, borderwidth: 1,
    },
  };

  Plotly.react("portfolio-payoff-chart", traces, layout, { responsive: true, scrollZoom: true });

  const noteEl = document.getElementById("pf-collateral-note");
  if (noteEl) { noteEl.textContent = pfCollateralNoteText(); noteEl.title = pfBookTooltip(); }
}

// ── MTM Matrix (HTML table with dollar values) ───────────
function pfRenderMtmGrid() {
  const spots = pfData.spot_ladder;
  const horizons = pfData.matrix_horizons;
  const ethSpot = pfData.eth_spot;

  const oldPositions = pfData.positions.filter(p => pfOldSet.has(p.id));
  const newPositions = pfData.positions.filter(p => pfNewSet.has(p.id));
  const hasOldAndNew = oldPositions.length > 0 && newPositions.length > 0;

  // Build header row
  const thead = document.getElementById("pf-mtm-grid-thead");
  if (hasOldAndNew) {
    let hdrHtml = `<tr><th rowspan="2" style="text-align:left">Spot</th>`;
    for (const h of horizons) hdrHtml += `<th colspan="2">${h}d</th>`;
    hdrHtml += `</tr><tr>`;
    for (const h of horizons) hdrHtml += `<th style="color:#f0883e;font-size:.7rem">Old</th><th style="color:var(--accent);font-size:.7rem">New</th>`;
    hdrHtml += `</tr>`;
    thead.innerHTML = hdrHtml;
  } else {
    thead.innerHTML = `<tr><th style="text-align:left">Spot</th>${horizons.map(h => `<th>${h}d</th>`).join("")}</tr>`;
  }

  // Pick spots at appropriate increments
  const step = currentAsset === "FIL" ? 0.2 : 500;
  const maxSpot = currentAsset === "FIL" ? 3.0 : 7000;
  const displaySpots = [];
  for (let s = step; s <= maxSpot; s += step) {
    const rounded = Math.round(s * 100) / 100;  // avoid float drift
    const idx = spots.findIndex(sp => Math.abs(sp - rounded) < 0.001);
    if (idx !== -1) displaySpots.push({ spot: rounded, idx });
  }
  displaySpots.reverse();

  let closestSpot = displaySpots[0]?.spot ?? 0;
  let closestDiff = Infinity;
  for (const ds of displaySpots) {
    const diff = Math.abs(ds.spot - ethSpot);
    if (diff < closestDiff) { closestDiff = diff; closestSpot = ds.spot; }
  }

  // Pre-compute curves
  const oldCurves = {}, newCurves = {};
  const singleSet = newPositions.length > 0 ? pfNewSet : pfOldSet;
  for (const h of horizons) {
    if (hasOldAndNew) {
      oldCurves[h] = pfSumCurveForSet(pfOldSet, h);
      newCurves[h] = pfSumCurves(pfNewSet, h);
    } else {
      oldCurves[h] = pfSumCurveForSet(singleSet, h);
    }
  }

  const fmtVal = v => { const r = Math.round(v); return r >= 0 ? `$${r.toLocaleString()}` : `-$${Math.abs(r).toLocaleString()}`; };

  const tbody = document.getElementById("pf-mtm-grid-body");
  let html = "";
  for (const { spot, idx } of displaySpots) {
    const isSpotRow = spot === closestSpot;
    html += `<tr class="${isSpotRow ? "pf-mtm-spot-row" : ""}">`;
    html += `<td style="text-align:left;font-weight:600;white-space:nowrap">$${spot.toLocaleString()}</td>`;
    for (const h of horizons) {
      const oldVal = oldCurves[h][idx];
      const oldCls = oldVal >= 0 ? "mtm-pos" : "mtm-neg";
      if (hasOldAndNew) {
        const newVal = newCurves[h][idx];
        const newCls = newVal >= 0 ? "mtm-pos" : "mtm-neg";
        html += `<td class="${oldCls}" style="font-size:.75rem">${fmtVal(oldVal)}</td>`;
        html += `<td class="${newCls}" style="font-size:.75rem">${fmtVal(newVal)}</td>`;
      } else {
        html += `<td class="${oldCls}">${fmtVal(oldVal)}</td>`;
      }
    }
    html += "</tr>";
  }
  tbody.innerHTML = html;
}

// ── Portfolio event wiring ────────────────────────────────
document.getElementById("btn-refresh-portfolio").addEventListener("click", () => {
  portfolioLoaded = false;
  loadPortfolio();
});

document.getElementById("pf-include-expired").addEventListener("change", () => {
  portfolioLoaded = false;
  loadPortfolio();
});

// Header Old/New all checkboxes
document.getElementById("pf-old-all").addEventListener("change", (e) => {
  pfGetFilteredPositions().forEach(p => {
    if (e.target.checked) pfOldSet.add(p.id); else pfOldSet.delete(p.id);
  });
  pfRenderTable();
  pfOnSelectionChange();
});

document.getElementById("pf-new-all").addEventListener("change", (e) => {
  pfGetFilteredPositions().forEach(p => {
    if (e.target.checked) pfNewSet.add(p.id); else pfNewSet.delete(p.id);
  });
  pfRenderTable();
  pfOnSelectionChange();
});

document.getElementById("btn-pf-select-all").addEventListener("click", () => {
  const visible = pfGetFilteredPositions();
  visible.forEach(p => { pfOldSet.add(p.id); pfNewSet.add(p.id); });
  pfRenderTable();
  pfOnSelectionChange();
});

document.getElementById("btn-pf-deselect-all").addEventListener("click", () => {
  const visible = pfGetFilteredPositions();
  visible.forEach(p => { pfOldSet.delete(p.id); pfNewSet.delete(p.id); });
  pfRenderTable();
  pfOnSelectionChange();
});

document.getElementById("btn-pf-expiring-10d").addEventListener("click", () => {
  if (!pfData) return;
  // Mark positions expiring within 10 days as Old
  pfData.positions.forEach(p => {
    if (p.days_remaining <= 10) {
      pfOldSet.add(p.id);
      pfNewSet.delete(p.id);
    }
  });
  pfRenderTable();
  pfOnSelectionChange();
});

["pf-filter-cpty", "pf-filter-expiry", "pf-filter-type", "pf-filter-side"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => { if (pfData) pfRenderTable(); });
});

// Counterparty filter also re-scopes the posted-collateral overlay; the
// collateral toggles just redraw the chart.
["pf-filter-cpty", "pf-show-collateral", "pf-collateral-haircut",
 "pf-collateral-invert", "pf-collateral-residual"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => { if (pfData) pfRenderPayoffChart(); });
});

document.querySelectorAll("#pf-positions-table .sortable").forEach(th => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    if (pfSortCol === col) pfSortAsc = !pfSortAsc;
    else { pfSortCol = col; pfSortAsc = true; }
    pfRenderTable();
  });
});

// ── Add Trade (frontend-only what-if) ────────────────────
let pfNextId = 90000; // synthetic IDs for added trades

document.getElementById("btn-pf-add-trade").addEventListener("click", () => {
  const instrument = prompt("Instrument name (e.g. ETH-27JUN25-4000-C):");
  if (!instrument) return;
  const side = prompt("Side (buy/sell):", "buy");
  if (!side) return;
  const qtyStr = prompt("Quantity (ETH options):", "1000");
  if (!qtyStr) return;
  const premStr = prompt("Total premium USD (negative=paid, positive=received):", "0");
  if (premStr === null) return;

  const qty = parseFloat(qtyStr) || 0;
  const premUsd = parseFloat(premStr) || 0;
  if (qty <= 0) { alert("Quantity must be positive."); return; }

  const name = instrument.trim().toUpperCase();

  // Fetch Deribit ticker for live data
  get(`/api/portfolio/ticker/${encodeURIComponent(name)}`)
    .then(tk => {
      const sign = side.toLowerCase() === "sell" ? -1 : 1;
      const signedQty = sign * qty;
      const markUsd = tk.mark_price_usd || 0;

      // Generate payoff curves using JS BS
      const sigma = (tk.mark_iv || 80) / 100;
      const opt = tk.opt || "C";
      const strike = tk.strike || 0;
      const dte = tk.days_remaining || 0;
      const spots = pfData.spot_ladder;
      const allHorizons = pfData.all_horizons;
      const payoff = {};
      for (const h of allHorizons) {
        const T = Math.max(dte - h, 0) / 365.25;
        const vals = bsVec(spots, strike, T, 0, sigma, opt);
        payoff[String(h)] = vals.map(v => Math.round(signedQty * v * 100) / 100);
      }

      // Build MTM horizon array
      const mtmHorizon = pfData.matrix_horizons.map(h => {
        const T = Math.max(dte - h, 0) / 365.25;
        const val = bsPrice(pfData.eth_spot, strike, T, 0, sigma, opt);
        return Math.round(signedQty * val * 100) / 100;
      });

      const curMtm = signedQty * markUsd;

      const newPos = {
        id: pfNextId++,
        counterparty: "What-If",
        trade_id: null,
        trade_date: new Date().toISOString().split("T")[0],
        side_raw: side.toLowerCase() === "sell" ? "Sell" : "Buy",
        option_type: opt === "C" ? "Call" : "Put",
        instrument: name,
        expiry: tk.expiry || "",
        days_remaining: dte,
        strike: strike,
        pct_otm_entry: 0,
        qty: qty,
        notional_mm: 0,
        premium_per: premUsd / qty,
        premium_usd: premUsd,
        opt: opt,
        side: sign > 0 ? "Long" : "Short",
        net_qty: signedQty,
        pct_otm_live: pfData.eth_spot > 0 ? Math.round((strike / pfData.eth_spot - 1) * 1000) / 10 : 0,
        iv_pct: tk.mark_iv || 80,
        delta: tk.delta,
        gamma: tk.gamma,
        theta: tk.theta,
        vega: tk.vega,
        mark_price_usd: markUsd,
        current_mtm: Math.round(curMtm * 100) / 100,
        notional_live: Math.round(qty * pfData.eth_spot * 100) / 100,
        mtm_by_horizon: mtmHorizon,
        payoff_by_horizon: payoff,
      };

      pfData.positions.push(newPos);
      pfNewSet.add(newPos.id);
      pfSelected.add(newPos.id);
      pfRenderAll();
    })
    .catch(e => {
      console.error("Failed to fetch ticker:", e);
      alert("Failed to fetch instrument data from Deribit.\n" + e.message);
    });
});

// ── Remove Selected (frontend-only) ─────────────────────
document.getElementById("btn-pf-remove-selected").addEventListener("click", () => {
  if (!pfData) return;
  const toRemove = new Set(pfSelected);
  if (toRemove.size === 0) { alert("No trades selected to remove."); return; }
  if (!confirm(`Remove ${toRemove.size} selected trade(s) from the scenario?`)) return;

  pfData.positions = pfData.positions.filter(p => !toRemove.has(p.id));
  for (const id of toRemove) { pfOldSet.delete(id); pfNewSet.delete(id); }
  pfSelected = new Set([...pfOldSet, ...pfNewSet]);
  pfRolled = new Map([...pfRolled].filter(([k]) => pfSelected.has(k)));
  pfRenderAll();
});

// ── Export to Excel ───────────────────────────────────────
document.getElementById("btn-pf-export-xlsx").addEventListener("click", () => {
  if (!pfData) return;

  const positions = pfGetFilteredPositions().filter(p => pfSelected.has(p.id));
  if (positions.length === 0) { alert("No selected trades to export."); return; }

  const spot = pfData.eth_spot;
  const rows = positions.map(pos => {
    const rolled = pfRolled.has(pos.id);
    const newDte = rolled ? pfRolled.get(pos.id).newDte : null;

    // Roll cost calculation (mirrors table render logic)
    let rollCost = null;
    let rollLabel = "";
    let rollCurMark = null;
    let rollNewMark = null;
    let rollIvUsed = null;
    if (rolled && newDte != null) {
      const T = Math.max(newDte, 0) / 365.25;
      const rollIvPct = pfLookupIv(newDte, pos.strike) ?? pos.iv_pct;
      const sigma = rollIvPct / 100;
      const newMark = bsPrice(spot, pos.strike, T, 0, sigma, pos.opt);
      const curMark = pos.mark_price_usd ?? 0;
      rollCost = Math.round(pos.net_qty * (curMark - newMark));
      rollLabel = rollCost >= 0 ? "Receive" : "Pay";
      rollCurMark = Math.round(curMark * 100) / 100;
      rollNewMark = Math.round(newMark * 100) / 100;
      rollIvUsed = Math.round(rollIvPct * 10) / 10;
    }

    return {
      "Counterparty": pos.counterparty,
      "ID": pos.trade_id,
      "Trade Date": pos.trade_date,
      "Buy/Sell": pos.side_raw,
      "Type": pos.option_type,
      "Instrument": pos.instrument,
      "Expiry": pos.expiry,
      "DTE": Math.round(pos.days_remaining),
      "Strike": pos.strike,
      "% OTM": pos.pct_otm_live,
      "ETH Qty": pos.qty,
      "Net Qty": pos.net_qty,
      "Entry Prem/Contract": pos.premium_per,
      "Entry USD": pos.premium_usd,
      "IV%": pos.iv_pct,
      "Mark Price USD": pos.mark_price_usd,
      "MTM": pos.current_mtm,
      "Collateral Call": pos.collateral_call_usd,
      "Roll": rolled ? "Yes" : "",
      "New DTE": newDte,
      "Cur Mark (Close)": rollCurMark,
      "New Mark (Open)": rollNewMark,
      "IV Used": rollIvUsed,
      "Roll Cost": rollCost,
      "Roll Direction": rollLabel,
    };
  });

  // Summary row
  const totalMtm = positions.reduce((s, p) => s + (p.current_mtm || 0), 0);
  const totalEntry = positions.reduce((s, p) => s + Math.abs(p.premium_usd || 0), 0);
  const totalCollCall = positions.reduce((s, p) => s + (p.collateral_call_usd || 0), 0);
  const totalRollCost = rows.reduce((s, r) => s + (r["Roll Cost"] || 0), 0);
  rows.push({});  // blank row
  rows.push({
    "Counterparty": "TOTALS",
    "ETH Qty": positions.reduce((s, p) => s + p.qty, 0),
    "Net Qty": positions.reduce((s, p) => s + p.net_qty, 0),
    "Entry USD": totalEntry,
    "MTM": totalMtm,
    "Collateral Call": totalCollCall,
    "Roll Cost": totalRollCost || null,
    "Roll Direction": totalRollCost ? (totalRollCost >= 0 ? "Net Receive" : "Net Pay") : "",
  });

  // Portfolio greeks summary
  const gd = (field) => positions.reduce((s, p) => s + ((p[field] || 0) * p.net_qty), 0);
  rows.push({
    "Counterparty": "PORTFOLIO GREEKS",
    "Delta": Math.round(gd("delta") * 100) / 100,
    "Gamma": Math.round(gd("gamma") * 10000) / 10000,
    "Theta": Math.round(gd("theta") * 100) / 100,
    "Vega": Math.round(gd("vega") * 100) / 100,
  });

  // Create workbook
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  // Column widths
  ws["!cols"] = [
    { wch: 15 }, // Counterparty
    { wch: 8 },  // ID
    { wch: 12 }, // Trade Date
    { wch: 8 },  // Buy/Sell
    { wch: 6 },  // Type
    { wch: 24 }, // Instrument
    { wch: 12 }, // Expiry
    { wch: 6 },  // DTE
    { wch: 8 },  // Strike
    { wch: 7 },  // % OTM
    { wch: 10 }, // ETH Qty
    { wch: 10 }, // Net Qty
    { wch: 14 }, // Entry Prem
    { wch: 14 }, // Entry USD
    { wch: 7 },  // IV%
    { wch: 8 },  // Delta
    { wch: 10 }, // Gamma
    { wch: 10 }, // Theta
    { wch: 8 },  // Vega
    { wch: 14 }, // Mark Price USD
    { wch: 14 }, // MTM
    { wch: 5 },  // Roll
    { wch: 8 },  // New DTE
    { wch: 14 }, // Cur Mark (Close)
    { wch: 14 }, // New Mark (Open)
    { wch: 8 },  // IV Used
    { wch: 14 }, // Roll Cost
    { wch: 12 }, // Roll Direction
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Portfolio");

  // Filename with date
  const dateStr = new Date().toISOString().split("T")[0];
  XLSX.writeFile(wb, `PLGO_Portfolio_${dateStr}.xlsx`);
});

// ─── Roll Analysis ──────────────────────────────────────────
let rollLoaded = false;
let rollSelected = new Set();
let rollIncluded = new Set();  // positions included in portfolio chart/matrix
let rollLastResults = null;    // last computed roll results (for refreshing visuals)
// Multi-level sort: clicking a new column makes it primary, old primary becomes secondary
let rollSortStack = [{ col: "expiry", asc: true }];

async function rollInit() {
  if (!pfData) {
    try {
      pfData = await get(`/api/portfolio/pnl?asset=${currentAsset}`);
      portfolioLoaded = true;
      if (pfSelected.size === 0) {
        pfSelected = new Set(pfData.positions.map(p => p.id));
      }
    } catch (e) {
      console.error("Failed to load portfolio for roll analysis:", e);
      alert("Failed to load portfolio data.\n" + e.message);
      return;
    }
  }
  rollPopulate();
}

function rollPopulate() {
  // Populate position expiry filter
  const expiries = [...new Set(pfData.positions.map(p => p.expiry.split("T")[0]))].sort();
  const $expF = document.getElementById("roll-filter-expiry");
  $expF.innerHTML = '<option value="">All</option>';
  expiries.forEach(e => {
    const opt = document.createElement("option");
    opt.value = e; opt.textContent = e;
    $expF.appendChild(opt);
  });

  // Populate target expiry dropdown from Deribit vol surface
  const $targetExp = document.getElementById("roll-target-expiry");
  $targetExp.innerHTML = "";
  const smiles = (pfData.vol_surface || []).filter(s => s.dte > 0);
  smiles.sort((a, b) => a.dte - b.dte);
  smiles.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.expiry_code;
    opt.textContent = `${s.expiry_code} (${s.dte}d)`;
    $targetExp.appendChild(opt);
  });
  // Default to nearest expiry
  if (smiles.length > 0) $targetExp.value = smiles[0].expiry_code;

  rollSelected = new Set();
  rollIncluded = new Set(pfData.positions.map(p => p.id));
  rollRenderTable();
  rollDrawChart(null);
  rollRenderMtmGrid(null);
  rollLoaded = true;
}

function rollGetFilteredPositions() {
  const fExpiry = document.getElementById("roll-filter-expiry").value;
  const fType = document.getElementById("roll-filter-type").value;
  const fSide = document.getElementById("roll-filter-side").value;
  let list = [...pfData.positions];
  if (fExpiry) list = list.filter(p => p.expiry.split("T")[0] === fExpiry);
  if (fType) list = list.filter(p => p.opt === fType);
  if (fSide) list = list.filter(p => p.side === fSide);

  if (rollSortStack.length > 0) {
    list.sort((a, b) => {
      for (const { col, asc } of rollSortStack) {
        let va = a[col], vb = b[col];
        if (typeof va === "string") { va = va.toLowerCase(); vb = (vb || "").toLowerCase(); }
        if (va < vb) return asc ? -1 : 1;
        if (va > vb) return asc ? 1 : -1;
      }
      return 0;
    });
  }
  return list;
}

function rollGetExpiryOptions(selectedCode) {
  const smiles = (pfData.vol_surface || []).filter(s => s.dte > 0);
  smiles.sort((a, b) => a.dte - b.dte);
  return smiles.map(s =>
    `<option value="${s.expiry_code}" ${s.expiry_code === selectedCode ? "selected" : ""}>${s.expiry_code} (${s.dte}d)</option>`
  ).join("");
}

function rollGetTargetExpiry() {
  return document.getElementById("roll-target-expiry").value;
}

function rollDteForExpiry(code) {
  const s = (pfData.vol_surface || []).find(s => s.expiry_code === code);
  return s ? s.dte : 90;
}

function rollComputeRow(pos) {
  const row = pos._rollRow || document.querySelector(`#roll-trades-body tr[data-pos-id="${pos.id}"]`);
  const expirySelect = row ? row.querySelector(".roll-expiry-select") : null;
  const strikeInput = row ? row.querySelector(".roll-strike-input") : null;
  const newExpiryCode = expirySelect ? expirySelect.value : rollGetTargetExpiry();
  const newStrike = strikeInput ? parseFloat(strikeInput.value) || pos.strike : pos.strike;
  const newDte = rollDteForExpiry(newExpiryCode);
  const T = Math.max(newDte, 0) / 365.25;
  const spot = pfData.eth_spot;
  const rollIvPct = pfLookupIv(newDte, newStrike) ?? pos.iv_pct;
  const sigma = rollIvPct / 100;
  const newMark = bsPrice(spot, newStrike, T, 0, sigma, pos.opt);
  const curMark = pos.mark_price_usd ?? 0;
  const cost = pos.net_qty * (curMark - newMark);
  return { newExpiryCode, newDte, newStrike, newMark, rollIvPct, curMark, cost };
}

function rollInlineUpdate(row) {
  const posId = parseInt(row.dataset.posId);
  const pos = pfData.positions.find(p => p.id === posId);
  if (!pos) return;
  const newExpCode = row.querySelector(".roll-expiry-select").value;
  const newStrike = parseFloat(row.querySelector(".roll-strike-input").value) || pos.strike;
  const newAbsQty = parseFloat(row.querySelector(".roll-qty-input").value);
  const newType = row.querySelector(".roll-type-select").value;
  const sign = pos.net_qty >= 0 ? 1 : -1;
  const newNetQty = isNaN(newAbsQty) ? pos.net_qty : sign * newAbsQty;
  const newDte = rollDteForExpiry(newExpCode);
  const T = Math.max(newDte, 0) / 365.25;
  const iv = pfLookupIv(newDte, newStrike) ?? pos.iv_pct;
  const sigma = iv / 100;
  const nm = bsPrice(pfData.eth_spot, newStrike, T, 0, sigma, newType);
  const cm = pos.mark_price_usd ?? 0;
  // Close current position + open new at new qty
  const closeVal = pos.net_qty * cm;
  const openVal = newNetQty * nm;
  const cost = closeVal - openVal;
  const cr = Math.round(cost);
  row.querySelector(".roll-new-mark").textContent = `$${nm.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  row.querySelector(".roll-iv-used").textContent = `${iv.toFixed(1)}%`;
  const costCell = row.querySelector(".roll-cost");
  costCell.textContent = `${cr >= 0 ? "Rcv" : "Pay"} $${Math.abs(cr).toLocaleString()}`;
  costCell.className = `${cr >= 0 ? "mtm-pos" : "mtm-neg"} roll-cost`;
  costCell.style.fontFamily = "monospace";
  costCell.style.fontWeight = "600";
}

function rollRenderTable() {
  const list = rollGetFilteredPositions();
  document.getElementById("roll-table-count").textContent = `(${list.length} trades)`;
  const globalExpiry = rollGetTargetExpiry();
  const allVisibleRoll = list.length > 0 && list.every(p => rollSelected.has(p.id));
  const allVisibleIncl = list.length > 0 && list.every(p => rollIncluded.has(p.id));
  document.getElementById("roll-check-all").checked = allVisibleRoll;

  // Update sort indicators (primary = arrow, secondary = dot)
  const primarySort = rollSortStack[0] || null;
  const secondarySort = rollSortStack[1] || null;
  document.querySelectorAll("#roll-trades-table .sortable").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc", "sort-secondary");
    if (primarySort && th.dataset.col === primarySort.col) {
      th.classList.add(primarySort.asc ? "sort-asc" : "sort-desc");
    } else if (secondarySort && th.dataset.col === secondarySort.col) {
      th.classList.add("sort-secondary");
    }
  });
  document.getElementById("roll-include-all").checked = allVisibleIncl;

  const _sd = currentAsset === "FIL" ? 2 : 0;
  const fmtNum = (v, d=0) => v != null ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : "---";
  const spot = pfData.eth_spot;
  const $tbody = document.getElementById("roll-trades-body");
  $tbody.innerHTML = "";

  for (const pos of list) {
    const included = rollIncluded.has(pos.id);
    const checked = rollSelected.has(pos.id);
    const typeColor = pos.opt === "C" ? "var(--green)" : "var(--red)";
    const sideClass = pos.side === "Long" ? "qty-long" : "qty-short";
    const rowClass = (checked ? "roll-row-selected" : "") + (!included ? " pf-row-excluded" : "");
    const absQty = Math.abs(pos.net_qty);

    // Compute roll inline (same qty by default)
    const newDte = rollDteForExpiry(globalExpiry);
    const T = Math.max(newDte, 0) / 365.25;
    const rollIvPct = pfLookupIv(newDte, pos.strike) ?? pos.iv_pct;
    const sigma = rollIvPct / 100;
    const newMark = bsPrice(spot, pos.strike, T, 0, sigma, pos.opt);
    const curMark = pos.mark_price_usd ?? 0;
    const closeVal = pos.net_qty * curMark;
    const openVal = pos.net_qty * newMark;
    const cost = closeVal - openVal;
    const costRounded = Math.round(cost);
    const costCls = costRounded >= 0 ? "mtm-pos" : "mtm-neg";
    const costLabel = costRounded >= 0 ? "Rcv" : "Pay";

    const expiryOpts = rollGetExpiryOptions(globalExpiry);

    const tr = document.createElement("tr");
    tr.className = rowClass;
    tr.dataset.posId = pos.id;
    tr.innerHTML =
      `<td class="roll-include-cell"><input type="checkbox" class="roll-include" data-id="${pos.id}" ${included ? "checked" : ""}></td>` +
      `<td><input type="checkbox" class="roll-check" data-id="${pos.id}" ${checked ? "checked" : ""}></td>` +
      `<td style="text-align:left;font-size:.72rem">${pos.counterparty || ""}</td>` +
      `<td style="text-align:left;font-size:.72rem">${pos.instrument}</td>` +
      `<td style="text-align:left" class="${sideClass}">${pos.side_raw}</td>` +
      `<td style="text-align:left;color:${typeColor}">${pos.opt === "C" ? "Call" : "Put"}</td>` +
      `<td style="font-family:monospace">${fmtNum(pos.strike, _sd)}</td>` +
      `<td>${pos.expiry}</td>` +
      `<td>${Math.round(pos.days_remaining)}</td>` +
      `<td style="font-family:monospace">${fmtNum(pos.net_qty)}</td>` +
      `<td style="font-family:monospace">$${fmtNum(curMark, 2)}</td>` +
      `<td>${pos.iv_pct != null ? pos.iv_pct.toFixed(1) + "%" : "---"}</td>` +
      `<td class="${pos.current_mtm >= 0 ? 'mtm-pos' : 'mtm-neg'}" style="font-family:monospace">` +
        `$${fmtNum(pos.current_mtm)}</td>` +
      `<td><select class="roll-expiry-select" data-id="${pos.id}" style="font-size:.72rem;width:100%;margin:0">${expiryOpts}</select></td>` +
      `<td><input type="number" class="roll-strike-input" data-id="${pos.id}" ` +
        `value="${pos.strike}" step="any" style="width:100%;font-size:.75rem;padding:.2rem .3rem;text-align:center"></td>` +
      `<td><input type="number" class="roll-qty-input" data-id="${pos.id}" ` +
        `value="${absQty}" step="1" min="0" style="width:100%;font-size:.75rem;padding:.2rem .3rem;text-align:center"></td>` +
      `<td><select class="roll-type-select" data-id="${pos.id}" style="font-size:.72rem;width:100%;margin:0">` +
        `<option value="C" ${pos.opt === "C" ? "selected" : ""}>Call</option>` +
        `<option value="P" ${pos.opt === "P" ? "selected" : ""}>Put</option></select></td>` +
      `<td style="font-family:monospace" class="roll-new-mark">$${fmtNum(newMark, 2)}</td>` +
      `<td class="roll-iv-used">${rollIvPct.toFixed(1)}%</td>` +
      `<td class="${costCls} roll-cost" style="font-family:monospace;font-weight:600">${costLabel} $${Math.abs(costRounded).toLocaleString()}</td>`;
    $tbody.appendChild(tr);
  }

  // Wire include checkbox events
  $tbody.querySelectorAll(".roll-include").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) rollIncluded.add(id); else rollIncluded.delete(id);
      const tr = cb.closest("tr");
      tr.classList.toggle("pf-row-excluded", !cb.checked);
      const visible = rollGetFilteredPositions();
      document.getElementById("roll-include-all").checked =
        visible.length > 0 && visible.every(p => rollIncluded.has(p.id));
      rollRefreshVisuals();
    });
  });

  // Wire roll checkbox events
  $tbody.querySelectorAll(".roll-check").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) rollSelected.add(id); else rollSelected.delete(id);
      cb.closest("tr").classList.toggle("roll-row-selected", cb.checked);
      const visible = rollGetFilteredPositions();
      document.getElementById("roll-check-all").checked =
        visible.length > 0 && visible.every(p => rollSelected.has(p.id));
    });
  });

  // Wire per-row expiry/strike/qty changes to update inline roll values
  $tbody.querySelectorAll(".roll-expiry-select, .roll-strike-input, .roll-qty-input, .roll-type-select").forEach(el => {
    el.addEventListener("change", () => rollInlineUpdate(el.closest("tr")));
  });
}

// Refresh chart + matrix based on current include/roll state (no full recompute)
function rollRefreshVisuals() {
  rollDrawChart(rollLastResults);
  rollRenderMtmGrid(rollLastResults);
}

function rollCompute() {
  if (!pfData) return;
  const selectedPositions = pfData.positions.filter(p => rollSelected.has(p.id));
  if (selectedPositions.length === 0) { alert("Select at least one leg to roll."); return; }

  const globalExpiry = rollGetTargetExpiry();
  const spot = pfData.eth_spot;
  const results = [];
  let totalCloseValue = 0, totalOpenValue = 0, totalRollCost = 0;

  for (const pos of selectedPositions) {
    const row = document.querySelector(`#roll-trades-body tr[data-pos-id="${pos.id}"]`);
    const newExpCode = row ? row.querySelector(".roll-expiry-select").value : globalExpiry;
    const newStrike = row ? (parseFloat(row.querySelector(".roll-strike-input").value) || pos.strike) : pos.strike;
    const newAbsQty = row ? parseFloat(row.querySelector(".roll-qty-input").value) : Math.abs(pos.net_qty);
    const newType = row ? row.querySelector(".roll-type-select").value : pos.opt;
    const sign = pos.net_qty >= 0 ? 1 : -1;
    const newNetQty = isNaN(newAbsQty) ? pos.net_qty : sign * newAbsQty;
    const newDte = rollDteForExpiry(newExpCode);
    const T = Math.max(newDte, 0) / 365.25;
    const rollIvPct = pfLookupIv(newDte, newStrike) ?? pos.iv_pct;
    const sigma = rollIvPct / 100;
    const newMark = bsPrice(spot, newStrike, T, 0, sigma, newType);
    const curMark = pos.mark_price_usd ?? 0;

    // Close current position fully, open new at (possibly different) qty
    const closeValue = pos.net_qty * curMark;
    const openValue = newNetQty * newMark;
    const cost = closeValue - openValue;

    // Breakdown: DTE impact vs strike impact vs type impact (at original qty for comparison)
    const strikeChanged = newStrike !== pos.strike;
    const qtyChanged = newAbsQty !== Math.abs(pos.net_qty);
    const typeChanged = newType !== pos.opt;
    let dteImpact = cost, strikeImpact = 0, qtyImpact = 0, typeImpact = 0;
    if (strikeChanged || qtyChanged || typeChanged) {
      // DTE-only: same strike, same qty, same type, new DTE
      const dteIv = pfLookupIv(newDte, pos.strike) ?? pos.iv_pct;
      const dteOnlyMark = bsPrice(spot, pos.strike, T, 0, dteIv / 100, pos.opt);
      const dteOnlyCost = pos.net_qty * curMark - pos.net_qty * dteOnlyMark;
      dteImpact = dteOnlyCost;

      // Strike change: same qty, same type, new strike vs old strike at new DTE
      const strikeOnlyMark = bsPrice(spot, newStrike, T, 0, sigma, pos.opt);
      const strikeOnlyCost = pos.net_qty * dteOnlyMark - pos.net_qty * strikeOnlyMark;
      strikeImpact = strikeChanged ? strikeOnlyCost : 0;

      // Type change: same qty, new strike, new type vs old type at new DTE
      const typeOnlyCost = pos.net_qty * strikeOnlyMark - pos.net_qty * newMark;
      typeImpact = typeChanged ? typeOnlyCost : 0;

      // Qty change: remainder
      qtyImpact = cost - dteImpact - strikeImpact - typeImpact;
    }

    totalCloseValue += closeValue;
    totalOpenValue += openValue;
    totalRollCost += cost;
    results.push({ pos, newExpCode, newDte, newStrike, newNetQty, newType, curMark, newMark, rollIvPct,
      cost, closeValue, openValue, strikeChanged, qtyChanged, typeChanged,
      dteImpact, strikeImpact, qtyImpact, typeImpact });
  }
  rollRenderResults(results, totalCloseValue, totalOpenValue, totalRollCost, globalExpiry);
}

function rollRenderResults(results, totalCloseValue, totalOpenValue, totalRollCost, globalExpiry) {
  rollLastResults = results;
  document.getElementById("roll-results-section").style.display = "block";

  document.getElementById("roll-legs-count").textContent = results.length;
  const globalDte = rollDteForExpiry(globalExpiry);
  document.getElementById("roll-target-dte-display").textContent = `${globalExpiry} (${globalDte}d)`;

  const fmtUsd = v => "$" + Math.abs(Math.round(v)).toLocaleString();
  const fmtCost = v => { const r = Math.round(v); return `<span class="${r >= 0 ? "mtm-pos" : "mtm-neg"}" style="font-family:monospace;font-weight:600">${r >= 0 ? "Rcv" : "Pay"} $${Math.abs(r).toLocaleString()}</span>`; };

  const $close = document.getElementById("roll-total-close");
  $close.textContent = (totalCloseValue >= 0 ? "" : "-") + fmtUsd(totalCloseValue);
  $close.className = "risk-value " + (totalCloseValue >= 0 ? "mtm-pos" : "mtm-neg");

  const $open = document.getElementById("roll-total-open");
  $open.textContent = (totalOpenValue >= 0 ? "" : "-") + fmtUsd(totalOpenValue);
  $open.className = "risk-value " + (totalOpenValue >= 0 ? "mtm-pos" : "mtm-neg");

  const rounded = Math.round(totalRollCost);
  const $net = document.getElementById("roll-net-cost");
  $net.textContent = (rounded >= 0 ? "" : "-") + fmtUsd(totalRollCost);
  $net.className = "risk-value " + (rounded >= 0 ? "mtm-pos" : "mtm-neg");

  const $dir = document.getElementById("roll-direction");
  $dir.textContent = rounded >= 0 ? "Net Receive" : "Net Pay";
  $dir.className = "risk-value " + (rounded >= 0 ? "mtm-pos" : "mtm-neg");

  // Check if any strike, qty, or type changed — show breakdown columns
  const hasStrikeChange = results.some(r => r.strikeChanged);
  const hasQtyChange = results.some(r => r.qtyChanged);
  const hasTypeChange = results.some(r => r.typeChanged);
  const hasBreakdown = hasStrikeChange || hasQtyChange || hasTypeChange;

  // Dynamic header
  const $thead = document.getElementById("roll-results-thead");
  let hdr = `<tr>
    <th style="text-align:left">Instrument</th>
    <th style="text-align:left">Side</th>
    <th>Strike</th>
    <th>Type</th>
    <th>Qty</th>
    <th>Cur DTE</th>
    <th>New Expiry</th>
    <th>Cur Mark</th>
    <th>New Mark</th>
    <th>IV Used</th>`;
  if (hasBreakdown) {
    hdr += `<th title="Cost from DTE change only (same strike, same qty, same type)">DTE Impact</th>`;
    if (hasStrikeChange) hdr += `<th title="Additional cost from strike change">Strike Impact</th>`;
    if (hasTypeChange) hdr += `<th title="Additional cost from type change (C↔P)">Type Impact</th>`;
    if (hasQtyChange) hdr += `<th title="Additional cost from qty change">Qty Impact</th>`;
  }
  hdr += `<th>Total Cost</th></tr>`;
  $thead.innerHTML = hdr;

  const _sd = currentAsset === "FIL" ? 2 : 0;
  const fmtNum = (v, d=2) => v != null ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : "---";
  const $tbody = document.getElementById("roll-results-body");
  $tbody.innerHTML = "";

  let totalDteImpact = 0, totalStrikeImpact = 0, totalQtyImpact = 0, totalTypeImpact = 0;

  for (const r of results) {
    totalDteImpact += r.dteImpact;
    totalStrikeImpact += r.strikeImpact;
    totalQtyImpact += r.qtyImpact;
    totalTypeImpact += r.typeImpact || 0;
    const sideClass = r.pos.side === "Long" ? "qty-long" : "qty-short";
    const strikeLabel = r.strikeChanged
      ? `${fmtNum(r.pos.strike, _sd)} → ${fmtNum(r.newStrike, _sd)}`
      : fmtNum(r.pos.strike, _sd);
    const qtyLabel = r.qtyChanged
      ? `${fmtNum(r.pos.net_qty, 0)} → ${fmtNum(r.newNetQty, 0)}`
      : fmtNum(r.pos.net_qty, 0);
    const typeLabel = r.typeChanged
      ? `${r.pos.opt === "C" ? "Call" : "Put"} → ${r.newType === "C" ? "Call" : "Put"}`
      : (r.pos.opt === "C" ? "Call" : "Put");

    const typeColor = r.typeChanged ? "var(--accent)" : "inherit";
    let rowHtml =
      `<td style="text-align:left;font-size:.72rem">${r.pos.instrument}</td>` +
      `<td style="text-align:left" class="${sideClass}">${r.pos.side_raw}</td>` +
      `<td style="font-family:monospace">${strikeLabel}</td>` +
      `<td style="color:${typeColor}">${typeLabel}</td>` +
      `<td style="font-family:monospace">${qtyLabel}</td>` +
      `<td>${Math.round(r.pos.days_remaining)}d</td>` +
      `<td>${r.newExpCode} (${r.newDte}d)</td>` +
      `<td style="font-family:monospace">$${fmtNum(r.curMark)}</td>` +
      `<td style="font-family:monospace">$${fmtNum(r.newMark)}</td>` +
      `<td>${r.rollIvPct.toFixed(1)}%</td>`;
    if (hasBreakdown) {
      rowHtml += `<td>${fmtCost(r.dteImpact)}</td>`;
      if (hasStrikeChange) rowHtml += `<td>${r.strikeChanged ? fmtCost(r.strikeImpact) : '<span style="color:var(--muted)">—</span>'}</td>`;
      if (hasTypeChange) rowHtml += `<td>${r.typeChanged ? fmtCost(r.typeImpact) : '<span style="color:var(--muted)">—</span>'}</td>`;
      if (hasQtyChange) rowHtml += `<td>${r.qtyChanged ? fmtCost(r.qtyImpact) : '<span style="color:var(--muted)">—</span>'}</td>`;
    }
    rowHtml += `<td>${fmtCost(r.cost)}</td>`;

    const tr = document.createElement("tr");
    tr.innerHTML = rowHtml;
    $tbody.appendChild(tr);
  }

  // Footer
  const $tfoot = document.getElementById("roll-results-foot");
  let footHtml = `<tr><td style="text-align:left;font-weight:700" colspan="5">TOTAL</td>` +
    `<td></td><td></td><td></td><td></td><td></td>`;
  if (hasBreakdown) {
    footHtml += `<td>${fmtCost(totalDteImpact)}</td>`;
    if (hasStrikeChange) footHtml += `<td>${fmtCost(totalStrikeImpact)}</td>`;
    if (hasTypeChange) footHtml += `<td>${fmtCost(totalTypeImpact)}</td>`;
    if (hasQtyChange) footHtml += `<td>${fmtCost(totalQtyImpact)}</td>`;
  }
  footHtml += `<td>${fmtCost(totalRollCost)}</td></tr>`;
  $tfoot.innerHTML = footHtml;

  // ── Payoff chart + MTM matrix ───────────────────────────
  rollDrawChart(results);
  rollRenderMtmGrid(results);
}

// Compute MTM across a spot ladder for a set of positions,
// optionally replacing some with rolled versions.
// rollMap: Map of posId → { newDte, newStrike, rollIvPct }
function rollSumCurve(spotLadder, positions, horizon, rollMap) {
  const result = new Array(spotLadder.length).fill(0);
  for (const p of positions) {
    const rolled = rollMap.get(p.id);
    if (rolled) {
      const qty = rolled.newNetQty != null ? rolled.newNetQty : p.net_qty;
      const T = Math.max(rolled.newDte - horizon, 0) / 365.25;
      const sigma = rolled.rollIvPct / 100;
      const optType = rolled.newOpt || p.opt;
      for (let i = 0; i < spotLadder.length; i++) {
        result[i] += qty * bsPrice(spotLadder[i], rolled.newStrike, T, 0, sigma, optType);
      }
    } else {
      const curve = p.payoff_by_horizon[String(horizon)];
      if (curve) {
        for (let i = 0; i < spotLadder.length; i++) result[i] += curve[i];
      }
    }
  }
  return result;
}

function rollBaselineCurve(spotLadder, positions, horizon) {
  const result = new Array(spotLadder.length).fill(0);
  for (const p of positions) {
    const curve = p.payoff_by_horizon[String(horizon)];
    if (curve) for (let i = 0; i < spotLadder.length; i++) result[i] += curve[i];
  }
  return result;
}

function rollBuildRollMap(results) {
  const m = new Map();
  for (const r of results) {
    m.set(r.pos.id, {
      newDte: r.newDte,
      newStrike: r.newStrike || r.pos.strike,
      newOpt: r.newType || r.pos.opt,
      rollIvPct: r.rollIvPct,
      newNetQty: r.newNetQty,
    });
  }
  return m;
}

function rollDrawChart(results) {
  const $chart = document.getElementById("roll-payoff-chart");
  $chart.style.display = "block";

  const $controls = document.getElementById("roll-chart-controls");
  const showBaseline = document.getElementById("roll-show-baseline").checked;
  const showScenario = document.getElementById("roll-show-scenario").checked;

  const spots = pfData.spot_ladder;
  const horizons = pfData.chart_horizons;
  const spot = pfData.eth_spot;
  const hasRolls = results && results.length > 0;
  const rollMap = hasRolls ? rollBuildRollMap(results) : new Map();
  const allPositions = pfData.positions;
  const includedPositions = allPositions.filter(p => rollIncluded.has(p.id));
  const hasExclusion = rollIncluded.size !== allPositions.length;
  const hasScenarioChange = hasRolls || hasExclusion;

  // Show toggle controls only when there's a scenario to compare
  $controls.style.display = hasScenarioChange ? "block" : "none";

  const scenColors = ["#f85149", "#d29922", "#e3b341", "#3fb950", "#58a6ff", "#bc8cff"];
  const traces = [];

  // Baseline = full portfolio (all positions, no rolls)
  if (!hasScenarioChange || showBaseline) {
    horizons.forEach((h, i) => {
      const curve = rollBaselineCurve(spots, allPositions, h);
      const label = h === 0 ? "Baseline: Expiry" : `Baseline: T+${h}d`;
      const onlyBaseline = hasScenarioChange && !showScenario;
      traces.push({
        x: spots, y: curve, type: "scatter", mode: "lines",
        name: label,
        line: {
          color: (hasScenarioChange && !onlyBaseline) ? "#484f58" : scenColors[i % scenColors.length],
          width: (hasScenarioChange && !onlyBaseline) ? 1.5 : 2.5,
          dash: (hasScenarioChange && !onlyBaseline) ? "dot" : "solid",
        },
        legendgroup: "baseline",
      });
    });
  }

  // Scenario = included positions with rolls applied (solid colored)
  if (hasScenarioChange && showScenario) {
    horizons.forEach((h, i) => {
      const curve = rollSumCurve(spots, includedPositions, h, rollMap);
      const label = h === 0 ? "Scenario: Expiry" : `Scenario: T+${h}d`;
      traces.push({
        x: spots, y: curve, type: "scatter", mode: "lines",
        name: label,
        line: { color: scenColors[i % scenColors.length], width: 2.5 },
        legendgroup: "scenario",
      });
    });
  }

  // Spot marker
  const allY = traces.flatMap(t => t.y);
  if (allY.length > 0) {
    traces.push({
      x: [spot, spot], y: [Math.min(...allY), Math.max(...allY)],
      type: "scatter", mode: "lines",
      name: `Spot $${fmtSpot(spot)}`,
      line: { color: "#3fb950", width: 1.5, dash: "dashdot" },
      legendgroup: "spot",
    });
  }

  let titleText = "Portfolio Payoff Profile — All Positions";
  if (hasRolls && hasExclusion) titleText = "Portfolio Payoff — Baseline (dotted) vs Scenario (solid)";
  else if (hasRolls) titleText = "Portfolio Payoff — Baseline (dotted) vs Rolled (solid)";
  else if (hasExclusion) titleText = "Portfolio Payoff — Baseline (dotted) vs Selected (solid)";

  const cc = chartColors();
  const layout = {
    title: { text: titleText, font: { color: cc.text, size: 16 } },
    paper_bgcolor: cc.paper, plot_bgcolor: cc.plot,
    xaxis: { title: currentAsset + " Spot Price (USD) — log scale", type: "log", color: cc.muted, gridcolor: cc.grid, zerolinecolor: cc.zeroline },
    yaxis: { title: "Portfolio P&L (USD)", color: cc.muted, gridcolor: cc.grid, zerolinecolor: "#f85149", zerolinewidth: 2 },
    margin: { t: 50, r: 200, b: 50, l: 80 },
    showlegend: true,
    legend: {
      font: { color: cc.muted, size: 10 },
      orientation: "v", x: 1.02, y: 1, xanchor: "left", yanchor: "top",
      bgcolor: cc.legendBg, bordercolor: cc.legendBorder, borderwidth: 1,
    },
  };

  Plotly.react("roll-payoff-chart", traces, layout, { responsive: true });
}

function rollRenderMtmGrid(results) {
  const $section = document.getElementById("roll-mtm-section");
  $section.style.display = "block";

  const spots = pfData.spot_ladder;
  const horizons = pfData.matrix_horizons;
  const ethSpot = pfData.eth_spot;
  const allPositions = pfData.positions;
  const includedPositions = allPositions.filter(p => rollIncluded.has(p.id));
  const hasRolls = results && results.length > 0;
  const hasExclusion = rollIncluded.size !== allPositions.length;
  const hasScenarioChange = hasRolls || hasExclusion;
  const rollMap = hasRolls ? rollBuildRollMap(results) : new Map();

  const scenLabel = hasRolls && hasExclusion ? "Scenario" : hasRolls ? "Rolled" : "Selected";

  // Header
  const thead = document.getElementById("roll-mtm-grid-thead");
  if (hasScenarioChange) {
    let hdrHtml = `<tr><th rowspan="2" style="text-align:left">Spot</th>`;
    for (const h of horizons) hdrHtml += `<th colspan="2">${h}d</th>`;
    hdrHtml += `</tr><tr>`;
    for (const h of horizons) hdrHtml += `<th class="roll-mtm-base-hdr">Base</th><th class="roll-mtm-rolled-hdr">${scenLabel}</th>`;
    hdrHtml += `</tr>`;
    thead.innerHTML = hdrHtml;
  } else {
    thead.innerHTML = `<tr><th style="text-align:left">Spot</th>${horizons.map(h => `<th>${h}d</th>`).join("")}</tr>`;
  }

  // Pick spots at $500 increments, reversed
  const step = 500;
  const displaySpots = [];
  for (let s = step; s <= 7000; s += step) {
    const idx = spots.indexOf(s);
    if (idx !== -1) displaySpots.push({ spot: s, idx });
  }
  displaySpots.reverse();

  let closestSpot = displaySpots[0]?.spot ?? 0;
  let closestDiff = Infinity;
  for (const ds of displaySpots) {
    const diff = Math.abs(ds.spot - ethSpot);
    if (diff < closestDiff) { closestDiff = diff; closestSpot = ds.spot; }
  }

  // Pre-compute curves: baseline = full portfolio, scenario = included + rolls
  const baseCurves = {};
  const scenCurves = {};
  for (const h of horizons) {
    baseCurves[h] = rollBaselineCurve(spots, allPositions, h);
    if (hasScenarioChange) scenCurves[h] = rollSumCurve(spots, includedPositions, h, rollMap);
  }

  const fmtVal = v => {
    const r = Math.round(v);
    return r >= 0 ? `$${r.toLocaleString()}` : `-$${Math.abs(r).toLocaleString()}`;
  };

  const tbody = document.getElementById("roll-mtm-grid-body");
  let html = "";
  for (const { spot, idx } of displaySpots) {
    const isSpotRow = spot === closestSpot;
    html += `<tr class="${isSpotRow ? "roll-mtm-spot-row" : ""}">`;
    html += `<td style="text-align:left;font-weight:600;white-space:nowrap">$${spot.toLocaleString()}</td>`;
    for (const h of horizons) {
      const base = baseCurves[h][idx];
      const baseCls = base >= 0 ? "mtm-pos" : "mtm-neg";
      if (hasScenarioChange) {
        const scen = scenCurves[h][idx];
        const scenCls = scen >= 0 ? "mtm-pos" : "mtm-neg";
        html += `<td class="${baseCls} roll-mtm-base-cell">${fmtVal(base)}</td>`;
        html += `<td class="${scenCls} roll-mtm-rolled-cell">${fmtVal(scen)}</td>`;
      } else {
        html += `<td class="${baseCls}">${fmtVal(base)}</td>`;
      }
    }
    html += "</tr>";
  }
  tbody.innerHTML = html;
}

// ── Roll Analysis event wiring ──────────────────────────
document.getElementById("btn-roll-compute").addEventListener("click", rollCompute);

document.getElementById("btn-roll-select-all").addEventListener("click", () => {
  rollGetFilteredPositions().forEach(p => rollSelected.add(p.id));
  rollRenderTable();
});

document.getElementById("btn-roll-deselect-all").addEventListener("click", () => {
  rollSelected.clear();
  rollLastResults = null;
  rollRenderTable();
  document.getElementById("roll-results-section").style.display = "none";
  rollDrawChart(null);
  rollRenderMtmGrid(null);
});

document.getElementById("roll-check-all").addEventListener("change", (e) => {
  rollGetFilteredPositions().forEach(p => {
    if (e.target.checked) rollSelected.add(p.id); else rollSelected.delete(p.id);
  });
  rollRenderTable();
});

document.getElementById("roll-include-all").addEventListener("change", (e) => {
  rollGetFilteredPositions().forEach(p => {
    if (e.target.checked) rollIncluded.add(p.id); else rollIncluded.delete(p.id);
  });
  rollRenderTable();
  rollRefreshVisuals();
});

["roll-filter-expiry", "roll-filter-type", "roll-filter-side"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => { if (pfData) rollRenderTable(); });
});

document.getElementById("roll-target-expiry").addEventListener("change", () => {
  if (pfData) rollRenderTable();
});

document.querySelectorAll("#roll-trades-table .sortable").forEach(th => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    const primary = rollSortStack[0];
    if (primary && primary.col === col) {
      // Same column: toggle direction
      primary.asc = !primary.asc;
    } else {
      // New column: push old primary as secondary, new column becomes primary
      const prev = rollSortStack[0] || null;
      rollSortStack = [{ col, asc: true }];
      if (prev) rollSortStack.push(prev);
    }
    rollRenderTable();
  });
});

document.getElementById("btn-roll-expiring-10d").addEventListener("click", () => {
  if (!pfData) return;
  // Select for rolling only positions expiring within 10 days
  rollSelected.clear();
  pfData.positions.forEach(p => {
    if (p.days_remaining <= 10) rollSelected.add(p.id);
  });
  // Sort by DTE ascending so soonest show first
  rollSortStack = [{ col: "days_remaining", asc: true }];
  rollRenderTable();
});

document.getElementById("btn-roll-refresh").addEventListener("click", () => {
  rollLoaded = false;
  rollLastResults = null;
  rollSelected.clear();
  document.getElementById("roll-results-section").style.display = "none";
  // Re-fetch data from backend
  pfData = null;
  portfolioLoaded = false;
  rollInit();
});

["roll-show-baseline", "roll-show-scenario"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => {
    rollDrawChart(rollLastResults);
  });
});

// ── Roll Add Trade ───────────────────────────────────────
document.getElementById("btn-roll-add-trade").addEventListener("click", () => {
  const $form = document.getElementById("roll-add-trade-form");
  $form.style.display = $form.style.display === "none" ? "block" : "none";
  if ($form.style.display === "block") {
    // Populate counterparty dropdown from existing positions
    if (pfData) {
      const $cp = document.getElementById("roll-add-counterparty");
      const existing = new Set();
      pfData.positions.forEach(p => { if (p.counterparty) existing.add(p.counterparty); });
      existing.add("What-If");
      const prev = $cp.value;
      $cp.innerHTML = [...existing].sort().map(c =>
        `<option value="${c}" ${c === prev ? "selected" : ""}>${c}</option>`
      ).join("");
    }
    document.getElementById("roll-add-instrument").focus();
  }
});

document.getElementById("btn-roll-add-cancel").addEventListener("click", () => {
  document.getElementById("roll-add-trade-form").style.display = "none";
});

document.getElementById("btn-roll-add-confirm").addEventListener("click", () => {
  const instrument = document.getElementById("roll-add-instrument").value.trim().toUpperCase();
  if (!instrument) { alert("Enter an instrument name."); return; }
  const counterparty = document.getElementById("roll-add-counterparty").value;
  const side = document.getElementById("roll-add-side").value;
  const qty = parseFloat(document.getElementById("roll-add-qty").value) || 0;
  const premUsd = parseFloat(document.getElementById("roll-add-premium").value) || 0;
  if (qty <= 0) { alert("Quantity must be positive."); return; }
  if (!pfData) { alert("Portfolio data not loaded yet."); return; }

  get(`/api/portfolio/ticker/${encodeURIComponent(instrument)}`)
    .then(tk => {
      const sign = side === "sell" ? -1 : 1;
      const signedQty = sign * qty;
      const markUsd = tk.mark_price_usd || 0;
      const sigma = (tk.mark_iv || 80) / 100;
      const opt = tk.opt || "C";
      const strike = tk.strike || 0;
      const dte = tk.days_remaining || 0;
      const spots = pfData.spot_ladder;
      const allHorizons = pfData.all_horizons;
      const payoff = {};
      for (const h of allHorizons) {
        const T = Math.max(dte - h, 0) / 365.25;
        const vals = bsVec(spots, strike, T, 0, sigma, opt);
        payoff[String(h)] = vals.map(v => Math.round(signedQty * v * 100) / 100);
      }
      const mtmHorizon = pfData.matrix_horizons.map(h => {
        const T = Math.max(dte - h, 0) / 365.25;
        const val = bsPrice(pfData.eth_spot, strike, T, 0, sigma, opt);
        return Math.round(signedQty * val * 100) / 100;
      });

      const newPos = {
        id: pfNextId++,
        counterparty: counterparty,
        trade_id: null,
        trade_date: new Date().toISOString().split("T")[0],
        side_raw: side === "sell" ? "Sell" : "Buy",
        option_type: opt === "C" ? "Call" : "Put",
        instrument: instrument,
        expiry: tk.expiry || "",
        days_remaining: dte,
        strike: strike,
        pct_otm_entry: 0,
        qty: qty,
        notional_mm: 0,
        premium_per: premUsd / qty,
        premium_usd: premUsd,
        opt: opt,
        side: sign > 0 ? "Long" : "Short",
        net_qty: signedQty,
        pct_otm_live: pfData.eth_spot > 0 ? Math.round((strike / pfData.eth_spot - 1) * 1000) / 10 : 0,
        iv_pct: tk.mark_iv || 80,
        delta: tk.delta,
        gamma: tk.gamma,
        theta: tk.theta,
        vega: tk.vega,
        mark_price_usd: markUsd,
        current_mtm: Math.round(signedQty * markUsd * 100) / 100,
        notional_live: Math.round(qty * pfData.eth_spot * 100) / 100,
        mtm_by_horizon: mtmHorizon,
        payoff_by_horizon: payoff,
      };

      pfData.positions.push(newPos);
      pfSelected.add(newPos.id);
      rollIncluded.add(newPos.id);
      rollRenderTable();
      rollRefreshVisuals();

      document.getElementById("roll-add-trade-form").style.display = "none";
      document.getElementById("roll-add-instrument").value = "";
    })
    .catch(e => {
      console.error("Failed to fetch ticker:", e);
      alert("Failed to fetch instrument data from Deribit.\n" + e.message);
    });
});

// ── Roll Export to Excel ────────────────────────────────
document.getElementById("btn-roll-export-xlsx").addEventListener("click", () => {
  if (!pfData) return;
  const positions = pfData.positions.filter(p => rollIncluded.has(p.id));
  if (positions.length === 0) { alert("No positions included for export."); return; }

  const spot = pfData.eth_spot;
  const globalExpiry = rollGetTargetExpiry();
  const rows = [];

  for (const pos of positions) {
    const isRolled = rollSelected.has(pos.id);
    const row = document.querySelector(`#roll-trades-body tr[data-pos-id="${pos.id}"]`);

    let newExpCode = null, newStrike = null, newAbsQty = null, newNetQty = null;
    let newMark = null, rollIvPct = null, rollCost = null, newType = null;
    let closeValue = null, openValue = null;

    if (isRolled && row) {
      newExpCode = row.querySelector(".roll-expiry-select").value;
      newStrike = parseFloat(row.querySelector(".roll-strike-input").value) || pos.strike;
      newAbsQty = parseFloat(row.querySelector(".roll-qty-input").value);
      newType = row.querySelector(".roll-type-select").value;
      const sign = pos.net_qty >= 0 ? 1 : -1;
      newNetQty = isNaN(newAbsQty) ? pos.net_qty : sign * newAbsQty;
      const newDte = rollDteForExpiry(newExpCode);
      const T = Math.max(newDte, 0) / 365.25;
      rollIvPct = pfLookupIv(newDte, newStrike) ?? pos.iv_pct;
      const sigma = rollIvPct / 100;
      newMark = bsPrice(spot, newStrike, T, 0, sigma, newType);
      const curMark = pos.mark_price_usd ?? 0;
      closeValue = pos.net_qty * curMark;
      openValue = newNetQty * newMark;
      rollCost = Math.round(closeValue - openValue);
    }

    rows.push({
      "Include": rollIncluded.has(pos.id) ? "Yes" : "",
      "Roll": isRolled ? "Yes" : "",
      "Instrument": pos.instrument,
      "Buy/Sell": pos.side_raw,
      "Type": pos.option_type,
      "Strike": pos.strike,
      "Expiry": pos.expiry,
      "DTE": Math.round(pos.days_remaining),
      "Net Qty": pos.net_qty,
      "Cur Mark": pos.mark_price_usd != null ? Math.round(pos.mark_price_usd * 100) / 100 : null,
      "IV%": pos.iv_pct,
      "MTM": pos.current_mtm != null ? Math.round(pos.current_mtm) : null,
      "New Expiry": newExpCode,
      "New Strike": newStrike,
      "New Qty": newNetQty,
      "New Type": newType ? (newType === "C" ? "Call" : "Put") : null,
      "New Mark": newMark != null ? Math.round(newMark * 100) / 100 : null,
      "IV Used": rollIvPct != null ? Math.round(rollIvPct * 10) / 10 : null,
      "Close Value": closeValue != null ? Math.round(closeValue) : null,
      "Open Value": openValue != null ? Math.round(openValue) : null,
      "Roll Cost": rollCost,
      "Direction": rollCost != null ? (rollCost >= 0 ? "Receive" : "Pay") : "",
    });
  }

  // Totals row
  const totalMtm = positions.reduce((s, p) => s + (p.current_mtm || 0), 0);
  const rolledRows = rows.filter(r => r["Roll"] === "Yes");
  const totalRollCost = rolledRows.reduce((s, r) => s + (r["Roll Cost"] || 0), 0);
  const totalClose = rolledRows.reduce((s, r) => s + (r["Close Value"] || 0), 0);
  const totalOpen = rolledRows.reduce((s, r) => s + (r["Open Value"] || 0), 0);
  rows.push({});
  rows.push({
    "Instrument": "TOTALS",
    "Net Qty": positions.reduce((s, p) => s + p.net_qty, 0),
    "MTM": Math.round(totalMtm),
    "Close Value": Math.round(totalClose),
    "Open Value": Math.round(totalOpen),
    "Roll Cost": totalRollCost,
    "Direction": totalRollCost ? (totalRollCost >= 0 ? "Net Receive" : "Net Pay") : "",
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [
    { wch: 8 }, { wch: 5 }, { wch: 24 }, { wch: 8 }, { wch: 6 },
    { wch: 8 }, { wch: 12 }, { wch: 6 }, { wch: 10 }, { wch: 12 },
    { wch: 7 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 },
    { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, "Roll Analysis");
  const dateStr = new Date().toISOString().split("T")[0];
  XLSX.writeFile(wb, `PLGO_Roll_Analysis_${dateStr}.xlsx`);
});

// ═══════════════════════════════════════════════════════════
// ═══  OPTIMIZER TAB (v3 — Ask + Workbench + Add)  ═════════
// ═══════════════════════════════════════════════════════════

let opt2Loaded = false;
let opt2Data = null;
let opt2HighlightIdx = -1;
let opt2Filtered = [];
let opt2WbLegs = [];
let opt2WbName = "";
let opt2AddedTrades = [];
let opt2Baseline = null; // {spot_ladder, payoff, profile, spot} — frozen at first load
let opt2ChatHistory = [];  // {role: "user"|"bot", text: "..."}
let opt2ClosedTradeIds = [];  // trade IDs "closed" in the optimizer working portfolio (rolls)
let opt2RollMeta = new Map();  // Map<wbLegIndex, {originalTradeId, originalTrade, type: 'close'|'open'}>
let opt2ScenarioTrades = [];  // locally-tracked scenario trades (roll open legs, etc.) — NOT in real DB

async function opt2Init() {
  try {
    const expiries = await get(`/api/optimizer/expiries?asset=${currentAsset}`);
    const $sel = document.getElementById("opt2-expiry");
    $sel.innerHTML = '<option value="">All expiries</option>';
    for (const e of expiries) {
      const o = document.createElement("option");
      o.value = e.code;
      o.textContent = `${e.code} (${e.dte}d)`;
      $sel.appendChild(o);
    }
  } catch (e) { /* ok */ }
  opt2Loaded = true;
}

// ── Run suggestion engine ────────────────────────────────

function opt2AddMsg(type, html) {
  const $log = document.getElementById("opt2-chat-log");
  const div = document.createElement("div");
  div.className = `opt2-msg opt2-msg-${type}`;
  div.innerHTML = `<div class="opt2-msg-bubble">${html}</div>`;
  $log.appendChild(div);
  $log.scrollTop = $log.scrollHeight;
}

// Progress phases for the status bar
const OPT2_PHASES = [
  { at: 0,  pct: 5,   text: "Loading portfolio..." },
  { at: 1,  pct: 15,  text: "Fetching live prices from Deribit..." },
  { at: 3,  pct: 30,  text: "Computing payoff curves..." },
  { at: 5,  pct: 45,  text: "Analyzing structures & MTM..." },
  { at: 8,  pct: 55,  text: "Running AI analysis..." },
  { at: 12, pct: 65,  text: "AI is evaluating strategies..." },
  { at: 18, pct: 75,  text: "Pricing suggestions on Deribit..." },
  { at: 25, pct: 82,  text: "Building roll recommendations..." },
  { at: 35, pct: 88,  text: "Finalizing response..." },
  { at: 50, pct: 92,  text: "Still working — complex analysis..." },
  { at: 70, pct: 95,  text: "Almost done..." },
];

let _opt2StatusTimer = null;
let _opt2StatusStart = 0;

function opt2StartProgress() {
  const $status = document.getElementById("opt2-status");
  const $text = document.getElementById("opt2-status-text");
  const $elapsed = document.getElementById("opt2-status-elapsed");
  const $bar = document.getElementById("opt2-status-bar");
  $status.style.display = "block";
  $text.textContent = OPT2_PHASES[0].text;
  $bar.style.width = "5%";
  $elapsed.textContent = "0s";
  _opt2StatusStart = Date.now();

  // Add typing indicator in chat
  const $log = document.getElementById("opt2-chat-log");
  const typingDiv = document.createElement("div");
  typingDiv.id = "opt2-typing";
  typingDiv.className = "opt2-msg opt2-msg-bot";
  typingDiv.innerHTML = `<div class="opt2-msg-bubble" style="display:inline-flex;gap:4px;padding:8px 16px">` +
    `<span class="opt2-dot" style="width:6px;height:6px;border-radius:50%;background:var(--muted);animation:opt2bounce .6s ease-in-out infinite"></span>` +
    `<span class="opt2-dot" style="width:6px;height:6px;border-radius:50%;background:var(--muted);animation:opt2bounce .6s ease-in-out .15s infinite"></span>` +
    `<span class="opt2-dot" style="width:6px;height:6px;border-radius:50%;background:var(--muted);animation:opt2bounce .6s ease-in-out .3s infinite"></span>` +
    `</div>`;
  $log.appendChild(typingDiv);
  $log.scrollTop = $log.scrollHeight;

  // Add bounce animation if not yet present
  if (!document.getElementById("opt2-bounce-style")) {
    const style = document.createElement("style");
    style.id = "opt2-bounce-style";
    style.textContent = `@keyframes opt2bounce{0%,100%{opacity:.3;transform:translateY(0)}50%{opacity:1;transform:translateY(-4px)}}`;
    document.head.appendChild(style);
  }

  _opt2StatusTimer = setInterval(() => {
    const elapsed = (Date.now() - _opt2StatusStart) / 1000;
    $elapsed.textContent = `${Math.floor(elapsed)}s`;
    // Find current phase
    for (let i = OPT2_PHASES.length - 1; i >= 0; i--) {
      if (elapsed >= OPT2_PHASES[i].at) {
        $text.textContent = OPT2_PHASES[i].text;
        $bar.style.width = OPT2_PHASES[i].pct + "%";
        break;
      }
    }
  }, 500);
}

function opt2StopProgress() {
  const $status = document.getElementById("opt2-status");
  const $bar = document.getElementById("opt2-status-bar");
  $bar.style.width = "100%";
  if (_opt2StatusTimer) { clearInterval(_opt2StatusTimer); _opt2StatusTimer = null; }
  setTimeout(() => { $status.style.display = "none"; $bar.style.width = "0%"; }, 400);
  // Remove typing indicator
  const typing = document.getElementById("opt2-typing");
  if (typing) typing.remove();
}

async function opt2Run() {
  const $btn = document.getElementById("btn-opt2-run");
  const queryText = document.getElementById("opt2-ask").value.trim();
  if (!queryText) return;

  opt2AddMsg("user", queryText);
  opt2ChatHistory.push({ role: "user", text: queryText });
  document.getElementById("opt2-ask").value = "";

  $btn.disabled = true;
  $btn.textContent = "...";
  opt2StartProgress();

  try {
    // Include drawn target profile if available
    const drawnTarget = window._opt2DrawnTarget || null;
    window._opt2DrawnTarget = null;  // consume once

    const result = await post("/api/optimizer/chat", {
      message: queryText,
      history: opt2ChatHistory,
      workbench_legs: opt2WbLegs.map(l => ({
        instrument: l.instrument, side: l.side, qty: l.qty,
        strike: l.strike, opt: l.opt, expiry_code: l.expiry_code,
        price_usd: l.price_usd, bid_usd: l.bid_usd, ask_usd: l.ask_usd,
        spread_pct: l.spread_pct, mark_iv: l.mark_iv, dte: l.dte,
      })),
      added_trades: opt2AddedTrades.map(t => ({
        id: t.id, instrument: t.instrument, side: t.side,
        opt: t.opt, strike: t.strike, qty: t.qty, premium_usd: t.premium_usd,
      })),
      closed_trade_ids: opt2ClosedTradeIds,
      target_payoff: drawnTarget,
      asset: currentAsset,
    });

    opt2StopProgress();
    $btn.disabled = false;
    $btn.textContent = "Send";

    // Render bot response as markdown-ish
    const text = (result.text || "").replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    opt2AddMsg("bot", text);
    opt2ChatHistory.push({ role: "bot", text: result.text || "" });

    // Compact cost-decomposition card when run_roll_search ran this turn
    const decomp = result.data && result.data.search_decomposition;
    if (decomp) {
      const fmt = (v) => "$" + Math.round(v || 0).toLocaleString();
      const intrinsicShare = decomp.close_cost_usd
        ? Math.round(100 * (decomp.intrinsic_close_cost_usd || 0) / decomp.close_cost_usd)
        : 0;
      const sources = [...new Set(
        (decomp.close_cost_breakdown || []).map(l => l.pricing_source).filter(Boolean)
      )].join(", ") || "—";
      const html = `
        <div class="opt2-decomp">
          <div class="opt2-decomp-title">Roll search cost breakdown</div>
          <div class="opt2-decomp-grid">
            <div><span>Combinations tried</span><strong>${(decomp.tried_combinations || 0).toLocaleString()}</strong></div>
            <div><span>Close cost (fixed)</span><strong>${fmt(decomp.close_cost_usd)}</strong></div>
            <div><span>Intrinsic floor</span><strong>${fmt(decomp.intrinsic_close_cost_usd)} (${intrinsicShare}%)</strong></div>
            <div><span>Best net cost</span><strong>${fmt(decomp.best_net_cost_usd)}</strong></div>
            <div><span>Recoverable savings</span><strong>${fmt(decomp.recoverable_savings_usd)}</strong></div>
            <div><span>Pricing sources</span><strong>${sources}</strong></div>
          </div>
        </div>`;
      opt2AddMsg("bot", html);
    }

    // If we got suggestions, populate the data and show tables
    if (result.type === "suggestions" && result.data) {
      // Freeze baseline on first load — never overwrite
      if (!opt2Baseline) {
        opt2Baseline = {
          spot_ladder: [...result.data.spot_ladder],
          payoff: [...result.data.current_payoff],
          profile: { ...result.data.current_profile },
          spot: result.data.spot,
        };
      }
      opt2Data = result.data;
      opt2RenderPortfolio();
      opt2ApplyFilter();
      opt2DrawChart();
    }

  } catch (e) {
    opt2AddMsg("bot", `<span style="color:var(--red)">Error: ${e.message}</span>`);
    opt2StopProgress();
    $btn.disabled = false;
    $btn.textContent = "Send";
  }

  // Focus back on input
  setTimeout(() => document.getElementById("opt2-ask").focus(), 100);
}

// ── Scenario Trades table ─────────────────────────────────

let opt2PortSortCol = "dte";
let opt2PortSortAsc = true;

function opt2RenderPortfolio() {
  if (!opt2Data) return;
  const p = opt2Data.current_profile || {};
  if (!p.at_spot && p.at_spot !== 0) return;  // no profile data yet
  const pos = opt2Data.positions || [];
  const $s = (id, v) => { document.getElementById(id).textContent = v; };
  const fmtM = v => (v >= 0 ? "+" : "-") + "$" + Math.abs(Math.round(v)).toLocaleString();
  const cs = "text-align:center";

  $s("opt2-spot-val", `$${opt2Data.spot.toLocaleString(undefined, {maximumFractionDigits: 2})}`);

  const $pnl = document.getElementById("opt2-pnl-spot");
  $pnl.textContent = fmtM(p.at_spot);
  $pnl.className = `risk-value ${p.at_spot >= 0 ? "mtm-pos" : "mtm-neg"}`;

  const $worst = document.getElementById("opt2-worst");
  $worst.textContent = fmtM(p.min);
  $worst.className = `risk-value ${p.min >= 0 ? "mtm-pos" : "mtm-neg"}`;

  $s("opt2-worst-at", `$${Math.round(p.min_at).toLocaleString()}`);
  $s("opt2-breakeven", p.breakeven ? `$${Math.round(p.breakeven).toLocaleString()}` : "N/A");

  const $best = document.getElementById("opt2-best");
  $best.textContent = fmtM(p.max);
  $best.className = "risk-value mtm-pos";

  // Populate counterparty filter dropdown (include scenario trades)
  const allForCpty = [...pos, ...opt2ScenarioTrades];
  const cptys = [...new Set(allForCpty.map(r => r.counterparty || "").filter(Boolean))].sort();
  const $cptySel = document.getElementById("opt2-port-filter-cpty");
  const curCpty = $cptySel.value;
  $cptySel.innerHTML = '<option value="">All</option>';
  for (const c of cptys) {
    const o = document.createElement("option");
    o.value = c; o.textContent = c;
    if (c === curCpty) o.selected = true;
    $cptySel.appendChild(o);
  }

  // Merge DB positions + local scenario trades; mark closed ones
  const closedSet = new Set(opt2ClosedTradeIds);
  const showClosed = document.getElementById("opt2-port-show-closed").checked;
  const allPos = [];
  for (const r of pos) {
    const isClosed = closedSet.has(r.id);
    if (isClosed && !showClosed) continue;
    allPos.push({ ...r, _source: "portfolio", _closed: isClosed });
  }
  for (const st of opt2ScenarioTrades) {
    allPos.push({ ...st, _source: st._type || "scenario", _closed: false });
  }

  // Apply filters
  const filterCpty = document.getElementById("opt2-port-filter-cpty").value;
  const filterType = document.getElementById("opt2-port-filter-type").value;
  const filterSide = document.getElementById("opt2-port-filter-side").value;

  let filtered = allPos.map(r => {
    const exp = (r.expiry || "")?.split("T")[0] || r.expiry_code || "";
    const dte = r._source !== "portfolio" && r.dte ? r.dte : Math.max(0, Math.round((new Date(exp) - new Date()) / 86400000));
    return { ...r, _exp: exp, _dte: dte, _notional: (r.qty || 0) * opt2Data.spot, _prem: r.premium_usd || 0 };
  });

  if (filterCpty) filtered = filtered.filter(r => r.counterparty === filterCpty);
  if (filterType) filtered = filtered.filter(r => r.opt === filterType);
  if (filterSide === "long") filtered = filtered.filter(r => r.net_qty > 0);
  else if (filterSide === "short") filtered = filtered.filter(r => r.net_qty < 0);

  // Sort by clickable column header
  const col = opt2PortSortCol;
  const dir = opt2PortSortAsc ? 1 : -1;
  filtered.sort((a, b) => {
    let va, vb;
    if (col === "id") { va = a.id; vb = b.id; }
    else if (col === "counterparty") { va = (a.counterparty || "").toLowerCase(); vb = (b.counterparty || "").toLowerCase(); return va < vb ? -dir : va > vb ? dir : 0; }
    else if (col === "side") { va = a.side; vb = b.side; return va < vb ? -dir : va > vb ? dir : 0; }
    else if (col === "opt") { va = a.opt; vb = b.opt; return va < vb ? -dir : va > vb ? dir : 0; }
    else if (col === "strike") { va = a.strike; vb = b.strike; }
    else if (col === "expiry") { va = a._exp; vb = b._exp; return va < vb ? -dir : va > vb ? dir : 0; }
    else if (col === "dte") { va = a._dte; vb = b._dte; }
    else if (col === "qty") { va = a.qty; vb = b.qty; }
    else if (col === "net_qty") { va = a.net_qty; vb = b.net_qty; }
    else if (col === "premium") { va = a._prem; vb = b._prem; }
    else if (col === "notional") { va = a._notional; vb = b._notional; }
    else { va = a._dte; vb = b._dte; }
    return (va - vb) * dir;
  });

  // Update sort indicators on headers
  document.querySelectorAll("#opt2-port-table th.sortable").forEach(h => {
    h.classList.remove("sort-asc", "sort-desc");
    if (h.dataset.col === opt2PortSortCol) h.classList.add(opt2PortSortAsc ? "sort-asc" : "sort-desc");
  });

  const totalCount = pos.length + opt2ScenarioTrades.length;
  $s("opt2-port-count", `(${filtered.length} of ${totalCount} trades)`);

  const $tbody = document.getElementById("opt2-port-body");
  $tbody.innerHTML = "";
  let totalNetQty = 0, totalPrem = 0, totalNotional = 0;

  const fmtMoney = v => v != null && v !== "" && v !== 0 ? `$${Number(v).toLocaleString(undefined, {maximumFractionDigits: 0})}` : "--";

  for (const r of filtered) {
    const isClosed = !!r._closed;
    const isScenario = r._source === "roll" || r._source === "added" || r._source === "scenario";
    const sideClass = r.side.toLowerCase().includes("buy") || r.side.toLowerCase().includes("long") ? "qty-long" : "qty-short";
    if (!isClosed) {
      totalNetQty += r.net_qty;
      totalPrem += r._prem;
      totalNotional += r._notional;
    }

    // Closed trades: show reopen button instead of X
    const delBtn = isClosed
      ? `<button class="btn-secondary opt2-port-reopen" data-tid="${r.id}" style="width:20px;height:20px;padding:0;margin:0;font-size:.65rem;line-height:1;border-radius:3px;color:var(--green)" title="Reopen in scenario">+</button>`
      : `<button class="btn-secondary opt2-port-delete" data-tid="${r.id}" data-sid="${r._scenarioId || ''}" data-source="${r._source}" style="width:20px;height:20px;padding:0;margin:0;font-size:.65rem;line-height:1;border-radius:3px;color:var(--red)" title="${isScenario ? 'Remove from scenario' : 'Exclude from scenario'}">x</button>`;

    // Row styling
    const closedStyle = isClosed ? "opacity:0.4;text-decoration:line-through;" : "";
    const borderStyle = isClosed ? "border-left:3px solid var(--red);" : isScenario && r._source === "roll" ? "border-left:3px solid #d2a8ff;" : isScenario ? "border-left:3px solid #58a6ff;" : "";
    const rowStyle = closedStyle + borderStyle;
    const idLabel = isClosed ? `<span style="color:var(--red);font-weight:600">X</span>` : r._source === "roll" ? `<span style="color:#d2a8ff;font-weight:600">R</span>` : r._source === "added" ? `<span style="color:#58a6ff;font-weight:600">S</span>` : `#${r.id}`;

    $tbody.innerHTML += `<tr style="${rowStyle}">
      <td style="${cs}">${delBtn}</td>
      <td style="${cs};font-size:.68rem;color:var(--muted)">${idLabel}</td>
      <td style="${cs}">${r.counterparty || ""}</td>
      <td style="${cs}" class="${sideClass}">${r.side}</td>
      <td style="${cs}">${r.opt === "C" ? "Call" : "Put"}</td>
      <td style="${cs}">${r.strike.toLocaleString()}</td>
      <td style="${cs}">${r._exp}</td>
      <td style="${cs}">${r._dte}</td>
      <td style="${cs}">${r.qty.toLocaleString()}</td>
      <td style="${cs}" class="${r.net_qty >= 0 ? 'qty-long' : 'qty-short'}">${r.net_qty >= 0 ? "+" : ""}${r.net_qty.toLocaleString()}</td>
      <td style="${cs}">${fmtMoney(r._prem)}</td>
      <td style="${cs}">${fmtMoney(r._notional)}</td>
    </tr>`;
  }

  // Wire delete buttons (X = close/remove)
  $tbody.querySelectorAll(".opt2-port-delete").forEach(btn => {
    btn.addEventListener("click", () => {
      const tid = btn.dataset.tid;
      const sid = btn.dataset.sid;
      const source = btn.dataset.source;

      if (source === "roll" || source === "added" || source === "scenario") {
        opt2ScenarioTrades = opt2ScenarioTrades.filter(t => t._scenarioId !== sid);
      } else if (source === "portfolio") {
        const numTid = parseInt(tid);
        if (!opt2ClosedTradeIds.includes(numTid)) {
          opt2ClosedTradeIds.push(numTid);
        }
      }
      opt2RenderPortfolio();
      opt2DrawChart();
    });
  });

  // Wire reopen buttons (+ = bring back closed trade)
  $tbody.querySelectorAll(".opt2-port-reopen").forEach(btn => {
    btn.addEventListener("click", () => {
      const numTid = parseInt(btn.dataset.tid);
      opt2ClosedTradeIds = opt2ClosedTradeIds.filter(id => id !== numTid);
      opt2RenderPortfolio();
      opt2DrawChart();
    });
  });

  const $tfoot = document.getElementById("opt2-port-foot");
  $tfoot.innerHTML = `<tr style="font-weight:700">
    <td colspan="9" style="text-align:right">TOTAL</td>
    <td style="${cs}" class="${totalNetQty >= 0 ? 'qty-long' : 'qty-short'}">${totalNetQty >= 0 ? "+" : ""}${totalNetQty.toLocaleString()}</td>
    <td style="${cs}">${fmtMoney(totalPrem)}</td>
    <td style="${cs}">${fmtMoney(totalNotional)}</td>
  </tr>`;

  document.getElementById("opt2-portfolio-section").style.display = "block";
}

// ── Filter & sort ────────────────────────────────────────

function opt2ApplyFilter() {
  if (!opt2Data) return;
  let list = [...opt2Data.suggestions];
  const catF = document.getElementById("opt2-filter-cat").value;
  if (catF) list = list.filter(s => s.category === catF);
  const sort = document.getElementById("opt2-sort").value;
  if (sort === "cost_asc") list.sort((a, b) => Math.abs(a.net_cost_usd) - Math.abs(b.net_cost_usd));
  else if (sort === "downside") list.sort((a, b) => (b.impact?.downside || 0) - (a.impact?.downside || 0));
  else if (sort === "upside") list.sort((a, b) => (b.impact?.upside || 0) - (a.impact?.upside || 0));
  else if (sort === "floor") list.sort((a, b) => (b.impact?.min_improvement || 0) - (a.impact?.min_improvement || 0));
  opt2Filtered = list;

  const cats = [...new Set(opt2Data.suggestions.map(s => s.category))].sort();
  const $catSel = document.getElementById("opt2-filter-cat");
  const curCat = $catSel.value;
  $catSel.innerHTML = '<option value="">All</option>';
  for (const c of cats) {
    const o = document.createElement("option");
    o.value = c; o.textContent = c.replace(/_/g, " ");
    if (c === curCat) o.selected = true;
    $catSel.appendChild(o);
  }
  opt2RenderResults();
}

// ── Results table ────────────────────────────────────────

function opt2RenderResults() {
  const $section = document.getElementById("opt2-results-section");
  $section.style.display = "block";
  const desc = opt2Data.parsed_query?.description || "";
  document.getElementById("opt2-results-count").textContent =
    `(${opt2Filtered.length} of ${opt2Data.num_suggestions})` + (desc ? ` -- ${desc}` : "");

  const fmtImp = v => {
    const r = Math.round(v);
    if (r === 0) return '<span style="color:var(--muted)">--</span>';
    return `<span class="${r > 0 ? 'mtm-pos' : 'mtm-neg'}" style="font-family:monospace">${r > 0 ? "+" : ""}$${Math.abs(r).toLocaleString()}</span>`;
  };
  const catLabels = {
    bull_call_spread: "Bull Call", bear_put_spread: "Bear Put", risk_reversal: "Risk Rev",
    put_protection: "Put Protect", collar: "Collar", put_ratio: "Put Ratio", bear_reversal: "Bear Rev",
    roll: "Roll", custom: "Custom", target_match: "Target",
  };
  const catColors = {
    bull_call_spread: "#3fb950", bear_put_spread: "#f85149", risk_reversal: "#58a6ff",
    put_protection: "#d29922", collar: "#bc8cff", put_ratio: "#f0883e", bear_reversal: "#da3633",
    roll: "#d2a8ff", custom: "#8b949e", target_match: "#f0883e",
  };

  const $tbody = document.getElementById("opt2-results-body");
  $tbody.innerHTML = "";

  // Detect step-based plan: suggestions named "Step N: ..."
  const hasSteps = opt2Filtered.some(s => /^step\s+\d/i.test(s.name));
  let lastPhase = "";

  opt2Filtered.forEach((s, idx) => {
    // Insert phase header rows for step-based plans
    if (hasSteps) {
      const stepMatch = s.name.match(/^step\s+(\d+)/i);
      let phase = "";
      if (stepMatch) {
        // Detect phase from name: "Close" = harvest, "Open" = deploy
        const nameLower = s.name.toLowerCase();
        if (nameLower.includes("close") || nameLower.includes("harvest") || nameLower.includes("sell")) {
          phase = "PHASE 1: CLOSE & HARVEST";
        } else if (nameLower.includes("open") || nameLower.includes("buy") || nameLower.includes("downside") || nameLower.includes("upside") || nameLower.includes("protection")) {
          phase = "PHASE 2: OPEN NEW TRADES";
        } else {
          phase = "RESTRUCTURING PLAN";
        }
      } else {
        phase = "OTHER SUGGESTIONS";
      }
      if (phase !== lastPhase) {
        lastPhase = phase;
        const phaseColor = phase.includes("CLOSE") ? "#f0883e" : phase.includes("OPEN") ? "#3fb950" : "#d2a8ff";
        const headerTr = document.createElement("tr");
        headerTr.style.cssText = `background:rgba(${phaseColor === "#f0883e" ? "240,136,62" : phaseColor === "#3fb950" ? "63,185,80" : "210,168,255"},0.1);border-left:3px solid ${phaseColor}`;
        headerTr.innerHTML = `<td colspan="11" style="text-align:left;font-size:.72rem;font-weight:700;padding:6px 8px;color:${phaseColor};letter-spacing:.5px">${phase}</td>`;
        $tbody.appendChild(headerTr);
      }
    }

    const costR = Math.round(s.net_cost_usd);
    const isHl = idx === opt2HighlightIdx;
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    if (isHl) tr.classList.add("roll-row-selected");
    const catColor = catColors[s.category] || "var(--muted)";
    const costCls = Math.abs(costR) < 500 ? "" : costR > 0 ? "mtm-neg" : "mtm-pos";
    // For step-based plans, show step number instead of index
    const stepMatch = s.name.match(/^step\s+(\d+)/i);
    const displayNum = stepMatch ? stepMatch[1] : (idx + 1);
    const displayName = stepMatch ? s.name.replace(/^step\s+\d+:\s*/i, "") : s.name;
    tr.innerHTML =
      `<td><button class="btn-primary opt2-add-to-wb" data-idx="${idx}" style="width:22px;height:20px;padding:0;margin:0;font-size:.75rem;line-height:1;border-radius:3px" title="Add to workbench">+</button></td>` +
      `<td>${displayNum}</td>` +
      `<td style="text-align:left;font-size:.76rem">${stepMatch ? `<strong>Step ${stepMatch[1]}:</strong> ` : ""}${displayName}</td>` +
      `<td style="text-align:left"><span style="color:${catColor};font-weight:600;font-size:.72rem">${catLabels[s.category] || s.category}</span></td>` +
      `<td>${s.dte}d</td>` +
      `<td class="${costCls}">${costR >= 0 ? "" : "-"}$${Math.abs(costR).toLocaleString()}</td>` +
      `<td>${fmtImp(s.impact?.at_spot || 0)}</td>` +
      `<td>${fmtImp(s.impact?.downside || 0)}</td>` +
      `<td>${fmtImp(s.impact?.upside || 0)}</td>` +
      `<td>${fmtImp(s.impact?.min_improvement || 0)}</td>` +
      `<td style="font-weight:700">${Math.round(s.score).toLocaleString()}${s.target_match_pct != null ? `<br><span style="font-size:.65rem;color:#f0883e;font-weight:400">${s.target_match_pct.toFixed(0)}% match</span>` : ''}</td>`;
    $tbody.appendChild(tr);

    // Click row to preview on chart
    tr.addEventListener("click", (e) => {
      if (e.target.closest(".opt2-add-to-wb")) return;
      opt2HighlightIdx = idx;
      opt2RenderResults();
      opt2DrawChart();
    });
  });

  // Wire + buttons to ADD legs to workbench (accumulate, don't replace)
  $tbody.querySelectorAll(".opt2-add-to-wb").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const s = opt2Filtered[parseInt(btn.dataset.idx)];
      if (s) {
        if (s.is_roll) {
          opt2AddRollToWorkbench(s);
        } else {
          opt2AddToWorkbench(s);
        }
      }
    });
  });
}

// ── Workbench (editable legs) ────────────────────────────

function opt2OpenWorkbench(s) {
  opt2WbLegs = s.legs.map(l => {
    const leg = { ...l };
    if (l.role === "close") { leg._isRollClose = true; }
    else if (l.role === "open") { leg._isRollOpen = true; }
    return leg;
  });
  opt2WbName = s.name;
  document.getElementById("opt2-wb-name").textContent = s.name;
  opt2RenderWorkbench();
  opt2ShowWbImpact(s.net_cost_usd, s.impact || {}, s.new_payoff);
  document.getElementById("opt2-workbench-section").style.display = "block";
}

function opt2AddToWorkbench(s) {
  // Accumulate — add legs from this suggestion to existing workbench
  // Tag each leg with the strategy name so we can group them visually
  const stratName = s.name || "Strategy";
  for (const l of s.legs) {
    const leg = { ...l, _strategyName: stratName };
    if (l.role === "close") { leg._isRollClose = true; }
    else if (l.role === "open") { leg._isRollOpen = true; }
    opt2WbLegs.push(leg);
  }
  opt2WbName = opt2WbLegs.length <= s.legs.length ? s.name : "Combined (" + opt2WbLegs.length + " legs)";
  document.getElementById("opt2-wb-name").textContent = opt2WbName;
  opt2RenderWorkbench();
  document.getElementById("opt2-workbench-section").style.display = "block";
}

function opt2AddRollToWorkbench(s) {
  // Add roll suggestion: multi-leg structures (close_legs + open_legs arrays)
  const rollId = s.original_trade_id;
  const rollTrade = s.original_trade;

  // Add close legs
  const closeLegs = s.close_legs || (s.close_leg ? [s.close_leg] : []);
  for (const cl of closeLegs) {
    const idx = opt2WbLegs.length;
    opt2WbLegs.push({ ...cl, _isRollClose: true, _rollOriginalTradeId: rollId, _rollOriginalTrade: rollTrade });
    opt2RollMeta.set(idx, { originalTradeId: rollId, originalTrade: rollTrade, type: "close" });
  }

  // Add open legs
  const openLegs = s.open_legs || (s.open_leg ? [s.open_leg] : []);
  for (const ol of openLegs) {
    const idx = opt2WbLegs.length;
    opt2WbLegs.push({ ...ol, _isRollOpen: true, _rollOriginalTradeId: rollId, _rollOriginalTrade: rollTrade });
    opt2RollMeta.set(idx, { originalTradeId: rollId, originalTrade: rollTrade, type: "open" });
  }

  // Store the original trade IDs on the legs so we can close them when user confirms
  // Do NOT add to opt2ClosedTradeIds yet — only when "Add to Scenario" is clicked

  const totalLegs = closeLegs.length + openLegs.length;
  opt2WbName = opt2WbLegs.length <= totalLegs ? s.name : "Combined (" + opt2WbLegs.length + " legs)";
  document.getElementById("opt2-wb-name").textContent = opt2WbName;
  opt2RenderWorkbench();
  document.getElementById("opt2-workbench-section").style.display = "block";
}

function opt2RenderWorkbench() {
  const $tbody = document.getElementById("opt2-wb-body");
  $tbody.innerHTML = "";
  const fmtM = v => (v >= 0 ? "+" : "-") + "$" + Math.abs(Math.round(v)).toLocaleString();

  const renderedRollHeaders = new Set();  // track which original trade IDs have had their header rendered
  const renderedStratHeaders = new Set();  // track strategy name headers
  opt2WbLegs.forEach((leg, idx) => {
    // Strategy block header row (non-roll): show strategy name when legs are grouped
    if (!leg._isRollClose && !leg._isRollOpen && leg._strategyName && !renderedStratHeaders.has(leg._strategyName)) {
      renderedStratHeaders.add(leg._strategyName);
      const stratTr = document.createElement("tr");
      // Color-code by zone: orange for downside, green for upside, purple for combined/other
      let headerColor = "#d2a8ff";
      const nameLower = leg._strategyName.toLowerCase();
      if (nameLower.startsWith("downside")) headerColor = "#f0883e";
      else if (nameLower.startsWith("upside")) headerColor = "#3fb950";
      else if (nameLower.startsWith("cost reduction")) headerColor = "#58a6ff";
      stratTr.style.cssText = `background:rgba(${headerColor === "#f0883e" ? "240,136,62" : headerColor === "#3fb950" ? "63,185,80" : headerColor === "#58a6ff" ? "88,166,255" : "210,168,255"},0.08);border-left:3px solid ${headerColor}`;
      stratTr.innerHTML =
        `<td colspan="12" style="text-align:left;font-size:.74rem;padding:.4rem .6rem">` +
        `<strong style="color:${headerColor}">${leg._strategyName}</strong>` +
        `</td>`;
      $tbody.appendChild(stratTr);
    }
    // Roll header row: show original trade info before close/open pair
    if (leg._isRollClose && leg._rollOriginalTrade && !renderedRollHeaders.has(leg._rollOriginalTradeId)) {
      renderedRollHeaders.add(leg._rollOriginalTradeId);
      const orig = leg._rollOriginalTrade;
      const headerTr = document.createElement("tr");
      headerTr.style.cssText = "background:rgba(210,168,255,0.08);border-left:3px solid #d2a8ff";
      // Show structure-aware info
      const structDesc = orig.description || `${orig.side} ${orig.opt} @ ${orig.strike}`;
      const structType = orig.structure_type ? orig.structure_type.replace(/_/g, " ").toUpperCase() : "SINGLE";
      const numLegs = orig.num_legs || 1;
      const idsStr = orig.all_ids ? orig.all_ids.map(id => `#${id}`).join(", ") : `#${orig.id}`;
      // Build per-leg detail with IDs
      const legsDetail = orig.legs_detail || [];
      const legsStr = legsDetail.length > 0
        ? legsDetail.map(ld => {
            const s = ld.net_qty > 0 ? "L" : "S";
            return `<span style="color:${ld.net_qty > 0 ? 'var(--green)' : 'var(--red)'};font-weight:600">${s}</span> ${ld.opt} @${ld.strike.toLocaleString()} <span style="color:var(--muted)">#${ld.id}</span>`;
          }).join(" &nbsp;|&nbsp; ")
        : structDesc;
      headerTr.innerHTML =
        `<td colspan="12" style="text-align:left;font-size:.74rem;padding:.4rem .6rem">` +
        `<strong style="color:#d2a8ff">ROLL ${structType}</strong> ` +
        `<span style="color:var(--muted)">Cpty: ${orig.counterparty || "N/A"} | exp ${orig.expiry} (${orig.dte}d)</span><br>` +
        `<span style="margin-left:1rem">${legsStr}</span>` +
        `</td>`;
      $tbody.appendChild(headerTr);
    }

    const isPerp = leg.opt === "PERP";
    const sideColor = leg.side === "buy" ? "var(--green)" : "var(--red)";
    const typeColor = isPerp ? "var(--muted)" : (leg.opt === "C" ? "var(--green)" : "var(--red)");
    const execPr = isPerp ? 0 : (leg.side === "buy" ? leg.ask_usd : leg.bid_usd);
    const legCost = leg.side === "buy" ? execPr * leg.qty : -execPr * leg.qty;
    const isRollLeg = leg._isRollClose || leg._isRollOpen;
    // Show trade ID on close legs so user can reference the original
    const closeId = leg._isRollClose && leg._rollOriginalTrade?.legs_detail
      ? leg._rollOriginalTrade.legs_detail.find(ld => ld.opt === leg.opt && ld.strike === leg.strike)
      : null;
    const closeIdStr = closeId ? ` <span style="color:var(--muted);font-size:.62rem">#${closeId.id}</span>` : (leg._isRollClose && leg._rollOriginalTrade?.id ? ` <span style="color:var(--muted);font-size:.62rem">#${leg._rollOriginalTrade.id}</span>` : '');
    const rollLabel = leg._isRollClose ? `<span style="color:#f85149;font-size:.65rem;font-weight:600">CLOSE</span>${closeIdStr} ` :
                      leg._isRollOpen ? '<span style="color:#3fb950;font-size:.65rem;font-weight:600">OPEN</span> ' : '';
    const rollBorder = isRollLeg ? "border-left:3px solid #d2a8ff;" : "";
    const tr = document.createElement("tr");
    tr.style.cssText = rollBorder;
    tr.innerHTML =
      `<td><button class="btn-secondary opt2-wb-remove" data-idx="${idx}" style="width:22px;height:22px;padding:0;margin:0;font-size:.7rem;line-height:1;border-radius:3px" title="Remove leg">x</button></td>` +
      `<td style="text-align:left;font-size:.72rem">${rollLabel}${leg.instrument}</td>` +
      `<td style="color:${sideColor};font-weight:600;text-transform:uppercase">` +
        `<select class="opt2-wb-side" data-idx="${idx}" style="width:55px;font-size:.72rem;padding:1px 2px;background:var(--surface);color:inherit;border:1px solid var(--border)">` +
        `<option value="buy" ${leg.side==="buy"?"selected":""}>Buy</option>` +
        `<option value="sell" ${leg.side==="sell"?"selected":""}>Sell</option></select></td>` +
      (isPerp
        ? `<td style="color:${typeColor}">Perp</td>`
        : `<td style="color:${typeColor}"><select class="opt2-wb-opt" data-idx="${idx}" style="width:62px;font-size:.72rem;padding:1px 2px;background:var(--surface);color:inherit;border:1px solid var(--border)"><option value="C" ${leg.opt === "C" ? "selected" : ""}>Call</option><option value="P" ${leg.opt === "P" ? "selected" : ""}>Put</option></select></td>`) +
      `<td><input type="number" class="opt2-wb-strike" data-idx="${idx}" value="${leg.strike}" step="50" style="width:80px;font-size:.75rem;padding:2px 4px;font-family:monospace;background:var(--surface);color:inherit;border:1px solid var(--border)"></td>` +
      `<td><input type="number" class="opt2-wb-qty" data-idx="${idx}" value="${leg.qty}" step="100" min="1" style="width:80px;font-size:.75rem;padding:2px 4px;font-family:monospace;background:var(--surface);color:inherit;border:1px solid var(--border)"></td>` +
      `<td><select class="opt2-wb-expiry" data-idx="${idx}" style="width:95px;font-size:.7rem;padding:1px 2px;background:var(--surface);color:inherit;border:1px solid var(--border)">` +
        (opt2Data?.available_expiries || []).map(e => `<option value="${e}" ${e === leg.expiry_code ? "selected" : ""}>${e}</option>`).join("") +
      `</select></td>` +
      `<td style="font-family:monospace;font-size:.72rem">$${leg.bid_usd.toFixed(2)}</td>` +
      `<td style="font-family:monospace;font-size:.72rem">$${leg.ask_usd.toFixed(2)}</td>` +
      `<td>${leg.spread_pct.toFixed(1)}%</td>` +
      `<td>${leg.mark_iv ? leg.mark_iv.toFixed(1) + "%" : "--"}</td>` +
      `<td style="font-family:monospace;font-weight:600">${fmtM(legCost)}</td>`;
    $tbody.appendChild(tr);
  });

  // Wire events
  $tbody.querySelectorAll(".opt2-wb-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      const removeIdx = parseInt(btn.dataset.idx);
      const removedLeg = opt2WbLegs[removeIdx];

      // If removing a roll leg, also remove its pair and clean up closed trade IDs
      if (removedLeg._rollOriginalTradeId) {
        const rollId = removedLeg._rollOriginalTradeId;
        // Get all original trade IDs for this structure
        const allOrigIds = removedLeg._rollOriginalTrade?.all_ids || [rollId];
        // Remove all legs for this roll
        opt2WbLegs = opt2WbLegs.filter(l => l._rollOriginalTradeId !== rollId);
        // Remove all structure IDs from closed IDs
        opt2ClosedTradeIds = opt2ClosedTradeIds.filter(id => !allOrigIds.includes(id));
        // Clean up roll meta
        opt2RollMeta = new Map([...opt2RollMeta].filter(([k, v]) => v.originalTradeId !== rollId));
      } else {
        opt2WbLegs.splice(removeIdx, 1);
      }
      // Rebuild roll meta indices
      const newMeta = new Map();
      opt2WbLegs.forEach((l, i) => {
        if (l._rollOriginalTradeId) {
          newMeta.set(i, { originalTradeId: l._rollOriginalTradeId, originalTrade: l._rollOriginalTrade, type: l._isRollClose ? "close" : "open" });
        }
      });
      opt2RollMeta = newMeta;
      opt2RenderWorkbench();
    });
  });
  $tbody.querySelectorAll(".opt2-wb-qty").forEach(inp => {
    inp.addEventListener("change", () => { opt2WbLegs[parseInt(inp.dataset.idx)].qty = parseFloat(inp.value) || 0; });
  });
  $tbody.querySelectorAll(".opt2-wb-strike").forEach(inp => {
    inp.addEventListener("change", () => {
      const idx = parseInt(inp.dataset.idx);
      const l = opt2WbLegs[idx];
      l.strike = parseFloat(inp.value) || 0;
      if (l.opt === "PERP") return;  // perps don't rebuild instrument name
      // Rebuild instrument name to match new strike
      const strikeStr = l.strike % 1 === 0 ? String(Math.round(l.strike)) : String(l.strike);
      l.instrument = `${currentAsset || "ETH"}-${l.expiry_code}-${strikeStr}-${l.opt}`;
      // Update displayed instrument name in the row
      const row = inp.closest("tr");
      if (row) row.cells[1].textContent = l.instrument;
    });
  });
  $tbody.querySelectorAll(".opt2-wb-side").forEach(sel => {
    sel.addEventListener("change", () => { opt2WbLegs[parseInt(sel.dataset.idx)].side = sel.value; });
  });
  $tbody.querySelectorAll(".opt2-wb-opt").forEach(sel => {
    sel.addEventListener("change", () => {
      const idx = parseInt(sel.dataset.idx);
      const l = opt2WbLegs[idx];
      l.opt = sel.value;
      // Rebuild instrument name + repaint type-cell color to match new type
      const strikeStr = l.strike % 1 === 0 ? String(Math.round(l.strike)) : String(l.strike);
      const asset = currentAsset || "ETH";
      l.instrument = `${asset}-${l.expiry_code}-${strikeStr}-${l.opt}`;
      const row = sel.closest("tr");
      if (row) {
        row.cells[1].textContent = l.instrument;
        row.cells[3].style.color = l.opt === "C" ? "#3fb950" : "#f85149";
      }
    });
  });
  $tbody.querySelectorAll(".opt2-wb-expiry").forEach(sel => {
    sel.addEventListener("change", () => {
      const idx = parseInt(sel.dataset.idx);
      const newExp = sel.value;
      opt2WbLegs[idx].expiry_code = newExp;
      // Update instrument name to match new expiry
      const l = opt2WbLegs[idx];
      const strikeStr = l.strike % 1 === 0 ? String(Math.round(l.strike)) : String(l.strike);
      l.instrument = `${currentAsset || "ETH"}-${newExp}-${strikeStr}-${l.opt}`;
    });
  });

  // Update total
  let total = 0;
  for (const l of opt2WbLegs) {
    const eP = l.side === "buy" ? l.ask_usd : l.bid_usd;
    total += (l.side === "buy" ? 1 : -1) * eP * l.qty;
  }
  const $t = document.getElementById("opt2-wb-total");
  $t.innerHTML = `<span class="${Math.abs(Math.round(total)) < 500 ? '' : total > 0 ? 'mtm-neg' : 'mtm-pos'}" style="font-family:monospace">${total >= 0 ? "" : "-"}$${Math.abs(Math.round(total)).toLocaleString()}</span>`;
}

function opt2ShowWbImpact(cost, impact, newPayoff) {
  const imp = impact || {};
  const fmtM = v => (v >= 0 ? "+" : "-") + "$" + Math.abs(Math.round(v)).toLocaleString();
  const setV = (id, v, cls) => {
    const el = document.getElementById(id);
    el.textContent = typeof v === "string" ? v : fmtM(v);
    if (cls !== undefined) el.className = `risk-value ${cls}`;
  };

  const cr = Math.round(cost || 0);
  setV("opt2-wb-cost", cost || 0, Math.abs(cr) < 500 ? "" : cr > 0 ? "mtm-neg" : "mtm-pos");
  setV("opt2-wb-pnl-spot", imp.at_spot || 0, (imp.at_spot || 0) >= 0 ? "mtm-pos" : "mtm-neg");
  setV("opt2-wb-new-worst", imp.new_min || 0, (imp.new_min || 0) >= 0 ? "mtm-pos" : "mtm-neg");
  setV("opt2-wb-new-be", imp.new_breakeven ? `$${Math.round(imp.new_breakeven).toLocaleString()}` : "N/A", "");
  setV("opt2-wb-floor-imp", imp.min_improvement || 0, (imp.min_improvement || 0) >= 0 ? "mtm-pos" : "mtm-neg");
  const beImp = imp.breakeven_improvement || 0;
  setV("opt2-wb-be-imp", beImp || "--", beImp > 0 ? "mtm-pos" : beImp < 0 ? "mtm-neg" : "");

  // Store for chart
  if (newPayoff) opt2Data._wbPayoff = newPayoff;
}

// ── Calculate (re-price workbench with live data) ────────

async function opt2Calculate() {
  const legs = opt2WbLegs.map(l => ({
    instrument: l.instrument, side: l.side, qty: l.qty,
    strike: l.strike, opt: l.opt, expiry_code: l.expiry_code,
  }));

  const $btn = document.getElementById("btn-opt2-calc");
  $btn.disabled = true; $btn.textContent = "Calculating...";

  try {
    const result = await post("/api/optimizer/calculate", { legs, closed_trade_ids: opt2ClosedTradeIds, asset: currentAsset });
    // Update leg costs
    for (let i = 0; i < opt2WbLegs.length && i < result.leg_costs.length; i++) {
      const lc = result.leg_costs[i];
      opt2WbLegs[i].bid_usd = lc.bid_usd;
      opt2WbLegs[i].ask_usd = lc.ask_usd;
      opt2WbLegs[i].price_usd = lc.price_usd;
      opt2WbLegs[i].spread_pct = lc.spread_pct;
      if (lc.mark_iv) opt2WbLegs[i].mark_iv = lc.mark_iv;
    }
    opt2RenderWorkbench();
    opt2ShowWbImpact(result.total_cost, {
      at_spot: result.pnl_at_spot - (opt2Data.current_profile?.at_spot || 0),
      new_min: result.new_min,
      min_improvement: result.floor_change,
      new_breakeven: result.new_breakeven,
      breakeven_improvement: result.be_change,
    }, result.new_payoff);
    // Update chart
    opt2Data._wbPayoff = result.new_payoff;
    opt2Data._wbSpots = result.spot_ladder;
    opt2DrawChart();
  } catch (e) {
    alert("Calculate error: " + e.message);
  }
  $btn.disabled = false; $btn.textContent = "Calculate";
}

// ── Add to Scenario (never touches real DB) ──────────────

async function opt2AddToPortfolio() {
  if (opt2WbLegs.length === 0) { alert("No legs in workbench"); return; }

  const $btn = document.getElementById("btn-opt2-add-to-portfolio");
  $btn.disabled = true; $btn.textContent = "Adding...";

  let addedCount = 0;

  // Close original trades for rolls NOW (on confirm, not on workbench add)
  for (const leg of opt2WbLegs) {
    if (leg._isRollClose) {
      const allIds = leg._rollOriginalTrade?.all_ids || [leg._rollOriginalTradeId];
      for (const tid of allIds) {
        if (tid && !opt2ClosedTradeIds.includes(tid)) {
          opt2ClosedTradeIds.push(tid);
        }
      }
    }
  }

  for (const leg of opt2WbLegs) {
    // Skip close legs of rolls (they cancel out the original — handled via closed_trade_ids)
    if (leg._isRollClose) continue;

    const sideLabel = leg.side === "buy" ? "Long" : "Short";
    const isRollOpen = !!leg._isRollOpen;

    opt2ScenarioTrades.push({
      _scenarioId: `scen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      _type: isRollOpen ? "roll" : "added",
      _rollOriginalTradeId: leg._rollOriginalTradeId || null,
      _rollOriginalTrade: leg._rollOriginalTrade || null,
      id: isRollOpen ? "R" : "S",
      counterparty: isRollOpen ? (leg._rollOriginalTrade?.counterparty || "Roll") : "Scenario",
      side: sideLabel,
      opt: leg.opt,
      strike: leg.strike,
      qty: leg.qty,
      net_qty: (leg.side === "buy" ? 1 : -1) * leg.qty,
      expiry: leg.expiry_code || "",
      premium_usd: (leg.side === "buy" ? leg.ask_usd : leg.bid_usd) * leg.qty * (leg.side === "buy" ? -1 : 1),
      price_usd: leg.side === "buy" ? leg.ask_usd : leg.bid_usd,
      expiry_code: leg.expiry_code || "",
      dte: leg.dte || 0,
      instrument: leg.instrument || "",
    });
    addedCount++;
  }

  // Count roll structures
  const rollIds = new Set(opt2WbLegs.filter(l => l._isRollClose || l._isRollOpen).map(l => l._rollOriginalTradeId)).size;
  const newLegs = opt2WbLegs.filter(l => !l._isRollClose && !l._isRollOpen).length;

  let msg = "";
  if (rollIds > 0) msg += `${rollIds} structure(s) rolled`;
  if (newLegs > 0) msg += `${msg ? " + " : ""}${newLegs} trade(s) added`;
  opt2AddMsg("bot",
    `<strong style="color:#3fb950">Scenario updated</strong> — ${msg}. ` +
    `<span style="color:var(--muted)">Simulation only — real trades not affected.</span>`
  );

  $btn.disabled = false;
  $btn.textContent = "Add to Scenario";

  // Clear workbench but keep roll state (closed_trade_ids)
  const keepClosedIds = [...opt2ClosedTradeIds];
  opt2WbLegs = [];
  opt2RollMeta = new Map();
  opt2ClosedTradeIds = keepClosedIds;
  delete opt2Data?._wbPayoff;
  delete opt2Data?._wbSpots;
  document.getElementById("opt2-workbench-section").style.display = "none";

  opt2RenderPortfolio();
  opt2DrawChart();
}

function opt2RenderAdded() {
  const $section = document.getElementById("opt2-added-section");
  if (opt2AddedTrades.length === 0) { $section.style.display = "none"; return; }
  $section.style.display = "block";

  let totalCost = 0;
  for (const t of opt2AddedTrades) totalCost += (t.premium || 0);

  const costStr = (totalCost >= 0 ? "+" : "-") + "$" + Math.abs(Math.round(totalCost)).toLocaleString();
  const costCls = totalCost >= 0 ? "mtm-pos" : "mtm-neg";
  document.getElementById("opt2-added-count").textContent = `(${opt2AddedTrades.length} trades | Net: `;
  document.getElementById("opt2-added-count").innerHTML = `(${opt2AddedTrades.length} trades | Net cost: <span class="${costCls}" style="font-weight:700">${costStr}</span>)`;

  const $tbody = document.getElementById("opt2-added-body");
  $tbody.innerHTML = "";
  for (const t of opt2AddedTrades) {
    const sideColor = t.side === "Buy" ? "var(--green)" : "var(--red)";
    const premStr = t.premium ? ((t.premium >= 0 ? "+" : "-") + "$" + Math.abs(Math.round(t.premium)).toLocaleString()) : "--";
    const premCls = t.premium >= 0 ? "mtm-pos" : "mtm-neg";
    const priceStr = t.price_usd ? "$" + t.price_usd.toFixed(2) : "--";
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><button class="btn-secondary opt2-remove-added" data-tid="${t.id}" style="width:22px;height:22px;padding:0;margin:0;font-size:.7rem;line-height:1;border-radius:3px;color:var(--red)" title="Remove from portfolio">x</button></td>` +
      `<td style="text-align:left;font-size:.74rem">${t.instrument}</td>` +
      `<td style="text-align:left;color:${sideColor};font-weight:600">${t.side}</td>` +
      `<td style="text-align:left">${t.opt === "C" ? "Call" : t.opt === "P" ? "Put" : "Perp"}</td>` +
      `<td style="font-family:monospace">$${t.strike.toLocaleString()}</td>` +
      `<td style="font-family:monospace">${t.qty.toLocaleString()}</td>` +
      `<td style="font-family:monospace">${priceStr}</td>` +
      `<td style="font-family:monospace" class="${premCls}">${premStr}</td>` +
      `<td style="font-size:.68rem;color:var(--muted)">#${t.id}</td>`;
    $tbody.appendChild(tr);
  }

  $tbody.querySelectorAll(".opt2-remove-added").forEach(btn => {
    btn.addEventListener("click", async () => {
      const tid = parseInt(btn.dataset.tid);
      try {
        await api("DELETE", `/api/trades/${tid}`);
        opt2AddedTrades = opt2AddedTrades.filter(t => t.id !== tid);
        pfData = null; portfolioLoaded = false;
        opt2RenderAdded();
        await opt2RefreshChart();
      } catch (e) {
        alert("Failed to remove: " + e.message);
      }
    });
  });
}

document.getElementById("btn-opt2-remove-all-added").addEventListener("click", async () => {
  if (!confirm(`Remove all ${opt2AddedTrades.length} recently added trades?`)) return;
  for (const t of opt2AddedTrades) {
    try { await api("DELETE", `/api/trades/${t.id}`); } catch (e) { /* skip */ }
  }
  opt2AddedTrades = [];
  pfData = null; portfolioLoaded = false;
  opt2RenderAdded();
  await opt2RefreshChart();
});

// ── Refresh chart after portfolio changes ────────────────

async function opt2RefreshChart() {
  if (!opt2Data) return;
  try {
    const result = await post("/api/optimizer/chat", {
      message: "hello",
      history: [],
      workbench_legs: [],
      added_trades: [],
      closed_trade_ids: opt2ClosedTradeIds,
      asset: currentAsset,
    });
    if (result.data) {
      opt2Data.current_payoff = result.data.current_payoff;
      opt2Data.spot_ladder = result.data.spot_ladder;
      opt2Data.spot = result.data.spot;
      opt2Data.current_profile = result.data.current_profile;
      opt2Data.positions = result.data.positions;
      opt2RenderPortfolio();
    }
  } catch (e) { /* silent */ }
  opt2DrawChart();
}

// ── Refresh Chart button ─────────────────────────────────

document.getElementById("btn-opt2-refresh-chart").addEventListener("click", async () => {
  const $btn = document.getElementById("btn-opt2-refresh-chart");
  $btn.disabled = true; $btn.textContent = "Refreshing...";

  // Clear any drawn target
  opt2TargetPoints = [];
  const clearBtn = document.getElementById("btn-opt2-clear-target");
  if (clearBtn) clearBtn.style.display = "none";

  // Exit drawing mode if active
  if (opt2DrawMode) opt2ExitDrawMode();

  await opt2RefreshChart();

  // Recalculate workbench payoff if there are legs
  if (opt2WbLegs.length > 0) {
    try { await opt2RecalculateWorkbench(); } catch (e) { /* silent */ }
  }

  $btn.disabled = false; $btn.textContent = "\u21bb Refresh Chart";
});

// ── Collapsible cards (Scenario, Target Curves) ──────────
// Lightweight toggle: click the header to fold/unfold the body. Used to keep
// the optimizer screen tidy when those panels aren't actively in use.
function opt2WireCollapsible(toggleId, bodyId, iconId) {
  const $t = document.getElementById(toggleId);
  const $b = document.getElementById(bodyId);
  const $i = iconId ? document.getElementById(iconId) : null;
  if (!$t || !$b) return;
  $t.addEventListener("click", (ev) => {
    // Ignore clicks that originated inside an interactive child (e.g. a button
    // sitting in the same flex row as a clickable header).
    if (ev.target.closest("button, input, select, a")) return;
    const isCollapsed = $b.style.display === "none";
    $b.style.display = isCollapsed ? "" : "none";
    if ($i) $i.textContent = isCollapsed ? "[ - ]" : "[ + ]";
  });
}
opt2WireCollapsible("opt2-portfolio-toggle", "opt2-portfolio-body", "opt2-portfolio-toggle-icon");
opt2WireCollapsible("opt2-curves-toggle", "opt2-curves-list", "opt2-curves-toggle-icon");

// ── Chart ────────────────────────────────────────────────

function opt2DrawChart() {
  if (!opt2Data) return;
  const $wrapper = document.getElementById("opt2-chart-wrapper");
  if ($wrapper) $wrapper.style.display = "block";
  const $chart = document.getElementById("opt2-payoff-chart");
  // Reset any stale display:none on the inner chart div (Refresh / Reset All
  // hide it directly; without this the chart stays invisible even after a
  // fresh Plotly.react call).
  if ($chart) $chart.style.display = "";

  const spots = opt2Data.spot_ladder;
  const spot = opt2Data.spot;
  const traces = [];

  // 1. EXISTING PORTFOLIO — GREEN SOLID, never moves
  if (opt2Baseline) {
    traces.push({
      x: opt2Baseline.spot_ladder, y: opt2Baseline.payoff, type: "scatter", mode: "lines",
      name: "Existing Portfolio", line: { color: "#3fb950", width: 2.5 },
    });
  } else {
    // No baseline yet — show current as the green line
    traces.push({
      x: spots, y: opt2Data.current_payoff, type: "scatter", mode: "lines",
      name: "Existing Portfolio", line: { color: "#3fb950", width: 2.5 },
    });
  }

  // 2. SCENARIO — portfolio with added trades/rolls — DOTTED
  const hasScenarioChanges = opt2AddedTrades.length > 0 || opt2ScenarioTrades.length > 0 || opt2ClosedTradeIds.length > 0;
  if (hasScenarioChanges && opt2Baseline) {
    traces.push({
      x: spots, y: opt2Data.current_payoff, type: "scatter", mode: "lines",
      name: "Scenario (with adds/rolls)",
      line: { color: "#58a6ff", width: 2.5, dash: "dot" },
    });
  }

  // 3. WORKBENCH PREVIEW — trades being considered (not yet confirmed) — DOTTED different color
  if (opt2Data._wbPayoff) {
    const wbSpots = opt2Data._wbSpots || spots;
    traces.push({
      x: wbSpots, y: opt2Data._wbPayoff, type: "scatter", mode: "lines",
      name: "With Workbench Trades",
      line: { color: "#d2a8ff", width: 2.5, dash: "dot" },
    });
  }
  // Or preview from clicked suggestion
  else if (opt2HighlightIdx >= 0 && opt2Filtered[opt2HighlightIdx]) {
    const s = opt2Filtered[opt2HighlightIdx];
    traces.push({
      x: spots, y: s.new_payoff, type: "scatter", mode: "lines",
      name: `Preview: ${s.name}`,
      line: { color: "#d2a8ff", width: 2.5, dash: "dot" },
    });
  }

  // Add target profile trace if we have drawn points (smoothed + raw markers)
  const clearBtn = document.getElementById("btn-opt2-clear-target");
  if (opt2TargetPoints.length >= 1) {
    // Raw markers — show exactly where user clicked
    const sorted = [...opt2TargetPoints].sort((a, b) => a.x - b.x);
    traces.push({
      x: sorted.map(p => p.x), y: sorted.map(p => p.y), type: "scatter",
      mode: "markers", name: "Drawn Points",
      marker: { color: "#f0883e", size: 8, symbol: "circle", line: { color: "#fff", width: 1 } },
      showlegend: false,
    });
    // Smoothed curve — interpolated spline
    if (opt2TargetPoints.length >= 2) {
      const smooth = opt2SmoothCurve(opt2TargetPoints, 80);
      traces.push({
        x: smooth.xs, y: smooth.ys, type: "scatter", mode: "lines",
        name: "Target Profile (smoothed)",
        line: { color: "#f0883e", width: 2.5, dash: "dash" },
      });
    }
    if (clearBtn) clearBtn.style.display = "";
  } else {
    if (clearBtn) clearBtn.style.display = "none";
  }

  // Add saved/displayed curve traces (multi-overlay)
  const curveTraces = opt2GetDisplayedCurveTraces();
  traces.push(...curveTraces);

  const allY = traces.flatMap(t => t.y);
  const yMin = Math.min(...allY);
  const yMax = Math.max(...allY);
  traces.push({
    x: [spot, spot], y: [yMin, yMax], type: "scatter", mode: "lines",
    name: `Spot $${spot.toLocaleString(undefined, {maximumFractionDigits: 0})}`,
    line: { color: "#f0883e", width: 1.5, dash: "dashdot" },
  });

  const cc = chartColors();
  Plotly.react("opt2-payoff-chart", traces, {
    title: { text: `${currentAsset} Portfolio Payoff — Baseline vs Current vs Proposed`, font: { color: cc.text, size: 14 } },
    paper_bgcolor: cc.paper, plot_bgcolor: cc.plot,
    xaxis: { title: `${currentAsset} Spot (USD)`, type: "log", color: cc.muted, gridcolor: cc.grid, zerolinecolor: cc.zeroline },
    yaxis: { title: "Portfolio Payoff at Expiry (USD)", color: cc.muted, gridcolor: cc.grid, zerolinecolor: "#f85149", zerolinewidth: 2 },
    margin: { t: 50, r: 260, b: 50, l: 90 },
    showlegend: true,
    legend: { font: { color: cc.muted, size: 10 }, orientation: "v", x: 1.02, y: 1,
      xanchor: "left", yanchor: "top", bgcolor: cc.legendBg, bordercolor: cc.legendBorder, borderwidth: 1 },
  }, { responsive: true });

  // Render comparison matrix
  opt2RenderMatrix();
}

// ── Monotone Cubic Spline Interpolation (Fritsch-Carlson) ──

function opt2SmoothCurve(points, numOut = 80) {
  // Takes sparse drawn points, returns a smooth curve with numOut points
  if (points.length < 2) return { xs: points.map(p => p.x), ys: points.map(p => p.y) };
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const xs = sorted.map(p => p.x);
  const ys = sorted.map(p => p.y);
  const n = xs.length;

  if (n === 2) {
    // Linear interpolation for 2 points — extend to numOut
    const outX = [], outY = [];
    for (let i = 0; i < numOut; i++) {
      const t = i / (numOut - 1);
      outX.push(xs[0] + t * (xs[1] - xs[0]));
      outY.push(ys[0] + t * (ys[1] - ys[0]));
    }
    return { xs: outX, ys: outY };
  }

  // Compute slopes (Fritsch-Carlson monotone cubic)
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(xs[i + 1] - xs[i]);
    dy.push(ys[i + 1] - ys[i]);
    m.push(dy[i] / dx[i]);
  }

  // Tangents
  const tg = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      tg.push(0);
    } else {
      tg.push(3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]));
    }
  }
  tg.push(m[n - 2]);

  // Evaluate spline at numOut evenly-spaced x values
  const xMin = xs[0], xMax = xs[n - 1];
  const outX = [], outY = [];
  for (let i = 0; i < numOut; i++) {
    const x = xMin + (i / (numOut - 1)) * (xMax - xMin);
    // Find interval
    let k = 0;
    for (k = 0; k < n - 2; k++) { if (x < xs[k + 1]) break; }
    const h = dx[k], t = (x - xs[k]) / h;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    outX.push(Math.round(x));
    outY.push(Math.round(h00 * ys[k] + h10 * h * tg[k] + h01 * ys[k + 1] + h11 * h * tg[k + 1]));
  }
  return { xs: outX, ys: outY };
}

// ── Draw Target Profile ──────────────────────────────────

let opt2DrawMode = false;
let opt2TargetPoints = [];  // [{x: spot, y: payoff}, ...]

document.getElementById("btn-opt2-draw").addEventListener("click", opt2EnterDrawMode);
document.getElementById("btn-opt2-reduce-cost").addEventListener("click", () => {
  if (!opt2Data) {
    alert("Load portfolio data first (type 'hello' in chat)");
    return;
  }
  document.getElementById("opt2-ask").value =
    "Analyze my existing structures and find ways to reduce their cost. " +
    "Use ROLLS (suggest_rolls with objective reduce_cost) or CLOSE+REOPEN at better strikes. " +
    "Do NOT suggest pure overlays (selling extra calls/puts on top without closing anything) — overlays create hidden risk. " +
    "Do NOT suggest closing positions without reopening equivalent protection. " +
    "The goal is to maintain the same protective profile while spending less premium. " +
    "Present each cost-reduction trade as a named strategy block I can add to the workbench.";
  opt2Run();
});
document.getElementById("btn-opt2-price-move").addEventListener("click", () => {
  if (!opt2Data) {
    alert("Load portfolio data first (type 'hello' in chat)");
    return;
  }
  document.getElementById("opt2-ask").value =
    "PRICE MOVEMENT OPTIMIZATION.\n\n" +
    "You have two jobs after a price move:\n\n" +
    "JOB 1 — RECYCLE WORTHLESS POSITIONS (far OTM)\n" +
    "Find positions that are now nearly worthless (far OTM) and cheap to close. " +
    "Roll them into better-positioned protection closer to current spot. " +
    "Close for pennies, reopen near spot.\n" +
    "Example: Long Put at 1200 is worthless (spot is 2000). Close it for pennies. Open Long Put at 1800.\n\n" +
    "JOB 2 — TIGHTEN ITM SPREADS\n" +
    "Find spreads that are now deep ITM where both legs have significant intrinsic value. " +
    "The max payout on these is already locked in — but the wide strike width ties up margin/capital for no extra benefit. " +
    "Reduce the spread width by moving strikes closer together or closer to spot. This can:\n" +
    "- Free up margin for new trades\n" +
    "- Capture some locked-in value as cash\n" +
    "- Improve the payoff profile at current spot levels\n" +
    "Example: Put spread Long 1800 / Short 1400 with spot at 1200 — both deep ITM, max payout realized. " +
    "Tighten to Long 1400 / Short 1200 — similar protection at current levels, narrower width, frees up the rest.\n\n" +
    "WHAT TO ANALYZE:\n" +
    "- For each structure, compute how deep ITM or OTM it is relative to current spot\n" +
    "- For OTM structures: are they cheap to close and recycle? (Job 1)\n" +
    "- For ITM spreads: can the width be reduced while maintaining protection at current levels? (Job 2)\n" +
    "- For structures near the money: leave them alone, they are actively working\n\n" +
    "HARD RULES:\n" +
    "- Net cost of each roll step should be under $30K. If more, skip that structure.\n" +
    "- Total plan cost should be near zero or a small credit.\n" +
    "- Close/reopen ENTIRE structures (spreads = all legs). Include trade IDs.\n" +
    "- build_strategy only (not scan_trades). Name: 'Step N: Roll [type] [#IDs] [old] -> [new]'\n" +
    "- IMPORTANT: Tag each leg with role: 'close' (closing existing position) or 'open' (new position) so the UI shows which trades are closes vs opens.\n" +
    "- If NO positions qualify, say so. Do not force bad trades.";
  opt2Run();
});
document.getElementById("btn-opt2-clear-target").addEventListener("click", () => {
  opt2TargetPoints = [];
  document.getElementById("btn-opt2-clear-target").style.display = "none";
  opt2DrawChart();
});
document.getElementById("btn-opt2-draw-undo").addEventListener("click", () => {
  opt2TargetPoints.pop();
  opt2DrawChart();
});
document.getElementById("btn-opt2-draw-clear").addEventListener("click", () => {
  opt2TargetPoints = [];
  opt2DrawChart();
});
document.getElementById("btn-opt2-draw-done").addEventListener("click", opt2SendDrawnTarget);
document.getElementById("btn-opt2-draw-cancel").addEventListener("click", opt2ExitDrawMode);

function opt2EnterDrawMode() {
  if (!opt2Data) {
    alert("Load portfolio data first (type 'hello' in chat)");
    return;
  }
  opt2DrawMode = true;
  opt2TargetPoints = [];
  document.getElementById("opt2-draw-banner").style.display = "block";
  document.getElementById("btn-opt2-draw").style.background = "#f0883e";
  document.getElementById("btn-opt2-draw").style.color = "#fff";
  document.getElementById("btn-opt2-draw").textContent = "Drawing...";

  // Scroll to chart
  const chartEl = document.getElementById("opt2-chart-wrapper");
  if (chartEl) chartEl.scrollIntoView({ behavior: "smooth", block: "center" });

  // Use native click on the chart div — works anywhere on the plot area
  const $chart = document.getElementById("opt2-payoff-chart");
  $chart.addEventListener("click", opt2HandleChartClick);
  // Change cursor to crosshair over the plot area
  $chart.style.cursor = "crosshair";

  // Redraw to clear any old target
  opt2DrawChart();
}

function opt2ExitDrawMode() {
  opt2DrawMode = false;
  document.getElementById("opt2-draw-banner").style.display = "none";
  document.getElementById("btn-opt2-draw").style.background = "";
  document.getElementById("btn-opt2-draw").style.color = "#f0883e";
  document.getElementById("btn-opt2-draw").textContent = "Draw";

  // Remove click handler and reset cursor
  const $chart = document.getElementById("opt2-payoff-chart");
  $chart.removeEventListener("click", opt2HandleChartClick);
  $chart.style.cursor = "";
}

function opt2HandleChartClick(event) {
  if (!opt2DrawMode) return;

  const $chart = document.getElementById("opt2-payoff-chart");
  // Find the plot area element (Plotly's drag layer covers the data area)
  const plotArea = $chart.querySelector(".nsewdrag");
  if (!plotArea) return;

  const rect = plotArea.getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;

  // Ignore clicks outside the plot area
  if (px < 0 || py < 0 || px > rect.width || py > rect.height) return;

  // Convert pixel coordinates to data coordinates using Plotly's axis objects
  const xaxis = $chart._fullLayout.xaxis;
  const yaxis = $chart._fullLayout.yaxis;

  // p2l: pixel to linear (for log axis, returns log10 value)
  // l2d: linear to data (for log axis, returns 10^value)
  const xData = xaxis.l2d(xaxis.p2l(px));
  const yData = yaxis.l2d(yaxis.p2l(py));

  if (!isFinite(xData) || !isFinite(yData)) return;

  opt2TargetPoints.push({ x: Math.round(xData), y: Math.round(yData) });
  opt2DrawChart();
}

function opt2SendDrawnTarget() {
  if (opt2TargetPoints.length < 2) {
    alert("Place at least 2 points on the chart");
    return;
  }

  // Smooth the curve before sending — gives the AI a proper curve to work with
  const smooth = opt2SmoothCurve(opt2TargetPoints, 40);
  const smoothedPoints = smooth.xs.map((x, i) => ({ x, y: smooth.ys[i] }));

  // Build a human-readable summary from KEY points (raw + a few interpolated)
  const sorted = [...opt2TargetPoints].sort((a, b) => a.x - b.x);
  const lines = sorted.map(p =>
    `  $${p.x.toLocaleString()} -> $${p.y.toLocaleString()}`
  );
  const msgText = `Match this target payoff profile (smoothed from my drawing):\n${lines.join("\n")}`;

  // Put into the chat input and send
  document.getElementById("opt2-ask").value = msgText;
  opt2ExitDrawMode();

  // Store the SMOOTHED target data so it gets sent with the chat message
  window._opt2DrawnTarget = smoothedPoints;

  // Also update the drawn points to include smoothed version for display
  // (keep originals for marker display, smoothed goes to backend)

  // Trigger send
  opt2Run();
}

// ── Saved Curves (localStorage + multi-display) ─────────

const OPT2_CURVES_KEY = "opt2_saved_curves";
let opt2DisplayedCurves = new Set();  // indices of curves shown on chart
let opt2SendCurveIdx = -1;            // index of curve selected to send

// Curve colors for multi-display (up to 8)
const OPT2_CURVE_COLORS = ["#f0883e", "#58a6ff", "#d2a8ff", "#3fb950", "#f85149", "#e3b341", "#79c0ff", "#ff7b72"];

const OPT2_DEFAULT_CURVES = [
  {
    name: "Current Target",
    color: "#f0883e",
    points: [
      {x:0,y:-5e6},{x:200,y:-5e6},{x:400,y:-5e6},{x:600,y:-6e6},
      {x:800,y:-8e6},{x:1000,y:-10e6},{x:1200,y:-12e6},{x:1400,y:-14e6},
      {x:1600,y:-16e6},{x:1800,y:-18e6},{x:2000,y:-20e6},{x:2200,y:-18e6},
      {x:2400,y:-16e6},{x:2600,y:-14e6},{x:2800,y:-12e6},{x:3000,y:-10e6},
      {x:3200,y:-10e6},{x:3400,y:-10e6},{x:3600,y:-10e6},{x:3800,y:-10e6},
      {x:4000,y:-10e6},{x:4200,y:-10e6},{x:4400,y:-10e6},{x:4600,y:-10e6},
      {x:4800,y:-10e6},{x:5000,y:-10e6},
    ],
  },
  {
    name: "Migration Step 1",
    color: "#58a6ff",
    points: [
      {x:0,y:-5e6},{x:200,y:-5e6},{x:400,y:-5e6},{x:600,y:-5e6},
      {x:800,y:-7e6},{x:1000,y:-9e6},{x:1200,y:-11e6},{x:1400,y:-13e6},
      {x:1600,y:-15e6},{x:1800,y:-17e6},{x:2000,y:-19e6},{x:2200,y:-17e6},
      {x:2400,y:-15e6},{x:2600,y:-13e6},{x:2800,y:-11e6},{x:3000,y:-10e6},
      {x:3200,y:-10e6},{x:3400,y:-10e6},{x:3600,y:-10e6},{x:3800,y:-10e6},
      {x:4000,y:-10e6},{x:4200,y:-10e6},{x:4400,y:-10e6},{x:4600,y:-10e6},
      {x:4800,y:-10e6},{x:5000,y:-10e6},
    ],
  },
  {
    name: "Migration Step 2",
    color: "#d2a8ff",
    points: [
      {x:0,y:-5e6},{x:200,y:-5e6},{x:400,y:-5e6},{x:600,y:-5e6},
      {x:800,y:-5e6},{x:1000,y:-6e6},{x:1200,y:-8e6},{x:1400,y:-10e6},
      {x:1600,y:-12e6},{x:1800,y:-14e6},{x:2000,y:-16e6},{x:2200,y:-18e6},
      {x:2400,y:-16e6},{x:2600,y:-14e6},{x:2800,y:-12e6},{x:3000,y:-10e6},
      {x:3200,y:-10e6},{x:3400,y:-10e6},{x:3600,y:-10e6},{x:3800,y:-10e6},
      {x:4000,y:-10e6},{x:4200,y:-10e6},{x:4400,y:-10e6},{x:4600,y:-10e6},
      {x:4800,y:-10e6},{x:5000,y:-10e6},
    ],
  },
  {
    name: "Migration Step 3",
    color: "#3fb950",
    points: [
      {x:0,y:-5e6},{x:200,y:-5e6},{x:400,y:-5e6},{x:600,y:-5e6},
      {x:800,y:-7e6},{x:1000,y:-9e6},{x:1200,y:-11e6},{x:1400,y:-13e6},
      {x:1600,y:-15e6},{x:1800,y:-17e6},{x:2000,y:-15e6},{x:2200,y:-13e6},
      {x:2400,y:-11e6},{x:2600,y:-10e6},{x:2800,y:-10e6},{x:3000,y:-10e6},
      {x:3200,y:-10e6},{x:3400,y:-10e6},{x:3600,y:-10e6},{x:3800,y:-10e6},
      {x:4000,y:-10e6},{x:4200,y:-10e6},{x:4400,y:-10e6},{x:4600,y:-10e6},
      {x:4800,y:-10e6},{x:5000,y:-10e6},
    ],
  },
];

function opt2LoadSavedCurves() {
  try {
    const raw = localStorage.getItem(OPT2_CURVES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function opt2SaveCurvesToStorage(curves) {
  localStorage.setItem(OPT2_CURVES_KEY, JSON.stringify(curves));
}

function opt2GetAllCurves() {
  const saved = opt2LoadSavedCurves();
  const names = new Set(saved.map(c => c.name));
  const all = [...saved];
  for (const d of OPT2_DEFAULT_CURVES) {
    if (!names.has(d.name)) all.push(d);
  }
  return all;
}

function opt2RefreshCurvesList() {
  const $list = document.getElementById("opt2-curves-list");
  const curves = opt2GetAllCurves();
  $list.innerHTML = "";

  curves.forEach((c, i) => {
    const color = c.color || OPT2_CURVE_COLORS[i % OPT2_CURVE_COLORS.length];
    const isDisplayed = opt2DisplayedCurves.has(i);
    const isSend = opt2SendCurveIdx === i;

    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:.5rem;padding:4px 8px;border-radius:6px;background:var(--surface);border:1px solid var(--border)";
    if (isSend) row.style.borderColor = color;

    row.innerHTML =
      `<input type="checkbox" class="opt2-curve-display" data-idx="${i}" ${isDisplayed ? "checked" : ""} ` +
        `style="accent-color:${color};cursor:pointer" title="Show on chart">` +
      `<input type="radio" name="opt2-curve-send" class="opt2-curve-radio" data-idx="${i}" ${isSend ? "checked" : ""} ` +
        `style="accent-color:${color};cursor:pointer" title="Select to send to chat">` +
      `<span style="width:12px;height:12px;border-radius:2px;background:${color};flex-shrink:0"></span>` +
      `<span style="flex:1;font-size:.78rem;font-weight:${isSend ? 700 : 400};color:${isDisplayed ? 'var(--text)' : 'var(--muted)'}">${c.name}</span>` +
      `<span style="font-size:.65rem;color:var(--muted)">${c.points.length} pts</span>`;

    $list.appendChild(row);
  });

  // Wire checkbox (display) events
  $list.querySelectorAll(".opt2-curve-display").forEach(cb => {
    cb.addEventListener("change", () => {
      const idx = parseInt(cb.dataset.idx);
      if (cb.checked) opt2DisplayedCurves.add(idx);
      else opt2DisplayedCurves.delete(idx);
      opt2RefreshCurvesList();
      opt2DrawChart();
      // Show chart
      const $w = document.getElementById("opt2-chart-wrapper");
      if ($w && opt2DisplayedCurves.size > 0) $w.style.display = "block";
    });
  });

  // Wire radio (send) events
  $list.querySelectorAll(".opt2-curve-radio").forEach(rb => {
    rb.addEventListener("change", () => {
      opt2SendCurveIdx = parseInt(rb.dataset.idx);
      // Also display it
      opt2DisplayedCurves.add(opt2SendCurveIdx);
      opt2RefreshCurvesList();
      opt2DrawChart();
      const $w = document.getElementById("opt2-chart-wrapper");
      if ($w) $w.style.display = "block";
    });
  });
}

// Get displayed curves for chart overlay
function opt2GetDisplayedCurveTraces() {
  const curves = opt2GetAllCurves();
  const traces = [];
  for (const i of opt2DisplayedCurves) {
    const c = curves[i];
    if (!c) continue;
    const color = c.color || OPT2_CURVE_COLORS[i % OPT2_CURVE_COLORS.length];
    const isSend = i === opt2SendCurveIdx;
    const sorted = [...c.points].sort((a, b) => a.x - b.x);
    // Smooth the curve
    const smooth = opt2SmoothCurve(sorted, 60);
    traces.push({
      x: smooth.xs, y: smooth.ys, type: "scatter", mode: "lines",
      name: c.name + (isSend ? " [SEND]" : ""),
      line: { color, width: isSend ? 3 : 2, dash: isSend ? "solid" : "dash" },
    });
  }
  return traces;
}

// Send selected curve to chat
document.getElementById("btn-opt2-curve-send").addEventListener("click", () => {
  const curves = opt2GetAllCurves();
  if (opt2SendCurveIdx < 0 || !curves[opt2SendCurveIdx]) {
    alert("Select a curve to send (use the radio button)");
    return;
  }
  const c = curves[opt2SendCurveIdx];
  opt2TargetPoints = c.points.map(p => ({ ...p }));
  opt2DrawChart();
  opt2SendDrawnTarget();
});

// Save current drawn curve
document.getElementById("btn-opt2-curve-save").addEventListener("click", () => {
  if (opt2TargetPoints.length < 2) {
    alert("Draw at least 2 points on the chart first");
    return;
  }
  const name = prompt("Name this curve:", `Custom Curve ${new Date().toLocaleDateString()}`);
  if (!name) return;
  const curves = opt2LoadSavedCurves();
  const existing = curves.findIndex(c => c.name === name);
  const entry = { name, points: [...opt2TargetPoints].sort((a, b) => a.x - b.x), savedAt: new Date().toISOString() };
  if (existing >= 0) curves[existing] = entry;
  else curves.push(entry);
  opt2SaveCurvesToStorage(curves);
  opt2RefreshCurvesList();
});

// Delete selected curve
document.getElementById("btn-opt2-curve-delete").addEventListener("click", () => {
  const curves = opt2GetAllCurves();
  if (opt2SendCurveIdx < 0 || !curves[opt2SendCurveIdx]) { alert("Select a curve first (radio button)"); return; }
  const name = curves[opt2SendCurveIdx].name;
  if (!confirm(`Delete curve "${name}"?`)) return;
  const saved = opt2LoadSavedCurves().filter(c => c.name !== name);
  opt2SaveCurvesToStorage(saved);
  opt2DisplayedCurves.delete(opt2SendCurveIdx);
  opt2SendCurveIdx = -1;
  opt2RefreshCurvesList();
  opt2DrawChart();
});

// Initialize
opt2RefreshCurvesList();

// ── Baseline vs Current comparison matrix ────────────────

function opt2RenderMatrix() {
  const $section = document.getElementById("opt2-matrix-section");
  if (!$section) return;
  if (!opt2Baseline || !opt2Data) { $section.style.display = "none"; return; }

  // Only show if portfolio has changed from baseline
  const hasChanges = opt2AddedTrades.length > 0 || opt2Data._wbPayoff;
  if (!hasChanges) { $section.style.display = "none"; return; }

  $section.style.display = "block";
  const spots = opt2Data.spot_ladder;
  const spot = opt2Data.spot;
  const baseSpots = opt2Baseline.spot_ladder;
  const basePnl = opt2Baseline.payoff;
  const curPnl = opt2Data.current_payoff;
  const wbPnl = opt2Data._wbPayoff || null;

  // Pick key spot levels — asset-aware rounding
  const multipliers = [0.3, 0.5, 0.7, 0.85, 0.95, 1.0, 1.05, 1.15, 1.3, 1.5, 2.0, 3.0];
  const roundStep = currentAsset === "FIL" ? 0.5 : 50;
  const keySpots = multipliers.map(m => Math.round(spot * m / roundStep) * roundStep);

  const fmtM = v => (v >= 0 ? "+" : "-") + "$" + Math.abs(Math.round(v)).toLocaleString();
  const fmtCls = v => v >= 0 ? "mtm-pos" : "mtm-neg";

  const $thead = document.getElementById("opt2-matrix-thead");
  const thStyle = 'style="text-align:center"';
  let hdr = `<tr><th ${thStyle}>${currentAsset} Spot</th><th ${thStyle}>Baseline P&L</th><th ${thStyle}>Current P&L</th><th ${thStyle}>Change</th>`;
  if (wbPnl) hdr += `<th ${thStyle}>With Workbench</th><th ${thStyle}>WB vs Baseline</th>`;
  hdr += "</tr>";
  $thead.innerHTML = hdr;

  const $tbody = document.getElementById("opt2-matrix-tbody");
  $tbody.innerHTML = "";

  for (const ks of keySpots) {
    const bIdx = baseSpots.reduce((best, s, i) => Math.abs(s - ks) < Math.abs(baseSpots[best] - ks) ? i : best, 0);
    const cIdx = spots.reduce((best, s, i) => Math.abs(s - ks) < Math.abs(spots[best] - ks) ? i : best, 0);

    const bVal = basePnl[bIdx] || 0;
    const cVal = curPnl[cIdx] || 0;
    const diff = cVal - bVal;
    const isSpot = Math.abs(ks - spot) < (currentAsset === "FIL" ? 1 : 100);

    const cs = "font-family:monospace;text-align:center";
    let row = `<tr${isSpot ? ' style="background:rgba(88,166,255,0.08);font-weight:600"' : ""}>`;
    row += `<td style="${cs}">$${currentAsset === "FIL" ? ks.toFixed(2) : ks.toLocaleString()}${isSpot ? " (spot)" : ""}</td>`;
    row += `<td style="${cs}" class="${fmtCls(bVal)}">${fmtM(bVal)}</td>`;
    row += `<td style="${cs}" class="${fmtCls(cVal)}">${fmtM(cVal)}</td>`;
    row += `<td style="${cs}" class="${fmtCls(diff)}">${fmtM(diff)}</td>`;

    if (wbPnl) {
      const wVal = wbPnl[cIdx] || 0;
      const wDiff = wVal - bVal;
      row += `<td style="${cs}" class="${fmtCls(wVal)}">${fmtM(wVal)}</td>`;
      row += `<td style="${cs}" class="${fmtCls(wDiff)}">${fmtM(wDiff)}</td>`;
    }
    row += "</tr>";
    $tbody.innerHTML += row;
  }
}

// ── Event wiring ─────────────────────────────────────────

document.getElementById("btn-opt2-run").addEventListener("click", opt2Run);
document.getElementById("btn-opt2-calc").addEventListener("click", opt2Calculate);
document.getElementById("btn-opt2-add-to-portfolio").addEventListener("click", opt2AddToPortfolio);

// Send workbench trades to Pricing screen (leg by leg)
document.getElementById("btn-opt2-send-to-exec").addEventListener("click", () => {
  if (opt2WbLegs.length === 0) { alert("No legs in workbench"); return; }

  // Clear existing legs on the Pricing screen
  legs.length = 0;

  // Add each workbench leg to the Pricing screen's legs array
  for (const l of opt2WbLegs) {
    const premium = l.price_usd ? String(Math.round(l.price_usd * 100) / 100) : "0";
    // Extract expiry_code from leg or from instrument name (ETH-13APR26-3600-P)
    let expCode = l.expiry_code;
    if (!expCode && l.instrument) {
      const parts = l.instrument.split("-");
      if (parts.length >= 3) expCode = parts[1];
    }
    addLeg(l.side, l.opt, String(l.strike), premium, String(l.qty), expCode || null);
  }

  // Add custom expiries to the main expiry dropdown if missing
  const existingExpOpts = new Set([...$expSel.options].map(o => o.value));
  for (const l of opt2WbLegs) {
    let ec = l.expiry_code;
    if (!ec && l.instrument) { const p = l.instrument.split("-"); if (p.length >= 3) ec = p[1]; }
    if (ec && !existingExpOpts.has(ec)) {
      const dte = _expiryCodeToDte(ec);
      const opt = document.createElement("option");
      opt.value = ec;
      opt.textContent = `${ec} (${dte != null ? dte + 'd' : '?'}) [interpolated]`;
      $expSel.appendChild(opt);
      existingExpOpts.add(ec);
    }
  }

  // Switch to the Pricing page
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const pricingBtn = document.querySelector('.nav-btn[data-page="pricing"]');
  if (pricingBtn) pricingBtn.classList.add("active");
  document.getElementById("page-pricing").classList.add("active");

  // Auto-trigger pricing via vol surface
  setTimeout(() => {
    const priceBtn = document.getElementById("btn-replicate");
    if (priceBtn) priceBtn.click();
  }, 300);

  opt2AddMsg("bot",
    `<strong style="color:#58a6ff">${opt2WbLegs.length} leg(s) sent to Pricing screen.</strong> ` +
    `Switched to Pricing — review legs and run pricing.`
  );
});

// Refresh button — re-fetch portfolio data and reset chat state
document.getElementById("btn-opt2-refresh").addEventListener("click", async () => {
  opt2Data = null;
  opt2WbLegs = [];
  opt2WbName = "";
  opt2ClosedTradeIds = [];
  opt2RollMeta = new Map();
  opt2ScenarioTrades = [];
  document.getElementById("opt2-workbench-section").style.display = "none";
  document.getElementById("opt2-results-section").style.display = "none";
  document.getElementById("opt2-portfolio-section").style.display = "none";
  // Hide the chart wrapper — hiding the inner Plotly div directly causes the
  // chart to stay invisible across subsequent redraws.
  document.getElementById("opt2-chart-wrapper").style.display = "none";
  // Re-trigger a greeting to reload portfolio context
  document.getElementById("opt2-ask").value = "hello";
  await opt2Run();
});

// Delete all optimizer-added trades, clear workbench, clear chat
document.getElementById("btn-opt2-delete-all").addEventListener("click", async () => {
  const total = opt2AddedTrades.length + opt2WbLegs.length;
  if (total === 0 && opt2ChatHistory.length <= 1) {
    alert("Nothing to reset.");
    return;
  }
  if (!confirm("This will clear all scenario trades, workbench, and reset the chat. Continue?")) return;

  // Clear scenario state (no DB changes)
  opt2AddedTrades = [];
  opt2ScenarioTrades = [];

  // Clear workbench + roll state
  opt2WbLegs = [];
  opt2WbName = "";
  opt2ClosedTradeIds = [];
  opt2RollMeta = new Map();
  opt2ScenarioTrades = [];
  document.getElementById("opt2-workbench-section").style.display = "none";

  // Clear suggestions and baseline
  opt2Data = null;
  opt2Baseline = null;
  document.getElementById("opt2-results-section").style.display = "none";
  document.getElementById("opt2-portfolio-section").style.display = "none";
  // Hide the chart wrapper — see note in btn-opt2-refresh.
  document.getElementById("opt2-chart-wrapper").style.display = "none";
  const $matrix = document.getElementById("opt2-matrix-section");
  if ($matrix) $matrix.style.display = "none";

  // Reset chat
  opt2ChatHistory = [];
  const $log = document.getElementById("opt2-chat-log");
  $log.innerHTML = `<div class="opt2-msg opt2-msg-bot"><div class="opt2-msg-bubble"><strong>Optimizer</strong><br>Reset complete. What would you like to work on?</div></div>`;

  pfData = null; portfolioLoaded = false;
});

// Preset buttons
document.querySelectorAll(".opt2-preset").forEach(btn => {
  btn.addEventListener("click", () => {
    document.getElementById("opt2-ask").value = btn.dataset.q;
    opt2Run();
  });
});

// Enter key on ask input
document.getElementById("opt2-ask").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); opt2Run(); }
});

// Add leg(s) — strategy-template driven (Put / Call / Spread / Straddle / Strangle / Iron Condor).
// Strikes are rounded to the asset's strike step (ETH=50, FIL=0.05). The Type cell on each
// resulting row is editable, so users can still flip Call<->Put after the fact.
function opt2RoundStrike(s) {
  const step = (typeof currentAsset !== "undefined" && currentAsset === "FIL") ? 0.05 : 50;
  return Math.round(s / step) * step;
}

document.getElementById("btn-opt2-add-leg").addEventListener("click", () => {
  if (!opt2Data) return;
  const tpl = document.getElementById("opt2-add-template")?.value || "put";
  const spot = opt2Data.spot || 0;
  const qty = opt2Data.base_qty;
  const expiry = opt2Data.available_expiries?.[0] || "";
  const atm   = opt2RoundStrike(spot);
  const up10  = opt2RoundStrike(spot * 1.10);
  const dn10  = opt2RoundStrike(spot * 0.90);
  const up20  = opt2RoundStrike(spot * 1.20);
  const dn20  = opt2RoundStrike(spot * 0.80);
  const blank = { instrument: "", expiry_code: expiry, dte: 30, price_usd: 0, bid_usd: 0, ask_usd: 0, spread_pct: 0, mark_iv: null };
  const mk = (side, opt, strike) => ({ ...blank, side, opt, strike, qty });
  let added;
  switch (tpl) {
    case "call":         added = [mk("buy", "C", atm)]; break;
    case "call_spread":  added = [mk("buy", "C", atm),  mk("sell", "C", up10)]; break;
    case "put_spread":   added = [mk("buy", "P", atm),  mk("sell", "P", dn10)]; break;
    case "straddle":     added = [mk("buy", "C", atm),  mk("buy",  "P", atm)]; break;
    case "strangle":     added = [mk("buy", "C", up10), mk("buy",  "P", dn10)]; break;
    case "iron_condor":  added = [
      mk("buy",  "P", dn20),
      mk("sell", "P", dn10),
      mk("sell", "C", up10),
      mk("buy",  "C", up20),
    ]; break;
    case "put":
    default:             added = [mk("buy", "P", atm)]; break;
  }
  opt2WbLegs.push(...added);
  opt2RenderWorkbench();
});

document.getElementById("btn-opt2-clear-wb").addEventListener("click", () => {
  opt2WbLegs = [];
  opt2WbName = "";
  opt2ClosedTradeIds = [];
  opt2RollMeta = new Map();
  opt2ScenarioTrades = [];
  document.getElementById("opt2-wb-name").textContent = "--";
  opt2RenderWorkbench();
  delete opt2Data?._wbPayoff;
  opt2DrawChart();
});

["opt2-filter-cat", "opt2-sort"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => {
    if (opt2Data) { opt2HighlightIdx = -1; opt2ApplyFilter(); opt2DrawChart(); }
  });
});

// Scenario Trades filter controls
["opt2-port-filter-cpty", "opt2-port-filter-type", "opt2-port-filter-side", "opt2-port-show-closed"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => {
    if (opt2Data) opt2RenderPortfolio();
  });
});

// Scenario Trades clickable column header sorting
document.getElementById("opt2-port-table").addEventListener("click", e => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const col = th.dataset.col;
  if (opt2PortSortCol === col) {
    opt2PortSortAsc = !opt2PortSortAsc;
  } else {
    opt2PortSortCol = col;
    opt2PortSortAsc = true;
  }
  opt2RenderPortfolio();
});

// ═══════════════════════════════════════════════════════════
// ═══  STRATEGY BUILDER TAB  ════════════════════════════════
// ═══════════════════════════════════════════════════════════

let sbLoaded = false;
let sbSelected = new Set();
let sbIncluded = new Set();
let sbLastResults = null;
let sbSortStack = [{ col: "expiry", asc: true }];
let sbLegs = [];
let sbLegsPriced = [];
let sbStructureCurves = null;
let sbOriginalPositionIds = null;  // snapshot before adding structures
let sbRemovedPositions = [];       // positions removed via Remove button (kept for baseline)

// ── Init & populate ──────────────────────────────────────

async function sbInit() {
  if (!pfData) {
    try {
      pfData = await get(`/api/portfolio/pnl?asset=${currentAsset}`);
      portfolioLoaded = true;
      if (pfSelected.size === 0) pfSelected = new Set(pfData.positions.map(p => p.id));
    } catch (e) {
      console.error("Failed to load portfolio for strategy builder:", e);
      alert("Failed to load portfolio data.\n" + e.message);
      return;
    }
  }
  if (!volSurface) {
    try { volSurface = await get("/api/market/vol-surface"); } catch (e) { /* optional */ }
  }
  sbPopulate();
}

function sbPopulate() {
  const cptys = [...new Set(pfData.positions.map(p => p.counterparty))].sort();
  const $cpF = document.getElementById("sb-filter-counterparty");
  $cpF.innerHTML = '<option value="">All</option>';
  cptys.forEach(c => { const o = document.createElement("option"); o.value = c; o.textContent = c; $cpF.appendChild(o); });

  const expiries = [...new Set(pfData.positions.map(p => p.expiry.split("T")[0]))].sort();
  const $expF = document.getElementById("sb-filter-expiry");
  $expF.innerHTML = '<option value="">All</option>';
  expiries.forEach(e => { const o = document.createElement("option"); o.value = e; o.textContent = e; $expF.appendChild(o); });

  const $targetExp = document.getElementById("sb-target-expiry");
  $targetExp.innerHTML = "";
  const smiles = (pfData.vol_surface || []).filter(s => s.dte > 0).sort((a, b) => a.dte - b.dte);
  smiles.forEach(s => {
    const o = document.createElement("option");
    o.value = s.expiry_code; o.textContent = `${s.expiry_code} (${s.dte}d)`;
    $targetExp.appendChild(o);
  });
  if (smiles.length > 0) $targetExp.value = smiles[0].expiry_code;

  sbSelected = new Set();
  sbIncluded = new Set(pfData.positions.map(p => p.id));
  sbLastResults = null;
  sbStructureCurves = null;
  sbLegsPriced = [];
  sbRemovedPositions = [];
  sbOriginalPositionIds = new Set(pfData.positions.map(p => p.id));
  sbRenderTable();
  sbRenderLegs();
  sbDrawStructureChart();
  sbDrawChart(null);
  sbRenderMtmGrid(null);
  sbLoaded = true;
}

// ── Filtering & sorting ──────────────────────────────────

function sbGetFilteredPositions() {
  const fCpty = document.getElementById("sb-filter-counterparty").value;
  const fExpiry = document.getElementById("sb-filter-expiry").value;
  const fType = document.getElementById("sb-filter-type").value;
  const fSide = document.getElementById("sb-filter-side").value;
  let list = [...pfData.positions];
  if (fCpty) list = list.filter(p => p.counterparty === fCpty);
  if (fExpiry) list = list.filter(p => p.expiry.split("T")[0] === fExpiry);
  if (fType) list = list.filter(p => p.opt === fType);
  if (fSide) list = list.filter(p => p.side === fSide);
  if (sbSortStack.length > 0) {
    list.sort((a, b) => {
      for (const { col, asc } of sbSortStack) {
        let va = a[col], vb = b[col];
        if (typeof va === "string") { va = va.toLowerCase(); vb = (vb || "").toLowerCase(); }
        if (va < vb) return asc ? -1 : 1;
        if (va > vb) return asc ? 1 : -1;
      }
      return 0;
    });
  }
  return list;
}

function sbGetTargetExpiry() {
  return document.getElementById("sb-target-expiry").value;
}

// ── Position table ───────────────────────────────────────

function sbRenderTable() {
  const list = sbGetFilteredPositions();
  document.getElementById("sb-table-count").textContent = `(${list.length} trades)`;
  const globalExpiry = sbGetTargetExpiry();
  const allVisibleRoll = list.length > 0 && list.every(p => sbSelected.has(p.id));
  const allVisibleIncl = list.length > 0 && list.every(p => sbIncluded.has(p.id));
  document.getElementById("sb-check-all").checked = allVisibleRoll;
  document.getElementById("sb-include-all").checked = allVisibleIncl;

  const primarySort = sbSortStack[0] || null;
  const secondarySort = sbSortStack[1] || null;
  document.querySelectorAll("#sb-trades-table .sortable").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc", "sort-secondary");
    if (primarySort && th.dataset.col === primarySort.col) th.classList.add(primarySort.asc ? "sort-asc" : "sort-desc");
    else if (secondarySort && th.dataset.col === secondarySort.col) th.classList.add("sort-secondary");
  });

  const _sd = currentAsset === "FIL" ? 2 : 0;
  const fmtNum = (v, d=0) => v != null ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : "---";
  const spot = pfData.eth_spot;
  const $tbody = document.getElementById("sb-trades-body");
  $tbody.innerHTML = "";

  for (const pos of list) {
    const included = sbIncluded.has(pos.id);
    const checked = sbSelected.has(pos.id);
    const typeColor = pos.opt === "C" ? "var(--green)" : "var(--red)";
    const sideClass = pos.side === "Long" ? "qty-long" : "qty-short";
    const rowClass = (checked ? "roll-row-selected" : "") + (!included ? " pf-row-excluded" : "");
    const absQty = Math.abs(pos.net_qty);
    const newDte = rollDteForExpiry(globalExpiry);
    const T = Math.max(newDte, 0) / 365.25;
    const rollIvPct = pfLookupIv(newDte, pos.strike) ?? pos.iv_pct;
    const sigma = rollIvPct / 100;
    const newMark = bsPrice(spot, pos.strike, T, 0, sigma, pos.opt);
    const curMark = pos.mark_price_usd ?? 0;
    const closeVal = pos.net_qty * curMark;
    const openVal = pos.net_qty * newMark;
    const cost = closeVal - openVal;
    const costRounded = Math.round(cost);
    const costCls = costRounded >= 0 ? "mtm-pos" : "mtm-neg";
    const costLabel = costRounded >= 0 ? "Rcv" : "Pay";
    const expiryOpts = rollGetExpiryOptions(globalExpiry);

    const tr = document.createElement("tr");
    tr.className = rowClass;
    tr.dataset.posId = pos.id;
    tr.innerHTML =
      `<td class="roll-include-cell"><input type="checkbox" class="roll-include" data-id="${pos.id}" ${included ? "checked" : ""}></td>` +
      `<td><input type="checkbox" class="roll-check" data-id="${pos.id}" ${checked ? "checked" : ""}></td>` +
      `<td style="text-align:left;font-size:.72rem">${pos.counterparty || ""}</td>` +
      `<td style="text-align:left;font-size:.72rem">${pos.instrument}</td>` +
      `<td style="text-align:left" class="${sideClass}">${pos.side_raw}</td>` +
      `<td style="text-align:left;color:${typeColor}">${pos.opt === "C" ? "Call" : "Put"}</td>` +
      `<td style="font-family:monospace">${fmtNum(pos.strike, _sd)}</td>` +
      `<td>${pos.expiry}</td>` +
      `<td>${Math.round(pos.days_remaining)}</td>` +
      `<td style="font-family:monospace">${fmtNum(pos.net_qty)}</td>` +
      `<td style="font-family:monospace">$${fmtNum(curMark, 2)}</td>` +
      `<td>${pos.iv_pct != null ? pos.iv_pct.toFixed(1) + "%" : "---"}</td>` +
      `<td class="${pos.current_mtm >= 0 ? 'mtm-pos' : 'mtm-neg'}" style="font-family:monospace">$${fmtNum(pos.current_mtm)}</td>` +
      `<td><select class="roll-expiry-select" data-id="${pos.id}" style="font-size:.72rem;width:100%;margin:0">${expiryOpts}</select></td>` +
      `<td><input type="number" class="roll-strike-input" data-id="${pos.id}" value="${pos.strike}" step="any" style="width:100%;font-size:.75rem;padding:.2rem .3rem;text-align:center"></td>` +
      `<td><input type="number" class="roll-qty-input" data-id="${pos.id}" value="${absQty}" step="1" min="0" style="width:100%;font-size:.75rem;padding:.2rem .3rem;text-align:center"></td>` +
      `<td><select class="roll-type-select" data-id="${pos.id}" style="font-size:.72rem;width:100%;margin:0">` +
        `<option value="C" ${pos.opt === "C" ? "selected" : ""}>Call</option>` +
        `<option value="P" ${pos.opt === "P" ? "selected" : ""}>Put</option></select></td>` +
      `<td style="font-family:monospace" class="roll-new-mark">$${fmtNum(newMark, 2)}</td>` +
      `<td class="roll-iv-used">${rollIvPct.toFixed(1)}%</td>` +
      `<td class="${costCls} roll-cost" style="font-family:monospace;font-weight:600">${costLabel} $${Math.abs(costRounded).toLocaleString()}</td>` +
      `<td><button class="btn-remove-pos" data-id="${pos.id}" title="Remove trade" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.85rem;padding:.2rem .4rem;opacity:.6">&times;</button></td>`;
    $tbody.appendChild(tr);
  }

  // Wire remove buttons
  $tbody.querySelectorAll(".btn-remove-pos").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = parseInt(btn.dataset.id);
      sbRemovePosition(id);
    });
  });

  // Wire include checkboxes
  $tbody.querySelectorAll(".roll-include").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) sbIncluded.add(id); else sbIncluded.delete(id);
      cb.closest("tr").classList.toggle("pf-row-excluded", !cb.checked);
      const visible = sbGetFilteredPositions();
      document.getElementById("sb-include-all").checked = visible.length > 0 && visible.every(p => sbIncluded.has(p.id));
      sbRefreshVisuals();
    });
  });

  // Wire roll checkboxes
  $tbody.querySelectorAll(".roll-check").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) sbSelected.add(id); else sbSelected.delete(id);
      cb.closest("tr").classList.toggle("roll-row-selected", cb.checked);
      const visible = sbGetFilteredPositions();
      document.getElementById("sb-check-all").checked = visible.length > 0 && visible.every(p => sbSelected.has(p.id));
    });
  });

  // Wire inline edits
  $tbody.querySelectorAll(".roll-expiry-select, .roll-strike-input, .roll-qty-input, .roll-type-select").forEach(el => {
    el.addEventListener("change", () => sbInlineUpdate(el.closest("tr")));
  });
}

function sbInlineUpdate(row) {
  const posId = parseInt(row.dataset.posId);
  const pos = pfData.positions.find(p => p.id === posId);
  if (!pos) return;
  const newExpCode = row.querySelector(".roll-expiry-select").value;
  const newStrike = parseFloat(row.querySelector(".roll-strike-input").value) || pos.strike;
  const newAbsQty = parseFloat(row.querySelector(".roll-qty-input").value);
  const newType = row.querySelector(".roll-type-select").value;
  const sign = pos.net_qty >= 0 ? 1 : -1;
  const newNetQty = isNaN(newAbsQty) ? pos.net_qty : sign * newAbsQty;
  const newDte = rollDteForExpiry(newExpCode);
  const T = Math.max(newDte, 0) / 365.25;
  const iv = pfLookupIv(newDte, newStrike) ?? pos.iv_pct;
  const sigma = iv / 100;
  const nm = bsPrice(pfData.eth_spot, newStrike, T, 0, sigma, newType);
  const cm = pos.mark_price_usd ?? 0;
  const closeVal = pos.net_qty * cm;
  const openVal = newNetQty * nm;
  const cost = closeVal - openVal;
  const cr = Math.round(cost);
  row.querySelector(".roll-new-mark").textContent = `$${nm.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  row.querySelector(".roll-iv-used").textContent = `${iv.toFixed(1)}%`;
  const costCell = row.querySelector(".roll-cost");
  costCell.textContent = `${cr >= 0 ? "Rcv" : "Pay"} $${Math.abs(cr).toLocaleString()}`;
  costCell.className = `${cr >= 0 ? "mtm-pos" : "mtm-neg"} roll-cost`;
  costCell.style.fontFamily = "monospace";
  costCell.style.fontWeight = "600";
}

// ── Remove position ──────────────────────────────────────

function sbRemovePosition(id) {
  const idx = pfData.positions.findIndex(p => p.id === id);
  if (idx === -1) return;
  const pos = pfData.positions[idx];
  sbRemovedPositions.push(pos);
  pfData.positions.splice(idx, 1);
  sbIncluded.delete(id);
  sbSelected.delete(id);
  pfSelected.delete(id);
  sbRenderTable();
  sbRefreshVisuals();
}

// ── Roll computation ─────────────────────────────────────

function sbComputeRoll() {
  if (!pfData) return;
  const selectedPositions = pfData.positions.filter(p => sbSelected.has(p.id));
  if (selectedPositions.length === 0) { alert("Select at least one leg to roll."); return; }

  const globalExpiry = sbGetTargetExpiry();
  const spot = pfData.eth_spot;
  const results = [];
  let totalCloseValue = 0, totalOpenValue = 0, totalRollCost = 0;

  for (const pos of selectedPositions) {
    const row = document.querySelector(`#sb-trades-body tr[data-pos-id="${pos.id}"]`);
    const newExpCode = row ? row.querySelector(".roll-expiry-select").value : globalExpiry;
    const newStrike = row ? (parseFloat(row.querySelector(".roll-strike-input").value) || pos.strike) : pos.strike;
    const newAbsQty = row ? parseFloat(row.querySelector(".roll-qty-input").value) : Math.abs(pos.net_qty);
    const newType = row ? row.querySelector(".roll-type-select").value : pos.opt;
    const sign = pos.net_qty >= 0 ? 1 : -1;
    const newNetQty = isNaN(newAbsQty) ? pos.net_qty : sign * newAbsQty;
    const newDte = rollDteForExpiry(newExpCode);
    const T = Math.max(newDte, 0) / 365.25;
    const rollIvPct = pfLookupIv(newDte, newStrike) ?? pos.iv_pct;
    const sigma = rollIvPct / 100;
    const newMark = bsPrice(spot, newStrike, T, 0, sigma, newType);
    const curMark = pos.mark_price_usd ?? 0;
    const closeValue = pos.net_qty * curMark;
    const openValue = newNetQty * newMark;
    const cost = closeValue - openValue;

    const strikeChanged = newStrike !== pos.strike;
    const qtyChanged = newAbsQty !== Math.abs(pos.net_qty);
    const typeChanged = newType !== pos.opt;
    let dteImpact = cost, strikeImpact = 0, qtyImpact = 0, typeImpact = 0;
    if (strikeChanged || qtyChanged || typeChanged) {
      const dteIv = pfLookupIv(newDte, pos.strike) ?? pos.iv_pct;
      const dteOnlyMark = bsPrice(spot, pos.strike, T, 0, dteIv / 100, pos.opt);
      dteImpact = pos.net_qty * curMark - pos.net_qty * dteOnlyMark;
      const strikeOnlyMark = bsPrice(spot, newStrike, T, 0, sigma, pos.opt);
      strikeImpact = strikeChanged ? (pos.net_qty * dteOnlyMark - pos.net_qty * strikeOnlyMark) : 0;
      typeImpact = typeChanged ? (pos.net_qty * strikeOnlyMark - pos.net_qty * newMark) : 0;
      qtyImpact = cost - dteImpact - strikeImpact - typeImpact;
    }

    totalCloseValue += closeValue;
    totalOpenValue += openValue;
    totalRollCost += cost;
    results.push({ pos, newExpCode, newDte, newStrike, newNetQty, newType, curMark, newMark, rollIvPct,
      cost, closeValue, openValue, strikeChanged, qtyChanged, typeChanged,
      dteImpact, strikeImpact, qtyImpact, typeImpact });
  }
  sbRenderRollResults(results, totalCloseValue, totalOpenValue, totalRollCost, globalExpiry);
}

function sbRenderRollResults(results, totalCloseValue, totalOpenValue, totalRollCost, globalExpiry) {
  sbLastResults = results;
  document.getElementById("sb-roll-results-section").style.display = "block";

  document.getElementById("sb-legs-count").textContent = results.length;
  const globalDte = rollDteForExpiry(globalExpiry);
  document.getElementById("sb-target-dte-display").textContent = `${globalExpiry} (${globalDte}d)`;

  const fmtUsd = v => "$" + Math.abs(Math.round(v)).toLocaleString();
  const fmtCost = v => { const r = Math.round(v); return `<span class="${r >= 0 ? "mtm-pos" : "mtm-neg"}" style="font-family:monospace;font-weight:600">${r >= 0 ? "Rcv" : "Pay"} $${Math.abs(r).toLocaleString()}</span>`; };

  const $close = document.getElementById("sb-total-close");
  $close.textContent = (totalCloseValue >= 0 ? "" : "-") + fmtUsd(totalCloseValue);
  $close.className = "risk-value " + (totalCloseValue >= 0 ? "mtm-pos" : "mtm-neg");
  const $open = document.getElementById("sb-total-open");
  $open.textContent = (totalOpenValue >= 0 ? "" : "-") + fmtUsd(totalOpenValue);
  $open.className = "risk-value " + (totalOpenValue >= 0 ? "mtm-pos" : "mtm-neg");
  const rounded = Math.round(totalRollCost);
  const $net = document.getElementById("sb-net-cost");
  $net.textContent = (rounded >= 0 ? "" : "-") + fmtUsd(totalRollCost);
  $net.className = "risk-value " + (rounded >= 0 ? "mtm-pos" : "mtm-neg");
  const $dir = document.getElementById("sb-direction");
  $dir.textContent = rounded >= 0 ? "Net Receive" : "Net Pay";
  $dir.className = "risk-value " + (rounded >= 0 ? "mtm-pos" : "mtm-neg");

  const hasStrikeChange = results.some(r => r.strikeChanged);
  const hasQtyChange = results.some(r => r.qtyChanged);
  const hasTypeChange = results.some(r => r.typeChanged);
  const hasBreakdown = hasStrikeChange || hasQtyChange || hasTypeChange;

  const $thead = document.getElementById("sb-results-thead");
  let hdr = `<tr><th style="text-align:left">Instrument</th><th style="text-align:left">Side</th><th>Strike</th><th>Type</th><th>Qty</th><th>Cur DTE</th><th>New Expiry</th><th>Cur Mark</th><th>New Mark</th><th>IV Used</th>`;
  if (hasBreakdown) {
    hdr += `<th>DTE Impact</th>`;
    if (hasStrikeChange) hdr += `<th>Strike Impact</th>`;
    if (hasTypeChange) hdr += `<th>Type Impact</th>`;
    if (hasQtyChange) hdr += `<th>Qty Impact</th>`;
  }
  hdr += `<th>Total Cost</th></tr>`;
  $thead.innerHTML = hdr;

  const _sd = currentAsset === "FIL" ? 2 : 0;
  const fmtNum = (v, d=2) => v != null ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : "---";
  const $tbody = document.getElementById("sb-results-body");
  $tbody.innerHTML = "";
  let totalDteImpact = 0, totalStrikeImpact = 0, totalQtyImpact = 0, totalTypeImpact = 0;

  for (const r of results) {
    totalDteImpact += r.dteImpact; totalStrikeImpact += r.strikeImpact;
    totalQtyImpact += r.qtyImpact; totalTypeImpact += r.typeImpact || 0;
    const sideClass = r.pos.side === "Long" ? "qty-long" : "qty-short";
    const strikeLabel = r.strikeChanged ? `${fmtNum(r.pos.strike, _sd)} → ${fmtNum(r.newStrike, _sd)}` : fmtNum(r.pos.strike, _sd);
    const qtyLabel = r.qtyChanged ? `${fmtNum(r.pos.net_qty, 0)} → ${fmtNum(r.newNetQty, 0)}` : fmtNum(r.pos.net_qty, 0);
    const typeLabel = r.typeChanged ? `${r.pos.opt === "C" ? "Call" : "Put"} → ${r.newType === "C" ? "Call" : "Put"}` : (r.pos.opt === "C" ? "Call" : "Put");
    const typeColor = r.typeChanged ? "var(--accent)" : "inherit";
    let rowHtml = `<td style="text-align:left;font-size:.72rem">${r.pos.instrument}</td>` +
      `<td style="text-align:left" class="${sideClass}">${r.pos.side_raw}</td>` +
      `<td style="font-family:monospace">${strikeLabel}</td>` +
      `<td style="color:${typeColor}">${typeLabel}</td>` +
      `<td style="font-family:monospace">${qtyLabel}</td>` +
      `<td>${Math.round(r.pos.days_remaining)}d</td>` +
      `<td>${r.newExpCode} (${r.newDte}d)</td>` +
      `<td style="font-family:monospace">$${fmtNum(r.curMark)}</td>` +
      `<td style="font-family:monospace">$${fmtNum(r.newMark)}</td>` +
      `<td>${r.rollIvPct.toFixed(1)}%</td>`;
    if (hasBreakdown) {
      rowHtml += `<td>${fmtCost(r.dteImpact)}</td>`;
      if (hasStrikeChange) rowHtml += `<td>${r.strikeChanged ? fmtCost(r.strikeImpact) : '<span style="color:var(--muted)">—</span>'}</td>`;
      if (hasTypeChange) rowHtml += `<td>${r.typeChanged ? fmtCost(r.typeImpact) : '<span style="color:var(--muted)">—</span>'}</td>`;
      if (hasQtyChange) rowHtml += `<td>${r.qtyChanged ? fmtCost(r.qtyImpact) : '<span style="color:var(--muted)">—</span>'}</td>`;
    }
    rowHtml += `<td>${fmtCost(r.cost)}</td>`;
    const tr = document.createElement("tr"); tr.innerHTML = rowHtml; $tbody.appendChild(tr);
  }

  const $tfoot = document.getElementById("sb-results-foot");
  let footHtml = `<tr><td style="text-align:left;font-weight:700" colspan="5">TOTAL</td><td></td><td></td><td></td><td></td><td></td>`;
  if (hasBreakdown) {
    footHtml += `<td>${fmtCost(totalDteImpact)}</td>`;
    if (hasStrikeChange) footHtml += `<td>${fmtCost(totalStrikeImpact)}</td>`;
    if (hasTypeChange) footHtml += `<td>${fmtCost(totalTypeImpact)}</td>`;
    if (hasQtyChange) footHtml += `<td>${fmtCost(totalQtyImpact)}</td>`;
  }
  footHtml += `<td>${fmtCost(totalRollCost)}</td></tr>`;
  $tfoot.innerHTML = footHtml;

  sbDrawChart(results);
  sbRenderMtmGrid(results);
}

// ── Structure Builder ────────────────────────────────────

function sbAddLeg(side, type, strike, qty, expiry) {
  side = side || "buy";
  type = type || "C";
  const _spot = pfData ? (pfData.eth_spot || pfData.spot || 0) : (ethSpot || 0);
  const _step = _spot >= 100 ? 50 : _spot >= 10 ? 1 : 0.1;
  strike = strike || (_spot ? Math.round(_spot / _step) * _step : 0);
  qty = qty || 1000;
  expiry = expiry || sbGetTargetExpiry() || ((pfData ? pfData.vol_surface || [] : [])[0] || {}).expiry_code || "";
  sbLegs.push({ side, type, strike, qty, expiry });
  sbRenderLegs();
}

function sbRemoveLeg(idx) {
  sbLegs.splice(idx, 1);
  sbRenderLegs();
}

function sbRenderLegs() {
  const $tbody = document.getElementById("sb-legs-body");
  $tbody.innerHTML = "";
  const smiles = (pfData ? pfData.vol_surface || [] : []).filter(s => s.dte > 0).sort((a, b) => a.dte - b.dte);
  const expiryOpts = smiles.map(s => `<option value="${s.expiry_code}">${s.expiry_code} (${s.dte}d)</option>`).join("");

  sbLegs.forEach((leg, idx) => {
    const isPerp = leg.type === "PERP";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${isPerp ? '<span style="color:var(--muted)">N/A</span>' : `<select class="sb-leg-expiry" data-idx="${idx}">${expiryOpts}</select>`}</td>
      <td class="side-type-cell">
        <select class="sb-leg-side" data-idx="${idx}" style="width:48%">
          <option value="buy" ${leg.side === "buy" ? "selected" : ""}>Buy</option>
          <option value="sell" ${leg.side === "sell" ? "selected" : ""}>Sell</option></select>
        <select class="sb-leg-type" data-idx="${idx}" style="width:48%">
          <option value="C" ${leg.type === "C" ? "selected" : ""}>Call</option>
          <option value="P" ${leg.type === "P" ? "selected" : ""}>Put</option>
          <option value="PERP" ${leg.type === "PERP" ? "selected" : ""}>Perp</option></select>
      </td>
      <td><input type="number" class="sb-leg-strike" data-idx="${idx}" value="${leg.strike}" step="any" ${isPerp ? 'title="Entry price for perpetual"' : ""}></td>
      <td><input type="number" class="sb-leg-qty" data-idx="${idx}" value="${leg.qty}" step="100" min="1"></td>
      <td><button class="btn-remove sb-leg-remove" data-idx="${idx}">✕</button></td>`;
    $tbody.appendChild(tr);
    // Set expiry value after append (only for options, not perps)
    if (!isPerp) {
      const expSel = tr.querySelector(".sb-leg-expiry");
      if (expSel) expSel.value = leg.expiry;
    }
  });

  // Wire changes
  $tbody.querySelectorAll(".sb-leg-expiry").forEach(el => el.addEventListener("change", () => { sbLegs[el.dataset.idx].expiry = el.value; }));
  $tbody.querySelectorAll(".sb-leg-side").forEach(el => el.addEventListener("change", () => { sbLegs[el.dataset.idx].side = el.value; }));
  $tbody.querySelectorAll(".sb-leg-type").forEach(el => el.addEventListener("change", () => { sbLegs[el.dataset.idx].type = el.value; }));
  $tbody.querySelectorAll(".sb-leg-strike").forEach(el => el.addEventListener("change", () => { sbLegs[el.dataset.idx].strike = parseFloat(el.value) || 0; }));
  $tbody.querySelectorAll(".sb-leg-qty").forEach(el => el.addEventListener("change", () => { sbLegs[el.dataset.idx].qty = parseFloat(el.value) || 1; }));
  $tbody.querySelectorAll(".sb-leg-remove").forEach(el => el.addEventListener("click", () => sbRemoveLeg(parseInt(el.dataset.idx))));
}

function sbApplyTemplate(name) {
  sbLegs = [];
  const spot = pfData ? pfData.eth_spot : 2500;
  // Adaptive rounding: use a step size proportional to spot price
  const step = spot >= 100 ? 50 : spot >= 10 ? 1 : 0.1;
  const K = Math.round(spot / step) * step;
  const narrow = Math.round(spot * 0.08 / step) * step || step;  // ~8% offset
  const wide   = Math.round(spot * 0.20 / step) * step || step;  // ~20% offset
  const spread = Math.round(spot * 0.12 / step) * step || step;  // ~12% offset for strangle
  const exp = sbGetTargetExpiry() || ((pfData.vol_surface || [])[0] || {}).expiry_code || "";
  switch (name) {
    case "long_call":     sbLegs.push({ side: "buy", type: "C", strike: K, qty: 1000, expiry: exp }); break;
    case "long_put":      sbLegs.push({ side: "buy", type: "P", strike: K, qty: 1000, expiry: exp }); break;
    case "bull_call_spread":
      sbLegs.push({ side: "buy", type: "C", strike: K, qty: 1000, expiry: exp });
      sbLegs.push({ side: "sell", type: "C", strike: K + wide, qty: 1000, expiry: exp }); break;
    case "bear_put_spread":
      sbLegs.push({ side: "buy", type: "P", strike: K, qty: 1000, expiry: exp });
      sbLegs.push({ side: "sell", type: "P", strike: K - wide, qty: 1000, expiry: exp }); break;
    case "straddle":
      sbLegs.push({ side: "buy", type: "C", strike: K, qty: 1000, expiry: exp });
      sbLegs.push({ side: "buy", type: "P", strike: K, qty: 1000, expiry: exp }); break;
    case "strangle":
      sbLegs.push({ side: "buy", type: "C", strike: K + spread, qty: 1000, expiry: exp });
      sbLegs.push({ side: "buy", type: "P", strike: K - spread, qty: 1000, expiry: exp }); break;
    case "iron_condor":
      sbLegs.push({ side: "buy", type: "P", strike: K - wide, qty: 1000, expiry: exp });
      sbLegs.push({ side: "sell", type: "P", strike: K - narrow, qty: 1000, expiry: exp });
      sbLegs.push({ side: "sell", type: "C", strike: K + narrow, qty: 1000, expiry: exp });
      sbLegs.push({ side: "buy", type: "C", strike: K + wide, qty: 1000, expiry: exp }); break;
    case "long_perp":
      sbLegs.push({ side: "buy", type: "PERP", strike: spot, qty: 1000, expiry: "" }); break;
    case "short_perp":
      sbLegs.push({ side: "sell", type: "PERP", strike: spot, qty: 1000, expiry: "" }); break;
  }
  document.querySelectorAll(".sb-template").forEach(b => b.classList.remove("active"));
  const btn = document.querySelector(`.sb-template[data-strategy="${name}"]`);
  if (btn) btn.classList.add("active");
  sbRenderLegs();
  document.getElementById("sb-pricing-results").style.display = "none";
  document.getElementById("btn-sb-add-to-portfolio").style.display = "none";
  document.getElementById("btn-sb-send-to-exec").style.display = "none";
  sbLegsPriced = [];
  sbStructureCurves = null;
  sbDrawStructureChart();
}

// ── IV lookup by expiry code ─────────────────────────────

function sbLookupSmileIv(expiryCode, strike) {
  if (!pfData || !pfData.vol_surface) return null;
  const entry = pfData.vol_surface.find(s => s.expiry_code === expiryCode);
  if (!entry) return null;
  const { strikes, ivs } = entry;
  if (!strikes || strikes.length === 0) return null;
  if (strike <= strikes[0]) return ivs[0];
  if (strike >= strikes[strikes.length - 1]) return ivs[ivs.length - 1];
  for (let i = 0; i < strikes.length - 1; i++) {
    if (strike >= strikes[i] && strike <= strikes[i + 1]) {
      const t = (strike - strikes[i]) / (strikes[i + 1] - strikes[i]);
      return ivs[i] + t * (ivs[i + 1] - ivs[i]);
    }
  }
  return ivs[ivs.length - 1];
}

// ── Price structure via vol surface ──────────────────────

function sbPriceStructure() {
  if (!pfData) { alert("Portfolio data not loaded."); return; }
  if (sbLegs.length === 0) { alert("Add at least one leg."); return; }

  const spot = pfData.eth_spot;
  const spots = pfData.spot_ladder;
  const sbVolSpread = parseFloat(document.getElementById("sb-vol-spread").value) || 0;
  sbLegsPriced = [];
  let totalPay = 0, totalReceive = 0;

  for (const leg of sbLegs) {
    const dir = leg.side === "buy" ? 1 : -1;

    if (leg.type === "PERP") {
      // Perpetual: no premium, linear P&L from entry price (strike field = entry price)
      const entryPrice = leg.strike || spot;
      sbLegsPriced.push({
        ...leg, strike: entryPrice, dte: 0, ivPct: 0, sigma: 0,
        bsPremEth: 0, bsPremUsd: 0, dir, totalCost: 0,
      });
      continue;
    }

    const entry = pfData.vol_surface.find(s => s.expiry_code === leg.expiry);
    if (!entry) { alert(`No vol surface data for expiry ${leg.expiry}`); return; }
    const dte = entry.dte;
    const T = Math.max(dte, 0) / 365.25;
    let ivPct = sbLookupSmileIv(leg.expiry, leg.strike);
    if (ivPct == null) { alert(`Cannot interpolate IV for strike ${leg.strike} at ${leg.expiry}`); return; }
    const sigma = ivPct / 100;  // mid IV
    // Bid/ask premium centred on the mid premium, half-width = vega × spread
    // (see pricer note) — avoids the convexity blow-up that zeroed OTM sells.
    const premMid = bsPrice(spot, leg.strike, T, 0, sigma, leg.type);
    let bsPremEth = premMid;
    if (sbVolSpread > 0) {
      const vegaPt = Math.abs(bsPrice(spot, leg.strike, T, 0, (ivPct + 1) / 100, leg.type)
                            - bsPrice(spot, leg.strike, T, 0, Math.max(ivPct - 1, 1) / 100, leg.type)) / 2;
      const halfWidth = vegaPt * sbVolSpread;
      bsPremEth = leg.side === "buy" ? premMid + halfWidth : Math.max(premMid - halfWidth, 0);
    }
    if (isNaN(bsPremEth)) console.error("NaN from bsPrice:", { spot, strike: leg.strike, T, sigma, type: leg.type });
    const bsPremUsd = isNaN(bsPremEth) ? 0 : bsPremEth;
    const legCost = dir * leg.qty * bsPremUsd;
    if (legCost > 0) totalPay += legCost; else totalReceive += Math.abs(legCost);

    sbLegsPriced.push({
      ...leg, dte, ivPct, sigma, bsPremEth: bsPremEth / spot, bsPremUsd, dir,
      totalCost: legCost,
    });
  }

  // Show pricing results
  const $results = document.getElementById("sb-pricing-results");
  $results.style.display = "block";
  const net = totalReceive - totalPay;
  const sbSpreadNote = sbVolSpread > 0 ? ` &nbsp;|&nbsp; <span style="font-size:.7rem;color:var(--muted)">vol spread &plusmn;${sbVolSpread}pts</span>` : "";
  document.getElementById("sb-pricing-summary").innerHTML =
    `Pay <span class="mtm-neg" style="font-weight:600">$${Math.round(totalPay).toLocaleString()}</span> &nbsp;|&nbsp; ` +
    `Receive <span class="mtm-pos" style="font-weight:600">$${Math.round(totalReceive).toLocaleString()}</span> &nbsp;|&nbsp; ` +
    `Net: <span class="${net >= 0 ? 'mtm-pos' : 'mtm-neg'}" style="font-weight:600">${net >= 0 ? "Rcv" : "Pay"} $${Math.abs(Math.round(net)).toLocaleString()}</span>` + sbSpreadNote;

  const $tbody = document.getElementById("sb-premiums-body");
  $tbody.innerHTML = "";
  for (const lp of sbLegsPriced) {
    const isPerp = lp.type === "PERP";
    const typeLabel = isPerp ? "Perp" : (lp.type === "C" ? "Call" : "Put");
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td style="text-align:left">${isPerp ? "--" : lp.expiry}</td>` +
      `<td style="text-align:left;color:${lp.side === "buy" ? "var(--green)" : "var(--red)"}">${lp.side}</td>` +
      `<td>${typeLabel}</td>` +
      `<td style="font-family:monospace">${isPerp ? "$" + lp.strike.toLocaleString() : lp.strike.toLocaleString()}</td>` +
      `<td>${isPerp ? "--" : lp.dte + "d"}</td>` +
      `<td>${isPerp ? "--" : lp.ivPct.toFixed(1) + "%"}</td>` +
      `<td style="font-family:monospace">${lp.qty.toLocaleString()}</td>` +
      `<td style="font-family:monospace">${isPerp ? "$0" : "$" + fmtPrem(lp.bsPremUsd)}</td>` +
      `<td style="font-family:monospace;color:${lp.side === 'sell' ? 'var(--green)' : 'var(--red)'}">` +
        `${isPerp ? "$0" : "$" + fmtPremTotal(lp.qty * lp.bsPremUsd)}</td>`;
    $tbody.appendChild(tr);
  }

  // Compute standalone structure payoff curves
  sbStructureCurves = {};
  const allHorizons = pfData.chart_horizons || [0, 30, 60];
  for (const h of allHorizons) {
    sbStructureCurves[h] = sbComputeStructureCurve(spots, h);
  }

  // Show Add to Portfolio button
  document.getElementById("btn-sb-add-to-portfolio").style.display = "block";
  document.getElementById("btn-sb-send-to-exec").style.display = "block";

  // Draw standalone structure chart only — net payoff & matrix update on "Add to Portfolio"
  sbDrawStructureChart();
}

// ── Compute structure curve ──────────────────────────────

function sbComputeStructureCurve(spots, horizon) {
  const result = new Array(spots.length).fill(0);
  if (!sbLegsPriced || sbLegsPriced.length === 0) return result;
  for (const lp of sbLegsPriced) {
    if (lp.type === "PERP") {
      // Perpetual: linear P&L = direction * qty * (spot - entry_price)
      // No time decay, no expiry — same payoff at all horizons
      for (let i = 0; i < spots.length; i++) {
        result[i] += lp.dir * lp.qty * (spots[i] - lp.strike);
      }
    } else {
      const T = Math.max(lp.dte - horizon, 0) / 365.25;
      for (let i = 0; i < spots.length; i++) {
        const val = bsPrice(spots[i], lp.strike, T, 0, lp.sigma, lp.type);
        result[i] += lp.dir * lp.qty * val;
      }
    }
  }
  // Subtract entry cost to show P&L not mark value
  const entryCost = sbLegsPriced.reduce((s, lp) => s + lp.totalCost, 0);
  for (let i = 0; i < result.length; i++) result[i] -= entryCost;
  return result;
}

// ── Add structure to portfolio ───────────────────────────

async function sbAddToPortfolio() {
  if (!sbLegsPriced || sbLegsPriced.length === 0) { alert("Price the structure first."); return; }

  const btn = document.getElementById("btn-sb-add-to-portfolio");
  btn.disabled = true;
  btn.textContent = "Adding...";

  try {
    for (const lp of sbLegsPriced) {
      const sign = lp.side === "sell" ? -1 : 1;
      const signedQty = sign * lp.qty;
      const spots = pfData.spot_ladder;
      const allHorizons = pfData.all_horizons;

      if (lp.type === "PERP") {
        // Perpetual position: linear payoff at all horizons
        const entryPrice = lp.strike;
        const spot = pfData.eth_spot;
        const payoff = {};
        for (const h of allHorizons) {
          payoff[String(h)] = spots.map(s => Math.round(signedQty * (s - entryPrice) * 100) / 100);
        }
        const markUsd = spot - entryPrice;  // current unrealized P&L per unit

        const newPos = {
          id: pfNextId++,
          counterparty: "Structure",
          trade_id: null,
          trade_date: new Date().toISOString().split("T")[0],
          side_raw: lp.side === "sell" ? "Sell" : "Buy",
          option_type: "Perpetual",
          instrument: `${currentAsset}-PERPETUAL`,
          expiry: "",
          days_remaining: 0,
          strike: entryPrice,
          pct_otm_entry: 0,
          qty: lp.qty,
          notional_mm: 0,
          premium_per: 0,
          premium_usd: 0,
          opt: "PERP",
          side: sign > 0 ? "Long" : "Short",
          net_qty: signedQty,
          pct_otm_live: 0,
          iv_pct: 0,
          delta: sign, gamma: 0, theta: 0, vega: 0,
          mark_price_usd: Math.abs(markUsd),
          current_mtm: Math.round(signedQty * markUsd * 100) / 100,
          notional_live: Math.round(lp.qty * spot * 100) / 100,
          payoff_by_horizon: payoff,
        };

        pfData.positions.push(newPos);
        pfSelected.add(newPos.id);
        sbIncluded.add(newPos.id);
        continue;
      }

      // Options leg
      const instrument = `${currentAsset}-${lp.expiry}-${lp.strike}-${lp.type}`;
      let tk;
      try {
        tk = await get(`/api/portfolio/ticker/${encodeURIComponent(instrument)}`);
      } catch (e) {
        tk = { mark_price_usd: lp.bsPremUsd, mark_iv: lp.ivPct, opt: lp.type, strike: lp.strike,
          days_remaining: lp.dte, expiry: "", delta: null, gamma: null, theta: null, vega: null };
      }

      const markUsd = tk.mark_price_usd || lp.bsPremUsd;
      const sigma = (tk.mark_iv || lp.ivPct) / 100;
      const opt = tk.opt || lp.type;
      const strike = tk.strike || lp.strike;
      const dte = tk.days_remaining || lp.dte;
      const payoff = {};
      for (const h of allHorizons) {
        const T = Math.max(dte - h, 0) / 365.25;
        const vals = bsVec(spots, strike, T, 0, sigma, opt);
        payoff[String(h)] = vals.map(v => Math.round(signedQty * v * 100) / 100);
      }

      const newPos = {
        id: pfNextId++,
        counterparty: "Structure",
        trade_id: null,
        trade_date: new Date().toISOString().split("T")[0],
        side_raw: lp.side === "sell" ? "Sell" : "Buy",
        option_type: opt === "C" ? "Call" : "Put",
        instrument,
        expiry: tk.expiry || "",
        days_remaining: dte,
        strike,
        pct_otm_entry: 0,
        qty: lp.qty,
        notional_mm: 0,
        premium_per: lp.bsPremUsd,
        premium_usd: lp.totalCost,
        opt,
        side: sign > 0 ? "Long" : "Short",
        net_qty: signedQty,
        pct_otm_live: pfData.eth_spot > 0 ? Math.round((strike / pfData.eth_spot - 1) * 1000) / 10 : 0,
        iv_pct: tk.mark_iv || lp.ivPct,
        delta: tk.delta, gamma: tk.gamma, theta: tk.theta, vega: tk.vega,
        mark_price_usd: markUsd,
        current_mtm: Math.round(signedQty * markUsd * 100) / 100,
        notional_live: Math.round(lp.qty * pfData.eth_spot * 100) / 100,
        payoff_by_horizon: payoff,
      };

      pfData.positions.push(newPos);
      pfSelected.add(newPos.id);
      sbIncluded.add(newPos.id);
    }

    // Clear structure builder state (but keep sbOriginalPositionIds for before/after)
    const addedCount = sbLegsPriced.length;
    sbLegs = [];
    sbLegsPriced = [];
    sbStructureCurves = null;
    document.getElementById("sb-pricing-results").style.display = "none";
    btn.style.display = "none";
    document.querySelectorAll(".sb-template").forEach(b => b.classList.remove("active"));

    sbRenderTable();
    sbRenderLegs();
    sbDrawStructureChart();  // redraw as empty placeholder
    sbRefreshVisuals();
    alert(`Added ${addedCount} leg${addedCount !== 1 ? "s" : ""} to portfolio.`);
  } catch (e) {
    console.error("Failed to add structure:", e);
    alert("Failed to add structure to portfolio.\n" + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Add Structure to Portfolio";
  }
}

// ── Standalone structure payoff chart ─────────────────────

function sbDrawStructureChart() {
  const spots = pfData ? pfData.spot_ladder : [];
  const spot = pfData ? pfData.eth_spot : 0;
  const horizons = pfData ? pfData.chart_horizons : [];
  const colors = ["#f85149", "#d29922", "#e3b341", "#3fb950", "#58a6ff", "#bc8cff"];
  const hasData = sbStructureCurves && Object.keys(sbStructureCurves).length > 0;
  const traces = [];

  if (hasData) {
    horizons.forEach((h, i) => {
      const curve = sbStructureCurves[h];
      if (curve) {
        traces.push({
          x: spots, y: curve, type: "scatter", mode: "lines",
          name: h === 0 ? "At Expiry" : `T+${h}d`,
          line: { color: colors[i % colors.length], width: 2.5 }
        });
      }
    });

    // Spot marker
    const allY = traces.flatMap(t => t.y);
    if (allY.length > 0) {
      traces.push({
        x: [spot, spot], y: [Math.min(...allY), Math.max(...allY)],
        type: "scatter", mode: "lines",
        name: `Spot $${fmtSpot(spot)}`,
        line: { color: "#3fb950", width: 1.5, dash: "dashdot" }
      });
    }

    // Break-even lines
    const expiryCurve = sbStructureCurves[0];
    if (expiryCurve && allY.length > 0) {
      const yMin = Math.min(...allY), yMax = Math.max(...allY);
      for (let i = 0; i < expiryCurve.length - 1; i++) {
        if ((expiryCurve[i] <= 0 && expiryCurve[i + 1] > 0) || (expiryCurve[i] >= 0 && expiryCurve[i + 1] < 0)) {
          const t = Math.abs(expiryCurve[i]) / (Math.abs(expiryCurve[i]) + Math.abs(expiryCurve[i + 1]));
          const beSpot = spots[i] + t * (spots[i + 1] - spots[i]);
          traces.push({
            x: [beSpot, beSpot], y: [yMin * 0.3, yMax * 0.3],
            type: "scatter", mode: "lines+text",
            name: `BE $${fmtSpot(beSpot)}`,
            text: [null, `BE $${fmtSpot(beSpot)}`],
            textposition: "top center",
            textfont: { color: "#d29922", size: 10 },
            line: { color: "#d29922", width: 1, dash: "dot" },
            showlegend: false,
          });
        }
      }
    }
  }

  const annotation = hasData ? [] : [{
    text: "Select a strategy and click<br><b>Price via Vol Surface</b>",
    xref: "paper", yref: "paper", x: 0.5, y: 0.5,
    showarrow: false,
    font: { size: 14, color: "#484f58" },
  }];

  const cc = chartColors();
  Plotly.react("sb-structure-chart", traces, {
    paper_bgcolor: cc.paper, plot_bgcolor: cc.plot,
    xaxis: {
      title: hasData ? currentAsset + " Spot (USD) — log scale" : "",
      type: "log",
      color: cc.muted, gridcolor: cc.grid, zerolinecolor: cc.zeroline,
      showticklabels: hasData,
    },
    yaxis: {
      title: hasData ? "P&L (USD)" : "",
      color: cc.muted, gridcolor: cc.grid,
      zerolinecolor: hasData ? "#f85149" : cc.grid,
      zerolinewidth: hasData ? 2 : 1,
      showticklabels: hasData,
    },
    annotations: annotation,
    margin: { t: 15, r: 25, b: hasData ? 45 : 20, l: hasData ? 70 : 30 },
    showlegend: hasData,
    legend: { font: { color: cc.muted, size: 10 }, orientation: "h", x: 0.5, y: 1.02,
      xanchor: "center", yanchor: "bottom", bgcolor: cc.legendBg },
  }, { responsive: true });
}

// ── Portfolio payoff chart (mirrors Roll tab pattern) ─────

function sbDrawChart(results) {
  const $chart = document.getElementById("sb-payoff-chart");
  const $controls = document.getElementById("sb-chart-controls");
  $chart.style.display = "block";

  const spots = pfData.spot_ladder;
  const horizons = pfData.chart_horizons;
  const spot = pfData.eth_spot;
  const hasRolls = results && results.length > 0;
  const rollMap = hasRolls ? rollBuildRollMap(results) : new Map();
  const allPositions = pfData.positions;
  const includedPositions = allPositions.filter(p => sbIncluded.has(p.id));
  const hasExclusion = allPositions.some(p => !sbIncluded.has(p.id)) || sbRemovedPositions.length > 0;
  const hasNewPositions = sbOriginalPositionIds && allPositions.some(p => !sbOriginalPositionIds.has(p.id));
  const hasScenarioChange = hasRolls || hasExclusion || hasNewPositions;

  // Show toggle controls only when there's a scenario to compare
  $controls.style.display = hasScenarioChange ? "block" : "none";
  const showBaseline = hasScenarioChange ? document.getElementById("sb-show-baseline").checked : true;
  const showScenario = hasScenarioChange ? document.getElementById("sb-show-scenario").checked : false;

  // Baseline = original portfolio (including positions that were removed)
  const baselinePositions = [...allPositions, ...sbRemovedPositions]
    .filter(p => sbOriginalPositionIds.has(p.id));

  const baseColors = ["#f85149", "#d29922", "#e3b341", "#3fb950", "#58a6ff", "#bc8cff"];
  const scenColors = ["#ff7b72", "#e3b341", "#f0d060", "#56d364", "#79c0ff", "#d2a8ff"];
  const traces = [];

  // Baseline portfolio payoff curves (always shown when no scenario, toggled otherwise)
  if (!hasScenarioChange || showBaseline) {
    horizons.forEach((h, i) => {
      const baseCurve = rollBaselineCurve(spots, baselinePositions, h);
      const label = h === 0 ? "Expiry" : `T+${h}d`;
      traces.push({
        x: spots, y: baseCurve, type: "scatter", mode: "lines",
        name: hasScenarioChange ? `Base ${label}` : label,
        line: { color: baseColors[i % baseColors.length], width: 2.5 },
        legendgroup: `h${h}`,
      });
    });
  }

  // Overlay scenario curves when toggled on
  if (hasScenarioChange && showScenario) {
    horizons.forEach((h, i) => {
      const scenCurve = rollSumCurve(spots, includedPositions, h, rollMap);
      const label = h === 0 ? "Expiry" : `T+${h}d`;
      traces.push({
        x: spots, y: scenCurve, type: "scatter", mode: "lines",
        name: `Scenario ${label}`,
        line: { color: scenColors[i % scenColors.length], width: 2.5, dash: "dash" },
        legendgroup: `h${h}`,
      });
    });
  }

  // Spot marker
  const allY = traces.flatMap(t => t.y);
  if (allY.length > 0) {
    traces.push({
      x: [spot, spot], y: [Math.min(...allY), Math.max(...allY)],
      type: "scatter", mode: "lines", name: `Spot $${fmtSpot(spot)}`,
      line: { color: "#3fb950", width: 1.5, dash: "dashdot" }, legendgroup: "spot",
    });
  }

  // Dynamic title
  let titleText = "Portfolio Payoff Profile";
  if (hasScenarioChange) {
    const parts = [];
    if (hasNewPositions) parts.push("New Trades");
    if (hasRolls) parts.push("Rolls");
    if (hasExclusion) parts.push("Removals");
    titleText += ` — Base vs Scenario (${parts.join(" + ")})`;
  }

  const cc = chartColors();
  Plotly.react("sb-payoff-chart", traces, {
    title: { text: titleText, font: { color: cc.text, size: 16 } },
    paper_bgcolor: cc.paper, plot_bgcolor: cc.plot,
    xaxis: { title: currentAsset + " Spot Price (USD) — log scale", type: "log", color: cc.muted, gridcolor: cc.grid, zerolinecolor: cc.zeroline },
    yaxis: { title: "P&L (USD)", color: cc.muted, gridcolor: cc.grid, zerolinecolor: "#f85149", zerolinewidth: 2 },
    margin: { t: 50, r: 250, b: 50, l: 80 },
    showlegend: true,
    legend: { font: { color: cc.muted, size: 10 }, orientation: "v", x: 1.02, y: 1,
      xanchor: "left", yanchor: "top", bgcolor: cc.legendBg, bordercolor: cc.legendBorder, borderwidth: 1 },
  }, { responsive: true });
}

// ── MTM Grid (Base vs Scenario — mirrors Roll tab) ───────

function sbRenderMtmGrid(results) {
  const $section = document.getElementById("sb-mtm-section");
  $section.style.display = "block";
  const spots = pfData.spot_ladder;
  const horizons = pfData.matrix_horizons;
  const ethSpot = pfData.eth_spot;
  const allPositions = pfData.positions;
  const includedPositions = allPositions.filter(p => sbIncluded.has(p.id));
  const hasRolls = results && results.length > 0;
  const hasExclusion = allPositions.some(p => !sbIncluded.has(p.id)) || sbRemovedPositions.length > 0;
  const hasNewPositions = sbOriginalPositionIds && allPositions.some(p => !sbOriginalPositionIds.has(p.id));
  const hasScenarioChange = hasRolls || hasExclusion || hasNewPositions;
  const rollMap = hasRolls ? rollBuildRollMap(results) : new Map();

  // Baseline = original portfolio including removed positions
  const baselinePositions = [...allPositions, ...sbRemovedPositions]
    .filter(p => sbOriginalPositionIds.has(p.id));

  // Update section title based on whether there's a scenario
  const $title = $section.querySelector("h2");
  $title.innerHTML = hasScenarioChange
    ? "Portfolio MTM Matrix &mdash; Base vs Scenario"
    : "Portfolio MTM Matrix";

  const scenLabel = hasNewPositions
    ? (hasRolls ? "Rolled+New" : "With New")
    : (hasRolls ? "Rolled" : "Selected");

  // Header (same pattern as Roll tab: Base | Scenario)
  const thead = document.getElementById("sb-mtm-grid-thead");
  if (hasScenarioChange) {
    let hdrHtml = `<tr><th rowspan="2" style="text-align:left">Spot</th>`;
    for (const h of horizons) hdrHtml += `<th colspan="2">${h}d</th>`;
    hdrHtml += `</tr><tr>`;
    for (const h of horizons) hdrHtml += `<th class="roll-mtm-base-hdr">Base</th><th class="roll-mtm-rolled-hdr">${scenLabel}</th>`;
    hdrHtml += `</tr>`;
    thead.innerHTML = hdrHtml;
  } else {
    thead.innerHTML = `<tr><th style="text-align:left">Spot</th>${horizons.map(h => `<th>${h}d</th>`).join("")}</tr>`;
  }

  // Pick spots at $500 increments
  const displaySpots = [];
  for (let s = 500; s <= 7000; s += 500) {
    const idx = spots.indexOf(s);
    if (idx !== -1) displaySpots.push({ spot: s, idx });
  }
  displaySpots.reverse();

  let closestSpot = displaySpots[0]?.spot ?? 0;
  let closestDiff = Infinity;
  for (const ds of displaySpots) {
    const diff = Math.abs(ds.spot - ethSpot);
    if (diff < closestDiff) { closestDiff = diff; closestSpot = ds.spot; }
  }

  // Pre-compute curves: baseline = original portfolio, scenario = included + rolls
  const baseCurves = {}, scenCurves = {};
  for (const h of horizons) {
    baseCurves[h] = rollBaselineCurve(spots, baselinePositions, h);
    if (hasScenarioChange) {
      scenCurves[h] = rollSumCurve(spots, includedPositions, h, rollMap);
    }
  }

  const fmtVal = v => { const r = Math.round(v); return r >= 0 ? `$${r.toLocaleString()}` : `-$${Math.abs(r).toLocaleString()}`; };

  const tbody = document.getElementById("sb-mtm-grid-body");
  let html = "";
  for (const { spot, idx } of displaySpots) {
    const isSpotRow = spot === closestSpot;
    html += `<tr class="${isSpotRow ? "roll-mtm-spot-row" : ""}">`;
    html += `<td style="text-align:left;font-weight:600;white-space:nowrap">$${spot.toLocaleString()}</td>`;
    for (const h of horizons) {
      const base = baseCurves[h][idx];
      const baseCls = base >= 0 ? "mtm-pos" : "mtm-neg";
      if (hasScenarioChange) {
        const scen = scenCurves[h][idx];
        const scenCls = scen >= 0 ? "mtm-pos" : "mtm-neg";
        html += `<td class="${baseCls} roll-mtm-base-cell">${fmtVal(base)}</td>`;
        html += `<td class="${scenCls} roll-mtm-rolled-cell">${fmtVal(scen)}</td>`;
      } else {
        html += `<td class="${baseCls}">${fmtVal(base)}</td>`;
      }
    }
    html += "</tr>";
  }
  tbody.innerHTML = html;
}

function sbRefreshVisuals() {
  sbDrawChart(sbLastResults);
  sbRenderMtmGrid(sbLastResults);
}

// ── Event wiring ─────────────────────────────────────────

document.getElementById("btn-sb-compute").addEventListener("click", sbComputeRoll);

document.getElementById("btn-sb-delete-selected").addEventListener("click", () => {
  if (!pfData) return;
  const ids = [...sbSelected];
  if (ids.length === 0) { alert("Select at least one trade to delete."); return; }
  if (!confirm(`Delete ${ids.length} selected trade${ids.length !== 1 ? "s" : ""} from portfolio?`)) return;
  for (const id of ids) {
    const idx = pfData.positions.findIndex(p => p.id === id);
    if (idx !== -1) {
      sbRemovedPositions.push(pfData.positions[idx]);
      pfData.positions.splice(idx, 1);
    }
    sbIncluded.delete(id);
    sbSelected.delete(id);
    pfSelected.delete(id);
  }
  sbRenderTable();
  sbRefreshVisuals();
});

document.getElementById("btn-sb-select-all").addEventListener("click", () => {
  sbGetFilteredPositions().forEach(p => sbSelected.add(p.id));
  sbRenderTable();
});

document.getElementById("btn-sb-deselect-all").addEventListener("click", () => {
  sbSelected.clear();
  sbLastResults = null;
  sbRenderTable();
  document.getElementById("sb-roll-results-section").style.display = "none";
  sbRefreshVisuals();
});

document.getElementById("sb-check-all").addEventListener("change", (e) => {
  sbGetFilteredPositions().forEach(p => {
    if (e.target.checked) sbSelected.add(p.id); else sbSelected.delete(p.id);
  });
  sbRenderTable();
});

document.getElementById("sb-include-all").addEventListener("change", (e) => {
  sbGetFilteredPositions().forEach(p => {
    if (e.target.checked) sbIncluded.add(p.id); else sbIncluded.delete(p.id);
  });
  sbRenderTable();
  sbRefreshVisuals();
});

document.getElementById("btn-sb-expiring-10d").addEventListener("click", () => {
  if (!pfData) return;
  sbSelected.clear();
  pfData.positions.forEach(p => { if (p.days_remaining <= 10) sbSelected.add(p.id); });
  sbRenderTable();
});

["sb-filter-counterparty", "sb-filter-expiry", "sb-filter-type", "sb-filter-side"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => { if (pfData) sbRenderTable(); });
});

document.getElementById("sb-target-expiry").addEventListener("change", () => { if (pfData) sbRenderTable(); });

// Sort headers
document.querySelectorAll("#sb-trades-table .sortable").forEach(th => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    const existing = sbSortStack.findIndex(s => s.col === col);
    if (existing === 0) {
      sbSortStack[0].asc = !sbSortStack[0].asc;
    } else {
      if (existing > 0) sbSortStack.splice(existing, 1);
      sbSortStack.unshift({ col, asc: true });
      if (sbSortStack.length > 2) sbSortStack.length = 2;
    }
    sbRenderTable();
  });
});

// Chart toggles
["sb-show-baseline", "sb-show-scenario"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => sbRefreshVisuals());
});

// Refresh
document.getElementById("btn-sb-refresh").addEventListener("click", async () => {
  sbLoaded = false;
  pfData = null;
  portfolioLoaded = false;
  sbSelected.clear();
  sbLastResults = null;
  sbStructureCurves = null;
  sbLegsPriced = [];
  document.getElementById("sb-roll-results-section").style.display = "none";
  document.getElementById("sb-pricing-results").style.display = "none";
  document.getElementById("btn-sb-add-to-portfolio").style.display = "none";
  document.getElementById("btn-sb-send-to-exec").style.display = "none";
  await sbInit();
});

// Add Trade form
document.getElementById("btn-sb-add-trade").addEventListener("click", () => {
  const $form = document.getElementById("sb-add-trade-form");
  $form.style.display = $form.style.display === "none" ? "block" : "none";
  if ($form.style.display === "block") {
    if (pfData) {
      const $cp = document.getElementById("sb-add-counterparty");
      const existing = new Set();
      pfData.positions.forEach(p => { if (p.counterparty) existing.add(p.counterparty); });
      existing.add("What-If");
      const prev = $cp.value;
      $cp.innerHTML = [...existing].sort().map(c =>
        `<option value="${c}" ${c === prev ? "selected" : ""}>${c}</option>`
      ).join("");
    }
    document.getElementById("sb-add-instrument").focus();
  }
});

document.getElementById("btn-sb-add-cancel").addEventListener("click", () => {
  document.getElementById("sb-add-trade-form").style.display = "none";
});

document.getElementById("btn-sb-add-confirm").addEventListener("click", () => {
  const instrument = document.getElementById("sb-add-instrument").value.trim().toUpperCase();
  if (!instrument) { alert("Enter an instrument name."); return; }
  const counterparty = document.getElementById("sb-add-counterparty").value;
  const side = document.getElementById("sb-add-side").value;
  const qty = parseFloat(document.getElementById("sb-add-qty").value) || 0;
  const premUsd = parseFloat(document.getElementById("sb-add-premium").value) || 0;
  if (qty <= 0) { alert("Quantity must be positive."); return; }
  if (!pfData) { alert("Portfolio data not loaded yet."); return; }

  get(`/api/portfolio/ticker/${encodeURIComponent(instrument)}`)
    .then(tk => {
      const sign = side === "sell" ? -1 : 1;
      const signedQty = sign * qty;
      const markUsd = tk.mark_price_usd || 0;
      const sigma = (tk.mark_iv || 80) / 100;
      const opt = tk.opt || "C";
      const strike = tk.strike || 0;
      const dte = tk.days_remaining || 0;
      const spots = pfData.spot_ladder;
      const allHorizons = pfData.all_horizons;
      const payoff = {};
      for (const h of allHorizons) {
        const T = Math.max(dte - h, 0) / 365.25;
        const vals = bsVec(spots, strike, T, 0, sigma, opt);
        payoff[String(h)] = vals.map(v => Math.round(signedQty * v * 100) / 100);
      }
      const newPos = {
        id: pfNextId++, counterparty, trade_id: null,
        trade_date: new Date().toISOString().split("T")[0],
        side_raw: side === "sell" ? "Sell" : "Buy",
        option_type: opt === "C" ? "Call" : "Put",
        instrument, expiry: tk.expiry || "", days_remaining: dte, strike,
        pct_otm_entry: 0, qty, notional_mm: 0, premium_per: premUsd / qty, premium_usd: premUsd,
        opt, side: sign > 0 ? "Long" : "Short", net_qty: signedQty,
        pct_otm_live: pfData.eth_spot > 0 ? Math.round((strike / pfData.eth_spot - 1) * 1000) / 10 : 0,
        iv_pct: tk.mark_iv || 80, delta: tk.delta, gamma: tk.gamma, theta: tk.theta, vega: tk.vega,
        mark_price_usd: markUsd, current_mtm: Math.round(signedQty * markUsd * 100) / 100,
        notional_live: Math.round(qty * pfData.eth_spot * 100) / 100,
        payoff_by_horizon: payoff,
      };
      pfData.positions.push(newPos);
      pfSelected.add(newPos.id);
      sbIncluded.add(newPos.id);
      sbRenderTable();
      sbRefreshVisuals();
      document.getElementById("sb-add-trade-form").style.display = "none";
      document.getElementById("sb-add-instrument").value = "";
    })
    .catch(e => { alert("Failed to fetch instrument data.\n" + e.message); });
});

// Structure builder
document.getElementById("btn-sb-add-leg").addEventListener("click", () => sbAddLeg());
document.getElementById("btn-sb-price-structure").addEventListener("click", sbPriceStructure);
document.getElementById("sb-vol-spread").addEventListener("input", () => updateVolSpreadHint("sb-vol-spread", "sb-vol-spread-hint"));
updateVolSpreadHint("sb-vol-spread", "sb-vol-spread-hint");
document.getElementById("btn-sb-add-to-portfolio").addEventListener("click", sbAddToPortfolio);

document.querySelectorAll(".sb-template").forEach(btn => {
  btn.addEventListener("click", () => sbApplyTemplate(btn.dataset.strategy));
});

// Structure toggle
document.getElementById("sb-structure-toggle").addEventListener("click", () => {
  const $body = document.getElementById("sb-structure-body");
  const $icon = document.getElementById("sb-structure-toggle-icon");
  $body.classList.toggle("collapsed");
  $icon.textContent = $body.classList.contains("collapsed") ? "[ + ]" : "[ - ]";
});

// Export
document.getElementById("btn-sb-export-xlsx").addEventListener("click", () => {
  if (!pfData) return;
  const positions = pfData.positions.filter(p => sbIncluded.has(p.id));
  const globalExpiry = sbGetTargetExpiry();
  const rows = [];
  for (const pos of positions) {
    const isRolled = sbSelected.has(pos.id) && sbLastResults && sbLastResults.some(r => r.pos.id === pos.id);
    const result = isRolled ? sbLastResults.find(r => r.pos.id === pos.id) : null;
    rows.push({
      "Include": sbIncluded.has(pos.id) ? "Yes" : "",
      "Roll": isRolled ? "Yes" : "",
      "Instrument": pos.instrument,
      "Buy/Sell": pos.side_raw,
      "Type": pos.option_type,
      "Strike": pos.strike,
      "Expiry": pos.expiry,
      "DTE": Math.round(pos.days_remaining),
      "Net Qty": pos.net_qty,
      "Cur Mark": pos.mark_price_usd != null ? Math.round(pos.mark_price_usd * 100) / 100 : null,
      "IV%": pos.iv_pct,
      "MTM": pos.current_mtm != null ? Math.round(pos.current_mtm) : null,
      "New Expiry": result ? result.newExpCode : null,
      "New Strike": result ? result.newStrike : null,
      "New Qty": result ? result.newNetQty : null,
      "New Mark": result ? Math.round(result.newMark * 100) / 100 : null,
      "Roll Cost": result ? Math.round(result.cost) : null,
      "Direction": result ? (result.cost >= 0 ? "Receive" : "Pay") : "",
    });
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Strategy Builder");
  const dateStr = new Date().toISOString().split("T")[0];
  XLSX.writeFile(wb, `PLGO_Strategy_Builder_${dateStr}.xlsx`);
});

// ═══════════════════════════════════════════════════════════
// ═══  EXECUTION PAGE  ═════════════════════════════════════
// ═══════════════════════════════════════════════════════════

let execOrders = [];    // orders staged for execution
let execLog = [];       // execution history
let execSelected = new Set();
let execLoaded = false;

async function execInit() {
  if (execLoaded) return;
  execLoaded = true;
  await execCheckStatus();
  execRenderOrders();
}

async function execCheckStatus() {
  try {
    const status = await get("/api/execution/status");
    const $env = document.getElementById("exec-env");
    $env.textContent = status.environment;
    $env.style.color = status.environment === "PRODUCTION" ? "var(--red)" : "var(--green)";

    const $auth = document.getElementById("exec-auth-status");
    if (status.authenticated) {
      $auth.textContent = "Connected";
      $auth.className = "risk-value mtm-pos";
      if (status.account) {
        document.getElementById("exec-balance").textContent = (status.account.balance || 0).toFixed(4);
        document.getElementById("exec-equity").textContent = (status.account.equity || 0).toFixed(4);
        document.getElementById("exec-available").textContent = (status.account.available_funds || 0).toFixed(4);
      }
      document.getElementById("exec-auth-error").style.display = "none";
    } else {
      $auth.textContent = "Not Connected";
      $auth.className = "risk-value mtm-neg";
      const $err = document.getElementById("exec-auth-error");
      $err.textContent = status.error || "Not configured";
      $err.style.display = "block";
    }
  } catch (e) {
    document.getElementById("exec-auth-status").textContent = "Error";
    document.getElementById("exec-auth-status").className = "risk-value mtm-neg";
  }
}

// Send priced legs from Strategy Builder to Execution
function execSendFromBuilder(pricedLegs) {
  for (const lp of pricedLegs) {
    const instrument = lp.type === "PERP" ? "ETH-PERPETUAL" : `ETH-${lp.expiry}-${lp.strike}-${lp.type}`;
    execOrders.push({
      id: Date.now() + Math.random(),
      instrument: instrument,
      side: lp.side,
      opt: lp.type,
      strike: lp.strike,
      qty: lp.qty,
      order_type: "limit",
      price: null,  // will be filled from order book
      best_bid: null,
      best_ask: null,
      mark: null,
      status: "pending",
      order_id: null,
    });
  }
  execRenderOrders();
  // Switch to Execution sub-tab within Strategy Builder
  const parent = document.getElementById("page-structurer");
  parent.querySelectorAll(".sub-tab-btn").forEach(b => b.classList.remove("active"));
  parent.querySelectorAll(".sub-tab-pane").forEach(p => p.classList.remove("active"));
  const execBtn = parent.querySelector('.sub-tab-btn[data-subtab="sb-execution"]');
  if (execBtn) execBtn.classList.add("active");
  document.getElementById("subtab-sb-execution").classList.add("active");
  execCheckStatus();
  execRefreshBooks();
}

async function execRefreshBooks() {
  for (const order of execOrders) {
    if (order.status !== "pending") continue;
    try {
      const book = await get(`/api/execution/orderbook/${encodeURIComponent(order.instrument)}`);
      order.best_bid = book.best_bid;
      order.best_ask = book.best_ask;
      order.mark = book.mark_price;
      // Auto-set limit price: buy at ask, sell at bid
      if (!order.price) {
        order.price = order.side === "buy" ? book.best_ask : book.best_bid;
      }
    } catch (e) {
      // ignore — will show as '--'
    }
  }
  execRenderOrders();
}

function execRenderOrders() {
  document.getElementById("exec-order-count").textContent = `(${execOrders.length})`;
  const $tbody = document.getElementById("exec-orders-body");
  $tbody.innerHTML = "";

  const allChecked = execOrders.length > 0 && execOrders.filter(o => o.status === "pending").every(o => execSelected.has(o.id));
  document.getElementById("exec-check-all").checked = allChecked;

  let totalCost = 0;
  for (const order of execOrders) {
    const isSelected = execSelected.has(order.id);
    const isPending = order.status === "pending";
    const sideColor = order.side === "buy" ? "var(--green)" : "var(--red)";
    const typeLabel = order.opt === "PERP" ? "Perp" : (order.opt === "C" ? "Call" : "Put");

    const spotPrice = order.price || 0;
    if (isPending && spotPrice > 0) {
      totalCost += (order.side === "buy" ? 1 : -1) * spotPrice * order.qty;
    }

    const statusCls = order.status === "filled" ? "mtm-pos" : order.status === "failed" ? "mtm-neg" : "";
    const tr = document.createElement("tr");
    if (isSelected) tr.classList.add("roll-row-selected");
    tr.innerHTML =
      `<td><input type="checkbox" class="exec-check" data-id="${order.id}" ${isSelected ? "checked" : ""} ${!isPending ? "disabled" : ""}></td>` +
      `<td style="text-align:left;font-size:.74rem">${order.instrument}</td>` +
      `<td style="color:${sideColor};font-weight:600;text-transform:uppercase">${order.side}</td>` +
      `<td>${typeLabel}</td>` +
      `<td style="font-family:monospace">$${order.strike.toLocaleString()}</td>` +
      `<td style="font-family:monospace">${order.qty.toLocaleString()}</td>` +
      `<td style="font-family:monospace">${order.best_bid != null ? order.best_bid.toFixed(4) : "--"}</td>` +
      `<td style="font-family:monospace">${order.best_ask != null ? order.best_ask.toFixed(4) : "--"}</td>` +
      `<td style="font-family:monospace">${order.mark != null ? order.mark.toFixed(4) : "--"}</td>` +
      `<td>${isPending ? `<select class="exec-order-type" data-id="${order.id}" style="font-size:.72rem;width:70px;background:var(--surface);color:inherit;border:1px solid var(--border)">` +
        `<option value="limit" ${order.order_type === "limit" ? "selected" : ""}>Limit</option>` +
        `<option value="market" ${order.order_type === "market" ? "selected" : ""}>Market</option></select>` : order.order_type}</td>` +
      `<td>${isPending ? `<input type="number" class="exec-price" data-id="${order.id}" value="${order.price || ""}" step="0.0001" style="width:80px;font-size:.72rem;padding:2px 4px;font-family:monospace;background:var(--surface);color:inherit;border:1px solid var(--border)">` : (order.price ? order.price.toFixed(4) : "--")}</td>` +
      `<td class="${statusCls}" style="font-weight:600;font-size:.74rem">${order.status.toUpperCase()}</td>`;
    $tbody.appendChild(tr);
  }

  document.getElementById("exec-total-summary").textContent =
    execOrders.filter(o => o.status === "pending").length + " pending";

  // Wire events
  $tbody.querySelectorAll(".exec-check").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = parseFloat(cb.dataset.id);
      if (cb.checked) execSelected.add(id); else execSelected.delete(id);
      cb.closest("tr").classList.toggle("roll-row-selected", cb.checked);
    });
  });
  $tbody.querySelectorAll(".exec-order-type").forEach(sel => {
    sel.addEventListener("change", () => {
      const order = execOrders.find(o => o.id === parseFloat(sel.dataset.id));
      if (order) order.order_type = sel.value;
    });
  });
  $tbody.querySelectorAll(".exec-price").forEach(inp => {
    inp.addEventListener("change", () => {
      const order = execOrders.find(o => o.id === parseFloat(inp.dataset.id));
      if (order) order.price = parseFloat(inp.value) || null;
    });
  });
}

async function execExecuteSelected() {
  const toExecute = execOrders.filter(o => execSelected.has(o.id) && o.status === "pending");
  if (toExecute.length === 0) { alert("Select orders to execute."); return; }

  const env = document.getElementById("exec-env").textContent;
  if (!confirm(`Execute ${toExecute.length} order(s) on ${env}?\n\nThis will place real orders on Deribit.`)) return;

  const $btn = document.getElementById("btn-exec-selected");
  $btn.disabled = true;
  $btn.textContent = "Executing...";

  for (const order of toExecute) {
    try {
      const body = {
        instrument_name: order.instrument,
        side: order.side,
        amount: order.qty,
        order_type: order.order_type,
        label: "plgo",
      };
      if (order.order_type === "limit" && order.price) {
        body.price = order.price;
      }
      const result = await post("/api/execution/order", body);
      order.status = result.order_state || "open";
      order.order_id = result.order_id;
      order.filled = result.filled_amount || 0;
      order.avg_price = result.average_price;

      execLog.unshift({
        time: new Date().toLocaleTimeString(),
        instrument: order.instrument,
        side: order.side,
        qty: order.qty,
        type: order.order_type,
        price: order.price,
        state: result.order_state,
        filled: result.filled_amount,
        avg_price: result.average_price,
        order_id: result.order_id,
      });
    } catch (e) {
      order.status = "failed";
      execLog.unshift({
        time: new Date().toLocaleTimeString(),
        instrument: order.instrument,
        side: order.side,
        qty: order.qty,
        type: order.order_type,
        price: order.price,
        state: "FAILED",
        filled: 0,
        avg_price: null,
        order_id: e.message,
      });
    }
  }

  execSelected.clear();
  $btn.disabled = false;
  $btn.textContent = "Execute Selected";
  execRenderOrders();
  execRenderLog();
  await execCheckStatus();  // refresh balance
}

function execRenderLog() {
  if (execLog.length === 0) return;
  document.getElementById("exec-log-section").style.display = "block";
  const $tbody = document.getElementById("exec-log-body");
  $tbody.innerHTML = "";
  for (const entry of execLog) {
    const sideColor = entry.side === "buy" ? "var(--green)" : "var(--red)";
    const stateCls = entry.state === "filled" ? "mtm-pos" : entry.state === "FAILED" ? "mtm-neg" : "";
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${entry.time}</td>` +
      `<td style="text-align:left;font-size:.74rem">${entry.instrument}</td>` +
      `<td style="color:${sideColor};font-weight:600">${entry.side.toUpperCase()}</td>` +
      `<td style="font-family:monospace">${entry.qty.toLocaleString()}</td>` +
      `<td>${entry.type}</td>` +
      `<td style="font-family:monospace">${entry.price ? entry.price.toFixed(4) : "--"}</td>` +
      `<td class="${stateCls}" style="font-weight:600">${(entry.state || "--").toUpperCase()}</td>` +
      `<td style="font-family:monospace">${entry.filled || 0}</td>` +
      `<td style="font-family:monospace">${entry.avg_price ? entry.avg_price.toFixed(4) : "--"}</td>` +
      `<td style="text-align:left;font-size:.68rem;color:var(--muted)">${entry.order_id || "--"}</td>`;
    $tbody.appendChild(tr);
  }
}

async function execRefreshOpenOrders() {
  try {
    const result = await get("/api/execution/open-orders");
    const orders = result.orders || [];
    document.getElementById("exec-open-section").style.display = "block";
    const $tbody = document.getElementById("exec-open-body");
    $tbody.innerHTML = "";
    for (const o of orders) {
      const sideColor = o.direction === "buy" ? "var(--green)" : "var(--red)";
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td style="text-align:left;font-size:.74rem">${o.instrument_name}</td>` +
        `<td style="color:${sideColor};font-weight:600">${(o.direction || "").toUpperCase()}</td>` +
        `<td style="font-family:monospace">${o.amount}</td>` +
        `<td style="font-family:monospace">${o.filled_amount || 0}</td>` +
        `<td style="font-family:monospace">${o.price ? o.price.toFixed(4) : "MKT"}</td>` +
        `<td style="font-weight:600">${(o.order_state || "").toUpperCase()}</td>` +
        `<td style="text-align:left;font-size:.68rem;color:var(--muted)">${o.order_id || ""}</td>` +
        `<td><button class="btn-secondary exec-cancel-btn" data-oid="${o.order_id}" style="width:auto;margin:0;padding:.15rem .4rem;font-size:.68rem">Cancel</button></td>`;
      $tbody.appendChild(tr);
    }
    $tbody.querySelectorAll(".exec-cancel-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await post("/api/execution/cancel", { order_id: btn.dataset.oid });
          btn.textContent = "Cancelled";
          btn.disabled = true;
          await execRefreshOpenOrders();
        } catch (e) { alert("Cancel failed: " + e.message); }
      });
    });
    if (orders.length === 0) {
      $tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">No open orders</td></tr>';
    }
  } catch (e) {
    alert("Failed to fetch open orders: " + e.message);
  }
}

// ── Execution page wiring ────────────────────────────────

document.getElementById("exec-check-all").addEventListener("change", (e) => {
  execOrders.filter(o => o.status === "pending").forEach(o => {
    if (e.target.checked) execSelected.add(o.id); else execSelected.delete(o.id);
  });
  execRenderOrders();
});

document.getElementById("btn-exec-refresh-books").addEventListener("click", execRefreshBooks);

document.getElementById("btn-exec-clear").addEventListener("click", () => {
  execOrders = execOrders.filter(o => o.status !== "pending");
  execSelected.clear();
  execRenderOrders();
});

document.getElementById("btn-exec-selected").addEventListener("click", execExecuteSelected);
document.getElementById("btn-exec-refresh-open").addEventListener("click", execRefreshOpenOrders);

// ── Send from Strategy Builder button ────────────────────

document.getElementById("btn-sb-send-to-exec").addEventListener("click", () => {
  if (!sbLegsPriced || sbLegsPriced.length === 0) { alert("Price the structure first."); return; }
  execSendFromBuilder(sbLegsPriced);
});

// ── Nav handler for execution page ───────────────────────
// (needs to trigger init when page is first shown)

// ─── Go! ────────────────────────────────────────────────────
init();

/* ================================================================
   OPTIMIZER V2 TAB
   ================================================================ */

let optv2Data = null;

/* ── Base-book scoping (trades sent from the Deals / Risk screen) ──────────
 * When the user picks deals on Deals / Risk and hits "Send to Optimizer v2",
 * their trade ids land on window._optv2BaseTradeIds. While that's set, the
 * Optimizer treats *only* those trades as the current portfolio: the Run call
 * passes base_trade_ids, and the preview (greeks/payoff/matrix) is filtered to
 * match so what you see is what the optimizer runs against. Clearing the pill
 * returns to the full book. */
function optv2BaseIds() {
  return Array.isArray(window._optv2BaseTradeIds) && window._optv2BaseTradeIds.length
    ? window._optv2BaseTradeIds : null;
}

// Positions the previews should render — the base-book subset when scoped.
function optv2ActivePositions() {
  const all = (optv2Data && optv2Data.positions) || [];
  const ids = optv2BaseIds();
  if (!ids) return all;
  const set = new Set(ids.map(Number));
  return all.filter(p => set.has(Number(p.id)));
}

function optv2RenderBasePill() {
  const el = document.getElementById("optv2-base-pill");
  if (!el) return;
  const ids = optv2BaseIds();
  if (!ids) { el.style.display = "none"; el.innerHTML = ""; return; }
  // How many of the sent trades actually matched the loaded book (if loaded)?
  const matched = optv2Data ? optv2ActivePositions().length : ids.length;
  const missing = optv2Data ? ids.length - matched : 0;
  el.style.display = "";
  el.innerHTML = `
    <span class="optv2-base-pill-text">
      🎯 Base book scoped to <b>${matched}</b> trade${matched === 1 ? "" : "s"} from Deals
      ${missing > 0 ? `<span style="color:var(--red)"> (${missing} not in current book)</span>` : ""}
      — the optimizer runs against just these.
    </span>
    <button id="optv2-base-clear" class="btn-secondary" style="width:auto;padding:.15rem .55rem;margin-left:.6rem"
      title="Use the full book again">Clear ✕</button>`;
  document.getElementById("optv2-base-clear")?.addEventListener("click", () => {
    window._optv2BaseTradeIds = null;
    window._optv2BaseMeta = null;
    optv2RenderBasePill();
    if (optv2Data) optv2RenderAll();
  });
}

// Entry point called from the Deals screen after switching to this page.
function optv2ApplyBaseSelection() {
  optv2RenderBasePill();
  if (optv2Data) {
    optv2RenderAll();
  } else {
    // Nothing loaded yet — pull the book so the scoped preview shows immediately.
    document.getElementById("btn-load-optv2")?.click();
  }
}

document.getElementById("btn-load-optv2").addEventListener("click", async () => {
  console.log("[OPT-FE] btn-load-optv2 clicked");
  const $btn = document.getElementById("btn-load-optv2");
  $btn.classList.add("loading");
  $btn.textContent = "Loading…";

  try {
    optv2Data = await get(`/api/portfolio/pnl?asset=${currentAsset}`);
    optv2PopulateCounterparties();
    optRenderVolPts("optv2-volpts-list", optv2Data);
    optRenderBoxFee("optv2-boxfee-list", optv2Data);
    optRenderPerpCost("optv2-perpcost-list", optv2Data);
    // Hint the live spot as the placeholder — blank still means "use live
    // spot", this is just so the field isn't a mystery number to fill in.
    const $customSpot = document.getElementById("optv2-custom-spot");
    if ($customSpot) $customSpot.placeholder = optv2Fmt(optv2Data.eth_spot, 2);
    optv2OptResult = null;  // reset so chart shows all horizons
    // Hide the "After" matrix panel
    document.getElementById("optv2-matrix-after-panel").style.display = "none";
    document.getElementById("optv2-matrix-grid").style.gridTemplateColumns = "1fr";
    optv2RenderAll();

    // Populate expiry dropdown from vol surface
    const $expiry = document.getElementById("optv2-target-expiry");
    $expiry.innerHTML = '<option value="">Select maturity…</option>';
    if (optv2Data.vol_surface) {
      const smiles = optv2Data.vol_surface
        .filter(s => s.dte > 0)
        .sort((a, b) => a.dte - b.dte);
      smiles.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s.expiry_code;
        opt.textContent = `${s.expiry_code} (${s.dte}d)`;
        $expiry.appendChild(opt);
      });
    }

    // A maturity must be chosen before running — Run stays disabled until then.
    optv2SyncRunEnabled();
  } catch (e) {
    console.error("Optimizer v2: failed to load portfolio:", e);
    alert("Failed to load portfolio data — check console.\n" + e.message);
  } finally {
    $btn.classList.remove("loading");
    $btn.textContent = "Load Risk Profile";
  }
});

const OPTV2_HORIZONS = [0, 16, 30, 60, 90, 120, 150];

function optv2RenderAll() {
  if (!optv2Data) return;

  document.getElementById("optv2-greeks-section").style.display = "";
  document.getElementById("optv2-payoff-section").style.display = "";
  document.getElementById("optv2-matrix-section").style.display = "";

  optv2RenderBasePill();
  optv2RenderGreeks();
  optv2RenderPayoff();
  optv2RenderMatrix();
}

/* ── Greeks summary ─────────────────────────────────────────── */
function optv2RenderGreeks() {
  document.getElementById("optv2-eth-spot").textContent = "$" + optv2Fmt(optv2Data.eth_spot, 2);
  if (!optv2BaseIds()) {
    // Full book — use the server-computed totals as before.
    const t = optv2Data.totals;
    document.getElementById("optv2-total-delta").textContent  = optv2Fmt(t.portfolio_delta, 2);
    document.getElementById("optv2-total-gamma").textContent  = optv2Fmt(t.portfolio_gamma, 4);
    document.getElementById("optv2-total-theta").textContent  = optv2Fmt(t.portfolio_theta, 2);
    document.getElementById("optv2-total-vega").textContent   = optv2Fmt(t.portfolio_vega, 2);
    document.getElementById("optv2-total-mtm").textContent    = "$" + optv2Fmt(t.current_total_mtm, 2);
    return;
  }
  // Scoped — recompute totals from the selected positions (same formulas the
  // /pnl endpoint uses: greek × net_qty summed, MTM summed).
  const ps = optv2ActivePositions();
  const sum = fn => ps.reduce((a, p) => a + (fn(p) || 0), 0);
  document.getElementById("optv2-total-delta").textContent = optv2Fmt(sum(p => (p.delta || 0) * p.net_qty), 2);
  document.getElementById("optv2-total-gamma").textContent = optv2Fmt(sum(p => (p.gamma || 0) * p.net_qty), 4);
  document.getElementById("optv2-total-theta").textContent = optv2Fmt(sum(p => (p.theta || 0) * p.net_qty), 2);
  document.getElementById("optv2-total-vega").textContent  = optv2Fmt(sum(p => (p.vega || 0) * p.net_qty), 2);
  document.getElementById("optv2-total-mtm").textContent   = "$" + optv2Fmt(sum(p => p.current_mtm), 2);
}

let optv2OptResult = null;  // stores latest optimization result

/* ── Payoff profile chart (Plotly) — multi-horizon, log-moneyness x-axis ── */
// Payoff chart — plots actual spot price on a LOG x-axis so it works at any
// scale (ETH ~$1-14k, FIL ~$0.2-10). Plotly auto-generates price ticks, so no
// asset-specific tick snapping is needed (mirrors optv3RenderPayoff, which
// fixed the same "zero ticks on FIL" bug there — the old log-moneyness axis's
// custom dollar labels only ever rendered at ETH-scale strikes since the
// tick-snap check required strike % 100 === 0, never true for FIL's ~$0.2-10
// range).
function optv2RenderPayoff() {
  const spots = optv2Data.spot_ladder;
  const positions = optv2ActivePositions();
  const S0 = optv2Data.eth_spot;  // /pnl uses "eth_spot" for the spot of any asset
  if (!positions.length || !spots || !spots.length) return;

  const assetLabel = (typeof currentAsset !== "undefined" && currentAsset) ? currentAsset : "ETH";
  const fmtPrice = s => (s < 100 ? Number(s).toFixed(2) : Math.round(s).toLocaleString());

  const traces = [];

  // If we have optimization results, show Before vs After — at horizon 0
  // (today), not T+90d: the LP's own fit (lam_factor/profile_error, and the
  // Target curve) is computed at horizon 0, so a T+90d curve — which bakes
  // in 90 days of theta decay — is never comparable to Target regardless of
  // fit quality. Confirmed empirically: raising lam_factor tightens the
  // horizon-0 fit to within a few $k of Target while the T+90d gap actually
  // grows, since decay reshapes the curve independent of today's fit.
  if (optv2OptResult && optv2OptResult.status === "ok") {
    // The optimizer's own spot_ladder can differ from optv2Data's (/pnl's) —
    // use it for anything sourced from optv2OptResult so x/y stay index-aligned.
    const optSpots = optv2OptResult.spot_ladder || spots;

    // Before (now)
    const beforeCurve = optv2OptResult.before.payoff_by_horizon["0"];
    if (beforeCurve) {
      traces.push({
        x: optSpots, y: beforeCurve, mode: "lines",
        name: "Before (Now)",
        line: { color: "#e57373", width: 2, dash: "dash" },
      });
    }
    // After (now)
    const afterCurve = optv2OptResult.after.payoff_by_horizon["0"];
    if (afterCurve) {
      traces.push({
        x: optSpots, y: afterCurve, mode: "lines",
        name: "After (Now)",
        line: { color: "#4fc3f7", width: 3 },
      });
    }
    // Target profile is an absolute-dollar curve on its own internal fitting
    // scale (raw BS book value + a cash_shift constant, evaluated at horizon
    // 0) — not directly comparable to Before/After, which are each
    // independently anchored to read 0 at (today, current spot). Self-anchor
    // Target the same way (subtract its own value at current spot) so all
    // three curves cross 0 at the same point and only relative *shape* away
    // from spot is being compared, not an arbitrary absolute-scale offset.
    if (optv2OptResult.target_payoff) {
      const spotIdx = optv2NearestIdx(optSpots, S0);
      const targetAtSpot = optv2OptResult.target_payoff[spotIdx];
      const targetCurve = optv2OptResult.target_payoff.map(v => v - targetAtSpot);
      traces.push({
        x: optSpots, y: targetCurve, mode: "lines",
        name: "Target Profile",
        line: { color: "#ffca28", width: 2, dash: "dot" },
      });
    }
  } else {
    // Default: show all horizons
    const horizonColors = {
      0:  "#4fc3f7",  // cyan — Now
      16: "#ba68c8",  // purple
      30: "#ffb74d",  // orange
      60: "#81c784",  // green
      90: "#e57373",  // red
    };

    for (const h of OPTV2_HORIZONS) {
      const hKey = String(h);
      const totalPayoff = new Array(spots.length).fill(0);
      let hasData = false;

      positions.forEach(p => {
        const curve = p.payoff_by_horizon[hKey];
        if (curve) {
          hasData = true;
          for (let i = 0; i < curve.length; i++) totalPayoff[i] += curve[i];
        }
      });

      if (!hasData) continue;

      traces.push({
        x: spots, y: totalPayoff, mode: "lines",
        name: h === 0 ? "Now (0d)" : `T+${h}d`,
        line: { color: horizonColors[h] || "#8b949e", width: h === 0 ? 3 : 2 },
      });
    }
  }

  // Zero line
  traces.push({
    x: [spots[0], spots[spots.length - 1]],
    y: [0, 0],
    mode: "lines",
    name: "Break-even",
    line: { color: "rgba(255,255,255,0.25)", dash: "dot", width: 1 },
    showlegend: false,
  });

  // Current spot marker (actual price on the log axis)
  const spotPayoff0 = (() => {
    const totalPayoff = new Array(spots.length).fill(0);
    positions.forEach(p => {
      const curve = p.payoff_by_horizon["0"];
      if (curve) for (let i = 0; i < curve.length; i++) totalPayoff[i] += curve[i];
    });
    return totalPayoff[optv2NearestIdx(spots, S0)];
  })();

  traces.push({
    x: [S0],
    y: [spotPayoff0],
    mode: "markers",
    name: `${assetLabel} Spot ($${fmtPrice(S0)})`,
    marker: { color: "#ffca28", size: 10, symbol: "diamond" },
  });

  const layout = {
    title: { text: optv2OptResult ? "Payoff Profile — Before vs After vs Target (Now)" : "Portfolio Payoff Profile — All Positions", font: { color: "#e6edf3", size: 16 } },
    xaxis: {
      title: `${assetLabel} Spot (USD, log scale)`,
      type: "log",
      tickprefix: "$",
      exponentformat: "none",
      separatethousands: true,
      color: "#8b949e",
      gridcolor: "#21262d",
      zerolinecolor: "#ffca28",
      zerolinewidth: 1.5,
    },
    yaxis: {
      title: "MTM (USD)",
      tickformat: ",.0f",
      zeroline: true,
      zerolinecolor: "#f85149",
      zerolinewidth: 1,
      color: "#8b949e",
      gridcolor: "#21262d",
    },
    paper_bgcolor: "#161b22",
    plot_bgcolor: "#0d1117",
    font: { color: "#e0e0e0" },
    legend: {
      font: { color: "#8b949e", size: 11 },
      orientation: "h",
      y: -0.22,
    },
    margin: { t: 50, b: 70, l: 80, r: 30 },
  };

  Plotly.newPlot("optv2-payoff-chart", traces, layout, { responsive: true });
}

/* ── Pick ~targetRows evenly index-spaced ladder points for matrix display.
   The ladder itself stays dense (for LP fit resolution + chart smoothness);
   this only thins out which rows the matrix tables show. ── */
function optv2MatrixDisplayIdx(spots, targetRows = 14) {
  const n = spots.length;
  if (n <= targetRows) return spots.map((_, i) => i);
  const idxs = [];
  for (let i = 0; i < targetRows; i++) {
    idxs.push(Math.round((i * (n - 1)) / (targetRows - 1)));
  }
  return [...new Set(idxs)];
}

/* ── Scenario matrix: spot (rows) × horizon (columns) ──────── */
function optv2RenderMatrix() {
  const spots    = optv2Data.spot_ladder;
  const positions = optv2ActivePositions();
  const ethSpot  = optv2Data.eth_spot;
  if (!positions.length) return;

  // Header
  const $thead = document.getElementById("optv2-matrix-thead");
  $thead.innerHTML = "";
  const headRow = document.createElement("tr");
  headRow.innerHTML = "<th>ETH Spot</th>";
  OPTV2_HORIZONS.forEach(h => {
    const th = document.createElement("th");
    th.textContent = h === 0 ? "Now" : `${h}d`;
    headRow.appendChild(th);
  });
  $thead.appendChild(headRow);

  // Body
  const $tbody = document.getElementById("optv2-matrix-tbody");
  $tbody.innerHTML = "";

  // Ladder is log-moneyness spaced (dense near ATM, sparse in the wings) and
  // kept dense for LP fit resolution — thin it to a handful of display rows
  // here rather than filtering by dollar value, which wouldn't land on much
  // of anything on a non-uniform ladder.
  const nearestIdx = optv2NearestIdx(spots, ethSpot);
  const displayIdx = optv2MatrixDisplayIdx(spots);
  displayIdx.forEach((si) => {
    const s = spots[si];
    const tr = document.createElement("tr");
    if (si === nearestIdx) tr.classList.add("row-highlight");

    const tdSpot = document.createElement("td");
    tdSpot.textContent = "$" + s.toLocaleString();
    tdSpot.style.fontWeight = "600";
    tr.appendChild(tdSpot);

    OPTV2_HORIZONS.forEach(h => {
      const hKey = String(h);
      let cellVal = 0;
      positions.forEach(p => {
        const curve = p.payoff_by_horizon[hKey];
        if (curve && curve[si] !== undefined) cellVal += curve[si];
      });

      const td = document.createElement("td");
      td.textContent = Math.round(cellVal).toLocaleString();
      td.style.textAlign = "right";
      if (cellVal > 0)  td.style.color = "#66bb6a";
      if (cellVal < 0)  td.style.color = "#ef5350";
      tr.appendChild(td);
    });

    $tbody.appendChild(tr);
  });
}

/* ── Helpers (namespaced to avoid collisions) ───────────────── */
function optv2Fmt(v, decimals) {
  if (v == null || isNaN(v)) return "—";
  return Number(v).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function optv2NearestIdx(arr, val) {
  let best = 0, bestDist = Math.abs(arr[0] - val);
  for (let i = 1; i < arr.length; i++) {
    const d = Math.abs(arr[i] - val);
    if (d < bestDist) { best = i; bestDist = d; }
  }
  return best;
}

/* ── Optimizer v2 — Saved Snapshots Browser ───────────────── */
function optv2FmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── Run gating: require a portfolio loaded AND a maturity chosen ──── */
function optv2SyncRunEnabled() {
  const runBtn = document.getElementById("btn-run-optv2");
  if (!runBtn) return;
  const hasExpiry = !!(document.getElementById("optv2-target-expiry")?.value);
  const loaded = !!optv2Data;
  runBtn.disabled = !(loaded && hasExpiry);
  runBtn.title = (loaded && !hasExpiry)
    ? "Choose a target maturity before running"
    : "";
}
document.getElementById("optv2-target-expiry")?.addEventListener("change", optv2SyncRunEnabled);

/* ── Run Optimizer ──────────────────────────────────────────── */
document.getElementById("btn-run-optv2").addEventListener("click", async () => {
  console.log("[OPT-FE] btn-run-optv2 clicked");
  const $btn = document.getElementById("btn-run-optv2");
  // Guard: a maturity must be selected.
  if (!document.getElementById("optv2-target-expiry")?.value) {
    alert("Choose a target maturity before running the optimizer.");
    return;
  }
  $btn.classList.add("loading");
  $btn.textContent = "Running…";
  $btn.disabled = true;

  try {
    function readNum(id, fallback) {
      const el = document.getElementById(id);
      if (!el) {
        console.error(`Missing optimizer input: ${id}`);
        return fallback;
      }
      const v = parseFloat(el.value);
      return Number.isNaN(v) ? fallback : v;
    }
    const rollDteThreshold = document.getElementById("optv2-roll-dte-threshold").value || null;
    const cptySel = document.getElementById("optv2-counterparties");
    const selectedCounterparties = cptySel
      ? Array.from(cptySel.selectedOptions).map(o => o.value).filter(v => v && v !== "ALL")
      : [];
    const saveRequested = document.getElementById("optv2-save-usecase")?.checked || false;
    const rollItmOnly = document.getElementById("optv2-roll-itm-only")?.checked || false;
    const enableBoxNeutralizer = document.getElementById("optv2-enable-box-neutralizer")?.checked || false;
    // Empty field = no cap (disabled); "0" is a real value (cap at current level) and
    // must NOT collapse to the same thing, so check for the empty string explicitly.
    const collateralBudgetRaw = document.getElementById("optv2-collateral-budget-pct")?.value;
    const collateralBudgetPct = collateralBudgetRaw === "" || collateralBudgetRaw === undefined
      ? null
      : parseFloat(collateralBudgetRaw);
    const maxQtyRaw = document.getElementById("optv2-max-qty")?.value;
    const maxQty = maxQtyRaw === "" || maxQtyRaw === undefined ? null : parseFloat(maxQtyRaw);
    const maxTradesRaw = document.getElementById("optv2-max-trades")?.value;
    const maxTrades = maxTradesRaw === "" || maxTradesRaw === undefined ? null : parseInt(maxTradesRaw, 10);
    const maxCpLossRaw = document.getElementById("optv2-max-cp-loss")?.value;
    const maxCpLoss = maxCpLossRaw === "" || maxCpLossRaw === undefined ? null : parseFloat(maxCpLossRaw);
    const useCollateralCap = document.getElementById("optv2-use-collateral-cap")?.checked || false;
    const customSpotRaw = document.getElementById("optv2-custom-spot")?.value;
    const customSpot = customSpotRaw === "" || customSpotRaw === undefined ? null : parseFloat(customSpotRaw);
    const data = await post("/api/optimization/run", {
      asset: currentAsset,
      // Blank (null) = live spot, unchanged from before this existed. Set =
      // run the whole optimization (candidates, greeks, target anchor,
      // payoff ladder) as if spot were this price instead.
      custom_spot: customSpot,
      lam_factor: parseFloat(document.getElementById("optv2-lam-factor").value || "0.2"),
      downside_factor: parseFloat(document.getElementById("optv2-downside-factor")?.value || "1"),
      t90_weight: parseFloat(document.getElementById("optv2-t90-weight")?.value || "0"),
      atm_concentration: parseFloat(document.getElementById("optv2-atm-concentration")?.value || "0"),
      mu_factor: parseFloat(document.getElementById("optv2-mu-factor")?.value || "0"),
      cash_neutrality_factor: parseFloat(document.getElementById("optv2-cash-neutrality-factor")?.value || "0"),
      max_cp_loss_usd: maxCpLoss,
      use_collateral_cap: useCollateralCap,
      target_expiry: document.getElementById("optv2-target-expiry").value || null,
      unwind_discount: parseFloat(document.getElementById("optv2-unwind-discount")?.value || "0.2"),
      new_position_penalty: parseFloat(document.getElementById("optv2-new-position-penalty")?.value || "0.04"),
      roll_dte_threshold: Number.isNaN(rollDteThreshold) ? null : rollDteThreshold,
      roll_itm_only: rollItmOnly,
      collateral_budget_pct: collateralBudgetPct,
      max_qty: maxQty,
      max_trades: maxTrades,
      enable_box_neutralizer: enableBoxNeutralizer,
      enable_composite_unwind: document.getElementById("optv2-enable-composite-unwind")?.checked ?? true,
      composite_overrides: currentCompositeOverrides(),
      save_usecase_snapshot: saveRequested,
      is_replay: false,
      counterparties: selectedCounterparties.length ? selectedCounterparties : null,
      // Only meaningful when roll_dte_threshold is -1 (manual roll-selection
      // mode), but harmless to always send — sourced from the same tmSelected
      // set the Trade Management tab's "Expire Selected" button uses.
      forced_roll_ids: [...tmSelected],
      // When trades were sent over from the Deals / Risk screen, scope the
      // optimizer's input book to exactly those trades. null = full book.
      base_trade_ids: optv2BaseIds(),
      // Per-counterparty transaction cost in vol points (cost = |vega| × VOLpts).
      bid_ask_vol_pts: optVolPtsDict("optv2-volpts-list"),
      // Per-counterparty box-neutralizer execution fee (entered in %, sent as bps).
      box_fee_bps: optBoxFeeDict("optv2-boxfee-list"),
      // Per-counterparty perp/future trading cost, in bps of notional.
      perp_cost_bps: optPerpCostDict("optv2-perpcost-list"),
      // Post-LP delta cleanup via a perp trade — see delta_hedger.check_rehedge.
      enable_delta_rehedge: document.getElementById("optv2-enable-delta-rehedge")?.checked || false,
      delta_band: parseFloat(document.getElementById("optv2-delta-band")?.value || "75"),
    });
    console.log("Optimizer v2 result:", data);
    optv2RenderResult(data);
    // Surface whether this run used a hypothetical spot instead of the live
    // mark — the "before" curve above is the CURRENT book repriced at that
    // hypothetical spot, not what the book is actually worth right now.
    const $customSpotWrap = document.getElementById("optv2-sum-custom-spot-wrap");
    if ($customSpotWrap) {
      $customSpotWrap.style.display = customSpot != null ? "" : "none";
      if (customSpot != null) {
        document.getElementById("optv2-sum-custom-spot").textContent = "$" + optv2Fmt(customSpot, 2);
      }
    }
    // If the run was saved, reveal + refresh the snapshots list so the new file
    // shows immediately with its download link.
    if (saveRequested) {
      const sec = document.getElementById("optv2-snapshots-section");
      if (sec) sec.style.display = "";
      await optv2LoadSnapshots();
      sec?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  } finally {
    $btn.classList.remove("loading");
    $btn.textContent = "Run Optimizer";
    $btn.disabled = false;
  }
});

/* ── Render optimization results (optimizer_v3: LASSO + boxes) ── */

// Human-readable strategy label from the engine's strategy code.
const OPTV2_STRATEGY_LABELS = {
  ROLL_UNWIND: "Unwind",
  ROLL_REPLACEMENT: "Roll replacement",
  BOX_NEUTRALIZER: "Box (collateral)",
  DELTA_REHEDGE: "Delta rehedge (perp)",
  CALL_SPREAD: "Call spread",
  PUT_SPREAD: "Put spread",
  STRADDLE: "Straddle",
  IRON_CONDOR: "Iron condor",
  SINGLE: "Single leg",
  CLOSE: "Close",
  REDUCE: "Reduce",
};

function optv2StrategyLabel(code) {
  return OPTV2_STRATEGY_LABELS[code] || (code || "Single leg");
}

function optv2OptType(opt) {
  if (opt === "C") return "Call";
  if (opt === "P") return "Put";
  if (opt === "F") return "Perp";
  return opt || "";
}

function optv2ExpiryText(t) {
  // Prefer an embedded Deribit code in the instrument (ETH-29MAY26-2400-C).
  const parts = String(t.instrument || "").split("-");
  if (parts.length >= 2 && /\d{1,2}[A-Z]{3}\d{2}/.test(parts[1])) return parts[1];
  const exp = t.expiry || "";
  return String(exp).slice(0, 10);
}

// Send the optimizer's proposed trades to the Pricing screen so they can be
// priced/quoted (per-counterparty methodology, vol surface, etc.). Mirrors the
// opt2 chat "Send to Pricing" flow: load legs, switch page, auto-price.
document.getElementById("btn-optv2-send-to-pricing")?.addEventListener("click", () => {
  const res = optv2OptResult;
  // Prefer the new/replacement trades; fall back to the full aggregated list.
  const source = (res && ((res.replacement_trades && res.replacement_trades.length)
    ? res.replacement_trades : res.trades)) || [];
  if (!source.length) { alert("No optimizer trades to send. Run the optimizer first."); return; }

  legs.length = 0;  // clear existing Pricing legs
  let sent = 0, skipped = 0;
  const usedCodes = new Set();
  for (const t of source) {
    const opt = String(t.opt || "").toUpperCase();
    if (opt !== "C" && opt !== "P") { skipped++; continue; }  // skip perps/futures — no option premium to price
    const qty = Math.abs(Number(t.qty) || 0);
    if (!qty) { skipped++; continue; }
    const side = String(t.side || "").toLowerCase().startsWith("s") ? "sell" : "buy";
    const premium = t.bs_price_usd ? String(Math.round(t.bs_price_usd * 100) / 100) : "0";
    // Use the trade's Deribit expiry code; a bare date can't be a pricing expiry.
    let expCode = optv2ExpiryText(t);
    if (!/^\d{1,2}[A-Z]{3}\d{2}$/.test(expCode || "")) expCode = null;
    addLeg(side, opt, String(t.strike), premium, String(qty), expCode);
    if (expCode) usedCodes.add(expCode);
    sent++;
  }
  if (!sent) { alert("No priceable option legs in the optimizer result (perps/zero-qty only)."); return; }

  // Add any non-standard expiries to the Pricing dropdown (interpolated).
  const existing = new Set([...$expSel.options].map(o => o.value));
  for (const ec of usedCodes) {
    if (!existing.has(ec)) {
      const dte = _expiryCodeToDte(ec);
      const o = document.createElement("option");
      o.value = ec;
      o.textContent = `${ec} (${dte != null ? dte + 'd' : '?'}) [interpolated]`;
      $expSel.appendChild(o);
      existing.add(ec);
    }
  }

  // Switch to the Pricing page via the real nav handler (keeps legs intact).
  const pricingNav = document.querySelector('.nav-item[data-page="pricing"]');
  if (pricingNav) pricingNav.click();

  // Auto-price via the vol surface once the legs are in.
  setTimeout(() => { document.getElementById("btn-replicate")?.click(); }, 300);

  if (skipped) console.log(`Optimizer → Pricing: sent ${sent} leg(s), skipped ${skipped} (perp/zero-qty).`);
});

// ─── Saved Snapshots ────────────────────────────────────────
async function optv2LoadSnapshots() {
  const tbody = document.getElementById("optv2-snapshots-body");
  if (!tbody) return;
  try {
    const res = await get("/api/optimization/snapshots");
    const snaps = res.snapshots || [];
    if (snaps.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:1rem;color:var(--muted)">No saved runs yet. Check "Save usecase snapshot" before running.</td></tr>';
      return;
    }
    tbody.innerHTML = snaps.map(s => {
      const d = s.modified ? new Date(s.modified * 1000) : null;
      const dateStr = d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
      const timeStr = d ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
      const statusColor = s.status === "ok" ? "var(--green)" : s.status ? "var(--red)" : "var(--muted)";
      return `<tr>
        <td style="white-space:nowrap">${dateStr} <span style="color:var(--muted)">${timeStr}</span></td>
        <td>${s.asset || "ETH"}</td>
        <td>${s.target_expiry || "--"}</td>
        <td>${s.lam_factor || "--"}</td>
        <td>${s.trades_count != null ? s.trades_count : "--"}</td>
        <td style="color:${statusColor}">${s.status || "--"}</td>
        <td>${s.size_kb || 0} KB</td>
        <td><a href="/api/optimization/snapshots/${encodeURIComponent(s.filename)}" download style="font-size:.75rem">&darr;</a></td>
      </tr>`;
    }).join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:1rem;color:var(--muted)">${e.message}</td></tr>`;
  }
}

document.getElementById("btn-optv2-refresh-snapshots")?.addEventListener("click", () => optv2LoadSnapshots());


function optv2RenderResult(data) {
  const $section = document.getElementById("optv2-result-section");

  if (data.status !== "ok") {
    $section.style.display = "none";
    alert(data.message || "Optimization returned no results.");
    return;
  }

  $section.style.display = "";
  optv2OptResult = data;
  optv2RenderPayoff();

  document.getElementById("optv2-result-status").textContent =
    data.optimizer_converged ? "Converged" : "Did not converge";

  // Warnings / errors banner
  const $warn = document.getElementById("optv2-warnings");
  if (data.message) {
    $warn.style.display = "";
    $warn.textContent = data.message;
  } else {
    $warn.style.display = "none";
  }

  const unwinds = data.roll_unwind_trades || [];
  const replacements = data.replacement_trades || [];
  const allTrades = data.trades || [];
  const ps = data.premium_summary || {};

  // ── A. Summary ──
  document.getElementById("optv2-sum-total-cost").textContent =
    data.total_cost_usd != null ? "$" + optv2Fmt(data.total_cost_usd, 0) : "—";
  document.getElementById("optv2-sum-unwind").textContent = unwinds.length;
  document.getElementById("optv2-sum-replacement").textContent = replacements.length;
  const netPrem = data.net_premium_generated ?? ps.net_premium_generated ?? 0;
  const $netPrem = document.getElementById("optv2-sum-net-premium");
  $netPrem.textContent = (netPrem >= 0 ? "+$" : "-$") + optv2Fmt(Math.abs(netPrem), 0);
  $netPrem.style.color = netPrem >= 0 ? "var(--green)" : "var(--red)";
  const cash = data.cash_shift || 0;
  document.getElementById("optv2-sum-cash-shift").textContent =
    (cash >= 0 ? "+$" : "-$") + optv2Fmt(Math.abs(cash), 0);
  // Fit error improvement (before - after); positive = better fit
  const fitBefore = data.fit_error_before, fitAfter = data.fit_error_after;
  const $fit = document.getElementById("optv2-sum-fit");
  if (fitBefore != null && fitAfter != null) {
    const pct = fitBefore > 0 ? (100 * (fitBefore - fitAfter) / fitBefore) : 0;
    $fit.textContent = optv2Fmt(pct, 1) + "%";
    $fit.style.color = pct >= 0 ? "var(--green)" : "var(--red)";
  } else {
    $fit.textContent = "—";
  }
  document.getElementById("optv2-candidates").textContent = data.candidates_evaluated ?? "—";
  document.getElementById("optv2-sum-prem-sold").textContent = "$" + optv2Fmt(ps.gross_premium_sold || 0, 0);
  document.getElementById("optv2-sum-prem-bought").textContent = "$" + optv2Fmt(ps.gross_premium_bought || 0, 0);
  document.getElementById("optv2-sum-target-expiry").textContent = data.target_expiry || "All";

  // Cash flow by counterparty — premium paid (outlay) vs. collected across
  // every proposed trade, including forced/DTE rolls. Net far from 0 means
  // the desk needs to wire cash to fund the trades, not self-fund them.
  const $cashSection = document.getElementById("optv2-cash-flow-section");
  const $cashBody = document.getElementById("optv2-cash-flow-tbody");
  const cashByCp = data.cash_by_counterparty || {};
  if ($cashSection && $cashBody) {
    const cps = Object.keys(cashByCp);
    if (cps.length) {
      $cashSection.style.display = "";
      $cashBody.innerHTML = cps.sort().map(cp => {
        const v = cashByCp[cp];
        const net = v.net || 0;
        return `<tr><td>${cp}</td><td style="color:var(--red)">$${optv2Fmt(v.cost || 0, 0)}</td><td>$${optv2Fmt(v.outlay || 0, 0)}</td>` +
          `<td>$${optv2Fmt(v.collection || 0, 0)}</td>` +
          `<td style="color:${net >= 0 ? "var(--red)" : "var(--green)"}">${net >= 0 ? "+$" : "-$"}${optv2Fmt(Math.abs(net), 0)}</td></tr>`;
      }).join("");
    } else {
      $cashSection.style.display = "none";
    }
  }

  // Worst-case stress P&L by counterparty — see cp_worst_case_stress in
  // run_lp's response. Independent of the fleet-wide fit shown above: a
  // counterparty can be left with a large standalone loss here even when
  // the aggregate summary looks fine, if another counterparty's gain
  // happens to net it out. cp_worst_case_net (rendered as "Min Collateral
  // Headroom") is a separate metric — same book, netted against posted
  // collateral at the same stress spot, framed as cushion remaining rather
  // than a raw P&L-plus-collateral sum (which reads backwards next to
  // "worst" once the collateral principal dominates) — populated only for
  // counterparties with collateral data, and can peak at a different spot
  // than the P&L-only worst case.
  const $cpStressSection = document.getElementById("optv2-cp-stress-section");
  const $cpStressBody = document.getElementById("optv2-cp-stress-tbody");
  const cpStress = data.cp_worst_case_stress || {};
  const cpNet = data.cp_worst_case_net || {};
  if ($cpStressSection && $cpStressBody) {
    const cps = Object.keys(cpStress);
    if (cps.length) {
      $cpStressSection.style.display = "";
      $cpStressBody.innerHTML = cps
        .sort((a, b) => cpStress[a].pnl - cpStress[b].pnl)
        .map(cp => {
          const v = cpStress[cp];
          const pnl = v.pnl || 0;
          const n = cpNet[cp];
          const netCells = n
            ? `<td style="color:${n.net >= 0 ? "var(--green)" : "var(--red)"}">${n.net >= 0 ? "+$" : "-$"}${optv2Fmt(Math.abs(n.net), 0)}</td>` +
              `<td>${optv2Fmt(n.spot, 4)}</td>`
            : `<td>—</td><td>—</td>`;
          return `<tr><td>${cp}</td>` +
            `<td style="color:${pnl >= 0 ? "var(--green)" : "var(--red)"}">${pnl >= 0 ? "+$" : "-$"}${optv2Fmt(Math.abs(pnl), 0)}</td>` +
            `<td>${optv2Fmt(v.spot, 4)}</td>${netCells}</tr>`;
        }).join("");
    } else {
      $cpStressSection.style.display = "none";
    }
  }

  // Both matrices below show P&L *from today*, anchored to 0 at (today,
  // current spot) — we don't have each position's historical entry premium
  // to compute a true absolute P&L. Surface that anchor explicitly so the
  // book's actual current MTM isn't lost, just baked into the reference point.
  const $mtmNote = document.getElementById("optv2-matrix-mtm-note");
  if ($mtmNote) {
    if (data.current_book_mtm != null) {
      const mtm = data.current_book_mtm;
      let html = `Both matrices show P&amp;L <b>from today</b>, not absolute value — ` +
        `current book MTM is <b style="color:${mtm >= 0 ? "var(--green)" : "var(--red)"}">` +
        `${mtm >= 0 ? "+$" : "-$"}${optv2Fmt(Math.abs(mtm), 0)}</b> (the implicit $0 anchor at Now/current spot below).`;
      // after_book_mtm is the absolute (not relative-to-now) counterpart, net
      // of the assumed transaction cost of actually executing these trades —
      // a real, one-time hit that (correctly) does NOT show up in the P&L
      // curves above, since those compare against "right after trading" as
      // their own zero point and a one-time cost cancels out of that
      // comparison by construction.
      if (data.after_book_mtm != null && data.total_cost_usd != null) {
        const afterMtm = data.after_book_mtm;
        html += ` After executing the proposed trades (net of ~$${optv2Fmt(data.total_cost_usd, 0)} ` +
          `assumed transaction cost), book MTM would be <b style="color:${afterMtm >= 0 ? "var(--green)" : "var(--red)"}">` +
          `${afterMtm >= 0 ? "+$" : "-$"}${optv2Fmt(Math.abs(afterMtm), 0)}</b>.`;
      }
      $mtmNote.innerHTML = html;
    } else {
      $mtmNote.textContent = "";
    }
  }

  // Refresh the main P&L Matrix from this same optimizer result — it was
  // originally rendered from the /pnl payload's own (linear-ladder) position
  // curves at "Load Risk Profile" time, which used a different spot_ladder
  // than the optimizer's. Re-rendering from data.before here keeps both
  // matrices on the identical ladder and semantics.
  if (data.before && data.before.payoff_by_horizon) {
    optv2RenderCompareMatrix(data, "before", "optv2-matrix-thead", "optv2-matrix-tbody");
  }

  // Show "After" matrix next to the main P&L Matrix
  const $afterPanel = document.getElementById("optv2-matrix-after-panel");
  const $matrixGrid = document.getElementById("optv2-matrix-grid");
  if ($afterPanel && $matrixGrid && data.after && data.after.payoff_by_horizon) {
    $afterPanel.style.display = "";
    $matrixGrid.style.gridTemplateColumns = "1fr 1fr";
    optv2RenderCompareMatrix(data, "after", "optv2-matrix-after-main-thead", "optv2-matrix-after-main-tbody");
  }

  // ── D. Strategy grouping ──
  optv2RenderStrategyGroups(allTrades);

  // ── B. Trades to unwind / close ──
  optv2RenderTradeTable(
    "optv2-unwind-tbody", unwinds, "optv2-unwind-count",
    (t) => [
      `<td>${t.instrument}</td>`,
      `<td>${optv2ExpiryText(t)}</td>`,
      `<td>${optv2Fmt(t.strike, optv3Dp())}</td>`,
      `<td>${optv2OptType(t.opt)}</td>`,
      `<td style="color:${t.side === "Buy" ? "var(--green)" : "var(--red)"}">${t.side}</td>`,
      `<td>${Math.abs(t.qty)}</td>`,
      `<td>${optv2Fmt(t.bs_price_usd, 2)}</td>`,
      `<td>${optv2Fmt(t.notional, 0)}</td>`,
      `<td>${optv2Fmt(t.cost_usd, 0)}</td>`,
      `<td>${t.counterparty || "—"}</td>`,
    ], 10,
    "No positions flagged for unwind/roll at this DTE threshold."
  );

  // ── C. Replacement / new trades ──
  optv2RenderTradeTable(
    "optv2-replacement-tbody", replacements, "optv2-replacement-count",
    (t) => [
      `<td>${t.instrument}</td>`,
      `<td>${optv2ExpiryText(t)}</td>`,
      `<td>${optv2Fmt(t.strike, optv3Dp())}</td>`,
      `<td>${optv2OptType(t.opt)}</td>`,
      `<td style="color:${t.side === "Buy" ? "var(--green)" : "var(--red)"}">${t.side}</td>`,
      `<td>${Math.abs(t.qty)}</td>`,
      `<td>${optv2Fmt(t.bs_price_usd, 2)}</td>`,
      `<td>${optv2Fmt(t.notional, 0)}</td>`,
      `<td>${optv2Fmt(t.cost_usd, 0)}</td>`,
      `<td>${optv2StrategyLabel(t.strategy)}</td>`,
      `<td>${t.counterparty || "—"}</td>`,
      `<td>${t.rolled_from ? "rolled from " + t.rolled_from : ""}</td>`,
    ], 12,
    "No replacement or new trades proposed."
  );
}

function optv2RenderTradeTable(tbodyId, rows, countId, rowFn, colspan, emptyMsg) {
  const $tbody = document.getElementById(tbodyId);
  $tbody.innerHTML = "";
  const $count = countId ? document.getElementById(countId) : null;
  if ($count) $count.textContent = rows.length ? `(${rows.length})` : "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="${colspan}" style="text-align:center;opacity:.6">${emptyMsg}</td>`;
    $tbody.appendChild(tr);
    return;
  }
  rows.forEach(t => {
    const tr = document.createElement("tr");
    tr.innerHTML = rowFn(t).join("");
    $tbody.appendChild(tr);
  });
}

// Group trade legs by their strategy_instrument so multi-leg structures
// (spreads / straddles / boxes) render as one card instead of loose rows.
function optv2RenderStrategyGroups(trades, wrapId = "optv2-strategy-groups") {
  const $wrap = document.getElementById(wrapId);
  $wrap.innerHTML = "";
  if (!trades || !trades.length) {
    $wrap.innerHTML = '<div style="opacity:.6;font-size:.82rem">No structures proposed.</div>';
    return;
  }

  const groups = new Map();
  trades.forEach(t => {
    const key = t.strategy_instrument || t.instrument;
    if (!groups.has(key)) groups.set(key, { key, strategy: t.strategy, legs: [] });
    groups.get(key).legs.push(t);
  });

  for (const g of groups.values()) {
    const isStructure = g.legs.length > 1;
    const card = document.createElement("div");
    card.style.cssText =
      "border:1px solid var(--border);border-radius:6px;padding:.55rem .7rem;background:var(--card-bg)";
    const legText = g.legs.map(l => {
      const c = l.side === "Buy" ? "var(--green)" : "var(--red)";
      return `<span style="white-space:nowrap"><span style="color:${c}">${l.side} ${Math.abs(l.qty)}</span> `
        + `${optv2OptType(l.opt)} ${optv2Fmt(l.strike, optv3Dp())}</span>`;
    }).join('<span style="opacity:.4"> · </span>');
    const net = g.legs.reduce((s, l) => s + (l.qty * (l.bs_price_usd || 0)), 0);
    const netLabel = (net <= 0 ? "credit +$" : "debit -$") + optv2Fmt(Math.abs(net), 0);
    card.innerHTML =
      `<div style="display:flex;justify-content:space-between;gap:1rem;align-items:baseline">`
      + `<div><span style="font-weight:700;font-size:.82rem">${optv2StrategyLabel(g.strategy)}</span>`
      + (isStructure ? ` <span style="opacity:.5;font-size:.74rem">${g.legs.length} legs · ${g.key}</span>` : ` <span style="opacity:.5;font-size:.74rem">${g.key}</span>`)
      + `</div>`
      + `<div style="font-size:.78rem;color:${net <= 0 ? "var(--green)" : "var(--red)"}">${netLabel}</div></div>`
      + `<div style="margin-top:.35rem;font-size:.8rem;display:flex;flex-wrap:wrap;gap:.5rem">${legText}</div>`;
    $wrap.appendChild(card);
  }
}

/* ── Before/After payoff comparison charts ──────────────────── */
/* ── Before/After P&L matrix ───────────────────────────────── */
function optv2RenderCompareMatrix(data, side, theadId, tbodyId) {
  const spots = data.spot_ladder;
  const ethSpot = data.eth_spot;
  const horizons = data.chart_horizons || [0, 16, 30, 60, 90];
  const payoff = data[side].payoff_by_horizon;

  const $thead = document.getElementById(theadId);
  $thead.innerHTML = "";
  const headRow = document.createElement("tr");
  headRow.innerHTML = "<th>ETH Spot</th>";
  horizons.forEach(h => {
    const th = document.createElement("th");
    th.textContent = h === 0 ? "Now" : `${h}d`;
    headRow.appendChild(th);
  });
  $thead.appendChild(headRow);

  const $tbody = document.getElementById(tbodyId);
  $tbody.innerHTML = "";

  // Ladder is log-moneyness spaced (dense near ATM, sparse in the wings) and
  // kept dense for LP fit resolution — thin it to a handful of display rows
  // here rather than filtering by dollar value.
  const nearestIdx = optv2NearestIdx(spots, ethSpot);
  const displayIdx = optv2MatrixDisplayIdx(spots);
  displayIdx.forEach((si) => {
    const s = spots[si];
    const tr = document.createElement("tr");
    if (si === nearestIdx) tr.classList.add("row-highlight");

    const tdSpot = document.createElement("td");
    tdSpot.textContent = "$" + s.toLocaleString();
    tdSpot.style.fontWeight = "600";
    tr.appendChild(tdSpot);

    horizons.forEach(h => {
      const curve = payoff[String(h)];
      const cellVal = (curve && curve[si] !== undefined) ? curve[si] : 0;
      const td = document.createElement("td");
      td.textContent = Math.round(cellVal).toLocaleString();
      td.style.textAlign = "right";
      if (cellVal > 0) td.style.color = "#66bb6a";
      if (cellVal < 0) td.style.color = "#ef5350";
      tr.appendChild(td);
    });

    $tbody.appendChild(tr);
  });
}

// (Full Optimizer tab removed)

// ═══════════════════════════════════════════════════════════════
// OPTIMIZER V3 — reorganized UI over the exact same v2 engine.
// Reuses the pure helpers + param-friendly renderers above
// (optv2Fmt / optv2NearestIdx / optv2MatrixDisplayIdx / optv2OptType /
//  optv2StrategyLabel / optv2ExpiryText / optv2RenderTradeTable /
//  optv2RenderCompareMatrix / optv2RenderStrategyGroups) and the same
// endpoints (/api/portfolio/pnl, /api/optimization/run, /snapshots).
// ═══════════════════════════════════════════════════════════════
let optv3Data = null;
let optv3OptResult = null;
let optv3Loaded = false;

// Base-book scoping shares the same global the Deals "Send to Optimizer" sets,
// so a selection works whether you open v2 or v3.
function optv3ActivePositions() {
  const all = (optv3Data && optv3Data.positions) || [];
  const ids = optv2BaseIds();
  if (!ids) return all;
  const set = new Set(ids.map(Number));
  return all.filter(p => set.has(Number(p.id)));
}

function optv3SyncRunEnabled() {
  const runBtn = document.getElementById("btn-run-optv3");
  if (!runBtn) return;
  const hasExpiry = !!(document.getElementById("optv3-target-expiry")?.value);
  runBtn.disabled = !(!!optv3Data && hasExpiry);
  runBtn.title = (optv3Data && !hasExpiry) ? "Choose a target maturity before running" : "";
}

function optv3RenderBasePill() {
  const el = document.getElementById("optv3-base-pill");
  if (!el) return;
  const ids = optv2BaseIds();
  if (!ids) { el.style.display = "none"; el.innerHTML = ""; return; }
  const matched = optv3Data ? optv3ActivePositions().length : ids.length;
  const missing = optv3Data ? ids.length - matched : 0;
  el.style.display = "";
  el.innerHTML = `<span class="optv2-base-pill-text">🎯 Base book scoped to <b>${matched}</b> trade${matched === 1 ? "" : "s"} from Deals`
    + (missing > 0 ? ` <span style="color:var(--red)">(${missing} not in book)</span>` : "")
    + `</span><button id="optv3-base-clear" class="btn-secondary" style="width:auto;padding:.15rem .55rem;margin-left:.6rem">Clear ✕</button>`;
  document.getElementById("optv3-base-clear")?.addEventListener("click", () => {
    window._optv2BaseTradeIds = null; window._optv2BaseMeta = null;
    optv3RenderBasePill();
    if (optv3Data) optv3RenderPreview();
  });
}

function optv3PopulateCounterparties() {
  const select = document.getElementById("optv3-counterparties");
  if (!select || !optv3Data) return;
  const cps = [...new Set((optv3Data.positions || []).map(p => p.counterparty).filter(Boolean))].sort();
  select.innerHTML = '<option value="ALL" selected>ALL</option>'
    + cps.map(c => `<option value="${c}">${c}</option>`).join("");
}

// Default per-counterparty VOLpts (one-way half-spread) — mirrors the engine's
// DEFAULT_BID_ASK_VOL_PTS_BY_ASSET so the inputs seed with the same fallback.
const OPT_DEFAULT_VOL_PTS = { ETH: 5, FIL: 40 };
function optDefaultVolPts(asset, cpty) {
  const a = OPT_DEFAULT_VOL_PTS[asset];
  if (a == null) return 0.75;
  if (typeof a === "number") return a;
  return a[cpty] != null ? a[cpty] : 0.75;
}

// Render one editable VOLpts input per counterparty in the loaded book,
// preserving any value the user already typed. (Shared v2/v3 by listId.)
function optRenderVolPts(listId, data) {
  const box = document.getElementById(listId);
  if (!box || !data) return;
  const cps = [...new Set((data.positions || []).map(p => p.counterparty).filter(Boolean))].sort();
  const asset = (typeof currentAsset !== "undefined" && currentAsset) ? currentAsset : "ETH";
  const prev = {};
  box.querySelectorAll(".opt-volpts-input").forEach(i => { prev[i.dataset.cpty] = i.value; });
  box.innerHTML = cps.length ? cps.map(cp => {
    const v = prev[cp] != null ? prev[cp] : optDefaultVolPts(asset, cp);
    return `<div class="optv3-field"><label>${cp}<input type="number" class="opt-volpts-input" data-cpty="${cp}" value="${v}" step="0.25" min="0" style="width:5rem"></label></div>`;
  }).join("") : '<p class="optv3-hint" style="margin:0">No counterparties in the loaded book.</p>';
}

// Collect {counterparty: VOLpts} from the inputs, or null if none set.
function optVolPtsDict(listId) {
  const box = document.getElementById(listId);
  if (!box) return null;
  const d = {};
  box.querySelectorAll(".opt-volpts-input").forEach(i => {
    const v = parseFloat(i.value);
    if (i.dataset.cpty && Number.isFinite(v)) d[i.dataset.cpty] = v;
  });
  return Object.keys(d).length ? d : null;
}

// Default perp/future trading cost (bps of notional) — mirrors the engine's
// _PERP_COST_BPS_FALLBACK so the input seeds with the same fallback.
const OPT_DEFAULT_PERP_COST_BPS = 2;

// The synthetic perp candidate always trades on this one venue (engine's
// PERP_COUNTERPARTY) — independent of which OTC options counterparties are in
// the loaded book, so unlike VOLpts/box-fee this always renders exactly one
// row, never derived from data.positions.
const OPT_PERP_COUNTERPARTY = "Binance Futures";

// Render the editable perp-cost input, in BPS of notional (price × qty) — a
// perp has zero vega so the VOLpts model can't price it.
function optRenderPerpCost(listId, data) {
  const box = document.getElementById(listId);
  if (!box) return;
  const prev = box.querySelector(".opt-perpcost-input")?.value;
  const v = prev != null ? prev : OPT_DEFAULT_PERP_COST_BPS;
  box.innerHTML = `<div class="optv3-field"><label>${OPT_PERP_COUNTERPARTY}<input type="number" class="opt-perpcost-input" data-cpty="${OPT_PERP_COUNTERPARTY}" value="${v}" step="0.25" min="0" style="width:5rem"></label></div>`;
}

// Collect {counterparty: perp cost bps} from the inputs, or null if none set.
function optPerpCostDict(listId) {
  const box = document.getElementById(listId);
  if (!box) return null;
  const d = {};
  box.querySelectorAll(".opt-perpcost-input").forEach(i => {
    const v = parseFloat(i.value);
    if (i.dataset.cpty && Number.isFinite(v)) d[i.dataset.cpty] = v;
  });
  return Object.keys(d).length ? d : null;
}

// Render one editable box-trade-fee input per counterparty, in PERCENT of
// notional (box_debit × qty — a box is economically a synthetic cash loan, so
// dealers price its bid-ask as a % of notional, not a flat per-contract fee).
// Displayed/entered in %; optBoxFeeDict converts to bps (engine's native unit)
// before sending. Defaults to 1% per counterparty until tuned against real
// quotes (no engine-side default to seed from yet, unlike VOLpts). Mirrors optRenderVolPts.
function optRenderBoxFee(listId, data) {
  const box = document.getElementById(listId);
  if (!box || !data) return;
  const cps = [...new Set((data.positions || []).map(p => p.counterparty).filter(Boolean))].sort();
  const prev = {};
  box.querySelectorAll(".opt-boxfee-input").forEach(i => { prev[i.dataset.cpty] = i.value; });
  box.innerHTML = cps.length ? cps.map(cp => {
    const v = prev[cp] != null ? prev[cp] : 1;
    return `<div class="optv3-field"><label>${cp}<input type="number" class="opt-boxfee-input" data-cpty="${cp}" value="${v}" step="0.1" min="0" style="width:5rem"></label></div>`;
  }).join("") : '<p class="optv3-hint" style="margin:0">No counterparties in the loaded book.</p>';
}

// Collect {counterparty: box fee bps} from the inputs (entered in %, so ×100
// to reach the engine's bps unit), or null if none set.
function optBoxFeeDict(listId) {
  const box = document.getElementById(listId);
  if (!box) return null;
  const d = {};
  box.querySelectorAll(".opt-boxfee-input").forEach(i => {
    const v = parseFloat(i.value);
    if (i.dataset.cpty && Number.isFinite(v) && v > 0) d[i.dataset.cpty] = v * 100;
  });
  return Object.keys(d).length ? d : null;
}

async function optv3Load() {
  const $btn = document.getElementById("btn-load-optv3");
  $btn.classList.add("loading"); $btn.textContent = "Loading…";
  try {
    optv3Data = await get(`/api/portfolio/pnl?asset=${currentAsset}`);
    optv3OptResult = null;
    optv3PopulateCounterparties();
    optRenderVolPts("optv3-volpts-list", optv3Data);
    optv3RenderDteList();
    optv3PopulateLegExpiries();
    optv3RenderManualLegs();
    optRenderBoxFee("optv3-boxfee-list", optv3Data);
    optRenderPerpCost("optv3-perpcost-list", optv3Data);

    const $expiry = document.getElementById("optv3-target-expiry");
    $expiry.innerHTML = '<option value="">Select maturity…</option>';
    if (optv3Data.vol_surface) {
      optv3Data.vol_surface.filter(s => s.dte > 0).sort((a, b) => a.dte - b.dte).forEach(s => {
        const o = document.createElement("option");
        o.value = s.expiry_code; o.textContent = `${s.expiry_code} (${s.dte}d)`;
        $expiry.appendChild(o);
      });
    }

    document.getElementById("optv3-kpi-section").style.display = "";
    document.getElementById("optv3-payoff-empty").style.display = "none";
    // Reset the "after" matrix panel until a run produces one.
    document.getElementById("optv3-matrix-after-panel").style.display = "none";
    document.getElementById("optv3-matrix-grid").style.gridTemplateColumns = "1fr";
    // Reset the run-only trades block until a new run. The Target Profile pane is
    // managed by optv3RenderProfileTable() (called from optv3RenderPreview) so it
    // stays editable off the loaded book even before the first run.
    const $tu = document.getElementById("optv3-trades-under-chart");
    if ($tu) $tu.style.display = "none";

    // Populate the saved-profile dropdown and fetch the active target profile
    // (parametric by default) so the Target Profile tab shows/seeds it pre-run.
    await optv3PopulateTargetProfiles();
    await optv3FetchTargetProfile();

    optv3RenderBasePill();
    optv3RenderPreview();
    optv3SyncRunEnabled();
  } catch (e) {
    console.error("Optimizer v3: failed to load portfolio:", e);
    alert("Failed to load portfolio data — check console.\n" + e.message);
  } finally {
    $btn.classList.remove("loading"); $btn.textContent = "Load Risk Profile";
  }
}

// Populate the "Profile" dropdown with the saved target-profile CSVs for the asset.
let optv3ProfilesList = [];  // [{name, file, user}] from /target-profiles

async function optv3PopulateTargetProfiles() {
  const sel = document.getElementById("optv3-target-select");
  if (!sel) return;
  const keep = optv3TargetProfileFile;
  let profiles = [];
  try {
    const res = await get(`/api/optimization/target-profiles?asset=${currentAsset}`);
    profiles = (res && res.profiles) || [];
  } catch (e) { console.warn("target-profiles list failed", e); }
  optv3ProfilesList = profiles;
  sel.innerHTML = '<option value="">Parametric (auto)</option>'
    + profiles.map(p => `<option value="${p.file}">${p.user ? "★ " : ""}${p.name}</option>`).join("");
  // Keep the current selection if it still exists; else fall back to parametric.
  if (keep && profiles.some(p => p.file === keep)) sel.value = keep;
  else { sel.value = ""; optv3TargetProfileFile = ""; }
  optv3SyncTargetControls();
}

// Enable Delete only for user-created profiles, and prefill the name field with
// the selected profile's name so "Save / Update" overwrites it.
function optv3SyncTargetControls() {
  const sel = document.getElementById("optv3-target-select");
  const del = document.getElementById("btn-optv3-target-delete");
  const nameEl = document.getElementById("optv3-target-name");
  if (!sel) return;
  const file = sel.value;
  const prof = optv3ProfilesList.find(p => p.file === file);
  // Enable Delete for any selected saved profile (not "Parametric"); the backend
  // is the authority and refuses built-ins with a clear message.
  if (del) del.disabled = !file;
  // Prefill the name with the selected profile's display name (strip "ASSET - ")
  if (nameEl && prof) {
    const display = prof.name.replace(new RegExp(`^${currentAsset}\\s*-\\s*`), "");
    nameEl.value = display;
  } else if (nameEl && !file) {
    nameEl.value = "";
  }
}

// Fetch the active target profile (selected saved CSV, or parametric) aligned to
// the loaded ladder, and use it as the shown/editable target. Clears any manual
// edits so the selection is what drives the next Run.
async function optv3FetchTargetProfile() {
  if (!optv3Data) return;
  optv3ManualTarget = null;
  optv3AutoTargetProfile = null;
  // Align to whichever ladder the profile table renders on (the LP result's ladder
  // after a run, else the /pnl ladder) so the fetched curve indexes correctly and
  // the table numbers update when the dropdown changes.
  const ladder = (optv3OptResult && optv3OptResult.status === "ok" && optv3OptResult.spot_ladder)
    ? optv3OptResult.spot_ladder : optv3Data.spot_ladder;
  try {
    const body = { asset: currentAsset, spot_ladder: ladder, current_spot: optv3Data.eth_spot };
    if (optv3TargetProfileFile) body.profile = optv3TargetProfileFile;
    const tp = await post("/api/optimization/target-profile", body);
    if (tp && Array.isArray(tp.payoff) && tp.payoff.length === (ladder || []).length) {
      optv3AutoTargetProfile = tp.payoff;
    }
  } catch (e) { console.warn("target-profile fetch failed", e); }
  optv3RenderProfileTable();
}

// The current target curve as control points, read from the editable table.
function optv3CurrentTargetPoints() {
  const pts = [];
  document.querySelectorAll("#optv3-profile-tbody .optv3-target-input").forEach(i => {
    const x = Number(i.dataset.x), y = Number(i.value);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
  });
  return pts;
}

// Save the current (possibly edited) target curve as a new named profile, then
// select it so it drives the next Run.
async function optv3SaveTargetProfile() {
  const nameEl = document.getElementById("optv3-target-name");
  const name = (nameEl && nameEl.value || "").trim();
  if (!name) { alert("Enter a name for the new target profile."); return; }
  const points = optv3CurrentTargetPoints();
  if (points.length < 2) { alert("Load or shape a target curve first (need at least 2 points)."); return; }
  try {
    const res = await post("/api/optimization/target-profile/save", { asset: currentAsset, name, points });
    if (nameEl) nameEl.value = "";
    await optv3PopulateTargetProfiles();
    const sel = document.getElementById("optv3-target-select");
    if (sel && res && res.file) { sel.value = res.file; optv3TargetProfileFile = res.file; }
    await optv3FetchTargetProfile();          // reload + show the saved curve
    optv3UpdateTargetStatus();
  } catch (e) {
    alert("Failed to save target profile.\n" + (e.message || e));
  }
}

// Delete the currently-selected saved target profile. The backend allows only
// user-created profiles and refuses built-ins (surfaced here as a clear message).
async function optv3DeleteTargetProfile() {
  const sel = document.getElementById("optv3-target-select");
  const file = sel && sel.value;
  if (!file) { alert("Select a saved profile to delete."); return; }
  const prof = optv3ProfilesList.find(p => p.file === file);
  const label = prof ? prof.name : file;
  if (!confirm(`Delete the saved target profile "${label}"? This can't be undone.`)) return;
  try {
    await post("/api/optimization/target-profile/delete", { asset: currentAsset, file });
    optv3TargetProfileFile = "";
    await optv3PopulateTargetProfiles();   // repopulate (selection resets to parametric)
    await optv3FetchTargetProfile();       // reload the parametric target
    optv3UpdateTargetStatus();
  } catch (e) {
    // e.g. built-in profiles can't be deleted (400) — show the server's reason.
    alert("Couldn't delete this profile.\n" + (e.detail || e.message || e));
  }
}

// Preview (greeks KPI + positions + payoff + before matrix) from the loaded book.
function optv3RenderPreview() {
  if (!optv3Data) return;
  optv3RenderKpi();
  optv3RenderPositions();
  optv3RenderRollCandidates();  // populates the tick-to-unwind panel; also refreshes the chart
  optv3RenderPayoff();
  optv3RenderMatrix();
  optv3RenderProfileTable();
}

// Current-book positions table — the loaded risk profile's per-position numbers.
// Decimal places for prices/strikes/spots in v3 displays — FIL is O($1) so it
// needs 2 dp (a 2.25 strike must not render as "2"); ETH is O($1000), 0 dp.
function optv3Dp() { return (typeof currentAsset !== "undefined" && currentAsset === "FIL") ? 2 : 0; }

function optv3RenderPositions() {
  const tbody = document.getElementById("optv3-positions-tbody");
  const count = document.getElementById("optv3-positions-count");
  if (!tbody) return;
  const ps = optv3ActivePositions();
  if (count) count.textContent = ps.length ? `(${ps.length})` : "";
  if (!ps.length) {
    tbody.innerHTML = '<tr><td colspan="14" style="text-align:center;color:var(--muted);padding:2rem">No positions in the current book.</td></tr>';
    return;
  }
  const rows = [...ps].sort((a, b) =>
    String(a.expiry).localeCompare(String(b.expiry)) || (a.strike - b.strike));
  const sum = fn => rows.reduce((t, p) => t + (fn(p) || 0), 0);
  const money = v => (v >= 0 ? "$" : "-$") + optv2Fmt(Math.abs(v), 0);

  const body = rows.map(p => {
    const long = p.net_qty >= 0;
    const mtm = p.current_mtm || 0;
    return `<tr>
      <td>${p.counterparty || "—"}</td>
      <td>${p.instrument || ""}</td>
      <td style="color:${long ? "var(--green)" : "var(--red)"}">${long ? "Long" : "Short"}</td>
      <td style="text-align:right">${optv2Fmt(Math.abs(p.net_qty), 0)}</td>
      <td style="text-align:right">${optv2Fmt(p.strike, optv3Dp())}</td>
      <td>${optv2OptType(p.opt)}</td>
      <td>${String(p.expiry || "").slice(0, 10)}</td>
      <td style="text-align:right">${p.days_remaining ?? "—"}</td>
      <td style="text-align:right">${optv2Fmt(p.iv_pct, 1)}</td>
      <td style="text-align:right">${optv2Fmt((p.delta || 0) * p.net_qty, 2)}</td>
      <td style="text-align:right">${optv2Fmt((p.gamma || 0) * p.net_qty, 4)}</td>
      <td style="text-align:right">${optv2Fmt((p.theta || 0) * p.net_qty, 2)}</td>
      <td style="text-align:right">${optv2Fmt((p.vega || 0) * p.net_qty, 2)}</td>
      <td style="text-align:right;color:${mtm >= 0 ? "var(--green)" : "var(--red)"}">${money(mtm)}</td>
    </tr>`;
  }).join("");

  const totalMtm = sum(p => p.current_mtm);
  const footer = `<tr class="row-highlight" style="font-weight:600">
    <td colspan="9">Total (${rows.length})</td>
    <td style="text-align:right">${optv2Fmt(sum(p => (p.delta || 0) * p.net_qty), 2)}</td>
    <td style="text-align:right">${optv2Fmt(sum(p => (p.gamma || 0) * p.net_qty), 4)}</td>
    <td style="text-align:right">${optv2Fmt(sum(p => (p.theta || 0) * p.net_qty), 2)}</td>
    <td style="text-align:right">${optv2Fmt(sum(p => (p.vega || 0) * p.net_qty), 2)}</td>
    <td style="text-align:right;color:${totalMtm >= 0 ? "var(--green)" : "var(--red)"}">${money(totalMtm)}</td>
  </tr>`;
  tbody.innerHTML = body + footer;
}

function optv3RenderKpi() {
  document.getElementById("optv3-eth-spot").textContent = "$" + optv2Fmt(optv3Data.eth_spot, 2);
  const ids = optv2BaseIds();
  if (!ids) {
    const t = optv3Data.totals || {};
    document.getElementById("optv3-total-delta").textContent = optv2Fmt(t.portfolio_delta, 2);
    document.getElementById("optv3-total-gamma").textContent = optv2Fmt(t.portfolio_gamma, 4);
    document.getElementById("optv3-total-theta").textContent = optv2Fmt(t.portfolio_theta, 2);
    document.getElementById("optv3-total-vega").textContent = optv2Fmt(t.portfolio_vega, 2);
    document.getElementById("optv3-total-mtm").textContent = "$" + optv2Fmt(t.current_total_mtm, 2);
    return;
  }
  const ps = optv3ActivePositions();
  const sum = fn => ps.reduce((a, p) => a + (fn(p) || 0), 0);
  document.getElementById("optv3-total-delta").textContent = optv2Fmt(sum(p => (p.delta || 0) * p.net_qty), 2);
  document.getElementById("optv3-total-gamma").textContent = optv2Fmt(sum(p => (p.gamma || 0) * p.net_qty), 4);
  document.getElementById("optv3-total-theta").textContent = optv2Fmt(sum(p => (p.theta || 0) * p.net_qty), 2);
  document.getElementById("optv3-total-vega").textContent = optv2Fmt(sum(p => (p.vega || 0) * p.net_qty), 2);
  document.getElementById("optv3-total-mtm").textContent = "$" + optv2Fmt(sum(p => p.current_mtm), 2);
}

// Payoff chart — plots actual spot price on a LOG x-axis so it works at any
// scale (ETH ~$1-14k, FIL ~$0.2-10). Plotly auto-generates price ticks, so no
// asset-specific tick snapping is needed. Labels are asset-aware via currentAsset.
function optv3RenderPayoff() {
  const spots = optv3Data.spot_ladder;
  const positions = optv3ActivePositions();
  const S0 = optv3Data.eth_spot;  // /pnl uses "eth_spot" for the spot of any asset
  if (!positions.length || !spots || !spots.length) return;

  const assetLabel = (typeof currentAsset !== "undefined" && currentAsset) ? currentAsset : "ETH";
  const fmtPrice = s => (s < 100 ? Number(s).toFixed(2) : Math.round(s).toLocaleString());

  const C = optv3ChartColors();
  const HT = "%{fullData.name}: %{y:$,.0f}<extra></extra>";
  const traces = [];
  if (optv3OptResult && optv3OptResult.status === "ok") {
    // x = actual spot prices (Plotly log-transforms them for the log axis).
    const optSpots = optv3OptResult.spot_ladder || spots;
    const beforeCurve = optv3OptResult.before.payoff_by_horizon["0"];
    if (beforeCurve) traces.push({ x: optSpots, y: beforeCurve, mode: "lines", name: "Before (current book)", hovertemplate: HT, line: { color: C.before, width: 2, dash: "dash" } });
    // After reflects only the *selected* replacement trades (checkboxes below).
    const afterCurve = optv3AfterSelectedCurve() || optv3OptResult.after.payoff_by_horizon["0"];
    const nTot = (optv3Replacements || []).length;
    const nSel = nTot - (optv3ReplDeselected ? optv3ReplDeselected.size : 0);
    const nLegs = (optv3ManualLegs || []).filter(l => l._on).length;
    let afterName = (nTot && nSel !== nTot) ? `After (selected ${nSel}/${nTot} trades)` : "After (with proposed trades)";
    if (nLegs) afterName += ` + ${nLegs} leg${nLegs === 1 ? "" : "s"}`;
    if (afterCurve) traces.push({ x: optSpots, y: afterCurve, mode: "lines", name: afterName, hovertemplate: HT, line: { color: C.after, width: 3 }, fill: "tozeroy", fillcolor: C.afterFill });
    if (optv3OptResult.target_payoff) {
      const spotIdx = optv2NearestIdx(optSpots, S0);
      const targetAtSpot = optv3OptResult.target_payoff[spotIdx];
      const targetCurve = optv3OptResult.target_payoff.map(v => v - targetAtSpot);
      traces.push({ x: optSpots, y: targetCurve, mode: "lines", name: "Target", hovertemplate: HT, line: { color: C.target, width: 2, dash: "dot" } });
    }
  } else {
    // Sequential ramp (bright = Now, fading into the future) — a proper time
    // encoding instead of a rainbow.
    OPTV2_HORIZONS.forEach((h, k) => {
      const hKey = String(h);
      const totalPayoff = new Array(spots.length).fill(0);
      let hasData = false;
      positions.forEach(p => { const curve = p.payoff_by_horizon[hKey]; if (curve) { hasData = true; for (let i = 0; i < curve.length; i++) totalPayoff[i] += curve[i]; } });
      if (!hasData) return;
      const isNow = h === 0;
      traces.push({
        x: spots, y: totalPayoff, mode: "lines",
        name: isNow ? "Now (current book)" : `T+${h}d`,
        hovertemplate: HT,
        line: { color: C.ramp[k] || "#8b949e", width: isNow ? 3 : 1.5 },
        ...(isNow ? { fill: "tozeroy", fillcolor: C.afterFill } : {}),
      });
    });
  }

  // What-if: book payoff (Now) excluding the ticked roll candidates — the unwind
  // preview. Lets you compare the book with vs. without the ITM/selected trades.
  if (typeof optv3RollSel !== "undefined" && optv3RollSel && optv3RollSel.size) {
    const excl = new Array(spots.length).fill(0);
    let any = false;
    positions.forEach(p => {
      const curve = p.payoff_by_horizon && p.payoff_by_horizon["0"];
      if (!curve) return;
      if (!optv3RollSel.has(p.id)) { for (let i = 0; i < curve.length; i++) excl[i] += curve[i]; }
      else any = true;
    });
    if (any) traces.push({ x: spots, y: excl, mode: "lines", name: "Book excl. ticked unwinds (Now)", hovertemplate: HT, line: { color: C.excl, width: 2, dash: "dashdot" } });
  }

  // Break-even line (y=0) — recessive, no hover.
  traces.push({ x: [spots[0], spots[spots.length - 1]], y: [0, 0], mode: "lines", name: "Break-even", line: { color: C.zero, dash: "dot", width: 1 }, showlegend: false, hoverinfo: "skip" });

  // Vertical line at the current spot — thin, semi-transparent, no hover.
  let yLo = 0, yHi = 0;
  traces.forEach(t => { if (Array.isArray(t.y)) t.y.forEach(v => { if (typeof v === "number" && isFinite(v)) { if (v < yLo) yLo = v; if (v > yHi) yHi = v; } }); });
  traces.push({ x: [S0, S0], y: [yLo, yHi], mode: "lines", name: "Spot", line: { color: C.spot, width: 1.5, dash: "dot" }, showlegend: false, hoverinfo: "skip" });
  traces.push({ x: [S0], y: [0], mode: "markers", name: `${assetLabel} Spot`, hovertemplate: `${assetLabel} spot: $${fmtPrice(S0)}<extra></extra>`, marker: { color: C.spotDot, size: 9, symbol: "diamond" } });

  const layout = optv3ChartLayout({
    title: optv3OptResult ? "Payoff at Now — Before vs After vs Target" : `Portfolio payoff — current book across horizons`,
    assetLabel, C,
  });
  Plotly.newPlot("optv3-payoff-chart", traces, layout, { responsive: true, displaylogo: false });
}

// Shared chart palette (coherent, semi-transparent) + layout for the v3 charts.
function optv3ChartColors() {
  return {
    before: "#e5737e",                       // current book — soft red, dashed
    after:  "#4fc3f7",                       // resulting book — cyan
    afterFill: "rgba(79,195,247,0.08)",      // faint area under the primary curve
    target: "#ffca28",                       // target — amber, dotted
    excl:   "#b388ff",                       // what-if excl. unwinds — violet
    spot:   "rgba(255,202,40,0.45)",         // spot rule — faint amber
    spotDot: "#ffca28",
    zero:   "rgba(230,237,243,0.18)",        // break-even — faint
    grid:   "rgba(139,148,158,0.12)",        // recessive grid
    // sequential cyan ramp: Now (bright) → T+90 (dim)
    ramp: ["#8fe1ff", "#4fc3f7", "#35a3d6", "#2a80ac", "#1f5f83", "#164a68", "#0e3550"],
  };
}

function optv3ChartLayout({ title, assetLabel, C, height }) {
  return {
    title: { text: title, font: { color: "#e6edf3", size: 15 } },
    hovermode: "x unified",
    hoverlabel: { bgcolor: "#161b22", bordercolor: "#30363d", font: { color: "#e6edf3", size: 11 } },
    xaxis: {
      title: `${assetLabel} Spot (USD, log scale)`,
      type: "log", tickprefix: "$", exponentformat: "none", separatethousands: true,
      xhoverformat: "$,.0f", color: "#8b949e", gridcolor: C.grid, zeroline: false,
    },
    yaxis: { title: "P&L from today (USD)", tickformat: "$,.0f", zeroline: true, zerolinecolor: "rgba(248,81,73,0.55)", zerolinewidth: 1, color: "#8b949e", gridcolor: C.grid },
    paper_bgcolor: "#161b22", plot_bgcolor: "#0d1117", font: { color: "#e0e0e0" },
    legend: { font: { color: "#8b949e", size: 11 }, orientation: "h", y: -0.22, bgcolor: "rgba(0,0,0,0)" },
    margin: { t: 46, b: 72, l: 84, r: 24 },
  };
}

// Preview P&L matrix (before) — faithful copy of optv2RenderMatrix on v3 ids.
function optv3RenderMatrix() {
  const spots = optv3Data.spot_ladder;
  const positions = optv3ActivePositions();
  const ethSpot = optv3Data.eth_spot;
  if (!positions.length) return;

  const $thead = document.getElementById("optv3-matrix-thead");
  $thead.innerHTML = "";
  const headRow = document.createElement("tr");
  headRow.innerHTML = "<th>ETH Spot</th>";
  OPTV2_HORIZONS.forEach(h => { const th = document.createElement("th"); th.textContent = h === 0 ? "Now" : `${h}d`; headRow.appendChild(th); });
  $thead.appendChild(headRow);

  const $tbody = document.getElementById("optv3-matrix-tbody");
  $tbody.innerHTML = "";
  const nearestIdx = optv2NearestIdx(spots, ethSpot);
  const displayIdx = optv2MatrixDisplayIdx(spots);
  displayIdx.forEach((si) => {
    const s = spots[si];
    const tr = document.createElement("tr");
    if (si === nearestIdx) tr.classList.add("row-highlight");
    const tdSpot = document.createElement("td");
    tdSpot.textContent = "$" + optv2Fmt(s, optv3Dp()); tdSpot.style.fontWeight = "600";
    tr.appendChild(tdSpot);
    OPTV2_HORIZONS.forEach(h => {
      const hKey = String(h);
      let cellVal = 0;
      positions.forEach(p => { const curve = p.payoff_by_horizon[hKey]; if (curve && curve[si] !== undefined) cellVal += curve[si]; });
      const td = document.createElement("td");
      td.textContent = Math.round(cellVal).toLocaleString(); td.style.textAlign = "right";
      if (cellVal > 0) td.style.color = "#66bb6a";
      if (cellVal < 0) td.style.color = "#ef5350";
      tr.appendChild(td);
    });
    $tbody.appendChild(tr);
  });
}

// ── Roll candidates: tick-to-unwind selection. Previews on the payoff chart
// (a "Book excl. ticked unwinds" line) and drives exactly what the optimizer
// rolls on the next Run (roll_dte_threshold = -1 + forced_roll_ids). ─────────
let optv3RollSel = new Set();   // ticked position ids
let optv3RollCandSig = "";      // signature of the current candidate set (to re-default ITM)

// Positions eligible to roll: DTE <= threshold (or all if threshold = -1), in
// the selected counterparty scope. Each tagged with _itm (call: K<spot, put: K>spot).
// Per-counterparty roll-DTE map from the GUI inputs (empty input = exclude that
// counterparty). {counterparty: dte}.
function optv3DteMap() {
  const box = document.getElementById("optv3-dte-list");
  const m = {};
  if (!box) return m;
  box.querySelectorAll(".optv3-dte-input").forEach(i => {
    if (!i.dataset.cpty) return;
    if (i.value === "" || i.value == null) { m[i.dataset.cpty] = null; return; }  // present but cleared → excluded
    const v = parseInt(i.value, 10);
    m[i.dataset.cpty] = Number.isNaN(v) ? null : v;
  });
  return m;
}

// Roll candidates: a position is eligible if its DTE <= its counterparty's
// threshold (per-counterparty inputs, falling back to the global default). -1 =
// roll all of that counterparty's trades. Also honours the counterparty scope.
function optv3RollCandidates() {
  if (!optv3Data) return [];
  const gRaw = document.getElementById("optv3-roll-dte-threshold")?.value;
  const gThr = (gRaw === "" || gRaw == null) ? null : parseInt(gRaw, 10);
  const dteMap = optv3DteMap();
  const spot = optv3Data.eth_spot || 0;
  const cptySel = document.getElementById("optv3-counterparties");
  const scope = new Set(cptySel ? Array.from(cptySel.selectedOptions).map(o => o.value).filter(v => v && v !== "ALL") : []);
  return optv3ActivePositions().filter(p => {
    const opt = String(p.opt || "");
    if (!["C", "P", "F"].includes(opt)) return false;
    if (scope.size && !scope.has(p.counterparty)) return false;
    // Per-counterparty DTE threshold, else the global default.
    let thr = Object.prototype.hasOwnProperty.call(dteMap, p.counterparty) ? dteMap[p.counterparty] : gThr;
    if (thr == null || Number.isNaN(thr)) return false;   // no threshold for this cpty → not a candidate
    if (thr === -1) return true;
    const dte = Number(p.days_remaining);
    return Number.isFinite(dte) && dte <= thr;
  }).map(p => {
    const opt = String(p.opt || "");
    const itm = (opt === "C" && p.strike < spot) || (opt === "P" && p.strike > spot);
    return Object.assign({ _itm: itm }, p);
  });
}

// Render one editable Roll-DTE input per counterparty in the loaded book,
// seeded from the global default; preserves any value the user already typed.
function optv3RenderDteList() {
  const box = document.getElementById("optv3-dte-list");
  if (!box || !optv3Data) return;
  const cps = [...new Set((optv3Data.positions || []).map(p => p.counterparty).filter(Boolean))].sort();
  const gRaw = document.getElementById("optv3-roll-dte-threshold")?.value;
  const def = (gRaw === "" || gRaw == null) ? "" : gRaw;
  const prev = {};
  box.querySelectorAll(".optv3-dte-input").forEach(i => { prev[i.dataset.cpty] = i.value; });
  box.innerHTML = cps.length ? cps.map(cp => {
    const v = prev[cp] != null ? prev[cp] : def;
    return `<div class="optv3-field"><label>${cp}<input type="number" class="optv3-dte-input" data-cpty="${cp}" value="${v}" step="1" min="-1" style="width:5rem" title="Roll ${cp} trades with DTE ≤ this. Clear to exclude ${cp}. -1 = roll all ${cp} trades."></label></div>`;
  }).join("") : '<p class="optv3-hint" style="margin:0">Load the risk profile to list counterparties.</p>';
}

function optv3RenderRollCandidates() {
  const tbody = document.getElementById("optv3-rollcand-tbody");
  const grid = document.getElementById("optv3-trades-under-chart");
  const count = document.getElementById("optv3-rollcand-count");
  if (!tbody) return;
  const cands = optv3RollCandidates();
  if (grid) grid.style.display = (cands.length || optv3OptResult) ? "" : "none";

  // Re-default the ticked set to the ITM candidates whenever the candidate set changes.
  const sig = cands.map(c => c.id).sort((a, b) => a - b).join(",");
  if (sig !== optv3RollCandSig) {
    optv3RollCandSig = sig;
    optv3RollSel = new Set(cands.filter(c => c._itm).map(c => c.id));
  }
  if (count) count.textContent = cands.length ? `(${optv3RollSel.size}/${cands.length} ticked)` : "";

  // Right column placeholder until a run produces new trades.
  const repl = document.getElementById("optv3-replacement-tbody");
  if (repl && !optv3OptResult) repl.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--muted);padding:1.5rem">Run the optimizer to see replacement / new trades.</td></tr>';

  if (!cands.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:1.5rem">No roll candidates at this DTE threshold.</td></tr>';
    optv3RenderPayoff();
    return;
  }

  const rows = [...cands].sort((a, b) => (Number(a.days_remaining) - Number(b.days_remaining)) || (a.strike - b.strike));
  const money = v => (v >= 0 ? "$" : "-$") + optv2Fmt(Math.abs(v), 0);
  tbody.innerHTML = rows.map(c => {
    const long = c.net_qty >= 0;
    const mtm = c.current_mtm || 0;
    const itmBadge = c._itm ? '<span style="color:var(--green);font-weight:600">ITM</span>' : '<span style="color:var(--muted)">—</span>';
    return `<tr>
      <td><input type="checkbox" class="optv3-rollcand-cb" data-id="${c.id}" ${optv3RollSel.has(c.id) ? "checked" : ""}></td>
      <td>${c.instrument || ""}</td>
      <td>${String(c.expiry || "").slice(0, 10)}</td>
      <td class="num">${optv2Fmt(c.strike, optv3Dp())}</td>
      <td>${optv2OptType(c.opt)}</td>
      <td style="color:${long ? "var(--green)" : "var(--red)"}">${long ? "Long" : "Short"}</td>
      <td class="num">${optv2Fmt(Math.abs(c.net_qty), 0)}</td>
      <td class="num">${c.days_remaining ?? "—"}</td>
      <td>${itmBadge}</td>
      <td class="num" style="color:${mtm >= 0 ? "var(--green)" : "var(--red)"}">${money(mtm)}</td>
    </tr>`;
  }).join("");

  // Totals row for the ticked set — total qty + total cost to unwind (Σ MTM).
  const ticked = rows.filter(c => optv3RollSel.has(c.id));
  const totQty = ticked.reduce((s, c) => s + Math.abs(Number(c.net_qty) || 0), 0);
  const totMtm = ticked.reduce((s, c) => s + (Number(c.current_mtm) || 0), 0);
  const tr = document.createElement("tr");
  tr.className = "row-highlight"; tr.style.fontWeight = "600";
  tr.innerHTML = `<td></td><td colspan="5">Ticked to unwind (${ticked.length})</td>`
    + `<td class="num">${optv2Fmt(totQty, 0)}</td><td></td><td></td>`
    + `<td class="num" style="color:${totMtm >= 0 ? "var(--green)" : "var(--red)"}">${money(totMtm)}</td>`;
  tbody.appendChild(tr);

  tbody.querySelectorAll(".optv3-rollcand-cb").forEach(cb => cb.addEventListener("change", () => {
    const id = Number(cb.dataset.id);
    if (cb.checked) optv3RollSel.add(id); else optv3RollSel.delete(id);
    optv3RenderRollCandidates();
  }));
  const allCb = document.getElementById("optv3-rollcand-all");
  if (allCb) {
    allCb.checked = ticked.length === rows.length && rows.length > 0;
    allCb.onchange = () => {
      if (allCb.checked) rows.forEach(c => optv3RollSel.add(c.id)); else rows.forEach(c => optv3RollSel.delete(c.id));
      optv3RenderRollCandidates();
    };
  }

  optv3RenderPayoff();  // refresh the "Book excl. ticked unwinds" what-if line
}

// Render optimization result into the v3 KPI row + tabbed detail.
function optv3RenderResult(data) {
  if (data.status !== "ok") { alert(data.message || "Optimization returned no results."); return; }

  document.getElementById("optv3-result-kpi").style.display = "";
  const $tradesUnder = document.getElementById("optv3-trades-under-chart");
  if ($tradesUnder) $tradesUnder.style.display = "";  // reveal unwind/new under the chart
  optv3OptResult = data;
  optv3RenderPayoff();  // now overlays before/after/target

  document.getElementById("optv3-result-status").textContent = data.optimizer_converged ? "Converged" : "Did not converge";

  const $warn = document.getElementById("optv3-warnings");
  if (data.message) { $warn.style.display = ""; $warn.textContent = data.message; } else { $warn.style.display = "none"; }

  const unwinds = data.roll_unwind_trades || [];
  const replacements = data.replacement_trades || [];
  const allTrades = data.trades || [];
  const ps = data.premium_summary || {};

  document.getElementById("optv3-sum-unwind").textContent = unwinds.length;
  document.getElementById("optv3-sum-replacement").textContent = replacements.length;
  const netPrem = data.net_premium_generated ?? ps.net_premium_generated ?? 0;
  const $netPrem = document.getElementById("optv3-sum-net-premium");
  $netPrem.textContent = (netPrem >= 0 ? "+$" : "-$") + optv2Fmt(Math.abs(netPrem), 0);
  $netPrem.style.color = netPrem >= 0 ? "var(--green)" : "var(--red)";
  const cash = data.cash_shift || 0;
  document.getElementById("optv3-sum-cash-shift").textContent = (cash >= 0 ? "+$" : "-$") + optv2Fmt(Math.abs(cash), 0);
  const fitBefore = data.fit_error_before, fitAfter = data.fit_error_after;
  const $fit = document.getElementById("optv3-sum-fit");
  if (fitBefore != null && fitAfter != null) {
    const pct = fitBefore > 0 ? (100 * (fitBefore - fitAfter) / fitBefore) : 0;
    $fit.textContent = optv2Fmt(pct, 1) + "%";
    $fit.style.color = pct >= 0 ? "var(--green)" : "var(--red)";
  } else { $fit.textContent = "—"; }
  document.getElementById("optv3-candidates").textContent = data.candidates_evaluated ?? "—";
  document.getElementById("optv3-sum-prem-sold").textContent = "$" + optv2Fmt(ps.gross_premium_sold || 0, 0);
  document.getElementById("optv3-sum-prem-bought").textContent = "$" + optv2Fmt(ps.gross_premium_bought || 0, 0);
  document.getElementById("optv3-sum-target-expiry").textContent = data.target_expiry || "All";
  // Per-counterparty transaction cost + after-execution MTM (net of cost) —
  // same figures the v2 screen shows; the pricing itself is applied by the
  // shared engine on every v3 run.
  const $cost = document.getElementById("optv3-sum-cost");
  if ($cost) $cost.textContent = data.total_cost_usd != null ? "$" + optv2Fmt(data.total_cost_usd, 0) : "—";
  const $am = document.getElementById("optv3-sum-after-mtm");
  if ($am) {
    if (data.after_book_mtm != null) {
      const am = data.after_book_mtm;
      $am.textContent = (am >= 0 ? "$" : "-$") + optv2Fmt(Math.abs(am), 0);
      $am.style.color = am >= 0 ? "var(--green)" : "var(--red)";
    } else { $am.textContent = "—"; $am.style.color = ""; }
  }

  // Cash flow by counterparty
  const $cashBody = document.getElementById("optv3-cash-flow-tbody");
  const $cashEmpty = document.getElementById("optv3-cash-empty");
  const cashByCp = data.cash_by_counterparty || {};
  const cps = Object.keys(cashByCp);
  if (cps.length) {
    if ($cashEmpty) $cashEmpty.style.display = "none";
    $cashBody.innerHTML = cps.sort().map(cp => {
      const v = cashByCp[cp]; const net = v.net || 0;
      return `<tr><td>${cp}</td><td class="num">$${optv2Fmt(v.outlay || 0, 0)}</td>`
        + `<td class="num">$${optv2Fmt(v.collection || 0, 0)}</td>`
        + `<td class="num" style="color:${net >= 0 ? "var(--red)" : "var(--green)"}">${net >= 0 ? "+$" : "-$"}${optv2Fmt(Math.abs(net), 0)}</td></tr>`;
    }).join("");
  } else {
    $cashBody.innerHTML = "";
    if ($cashEmpty) $cashEmpty.style.display = "";
  }

  // Matrix note + before/after matrices (reuse the shared renderer)
  const $mtmNote = document.getElementById("optv3-matrix-mtm-note");
  if ($mtmNote) {
    if (data.current_book_mtm != null) {
      const mtm = data.current_book_mtm;
      let noteHtml = `Both matrices show P&amp;L <b>from today</b>, not absolute value — current book MTM is `
        + `<b style="color:${mtm >= 0 ? "var(--green)" : "var(--red)"}">${mtm >= 0 ? "+$" : "-$"}${optv2Fmt(Math.abs(mtm), 0)}</b> `
        + `(the implicit $0 anchor at Now / current spot).`;
      // After-execution book MTM, net of the assumed per-counterparty trading
      // cost (deliberately NOT netted into the curves — a one-time cost cancels
      // out of a P&L-relative-to-now comparison).
      if (data.after_book_mtm != null && data.total_cost_usd != null) {
        const am = data.after_book_mtm;
        noteHtml += ` After executing the proposed trades (net of ~$${optv2Fmt(data.total_cost_usd, 0)} `
          + `assumed transaction cost), book MTM would be <b style="color:${am >= 0 ? "var(--green)" : "var(--red)"}">`
          + `${am >= 0 ? "+$" : "-$"}${optv2Fmt(Math.abs(am), 0)}</b>.`;
      }
      $mtmNote.innerHTML = noteHtml;
    } else { $mtmNote.textContent = ""; }
  }
  if (data.before && data.before.payoff_by_horizon) {
    optv2RenderCompareMatrix(data, "before", "optv3-matrix-thead", "optv3-matrix-tbody");
  }
  optv3RenderAfterMatrix();

  // Target profile table (payoff-at-Now: Before / After / Target)
  optv3RenderProfileTable();

  // Structures
  const $structEmpty = document.getElementById("optv3-structures-empty");
  if ($structEmpty) $structEmpty.style.display = allTrades.length ? "none" : "";
  optv2RenderStrategyGroups(allTrades, "optv3-strategy-groups");

  // Trades to unwind are shown by the interactive Roll-candidates panel (left of
  // the chart), which persists the ticked selection that drove this run.
  optv3RenderRollCandidates();

  // Replacement / new table — each row has a checkbox to include/exclude it from
  // the "After (selected)" payoff line above. Default: all selected.
  optv3Replacements = replacements.map((t, i) => {
    t._idx = i;
    t._qty0 = Number(t.qty) || 0;   // original signed qty from the optimizer
    t._qty = t._qty0;               // current (editable) signed qty
    return t;
  });
  optv3ReplDeselected = new Set();
  optv2RenderTradeTable("optv3-replacement-tbody", replacements, "optv3-replacement-count",
    (t) => [
      `<td><input type="checkbox" class="optv3-repl-cb" data-idx="${t._idx}" checked></td>`,
      `<td>${t.instrument}</td>`, `<td>${optv2ExpiryText(t)}</td>`, `<td class="num">${optv2Fmt(t.strike, optv3Dp())}</td>`,
      `<td>${optv2OptType(t.opt)}</td>`,
      `<td style="color:${t.side === "Buy" ? "var(--green)" : "var(--red)"}">${t.side}</td>`,
      `<td class="num"><input class="optv3-repl-qty" data-idx="${t._idx}" type="number" min="0" step="1" value="${Math.abs(t.qty)}" style="width:5rem;text-align:right" title="Adjust this trade's size — the After curve & P&L matrix update live"></td>`,
      `<td class="num">${optv2Fmt(t.bs_price_usd, 2)}</td>`,
      `<td class="num">${optv2Fmt(t.notional, 0)}</td>`, `<td class="num">${optv2Fmt(t.cost_usd, 0)}</td>`,
      `<td>${optv2StrategyLabel(t.strategy)}</td>`,
      `<td>${t.counterparty || "—"}</td>`, `<td>${t.rolled_from ? "rolled from " + t.rolled_from : ""}</td>`,
    ], 13, "No replacement or new trades proposed.");

  // Totals row (leading blank for the checkbox column).
  optv3AppendTradeTotals("optv3-replacement-tbody", replacements, [
    {},                                               // checkbox column
    { colspan: 5, label: "Total new / replacement" },
    { key: t => Math.abs(Number(t.qty) || 0) },       // Qty
    {},                                               // Price (blank)
    { key: t => Number(t.notional) || 0 },            // Value ($)
    { key: t => Number(t.cost_usd) || 0 },            // Cost ($)
    { colspan: 3 },                                   // Strategy / Counterparty / Comment
  ]);
  optv3WireReplCheckboxes();
}

// ── Replacement-trade selection: tick to include a suggested trade in the
// "After (selected)" payoff line. Recomputed client-side (BS) so it's live. ──
let optv3Replacements = [];
let optv3ReplDeselected = new Set();

function optv3WireReplCheckboxes() {
  const tb = document.getElementById("optv3-replacement-tbody");
  if (!tb) return;
  tb.querySelectorAll(".optv3-repl-cb").forEach(cb => cb.addEventListener("change", () => {
    const idx = Number(cb.dataset.idx);
    if (cb.checked) optv3ReplDeselected.delete(idx); else optv3ReplDeselected.add(idx);
    const all = document.getElementById("optv3-repl-all");
    if (all) all.checked = optv3ReplDeselected.size === 0;
    optv3RenderPayoff();
    optv3RenderAfterMatrix();
  }));
  const all = document.getElementById("optv3-repl-all");
  if (all) {
    all.checked = optv3ReplDeselected.size === 0;
    all.onchange = () => {
      optv3ReplDeselected = new Set();
      if (!all.checked) (optv3Replacements || []).forEach(t => optv3ReplDeselected.add(t._idx));
      tb.querySelectorAll(".optv3-repl-cb").forEach(cb => { cb.checked = !optv3ReplDeselected.has(Number(cb.dataset.idx)); });
      optv3RenderPayoff();
      optv3RenderAfterMatrix();
    };
  }
  // Editable trade sizes: adjust a suggested trade's qty → live After curve/matrix.
  tb.querySelectorAll(".optv3-repl-qty").forEach(inp => inp.addEventListener("input", () => {
    const t = (optv3Replacements || []).find(x => x._idx === Number(inp.dataset.idx));
    if (!t) return;
    const absQ = Math.abs(parseFloat(inp.value));
    const sign = (t._qty0 || 0) < 0 ? -1 : 1;   // preserve buy/sell direction
    t._qty = Number.isFinite(absQ) ? sign * absQ : 0;
    optv3RenderPayoff();
    optv3RenderAfterMatrix();
  }));
}

// One trade's P&L-from-today curve across `spots` at horizon `h` days (0 at S0) —
// matches the engine's After-curve basis (raw BS value minus the trade's premium).
// Time decays by h days; perps are horizon-independent.
function optv3TradePnlNow(t, spots, S0, h = 0, qtyOverride) {
  const qty = (qtyOverride != null ? Number(qtyOverride) : Number(t.qty)) || 0;  // signed
  const K = Number(t.strike) || 0;
  const opt = String(t.opt || "").toUpperCase();
  const price = Number(t.bs_price_usd) || 0;
  if (opt === "F" || opt === "PERP") return spots.map(s => qty * (s - S0));
  const sigma = (Number(t.iv_pct) || Number(t.mark_iv) || 0) / 100;
  const T = Math.max((Number(t.dte) || 0) - (Number(h) || 0), 0) / 365.25;
  return spots.map(s => {
    let val;
    if (T <= 0 || sigma <= 0) val = opt === "C" ? Math.max(s - K, 0) : Math.max(K - s, 0);
    else val = bsPrice(s, K, T, 0, sigma, opt);
    return qty * (val - price);
  });
}

// After payoff at horizon `h` including only the *selected* replacement trades:
// subtract each deselected trade's contribution from the full After curve at h.
function optv3AfterSelectedAtHorizon(hKey) {
  const r = optv3OptResult;
  const base = r && r.after && r.after.payoff_by_horizon && r.after.payoff_by_horizon[hKey];
  if (!base) return null;
  const legs = (optv3ManualLegs || []).filter(l => l._on);
  const spots = r.spot_ladder || [];
  const S0 = (r.eth_spot != null ? r.eth_spot : (optv3Data && optv3Data.eth_spot)) || 0;
  const out = base.slice();
  const h = Number(hKey) || 0;
  // For each optimizer replacement, `after_full` already contains it at its
  // ORIGINAL qty; apply the delta to its EFFECTIVE qty (0 if deselected, else the
  // possibly-edited size).
  (optv3Replacements || []).forEach(t => {
    const q0 = (t._qty0 != null ? t._qty0 : Number(t.qty)) || 0;
    const qEff = optv3ReplDeselected.has(t._idx) ? 0 : ((t._qty != null ? t._qty : q0) || 0);
    if (qEff === q0) return;
    const cEff = optv3TradePnlNow(t, spots, S0, h, qEff);
    const c0 = optv3TradePnlNow(t, spots, S0, h, q0);
    for (let i = 0; i < out.length && i < c0.length; i++) out[i] += cEff[i] - c0[i];
  });
  // Add each enabled user-created leg (at its current qty).
  legs.forEach(l => {
    const c = optv3TradePnlNow(l, spots, S0, h);
    for (let i = 0; i < out.length && i < c.length; i++) out[i] += c[i];
  });
  return out;
}

// Horizon-0 After curve for the payoff chart.
function optv3AfterSelectedCurve() {
  const r = optv3OptResult;
  if (!r || r.status !== "ok" || !r.after || !r.after.payoff_by_horizon) return null;
  return optv3AfterSelectedAtHorizon("0");
}

// ── Manual leg builder: user-created what-if legs added to the After curve/matrix.
let optv3ManualLegs = [];
let optv3LegSeq = 0;

function optv3PopulateLegExpiries() {
  const sel = document.getElementById("optv3-leg-expiry");
  if (!sel || !optv3Data) return;
  const vs = (optv3Data.vol_surface || []).filter(s => s.dte > 0).sort((a, b) => a.dte - b.dte);
  sel.innerHTML = '<option value="">Expiry…</option>'
    + vs.map(s => {
      const iv = (s.atm_iv != null ? s.atm_iv : (s.iv != null ? s.iv : ""));
      return `<option value="${s.expiry_code}" data-dte="${s.dte}" data-iv="${iv}">${s.expiry_code} (${s.dte}d)</option>`;
    }).join("");
}

function optv3RefreshAfterWhatIf() {
  optv3RenderPayoff();
  optv3RenderAfterMatrix();
}

function optv3AddManualLeg() {
  if (!optv3Data) { alert("Load the risk profile first."); return; }
  const S0 = optv3Data.eth_spot || 0;
  const side = document.getElementById("optv3-leg-side").value;
  const opt = document.getElementById("optv3-leg-type").value;   // C / P
  const K = parseFloat(document.getElementById("optv3-leg-strike").value);
  const expSel = document.getElementById("optv3-leg-expiry");
  const exp = expSel.value;
  const dte = expSel.selectedOptions[0] ? Number(expSel.selectedOptions[0].dataset.dte) : NaN;
  const qtyAbs = Math.abs(parseFloat(document.getElementById("optv3-leg-qty").value));
  let iv = parseFloat(document.getElementById("optv3-leg-iv").value);
  if (!isFinite(K) || K <= 0) { alert("Enter a valid strike."); return; }
  if (!exp || !isFinite(dte)) { alert("Pick an expiry."); return; }
  if (!isFinite(qtyAbs) || qtyAbs <= 0) { alert("Enter a quantity."); return; }
  if (!isFinite(iv) || iv <= 0) {
    const d = expSel.selectedOptions[0] && expSel.selectedOptions[0].dataset.iv;
    iv = d ? Number(d) : 60;   // fall back to the expiry's ATM IV, else 60%
  }
  const qty = side === "buy" ? qtyAbs : -qtyAbs;   // signed
  const sigma = iv / 100;
  const T = Math.max(dte, 0) / 365.25;
  const price = (T > 0 && sigma > 0) ? bsPrice(S0, K, T, 0, sigma, opt)
    : (opt === "C" ? Math.max(S0 - K, 0) : Math.max(K - S0, 0));
  optv3ManualLegs.push({
    _mid: ++optv3LegSeq, _on: true,
    side: side === "buy" ? "Buy" : "Sell", opt, strike: K, qty,
    dte, iv_pct: iv, expiry_code: exp, bs_price_usd: price,
  });
  document.getElementById("optv3-leg-qty").value = "";
  optv3RenderManualLegs();
  optv3RefreshAfterWhatIf();
}

function optv3RenderManualLegs() {
  const tb = document.getElementById("optv3-manual-legs-tbody");
  const wrap = document.getElementById("optv3-manual-legs-wrap");
  if (!tb) return;
  if (!optv3ManualLegs.length) { if (wrap) wrap.style.display = "none"; tb.innerHTML = ""; return; }
  if (wrap) wrap.style.display = "";
  const dp = optv3Dp();
  tb.innerHTML = optv3ManualLegs.map(l => `<tr>
    <td><input type="checkbox" class="optv3-leg-cb" data-mid="${l._mid}" ${l._on ? "checked" : ""}></td>
    <td style="color:${l.side === "Buy" ? "var(--green)" : "var(--red)"}">${l.side}</td>
    <td>${optv2OptType(l.opt)}</td>
    <td class="num">${optv2Fmt(l.strike, dp)}</td>
    <td>${l.expiry_code}</td>
    <td class="num"><input class="optv3-leg-qty-edit" data-mid="${l._mid}" type="number" min="0" step="1" value="${Math.abs(l.qty)}" style="width:5rem;text-align:right" title="Adjust leg size — updates the After curve & P&L matrix live"></td>
    <td class="num">${optv2Fmt(l.iv_pct, 1)}</td>
    <td><button class="btn-secondary optv3-leg-rm" data-mid="${l._mid}" style="width:auto;padding:.1rem .45rem" title="Remove leg">✕</button></td>
  </tr>`).join("");
  tb.querySelectorAll(".optv3-leg-cb").forEach(cb => cb.addEventListener("change", () => {
    const leg = optv3ManualLegs.find(l => l._mid === Number(cb.dataset.mid));
    if (leg) leg._on = cb.checked;
    const all = document.getElementById("optv3-leg-all"); if (all) all.checked = optv3ManualLegs.every(l => l._on);
    optv3RefreshAfterWhatIf();
  }));
  tb.querySelectorAll(".optv3-leg-rm").forEach(b => b.addEventListener("click", () => {
    optv3ManualLegs = optv3ManualLegs.filter(l => l._mid !== Number(b.dataset.mid));
    optv3RenderManualLegs(); optv3RefreshAfterWhatIf();
  }));
  tb.querySelectorAll(".optv3-leg-qty-edit").forEach(inp => inp.addEventListener("input", () => {
    const leg = optv3ManualLegs.find(l => l._mid === Number(inp.dataset.mid));
    if (!leg) return;
    const absQ = Math.abs(parseFloat(inp.value));
    const sign = leg.qty < 0 ? -1 : 1;   // preserve buy/sell
    leg.qty = Number.isFinite(absQ) ? sign * absQ : 0;
    optv3RefreshAfterWhatIf();
  }));
  const all = document.getElementById("optv3-leg-all");
  if (all) {
    all.checked = optv3ManualLegs.every(l => l._on);
    all.onchange = () => { optv3ManualLegs.forEach(l => l._on = all.checked); optv3RenderManualLegs(); optv3RefreshAfterWhatIf(); };
  }
}

// Build an optv3OptResult-shaped object whose `after.payoff_by_horizon` reflects
// only the selected trades, and (re)render the "After" P&L matrix from it.
function optv3RenderAfterMatrix() {
  const r = optv3OptResult;
  const $afterPanel = document.getElementById("optv3-matrix-after-panel");
  const $matrixGrid = document.getElementById("optv3-matrix-grid");
  if (!(r && r.after && r.after.payoff_by_horizon && $afterPanel && $matrixGrid)) return;
  const adj = {};
  Object.keys(r.after.payoff_by_horizon).forEach(hKey => {
    adj[hKey] = optv3AfterSelectedAtHorizon(hKey) || r.after.payoff_by_horizon[hKey];
  });
  const dataSel = Object.assign({}, r, { after: { payoff_by_horizon: adj } });
  $afterPanel.style.display = "";
  $matrixGrid.style.gridTemplateColumns = "1fr 1fr";
  optv2RenderCompareMatrix(dataSel, "after", "optv3-matrix-after-main-thead", "optv3-matrix-after-main-tbody");
}

// Append a bold totals row to a trade table already rendered by optv2RenderTradeTable.
// spec entries map to cells: {colspan?, label?} for a label cell, {key: fn} to sum
// a numeric column, {} for a blank cell, {colspan, } for a blank span.
function optv3AppendTradeTotals(tbodyId, rows, spec) {
  const tb = document.getElementById(tbodyId);
  if (!tb || !rows || !rows.length) return;
  const tr = document.createElement("tr");
  tr.className = "row-highlight";
  tr.style.fontWeight = "600";
  tr.innerHTML = spec.map(c => {
    const cs = c.colspan ? ` colspan="${c.colspan}"` : "";
    if (c.label != null) return `<td${cs}>${c.label} (${rows.length})</td>`;
    if (typeof c.key === "function") {
      const sum = rows.reduce((s, t) => s + (c.key(t) || 0), 0);
      return `<td class="num"${cs}>${optv2Fmt(sum, 0)}</td>`;
    }
    return `<td${cs}></td>`;
  }).join("");
  tb.appendChild(tr);
}

// ── Target Profile: editable table + smoothing + live chart preview ─────────
// The user can type target payoff values per spot (or smooth them), and the LP
// fits to those on the next Run (sent as manual_target). All values are at
// horizon 0 and anchored to $0 at the current spot — same basis as the chart.
let optv3ManualTarget = null;     // [{x: spot, y: payoff}, ...] control points, or null = auto
let optv3ProfileState = null;     // {spots, after, displayIdx} cached for live residual updates
let optv3AutoTargetProfile = null; // active target payoff aligned to optv3Data.spot_ladder (from /target-profile)
let optv3TargetProfileFile = "";   // selected saved-profile filename, or "" for parametric

// Where the profile table/chart get their curves: a run result if present, else
// the loaded book (so you can define a target before ever running).
function optv3ProfileSource() {
  if (optv3OptResult && optv3OptResult.status === "ok") {
    const r = optv3OptResult;
    const spots = r.spot_ladder || [];
    // Prefer the currently-selected/fetched profile (aligned to this ladder) so
    // changing the dropdown updates the shown target even after a run; fall back
    // to the target the run actually fit to.
    const autoTarget = (optv3AutoTargetProfile && optv3AutoTargetProfile.length === spots.length)
      ? optv3AutoTargetProfile : (r.target_payoff || null);
    return {
      spots,
      S0: (r.eth_spot != null ? r.eth_spot : (optv3Data && optv3Data.eth_spot)) || 0,
      before: r.before && r.before.payoff_by_horizon && r.before.payoff_by_horizon["0"],
      after: r.after && r.after.payoff_by_horizon && r.after.payoff_by_horizon["0"],
      autoTarget,
    };
  }
  if (optv3Data && optv3Data.spot_ladder) {
    const spots = optv3Data.spot_ladder;
    const ps = optv3ActivePositions();
    const before = spots.map((_, i) => ps.reduce((a, p) =>
      a + ((p.payoff_by_horizon && p.payoff_by_horizon["0"] && p.payoff_by_horizon["0"][i]) || 0), 0));
    // Default target = built-in parametric profile (fetched on Load), so it's
    // visible/editable before the first run.
    const autoTarget = (optv3AutoTargetProfile && optv3AutoTargetProfile.length === spots.length)
      ? optv3AutoTargetProfile : null;
    return { spots, S0: optv3Data.eth_spot || 0, before, after: null, autoTarget };
  }
  return null;
}

// Finer control-point grid for the editable target table: ladder points nearest
// each fixed price step (ETH $250 / FIL $0.25) so the curve can be shaped at
// ≤250-USD granularity, instead of the coarse ~14-row matrix thinning. Where the
// ladder itself is sparser than the step (deep wings), it follows the ladder.
function optv3TargetDisplayIdx(spots) {
  if (!spots || !spots.length) return [];
  const asset = (typeof currentAsset !== "undefined" && currentAsset) ? currentAsset : "ETH";
  const step = asset === "FIL" ? 0.25 : 250;
  const lo = spots[0], hi = spots[spots.length - 1];
  const idxs = new Set([0, spots.length - 1]);  // always include both ends
  for (let g = Math.ceil(lo / step) * step; g <= hi + 1e-9; g += step) {
    idxs.add(optv2NearestIdx(spots, g));
  }
  return [...idxs].sort((a, b) => a - b);
}

// Auto target, anchored to $0 at current spot (matches the display convention).
function optv3AutoTargetAnchored(src) {
  if (!src.autoTarget) return null;
  const at = src.autoTarget[optv2NearestIdx(src.spots, src.S0)] || 0;
  // Not floored at 0: a trough is, by definition, a point that reads worse
  // (more negative) than the anchor — clamping that away made the curve
  // structurally unable to show the exact dip shape these curves exist to
  // represent (both ETH's built-in target and any hand-shaped one).
  return src.autoTarget.map(v => v - at);
}

// Linear-interpolate the manual control points onto a spot array (or null).
function optv3ManualTargetInterp(spots) {
  if (!optv3ManualTarget || optv3ManualTarget.length < 2) return null;
  const pts = optv3ManualTarget;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return spots.map(s => {
    if (s <= xs[0]) return ys[0];
    if (s >= xs[xs.length - 1]) return ys[ys.length - 1];
    let i = 1; while (i < xs.length && xs[i] < s) i++;
    const x0 = xs[i - 1], x1 = xs[i], y0 = ys[i - 1], y1 = ys[i];
    return x1 === x0 ? y0 : y0 + (y1 - y0) * (s - x0) / (x1 - x0);
  });
}

function optv3RenderProfileTable() {
  const tbody = document.getElementById("optv3-profile-tbody");
  const empty = document.getElementById("optv3-profile-empty");
  const wrap = document.getElementById("optv3-profile-wrap");
  const toolbar = document.getElementById("optv3-target-toolbar");
  if (!tbody) return;
  const src = optv3ProfileSource();
  if (!src || !src.spots.length) {
    tbody.innerHTML = ""; optv3ProfileState = null;
    if (wrap) wrap.style.display = "none";
    if (toolbar) toolbar.style.display = "none";
    if (empty) { empty.style.display = ""; empty.textContent = "Load the risk profile to define a target."; }
    optv3RenderProfileChart();
    return;
  }
  if (empty) empty.style.display = "none";
  if (wrap) wrap.style.display = "";
  if (toolbar) toolbar.style.display = "";

  const spots = src.spots, S0 = src.S0;
  const spotIdx = optv2NearestIdx(spots, S0);
  const displayIdx = optv3TargetDisplayIdx(spots);
  const auto = optv3AutoTargetAnchored(src);
  const manualMap = optv3ManualTarget ? new Map(optv3ManualTarget.map(p => [p.x, p.y])) : null;
  optv3ProfileState = { spots, after: src.after, displayIdx };

  const cell = v => {
    if (v == null || isNaN(v)) return `<td class="num">—</td>`;
    const c = v > 0 ? "#66bb6a" : v < 0 ? "#ef5350" : "";
    return `<td class="num" style="color:${c}">${Math.round(v).toLocaleString()}</td>`;
  };

  tbody.innerHTML = displayIdx.map(si => {
    const s = spots[si];
    const b = src.before ? src.before[si] : null;
    const a = src.after ? src.after[si] : null;
    const tv = (manualMap && manualMap.has(s)) ? manualMap.get(s) : (auto ? auto[si] : 0);
    const resid = (a != null) ? a - tv : null;
    const hl = si === spotIdx ? ' class="row-highlight"' : '';
    return `<tr${hl}>`
      + `<td style="font-weight:600">$${optv2Fmt(s, optv3Dp())}</td>`
      + `${cell(b)}${cell(a)}`
      + `<td class="num"><input class="optv3-target-input" type="number" step="1000" data-x="${s}" value="${Math.round(tv)}"></td>`
      + `${cell(resid)}</tr>`;
  }).join("");

  tbody.querySelectorAll(".optv3-target-input").forEach(inp => inp.addEventListener("input", optv3OnTargetEdit));
  optv3RenderProfileChart();
  optv3UpdateTargetStatus();
}

// Rebuild the manual target from the current inputs; refresh chart + residuals live.
function optv3OnTargetEdit() {
  const inputs = document.querySelectorAll("#optv3-profile-tbody .optv3-target-input");
  optv3ManualTarget = Array.from(inputs)
    .map(i => ({ x: Number(i.dataset.x), y: Number(i.value) || 0 }))
    .filter(p => Number.isFinite(p.x))
    .sort((a, b) => a.x - b.x);
  optv3RenderProfileChart();
  optv3UpdateResiduals();
  optv3UpdateTargetStatus();
}

// Update just the After−Target column in place (no input rebuild → no focus loss).
function optv3UpdateResiduals() {
  const st = optv3ProfileState; if (!st) return;
  const rows = document.querySelectorAll("#optv3-profile-tbody tr");
  rows.forEach((tr, k) => {
    const si = st.displayIdx[k]; if (si == null) return;
    const a = st.after ? st.after[si] : null;
    const inp = tr.querySelector(".optv3-target-input");
    const tds = tr.querySelectorAll("td");
    const residTd = tds[tds.length - 1];
    if (!residTd) return;
    if (a == null || !inp) { residTd.textContent = "—"; residTd.style.color = ""; return; }
    const r = a - (Number(inp.value) || 0);
    residTd.textContent = Math.round(r).toLocaleString();
    residTd.style.color = r > 0 ? "#66bb6a" : r < 0 ? "#ef5350" : "";
  });
}

// Moving-average smooth over the current target control points.
function optv3SmoothTarget() {
  const st = optv3ProfileState; if (!st) return;
  const inputs = document.querySelectorAll("#optv3-profile-tbody .optv3-target-input");
  if (!inputs.length) return;
  const vals = Array.from(inputs).map(i => Number(i.value) || 0);
  const win = Math.max(1, Math.round(Number(document.getElementById("optv3-target-smooth-strength")?.value || 3)));
  const sm = vals.map((_, i) => {
    let s = 0, n = 0;
    for (let j = i - win; j <= i + win; j++) if (j >= 0 && j < vals.length) { s += vals[j]; n++; }
    return n ? s / n : vals[i];
  });
  optv3ManualTarget = Array.from(inputs)
    .map((inp, k) => ({ x: Number(inp.dataset.x), y: sm[k] }))
    .filter(p => Number.isFinite(p.x)).sort((a, b) => a.x - b.x);
  optv3RenderProfileTable();
}

function optv3ResetTarget() {
  // Back to the selected profile (or parametric): drop manual edits and reload it.
  optv3ManualTarget = null;
  optv3FetchTargetProfile();
}

function optv3UpdateTargetStatus() {
  const el = document.getElementById("optv3-target-status"); if (!el) return;
  const n = optv3ManualTarget ? optv3ManualTarget.length : 0;
  if (n >= 2) {
    el.textContent = `Manual target active (${n} points) — click Apply & Re-run to optimize to it.`;
    return;
  }
  const sel = document.getElementById("optv3-target-select");
  const label = sel && sel.value ? (sel.options[sel.selectedIndex]?.text || "saved profile") : null;
  el.textContent = label
    ? `Fitting to saved profile "${label}". Edit any Target cell — or Smooth — to override.`
    : "Using the parametric (auto) target. Pick a saved profile, or edit / Smooth the Target column.";
}

// Target-profile chart (Before / After / Target). Target = manual override if set.
function optv3RenderProfileChart() {
  const el = document.getElementById("optv3-profile-chart");
  if (!el) return;
  const src = optv3ProfileSource();
  if (!src || !src.spots.length) { el.style.display = "none"; return; }
  el.style.display = "";
  const spots = src.spots, S0 = src.S0;
  const assetLabel = (typeof currentAsset !== "undefined" && currentAsset) ? currentAsset : "ETH";
  const manual = optv3ManualTargetInterp(spots);
  const auto = optv3AutoTargetAnchored(src);
  const targetCurve = manual || auto;
  const C = optv3ChartColors();
  const HT = "%{fullData.name}: %{y:$,.0f}<extra></extra>";

  const traces = [];
  if (src.before) traces.push({ x: spots, y: src.before, mode: "lines", name: "Before (current book)", hovertemplate: HT, line: { color: C.before, width: 2, dash: "dash" } });
  if (src.after) traces.push({ x: spots, y: src.after, mode: "lines", name: "After (with trades)", hovertemplate: HT, line: { color: C.after, width: 3 }, fill: "tozeroy", fillcolor: C.afterFill });
  if (targetCurve) traces.push({ x: spots, y: targetCurve, mode: "lines", name: manual ? "Target (manual)" : "Target", hovertemplate: HT, line: { color: C.target, width: 2.5, dash: "dot" } });

  let yLo = 0, yHi = 0;
  traces.forEach(t => t.y.forEach(v => { if (typeof v === "number" && isFinite(v)) { if (v < yLo) yLo = v; if (v > yHi) yHi = v; } }));
  if (S0) traces.push({ x: [S0, S0], y: [yLo, yHi], mode: "lines", name: "Spot", line: { color: C.spot, width: 1.5, dash: "dot" }, showlegend: false, hoverinfo: "skip" });

  const layout = optv3ChartLayout({
    title: manual ? "Target Profile — your manual target" : "Target Profile — Before vs After vs Target",
    assetLabel, C,
  });
  layout.margin = { t: 40, b: 66, l: 78, r: 20 };
  if (optv3DrawMode) layout.dragmode = false;  // let clicks register as points, not zoom
  Plotly.newPlot("optv3-profile-chart", traces, layout, { responsive: true, displaylogo: false })
    .then(optv3BindProfileChartClick);
}

// ── Draw-on-chart: click the target chart to set the payoff at the nearest
// spot-ladder point, building a curve point-by-point. ───────────────────────
let optv3DrawMode = false;
let optv3ProfileChartClickBound = false;

function optv3BindProfileChartClick() {
  const gd = document.getElementById("optv3-profile-chart");
  if (!gd || optv3ProfileChartClickBound) return;
  optv3ProfileChartClickBound = true;   // gd element persists across re-plots
  gd.addEventListener("click", (evt) => {
    if (!optv3DrawMode || !gd._fullLayout) return;
    const xa = gd._fullLayout.xaxis, ya = gd._fullLayout.yaxis;
    if (!xa || !ya) return;
    const bb = gd.getBoundingClientRect();
    const px = evt.clientX - bb.left - xa._offset;
    const py = evt.clientY - bb.top - ya._offset;
    if (px < 0 || py < 0 || px > xa._length || py > ya._length) return;  // outside plot area
    const spot = xa.p2d(px);   // log-aware → actual price
    const payoff = ya.p2d(py);
    if (!isFinite(spot) || !isFinite(payoff)) return;
    optv3SetTargetPointAtSpot(spot, payoff);
  });
}

// Set the target payoff at the ladder point nearest `spot`, keeping every other
// point at its current value (from the table, else the active auto curve).
function optv3SetTargetPointAtSpot(spot, y) {
  const src = optv3ProfileSource();
  if (!src || !src.spots.length) return;
  const spots = src.spots;
  const displayIdx = optv3TargetDisplayIdx(spots);
  const cur = new Map(optv3CurrentTargetPoints().map(p => [p.x, p.y]));
  const auto = optv3AutoTargetAnchored(src);
  let best = displayIdx[0], bd = Infinity;
  displayIdx.forEach(si => { const d = Math.abs(spots[si] - spot); if (d < bd) { bd = d; best = si; } });
  optv3ManualTarget = displayIdx.map(si => {
    const s = spots[si];
    let val = cur.has(s) ? cur.get(s) : (auto ? auto[si] : 0);
    if (si === best) val = y;
    return { x: s, y: val };
  }).sort((a, b) => a.x - b.x);
  optv3RenderProfileTable();  // regenerates the editable table + chart from the manual curve
}

function optv3ToggleDrawMode() {
  optv3DrawMode = !optv3DrawMode;
  const btn = document.getElementById("btn-optv3-target-draw");
  const gd = document.getElementById("optv3-profile-chart");
  if (btn) {
    btn.classList.toggle("btn-primary", optv3DrawMode);
    btn.classList.toggle("btn-secondary", !optv3DrawMode);
    btn.textContent = optv3DrawMode ? "✏ Drawing… (click chart)" : "✏ Draw on chart";
  }
  if (gd) { gd.style.cursor = optv3DrawMode ? "crosshair" : ""; Plotly.relayout(gd, { dragmode: optv3DrawMode ? false : "zoom" }); }
}

async function optv3LoadSnapshots() {
  const tbody = document.getElementById("optv3-snapshots-body");
  if (!tbody) return;
  try {
    const res = await get("/api/optimization/snapshots");
    const snaps = res.snapshots || [];
    if (!snaps.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:1rem;color:var(--muted)">No saved runs yet. Tick "Save run snapshot" before running.</td></tr>';
      return;
    }
    tbody.innerHTML = snaps.map(s => {
      const d = s.modified ? new Date(s.modified * 1000) : null;
      const dateStr = d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
      const timeStr = d ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
      const statusColor = s.status === "ok" ? "var(--green)" : s.status ? "var(--red)" : "var(--muted)";
      return `<tr>
        <td style="white-space:nowrap">${dateStr} <span style="color:var(--muted)">${timeStr}</span></td>
        <td>${s.asset || "ETH"}</td><td>${s.target_expiry || "--"}</td><td>${s.lam_factor || "--"}</td>
        <td>${s.trades_count != null ? s.trades_count : "--"}</td>
        <td style="color:${statusColor}">${s.status || "--"}</td><td>${s.size_kb || 0} KB</td>
        <td><a href="/api/optimization/snapshots/${encodeURIComponent(s.filename)}" download style="font-size:.75rem">&darr;</a></td>
      </tr>`;
    }).join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:1rem;color:var(--muted)">${e.message}</td></tr>`;
  }
}

// One-time init when the page is first opened.
function optv3Init() {
  optv3Loaded = true;
  optv3LoadSnapshots();
  // Resize the Plotly chart when its (previously-hidden) tab becomes visible.
  document.querySelectorAll('#page-optv3 .sub-tab-btn').forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.subtab === "optv3-payoff" ? "optv3-payoff-chart"
        : btn.dataset.subtab === "optv3-profile" ? "optv3-profile-chart" : null;
      if (id) setTimeout(() => { const c = document.getElementById(id); if (c && c.data) Plotly.Plots.resize(c); }, 40);
    });
  });
}

// Send the v3 optimizer's proposed trades to the Pricing screen (mirrors the v2
// btn-optv2-send-to-pricing flow: load legs, switch page, auto-price).
document.getElementById("btn-optv3-send-to-pricing")?.addEventListener("click", () => {
  const res = optv3OptResult;
  const source = (res && ((res.replacement_trades && res.replacement_trades.length)
    ? res.replacement_trades : res.trades)) || [];
  if (!source.length) { alert("No optimizer trades to send. Run the optimizer first."); return; }

  legs.length = 0;  // clear existing Pricing legs
  let sent = 0, skipped = 0;
  const usedCodes = new Set();
  for (const t of source) {
    const opt = String(t.opt || "").toUpperCase();
    if (opt !== "C" && opt !== "P") { skipped++; continue; }  // skip perps/futures
    const qty = Math.abs(Number(t.qty) || 0);
    if (!qty) { skipped++; continue; }
    const side = String(t.side || "").toLowerCase().startsWith("s") ? "sell" : "buy";
    const premium = t.bs_price_usd ? String(Math.round(t.bs_price_usd * 100) / 100) : "0";
    let expCode = optv2ExpiryText(t);
    if (!/^\d{1,2}[A-Z]{3}\d{2}$/.test(expCode || "")) expCode = null;
    addLeg(side, opt, String(t.strike), premium, String(qty), expCode);
    if (expCode) usedCodes.add(expCode);
    sent++;
  }
  if (!sent) { alert("No priceable option legs in the optimizer result (perps/zero-qty only)."); return; }

  const existing = new Set([...$expSel.options].map(o => o.value));
  for (const ec of usedCodes) {
    if (!existing.has(ec)) {
      const dte = _expiryCodeToDte(ec);
      const o = document.createElement("option");
      o.value = ec;
      o.textContent = `${ec} (${dte != null ? dte + 'd' : '?'}) [interpolated]`;
      $expSel.appendChild(o);
      existing.add(ec);
    }
  }

  const pricingNav = document.querySelector('.nav-item[data-page="pricing"]');
  if (pricingNav) pricingNav.click();
  setTimeout(() => { document.getElementById("btn-replicate")?.click(); }, 300);
  if (skipped) console.log(`Optimizer v3 → Pricing: sent ${sent} leg(s), skipped ${skipped} (perp/zero-qty).`);
});

// ── Event wiring (elements exist in the initial HTML) ──
document.getElementById("btn-load-optv3")?.addEventListener("click", optv3Load);
document.getElementById("optv3-target-expiry")?.addEventListener("change", optv3SyncRunEnabled);
// Recompute roll candidates (and re-default the ITM ticks) when the DTE
// threshold or counterparty scope changes.
document.getElementById("optv3-roll-dte-threshold")?.addEventListener("change", (e) => {
  if (!optv3Data) return;
  // "Default" applies to every counterparty; users then tweak individual rows.
  const v = e.target.value;
  const inputs = document.querySelectorAll("#optv3-dte-list .optv3-dte-input");
  if (inputs.length) inputs.forEach(i => { i.value = v; });
  else optv3RenderDteList();
  optv3RenderRollCandidates();
});
document.getElementById("optv3-counterparties")?.addEventListener("change", () => { if (optv3Data) optv3RenderRollCandidates(); });
// Per-counterparty DTE inputs are dynamic — delegate their change to re-filter candidates.
document.getElementById("optv3-dte-list")?.addEventListener("input", () => { if (optv3Data) optv3RenderRollCandidates(); });
document.getElementById("btn-optv3-refresh-snapshots")?.addEventListener("click", () => optv3LoadSnapshots());
document.getElementById("optv3-target-select")?.addEventListener("change", (e) => {
  optv3TargetProfileFile = e.target.value || "";
  optv3SyncTargetControls();
  optv3FetchTargetProfile();
});
document.getElementById("btn-optv3-target-smooth")?.addEventListener("click", optv3SmoothTarget);
document.getElementById("btn-optv3-target-save")?.addEventListener("click", optv3SaveTargetProfile);
document.getElementById("btn-optv3-target-delete")?.addEventListener("click", optv3DeleteTargetProfile);
document.getElementById("btn-optv3-target-draw")?.addEventListener("click", optv3ToggleDrawMode);
document.getElementById("btn-optv3-add-leg")?.addEventListener("click", optv3AddManualLeg);

// Persistent, copyable optimizer-error panel.
function optv3ShowError(e) {
  const box = document.getElementById("optv3-error");
  const pre = document.getElementById("optv3-error-text");
  if (!box || !pre) { alert("Optimization failed.\n" + (e && (e.detail || e.message) || e)); return; }
  const msg = (e && (e.detail || e.message)) ? (e.detail || e.message) : String(e);
  pre.textContent = `[${new Date().toISOString()}] Optimizer v3 run failed\n\n${msg}`;
  box.style.display = "";
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}
function optv3HideError() {
  const box = document.getElementById("optv3-error");
  if (box) box.style.display = "none";
}
document.getElementById("btn-optv3-dismiss-error")?.addEventListener("click", optv3HideError);
document.getElementById("btn-optv3-copy-error")?.addEventListener("click", async () => {
  const pre = document.getElementById("optv3-error-text");
  const txt = pre ? pre.textContent : "";
  try {
    await navigator.clipboard.writeText(txt);
    const btn = document.getElementById("btn-optv3-copy-error");
    if (btn) { const o = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = o; }, 1500); }
  } catch {
    // Clipboard API blocked (e.g. non-HTTPS) — select the text so the user can Ctrl-C.
    const pre2 = document.getElementById("optv3-error-text");
    if (pre2) { const r = document.createRange(); r.selectNodeContents(pre2); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
  }
});
document.getElementById("btn-optv3-target-reset")?.addEventListener("click", optv3ResetTarget);
document.getElementById("btn-optv3-target-apply")?.addEventListener("click", () => {
  if (!document.getElementById("optv3-target-expiry")?.value) { alert("Choose a target maturity before running."); return; }
  document.getElementById("btn-run-optv3")?.click();
});

document.getElementById("btn-run-optv3")?.addEventListener("click", async () => {
  const $btn = document.getElementById("btn-run-optv3");
  if (!document.getElementById("optv3-target-expiry")?.value) {
    alert("Choose a target maturity before running the optimizer."); return;
  }
  $btn.classList.add("loading"); $btn.textContent = "Running…"; $btn.disabled = true;
  try {
    const rollDteThreshold = document.getElementById("optv3-roll-dte-threshold").value || null;
    const cptySel = document.getElementById("optv3-counterparties");
    const selectedCounterparties = cptySel
      ? Array.from(cptySel.selectedOptions).map(o => o.value).filter(v => v && v !== "ALL") : [];
    const saveRequested = document.getElementById("optv3-save-usecase")?.checked || false;
    const rollItmOnly = document.getElementById("optv3-roll-itm-only")?.checked || false;
    const enableBoxNeutralizer = document.getElementById("optv3-enable-box-neutralizer")?.checked || false;
    const collateralBudgetRaw = document.getElementById("optv3-collateral-budget-pct")?.value;
    const collateralBudgetPct = collateralBudgetRaw === "" || collateralBudgetRaw === undefined ? null : parseFloat(collateralBudgetRaw);
    const maxQtyRaw = document.getElementById("optv3-max-qty")?.value;
    const maxQty = maxQtyRaw === "" || maxQtyRaw === undefined ? null : parseFloat(maxQtyRaw);
    const maxTradesRaw = document.getElementById("optv3-max-trades")?.value;
    const maxTrades = maxTradesRaw === "" || maxTradesRaw === undefined ? null : parseInt(maxTradesRaw, 10);

    // When there are roll candidates, the tick-to-unwind panel is authoritative:
    // force exactly the ticked set (roll_dte_threshold = -1 → manual mode). With
    // no candidates, fall back to the threshold / ITM-only inputs.
    const rollCandsActive = optv3RollCandidates().length > 0;
    const rollThresholdParam = rollCandsActive ? -1 : (Number.isNaN(rollDteThreshold) ? null : rollDteThreshold);
    const forcedRollIds = rollCandsActive ? [...optv3RollSel] : [...tmSelected];

    // Scope the NEW/replacement trades to the counterparties actually being
    // rolled, so "roll only G20" doesn't spawn trades for Wave/KeyRock/Flowdesk.
    // An explicit Counterparties selection still wins; otherwise derive scope
    // from the ticked roll candidates.
    let cptiesParam = selectedCounterparties.length ? selectedCounterparties : null;
    if (rollCandsActive && !cptiesParam) {
      const rolledCps = [...new Set(
        optv3RollCandidates().filter(c => optv3RollSel.has(c.id)).map(c => c.counterparty).filter(Boolean)
      )];
      if (rolledCps.length) cptiesParam = rolledCps;
    }

    const data = await post("/api/optimization/run", {
      asset: currentAsset,
      lam_factor: parseFloat(document.getElementById("optv3-lam-factor").value || "0.2"),
      downside_factor: parseFloat(document.getElementById("optv3-downside-factor")?.value || "1"),
      t90_weight: parseFloat(document.getElementById("optv3-t90-weight")?.value || "0"),
      atm_concentration: parseFloat(document.getElementById("optv3-atm-concentration")?.value || "0"),
      mu_factor: parseFloat(document.getElementById("optv3-mu-factor")?.value || "0"),
      cash_neutrality_factor: parseFloat(document.getElementById("optv3-cash-neutrality-factor")?.value || "0"),
      target_expiry: document.getElementById("optv3-target-expiry").value || null,
      unwind_discount: parseFloat(document.getElementById("optv3-unwind-discount")?.value || "0.2"),
      new_position_penalty: parseFloat(document.getElementById("optv3-new-position-penalty")?.value || "0.04"),
      roll_dte_threshold: rollThresholdParam,
      roll_itm_only: rollItmOnly,
      collateral_budget_pct: collateralBudgetPct,
      max_qty: maxQty,
      max_trades: maxTrades,
      enable_box_neutralizer: enableBoxNeutralizer,
      enable_composite_unwind: document.getElementById("optv3-enable-composite-unwind")?.checked ?? true,
      composite_overrides: currentCompositeOverrides(),
      save_usecase_snapshot: saveRequested,
      is_replay: false,
      counterparties: cptiesParam,
      forced_roll_ids: forcedRollIds,
      base_trade_ids: optv2BaseIds(),
      // User-edited target profile (Target Profile tab). null = auto parametric.
      manual_target: (optv3ManualTarget && optv3ManualTarget.length >= 2) ? optv3ManualTarget : null,
      // Per-counterparty transaction cost in vol points (cost = |vega| × VOLpts).
      bid_ask_vol_pts: optVolPtsDict("optv3-volpts-list"),
      // Per-counterparty box-neutralizer execution fee (entered in %, sent as bps).
      box_fee_bps: optBoxFeeDict("optv3-boxfee-list"),
      // Per-counterparty perp/future trading cost, in bps of notional.
      perp_cost_bps: optPerpCostDict("optv3-perpcost-list"),
      // Post-LP delta cleanup via a perp trade — see delta_hedger.check_rehedge.
      enable_delta_rehedge: document.getElementById("optv3-enable-delta-rehedge")?.checked || false,
      delta_band: parseFloat(document.getElementById("optv3-delta-band")?.value || "75"),
      // Saved target profile selected in the dropdown (engine loads the CSV).
      // Overridden by manual_target when the Target column has been edited.
      target_profile_file: optv3TargetProfileFile || null,
    });
    console.log("Optimizer v3 result:", data);
    optv3HideError();
    optv3RenderResult(data);
    if (saveRequested) { await optv3LoadSnapshots(); }
  } catch (e) {
    console.error("Optimizer v3 run failed:", e);
    optv3ShowError(e);
  } finally {
    $btn.classList.remove("loading"); $btn.textContent = "Run Optimizer"; $btn.disabled = false;
  }
});

// ═══════════════════════════════════════════════════════════════
// VOL SURFACE CURVE PAGE
// ═══════════════════════════════════════════════════════════════
let vcLoaded = false;

async function vcInit() {
  vcLoaded = true;
  const $sel = document.getElementById("vc-expiry-select");
  const $btn = document.getElementById("btn-vc-load");

  // Populate expiry dropdown from vol surface cache or fetch expirations
  if (volSurface && volSurface.smiles && volSurface.smiles.length > 0) {
    $sel.innerHTML = "";
    for (const s of volSurface.smiles) {
      const opt = document.createElement("option");
      opt.value = s.expiry_code;
      opt.textContent = `${s.expiry_code} (${s.dte}d)`;
      $sel.appendChild(opt);
    }
  } else {
    try {
      const expiries = await get("/api/market/expirations");
      $sel.innerHTML = "";
      for (const exp of expiries) {
        const opt = document.createElement("option");
        opt.value = exp;
        opt.textContent = exp;
        $sel.appendChild(opt);
      }
    } catch (e) {
      $sel.innerHTML = '<option value="">Failed to load</option>';
    }
  }

  $btn.addEventListener("click", vcLoadCurve);
  $sel.addEventListener("change", vcLoadCurve);

  // Draw empty chart
  vcDrawEmpty();

  // Auto-load first expiry
  if ($sel.value) vcLoadCurve();
}

function vcDrawEmpty() {
  const cc = chartColors();
  const layout = {
    title: { text: "Vol Surface Curve — Select an Expiry", font: { color: cc.text, size: 16 } },
    paper_bgcolor: cc.paper,
    plot_bgcolor: cc.plot,
    xaxis: { title: "Strike (USD)", color: cc.muted, gridcolor: cc.grid, zerolinecolor: cc.zeroline },
    yaxis: { title: "Cost / Income (USD)", color: cc.muted, gridcolor: cc.grid, zerolinecolor: "#f85149", zerolinewidth: 2 },
    margin: { t: 50, r: 30, b: 50, l: 70 },
    showlegend: true,
    legend: { font: { color: cc.muted }, bgcolor: cc.legendBg, bordercolor: cc.legendBorder, borderwidth: 1 },
  };
  Plotly.newPlot("volcurve-chart", [], layout, { responsive: true });
}

async function vcLoadCurve() {
  const expiry = document.getElementById("vc-expiry-select").value;
  if (!expiry) return;

  const $btn = document.getElementById("btn-vc-load");
  $btn.classList.add("loading");
  $btn.disabled = true;

  try {
    const data = await get(`/api/market/surface-curve?expiry=${expiry}`);
    vcRenderCurve(data);
  } catch (e) {
    console.error("Vol curve load failed:", e);
    alert("Failed to load curve: " + e.message);
  } finally {
    $btn.classList.remove("loading");
    $btn.disabled = false;
  }
}

function vcRenderCurve(data) {
  const { spot, expiry, calls, puts } = data;
  const notional = parseFloat(document.getElementById("vc-notional").value) || 1000;
  const step = parseFloat(document.getElementById("vc-step").value) || 100;

  // Build strike-indexed maps
  const callMap = {};
  for (const c of calls) callMap[c.strike] = c;
  const putMap = {};
  for (const p of puts) putMap[p.strike] = p;

  // Collect ALL strikes that Deribit has listed for this expiry
  const allStrikes = new Set();
  for (const c of calls) allStrikes.add(c.strike);
  for (const p of puts) allStrikes.add(p.strike);
  const strikes = [...allStrikes].sort((a, b) => a - b);

  // Build call mids and put mids across all strikes
  const callStrikes = [], callMids = [], callIvs = [];
  const putStrikes = [], putMids = [], putIvs = [];

  for (const k of strikes) {
    const c = callMap[k];
    if (c) {
      callStrikes.push(k);
      callMids.push(c.mark_usd * notional);
      callIvs.push(c.mark_iv);
    }
    const p = putMap[k];
    if (p) {
      putStrikes.push(k);
      putMids.push(p.mark_usd * notional);
      putIvs.push(p.mark_iv);
    }
  }

  // Build traces
  const cc = chartColors();
  const traces = [];

  // Call mids — green
  if (callStrikes.length > 0) {
    traces.push({
      x: callStrikes,
      y: callMids,
      type: "scatter",
      mode: "lines+markers",
      name: `Calls mid (${notional.toLocaleString()} ETH)`,
      line: { color: "#66bb6a", width: 2.5 },
      marker: { size: 5 },
      fill: "tozeroy",
      fillcolor: "rgba(102,187,106,0.10)",
      hovertemplate: "Strike: $%{x:,.0f}<br>Mid: $%{y:,.0f}<br>IV: %{customdata:.1f}%<extra>Call</extra>",
      customdata: callIvs,
    });
  }

  // Put mids — red/orange
  if (putStrikes.length > 0) {
    traces.push({
      x: putStrikes,
      y: putMids,
      type: "scatter",
      mode: "lines+markers",
      name: `Puts mid (${notional.toLocaleString()} ETH)`,
      line: { color: "#ef5350", width: 2.5 },
      marker: { size: 5 },
      fill: "tozeroy",
      fillcolor: "rgba(239,83,80,0.10)",
      hovertemplate: "Strike: $%{x:,.0f}<br>Mid: $%{y:,.0f}<br>IV: %{customdata:.1f}%<extra>Put</extra>",
      customdata: putIvs,
    });
  }

  // Spot vertical line
  const allValues = callMids.concat(putMids);
  const yMax = allValues.length > 0 ? Math.max(...allValues) * 1.05 : 1;
  traces.push({
    x: [spot, spot],
    y: [0, yMax],
    type: "scatter",
    mode: "lines",
    name: `Spot $${spot.toLocaleString(undefined, {maximumFractionDigits: 0})}`,
    line: { color: "#ffa726", width: 2, dash: "dash" },
    hoverinfo: "skip",
  });

  const layout = {
    title: { text: `Vol Surface Curve — ${expiry}`, font: { color: cc.text, size: 16 } },
    paper_bgcolor: cc.paper,
    plot_bgcolor: cc.plot,
    xaxis: {
      title: "Strike (USD)",
      color: cc.muted,
      gridcolor: cc.grid,
      zerolinecolor: cc.zeroline,
      tickformat: "$,.0f",
      range: [0, 7000],
    },
    yaxis: {
      title: `Mid Premium per ${notional.toLocaleString()} ETH (USD)`,
      color: cc.muted,
      gridcolor: cc.grid,
      zerolinecolor: cc.zeroline,
      tickformat: "$,.0f",
    },
    margin: { t: 50, r: 30, b: 50, l: 80 },
    showlegend: true,
    legend: { font: { color: cc.muted }, bgcolor: cc.legendBg, bordercolor: cc.legendBorder, borderwidth: 1 },
    annotations: [{
      x: spot,
      y: yMax * 0.95,
      text: `Spot $${spot.toLocaleString(undefined, {maximumFractionDigits: 0})}`,
      showarrow: true,
      arrowhead: 2,
      ax: 40,
      ay: 20,
      font: { color: "#ffa726", size: 12 },
      arrowcolor: "#ffa726",
    }],
  };

  Plotly.react("volcurve-chart", traces, layout, { responsive: true });

  // Update spot label
  document.getElementById("vc-spot-label").textContent =
    `ETH Spot: $${spot.toLocaleString(undefined, {maximumFractionDigits: 2})} | Expiry: ${expiry} | Call & Put mid prices across all strikes`;

  // Render table
  vcRenderTable(callStrikes, callMids, callIvs, putStrikes, putMids, putIvs, notional, spot);
}

function vcRenderTable(callStrikes, callMids, callIvs, putStrikes, putMids, putIvs, notional, spot) {
  const $section = document.getElementById("vc-table-section");
  const $tbody = document.getElementById("vc-table-body");
  $tbody.innerHTML = "";

  // Build maps for easy lookup
  const cMap = {};
  for (let i = 0; i < callStrikes.length; i++) cMap[callStrikes[i]] = { mid: callMids[i], iv: callIvs[i] };
  const pMap = {};
  for (let i = 0; i < putStrikes.length; i++) pMap[putStrikes[i]] = { mid: putMids[i], iv: putIvs[i] };

  // All strikes
  const allK = [...new Set([...callStrikes, ...putStrikes])].sort((a, b) => a - b);

  for (const k of allK) {
    const c = cMap[k];
    const p = pMap[k];
    const tr = document.createElement("tr");

    if (Math.abs(k - spot) < 50) tr.classList.add("row-highlight");

    const callMidStr = c ? `$${Math.round(c.mid).toLocaleString()}` : "--";
    const callIvStr = c && c.iv ? c.iv.toFixed(1) + "%" : "--";
    const callPerUnit = c ? `$${(c.mid / notional).toFixed(2)}` : "--";
    const putMidStr = p ? `$${Math.round(p.mid).toLocaleString()}` : "--";
    const putIvStr = p && p.iv ? p.iv.toFixed(1) + "%" : "--";
    const putPerUnit = p ? `$${(p.mid / notional).toFixed(2)}` : "--";

    tr.innerHTML = `
      <td style="font-weight:600">$${k.toLocaleString()}</td>
      <td style="text-align:right;color:#66bb6a">${callPerUnit}</td>
      <td style="text-align:right;color:#66bb6a">${callMidStr}</td>
      <td style="text-align:right">${callIvStr}</td>
      <td style="text-align:right;color:#ef5350">${putPerUnit}</td>
      <td style="text-align:right;color:#ef5350">${putMidStr}</td>
      <td style="text-align:right">${putIvStr}</td>
    `;
    $tbody.appendChild(tr);
  }

  $section.style.display = "";
}

// ─── MTM History ────────────────────────────────────────────
// One snapshot per (date, asset) is written lazily on /api/portfolio/pnl.
// This block: (1) renders Δ1d / Δ7d on the Portfolio MTM summary card,
// (2) opens a modal on card click, (3) drives the standalone MTM History page.

let mtmhPageLoaded = false;

function _mtmFmt(n, opts = {}) {
  if (n === null || n === undefined || isNaN(n)) return "--";
  const sign = opts.signed && n > 0 ? "+" : "";
  return sign + "$" + Math.round(n).toLocaleString();
}

function _mtmDeltaSpan(d, kind = "mtm") {
  // d = {mtm_change, spot_change, from_date} | null
  if (!d) return '<span style="color:var(--muted)">--</span>';
  const val = kind === "spot" ? d.spot_change : d.mtm_change;
  if (val === null || val === undefined) return '<span style="color:var(--muted)">--</span>';
  const cls = val >= 0 ? "risk-sub-pos" : "risk-sub-neg";
  const sign = val > 0 ? "+" : "";
  return `<span class="${cls}">${sign}$${Math.round(val).toLocaleString()}</span>`;
}

async function refreshMtmDeltas() {
  const $d1 = document.getElementById("tm-mtm-d1d");
  const $d7 = document.getElementById("tm-mtm-d7d");
  if (!$d1 || !$d7) return;
  try {
    const data = await get(`/api/portfolio/mtm-history?asset=${currentAsset}&days=14`);
    $d1.innerHTML = _mtmDeltaSpan(data.delta_1d);
    $d7.innerHTML = _mtmDeltaSpan(data.delta_7d);
  } catch (e) {
    $d1.textContent = "--";
    $d7.textContent = "--";
  }
}

// Median of a numeric array (non-mutating).
function _median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Hampel filter: replace isolated outlier points (bad snapshots) with the
// local median. Robust to spikes, preserves genuine level shifts.
function _hampel(values, window = 3, nSigmas = 3) {
  const n = values.length;
  const out = values.slice();
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - window), hi = Math.min(n - 1, i + window);
    const win = values.slice(lo, hi + 1);
    const med = _median(win);
    const mad = _median(win.map(v => Math.abs(v - med)));
    const sigma = 1.4826 * mad;  // MAD → σ for a normal distribution
    if (sigma > 0 && Math.abs(values[i] - med) > nSigmas * sigma) out[i] = med;
  }
  return out;
}

function _renderMtmChart(elId, history) {
  const dates = history.map(h => h.date);
  const rawMtm = history.map(h => h.mtm_usd);
  // Strip outlier snapshots so the curve reflects the real MTM trajectory.
  const mtm = _hampel(rawMtm);

  // Focus the y-axis on the actual curve (not anchored at 0 / huge outliers).
  const lo = Math.min(...mtm), hi = Math.max(...mtm);
  const span = (hi - lo) || Math.max(Math.abs(hi), 1);
  const pad = span * 0.08;

  const traces = [
    {
      x: dates, y: mtm, name: "Portfolio MTM (USD)",
      type: "scatter", mode: "lines+markers",
      line: { color: "#3fb950", width: 2, shape: "spline", smoothing: 0.6 },
      marker: { size: 4 },
      hovertemplate: "%{x}<br>MTM %{y:$,.0f}<extra></extra>",
    },
  ];
  const layout = {
    margin: { t: 10, r: 20, b: 40, l: 70 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: getComputedStyle(document.body).color, size: 11 },
    showlegend: false,
    xaxis: { showgrid: false },
    yaxis: {
      title: "MTM (USD)", tickprefix: "$", gridcolor: "rgba(128,128,128,.2)",
      range: [lo - pad, hi + pad], tickformat: ",.0f",
    },
    hovermode: "x unified",
  };
  Plotly.newPlot(elId, traces, layout, { responsive: true, displayModeBar: false });
}

function _renderMtmTable(history) {
  const $tbody = document.getElementById("mtmh-tbody");
  if (!$tbody) return;
  if (!history.length) {
    $tbody.innerHTML = '<tr><td colspan="10" class="mtmh-empty">No snapshots yet.</td></tr>';
    return;
  }
  const rows = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const prev = i > 0 ? history[i - 1] : null;
    const dMtm = prev ? h.mtm_usd - prev.mtm_usd : null;
    const dSpot = prev ? h.spot - prev.spot : null;
    const dMtmCls = dMtm == null ? "" : dMtm >= 0 ? "mtmh-pos" : "mtmh-neg";
    const dSpotCls = dSpot == null ? "" : dSpot >= 0 ? "mtmh-pos" : "mtmh-neg";
    rows.push(`<tr>
      <td>${h.date}</td>
      <td>$${Number(h.spot).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
      <td>${_mtmFmt(h.mtm_usd)}</td>
      <td class="${dMtmCls}">${dMtm == null ? "--" : _mtmFmt(dMtm, { signed: true })}</td>
      <td class="${dSpotCls}">${dSpot == null ? "--" : (dSpot > 0 ? "+" : "") + "$" + dSpot.toFixed(2)}</td>
      <td>${h.position_count}</td>
      <td>${(h.delta ?? 0).toFixed(2)}</td>
      <td>${(h.gamma ?? 0).toFixed(4)}</td>
      <td>${(h.theta ?? 0).toFixed(2)}</td>
      <td>${(h.vega ?? 0).toFixed(2)}</td>
    </tr>`);
  }
  $tbody.innerHTML = rows.join("");
}

async function mtmhLoadPage() {
  const range = document.getElementById("mtmh-range").value || "30";
  try {
    const data = await get(`/api/portfolio/mtm-history?asset=${currentAsset}&days=${range}`);
    const history = data.history || [];
    const $summary = document.getElementById("mtmh-summary");
    const $empty = document.getElementById("mtmh-empty");
    const $chart = document.getElementById("mtmh-chart");

    if (!history.length) {
      $summary.textContent = "";
      $chart.style.display = "none";
      $empty.style.display = "";
      _renderMtmTable([]);
      return;
    }

    $chart.style.display = "";
    $empty.style.display = "none";

    const cur = data.current;
    const d1 = data.delta_1d;
    const d7 = data.delta_7d;
    const fmtChg = (d) => d
      ? `<span class="${d.mtm_change >= 0 ? "mtmh-pos" : "mtmh-neg"}">${d.mtm_change >= 0 ? "+" : ""}$${Math.round(d.mtm_change).toLocaleString()}</span> <span style="opacity:.6">(from ${d.from_date})</span>`
      : '<span style="opacity:.5">--</span>';
    $summary.innerHTML = `
      <strong>${currentAsset}</strong> &nbsp;|&nbsp;
      Latest <strong>${_mtmFmt(cur.mtm_usd)}</strong> @ spot $${Number(cur.spot).toFixed(2)} on ${cur.date}
      &nbsp;|&nbsp; Δ1d: ${fmtChg(d1)}
      &nbsp;|&nbsp; Δ7d: ${fmtChg(d7)}
    `;
    _renderMtmChart("mtmh-chart", history);
    _renderMtmTable(history);
  } catch (e) {
    console.error("MTM history load failed:", e);
  }
}

async function mtmhOpenModal() {
  document.getElementById("mtmh-modal-asset").textContent = currentAsset;
  const $modal = document.getElementById("mtmh-modal");
  $modal.classList.add("open");
  try {
    const data = await get(`/api/portfolio/mtm-history?asset=${currentAsset}&days=30`);
    const history = data.history || [];
    const $summary = document.getElementById("mtmh-modal-summary");
    const $empty = document.getElementById("mtmh-modal-empty");
    const $chart = document.getElementById("mtmh-modal-chart");

    if (!history.length) {
      $summary.textContent = "";
      $chart.style.display = "none";
      $empty.style.display = "";
      return;
    }
    $chart.style.display = "";
    $empty.style.display = "none";

    const cur = data.current;
    const d1 = data.delta_1d, d7 = data.delta_7d;
    const fmtChg = (d) => d
      ? `<span class="${d.mtm_change >= 0 ? "mtmh-pos" : "mtmh-neg"}">${d.mtm_change >= 0 ? "+" : ""}$${Math.round(d.mtm_change).toLocaleString()}</span>`
      : '<span style="opacity:.5">--</span>';
    $summary.innerHTML = `Latest <strong>${_mtmFmt(cur.mtm_usd)}</strong> on ${cur.date} &nbsp;|&nbsp; Δ1d: ${fmtChg(d1)} &nbsp;|&nbsp; Δ7d: ${fmtChg(d7)}`;
    // Plotly needs a tick to size correctly inside a just-opened modal
    setTimeout(() => _renderMtmChart("mtmh-modal-chart", history), 50);
  } catch (e) {
    console.error("MTM history modal load failed:", e);
  }
}

function mtmhCloseModal() {
  document.getElementById("mtmh-modal").classList.remove("open");
}

// Wire up MTM history UI once DOM is ready
(function initMtmHistoryUi() {
  const setup = () => {
    const card = document.getElementById("tm-mtm-card");
    if (card) card.addEventListener("click", mtmhOpenModal);

    const closeBtn = document.getElementById("mtmh-modal-close");
    if (closeBtn) closeBtn.addEventListener("click", mtmhCloseModal);

    const backdrop = document.getElementById("mtmh-modal");
    if (backdrop) backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) mtmhCloseModal();
    });

    const openPage = document.getElementById("mtmh-modal-open-page");
    if (openPage) openPage.addEventListener("click", (e) => {
      e.preventDefault();
      mtmhCloseModal();
      const nav = document.querySelector('.nav-item[data-page="mtmhistory"]');
      if (nav) nav.click();
    });

    const refresh = document.getElementById("btn-mtmh-refresh");
    if (refresh) refresh.addEventListener("click", mtmhLoadPage);

    const range = document.getElementById("mtmh-range");
    if (range) range.addEventListener("change", mtmhLoadPage);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();

// ════════════════════════════════════════════════════════════════
// Collateral & Margin
// ════════════════════════════════════════════════════════════════
let collatLast = null;
let collatAssetFilter = "all";  // "all" | "ETH" | "FIL"
let collatEditKey = null;       // {counterparty, portfolio_asset} when editing existing row

const _collatFmtUsd = (v, opts = {}) => {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(Number(v));
  const digits = opts.digits ?? 0;
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
const _collatFmtPct = (v) => {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
};
const _collatFmtQty = (v, asset) => {
  if (v === null || v === undefined || !isFinite(v) || v === 0) return null;
  const digits = asset === "FIL" ? 0 : 2;
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const _collatRatioClass = (r) => {
  if (r === null || r === undefined || !isFinite(r)) return "";
  if (r >= 1.0) return "collat-ratio-good";
  if (r >= 0.9) return "collat-ratio-warn";
  return "collat-ratio-bad";
};
// Posted-collateral cell: tokens (ETH/FIL/BTC/WAVE) + USD/USDC cash.
function _collatPostedCell(r) {
  const parts = [];
  const ethQ = _collatFmtQty(r.eth_qty, "ETH");
  const filQ = _collatFmtQty(r.fil_qty, "FIL");
  if (ethQ) parts.push(`<span class="qty-eth">${ethQ} ETH</span>`);
  if (filQ) parts.push(`<span class="qty-fil">${filQ} FIL</span>`);
  if (r.btc_qty) parts.push(`<span class="qty-eth">${Number(r.btc_qty).toLocaleString(undefined, { maximumFractionDigits: 4 })} BTC</span>`);
  if (r.wave_qty) parts.push(`<span class="qty-fil">${Number(r.wave_qty).toLocaleString(undefined, { maximumFractionDigits: 0 })} WAVE${r.wave_price ? "" : " (no px)"}</span>`);
  if (r.usdc_usd) parts.push(`<span class="qty-eth">$${Number(r.usdc_usd).toLocaleString(undefined, { maximumFractionDigits: 0 })} USDC</span>`);
  return parts.length ? `<div class="collat-posted-cell">${parts.join("")}</div>` : `<span class="qty-zero">—</span>`;
}

let collatMap = null;
// Pending (unsaved) collateral quantity edits, keyed "cp asset book".
// Edits accumulate here and are committed to the DB only on "Save changes".
let collatPending = {};

function collatPendingCount() { return Object.keys(collatPending).length; }

function collatUpdateSaveBtn() {
  const btn = document.getElementById("btn-collat-save");
  if (!btn) return;
  const n = collatPendingCount();
  btn.disabled = n === 0;
  btn.textContent = n ? `Save changes (${n})` : "Save changes";
}

async function collatSaveChanges() {
  const cells = Object.values(collatPending);
  if (!cells.length) return;
  const btn = document.getElementById("btn-collat-save");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    await api("PUT", "/api/collateral/map/cells", { cells });
    collatPending = {};        // committed — clear dirty state
    await collatLoad();        // one reload (live prices reused from cache)
  } catch (e) {
    alert("Save failed: " + (e.message || e));
    collatUpdateSaveBtn();
  }
}

async function collatLoad() {
  const tb = document.getElementById("collat-map-tbody");
  if (tb) tb.innerHTML = `<tr><td style="padding:1rem;color:var(--muted)">Loading…</td></tr>`;
  try {
    collatMap = await get("/api/collateral/map");
    collatRenderMap();
  } catch (e) {
    console.error("Collateral map load failed:", e);
    if (tb) tb.innerHTML = `<tr><td style="padding:1rem;color:var(--red)">Failed to load: ${e.message || e}</td></tr>`;
  }
}

function collatRenderMap() {
  if (!collatMap) return;
  const haircutOn = document.getElementById("collat-haircut-toggle")?.checked ?? true;
  const m = collatMap;
  const assets = m.assets || [];
  const cps = m.counterparties || [];
  const prices = m.prices || {};
  const overrides = m.price_overrides || {};
  const labels = m.asset_labels || {};

  // Spot pill (live reference prices)
  const lp = m.live_prices || {};
  const $pill = document.getElementById("collat-spot-pill");
  if ($pill) $pill.textContent = `ETH $${(lp.ETH || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} · FIL $${(lp.FIL || 0).toFixed(3)} · BTC $${(lp.BTC || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} · as of ${new Date().toLocaleTimeString()}`;

  // Summary tiles
  const totHc = cps.reduce((s, c) => s + (c.collateral_haircut_usd || 0), 0);
  document.getElementById("collat-total-market").textContent = _collatFmtUsd(m.grand_total_usd);
  document.getElementById("collat-total-haircut").textContent = _collatFmtUsd(totHc);
  document.getElementById("collat-total-liability").textContent = _collatFmtUsd(m.total_liability_usd);
  const $bal = document.getElementById("collat-total-balance");
  $bal.textContent = `${m.total_balance_usd > 0 ? "+" : ""}${_collatFmtUsd(m.total_balance_usd)}`;
  $bal.className = "collat-metric-value " + (m.total_balance_usd >= 0 ? "collat-ratio-good" : "collat-ratio-bad");

  // Matrix header: Asset | Price | CP… | Total
  document.getElementById("collat-map-thead").innerHTML = `<tr>
    <th style="text-align:left">Asset</th>
    <th class="num">Price (USD)</th>
    ${cps.map(c => `<th class="num">${c.counterparty} <button class="collat-del-cp" data-cp="${encodeURIComponent(c.counterparty)}" title="Remove counterparty" style="border:none;background:none;color:var(--muted);cursor:pointer;font-size:.9rem">×</button></th>`).join("")}
    <th class="num">Total</th>
  </tr>`;

  // Matrix body: per asset an "asset header" row (price + per-CP totals) plus
  // two editable book rows (ETH book, FIL book). Total posted per asset = ETH + FIL.
  const bookMeta = [
    { book: "ETH", label: "ETH book", color: "var(--accent)" },
    { book: "FIL", label: "FIL book", color: "#f0883e" },
  ];
  document.getElementById("collat-map-tbody").innerHTML = assets.map(a => {
    const isUsdc = a === "USDC";
    const overridden = (a in overrides);
    const priceCell = isUsdc
      ? `<td class="num">1.00</td>`
      : `<td class="num"><input type="number" step="any" min="0" class="collat-price-input" data-asset="${a}" value="${prices[a] ?? 0}" title="${overridden ? "manual override — clear to revert to live" : "live price — type to override"}" style="width:90px;${overridden ? "color:var(--accent);font-weight:600" : ""}"></td>`;

    // Asset header row: total (both books) per CP + asset grand total.
    const headCells = cps.map(c => {
      const usd = c.usd[a] || 0;
      return `<td class="num" style="font-weight:600">${usd ? _collatFmtUsd(usd) : "—"}</td>`;
    }).join("");
    const assetTotal = m.asset_totals[a] || 0;
    const headRow = `<tr style="border-top:2px solid var(--border)">
      <td style="text-align:left"><strong>${labels[a] || a}</strong></td>
      ${priceCell}
      ${headCells}
      <td class="num"><strong>${assetTotal ? _collatFmtUsd(assetTotal) : "—"}</strong></td>
    </tr>`;

    // One editable row per book.
    const bookRows = bookMeta.map(bm => {
      const cells = cps.map(c => {
        const qty = (c.books && c.books[bm.book] && c.books[bm.book][a]) || 0;
        const usd = qty * (prices[a] || (isUsdc ? 1 : 0));
        return `<td class="num">
          <input type="number" step="any" min="0" class="collat-qty-input" data-cp="${encodeURIComponent(c.counterparty)}" data-asset="${a}" data-book="${bm.book}" value="${qty || ""}" placeholder="0" style="width:110px">
          <div style="font-size:.7rem;color:var(--muted)">${usd ? _collatFmtUsd(usd) : "—"}</div>
        </td>`;
      }).join("");
      const bookTotalUsd = cps.reduce((s, c) => s + ((c.books && c.books[bm.book] && c.books[bm.book][a]) || 0), 0) * (prices[a] || (isUsdc ? 1 : 0));
      return `<tr>
        <td style="text-align:left;padding-left:1.25rem;color:${bm.color};font-size:.82rem">↳ ${bm.label}</td>
        <td></td>
        ${cells}
        <td class="num" style="color:var(--muted)">${bookTotalUsd ? _collatFmtUsd(bookTotalUsd) : "—"}</td>
      </tr>`;
    }).join("");

    return headRow + bookRows;
  }).join("");

  // Matrix footer: per-CP totals
  document.getElementById("collat-map-tfoot").innerHTML = `<tr>
    <td style="text-align:left"><strong>Total</strong></td>
    <td></td>
    ${cps.map(c => `<td class="num"><strong>${_collatFmtUsd(c.total_usd)}</strong></td>`).join("")}
    <td class="num"><strong>${_collatFmtUsd(m.grand_total_usd)}</strong></td>
  </tr>`;

  // Balance vs liability table
  document.getElementById("collat-bal-th-coll").textContent = haircutOn ? "Collateral (haircut)" : "Collateral (market)";
  document.getElementById("collat-balance-tbody").innerHTML = cps.map(c => {
    const bal = haircutOn ? c.balance_usd : (c.total_usd - c.liability_usd);
    const balCls = bal > 0 ? "collat-diff-pos" : bal < 0 ? "collat-diff-neg" : "collat-diff-zero";
    return `<tr>
      <td style="text-align:left"><strong>${c.counterparty}</strong></td>
      <td class="num">${_collatFmtUsd(c.total_usd)}</td>
      <td class="num">${_collatFmtUsd(c.collateral_haircut_usd)}</td>
      <td class="num">${_collatFmtUsd(c.liability_usd)}</td>
      <td class="num ${balCls}" style="font-weight:600">${bal > 0 ? "+" : ""}${_collatFmtUsd(bal)}</td>
    </tr>`;
  }).join("");
  const totMarket = cps.reduce((s, c) => s + (c.total_usd || 0), 0);
  document.getElementById("collat-balance-tfoot").innerHTML = `<tr>
    <td style="text-align:left"><strong>Total</strong></td>
    <td class="num"><strong>${_collatFmtUsd(totMarket)}</strong></td>
    <td class="num"><strong>${_collatFmtUsd(totHc)}</strong></td>
    <td class="num"><strong>${_collatFmtUsd(m.total_liability_usd)}</strong></td>
    <td class="num ${m.total_balance_usd >= 0 ? "collat-diff-pos" : "collat-diff-neg"}" style="font-weight:600">${m.total_balance_usd > 0 ? "+" : ""}${_collatFmtUsd(m.total_balance_usd)}</td>
  </tr>`;

  // Fresh render from the server reflects the saved state — drop any dirty edits.
  collatPending = {};
  collatUpdateSaveBtn();

  // Wire inputs: edits are BATCHED into collatPending and committed on "Save
  // changes" — no per-cell PUT or full reload while you type.
  document.querySelectorAll("#collat-map-tbody .collat-qty-input").forEach(inp => {
    inp.addEventListener("input", () => {
      const cp = decodeURIComponent(inp.dataset.cp);
      const asset = inp.dataset.asset, book = inp.dataset.book;
      const qty = parseFloat(inp.value) || 0;
      collatPending[`${cp} ${asset} ${book}`] = { counterparty: cp, asset, book, qty };
      inp.style.borderColor = "var(--accent)";  // mark dirty
      // Live USD hint for immediate feedback (price = current effective price).
      const px = asset === "USDC" ? 1 : ((collatMap && collatMap.prices && collatMap.prices[asset]) || 0);
      const hint = inp.nextElementSibling;
      if (hint) hint.textContent = qty ? _collatFmtUsd(qty * px) : "—";
      collatUpdateSaveBtn();
    });
  });
  document.querySelectorAll("#collat-map-tbody .collat-price-input").forEach(inp => {
    inp.addEventListener("change", () => {
      const v = inp.value.trim();
      collatSavePrice(inp.dataset.asset, v === "" ? null : (parseFloat(v) || 0));
    });
  });
  document.querySelectorAll("#collat-map-thead .collat-del-cp").forEach(btn => {
    btn.addEventListener("click", () => {
      const cp = decodeURIComponent(btn.dataset.cp);
      if (confirm(`Remove counterparty "${cp}" and all its collateral?`)) collatDeleteCp(cp);
    });
  });
}

async function collatSavePrice(asset, price) {
  try {
    // Editing a price override reloads the map, which would drop unsaved qty
    // edits — commit those first so nothing is lost.
    if (collatPendingCount()) {
      await api("PUT", "/api/collateral/map/cells", { cells: Object.values(collatPending) });
      collatPending = {};
    }
    await api("PUT", "/api/collateral/price", { asset, price });
    await collatLoad();
  } catch (e) { alert("Save failed: " + (e.message || e)); }
}
async function collatAddCp() {
  const name = prompt("Counterparty name:");
  if (!name || !name.trim()) return;
  try { await api("POST", "/api/collateral/counterparty", { counterparty: name.trim() }); await collatLoad(); }
  catch (e) { alert("Add failed: " + (e.message || e)); }
}
async function collatDeleteCp(counterparty) {
  try { await api("DELETE", `/api/collateral/counterparty?counterparty=${encodeURIComponent(counterparty)}`); await collatLoad(); }
  catch (e) { alert("Delete failed: " + (e.message || e)); }
}

let collatScenarioData = null;

async function collatLoadScenario() {
  const $card = document.getElementById("collat-scenario-card");
  if (!$card) return;
  // Show only when a single asset is selected
  if (collatAssetFilter !== "ETH" && collatAssetFilter !== "FIL") {
    $card.style.display = "none";
    collatScenarioData = null;
    return;
  }
  $card.style.display = "";
  document.getElementById("collat-scenario-asset").textContent = collatAssetFilter;

  const $sub = document.getElementById("collat-scenario-sub");
  if ($sub) $sub.textContent = "Loading scenario…";

  try {
    collatScenarioData = await get(`/api/collateral/scenario?asset=${collatAssetFilter}`);
    collatRenderScenario();
  } catch (e) {
    console.error("Scenario load failed:", e);
    if ($sub) $sub.textContent = `Scenario unavailable: ${e.message || e}`;
    document.getElementById("collat-scenario-chart").innerHTML = "";
    document.getElementById("collat-scenario-tbody").innerHTML = "";
    document.getElementById("collat-scenario-summary").innerHTML = "";
  }
}

function _collatNearestIdx(ladder, target) {
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < ladder.length; i++) {
    const d = Math.abs(ladder[i].spot - target);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}

function _collatBreakevenSpot(ladder, useHaircut) {
  // Find spot where residual crosses zero (sign change between adjacent rows).
  const key = useHaircut ? "residual_haircut" : "residual_no_haircut";
  for (let i = 1; i < ladder.length; i++) {
    const a = ladder[i - 1][key], b = ladder[i][key];
    if (a === null || b === null) continue;
    if ((a >= 0 && b < 0) || (a < 0 && b >= 0)) {
      // Linear interpolate
      const t = a / (a - b);
      const spot = ladder[i - 1].spot + t * (ladder[i].spot - ladder[i - 1].spot);
      return spot;
    }
  }
  return null;
}

function collatRenderScenario() {
  if (!collatScenarioData) return;
  const haircutOn = document.getElementById("collat-haircut-toggle")?.checked ?? true;
  const d = collatScenarioData;
  const ladder = d.ladder || [];
  const $sub = document.getElementById("collat-scenario-sub");

  const collKey = haircutOn ? "collateral_usd_haircut" : "collateral_usd_no_haircut";
  const resKey  = haircutOn ? "residual_haircut" : "residual_no_haircut";
  const ratKey  = haircutOn ? "margin_ratio_haircut" : "margin_ratio_no_haircut";

  // Table column labels
  document.getElementById("collat-scen-th-coll").textContent  = haircutOn ? "Collateral (haircut)" : "Collateral";
  document.getElementById("collat-scen-th-res").textContent   = haircutOn ? "Residual (haircut)"   : "Residual";
  document.getElementById("collat-scen-th-ratio").textContent = haircutOn ? "Margin % (haircut)"   : "Margin %";

  // Sub line
  const otherInfo = (d.other_spot && d.other_spot > 0)
    ? ` · ${d.other_asset} collateral held flat at $${Number(d.other_spot).toLocaleString(undefined, { maximumFractionDigits: 3 })}`
    : "";
  if ($sub) $sub.textContent = `Current ${d.asset} spot $${Number(d.current_spot).toLocaleString(undefined, { maximumFractionDigits: 2 })}${otherInfo}. IV & time-to-expiry held at today.`;

  // ─── Chart ────────────────────────────────────────────────
  const spots = ladder.map(r => r.spot);
  const liability = ladder.map(r => r.liability_usd);
  const collateral = ladder.map(r => r[collKey]);
  const residual = ladder.map(r => r[resKey]);

  const c = chartColors();

  const traces = [
    {
      x: spots, y: liability, type: "scatter", mode: "lines",
      name: "Liability", line: { color: "#f85149", width: 2.2 },
      hovertemplate: "$%{x:,.2f} → $%{y:,.0f}<extra>Liability</extra>",
    },
    {
      x: spots, y: collateral, type: "scatter", mode: "lines",
      name: haircutOn ? "Collateral (haircut)" : "Collateral",
      line: { color: "#3fb950", width: 2.2 },
      hovertemplate: "$%{x:,.2f} → $%{y:,.0f}<extra>Collateral</extra>",
    },
    {
      x: spots, y: residual, type: "scatter", mode: "lines",
      name: "Residual (Coll − Liab)",
      line: { color: "#58a6ff", width: 2.4, dash: "solid" },
      hovertemplate: "$%{x:,.2f} → $%{y:,.0f}<extra>Residual</extra>",
    },
  ];

  // Vertical line at current spot
  const shapes = [
    {
      type: "line", x0: d.current_spot, x1: d.current_spot,
      y0: 0, y1: 1, yref: "paper",
      line: { color: c.muted, width: 1, dash: "dot" },
    },
    {
      type: "line", x0: spots[0], x1: spots[spots.length - 1],
      y0: 0, y1: 0,
      line: { color: c.zeroline, width: 1 },
    },
  ];

  const annotations = [
    {
      x: d.current_spot, y: 1, yref: "paper", xref: "x",
      text: `Spot $${Number(d.current_spot).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
      showarrow: false, font: { size: 10, color: c.muted },
      xanchor: "left", yanchor: "top",
      bgcolor: c.paper, bordercolor: c.grid, borderwidth: 1, borderpad: 3,
    },
  ];

  // Break-even (residual = 0) annotation if it lies within ladder
  const breakEven = _collatBreakevenSpot(ladder, haircutOn);
  if (breakEven !== null) {
    shapes.push({
      type: "line", x0: breakEven, x1: breakEven,
      y0: 0, y1: 1, yref: "paper",
      line: { color: "#d29922", width: 1, dash: "dash" },
    });
    annotations.push({
      x: breakEven, y: 0.92, yref: "paper", xref: "x",
      text: `100% margin @ $${Number(breakEven).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
      showarrow: false, font: { size: 10, color: "#d29922" },
      xanchor: "left", yanchor: "top",
      bgcolor: c.paper, bordercolor: "#d29922", borderwidth: 1, borderpad: 3,
    });
  }

  const layout = {
    paper_bgcolor: c.paper, plot_bgcolor: c.plot,
    font: { color: c.text, family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", size: 11 },
    margin: { t: 30, r: 20, b: 50, l: 70 },
    xaxis: { title: `${d.asset} spot (USD)`, gridcolor: c.grid, zerolinecolor: c.zeroline, tickformat: ",.0f" },
    yaxis: { title: "USD", gridcolor: c.grid, zerolinecolor: c.zeroline, tickformat: ",.0f" },
    hovermode: "x unified",
    legend: { orientation: "h", x: 0.5, xanchor: "center", y: 1.08, bgcolor: c.legendBg, bordercolor: c.legendBorder, borderwidth: 1 },
    shapes, annotations,
  };

  Plotly.react("collat-scenario-chart", traces, layout, { responsive: true, displayModeBar: false });

  // ─── Summary pills ────────────────────────────────────────
  const curIdx = _collatNearestIdx(ladder, d.current_spot);
  const cur = ladder[curIdx] || {};
  const minRes = ladder.reduce((m, r) => (r[resKey] !== null && r[resKey] < m.v) ? { v: r[resKey], r } : m, { v: Infinity, r: null });
  const $sum = document.getElementById("collat-scenario-summary");
  const beTxt = breakEven !== null
    ? `<span class="pill"><span class="label">Break-even (margin = 100%)</span><strong>$${Number(breakEven).toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong> <span style="color:var(--muted)">(${((breakEven / d.current_spot - 1) * 100).toFixed(1)}%)</span></span>`
    : `<span class="pill"><span class="label">Break-even</span><strong>—</strong> <span style="color:var(--muted)">no zero crossing in ladder</span></span>`;
  const minResTxt = minRes.r
    ? `<span class="pill"><span class="label">Worst residual in ladder</span><strong style="color:${minRes.v < 0 ? 'var(--red)' : 'var(--green)'}">${_collatFmtUsd(minRes.v)}</strong> <span style="color:var(--muted)">@ $${Number(minRes.r.spot).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></span>`
    : ``;
  $sum.innerHTML = `
    <span class="pill"><span class="label">At current spot</span> Liab ${_collatFmtUsd(cur.liability_usd)} · Coll ${_collatFmtUsd(cur[collKey])} · <strong style="color:${(cur[resKey] || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">Residual ${_collatFmtUsd(cur[resKey])}</strong></span>
    ${beTxt}
    ${minResTxt}
  `;

  // ─── Table ────────────────────────────────────────────────
  const $tbody = document.getElementById("collat-scenario-tbody");
  const curSpot = d.current_spot;
  // Find break-even row index (closest to crossing) for visual marker
  let beIdx = -1;
  if (breakEven !== null) {
    beIdx = _collatNearestIdx(ladder, breakEven);
  }
  $tbody.innerHTML = ladder.map((r, i) => {
    const ratioCls = _collatRatioClass(r[ratKey]);
    const resCls = r[resKey] === null ? "" : r[resKey] >= 0 ? "collat-diff-pos" : "collat-diff-neg";
    const rowCls = (i === curIdx ? " collat-scenario-current" : "") + (i === beIdx && beIdx !== curIdx ? " collat-scenario-breakeven" : "");
    const pctTxt = r.spot_pct >= 0 ? `+${r.spot_pct.toFixed(1)}%` : `${r.spot_pct.toFixed(1)}%`;
    const spotFmt = d.asset === "FIL"
      ? `$${Number(r.spot).toFixed(3)}`
      : `$${Number(r.spot).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    return `<tr class="${rowCls.trim()}">
      <td class="num">${spotFmt}</td>
      <td class="num" style="color:var(--muted)">${pctTxt}</td>
      <td class="num">${_collatFmtUsd(r.liability_usd)}</td>
      <td class="num">${_collatFmtUsd(r[collKey])}</td>
      <td class="num ${resCls}">${_collatFmtUsd(r[resKey])}</td>
      <td class="num ${ratioCls}">${_collatFmtPct(r[ratKey])}</td>
    </tr>`;
  }).join("");
}

function collatRender() {
  if (!collatLast) return;
  const haircutOn = document.getElementById("collat-haircut-toggle")?.checked ?? true;
  const p = collatLast.portfolio;
  const spots = collatLast.spots || {};
  const rows = collatLast.rows || [];

  // Spot pill
  const spotParts = [];
  if (spots.ETH) spotParts.push(`ETH $${Number(spots.ETH).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  if (spots.FIL) spotParts.push(`FIL $${Number(spots.FIL).toFixed(3)}`);
  const $pill = document.getElementById("collat-spot-pill");
  if ($pill) $pill.textContent = spotParts.length ? spotParts.join(" · ") : "";

  // Portfolio summary cards
  const totalColl = haircutOn ? p.collateral_usd_haircut : p.collateral_usd_no_haircut;
  const totalRatio = haircutOn ? p.margin_ratio_haircut : p.margin_ratio_no_haircut;
  const totalShort = haircutOn ? p.shortfall_haircut : p.shortfall_no_haircut;
  const otherColl = haircutOn ? p.collateral_usd_no_haircut : p.collateral_usd_haircut;

  document.getElementById("collat-liability").textContent = _collatFmtUsd(p.liability_usd);

  document.getElementById("collat-value").textContent = _collatFmtUsd(totalColl);
  const $valueSub = document.getElementById("collat-value-sub");
  if ($valueSub) {
    const lbl = haircutOn ? "no-haircut" : "with haircuts";
    $valueSub.textContent = `${lbl}: ${_collatFmtUsd(otherColl)}`;
  }

  const $ratio = document.getElementById("collat-ratio");
  $ratio.textContent = _collatFmtPct(totalRatio);
  $ratio.className = "collat-metric-value " + _collatRatioClass(totalRatio);

  const $short = document.getElementById("collat-shortfall");
  $short.textContent = _collatFmtUsd(totalShort);
  $short.className = "collat-metric-value " + (totalShort > 0 ? "collat-ratio-bad" : "collat-ratio-good");

  // Compare card — only if any row has a counterparty ask
  const $compareCard = document.getElementById("collat-compare-card");
  if (p.requested_usd !== null && p.requested_usd !== undefined) {
    $compareCard.style.display = "";
    document.getElementById("collat-requested").textContent = _collatFmtUsd(p.requested_usd);
    const diff = p.diff_usd;
    const $diff = document.getElementById("collat-diff");
    const diffCls = diff > 0 ? "collat-diff-pos" : diff < 0 ? "collat-diff-neg" : "collat-diff-zero";
    const diffSign = diff > 0 ? "+" : "";
    $diff.textContent = `${diffSign}${_collatFmtUsd(diff)}`;
    $diff.className = diffCls;
  } else {
    $compareCard.style.display = "none";
  }

  // Table headers (haircut labelling)
  document.getElementById("collat-th-coll-usd").textContent = haircutOn ? "Coll USD (haircut)" : "Coll USD";
  document.getElementById("collat-th-ratio").textContent = haircutOn ? "Margin % (haircut)" : "Margin %";
  document.getElementById("collat-th-shortfall").textContent = haircutOn ? "Shortfall (haircut)" : "Shortfall";

  const $tbody = document.getElementById("collat-tbody");
  if (!rows.length) {
    $tbody.innerHTML = `<tr class="collat-row-empty"><td colspan="13" style="text-align:center;padding:1.5rem">
      No counterparties with positions or collateral in this view.
      ${collatAssetFilter !== "all" ? `Try the "All books" filter, or click <strong>+ New entry</strong> to add one.` : ""}
    </td></tr>`;
  } else {
    $tbody.innerHTML = rows.map(r => {
      const coll = haircutOn ? r.collateral_usd_haircut : r.collateral_usd_no_haircut;
      const ratio = haircutOn ? r.margin_ratio_haircut : r.margin_ratio_no_haircut;
      const short = haircutOn ? r.shortfall_haircut : r.shortfall_no_haircut;
      const ratioCls = _collatRatioClass(ratio);

      const postedHtml = _collatPostedCell(r);

      const marginReqHtml = r.margin_req_usd
        ? _collatFmtUsd(r.margin_req_usd)
        : `<span class="collat-diff-zero">—</span>`;

      const bal = r.balance_usd;
      const balHtml = (bal === null || bal === undefined)
        ? `<span class="collat-diff-zero">—</span>`
        : `<span class="${bal > 0 ? 'collat-diff-pos' : bal < 0 ? 'collat-diff-neg' : 'collat-diff-zero'}" style="font-weight:600">${bal > 0 ? '+' : ''}${_collatFmtUsd(bal)}</span>`;

      const diff = r.diff_usd;
      const diffHtml = (diff === null || diff === undefined)
        ? `<span class="collat-diff-zero">—</span>`
        : `<span class="${diff > 0 ? 'collat-diff-pos' : diff < 0 ? 'collat-diff-neg' : 'collat-diff-zero'}">${diff > 0 ? '+' : ''}${_collatFmtUsd(diff)}</span>`;

      const requestedHtml = (r.requested_usd === null || r.requested_usd === undefined)
        ? `<span class="collat-diff-zero">—</span>`
        : _collatFmtUsd(r.requested_usd);

      const shortHtml = short > 0
        ? `<span class="collat-shortfall-pos">${_collatFmtUsd(short)}</span>`
        : `<span class="collat-shortfall-zero">—</span>`;

      return `<tr>
        <td><strong>${r.counterparty}</strong></td>
        <td><span class="collat-book-pill ${r.portfolio_asset.toLowerCase()}">${r.portfolio_asset}</span></td>
        <td class="num">${r.position_count}</td>
        <td class="num">${_collatFmtUsd(r.liability_usd)}</td>
        <td class="num">${postedHtml}</td>
        <td class="num">${_collatFmtUsd(coll)}</td>
        <td class="num ${ratioCls}" style="font-weight:600">${_collatFmtPct(ratio)}</td>
        <td class="num">${marginReqHtml}</td>
        <td class="num">${requestedHtml}</td>
        <td class="num">${diffHtml}</td>
        <td class="num">${shortHtml}</td>
        <td class="num">${balHtml}</td>
        <td class="collat-col-actions">
          <button class="collat-edit-btn" data-cp="${encodeURIComponent(r.counterparty)}" data-pa="${r.portfolio_asset}"
                  data-eth="${r.eth_qty}" data-fil="${r.fil_qty}"
                  data-usdc="${r.usdc_usd}" data-btc="${r.btc_qty}" data-wave="${r.wave_qty}"
                  data-wavepx="${r.wave_price}" data-marginreq="${r.margin_req_tokens}"
                  data-req="${r.requested_usd ?? ''}" data-notes="${(r.notes || '').replace(/"/g, '&quot;')}">
            Edit
          </button>
        </td>
      </tr>`;
    }).join("");

    $tbody.querySelectorAll(".collat-edit-btn").forEach(btn => {
      btn.addEventListener("click", () => collatOpenModal({
        counterparty: decodeURIComponent(btn.dataset.cp),
        portfolio_asset: btn.dataset.pa,
        eth_qty: parseFloat(btn.dataset.eth) || 0,
        fil_qty: parseFloat(btn.dataset.fil) || 0,
        usdc_usd: parseFloat(btn.dataset.usdc) || 0,
        btc_qty: parseFloat(btn.dataset.btc) || 0,
        wave_qty: parseFloat(btn.dataset.wave) || 0,
        wave_price: parseFloat(btn.dataset.wavepx) || 0,
        margin_req_tokens: parseFloat(btn.dataset.marginreq) || 0,
        requested_usd: btn.dataset.req ? parseFloat(btn.dataset.req) : null,
        notes: btn.dataset.notes || "",
        existing: true,
      }));
    });
  }

  // Footer total row
  const $tfoot = document.getElementById("collat-tfoot");
  const totalPosCount = rows.reduce((a, r) => a + (r.position_count || 0), 0);
  const ratioCls = _collatRatioClass(totalRatio);

  const totalPostedHtml = _collatPostedCell({
    eth_qty: p.eth_qty, fil_qty: p.fil_qty, btc_qty: p.btc_qty,
    wave_qty: p.wave_qty, wave_price: 1, usdc_usd: p.usdc_usd,
  });

  const marginReqFootHtml = p.margin_req_usd
    ? _collatFmtUsd(p.margin_req_usd) : `<span class="collat-diff-zero">—</span>`;
  const balFoot = p.balance_usd;
  const balFootHtml = (balFoot === null || balFoot === undefined)
    ? `<span class="collat-diff-zero">—</span>`
    : `<span class="${balFoot > 0 ? 'collat-diff-pos' : balFoot < 0 ? 'collat-diff-neg' : 'collat-diff-zero'}" style="font-weight:600">${balFoot > 0 ? '+' : ''}${_collatFmtUsd(balFoot)}</span>`;

  const portfolioReq = p.requested_usd;
  const portfolioDiff = p.diff_usd;
  const reqFootHtml = (portfolioReq === null || portfolioReq === undefined)
    ? `<span class="collat-diff-zero">—</span>` : _collatFmtUsd(portfolioReq);
  const diffFootHtml = (portfolioDiff === null || portfolioDiff === undefined)
    ? `<span class="collat-diff-zero">—</span>`
    : `<span class="${portfolioDiff > 0 ? 'collat-diff-pos' : portfolioDiff < 0 ? 'collat-diff-neg' : 'collat-diff-zero'}">${portfolioDiff > 0 ? '+' : ''}${_collatFmtUsd(portfolioDiff)}</span>`;
  const shortFootHtml = totalShort > 0
    ? `<span class="collat-shortfall-pos">${_collatFmtUsd(totalShort)}</span>`
    : `<span class="collat-shortfall-zero">—</span>`;

  const filterLabel = collatAssetFilter === "all" ? "Portfolio" : `Portfolio (${collatAssetFilter} only)`;
  $tfoot.innerHTML = `<tr>
    <td>${filterLabel}</td>
    <td></td>
    <td class="num">${totalPosCount}</td>
    <td class="num">${_collatFmtUsd(p.liability_usd)}</td>
    <td class="num">${totalPostedHtml}</td>
    <td class="num">${_collatFmtUsd(totalColl)}</td>
    <td class="num ${ratioCls}">${_collatFmtPct(totalRatio)}</td>
    <td class="num">${marginReqFootHtml}</td>
    <td class="num">${reqFootHtml}</td>
    <td class="num">${diffFootHtml}</td>
    <td class="num">${shortFootHtml}</td>
    <td class="num">${balFootHtml}</td>
    <td></td>
  </tr>`;

  // Nav badge
  const $badge = document.getElementById("nav-badge-collateral");
  if ($badge) {
    if (totalShort > 0) {
      const m = totalShort >= 1e6 ? `${(totalShort / 1e6).toFixed(1)}M` : `${Math.round(totalShort / 1000)}k`;
      $badge.textContent = `-$${m}`;
      $badge.style.background = "var(--red)";
      $badge.style.color = "#fff";
    } else {
      $badge.textContent = "";
      $badge.style.background = "";
    }
  }
}

function collatOpenModal(prefill = {}) {
  const $modal = document.getElementById("collat-modal");
  const isEdit = !!prefill.existing;
  collatEditKey = isEdit ? { counterparty: prefill.counterparty, portfolio_asset: prefill.portfolio_asset } : null;

  document.getElementById("collat-modal-title").textContent = isEdit
    ? `Edit — ${prefill.counterparty} · ${prefill.portfolio_asset} book`
    : "New margin entry";

  document.getElementById("collat-modal-cp").value = prefill.counterparty || "";
  document.getElementById("collat-modal-portfolio").value = prefill.portfolio_asset || "ETH";
  document.getElementById("collat-modal-eth").value = prefill.eth_qty || "";
  document.getElementById("collat-modal-fil").value = prefill.fil_qty || "";
  document.getElementById("collat-modal-usdc").value = prefill.usdc_usd || "";
  document.getElementById("collat-modal-btc").value = prefill.btc_qty || "";
  document.getElementById("collat-modal-wave").value = prefill.wave_qty || "";
  document.getElementById("collat-modal-wave-price").value = prefill.wave_price || "";
  document.getElementById("collat-modal-margin-req").value = prefill.margin_req_tokens || "";
  document.getElementById("collat-modal-requested").value = (prefill.requested_usd ?? "");
  document.getElementById("collat-modal-notes").value = prefill.notes || "";

  // Lock counterparty/book when editing — keeps the row identity stable
  document.getElementById("collat-modal-cp").disabled = isEdit;
  document.getElementById("collat-modal-portfolio").disabled = isEdit;

  document.getElementById("btn-collat-modal-delete").style.display = isEdit ? "" : "none";

  collatUpdateModalPreview();
  $modal.classList.add("open");
  if (!isEdit) document.getElementById("collat-modal-cp").focus();
}

function collatCloseModal() {
  document.getElementById("collat-modal").classList.remove("open");
  collatEditKey = null;
}

function collatUpdateModalPreview() {
  const spots = (collatLast && collatLast.spots) || {};
  const haircuts = (collatLast && collatLast.haircuts) || { ETH: 0.10, FIL: 0.50, BTC: 0.15, WAVE: 0.50, USDC: 0.0 };
  const num = (id) => parseFloat(document.getElementById(id).value) || 0;
  const legs = [
    [num("collat-modal-eth") * (spots.ETH || 0), haircuts.ETH ?? 0.10],
    [num("collat-modal-fil") * (spots.FIL || 0), haircuts.FIL ?? 0.50],
    [num("collat-modal-btc") * (spots.BTC || 0), haircuts.BTC ?? 0.15],
    [num("collat-modal-wave") * num("collat-modal-wave-price"), haircuts.WAVE ?? 0.50],
    [num("collat-modal-usdc"), haircuts.USDC ?? 0.0],
  ];
  const totalNh = legs.reduce((s, [v]) => s + v, 0);
  const totalHc = legs.reduce((s, [v, h]) => s + v * (1 - h), 0);
  const $preview = document.getElementById("collat-modal-preview");
  if (!$preview) return;
  if (totalNh === 0) {
    $preview.textContent = "";
    return;
  }
  $preview.innerHTML = `= ${_collatFmtUsd(totalNh)} <span style="opacity:.6">no haircut</span> · <strong>${_collatFmtUsd(totalHc)}</strong> with haircuts`;
}

async function collatSaveModal() {
  const cp = document.getElementById("collat-modal-cp").value.trim();
  const pa = document.getElementById("collat-modal-portfolio").value;
  const num = (id) => parseFloat(document.getElementById(id).value) || 0;
  const eth = num("collat-modal-eth");
  const fil = num("collat-modal-fil");
  const usdc = num("collat-modal-usdc");
  const btc = num("collat-modal-btc");
  const wave = num("collat-modal-wave");
  const wavePrice = num("collat-modal-wave-price");
  const marginReq = num("collat-modal-margin-req");
  const reqRaw = document.getElementById("collat-modal-requested").value.trim();
  const requested = reqRaw === "" ? null : parseFloat(reqRaw);
  const notes = document.getElementById("collat-modal-notes").value.trim() || null;

  if (!cp) { alert("Counterparty required"); return; }
  if (Math.min(eth, fil, usdc, btc, wave, wavePrice, marginReq) < 0) { alert("Quantities must be ≥ 0"); return; }
  if (requested !== null && (!isFinite(requested) || requested < 0)) { alert("Requested USD must be ≥ 0"); return; }

  try {
    await api("PUT", "/api/collateral/margin", {
      counterparty: cp,
      portfolio_asset: pa,
      eth_qty: eth,
      fil_qty: fil,
      usdc_usd: usdc,
      btc_qty: btc,
      wave_qty: wave,
      wave_price: wavePrice,
      margin_req_tokens: marginReq,
      requested_usd: requested,
      notes,
    });
    collatCloseModal();
    await collatLoad();
  } catch (e) {
    alert(`Save failed: ${e.message || e}`);
  }
}

async function collatDeleteModal() {
  if (!collatEditKey) return;
  if (!confirm(`Delete margin row for ${collatEditKey.counterparty} · ${collatEditKey.portfolio_asset}?`)) return;
  try {
    await api("DELETE", `/api/collateral/margin?counterparty=${encodeURIComponent(collatEditKey.counterparty)}&portfolio_asset=${collatEditKey.portfolio_asset}`);
    collatCloseModal();
    await collatLoad();
  } catch (e) {
    alert(`Delete failed: ${e.message || e}`);
  }
}

(function initCollateralUi() {
  const setup = () => {
    const save = document.getElementById("btn-collat-save");
    if (save) save.addEventListener("click", () => collatSaveChanges());

    const refresh = document.getElementById("btn-collat-refresh");
    if (refresh) refresh.addEventListener("click", () => {
      if (collatPendingCount() && !confirm(`Discard ${collatPendingCount()} unsaved change(s) and reload?`)) return;
      collatLoad();
    });

    const toggle = document.getElementById("collat-haircut-toggle");
    if (toggle) toggle.addEventListener("change", () => collatRenderMap());

    const addCp = document.getElementById("btn-collat-add-cp");
    if (addCp) addCp.addEventListener("click", () => collatAddCp());

    // Auto-refresh while the Collateral tab is open, every 10 min — this is also
    // when live prices refresh (the backend caches them for 10 min). Skips when a
    // map input is focused or there are unsaved edits, so it never clobbers work.
    setInterval(() => {
      const page = document.getElementById("page-collateral");
      if (!page || !page.classList.contains("active")) return;
      if (collatPendingCount()) return;
      const ae = document.activeElement;
      if (ae && ae.closest && ae.closest("#collat-map-table")) return;
      collatLoad();
    }, 600000);

    document.getElementById("collat-modal-close")?.addEventListener("click", collatCloseModal);
    document.getElementById("btn-collat-modal-cancel")?.addEventListener("click", collatCloseModal);
    document.getElementById("btn-collat-modal-save")?.addEventListener("click", collatSaveModal);
    document.getElementById("btn-collat-modal-delete")?.addEventListener("click", collatDeleteModal);

    ["collat-modal-eth", "collat-modal-fil", "collat-modal-usdc", "collat-modal-btc",
     "collat-modal-wave", "collat-modal-wave-price"].forEach(id => {
      document.getElementById(id)?.addEventListener("input", collatUpdateModalPreview);
    });

    const backdrop = document.getElementById("collat-modal");
    if (backdrop) backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) collatCloseModal();
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();

// ════════════════════════════════════════════════════════════
// DEALS / RISK PAGE
// ════════════════════════════════════════════════════════════
let dealsLoaded = false;
let dealsData = null;            // full /api/deals response
let dealsSelectedIds = new Set();// ids of deals selected for compare
let dealsClosed = new Set();     // leg ids marked to close (what-if, single deal)

// Deal-list filter/quick-select state. Filters narrow the visible list; the
// "Select shown" button then selects everything currently visible.
//   cpty   : counterparty name ("" = all)
//   expiry : one expiry date ("" = all) — matches deals that touch it
//   tdate  : one trade date ("" = all)
//   legs   : Set of leg-composition tags a deal must contain (AND):
//            'C','P','sC','sP','lC','lP' (short/long call/put)
//   up     : directional impact of a ~+15% spot move ("gain"|"loss"|"")
//   state  : where the deal sits on its own payoff curve at current spot
//            ("maxloss" = near worst case | "maxprofit" = near best | "")
let dealsFilter = { cpty: "", expiry: "", tdate: "", legs: new Set(), up: "", state: "" };
function resetDealsFilter() {
  dealsFilter = { cpty: "", expiry: "", tdate: "", legs: new Set(), up: "", state: "" };
}

// Distinct colors for overlaying multiple deal profiles on one chart.
const DEAL_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f85149",
                     "#39c5cf", "#ff7b72", "#a5d6ff", "#7ee787", "#ffa657"];

const fmtUsd = (v) => {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  const n = Number(v);
  const a = Math.abs(n);
  let s;
  if (a >= 1e6) s = (n / 1e6).toFixed(2) + "M";
  else if (a >= 1e3) s = (n / 1e3).toFixed(1) + "k";
  else s = n.toFixed(0);
  return "$" + s;
};
const fmtPct1 = (v) => (v === null || v === undefined || !isFinite(v)) ? "—" : (v * 100).toFixed(0) + "%";
const dealAsset = () => currentAsset;

// Manual grouping overrides { counterparty: { legId: groupId } }, persisted per
// asset in localStorage so the user's group/ungroup choices survive reloads.
let dealsOverrides = {};
const _ovKey = () => `plgo_deal_overrides_${dealAsset()}`;
function loadOverrides() {
  try { dealsOverrides = JSON.parse(localStorage.getItem(_ovKey()) || "{}") || {}; }
  catch { dealsOverrides = {}; }
}
function saveOverrides() {
  try { localStorage.setItem(_ovKey(), JSON.stringify(dealsOverrides)); } catch {}
}

// Same manual grouping the Deals screen uses, for the optimizer's
// composite_overrides param — re-reads localStorage so it's fresh even if
// the Deals screen wasn't opened this session (e.g. a stale in-memory
// dealsOverrides from a previously viewed asset).
function currentCompositeOverrides() {
  loadOverrides();
  return dealsOverrides;
}

// Current resolved grouping for a counterparty, read back from the rendered
// deals: { legId(str): groupId }. Lets us pin existing groups while we modify
// only the legs the user touched.
function currentGroupingFor(cpty) {
  const map = {};
  dealsData.deals.filter(d => d.counterparty === cpty).forEach(d => {
    d.leg_ids.forEach(id => { map[String(id)] = d.group_id; });
  });
  return map;
}

// Merge the selected deals (must share a counterparty) into one manual deal.
function groupSelectedDeals() {
  const deals = selectedDeals();
  if (deals.length < 2) return;
  const cpty = deals[0].counterparty;
  if (!deals.every(d => d.counterparty === cpty)) {
    alert("Deals can only be grouped within the same counterparty.");
    return;
  }
  const map = currentGroupingFor(cpty);          // pin existing groups…
  const newId = "manual-" + Date.now().toString(36);
  deals.forEach(d => d.leg_ids.forEach(id => { map[String(id)] = newId; }));  // …reassign selected
  dealsOverrides[cpty] = map;
  saveOverrides();
  dealsSelectedIds = new Set([`${cpty}|${newId}`]);
  loadDeals();
}

// Ungroup: drop this counterparty's manual overrides → back to suggested split.
function ungroupCounterparty(cpty) {
  if (dealsOverrides[cpty]) { delete dealsOverrides[cpty]; saveOverrides(); }
  dealsSelectedIds = new Set();
  loadDeals();
}

async function dealsInit() {
  dealsLoaded = true;
  const incExp = document.getElementById("deals-include-expired");
  const $refresh = document.getElementById("btn-deals-refresh");
  if ($refresh && !$refresh._wired) {
    $refresh._wired = true;
    $refresh.addEventListener("click", () => loadDeals());
    incExp?.addEventListener("change", () => loadDeals());
  }
  await loadDeals();
}

async function loadDeals() {
  const list = document.getElementById("deals-list");
  const detail = document.getElementById("deals-detail");
  list.innerHTML = `<div class="deals-empty">Loading deals…</div>`;
  detail.innerHTML = `<div class="deals-empty">Select a deal on the left to analyse it.</div>`;
  const incExp = !!document.getElementById("deals-include-expired")?.checked;
  loadOverrides();
  try {
    dealsData = await post(`/api/deals`, {
      asset: dealAsset(), include_expired: incExp, overrides: dealsOverrides,
    });
  } catch (e) {
    list.innerHTML = `<div class="deals-empty">Failed to load deals: ${e.message}</div>`;
    return;
  }
  const n = dealsData.deals.length;
  const nManual = dealsData.deals.filter(d => d.manual).length;
  const meta = document.getElementById("deals-meta");
  if (meta) meta.textContent =
    `${n} deal${n === 1 ? "" : "s"}${nManual ? ` (${nManual} grouped)` : ""} · spot ${fmtStrike(dealsData.spot)}`;
  // Keep any prior selection that still exists; otherwise select the first deal.
  const valid = new Set(dealsData.deals.map(d => d.id));
  dealsSelectedIds = new Set([...dealsSelectedIds].filter(id => valid.has(id)));
  if (!dealsSelectedIds.size && dealsData.deals[0]) dealsSelectedIds.add(dealsData.deals[0].id);
  dealsClosed = new Set();
  resetDealsFilter();
  renderDealFilters();
  renderDealList();
  renderDealsView();
}

function popClass(p) {
  if (p === null || p === undefined) return "";
  if (p >= 0.66) return "deal-pop-good";
  if (p >= 0.33) return "deal-pop-mid";
  return "deal-pop-bad";
}

// Linear-interpolate a per-grid array (e.g. a payoff curve) at an arbitrary
// spot level. Grid is ascending; clamps to the ends.
function dealInterpAt(arr, x) {
  const g = dealsData.grid;
  if (!g || !g.length || !arr) return null;
  if (x <= g[0]) return arr[0];
  if (x >= g[g.length - 1]) return arr[arr.length - 1];
  for (let i = 0; i < g.length - 1; i++) {
    if (x >= g[i] && x <= g[i + 1]) {
      const t = (g[i + 1] - g[i]) ? (x - g[i]) / (g[i + 1] - g[i]) : 0;
      return arr[i] + (arr[i + 1] - arr[i]) * t;
    }
  }
  return arr[arr.length - 1];
}

// Where the deal sits on its own payoff curve *at the current spot*, as a
// fraction from 0 (max loss) to 1 (max profit). null when the curve is flat.
function dealPnlPosition(d) {
  const range = d.max_profit - d.max_loss;
  if (!isFinite(range) || range <= 1e-9) return null;
  const here = dealInterpAt(d.payoff, dealsData.spot);
  if (here === null) return null;
  return (here - d.max_loss) / range;
}

// Directional impact of a ~+15% spot move: does the deal make or lose money if
// price goes up from here? Uses the at-expiry payoff curve so it reflects a
// real move (not just instantaneous delta) and handles capped structures.
function dealUpImpact(d) {
  const spot = dealsData.spot;
  if (!(spot > 0)) return "flat";
  const here = dealInterpAt(d.payoff, spot);
  const up = dealInterpAt(d.payoff, spot * 1.15);
  if (here === null || up === null) return "flat";
  const eps = Math.max(1, Math.abs(d.max_profit - d.max_loss) * 0.01);
  if (up > here + eps) return "gain";
  if (up < here - eps) return "loss";
  return "flat";
}

// Does a deal contain a leg matching a composition tag?
function dealHasLegTag(d, tag) {
  const opt = tag.slice(-1);                     // 'C' or 'P'
  const side = tag.length === 2 ? (tag[0] === "s" ? "Short" : "Long") : null;
  return d.legs.some(l => l.opt === opt && (!side || l.side === side));
}

function dealMatchesFilter(d) {
  const f = dealsFilter;
  if (f.cpty && d.counterparty !== f.cpty) return false;
  if (f.expiry && !(d.expiries || [d.expiry]).includes(f.expiry)) return false;
  if (f.tdate && !(d.trade_dates || [d.trade_date]).includes(f.tdate)) return false;
  for (const tag of f.legs) if (!dealHasLegTag(d, tag)) return false;
  if (f.up && dealUpImpact(d) !== f.up) return false;
  if (f.state) {
    const pos = dealPnlPosition(d);
    if (pos === null) return false;
    if (f.state === "maxloss" && pos > 0.15) return false;
    if (f.state === "maxprofit" && pos < 0.85) return false;
  }
  return true;
}

function visibleDeals() {
  return dealsData.deals.filter(dealMatchesFilter);
}

// Re-render the filter bar + list + count without refetching.
function applyDealsFilter() {
  renderDealFilters();
  renderDealList();
}

function renderDealFilters() {
  const host = document.getElementById("deals-filters");
  if (!host || !dealsData) return;
  const deals = dealsData.deals;
  const cptys = [...new Set(deals.map(d => d.counterparty).filter(Boolean))].sort();
  const expiries = [...new Set(deals.flatMap(d => d.expiries || [d.expiry]).filter(Boolean))].sort();
  const tdates = [...new Set(deals.flatMap(d => d.trade_dates || [d.trade_date]).filter(Boolean))].sort();
  const f = dealsFilter;
  const shown = visibleDeals().length;

  const chip = (label, active, attrs, extra = "") =>
    `<span class="deal-chip ${active ? "active " + extra : ""}" ${attrs}>${label}</span>`;

  const cptyChips = [chip("All", !f.cpty, `data-cpty=""`)]
    .concat(cptys.map(c => chip(c, f.cpty === c, `data-cpty="${c}"`))).join("");

  const legDefs = [["C", "Calls"], ["P", "Puts"], ["sC", "Short C"], ["sP", "Short P"],
                   ["lC", "Long C"], ["lP", "Long P"]];
  const legChips = legDefs.map(([tag, lbl]) =>
    chip(lbl, f.legs.has(tag), `data-leg="${tag}"`)).join("");

  const opt = (v, sel) => `<option value="${v}" ${sel === v ? "selected" : ""}>${v || "All"}</option>`;
  const expSel = `<select class="deals-filter-sel" data-sel="expiry">${["", ...expiries].map(e => opt(e, f.expiry)).join("")}</select>`;
  const tdSel = `<select class="deals-filter-sel" data-sel="tdate">${["", ...tdates].map(t => opt(t, f.tdate)).join("")}</select>`;

  host.innerHTML = `
    <div class="deals-filter-row"><span class="deals-filter-lbl">Party</span>${cptyChips}</div>
    <div class="deals-filter-row"><span class="deals-filter-lbl">When</span>${expSel}${tdSel}</div>
    <div class="deals-filter-row"><span class="deals-filter-lbl">Legs</span>${legChips}</div>
    <div class="deals-filter-row"><span class="deals-filter-lbl">If spot ↑</span>
      ${chip("Gains", f.up === "gain", `data-up="gain"`, "chip-gain")}
      ${chip("Loses", f.up === "loss", `data-up="loss"`, "chip-loss")}
      <span class="deals-filter-lbl" style="min-width:auto;margin-left:.4rem">P&amp;L now</span>
      ${chip("Near max loss", f.state === "maxloss", `data-state="maxloss"`, "chip-loss")}
      ${chip("Near max profit", f.state === "maxprofit", `data-state="maxprofit"`, "chip-gain")}
    </div>
    <div class="deals-filter-row deals-filter-actions">
      <span class="deal-chip" data-act="select">Select shown</span>
      <span class="deal-chip" data-act="clearsel">Clear selection</span>
      <span class="deal-chip" data-act="reset">Reset filters</span>
      <span class="deals-filter-count">${shown} / ${deals.length} shown · ${dealsSelectedIds.size} selected</span>
    </div>`;

  // Wire counterparty chips (single-select).
  host.querySelectorAll("[data-cpty]").forEach(el =>
    el.addEventListener("click", () => { f.cpty = el.dataset.cpty; applyDealsFilter(); }));
  // Leg-composition chips (multi, toggle).
  host.querySelectorAll("[data-leg]").forEach(el =>
    el.addEventListener("click", () => {
      const t = el.dataset.leg;
      f.legs.has(t) ? f.legs.delete(t) : f.legs.add(t);
      applyDealsFilter();
    }));
  // Direction / state chips (single-select, click active to clear).
  host.querySelectorAll("[data-up]").forEach(el =>
    el.addEventListener("click", () => { f.up = f.up === el.dataset.up ? "" : el.dataset.up; applyDealsFilter(); }));
  host.querySelectorAll("[data-state]").forEach(el =>
    el.addEventListener("click", () => { f.state = f.state === el.dataset.state ? "" : el.dataset.state; applyDealsFilter(); }));
  // Expiry / trade-date selects.
  host.querySelectorAll("[data-sel]").forEach(el =>
    el.addEventListener("change", () => { f[el.dataset.sel] = el.value; applyDealsFilter(); }));
  // Actions.
  host.querySelector('[data-act="select"]')?.addEventListener("click", () => {
    visibleDeals().forEach(d => dealsSelectedIds.add(d.id));
    dealsClosed = new Set();
    renderDealFilters(); renderDealList(); renderDealsView();
  });
  host.querySelector('[data-act="clearsel"]')?.addEventListener("click", () => {
    dealsSelectedIds = new Set(); dealsClosed = new Set();
    renderDealFilters(); renderDealList(); renderDealsView();
  });
  host.querySelector('[data-act="reset"]')?.addEventListener("click", () => {
    resetDealsFilter(); applyDealsFilter();
  });
}

function renderDealList() {
  const list = document.getElementById("deals-list");
  if (!dealsData.deals.length) {
    const expHint = document.getElementById("deals-include-expired")?.checked
      ? ""
      : `<br><br>All ${dealAsset()} positions may have expired. Tick <b>Include Expired</b> above to see them.`;
    list.innerHTML = `<div class="deals-empty">No active deals for ${dealAsset()}.${expHint}</div>`;
    return;
  }
  const deals = visibleDeals();
  if (!deals.length) {
    list.innerHTML = `<div class="deals-empty">No deals match the current filters.<br><br>Click <b>Reset filters</b> above to see all ${dealsData.deals.length} deals.</div>`;
    return;
  }
  list.innerHTML = "";
  deals.forEach((d, i) => {
    const card = document.createElement("div");
    const sel = dealsSelectedIds.has(d.id);
    card.className = "deal-card" + (sel ? " selected" : "");
    card.dataset.id = d.id;
    const pop = d.prob_profit;
    // Colour swatch matches the deal's line on the chart when selected.
    const swatch = sel ? `<span class="deal-swatch" style="background:${dealColor(d.id)}"></span>` : "";
    card.innerHTML = `
      <div class="deal-card-top">
        <span class="deal-card-cpty"><input type="checkbox" class="deal-select-cb" ${sel ? "checked" : ""}>${swatch}${d.counterparty || "—"}</span>
        <span class="deal-badge">${d.strategy}</span>
      </div>
      <div class="deal-card-meta">
        <span>${d.trade_date} · ${d.n_legs} legs · ${d.days_to_expiry}d</span>
        <span class="deal-card-pop ${popClass(pop)}">P ${fmtPct1(pop)}</span>
      </div>
      <div class="deal-card-meta" style="margin-top:.2rem">
        <span>max +${fmtUsd(d.max_profit)} / ${fmtUsd(d.max_loss)}</span>
        <span>MTM ${fmtUsd(d.mtm)}</span>
      </div>`;
    card.addEventListener("click", () => toggleDeal(d.id));
    list.appendChild(card);
  });
}

// Stable colour for a selected deal (by its position in the selection order).
function dealColor(id) {
  const order = [...dealsSelectedIds];
  const idx = order.indexOf(id);
  return DEAL_COLORS[(idx < 0 ? order.length : idx) % DEAL_COLORS.length];
}

function toggleDeal(id) {
  if (dealsSelectedIds.has(id)) dealsSelectedIds.delete(id);
  else dealsSelectedIds.add(id);
  dealsClosed = new Set();   // what-if only applies to a single focused deal
  renderDealFilters();       // keep the "selected" count in sync
  renderDealList();
  renderDealsView();
}

// Recompute payoff + risk metrics for the current deal given a set of legs
// marked to close. Closing a leg replaces its expiry payoff with the cash
// realised today (its premium + current MTM), shifting the curve by a constant.
function dealMetrics(deal, closedSet) {
  const grid = dealsData.grid;
  const mass = deal.prob_mass;
  const after = new Array(grid.length).fill(0);
  let shift = 0;        // P&L locked in from closed legs (premium + close cash)
  let netCloseCash = 0; // market cash transacted now (cost-to-close metric)
  deal.legs.forEach(leg => {
    if (closedSet.has(leg.id)) {
      shift += (leg.premium_usd || 0) + (leg.close_cash || 0);
      netCloseCash += (leg.close_cash || 0);
    } else {
      const p = leg.payoff;
      for (let i = 0; i < grid.length; i++) after[i] += p[i];
    }
  });
  for (let i = 0; i < after.length; i++) after[i] += shift;
  let maxP = -Infinity, maxL = Infinity;
  for (const v of after) { if (v > maxP) maxP = v; if (v < maxL) maxL = v; }
  let probProfit = null, expected = null;
  if (mass) {
    probProfit = 0; expected = 0;
    for (let i = 0; i < after.length; i++) {
      if (after[i] > 0) probProfit += mass[i];
      expected += after[i] * mass[i];
    }
  }
  return { after, maxP, maxL, probProfit, expected, netCloseCash, be: beCrossings(grid, after) };
}

function beCrossings(grid, payoff) {
  const out = [];
  for (let i = 0; i < grid.length - 1; i++) {
    const y0 = payoff[i], y1 = payoff[i + 1];
    if (y0 * y1 < 0) {
      const x0 = grid[i], x1 = grid[i + 1];
      out.push(x0 + (x1 - x0) * (-y0) / (y1 - y0));
    }
  }
  return out;
}

function selectedDeals() {
  // Preserve selection order so colours stay stable.
  return [...dealsSelectedIds]
    .map(id => dealsData.deals.find(d => d.id === id))
    .filter(Boolean);
}

// Compact summary "little screen" for one deal, following the risk-grid template.
function dealSummaryCard(d, m) {
  return `
    <section class="card deal-summary-card" style="border-left:3px solid ${dealColor(d.id)}">
      <h2 style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;margin-bottom:.6rem">
        <span><span class="deal-swatch" style="background:${dealColor(d.id)}"></span>${d.counterparty} · ${d.strategy}</span>
        <span style="color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0">${d.n_legs} legs · exp ${d.expiry}</span>
      </h2>
      <div class="risk-grid">
        <div class="risk-metric"><span class="risk-label">P(profit)</span><span class="risk-value ${popClass(m.probProfit)}">${fmtPct1(m.probProfit)}</span></div>
        <div class="risk-metric"><span class="risk-label">Expected P&L</span><span class="risk-value" style="color:${(m.expected||0)>=0?'var(--green)':'var(--red)'}">${fmtUsd(m.expected)}</span></div>
        <div class="risk-metric"><span class="risk-label">Max Profit</span><span class="risk-value">${fmtUsd(m.maxP)}</span></div>
        <div class="risk-metric"><span class="risk-label">Max Loss</span><span class="risk-value" style="color:var(--red)">${fmtUsd(m.maxL)}</span></div>
        <div class="risk-metric"><span class="risk-label">Breakeven</span><span class="risk-value" style="font-size:.95rem">${m.be.length ? m.be.map(b => fmtStrike(b)).join(" / ") : "—"}</span></div>
        <div class="risk-metric"><span class="risk-label">Net Credit</span><span class="risk-value" style="color:${d.net_credit>=0?'var(--green)':'var(--red)'}">${fmtUsd(d.net_credit)}</span></div>
        <div class="risk-metric"><span class="risk-label">MTM</span><span class="risk-value" style="color:var(--text)">${fmtUsd(d.mtm)}</span></div>
        <div class="risk-metric"><span class="risk-label">&Delta;</span><span class="risk-value" style="color:var(--text)">${d.greeks.delta.toFixed(1)}</span></div>
        <div class="risk-metric"><span class="risk-label">&Theta;/day</span><span class="risk-value" style="color:var(--text)">${fmtUsd(d.greeks.theta)}</span></div>
        <div class="risk-metric"><span class="risk-label">&nu; /1%</span><span class="risk-value" style="color:var(--text)">${fmtUsd(d.greeks.vega)}</span></div>
      </div>
    </section>`;
}

function whatifBannerHtml(deal, base, wi) {
  return `
    <div class="deals-whatif-banner">
      <b>What-if:</b> closing ${dealsClosed.size} leg(s) ·
      net cash to do it: <b style="color:${Math.abs(wi.netCloseCash) < zeroCostTol(deal) ? 'var(--green)' : 'var(--orange)'}">${fmtUsd(wi.netCloseCash)}</b>
      ${wi.netCloseCash >= 0 ? "(you receive)" : "(you pay)"} ·
      max loss ${fmtUsd(base.maxL)} → <b>${fmtUsd(wi.maxL)}</b> ·
      P(profit) ${fmtPct1(base.probProfit)} → <b>${fmtPct1(wi.probProfit)}</b>
      <button id="btn-deals-reset-whatif" class="btn-secondary" style="width:auto;margin-left:.6rem;padding:.15rem .5rem">Reset</button>
    </div>`;
}

function renderDealsView() {
  const detail = document.getElementById("deals-detail");
  const deals = selectedDeals();
  if (!deals.length) {
    detail.innerHTML = `<div class="deals-empty">Select one or more deals on the left to see each one's summary and overlay their payoff profiles.</div>`;
    return;
  }
  const single = deals.length === 1 ? deals[0] : null;
  const hasWhatIf = !!single && dealsClosed.size > 0;
  const base = single ? dealMetrics(single, new Set()) : null;
  const wi = single ? dealMetrics(single, dealsClosed) : null;

  // One summary "little screen" per selected deal — shown separately.
  const summaries = deals.map(d => {
    const m = (single && hasWhatIf) ? wi : dealMetrics(d, new Set());
    return dealSummaryCard(d, m);
  }).join("");

  // Legs / what-if / zero-cost tool — only meaningful for a single focused deal.
  const ungroupBtn = (single && single.manual)
    ? `<button id="btn-deals-ungroup" class="btn-secondary" style="width:auto" title="Drop manual grouping for ${single.counterparty} and return to the auto-suggested structures">Ungroup → suggested</button>`
    : "";
  const legsSection = single ? `
    <section class="card">
      <div class="pf-toolbar" style="margin-bottom:.6rem">
        <h2 style="margin:0">Legs — tick to close (what-if)</h2>
        <div class="pf-toolbar-spacer"></div>
        ${ungroupBtn}
        <button id="btn-deals-suggest" class="btn-primary" style="width:auto">Suggest zero-cost improvements</button>
      </div>
      <table class="deals-legs-table">
        <thead><tr>
          <th></th><th class="lt">Leg</th><th>Trade Date</th><th>Expiry</th><th>Strike</th><th>Qty</th>
          <th>IV</th><th>Premium</th><th>MTM / Close</th>
        </tr></thead>
        <tbody id="deals-legs-body"></tbody>
      </table>
      <div id="deals-suggestions" style="margin-top:.8rem"></div>
    </section>` : `
    <section class="card">
      <p style="margin:0;font-size:.8rem;color:var(--muted)">
        ${deals.length} deals selected — comparing payoff profiles.
        ${canGroup(deals) ? "Use <b>Group selected</b> above to merge them into one deal." : "Select a single deal for the leg-level what-if and zero-cost close tool."}
      </p>
    </section>`;

  const groupBtn = canGroup(deals)
    ? `<button id="btn-deals-group" class="btn-primary" style="width:auto" title="Merge the selected deals into one deal">Group selected (${deals.length})</button>`
    : "";

  detail.innerHTML = `
    <section class="card">
      <div class="pf-toolbar">
        <h2 style="margin:0">Payoff Profiles ${single ? "" : `· ${deals.length} deals`}</h2>
        <div class="pf-toolbar-spacer"></div>
        ${groupBtn}
        <button id="btn-deals-to-optv2" class="btn-primary" style="width:auto" title="Load the selected deals' trades into Optimizer v2 as the base book to optimize against">Send to Optimizer v2 (${deals.length})</button>
        <button id="btn-deals-clear-sel" class="btn-secondary" style="width:auto">Clear selection</button>
      </div>
      ${hasWhatIf ? whatifBannerHtml(single, base, wi) : ""}
      <div id="deals-payoff-chart" class="chart-container" style="min-height:440px"></div>
    </section>
    <div class="deals-summary-grid">${summaries}</div>
    ${legsSection}`;

  drawDealsChart(deals, single, base, wi);
  if (single) renderLegsTable(single);

  document.getElementById("btn-deals-clear-sel")?.addEventListener("click", () => {
    dealsSelectedIds = new Set(); dealsClosed = new Set();
    renderDealList(); renderDealsView();
  });
  document.getElementById("btn-deals-to-optv2")?.addEventListener("click", () => sendDealsToOptv2(deals));
  document.getElementById("btn-deals-group")?.addEventListener("click", groupSelectedDeals);
  document.getElementById("btn-deals-ungroup")?.addEventListener("click", () => ungroupCounterparty(single.counterparty));
  document.getElementById("btn-deals-reset-whatif")?.addEventListener("click", () => {
    dealsClosed = new Set(); renderDealsView();
  });
  document.getElementById("btn-deals-suggest")?.addEventListener("click", () => suggestZeroCost(single));
}

// Hand the selected deals' underlying trades to the Optimizer v2 screen as its
// base book (the "current portfolio" the LP optimizes against). The DB trade ids
// live on each deal as `leg_ids`; we flatten + de-dupe them, stash them on a
// shared global, switch to the Optimizer v2 page, and let it scope itself.
function sendDealsToOptv2(deals) {
  const ids = [...new Set((deals || []).flatMap(d => d.leg_ids || []))]
    .map(Number).filter(Number.isFinite);
  if (!ids.length) { alert("No trades found in the selected deals."); return; }
  window._optv2BaseTradeIds = ids;
  window._optv2BaseMeta = { trades: ids.length, deals: deals.length };
  const nav = document.querySelector('.nav-item[data-page="optv2"]');
  if (nav) nav.click();
  if (typeof optv2ApplyBaseSelection === "function") optv2ApplyBaseSelection();
}

// Can the current multi-selection be merged? (2+ deals, same counterparty.)
function canGroup(deals) {
  return deals.length >= 2 && deals.every(d => d.counterparty === deals[0].counterparty);
}

function renderLegsTable(deal) {
  const body = document.getElementById("deals-legs-body");
  body.innerHTML = "";
  deal.legs.forEach(leg => {
    const tr = document.createElement("tr");
    if (dealsClosed.has(leg.id)) tr.className = "leg-closed";
    const sideColor = leg.side === "Long" ? "var(--green)" : "var(--red)";
    tr.innerHTML = `
      <td class="keep-strike"><input type="checkbox" class="deal-leg-cb" data-id="${leg.id}" ${dealsClosed.has(leg.id) ? "checked" : ""}></td>
      <td class="lt" style="color:${sideColor}">${leg.side} ${leg.opt}</td>
      <td class="keep-strike">${leg.trade_date || "—"}</td>
      <td class="keep-strike">${leg.expiry}</td>
      <td class="keep-strike">${fmtStrike(leg.strike)}</td>
      <td>${leg.qty.toLocaleString()}</td>
      <td>${leg.iv_pct}%</td>
      <td class="${leg.premium_usd>=0?'num-pos':'num-neg'}">${fmtUsd(leg.premium_usd)}</td>
      <td class="${leg.close_cash>=0?'num-pos':'num-neg'}">${fmtUsd(leg.close_cash)}</td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll(".deal-leg-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) dealsClosed.add(id); else dealsClosed.delete(id);
      renderDealsView();
    });
  });
}

// Tolerance for "zero cost": small relative to the deal's gross close value.
function zeroCostTol(deal) {
  const gross = deal.legs.reduce((s, l) => s + Math.abs(l.close_cash || 0), 0);
  return Math.max(gross * 0.05, 5000);
}

// Brute-force search over leg subsets for a near-zero-cash close that improves
// the profile (raises max loss / lifts P(profit)). Falls back to greedy when a
// deal has many legs.
function suggestZeroCost(deal) {
  const out = document.getElementById("deals-suggestions");
  const legs = deal.legs;
  const n = legs.length;
  const base = dealMetrics(deal, new Set());
  const tol = zeroCostTol(deal);
  const cands = [];

  const evalSet = (ids) => {
    if (!ids.size) return;
    const m = dealMetrics(deal, ids);
    if (Math.abs(m.netCloseCash) > tol) return;
    const lossGain = m.maxL - base.maxL;       // positive = less downside
    const popGain = (m.probProfit ?? 0) - (base.probProfit ?? 0);
    // Require a real improvement on at least one axis.
    if (lossGain <= 1 && popGain <= 1e-4) return;
    cands.push({ ids: [...ids], lossGain, popGain, netCloseCash: m.netCloseCash, maxL: m.maxL, probProfit: m.probProfit });
  };

  if (n <= 14) {
    for (let mask = 1; mask < (1 << n); mask++) {
      const ids = new Set();
      for (let i = 0; i < n; i++) if (mask & (1 << i)) ids.add(legs[i].id);
      evalSet(ids);
    }
  } else {
    // Greedy: add the single best zero-cost leg repeatedly.
    let cur = new Set();
    for (let step = 0; step < n; step++) {
      let best = null;
      for (const leg of legs) {
        if (cur.has(leg.id)) continue;
        const trial = new Set(cur); trial.add(leg.id);
        const m = dealMetrics(deal, trial);
        if (Math.abs(m.netCloseCash) > tol) continue;
        const score = (m.maxL - base.maxL) + (m.probProfit ?? 0) * 1e5;
        if (!best || score > best.score) best = { id: leg.id, score };
      }
      if (!best) break;
      cur.add(best.id);
      evalSet(new Set(cur));
    }
  }

  // Rank by downside reduction, then P(profit) gain, then cheapest cash.
  cands.sort((a, b) => (b.lossGain - a.lossGain) || (b.popGain - a.popGain) || (Math.abs(a.netCloseCash) - Math.abs(b.netCloseCash)));
  // De-dup identical id-sets, keep top 5.
  const seen = new Set(); const top = [];
  for (const c of cands) {
    const key = c.ids.slice().sort((x, y) => x - y).join(",");
    if (seen.has(key)) continue; seen.add(key);
    top.push(c); if (top.length >= 5) break;
  }

  if (!top.length) {
    out.innerHTML = `<div class="deals-empty">No zero-cost closing set found that improves this profile (within ±${fmtUsd(tol)} cash). The structure may already be efficient, or improving it would require paying premium.</div>`;
    return;
  }

  out.innerHTML = `<div style="font-size:.78rem;color:var(--muted);margin-bottom:.5rem">Closing sets that cost ≈ $0 and improve the profile:</div>` +
    top.map((c, idx) => {
      const labels = c.ids.map(id => {
        const l = legs.find(x => x.id === id);
        return `${l.side} ${l.opt} ${fmtStrike(l.strike)}`;
      }).join(" + ");
      return `<div class="suggestion-item">
        <div>
          <div class="sug-text">Close: ${labels}</div>
          <div class="sug-sub">cash ${fmtUsd(c.netCloseCash)} · max loss → ${fmtUsd(c.maxL)} (${c.lossGain>0?'+':''}${fmtUsd(c.lossGain)}) · P(profit) → ${fmtPct1(c.probProfit)}</div>
        </div>
        <button class="btn-secondary deals-apply-sug" data-idx="${idx}" style="width:auto">Apply</button>
      </div>`;
    }).join("");

  out.querySelectorAll(".deals-apply-sug").forEach(btn => {
    btn.addEventListener("click", () => {
      const c = top[Number(btn.dataset.idx)];
      dealsClosed = new Set(c.ids);
      renderDealsView();
    });
  });
}

// Overlay each selected deal's payoff profile (one line per deal). When a
// single deal is selected we also show its terminal-spot distribution,
// breakeven markers, and the what-if "after closing" curve.
function drawDealsChart(deals, single, base, wi) {
  const el = document.getElementById("deals-payoff-chart");
  if (!el) return;
  const c = chartColors();
  const accent = "#58a6ff";
  const grid = dealsData.grid;
  const spot = dealsData.spot;
  const hasWhatIf = !!single && dealsClosed.size > 0;

  const traces = [];

  // Single-deal extra: terminal-spot probability distribution (secondary axis).
  if (single && single.prob_density) {
    traces.push({
      x: grid, y: single.prob_density, name: "Spot distribution @ expiry",
      type: "scatter", mode: "lines", yaxis: "y2",
      line: { color: c.muted, width: 1 },
      fill: "tozeroy", fillcolor: "rgba(139,148,158,0.18)",
      hoverinfo: "skip",
    });
  }

  // One payoff line per selected deal. Track overall P&L extent so the spot /
  // breakeven verticals (drawn as traces — log x-axis can't use shapes cleanly)
  // span the full plot.
  let yMin = Infinity, yMax = -Infinity;
  deals.forEach(d => {
    const m = dealMetrics(d, new Set());
    for (const v of m.after) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
    traces.push({
      x: grid, y: m.after,
      name: `${d.counterparty} · ${d.strategy}`,
      type: "scatter", mode: "lines",
      line: { color: dealColor(d.id), width: 2, dash: (single && hasWhatIf) ? "dot" : "solid" },
      hovertemplate: `${d.counterparty} ${d.strategy}<br>Spot %{x}<br>P&L %{y:$,.0f}<extra></extra>`,
    });
  });

  // Single-deal what-if "after closing" curve.
  if (hasWhatIf) {
    for (const v of wi.after) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
    traces.push({
      x: grid, y: wi.after, name: "After closing selected legs",
      type: "scatter", mode: "lines",
      line: { color: accent, width: 2.5 },
      hovertemplate: "Spot %{x}<br>P&L %{y:$,.0f}<extra></extra>",
    });
  }
  if (!isFinite(yMin)) { yMin = -1; yMax = 1; }

  // Current-spot vertical (as a trace, like the platform's payoff charts —
  // shapes mis-position on a log axis).
  traces.push({
    x: [spot, spot], y: [yMin, yMax],
    type: "scatter", mode: "lines",
    name: `Spot ${fmtStrike(spot)}`,
    line: { color: accent, width: 1.5, dash: "dash" },
    hoverinfo: "skip",
  });

  // Breakeven verticals only for a single focused deal (avoids clutter).
  if (single) {
    (hasWhatIf ? wi.be : base.be).forEach((b, i) => {
      traces.push({
        x: [b, b], y: [yMin, yMax],
        type: "scatter", mode: "lines",
        name: `Breakeven ${fmtStrike(b)}`,
        line: { color: c.muted, width: 1, dash: "dot" },
        showlegend: i === 0, legendgroup: "be",
        hoverinfo: "name",
      });
    });
  }

  const maxDensity = (single && single.prob_density) ? Math.max(...single.prob_density) : 1;
  const layout = {
    margin: { l: 60, r: 20, t: 20, b: 50 },
    paper_bgcolor: c.paper, plot_bgcolor: c.plot,
    font: { color: c.text, size: 11 },
    xaxis: { title: `${dealAsset()} spot at expiry (USD) — log scale`, type: "log",
      gridcolor: c.grid, zerolinecolor: c.zeroline },
    yaxis: { title: "P&L (USD)", gridcolor: c.grid, zerolinecolor: "#f85149", zerolinewidth: 2,
      tickformat: "$.2s" },
    yaxis2: { overlaying: "y", side: "right", showgrid: false, showticklabels: false,
      range: [0, maxDensity * 3.2], fixedrange: true },
    legend: { orientation: "h", y: 1.14, bgcolor: c.legendBg, bordercolor: c.legendBorder, borderwidth: 1 },
    showlegend: true,
  };
  Plotly.newPlot(el, traces, layout, { responsive: true, displayModeBar: false });
}

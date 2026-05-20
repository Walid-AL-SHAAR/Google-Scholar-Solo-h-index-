"use strict";

/* ── DOM refs ─────────────────────────────────────────────────────────── */
const stateIdle    = document.getElementById("state-idle");
const stateLoading = document.getElementById("state-loading");
const stateError   = document.getElementById("state-error");
const stateResult  = document.getElementById("state-result");

const btnCalculate = document.getElementById("btn-calculate");
const btnReset     = document.getElementById("btn-reset");

const loadNum      = document.getElementById("load-num");
const progressFill = document.getElementById("progress-fill");

const resultHIndex      = document.getElementById("result-hindex");
const statSole          = document.getElementById("stat-sole");
const statCoauth        = document.getElementById("stat-coauth");
const statCites         = document.getElementById("stat-cites");
const paperList         = document.getElementById("paper-list");
const profilePill       = document.getElementById("profile-pill");
const profileNameText   = document.getElementById("profile-name-text");
const papersLoadedLabel = document.getElementById("papers-loaded-label");
const footerLeft        = document.getElementById("footer-left");
const footerRight       = document.getElementById("footer-right");

/* Track the last known paper count so the progress bar can animate */
let progressCount = 0;

/* ── State helpers ─────────────────────────────────────────────────────── */

function showIdle() {
  stateIdle.style.display    = "block";
  stateLoading.style.display = "none";
  stateError.style.display   = "none";
  stateResult.style.display  = "none";
  btnReset.style.display     = "none";
  footerLeft.textContent     = "Open a Scholar profile to begin";
  footerRight.textContent    = "";
}

function showLoading(count) {
  stateIdle.style.display    = "none";
  stateLoading.style.display = "block";
  stateError.style.display   = "none";
  stateResult.style.display  = "none";
  updateProgress(count);
  footerLeft.textContent  = "Loading all papers automatically…";
  footerRight.textContent = "";
}

function updateProgress(count) {
  progressCount = count;
  loadNum.textContent = count;

  /* Animate the fill bar — we don't know the total, so use a soft easing
     that approaches 90% asymptotically to convey activity */
  const pseudo = Math.min(90, (count / 20) * 8);          // rough heuristic
  progressFill.style.width = pseudo + "%";
}

function showError(message) {
  stateIdle.style.display    = "none";
  stateLoading.style.display = "none";
  stateError.style.display   = "block";
  stateResult.style.display  = "none";
  stateError.innerHTML =
    `<strong>Could not calculate</strong><br/>${escHtml(message)}`;
  footerLeft.textContent  = "";
  footerRight.textContent = "";
}

function showResult(data) {
  stateIdle.style.display    = "none";
  stateLoading.style.display = "none";
  stateError.style.display   = "none";
  stateResult.style.display  = "block";
  btnReset.style.display     = "inline-flex";

  if (data.profileName) {
    profilePill.style.display = "inline-flex";
    profileNameText.textContent = data.profileName;
  } else {
    profilePill.style.display = "none";
  }

  papersLoadedLabel.textContent =
    `Based on all ${data.totalLoaded} loaded papers`;

  animateCount(resultHIndex, data.hIndex);
  statSole.textContent   = data.soleAuthorCount;
  statCoauth.textContent = data.coAuthoredCount;
  statCites.textContent  = data.totalCitations;

  buildPaperList(data.soleAuthorPapers, data.hIndex);

  footerLeft.textContent  = `${data.totalLoaded} papers scanned`;
  footerRight.textContent = `${data.soleAuthorCount} sole-author`;
}

/* ── Paper list ──────────────────────────────────────────────────────── */

function buildPaperList(papers, hIndex) {
  paperList.innerHTML = "";

  if (papers.length === 0) {
    paperList.innerHTML =
      `<div class="no-papers">No sole-author papers found.</div>`;
    return;
  }

  papers.forEach((paper, idx) => {
    const rank = idx + 1;
    const qualifies = paper.citations >= rank;

    const item = document.createElement("div");
    item.className = `paper-item${qualifies ? " qualifies" : ""}`;
    item.title =
      `${paper.title}\n` +
      `Citations: ${paper.citations}\n` +
      (qualifies ? "Qualifies for Solo-h-index" : "Below h-index threshold");

    item.innerHTML = `
      <div class="rank">${rank}</div>
      <div class="paper-title">
        ${escHtml(truncate(paper.title, 52))}
        <span class="year">${escHtml(paper.year || "")}</span>
      </div>
      <div class="paper-cites ${qualifies ? "qualifies" : "not-qualifies"}">
        ${paper.citations}
      </div>`;

    paperList.appendChild(item);
  });
}

/* ── Utilities ───────────────────────────────────────────────────────── */

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function animateCount(el, target) {
  const duration = 700;
  const start    = performance.now();
  (function step(now) {
    const p = Math.min((now - start) / duration, 1);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(target * e);
    if (p < 1) requestAnimationFrame(step);
  })(performance.now());
}

/* ── Message listener (receives progress + result from content.js) ───── */

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "progress") {
    showLoading(message.count);
    return;
  }

  if (message.action === "result") {
    const data = message.data;
    if (!data || data.error) {
      showError(data?.error || "An unexpected error occurred.");
    } else {
      showResult(data);
    }
  }
});

/* ── Main: trigger calculation ───────────────────────────────────────── */

async function startCalculation() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    showError("Could not detect the active tab.");
    return;
  }

  /* Accept any scholar.google.* domain */
  const isScholar = /^https?:\/\/scholar\.google\.[a-z.]+\//.test(tab.url || "");
  if (!isScholar) {
    showError(
      "Please navigate to a Google Scholar profile page " +
      "(scholar.google.com/citations?user=…) and try again."
    );
    return;
  }

  showLoading(0);

  /* Inject content script in case the page was already open before
     the extension was installed, or in case of duplicate-guard re-use */
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ["content.js"],
    });
  } catch (_) {
    /* Already injected — the guard variable prevents double registration */
  }

  /* Tell the content script to start */
  chrome.tabs.sendMessage(tab.id, { action: "startCalculation" }, () => {
    if (chrome.runtime.lastError) {
      showError(
        "Could not reach the page script. " +
        "Try refreshing the Scholar profile and recalculating."
      );
    }
  });
}

/* ── Events ──────────────────────────────────────────────────────────── */

btnCalculate.addEventListener("click", startCalculation);
btnReset.addEventListener("click", showIdle);

showIdle();

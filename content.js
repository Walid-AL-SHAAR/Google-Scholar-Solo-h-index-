/**
 * Solo-h-index — content script
 *
 * Flow triggered by popup:
 *   1. Receive "startCalculation" message.
 *   2. Auto-click "Show more" in a loop until all papers are in the DOM,
 *      sending progress updates to the popup after each batch.
 *   3. Calculate the sole-author h-index on the full paper list.
 *   4. Send the final result back to the popup.
 *
 * Sole-author detection:
 *   Google Scholar always separates co-authors with commas.
 *   A paper whose first .gs_gray element has no comma, no "et al.",
 *   and no ellipsis is a sole-author paper.
 */

/* ── Guard: prevent double-registration if script is injected twice ── */
if (!window.__soloHIndexLoaded) {
  window.__soloHIndexLoaded = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "startCalculation") {
      runFullCalculation();
      sendResponse({ ack: true }); // immediate ack; result comes via sendMessage
    }
    return false;
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   MAIN ENTRY
═══════════════════════════════════════════════════════════════════════ */

async function runFullCalculation() {
  sendProgress(countRows(), false);

  try {
    await autoLoadAllPapers();
  } catch (err) {
    // If loading stalls, still calculate on what we have
    console.warn("[Solo-h-index] Auto-load interrupted:", err.message);
  }

  const result = buildResult();
  chrome.runtime.sendMessage({ action: "result", data: result });
}

/* ═══════════════════════════════════════════════════════════════════════
   AUTO-LOAD: keep clicking "Show more" until it disappears or is disabled
═══════════════════════════════════════════════════════════════════════ */

function autoLoadAllPapers() {
  return new Promise((resolve, reject) => {
    const MAX_TOTAL_MS  = 120_000; // 2 min hard limit
    const CLICK_DELAY   = 400;     // ms to wait after each click before checking
    const POLL_INTERVAL = 250;     // ms between row-count polls
    const STALL_LIMIT   = 8_000;   // ms with no new rows = give up on this click
    const startTime     = Date.now();

    function getBtn() {
      return document.querySelector("#gsc_bpf_more");
    }

    function btnActive() {
      const btn = getBtn();
      return btn && !btn.disabled && btn.offsetParent !== null;
    }

    function attemptNext() {
      if (Date.now() - startTime > MAX_TOTAL_MS) {
        resolve(); // timeout — compute on what we have
        return;
      }

      if (!btnActive()) {
        resolve(); // all papers loaded
        return;
      }

      const rowsBefore = countRows();
      getBtn().click();

      // Poll until rows increase or we stall
      const clickTime = Date.now();
      const poll = setInterval(() => {
        const rowsNow = countRows();

        if (rowsNow > rowsBefore) {
          clearInterval(poll);
          sendProgress(rowsNow, true);
          setTimeout(attemptNext, CLICK_DELAY);
          return;
        }

        if (Date.now() - clickTime > STALL_LIMIT) {
          clearInterval(poll);
          // Button may have disappeared or page stalled
          if (!btnActive()) {
            resolve();
          } else {
            // Try once more after a pause
            setTimeout(attemptNext, 1000);
          }
        }
      }, POLL_INTERVAL);
    }

    attemptNext();
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   CALCULATION
═══════════════════════════════════════════════════════════════════════ */

function isSoleAuthor(authorString) {
  if (!authorString || authorString.length === 0) return false;
  if (authorString.includes(",")) return false;
  if (authorString.includes("…") || authorString.includes("...")) return false;
  if (/et\s+al/i.test(authorString)) return false;
  return true;
}

function buildResult() {
  const rows = document.querySelectorAll(".gsc_a_tr");

  if (rows.length === 0) {
    return {
      error:
        "No paper rows found. Please open a Google Scholar profile page " +
        "(the /citations?user=... URL) and try again.",
    };
  }

  const soleAuthorPapers = [];
  let coAuthoredCount = 0;

  rows.forEach((row) => {
    const grayEls    = row.querySelectorAll(".gs_gray");
    if (grayEls.length === 0) return;

    const authorsText = grayEls[0].textContent.trim();
    const citationEl  = row.querySelector(".gsc_a_ac");
    const citations   = citationEl
      ? parseInt(citationEl.textContent.trim()) || 0
      : 0;

    if (isSoleAuthor(authorsText)) {
      const titleEl   = row.querySelector(".gsc_a_at");
      const yearEl    = row.querySelector(".gsc_a_y .gsc_a_h");
      const journalEl = grayEls.length > 1 ? grayEls[1] : null;

      soleAuthorPapers.push({
        title:    titleEl   ? titleEl.textContent.trim()   : "Unknown title",
        authors:  authorsText,
        journal:  journalEl ? journalEl.textContent.trim() : "",
        year:     yearEl    ? yearEl.textContent.trim()    : "",
        citations,
      });
    } else {
      coAuthoredCount++;
    }
  });

  // Sort descending for h-index calculation
  soleAuthorPapers.sort((a, b) => b.citations - a.citations);

  let hIndex = 0;
  for (let i = 0; i < soleAuthorPapers.length; i++) {
    if (soleAuthorPapers[i].citations >= i + 1) hIndex = i + 1;
    else break;
  }

  const totalCitations = soleAuthorPapers.reduce(
    (sum, p) => sum + p.citations, 0
  );

  const nameEl      = document.querySelector("#gsc_prf_in");
  const profileName = nameEl ? nameEl.textContent.trim() : null;

  return {
    hIndex,
    soleAuthorPapers,
    soleAuthorCount: soleAuthorPapers.length,
    coAuthoredCount,
    totalCitations,
    totalLoaded: rows.length,
    profileName,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════════════ */

function countRows() {
  return document.querySelectorAll(".gsc_a_tr").length;
}

function sendProgress(count, loading) {
  chrome.runtime.sendMessage({
    action:  "progress",
    count,
    loading,
  }).catch(() => {}); // popup may have closed — ignore
}

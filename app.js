import { auth, db, googleProvider, gmailProvider, signInWithPopup, reauthenticateWithPopup, onAuthStateChanged, signOut, GoogleAuthProvider } from "./firebase-init.js";
import { buildMimeMessage, toGmailRaw } from "./mime.mjs";
import { masterResumeToDocxShape, masterResumeIsAttachable } from "./master-resume.mjs";
import { gmailErrorMessage } from "./gmail-error.mjs";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* ---------- default profile (empty seed) ----------
 * Deliberately blank. This file is served publicly to anyone who loads the
 * app — no sign-in required — so it must never contain a real person's
 * contact details or work history. It previously shipped the author's name,
 * phone number, email, and full employment history, which meant (a) anyone
 * could read them straight out of the JS bundle, and (b) every new account
 * started life pre-filled with someone else's resume.
 *
 * A returning user never sees this: loadProfile() only writes the seed when
 * the account has no Firestore document yet. The shape is kept intact so the
 * profile form, quick-questions, and generation prompts have the keys they
 * expect.
 */
const DEFAULT_PROFILE = {
  identity: {
    name: "",
    location: "",
    phone: "",
    email: "",
    linkedin: ""
  },
  standingAnswers: {
    notice_period: "",
    current_ctc: "",
    expected_ctc: "",
    location: "",
    open_to_relocation: "yes"
  },
  resume: {
    experience_years: 0,
    domains: [],
    headline_options: [],
    experience: [],
    education: [],
    projects: [],
    skills: []
  }
};

/* ---------- provider metadata (client) ---------- */
const PROVIDER_META = {
  gemini: { label: "Google (Gemini)", keyUrl: "https://aistudio.google.com/apikey", note: "Free tier, no card needed. Best place to start." },
  openrouter: { label: "OpenRouter", keyUrl: "https://openrouter.ai/keys", note: "Free models, no card needed. Good backup when Gemini is busy." },
  anthropic: { label: "Anthropic (Claude)", keyUrl: "https://console.anthropic.com/settings/keys", note: "Paid API credits required — a Claude subscription does NOT cover this." },
  openai: { label: "OpenAI (ChatGPT)", keyUrl: "https://platform.openai.com/api-keys", note: "Paid API credits required — a ChatGPT Plus subscription does NOT cover this." }
};
// Keep in sync with api/_llm.js MODEL_REGISTRY.
const MODEL_REGISTRY = {
  anthropic: [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" }
  ],
  openai: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "gpt-4o", label: "GPT-4o" }
  ],
  // Free-tier fallback chain, least-contended first. Keep in sync with
  // api/_llm.js — the server walks this same order when a model is busy.
  gemini: [
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite (most reliable free)" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }
  ],
  openrouter: [
    { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B (free)" },
    { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (free)" },
    { id: "nvidia/nemotron-nano-12b-v2-vl:free", label: "Nemotron Nano 12B VL (free)" }
  ]
};

/* ---------- state ---------- */
let CURRENT_USER = null;
let PROFILE = null;
let PROVIDER_STATUS = { gemini: { configured: false }, openrouter: { configured: false }, anthropic: { configured: false }, openai: { configured: false } };
let SESSION = { imageB64: null, jd: null, generation: null, mismatchOverridden: false, provider: null, model: null, attachSource: "master" };

/* ---------- nav ---------- */
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById("screen-" + id).classList.add("active");
  document.querySelectorAll(".navlink").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(`.navlink[data-nav="${id}"]`).forEach(b => b.classList.add("active"));
  window.scrollTo(0, 0);
}
document.addEventListener("click", e => {
  const el = e.target.closest("[data-nav]");
  if (!el) return;
  const id = el.getAttribute("data-nav");
  if (id === "log") renderLog();
  if (id === "profile") fillProfileForm();
  showScreen(id);
});

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Set when the user chooses "Finish later" in the setup wizard, so the next
// sign-in doesn't drop them straight back into it. Declared here because the
// auth listener below reads it.
const OB_DISMISSED_KEY = "jobagent.onboardingDismissed.v1";

/* ---------- auth ---------- */
document.getElementById("btnGoogleSignIn").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (e) {
    toast("Sign-in failed — try again");
  }
});
document.getElementById("btnSignOut").addEventListener("click", async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    CURRENT_USER = null;
    // One place covers sign-out, session expiry and account deletion — a live
    // Gmail token must not survive the account it belongs to.
    clearGmailToken();
    document.body.classList.remove("authed");
    showScreen("login");
    return;
  }
  CURRENT_USER = user;
  document.body.classList.add("authed");
  document.getElementById("userAvatar").src = user.photoURL || "icons/icon-192.png";
  try {
    await Promise.all([loadProfile(), loadProviderStatus()]);
    populateHomeSelectors();
    // A profile with nothing in it can't produce an application, so sending a
    // new user to the capture screen only sets them up to fail at the fit
    // check. Take them through setup first — unless they've explicitly chosen
    // to finish later, in which case nagging them every sign-in is worse than
    // letting them find it from Profile.
    if (profileIsEmpty(PROFILE) && !localStorage.getItem(OB_DISMISSED_KEY)) {
      startOnboarding();
    } else {
      showScreen("home");
    }
    maybeOfferImport();
  } catch (e) {
    toast("Could not load your account data");
  }
});

async function getIdToken() {
  return CURRENT_USER.getIdToken();
}
async function apiPost(path, body) {
  const idToken = await getIdToken();
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, idToken }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((data.error || "request failed") + (data.detail ? ` (${data.detail})` : ""));
    err.code = data.code;
    throw err;
  }
  return data;
}

// A real per-minute rate limit (unlike a quota/billing failure) resolves itself —
// so for that one error code, wait it out with a visible countdown and retry once
// automatically instead of making the user guess when to tap retry again. Any other
// error (or a second failure) surfaces normally; this never loops more than once.
const RATE_LIMIT_COOLDOWN_SECONDS = 65;

// Gemini answers capacity pressure with 503 UNAVAILABLE — "This model is
// currently experiencing high demand... Please try again later." That is the
// provider explicitly telling us to retry, but the client used to give up
// immediately on provider_down and hand the user a dead end. Short escalating
// waits, because these spikes usually clear in seconds rather than minutes.
const PROVIDER_DOWN_BACKOFF_SECONDS = [5, 12, 25];

async function countdown(seconds, onWaiting, label) {
  for (let s = seconds; s > 0; s--) {
    onWaiting(`${label} ${s}s…`);
    await new Promise(res => setTimeout(res, 1000));
  }
  onWaiting("Retrying now…");
}

// Retries only the two failures that can actually succeed on a second attempt.
// quota_exceeded and invalid_key are deliberately excluded — retrying those
// just loops forever against a state only the user can change.
async function withAutoRetry(fn, onWaiting) {
  try {
    return await fn();
  } catch (err) {
    if (err.code === "rate_limited") {
      await countdown(RATE_LIMIT_COOLDOWN_SECONDS, onWaiting, "Rate-limited by the provider — retrying automatically in");
      return await fn();
    }

    if (err.code === "provider_down") {
      let last = err;
      for (let i = 0; i < PROVIDER_DOWN_BACKOFF_SECONDS.length; i++) {
        await countdown(
          PROVIDER_DOWN_BACKOFF_SECONDS[i],
          onWaiting,
          `The model is busy right now — retry ${i + 1} of ${PROVIDER_DOWN_BACKOFF_SECONDS.length} in`
        );
        try {
          return await fn();
        } catch (e) {
          last = e;
          // A different failure mid-retry is not a capacity problem; stop.
          if (e.code !== "provider_down") throw e;
        }
      }
      throw last;
    }

    throw err;
  }
}

/* ---------- profile (Firestore) ---------- */
async function loadProfile() {
  const ref = doc(db, "users", CURRENT_USER.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    // Normalise on read: documents written by earlier versions can be missing
    // arrays the editors index into.
    PROFILE = normalizeProfile(snap.data());
  } else {
    PROFILE = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
    await setDoc(ref, PROFILE);
  }
}
async function saveProfile() {
  await setDoc(doc(db, "users", CURRENT_USER.uid), PROFILE);
}

/* ---------- applications (Firestore) ---------- */
function appsCol() { return collection(db, "users", CURRENT_USER.uid, "applications"); }
async function dbAll() {
  const snap = await getDocs(appsCol());
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}
async function dbFindByCompanyRole(key) {
  const all = await dbAll();
  return all.find(r => r.companyRole === key);
}
async function dbGet(id) {
  const snap = await getDoc(doc(db, "users", CURRENT_USER.uid, "applications", id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
async function dbAdd(record) {
  await setDoc(doc(db, "users", CURRENT_USER.uid, "applications", record.id), record);
}
async function dbUpdate(id, patch) {
  await updateDoc(doc(db, "users", CURRENT_USER.uid, "applications", id), patch);
}
async function dbDelete(id) {
  await deleteDoc(doc(db, "users", CURRENT_USER.uid, "applications", id));
}

/* ---------- one-time best-effort import from the pre-login local version ---------- */
function openLegacyDB() {
  return new Promise(resolve => {
    const req = indexedDB.open("jobagent");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onupgradeneeded = () => {};
  });
}
async function readLegacyApplications() {
  const idb = await openLegacyDB();
  if (!idb || !idb.objectStoreNames.contains("applications")) return [];
  return new Promise(resolve => {
    try {
      const tx = idb.transaction("applications", "readonly");
      const req = tx.objectStore("applications").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
}
async function maybeOfferImport() {
  if (localStorage.getItem("jobagent.importDismissed.v1")) return;
  try {
    const legacy = await readLegacyApplications();
    if (!legacy.length) { localStorage.setItem("jobagent.importDismissed.v1", "1"); return; }
    const existing = await dbAll();
    if (existing.length) { localStorage.setItem("jobagent.importDismissed.v1", "1"); return; }
    const n = legacy.length;
    if (confirm(`Found ${n} previously-saved application${n > 1 ? "s" : ""} on this device. Import them into your account?`)) {
      for (const rec of legacy) {
        const id = rec.id || (Date.now() + "-" + Math.random().toString(36).slice(2, 8));
        await dbAdd({ ...rec, id });
      }
      toast(`Imported ${n} application${n > 1 ? "s" : ""}`);
    }
  } catch (e) {
    // best-effort only
  } finally {
    localStorage.setItem("jobagent.importDismissed.v1", "1");
  }
}

/* ---------- provider key management ---------- */
async function loadProviderStatus() {
  try {
    PROVIDER_STATUS = await apiPost("/api/save-provider-key", { action: "status" });
  } catch (e) {
    PROVIDER_STATUS = { gemini: { configured: false }, openrouter: { configured: false }, anthropic: { configured: false }, openai: { configured: false } };
  }
  renderProviderList();
}
function renderProviderList() {
  const box = document.getElementById("providerList");
  if (!box) return;
  box.innerHTML = "";
  Object.keys(PROVIDER_META).forEach(p => {
    const meta = PROVIDER_META[p];
    const status = PROVIDER_STATUS[p] || { configured: false };
    const row = document.createElement("div");
    row.className = "provider-row";
    if (status.configured) {
      row.innerHTML = `
        <div>
          <div class="provider-name">${meta.label} <span class="badge badge-configured">connected</span></div>
          <div class="provider-preview">${escapeHtml(status.preview || "")}</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-remove="${p}">Remove</button>`;
    } else {
      row.innerHTML = `
        <div style="flex:1;">
          <div class="provider-name">${meta.label} <span class="badge badge-missing">not connected</span></div>
          <div class="provider-preview">${escapeHtml(meta.note)} <a class="link" href="${meta.keyUrl}" target="_blank" rel="noopener">Get a key →</a></div>
          <div class="field" style="margin-top:8px;"><input type="password" placeholder="Paste ${meta.label} key" data-keyinput="${p}"></div>
          <button class="btn btn-outline btn-sm" data-save="${p}">Save key</button>
        </div>`;
    }
    box.appendChild(row);
  });
  box.querySelectorAll("[data-save]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const p = btn.getAttribute("data-save");
      const input = box.querySelector(`[data-keyinput="${p}"]`);
      const key = input.value.trim();
      if (!key) return;
      btn.disabled = true;
      btn.textContent = "Validating…";
      try {
        await apiPost("/api/save-provider-key", { action: "save", provider: p, apiKey: key, model: MODEL_REGISTRY[p][0].id });
        input.value = "";
        toast(`${PROVIDER_META[p].label} connected`);
        await loadProviderStatus();
        populateHomeSelectors();
      } catch (e) {
        toast(e.message || "Could not save key");
        btn.disabled = false;
        btn.textContent = "Save key";
      }
    });
  });
  box.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const p = btn.getAttribute("data-remove");
      if (!confirm(`Remove your ${PROVIDER_META[p].label} key?`)) return;
      try {
        await apiPost("/api/save-provider-key", { action: "remove", provider: p });
        toast("Removed");
        await loadProviderStatus();
        populateHomeSelectors();
      } catch (e) {
        toast("Could not remove key");
      }
    });
  });
}

/* ---------- provider/model picker on home ---------- */
function configuredProviders() {
  return Object.keys(PROVIDER_META).filter(p => PROVIDER_STATUS[p] && PROVIDER_STATUS[p].configured);
}
function populateHomeSelectors() {
  const configured = configuredProviders();
  const provSel = document.getElementById("providerSelect");
  const modelSel = document.getElementById("modelSelect");
  if (!configured.length) {
    provSel.innerHTML = "";
    modelSel.innerHTML = "";
    return;
  }
  provSel.innerHTML = configured.map(p => `<option value="${p}">${PROVIDER_META[p].label}</option>`).join("");
  const preferred = PROFILE?.preferredProvider && configured.includes(PROFILE.preferredProvider) ? PROFILE.preferredProvider : configured[0];
  provSel.value = preferred;
  populateModelSelector();
  provSel.onchange = () => { populateModelSelector(); persistPreference(); };
  modelSel.onchange = persistPreference;
}
function populateModelSelector() {
  const p = document.getElementById("providerSelect").value;
  const modelSel = document.getElementById("modelSelect");
  const models = MODEL_REGISTRY[p] || [];
  modelSel.innerHTML = models.map(m => `<option value="${m.id}">${m.label}</option>`).join("");
  const savedModel = (PROFILE?.preferredProvider === p && PROFILE?.preferredModel) ? PROFILE.preferredModel : (PROVIDER_STATUS[p] && PROVIDER_STATUS[p].model);
  if (savedModel && models.some(m => m.id === savedModel)) modelSel.value = savedModel;
}
let prefSaveTimer;
function persistPreference() {
  clearTimeout(prefSaveTimer);
  prefSaveTimer = setTimeout(async () => {
    PROFILE.preferredProvider = document.getElementById("providerSelect").value;
    PROFILE.preferredModel = document.getElementById("modelSelect").value;
    try { await saveProfile(); } catch (e) {}
  }, 400);
}
function currentSelection() {
  const configured = configuredProviders();
  if (!configured.length) return null;
  const provSel = document.getElementById("providerSelect");
  const modelSel = document.getElementById("modelSelect");
  return { provider: provSel.value || configured[0], model: modelSel.value || MODEL_REGISTRY[configured[0]][0].id };
}

/* ---------- capture ---------- */
const btnCamera = document.getElementById("btnCamera");
const btnUpload = document.getElementById("btnUpload");
const fileCamera = document.getElementById("fileCamera");
const fileUpload = document.getElementById("fileUpload");
btnCamera.addEventListener("click", () => { if (!configuredProviders().length) { showScreen("noprovider"); return; } fileCamera.click(); });
btnUpload.addEventListener("click", () => { if (!configuredProviders().length) { showScreen("noprovider"); return; } fileUpload.click(); });
fileCamera.addEventListener("change", e => handleFile(e.target.files[0]));
fileUpload.addEventListener("change", e => handleFile(e.target.files[0]));

function handleFile(file) {
  if (!file) return;
  const sel = currentSelection();
  if (!sel) { showScreen("noprovider"); return; }
  SESSION.provider = sel.provider;
  SESSION.model = sel.model;
  SESSION.duplicateInfo = null;
  SESSION.logId = null;

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const maxW = 1024;
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      SESSION.imageB64 = dataUrl.split(",")[1];
      startExtraction();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function setProcessing(text) {
  document.getElementById("processingStatus").textContent = text;
  showScreen("processing");
}

// An empty profile is a setup problem, not a hiring problem.
//
// Without this check the app happily ran extract + generate against the empty
// seed profile, spent two provider calls, and came back with "Doesn't look like
// a fit" — blaming the match when the real answer was "we know nothing about
// you". The verdict was technically accurate and completely useless: the user's
// next move is to upload a resume, not to find a different job.
function profileIsEmpty(p) {
  const r = (p && p.resume) || {};
  return !(r.experience || []).length
    && !(r.education || []).length
    && !(r.projects || []).length
    && !(r.skills || []).length;
}

async function startExtraction(roleHint) {
  if (profileIsEmpty(PROFILE)) {
    toast("Let's set up your profile first");
    startOnboarding();
    return;
  }
  setProcessing(roleHint ? "Reading that role…" : "Reading the post…");
  try {
    const jd = await withAutoRetry(
      () => apiPost("/api/job-extract", {
        image: SESSION.imageB64, mediaType: "image/jpeg", roleHint,
        provider: SESSION.provider, model: SESSION.model
      }),
      (msg) => { document.getElementById("processingStatus").textContent = msg; }
    );

    // The server silently walks to another model when the chosen one is busy.
    // Say so, otherwise a user sees different output quality with no explanation.
    if (jd._fellBackFrom) {
      const label = (MODEL_REGISTRY[SESSION.provider] || []).find(m => m.id === jd._model);
      toast(`${jd._fellBackFrom} was busy — used ${label ? label.label : jd._model} instead`);
    }

    if (jd.readable === false) {
      document.getElementById("unreadableReason").textContent = jd.unreadable_reason || "The image didn't look like a job posting, or was too cropped/blurry to extract.";
      showScreen("unreadable");
      return;
    }
    if (jd.multiple_roles && !roleHint) {
      const box = document.getElementById("roleChips");
      box.innerHTML = "";
      (jd.role_candidates || []).forEach(label => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = label;
        chip.addEventListener("click", () => startExtraction(label));
        box.appendChild(chip);
      });
      showScreen("multirole");
      return;
    }
    if (!jd.recruiter_email) {
      showScreen("noemail");
      return;
    }

    SESSION.jd = jd;
    // A new posting is a new application, so the attachment choice starts over.
    // usingTailored() already refuses to use a resume that isn't there, so this
    // changes no behaviour today — it removes the possibility that a later edit
    // to that guard silently attaches the previous job's tailored resume to this
    // one. Sending the wrong resume to a recruiter is not a failure worth
    // leaving one refactor away.
    SESSION.attachSource = "master";
    await afterExtraction();
  } catch (err) {
    toast(err.message || "Something went wrong reading that image.");
    showScreen("home");
  }
}

async function afterExtraction() {
  const jd = SESSION.jd;
  const key = `${(jd.company || "").trim().toLowerCase()}|${(jd.role_title || "").trim().toLowerCase()}`;
  jd._companyRoleKey = key;
  // Informational only — never blocks re-drafting or reapplying to the same posting.
  SESSION.duplicateInfo = await dbFindByCompanyRole(key);
  proceedPastDuplicate();
}

function proceedPastDuplicate() {
  const jd = SESSION.jd;
  if (jd.explicitly_requested_fields && jd.explicitly_requested_fields.length) {
    renderQuickQuestions(jd.explicitly_requested_fields);
    showScreen("quickq");
    return;
  }
  runGenerate();
}

function renderQuickQuestions(fields) {
  const box = document.getElementById("quickFields");
  box.innerHTML = "";
  const labelMap = { current_ctc: "Current CTC", expected_ctc: "Expected CTC", notice_period: "Notice period", availability: "Availability" };
  fields.forEach(f => {
    const div = document.createElement("div");
    div.className = "field";
    const label = labelMap[f] || f.replace(/_/g, " ");
    const existing = PROFILE.standingAnswers[f] || "";
    div.innerHTML = `<label>${escapeHtml(label)}</label><input data-qfield="${f}" value="${escapeHtml(existing)}">`;
    box.appendChild(div);
  });
}
document.getElementById("btnQuickContinue").addEventListener("click", async () => {
  document.querySelectorAll("[data-qfield]").forEach(input => {
    PROFILE.standingAnswers[input.getAttribute("data-qfield")] = input.value;
  });
  try { await saveProfile(); } catch (e) {}
  runGenerate();
});

async function runGenerate() {
  setProcessing("Checking fit…");
  const statuses = ["Checking fit…", "Tailoring the resume…", "Drafting the email…"];
  let i = 0;
  const rotate = setInterval(() => { i = (i + 1) % statuses.length; document.getElementById("processingStatus").textContent = statuses[i]; }, 1800);
  try {
    const gen = await withAutoRetry(
      () => apiPost("/api/job-generate", { jd: SESSION.jd, profile: PROFILE, provider: SESSION.provider, model: SESSION.model }),
      (msg) => { clearInterval(rotate); document.getElementById("processingStatus").textContent = msg; }
    );
    clearInterval(rotate);
    SESSION.generation = gen;
    SESSION.mismatchOverridden = false;

    if (gen.fit.verdict === "mismatch") {
      renderFitScreen(gen.fit);
      showScreen("fit");
    } else {
      renderReview();
      await logCurrentApplication("drafted");
      showScreen("review");
    }
  } catch (err) {
    clearInterval(rotate);
    toast(err.message || "Something went wrong generating the application.");
    showScreen("home");
  }
}

function renderFitScreen(fit) {
  const banner = document.getElementById("fitBanner");
  banner.innerHTML = `
    <div class="verdict-banner verdict-mismatch">
      <div class="title">Doesn't look like a fit</div>
      <div>${escapeHtml(fit.reason || "")}</div>
      ${fit.gap_note ? `<div style="margin-top:6px; font-size:13px; color:var(--muted);">${escapeHtml(fit.gap_note)}</div>` : ""}
    </div>`;
}
document.getElementById("btnDiscardMismatch").addEventListener("click", async () => {
  await logCurrentApplication("skipped");
  SESSION = { imageB64: null, jd: null, generation: null, mismatchOverridden: false, provider: SESSION.provider, model: SESSION.model, attachSource: "master" };
  showScreen("home");
});
document.getElementById("btnApplyAnyway").addEventListener("click", async () => {
  SESSION.mismatchOverridden = true;
  renderReview();
  await logCurrentApplication("drafted");
  showScreen("review");
});

/* ---------- review screen ---------- */
function renderReview() {
  const jd = SESSION.jd, gen = SESSION.generation;

  const dupBanner = document.getElementById("reviewDuplicateBanner");
  if (SESSION.duplicateInfo) {
    const dup = SESSION.duplicateInfo;
    dupBanner.style.display = "block";
    dupBanner.textContent = `You applied here before — ${dup.date} · status: ${dup.status}. This is being logged as a separate attempt, not a replacement.`;
  } else {
    dupBanner.style.display = "none";
  }

  const banner = document.getElementById("reviewVerdictBanner");
  const v = gen.fit.verdict;
  const cls = v === "strong" ? "verdict-strong" : v === "partial" ? "verdict-partial" : "verdict-mismatch";
  const title = v === "strong" ? "Strong fit" : v === "partial" ? "Partial fit" : "Mismatch — applying anyway";
  banner.innerHTML = `
    <div class="verdict-banner ${cls}">
      <div class="title">${title}</div>
      <div>${escapeHtml(gen.fit.reason || "")}</div>
      ${gen.fit.gap_note ? `<div style="margin-top:6px; font-size:13px;">Gap: ${escapeHtml(gen.fit.gap_note)}</div>` : ""}
    </div>`;

  document.getElementById("emailTo").value = jd.recruiter_email || "";
  document.getElementById("emailSubject").value = gen.email.subject || "";
  document.getElementById("emailBody").value = gen.email.body || "";

  renderResumeCard();
}

// ---------------------------------------------------------------------------
// Which resume gets attached
//
// The master resume is the default because it is the one the user actually
// wrote. Tailoring is a deliberate extra step: it costs a provider call, and a
// model rewriting someone's work history is a thing they should opt into per
// application rather than have happen to every application silently.
// ---------------------------------------------------------------------------

// Both shapes render identically here — masterResumeToDocxShape exists so the
// master resume arrives in the same shape the generated one already has.
function resumePreviewHtml(r) {
  r = r || {};
  let html = "";
  if (r.title_line) html += `<div style="font-weight:700; margin-bottom:6px;">${escapeHtml(r.title_line)}</div>`;
  if (r.summary) html += `<div style="margin-bottom:10px;">${escapeHtml(r.summary)}</div>`;
  if (r.skills && r.skills.length) html += `<div style="margin-bottom:6px;"><strong>Skills:</strong> ${escapeHtml(r.skills.slice(0, 10).join(", "))}${r.skills.length > 10 ? "…" : ""}</div>`;
  if (r.bullet_sections && r.bullet_sections.length) {
    r.bullet_sections.forEach(s => {
      html += `<div style="margin-top:8px; font-weight:600;">${escapeHtml(s.header)}</div><ul class="changed">`;
      (s.bullets || []).forEach(b => html += `<li>${escapeHtml(b)}</li>`);
      html += `</ul>`;
    });
  }
  // Work history and education are the bulk of the .docx, so they belong in
  // the preview too. Leaving them out is how a resume that was missing every
  // job still looked fine on this screen, right up until the file was opened.
  if (r.experience && r.experience.length) {
    html += `<div style="margin-top:12px; font-weight:600;">Experience</div>`;
    r.experience.forEach(job => {
      const titleLine = [job.title, job.company].filter(Boolean).join(" — ");
      const metaLine = [job.location, job.dates].filter(Boolean).join(" · ");
      html += `<div style="margin-top:8px; font-weight:600;">${escapeHtml(titleLine)}</div>`;
      if (metaLine) html += `<div class="sub" style="margin-bottom:4px;">${escapeHtml(metaLine)}</div>`;
      if ((job.bullets || []).length) {
        html += `<ul class="changed">` + job.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join("") + `</ul>`;
      }
    });
  }
  if (r.education && r.education.length) {
    html += `<div style="margin-top:12px; font-weight:600;">Education</div>`;
    r.education.forEach(e => {
      html += `<div>${escapeHtml([e.degree, e.school, e.dates].filter(Boolean).join(" — "))}</div>`;
    });
  }
  return html;
}

function tailoredResume() {
  return SESSION.generation && SESSION.generation.resume ? SESSION.generation.resume : null;
}

function usingTailored() {
  return SESSION.attachSource === "tailored" && Boolean(tailoredResume());
}

/** The resume object that will actually be built into the .docx. */
function activeResume() {
  return usingTailored() ? tailoredResume() : masterResumeToDocxShape(PROFILE.resume);
}

function renderResumeCard() {
  const tailored = tailoredResume();
  const onTailored = usingTailored();
  const r = activeResume();

  document.getElementById("resumeCardTitle").textContent = onTailored ? "Tailored resume" : "Your resume";
  document.getElementById("resumeAttachNote").textContent = onTailored
    ? "The AI-tailored version will be attached to the email."
    : "Your own resume will be attached, exactly as you wrote it — nothing rewritten.";

  const html = resumePreviewHtml(r);
  document.getElementById("resumePreview").innerHTML = html ||
    "<span class='sub'>Your profile has no resume content yet — add or upload one in Profile.</span>";

  // Offer tailoring once per application; after that the toggle takes over.
  const btnTailor = document.getElementById("btnTailorResume");
  btnTailor.style.display = tailored ? "none" : "";
  btnTailor.disabled = !masterResumeIsAttachable(PROFILE.resume);

  const row = document.getElementById("attachToggleRow");
  const toggle = document.getElementById("btnAttachToggle");
  row.style.display = tailored ? "" : "none";
  toggle.textContent = onTailored ? "Attach my own resume instead" : "Attach AI resume instead";

  const wc = document.getElementById("whatChangedList");
  wc.innerHTML = "";
  const changed = (onTailored && tailored.what_changed) || [];
  changed.forEach(c => {
    const li = document.createElement("li");
    li.textContent = c;
    wc.appendChild(li);
  });
  document.getElementById("whatChangedCard").style.display = changed.length ? "block" : "none";
}


// ---------------------------------------------------------------------------
// Gmail drafts
//
// The mailto: route hands the body to whatever mail client the OS has, which
// cannot carry an attachment — hence the old "attach it yourself" toast. Writing
// a real Gmail draft is the only way to hand someone a finished application:
// recipient, subject, body AND the tailored .docx, ready to review and send.
//
// Nothing is ever sent. gmail.compose can only create drafts.
// ---------------------------------------------------------------------------

// Firebase does not persist or refresh the Google OAuth access token — it exists
// only in the credential returned by a popup, and Google expires it in about an
// hour. So it is held in memory for its lifetime and never written to storage:
// a Gmail token in localStorage would outlive the tab and is exactly the kind of
// credential worth stealing. Worst case the user sees one extra popup.
let GMAIL_TOKEN = null;
let GMAIL_TOKEN_EXPIRES_AT = 0;

function clearGmailToken() {
  GMAIL_TOKEN = null;
  GMAIL_TOKEN_EXPIRES_AT = 0;
}

async function getGmailAccessToken() {
  if (GMAIL_TOKEN && Date.now() < GMAIL_TOKEN_EXPIRES_AT) return GMAIL_TOKEN;
  const user = auth.currentUser;
  if (!user) throw new Error("signed_out");

  // reauthenticateWithPopup rather than signInWithPopup: it pins the popup to the
  // account already signed in, so someone with three Google accounts can't
  // silently authorise the wrong mailbox and wonder where the draft went.
  // prompt=consent is not optional here, and leaving it out is why this used to
  // fail with a scope error nobody was ever asked to prevent. This account has
  // already approved the app for sign-in, so Google skips the consent screen on
  // a later request and hands back a token carrying only those original scopes —
  // gmail.compose silently never granted, popup flashing past, and a 403 at the
  // draft call. Forcing consent is the documented way to add a scope to an
  // account that already trusts the app.
  const params = { prompt: "consent" };
  if (user.email) params.login_hint = user.email;
  gmailProvider.setCustomParameters(params);
  const res = await reauthenticateWithPopup(user, gmailProvider);
  const token = GoogleAuthProvider.credentialFromResult(res)?.accessToken;
  if (!token) throw new Error("no_token");

  GMAIL_TOKEN = token;
  // Google issues these for ~3600s. Expire ours early so a call that starts just
  // before the boundary doesn't fail mid-flight.
  GMAIL_TOKEN_EXPIRES_AT = Date.now() + 50 * 60 * 1000;
  return token;
}

async function createGmailDraft({ to, subject, body, attachment }) {
  const token = await getGmailAccessToken();
  const raw = toGmailRaw(buildMimeMessage({ to, subject, body, attachment }));
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message: { raw } })
  });
  if (!r.ok) {
    // A 401 means the token died early; drop it so the next attempt re-prompts
    // rather than replaying a token Google has already rejected.
    if (r.status === 401) clearGmailToken();
    const detail = await r.text().catch(() => "");
    const err = new Error(`gmail_api_${r.status}`);
    err.status = r.status;
    err.detail = detail;
    throw err;
  }
  return r.json();
}

function resumeFileName() {
  const name = String(PROFILE?.identity?.name || "").trim();
  const year = new Date().getFullYear();
  const base = name ? `${name}_Resume_${year}` : `Resume_${year}`;
  // Strip the characters Windows and macOS refuse in a filename, so the save
  // doesn't silently fail on a name with a slash or colon in it.
  return base.replace(/[<>:"/\\|?*\r\n]/g, "").trim() + ".docx";
}

// Shared by the download button and the Gmail draft so the attachment is byte
// for byte the file the user would have downloaded.
async function buildResumeDocx() {
  const idToken = await getIdToken();
  const r = await fetch("/api/job-resume-docx", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idToken, resume: activeResume(), contact: PROFILE.identity,
      fileName: resumeFileName(),
      // Lets the server give advice that matches which resume came up empty.
      source: usingTailored() ? "tailored" : "master"
    })
  });
  if (!r.ok) {
    // The endpoint refuses to build an empty document and says why. That
    // reason is worth far more to the user than "couldn't build the file".
    const info = await r.json().catch(() => null);
    const err = new Error(info?.error || "resume_build_failed");
    err.code = info?.code;
    err.userFacing = Boolean(info?.error);
    throw err;
  }
  return { blob: await r.blob(), filename: resumeFileName() };
}

document.getElementById("btnGmailDraft").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const to = document.getElementById("emailTo").value;
  const subject = document.getElementById("emailSubject").value;
  const body = document.getElementById("emailBody").value;

  if (!to) { toast("No recipient address on this application"); return; }

  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Saving to Gmail…";
  try {
    // The resume is best-effort: a draft with the right words in it still beats
    // no draft, so a failed .docx build downgrades to a body-only draft rather
    // than losing the whole thing.
    let attachment = null;
    try {
      const { blob, filename } = await buildResumeDocx();
      attachment = {
        filename,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: new Uint8Array(await blob.arrayBuffer())
      };
    } catch (_) {
      attachment = null;
    }

    await createGmailDraft({ to, subject, body, attachment });
    toast(attachment ? "Draft saved to Gmail with your resume attached" : "Draft saved to Gmail — resume didn't attach, add it manually");
  } catch (err) {
    if (err?.code === "auth/popup-closed-by-user" || err?.code === "auth/cancelled-popup-request") {
      toast("Gmail access cancelled");
    } else if (err?.code === "auth/user-mismatch") {
      toast("That's a different Google account — pick the one you signed in with");
    } else if (err?.message === "signed_out") {
      toast("Sign in again to save drafts");
    } else {
      // Google says which failure this is in the response body. That string used
      // to be captured and dropped on the floor, so every one of these became
      // "allow it when Google asks" — advice that is wrong whenever the popup
      // already worked. Log it and let gmailErrorMessage pick the real message.
      console.error("Gmail draft failed:", err?.status, err?.detail || err);
      toast(gmailErrorMessage(err));
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

document.getElementById("btnCopyEmail").addEventListener("click", () => {
  navigator.clipboard.writeText(document.getElementById("emailBody").value).then(() => toast("Copied"));
});
document.getElementById("btnMailto").addEventListener("click", () => {
  const to = document.getElementById("emailTo").value;
  const subject = document.getElementById("emailSubject").value;
  const body = document.getElementById("emailBody").value;
  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  toast("Resume downloads separately — attach it in your mail app");
  window.location.href = mailto;
});
document.getElementById("btnDownloadResume").addEventListener("click", async () => {
  try {
    const { blob, filename } = await buildResumeDocx();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast(e.userFacing ? e.message : "Couldn't build the resume file");
  }
});

// Tailoring is a second provider call, made only when asked for. It does not
// touch the email or the fit verdict already on screen — those were settled by
// the capture call and a user who wanted a resume didn't ask to have them redone.
document.getElementById("btnTailorResume").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (!masterResumeIsAttachable(PROFILE.resume)) {
    toast("Add your resume in Profile first — there's nothing to tailor from");
    return;
  }
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Tailoring…";
  try {
    const out = await apiPost("/api/job-generate", {
      jd: SESSION.jd, profile: PROFILE,
      provider: SESSION.provider, model: SESSION.model,
      want: "resume"
    });
    SESSION.generation = { ...(SESSION.generation || {}), resume: out.resume };
    // Generating it is a clear signal of intent, so it becomes the attachment —
    // the toggle is there for changing that mind, not for confirming it twice.
    SESSION.attachSource = "tailored";
    renderResumeCard();
    toast("Tailored resume ready — it will be attached");
  } catch (err) {
    toast(err?.message || "Couldn't tailor the resume");
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

document.getElementById("btnAttachToggle").addEventListener("click", () => {
  SESSION.attachSource = usingTailored() ? "master" : "tailored";
  renderResumeCard();
  toast(usingTailored() ? "Attaching the AI resume" : "Attaching your own resume");
});

document.getElementById("btnMarkSent").addEventListener("click", async () => {
  if (SESSION.logId) {
    try { await dbUpdate(SESSION.logId, { status: "sent" }); } catch (e) {}
  }
  toast("Marked as sent");
  showScreen("home");
});

async function logCurrentApplication(status) {
  const jd = SESSION.jd, gen = SESSION.generation;
  const id = SESSION.logId || (Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  SESSION.logId = id;
  const record = {
    id,
    company: jd.company || "",
    role: jd.role_title || "",
    companyRole: jd._companyRoleKey,
    recruiterEmail: jd.recruiter_email || "",
    date: new Date().toISOString().slice(0, 10),
    dateApplied: new Date().toISOString().slice(0, 10),
    fitVerdict: gen.fit.verdict + (SESSION.mismatchOverridden ? " (overridden)" : ""),
    status,
    email: gen.email,
    resume: activeResume(),
    resumeSource: usingTailored() ? "tailored" : "master",
    provider: SESSION.provider,
    model: SESSION.model,
    followUps: []
  };
  await dbAdd(record);
}

/* ---------- log ---------- */
async function renderLog() {
  const list = document.getElementById("logList");
  list.innerHTML = "<div class='empty'>Loading…</div>";
  const items = await dbAll();
  if (!items.length) { list.innerHTML = "<div class='empty'>Nothing logged yet.</div>"; return; }
  list.innerHTML = "";
  items.forEach(item => {
    const div = document.createElement("div");
    div.className = "log-item";
    const badgeClass = item.fitVerdict.startsWith("strong") ? "badge-strong" : item.fitVerdict.startsWith("partial") ? "badge-partial" : "badge-mismatch";
    div.innerHTML = `
      <div><div class="lname">${escapeHtml(item.company)}</div><div class="lrole">${escapeHtml(item.role)}</div></div>
      <div class="lmeta"><span class="badge ${badgeClass}">${escapeHtml(item.fitVerdict)}</span><br><span class="badge badge-status" style="margin-top:4px;">${escapeHtml(item.status)}</span><br>${escapeHtml(item.date)}</div>`;
    div.addEventListener("click", () => openLogDetail(item.id));
    list.appendChild(div);
  });
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
}
function formatDaysAgo(n) {
  if (n === null || n === undefined) return "unknown";
  if (n === 0) return "today";
  return n === 1 ? "1 day ago" : `${n} days ago`;
}

async function openLogDetail(id) {
  const item = await dbGet(id);
  if (!item) return;
  document.getElementById("logDetailTitle").textContent = `${item.company} — ${item.role}`;
  const body = document.getElementById("logDetailBody");
  const followUps = item.followUps || [];
  body.innerHTML = `
    <div class="card">
      <div><strong>Status:</strong> ${escapeHtml(item.status)}</div>
      <div><strong>Fit:</strong> ${escapeHtml(item.fitVerdict)}</div>
      <div><strong>Recruiter:</strong> ${escapeHtml(item.recruiterEmail)}</div>
      <div><strong>Applied:</strong> ${escapeHtml(item.date)} (${formatDaysAgo(daysSince(item.dateApplied || item.date))})</div>
    </div>
    <div class="card">
      <h2 style="margin-top:0;">Email</h2>
      <div style="font-weight:600; margin-bottom:6px;">${escapeHtml(item.email?.subject || "")}</div>
      <div style="white-space:pre-wrap; font-size:14px;">${escapeHtml(item.email?.body || "")}</div>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline" id="btnLogMarkSent">Mark as sent</button>
      <button class="btn btn-ghost" id="btnLogDelete">Delete</button>
    </div>
    <div class="hr"></div>
    <button class="btn btn-primary" id="btnDraftFollowup"><svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="14" height="10" rx="1.3"/><path d="m3.6 5.8 6.4 5 6.4-5"/></svg> Draft follow-up email</button>
    <div id="followupList">
      ${followUps.map((f, idx) => `
        <div class="followup-item">
          <div style="font-size:12px; color:var(--muted); margin-bottom:4px;">Follow-up · ${f.date} · <span class="badge badge-status">${escapeHtml(f.status)}</span></div>
          <div style="font-weight:600; margin-bottom:4px;">${escapeHtml(f.subject)}</div>
          <div style="white-space:pre-wrap; font-size:14px; margin-bottom:8px;">${escapeHtml(f.body)}</div>
          <div class="btn-row">
            <button class="btn btn-outline btn-sm" data-fu-copy="${idx}">Copy</button>
            <button class="btn btn-primary btn-sm" data-fu-mailto="${idx}">Open in Mail App</button>
            ${f.status !== "sent" ? `<button class="btn btn-ghost btn-sm" data-fu-sent="${idx}">Mark sent</button>` : ""}
          </div>
        </div>`).join("")}
    </div>`;

  document.getElementById("btnLogMarkSent").addEventListener("click", async () => {
    await dbUpdate(id, { status: "sent" }); toast("Marked as sent"); openLogDetail(id);
  });
  document.getElementById("btnLogDelete").addEventListener("click", async () => {
    if (!confirm("Delete this application?")) return;
    await dbDelete(id);
    toast("Deleted"); showScreen("log"); renderLog();
  });
  document.getElementById("btnDraftFollowup").addEventListener("click", () => draftFollowup(id));
  body.querySelectorAll("[data-fu-copy]").forEach(btn => {
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(followUps[+btn.getAttribute("data-fu-copy")].body).then(() => toast("Copied"));
    });
  });
  body.querySelectorAll("[data-fu-mailto]").forEach(btn => {
    btn.addEventListener("click", () => {
      const f = followUps[+btn.getAttribute("data-fu-mailto")];
      window.location.href = `mailto:${encodeURIComponent(item.recruiterEmail)}?subject=${encodeURIComponent(f.subject)}&body=${encodeURIComponent(f.body)}`;
    });
  });
  body.querySelectorAll("[data-fu-sent]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = +btn.getAttribute("data-fu-sent");
      const updated = followUps.map((f, i) => i === idx ? { ...f, status: "sent" } : f);
      await dbUpdate(id, { followUps: updated });
      openLogDetail(id);
    });
  });

  showScreen("logdetail");
}

async function draftFollowup(appId) {
  const item = await dbGet(appId);
  const sel = currentSelection();
  if (!sel) { toast("Add an AI provider key first"); showScreen("profile"); return; }
  toast("Drafting follow-up…");
  try {
    const result = await withAutoRetry(
      () => apiPost("/api/job-followup", {
        application: item, profile: PROFILE, daysSinceApplied: daysSince(item.dateApplied || item.date),
        provider: sel.provider, model: sel.model
      }),
      (msg) => toast(msg)
    );
    const followUp = { id: Date.now() + "-" + Math.random().toString(36).slice(2, 6), date: new Date().toISOString().slice(0, 10), subject: result.subject, body: result.body, status: "drafted" };
    const followUps = [...(item.followUps || []), followUp];
    await dbUpdate(appId, { followUps });
    toast("Follow-up drafted");
    openLogDetail(appId);
  } catch (e) {
    toast(e.message || "Could not draft follow-up");
  }
}

/* ---------- profile screen ---------- */
/* ---------- structured resume editors ----------
   Before this existed, work history was editable only as raw JSON in a collapsed
   <details> block, so the only realistic way to fill a profile was to upload a
   resume file. Anyone without one was stuck — and an empty profile makes every
   fit check come back "not a fit", which reads like a rejection rather than the
   setup problem it actually is.

   The same three editors are mounted twice: once in the first-run wizard and
   once on the Profile screen. One implementation, so the two can never drift. */

// Firestore documents written by older versions predate some of these arrays,
// and a missing array crashes the editors on the first .length. Normalise on the
// way in rather than defending at every use site.
function normalizeProfile(p) {
  const base = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
  const out = { ...base, ...(p || {}) };
  out.identity = { ...base.identity, ...(p && p.identity) };
  out.standingAnswers = { ...base.standingAnswers, ...(p && p.standingAnswers) };
  out.resume = { ...base.resume, ...(p && p.resume) };
  for (const k of ["domains", "headline_options", "experience", "education", "projects", "skills"]) {
    if (!Array.isArray(out.resume[k])) out.resume[k] = [];
  }
  return out;
}

// The Save button on the Profile screen still reads the raw JSON box as the
// source of truth, so every structured edit has to be mirrored back into it or
// saving would silently revert whatever was just typed.
function syncResumeJson() {
  const box = document.getElementById("pResumeJson");
  if (box) box.value = JSON.stringify(PROFILE.resume, null, 2);
}

function onResumeEdited() {
  syncResumeJson();
  refreshMountedEditors();
}

// Both screens can hold a live copy of an editor; re-render whichever are on the
// page so the wizard and Profile never show different data.
function refreshMountedEditors() {
  ["obExperienceMount", "pExperienceMount"].forEach(renderExperienceEditor);
  ["obSkillsMount", "pSkillsMount"].forEach(renderSkillsEditor);
  ["obEducationMount", "pEducationMount"].forEach(renderEducationEditor);
}

function renderExperienceEditor(mountId) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  const list = PROFILE.resume.experience;
  // Inside the wizard the surrounding step card already supplies the heading
  // and the explanation; only the Profile screen needs the editor to label
  // itself, because there the card is titled "Master resume".
  const inWizard = mountId.startsWith("ob");
  mount.className = "list-editor";
  mount.innerHTML =
    (inWizard ? "" : `<h3>Work experience</h3>`) +
    (inWizard ? "" : `<p class="sub" style="margin:0 0 10px;">Your own wording is reused as-is. Nothing here gets rewritten into something you didn't do.</p>`) +
    (list.length ? "" : `<div class="empty-hint">No roles added yet.</div>`) +
    list.map((role, i) => `
      <div class="entry-card" data-i="${i}">
        <div class="entry-head">
          <span class="entry-num">Role ${i + 1}</span>
          <button type="button" class="entry-remove" data-remove>Remove</button>
        </div>
        <div class="entry-grid">
          <div class="field"><label>Job title</label><input data-f="title" value="${escapeHtml(role.title)}" placeholder="Business Analyst"></div>
          <div class="field"><label>Company</label><input data-f="company" value="${escapeHtml(role.company)}" placeholder="Axis Max Life"></div>
          <div class="field"><label>Dates</label><input data-f="dates" value="${escapeHtml(role.dates)}" placeholder="Mar 2022 – present"></div>
          <div class="field"><label>Location</label><input data-f="location" value="${escapeHtml(role.location)}"></div>
        </div>
        <div class="field" style="margin-bottom:6px;"><label>What you did</label></div>
        ${(role.achievements || []).map((b, bi) => `
          <div class="bullet-row">
            <textarea data-b="${bi}" placeholder="Cut policy issuance turnaround from 6 days to 2">${escapeHtml(b)}</textarea>
            <button type="button" class="entry-remove" data-remove-bullet="${bi}">×</button>
          </div>`).join("")}
        <button type="button" class="btn btn-ghost btn-sm" data-add-bullet>+ Add a point</button>
      </div>`).join("") +
    `<button type="button" class="btn btn-outline btn-sm" data-add-role>+ Add a role</button>`;

  mount.querySelectorAll("[data-add-role]").forEach(b => b.addEventListener("click", () => {
    list.push({ title: "", company: "", location: "", dates: "", achievements: [""] });
    onResumeEdited();
  }));

  mount.querySelectorAll(".entry-card").forEach(card => {
    const i = +card.getAttribute("data-i");
    card.querySelector("[data-remove]").addEventListener("click", () => {
      list.splice(i, 1);
      onResumeEdited();
    });
    card.querySelectorAll("[data-f]").forEach(input => {
      input.addEventListener("input", () => {
        list[i][input.getAttribute("data-f")] = input.value;
        syncResumeJson();
      });
    });
    card.querySelectorAll("[data-b]").forEach(ta => {
      ta.addEventListener("input", () => {
        list[i].achievements[+ta.getAttribute("data-b")] = ta.value;
        syncResumeJson();
      });
    });
    card.querySelectorAll("[data-remove-bullet]").forEach(btn => {
      btn.addEventListener("click", () => {
        list[i].achievements.splice(+btn.getAttribute("data-remove-bullet"), 1);
        onResumeEdited();
      });
    });
    card.querySelector("[data-add-bullet]").addEventListener("click", () => {
      (list[i].achievements = list[i].achievements || []).push("");
      onResumeEdited();
    });
  });
}

function renderEducationEditor(mountId) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  const list = PROFILE.resume.education;
  mount.className = "list-editor";
  mount.innerHTML =
    `<h3>Education</h3>` +
    (list.length ? "" : `<div class="empty-hint">Nothing added yet.</div>`) +
    list.map((ed, i) => `
      <div class="entry-card" data-i="${i}">
        <div class="entry-head">
          <span class="entry-num">Entry ${i + 1}</span>
          <button type="button" class="entry-remove" data-remove>Remove</button>
        </div>
        <div class="entry-grid">
          <div class="field"><label>Degree</label><input data-f="degree" value="${escapeHtml(ed.degree)}" placeholder="B.Tech, Computer Science"></div>
          <div class="field"><label>Institution</label><input data-f="school" value="${escapeHtml(ed.school)}"></div>
        </div>
        <div class="field"><label>Dates</label><input data-f="dates" value="${escapeHtml(ed.dates)}" placeholder="2014 – 2018"></div>
      </div>`).join("") +
    `<button type="button" class="btn btn-outline btn-sm" data-add>+ Add education</button>`;

  mount.querySelector("[data-add]").addEventListener("click", () => {
    list.push({ degree: "", school: "", dates: "" });
    onResumeEdited();
  });
  mount.querySelectorAll(".entry-card").forEach(card => {
    const i = +card.getAttribute("data-i");
    card.querySelector("[data-remove]").addEventListener("click", () => { list.splice(i, 1); onResumeEdited(); });
    card.querySelectorAll("[data-f]").forEach(input => {
      input.addEventListener("input", () => { list[i][input.getAttribute("data-f")] = input.value; syncResumeJson(); });
    });
  });
}

function renderSkillsEditor(mountId) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  const list = PROFILE.resume.skills;
  mount.className = "list-editor";
  mount.innerHTML =
    `<h3>Skills</h3>` +
    (mountId.startsWith("ob") ? "" : `<p class="sub" style="margin:0 0 10px;">Matched against the job's requirements, so list what you'd defend in an interview.</p>`) +
    `<div class="chip-input-row">
       <input data-skill-input placeholder="e.g. Requirement gathering — press Enter">
       <button type="button" class="btn btn-outline btn-sm" data-skill-add>Add</button>
     </div>` +
    (list.length
      ? `<div class="chip-list">${list.map((s, i) => `<span class="chip-tag">${escapeHtml(s)}<button type="button" data-rm="${i}" aria-label="Remove ${escapeHtml(s)}">×</button></span>`).join("")}</div>`
      : `<div class="empty-hint">No skills added yet.</div>`);

  const input = mount.querySelector("[data-skill-input]");
  const add = () => {
    // Accept a pasted comma-separated list too — retyping 20 skills one at a
    // time is exactly the kind of friction that makes people abandon setup.
    const parts = input.value.split(",").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    parts.forEach(p => { if (!list.some(s => s.toLowerCase() === p.toLowerCase())) list.push(p); });
    input.value = "";
    onResumeEdited();
    const again = document.getElementById(mountId)?.querySelector("[data-skill-input]");
    if (again) again.focus();
  };
  mount.querySelector("[data-skill-add]").addEventListener("click", add);
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  mount.querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", () => {
    list.splice(+b.getAttribute("data-rm"), 1);
    onResumeEdited();
  }));
}

/* ---------- first-run setup wizard ---------- */

const OB_TOTAL = 5;
let OB_STEP = 1;

// Step 1 offers to read a resume file, but that parse runs through the user's
// own AI provider — and a brand-new account has no key yet. Left unguarded the
// first button a new user sees fails with "Add an AI provider key first" and
// points nowhere. Show the real prerequisite instead, and keep typing it in
// available as the path that works without a key.
function obSyncUploadAvailability() {
  const hasKey = configuredProviders().length > 0;
  const btn = document.getElementById("btnObUpload");
  const note = document.getElementById("obUploadBlocked");
  btn.disabled = !hasKey;
  note.style.display = hasKey ? "none" : "block";
}

function obShowStep(n) {
  OB_STEP = Math.min(Math.max(n, 1), OB_TOTAL);
  document.querySelectorAll(".ob-step").forEach(s => {
    s.classList.toggle("active", +s.getAttribute("data-ob-step") === OB_STEP);
  });
  document.getElementById("obProgress").innerHTML =
    Array.from({ length: OB_TOTAL }, (_, i) => `<span class="${i < OB_STEP ? "done" : ""}"></span>`).join("");
  document.getElementById("obError").textContent = "";
  document.getElementById("btnObBack").style.visibility = OB_STEP === 1 ? "hidden" : "visible";
  document.getElementById("btnObNext").textContent = OB_STEP === OB_TOTAL ? "Finish setup" : "Continue";
  if (OB_STEP === 1) obSyncUploadAvailability();
  if (OB_STEP === 3) renderExperienceEditor("obExperienceMount");
  if (OB_STEP === 4) { renderSkillsEditor("obSkillsMount"); renderEducationEditor("obEducationMount"); }
  window.scrollTo(0, 0);
}

function obCollectIdentity() {
  PROFILE.identity.name = document.getElementById("obName").value.trim();
  PROFILE.identity.email = document.getElementById("obEmail").value.trim();
  PROFILE.identity.phone = document.getElementById("obPhone").value.trim();
  PROFILE.identity.location = document.getElementById("obLocation").value.trim();
  PROFILE.identity.linkedin = document.getElementById("obLinkedin").value.trim();
}

function obCollectStanding() {
  PROFILE.standingAnswers.notice_period = document.getElementById("obNotice").value.trim();
  PROFILE.standingAnswers.current_ctc = document.getElementById("obCurrentCtc").value.trim();
  PROFILE.standingAnswers.expected_ctc = document.getElementById("obExpectedCtc").value.trim();
  PROFILE.standingAnswers.location = PROFILE.identity.location || "";
  PROFILE.standingAnswers.open_to_relocation =
    document.getElementById("obReloYes").classList.contains("on") ? "yes" : "no";
}

// Only two things are actually enforced, and both are enforced because the app
// genuinely cannot work without them: a name (it goes on the resume) and some
// substance to match against (a role or a skill). Everything else is optional —
// a setup wall is worse than a thin profile the user can top up later.
function obValidate(step) {
  if (step === 2 && !document.getElementById("obName").value.trim()) {
    return "Your name goes on every resume — please add it.";
  }
  if (step === 3) {
    const roles = PROFILE.resume.experience.filter(r => (r.title || "").trim() || (r.company || "").trim());
    if (!roles.length) return "Add at least one role, or the fit check has nothing to compare against.";
  }
  return null;
}

function startOnboarding() {
  document.getElementById("obName").value = PROFILE.identity.name || CURRENT_USER?.displayName || "";
  document.getElementById("obEmail").value = PROFILE.identity.email || CURRENT_USER?.email || "";
  document.getElementById("obPhone").value = PROFILE.identity.phone || "";
  document.getElementById("obLocation").value = PROFILE.identity.location || "";
  document.getElementById("obLinkedin").value = PROFILE.identity.linkedin || "";
  document.getElementById("obNotice").value = PROFILE.standingAnswers.notice_period || "";
  document.getElementById("obCurrentCtc").value = PROFILE.standingAnswers.current_ctc || "";
  document.getElementById("obExpectedCtc").value = PROFILE.standingAnswers.expected_ctc || "";
  obSetRelo(PROFILE.standingAnswers.open_to_relocation !== "no");
  obShowStep(1);
  showScreen("onboarding");
}

function obSetRelo(yes) {
  document.getElementById("obReloYes").classList.toggle("on", yes);
  document.getElementById("obReloNo").classList.toggle("on", !yes);
}
document.getElementById("obReloYes").addEventListener("click", () => obSetRelo(true));
document.getElementById("obReloNo").addEventListener("click", () => obSetRelo(false));

document.getElementById("btnObBack").addEventListener("click", () => {
  if (OB_STEP === 2) obCollectIdentity();
  if (OB_STEP === 5) obCollectStanding();
  obShowStep(OB_STEP - 1);
});

document.getElementById("btnObNext").addEventListener("click", async () => {
  if (OB_STEP === 2) obCollectIdentity();
  if (OB_STEP === 5) obCollectStanding();

  const problem = obValidate(OB_STEP);
  if (problem) { document.getElementById("obError").textContent = problem; return; }

  if (OB_STEP < OB_TOTAL) { obShowStep(OB_STEP + 1); return; }

  // Finish: drop the placeholder rows the editors create so an empty "Add a
  // role" click doesn't persist a blank employer into every future resume.
  PROFILE.resume.experience = PROFILE.resume.experience
    .filter(r => (r.title || "").trim() || (r.company || "").trim())
    .map(r => ({ ...r, achievements: (r.achievements || []).map(b => b.trim()).filter(Boolean) }));
  PROFILE.resume.education = PROFILE.resume.education.filter(e => (e.degree || "").trim() || (e.school || "").trim());

  const btn = document.getElementById("btnObNext");
  btn.disabled = true;
  try {
    await saveProfile();
    localStorage.removeItem(OB_DISMISSED_KEY);
    toast("Profile saved — you're set up");
    showScreen("home");
  } catch (e) {
    document.getElementById("obError").textContent = "Couldn't save your profile. Check your connection and try again.";
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btnObSkip").addEventListener("click", async () => {
  if (OB_STEP === 2) obCollectIdentity();
  if (OB_STEP === 5) obCollectStanding();
  try { await saveProfile(); } catch (e) {}
  // Remember the choice, or the next sign-in drops them straight back into the
  // wizard they just walked away from. The Profile screen keeps a way back in.
  localStorage.setItem(OB_DISMISSED_KEY, "1");
  toast("Saved what you've entered — finish anytime from Profile");
  showScreen("profile");
  fillProfileForm();
});

document.getElementById("btnObManual").addEventListener("click", () => obShowStep(2));

// Reachable after "Finish later", and useful to anyone who'd rather be walked
// through the fields than hunt for them on this screen.
document.getElementById("btnRunSetup").addEventListener("click", () => startOnboarding());
document.getElementById("btnObUpload").addEventListener("click", () => document.getElementById("fileObResume").click());
document.getElementById("fileObResume").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  const ok = await handleResumeUpload(file, {
    statusEl: document.getElementById("obUploadStatus"),
    buttonEl: document.getElementById("btnObUpload")
  });
  e.target.value = "";
  // Straight into review — the parse is good but not infallible, and the user
  // should see what was extracted before it's used on a real application.
  if (ok) {
    document.getElementById("obName").value = PROFILE.identity.name || "";
    document.getElementById("obEmail").value = PROFILE.identity.email || "";
    document.getElementById("obPhone").value = PROFILE.identity.phone || "";
    document.getElementById("obLocation").value = PROFILE.identity.location || "";
    document.getElementById("obLinkedin").value = PROFILE.identity.linkedin || "";
    obShowStep(2);
  }
});

function fillProfileForm() {
  document.getElementById("pName").value = PROFILE.identity.name || "";
  document.getElementById("pLocation").value = PROFILE.identity.location || "";
  document.getElementById("pPhone").value = PROFILE.identity.phone || "";
  document.getElementById("pEmail").value = PROFILE.identity.email || "";
  document.getElementById("pLinkedin").value = PROFILE.identity.linkedin || "";
  document.getElementById("pNotice").value = PROFILE.standingAnswers.notice_period || "";
  document.getElementById("pCurrentCtc").value = PROFILE.standingAnswers.current_ctc || "";
  document.getElementById("pExpectedCtc").value = PROFILE.standingAnswers.expected_ctc || "";
  setRelo(PROFILE.standingAnswers.open_to_relocation === "yes");
  document.getElementById("pResumeJson").value = JSON.stringify(PROFILE.resume, null, 2);
  renderExperienceEditor("pExperienceMount");
  renderSkillsEditor("pSkillsMount");
  renderEducationEditor("pEducationMount");
  renderProviderList();
}
function setRelo(yes) {
  document.getElementById("pReloYes").classList.toggle("on", yes);
  document.getElementById("pReloNo").classList.toggle("on", !yes);
}
document.getElementById("pReloYes").addEventListener("click", () => setRelo(true));
document.getElementById("pReloNo").addEventListener("click", () => setRelo(false));
document.getElementById("btnSaveProfile").addEventListener("click", async () => {
  let resumeData;
  try {
    resumeData = JSON.parse(document.getElementById("pResumeJson").value);
  } catch (e) {
    toast("Resume JSON isn't valid — not saved");
    return;
  }
  PROFILE = {
    ...PROFILE,
    identity: {
      name: document.getElementById("pName").value,
      location: document.getElementById("pLocation").value,
      phone: document.getElementById("pPhone").value,
      email: document.getElementById("pEmail").value,
      linkedin: document.getElementById("pLinkedin").value
    },
    standingAnswers: {
      notice_period: document.getElementById("pNotice").value,
      current_ctc: document.getElementById("pCurrentCtc").value,
      expected_ctc: document.getElementById("pExpectedCtc").value,
      location: document.getElementById("pLocation").value,
      open_to_relocation: document.getElementById("pReloYes").classList.contains("on") ? "yes" : "no"
    },
    resume: resumeData
  };
  try {
    await saveProfile();
    toast("Profile saved");
  } catch (e) {
    toast("Could not save profile");
  }
});
document.getElementById("btnResetProfile").addEventListener("click", async () => {
  if (!confirm("Reset profile to the default seed data? This discards your edits.")) return;
  PROFILE = { ...JSON.parse(JSON.stringify(DEFAULT_PROFILE)), preferredProvider: PROFILE.preferredProvider, preferredModel: PROFILE.preferredModel };
  await saveProfile();
  fillProfileForm();
  toast("Reset to default");
});

/* ---------- master resume upload ---------- */
const fileResume = document.getElementById("fileResume");
document.getElementById("btnUploadResume").addEventListener("click", () => {
  if (!configuredProviders().length) { toast("Add an AI provider key first"); return; }
  fileResume.click();
});

fileResume.addEventListener("change", async e => {
  const file = e.target.files[0];
  // Reset so re-picking the same file still fires a change event.
  e.target.value = "";
  if (!file) return;
  // Repaint the whole Profile screen on success — the parse fills identity
  // fields too, not just the resume arrays.
  if (await handleResumeUpload(file)) fillProfileForm();
});

// Serves both the Profile screen and the first-run wizard, which own different
// status/button elements — hence the injected targets rather than hard-coded ids.
// Returns true only on a successful import, so the wizard knows whether to
// advance the user to the review step.
async function handleResumeUpload(file, targets) {
  const sel = currentSelection();
  if (!sel) { toast("Add an AI provider key first"); return false; }

  const status = targets?.statusEl || document.getElementById("resumeUploadStatus");
  const btn = targets?.buttonEl || document.getElementById("btnUploadResume");
  const setStatus = msg => { status.textContent = msg; };

  btn.disabled = true;
  setStatus(`Reading ${file.name}…`);

  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("could not read that file"));
      reader.readAsDataURL(file);
    });

    const parsed = await withAutoRetry(
      () => apiPost("/api/profile-resume-parse", {
        file: base64, filename: file.name, provider: sel.provider, model: sel.model
      }),
      setStatus
    );

    // Only overwrite identity fields the resume actually supplied — a resume
    // without a phone number shouldn't wipe one the user already typed in.
    const id = parsed.identity || {};
    PROFILE.identity = { ...PROFILE.identity };
    for (const k of ["name", "location", "phone", "email", "linkedin"]) {
      if (id[k]) PROFILE.identity[k] = id[k];
    }
    if (parsed.resume) PROFILE.resume = parsed.resume;

    PROFILE = normalizeProfile(PROFILE);
    await saveProfile();
    refreshMountedEditors();
    syncResumeJson();

    const r = parsed.resume || {};
    setStatus(`Imported ${(r.experience || []).length} role(s), ${(r.education || []).length} education entr(ies), ${(r.skills || []).length} skills. Review and edit anything that looks off.`);
    toast("Resume imported");
    return true;
  } catch (err) {
    setStatus("");
    toast(err.message || "Could not read that resume");
    return false;
  } finally {
    btn.disabled = false;
  }
}

// Irreversible, so it asks for the word to be typed rather than a single
// confirm() that can be dismissed by reflex. The server independently
// re-checks the same phrase.
document.getElementById("btnDeleteAccount").addEventListener("click", async () => {
  const typed = prompt(
    "This permanently deletes your profile, all logged applications and follow-ups, and your saved provider keys.\n\n" +
    "This cannot be undone.\n\nType DELETE to confirm:"
  );
  if (typed !== "DELETE") {
    if (typed !== null) toast("Not deleted — the phrase didn't match");
    return;
  }
  try {
    await apiPost("/api/delete-account", { confirm: "DELETE" });
    // Clear the local import marker so a fresh account on this device isn't
    // silently blocked from the one-time legacy import.
    try { localStorage.removeItem("jobagent.importDismissed.v1"); } catch (e) {}
    toast("Account deleted");
    await signOut(auth);
  } catch (e) {
    toast(e.message || "Could not delete the account");
  }
});

/* ---------- service worker ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

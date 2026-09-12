// ============================================
// 8CM — Auth UI
// ------------------------------------------------
// Wires the sign-in/sign-up modal, the identity-claim modal, and the
// profile dropdown in the navbar to the logic in auth.js. Nothing in
// here talks to Firebase directly — it only calls exported functions.
// ============================================
import { students } from "./students.js";
import {
  subscribeAuth,
  signInGoogle,
  signInEmail,
  signUpEmail,
  resetPassword,
  signOutUser,
  getFriendlyAuthError,
  ensureProfileDoc,
  claimStudentIdentity,
  switchStudentIdentity,
  isFirebaseConfigured,
} from "./auth.js";

let mode = "signin"; // "signin" | "signup" | "reset"
let latestState = { user: null, profile: null, admin: false };
// "initial" = mandatory first-time pick, no way out but signing out.
// "switch" = the optional, cancelable "Switch student" action from
// the profile dropdown on an account that's already claimed.
let claimMode = "initial";

const $ = (id) => document.getElementById(id);

// ------------------------------------------------
// Sign in / up / reset modal
// ------------------------------------------------
function showAuthModal(startMode) {
  setMode(startMode || "signin");
  $("authOverlay").hidden = false;
}

function hideAuthModal() {
  $("authOverlay").hidden = true;
  $("authForm").reset();
  setAuthError(null);
  $("authResetNote").hidden = true;
  document.querySelectorAll(".password-toggle").forEach((btn) => {
    const input = document.querySelector(`input[name="${btn.dataset.target}"]`);
    if (input) input.type = "password";
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", "Show password");
    btn.querySelector(".eye-open").hidden = false;
    btn.querySelector(".eye-closed").hidden = true;
  });
}

function setAuthError(message, retryFn) {
  const el = $("authError");
  el.innerHTML = "";
  el.hidden = !message;
  if (!message) return;

  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);

  if (retryFn) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "auth-error-retry";
    btn.textContent = "Try again";
    btn.addEventListener("click", () => {
      setAuthError(null);
      retryFn();
    });
    el.appendChild(btn);
  }
}

function setMode(next) {
  mode = next;

  document.querySelectorAll(".auth-tab").forEach((tab) => {
    const matches = tab.dataset.mode === next || (next === "reset" && tab.dataset.mode === "signin");
    tab.classList.toggle("active", matches);
  });

  document.querySelector('[data-field="password"]').hidden = next === "reset";
  document.querySelector('[data-field="confirmPassword"]').hidden = next !== "signup";
  $("googleSignInBtn").hidden = next === "reset";
  document.querySelector(".auth-divider").hidden = next === "reset";
  $("forgotPasswordBtn").hidden = next === "signup";
  $("authResetNote").hidden = true;

  $("authSubmitBtn").querySelector(".btn-label").textContent =
    next === "signup" ? "Create account" : next === "reset" ? "Send reset link" : "Sign in";

  setAuthError(null);
}

// ------------------------------------------------
// Immersive loading overlay (blur backdrop + status)
// ------------------------------------------------
function showLoading(status) {
  $("loadingOverlay").classList.remove("hiding");
  $("loadingStatus").textContent = status || "Working…";
  $("loadingOverlay").hidden = false;
}

function setLoadingStatus(status) {
  $("loadingStatus").textContent = status;
}

function hideLoading() {
  const el = $("loadingOverlay");
  if (el.hidden) return;
  // Fade out rather than snapping to [hidden] instantly, so a fast
  // Firebase response never reads as an abrupt, jarring close.
  el.classList.add("hiding");
  setTimeout(() => {
    el.hidden = true;
    el.classList.remove("hiding");
  }, 180);
}

// ------------------------------------------------
// Wait for the global auth subscription (below) to actually reflect
// the just-signed-in user — including its Firestore profile fetch —
// before any modal/loading state is dismissed. Signing in resolves
// the moment Firebase Auth confirms the credential, but our own
// onAuthStateChanged → getProfile chain runs a beat *after* that, so
// closing the modal on promise-resolution alone could show a stale
// "Sign in" button for a frame, or make a Google-returning-user
// wrongly look like they still need to claim a name. This polls
// `latestState` (kept current by subscribeAuth below) until it lines
// up with the uid we just authenticated, with a defensive timeout so
// a dropped listener can never hang the UI forever.
function waitForAuthUser(uid, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (latestState.user && latestState.user.uid === uid) {
      resolve(latestState);
      return;
    }
    const interval = setInterval(() => {
      if (latestState.user && latestState.user.uid === uid) {
        finish();
      }
    }, 50);
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      clearInterval(interval);
      clearTimeout(timer);
      resolve(latestState);
    }
  });
}

// ------------------------------------------------
// Password visibility toggles
// ------------------------------------------------
function wirePasswordToggles() {
  document.querySelectorAll(".password-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.querySelector(`input[name="${btn.dataset.target}"]`);
      if (!input) return;
      const nowVisible = input.type === "password"; // about to become visible
      input.type = nowVisible ? "text" : "password";
      btn.setAttribute("aria-pressed", String(nowVisible));
      btn.setAttribute("aria-label", nowVisible ? "Hide password" : "Show password");
      btn.querySelector(".eye-open").hidden = nowVisible;
      btn.querySelector(".eye-closed").hidden = !nowVisible;
    });
  });
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const email = f.email.value.trim();
  const password = f.password.value;
  const confirmPassword = f.confirmPassword.value;

  setAuthError(null);

  if (mode === "signup" && password !== confirmPassword) {
    setAuthError("Those passwords don't match — check and try again.");
    return;
  }

  if (mode === "signup") {
    await runSignUp(email, password);
  } else if (mode === "reset") {
    await runReset(email);
  } else {
    await runSignIn(email, password);
  }
}

// ------------------------------------------------
// Each Firebase call gets its own try/catch so a failure at any one
// stage (the auth call itself vs. the Firestore sync afterward) gets
// its own accurate message and its own retry, instead of one
// catch-all that can't tell the two apart.
// ------------------------------------------------
async function runSignIn(email, password) {
  showLoading("Signing in…");
  let cred;
  try {
    cred = await signInEmail(email, password);
  } catch (err) {
    hideLoading();
    console.error(err);
    setAuthError(getFriendlyAuthError(err), () => runSignIn(email, password));
    return;
  }
  await finishAfterAuth(cred.user);
}

async function runSignUp(email, password) {
  showLoading("Creating your account…");
  let cred;
  try {
    cred = await signUpEmail(email, password);
  } catch (err) {
    hideLoading();
    console.error(err);
    setAuthError(getFriendlyAuthError(err), () => runSignUp(email, password));
    return;
  }
  await finishAfterAuth(cred.user);
}

async function runReset(email) {
  showLoading("Sending reset link…");
  try {
    await resetPassword(email);
    hideLoading();
    $("authResetNote").hidden = false;
    $("authResetNote").textContent = "Reset link sent — check your inbox.";
  } catch (err) {
    hideLoading();
    console.error(err);
    setAuthError(getFriendlyAuthError(err), () => runReset(email));
  }
}

async function handleGoogleSignIn() {
  setAuthError(null);
  showLoading("Connecting to Google…");
  let cred;
  try {
    cred = await signInGoogle();
  } catch (err) {
    hideLoading();
    console.error(err);
    setAuthError(getFriendlyAuthError(err), handleGoogleSignIn);
    return;
  }
  await finishAfterAuth(cred.user);
}

// Runs after Firebase Auth itself has already succeeded: syncs the
// Firestore profile doc, then waits for that to actually propagate
// through the app's own auth-state subscription before dismissing the
// loading state and the sign-in modal — this is the fix for the
// popup/modal closing before Firebase state had fully settled.
//
// It deliberately does NOT decide whether the identity-claim modal
// should open: subscribeAuth's callback below does that, uniformly,
// for every sign-in path (email, sign-up, Google, and a restored
// session on page load) instead of each call site guessing.
async function finishAfterAuth(user) {
  try {
    setLoadingStatus("Setting up your profile…");
    await ensureProfileDoc(user);
    await waitForAuthUser(user.uid);
    hideLoading();
    hideAuthModal();
  } catch (err) {
    hideLoading();
    console.error(err);
    setAuthError(
      "Signed in, but we couldn't finish syncing your profile. Try again.",
      () => finishAfterAuth(user)
    );
  }
}

// ------------------------------------------------
// Identity claim modal
// ------------------------------------------------
function populateClaimSelect() {
  const select = $("claimSelect");
  select.innerHTML = "";
  [...students]
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name;
      select.appendChild(opt);
    });
}

function openClaimModal(nextMode = "initial", preselectId = null) {
  claimMode = nextMode;
  const isSwitch = nextMode === "switch";

  populateClaimSelect();
  if (preselectId) $("claimSelect").value = preselectId;
  $("claimError").hidden = true;

  $("claimModalTitle").textContent = isSwitch ? "Switch student" : "Which one are you?";
  $("claimModalSub").textContent = isSwitch
    ? "Pick a different name from the directory. This updates who your account is linked to."
    : "Pick your name from the directory to finish setting up your account. This links your account to that student.";
  $("claimWrongAccountBtn").hidden = isSwitch;
  $("claimCancelBtn").hidden = !isSwitch;
  $("claimClose").hidden = !isSwitch;

  $("claimOverlay").hidden = false;
}

function closeClaimModal() {
  $("claimOverlay").hidden = true;
}

async function handleClaimConfirm() {
  const studentId = $("claimSelect").value;
  const student = students.find((s) => s.id === studentId);
  if (!student || !latestState.user) return;

  const btn = $("claimConfirmBtn");
  btn.disabled = true;
  $("claimError").hidden = true;

  try {
    if (claimMode === "switch") {
      await switchStudentIdentity(latestState.user.uid, student);
    } else {
      await claimStudentIdentity(latestState.user.uid, student, latestState.profile);
    }
    // Firestore writes don't re-trigger onAuthStateChanged, so the
    // reactive state never hears about this on its own — that's what
    // used to force a manual page reload before the claimed name and
    // house/transport stats would show up. Patch it in directly here
    // instead of waiting on a listener that will never fire.
    latestState = {
      ...latestState,
      profile: {
        ...(latestState.profile || {}),
        claimedStudentId: student.id,
        claimedStudentName: student.name,
      },
    };
    renderAuthSlot();
    closeClaimModal();
  } catch (err) {
    $("claimError").hidden = false;
    $("claimError").textContent =
      err.code === "identity/already-claimed"
        ? "That student is already linked to another account. Pick a different name."
        : err.code === "identity/already-bound"
        ? "Your account is already permanently linked to a student and can't be changed here."
        : "Couldn't save that right now. Try again.";
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------
// Profile pill (reactive — rebuilt whenever auth state changes)
// ------------------------------------------------
function initials(name) {
  if (!name) return "?";
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

function houseLabel(house) {
  return house.charAt(0).toUpperCase() + house.slice(1);
}

function transportLabel(t) {
  return t === "OT" ? "Own transport" : `Bus ${t}`;
}

function renderAuthSlot() {
  const slot = $("authSlot");
  if (!slot) return;
  const { user, profile, admin } = latestState;

  if (!user) {
    slot.innerHTML = `<button class="btn btn-primary btn-small" id="signInTriggerBtn">Sign in</button>`;
    $("signInTriggerBtn").addEventListener("click", () => showAuthModal("signin"));
    return;
  }

  const name = (profile && profile.claimedStudentName) || user.displayName || user.email || "Account";
  const student = profile && profile.claimedStudentId
    ? students.find((s) => s.id === profile.claimedStudentId)
    : null;

  slot.innerHTML = `
    <div class="nav-item has-dropdown" id="profileItem">
      <button class="profile-pill" id="profileTrigger" aria-expanded="false">
        <span class="profile-avatar">${initials(name)}</span>
        <span class="tri">▾</span>
      </button>
      <div class="dropdown profile-dropdown" id="profileDropdown">
        <p class="profile-name">${name}</p>
        <p class="profile-email">${user.email || ""}</p>
        ${admin ? `<span class="admin-pill">Admin</span>` : ""}
        ${student ? `
          <div class="profile-stats">
            <span class="profile-stat-pill house-${student.house}">
              <span class="house-dot ${student.house}"></span>${houseLabel(student.house)}
            </span>
            <span class="profile-stat-pill">${transportLabel(student.transport)}</span>
          </div>
        ` : ""}
        <button class="dropdown-action" id="switchStudentBtn">Switch student</button>
        <button class="dropdown-action" id="signOutBtn">Sign out</button>
      </div>
    </div>
  `;

  const item = $("profileItem");
  const trigger = $("profileTrigger");
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = item.classList.toggle("open");
    trigger.setAttribute("aria-expanded", open);
  });

  $("switchStudentBtn").addEventListener("click", () => {
    item.classList.remove("open");
    openClaimModal("switch", profile && profile.claimedStudentId);
  });

  $("signOutBtn").addEventListener("click", () => {
    signOutUser();
    item.classList.remove("open");
  });
}

document.addEventListener("click", (e) => {
  const item = $("profileItem");
  if (item && !item.contains(e.target)) item.classList.remove("open");
});

// ------------------------------------------------
// Init
// ------------------------------------------------
export function initAuthUI() {
  wirePasswordToggles();

  if (!isFirebaseConfigured) {
    $("configBanner").hidden = false;
  }

  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });

  $("authClose").addEventListener("click", hideAuthModal);
  $("authForm").addEventListener("submit", handleAuthSubmit);
  $("googleSignInBtn").addEventListener("click", handleGoogleSignIn);
  $("forgotPasswordBtn").addEventListener("click", () => setMode("reset"));
  $("authOverlay").addEventListener("click", (e) => {
    if (e.target === $("authOverlay")) hideAuthModal();
  });

  $("claimConfirmBtn").addEventListener("click", handleClaimConfirm);
  // This signs the account out entirely — it's not a "skip", it's the
  // only way out for someone who authenticated with the wrong Google
  // account during the mandatory first-time claim. Hidden in "switch"
  // mode, where claimCancelBtn/claimClose below do the equivalent job
  // without signing anyone out.
  $("claimWrongAccountBtn").addEventListener("click", () => {
    signOutUser();
    closeClaimModal();
  });
  $("claimCancelBtn").addEventListener("click", closeClaimModal);
  $("claimClose").addEventListener("click", closeClaimModal);
  $("claimOverlay").addEventListener("click", (e) => {
    if (e.target === $("claimOverlay") && claimMode === "switch") closeClaimModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && claimMode === "switch" && !$("claimOverlay").hidden) {
      closeClaimModal();
    }
  });

  subscribeAuth((state) => {
    latestState = state;
    renderAuthSlot();

    // Single source of truth for "does the MANDATORY claim modal need
    // to be open right now?" — runs for every sign-in path (email,
    // sign-up, Google) *and* for a session restored on page load,
    // instead of each call site deciding for itself. A signed-in user
    // with no linked student is forced through this until they
    // complete it; there is no skip. This only ever opens/closes the
    // "initial" claim — it leaves an open "switch" modal alone, since
    // that one is the user's own optional action.
    const overlay = $("claimOverlay");
    const needsInitialClaim = state.user && (!state.profile || !state.profile.claimedStudentId);
    if (needsInitialClaim) {
      if (overlay.hidden || claimMode !== "initial") openClaimModal("initial");
    } else if (!overlay.hidden && claimMode === "initial") {
      closeClaimModal();
    }
  });
}

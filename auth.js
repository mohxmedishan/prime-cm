// ============================================
// 8CM — Authentication & profile logic
// ------------------------------------------------
// UI code (auth-ui.js, tasks.js) imports from here rather than
// touching Firebase directly, so the auth/Firestore surface area
// stays in one place.
// ============================================
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, isFirebaseConfigured } from "./firebase-config.js";

export { isFirebaseConfigured };

// This must match the email allow-listed in firestore.rules for the
// tasks collection. Keeping it here too lets the UI hide admin
// controls for everyone else — the rules file is what actually
// enforces it server-side.
export const ADMIN_EMAIL = "mohamedishankunnummal@gmail.com";

const googleProvider = new GoogleAuthProvider();
// Forces the account chooser every time instead of silently reusing
// whatever Google session is cached, which is what produced confusing
// "something went wrong" retries after a first failed popup.
googleProvider.setCustomParameters({ prompt: "select_account" });

// ------------------------------------------------
// Friendly error messages
// ------------------------------------------------
const ERROR_MESSAGES = {
  "auth/email-already-in-use": "That email already has an account — try signing in instead.",
  "auth/invalid-email": "That doesn't look like a valid email address.",
  "auth/user-not-found": "No account found with that email.",
  "auth/wrong-password": "Incorrect password. Try again, or reset it below.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/weak-password": "Password should be at least 6 characters.",
  "auth/missing-password": "Enter a password.",
  "auth/popup-closed-by-user": "Sign-in was closed before finishing — try again.",
  "auth/cancelled-popup-request": "Sign-in was interrupted — try again.",
  "auth/popup-blocked": "Your browser blocked the sign-in popup — allow popups for this site and try again.",
  "auth/unauthorized-domain": "This domain isn't authorized for Google sign-in yet — an admin needs to add it in the Firebase console (Authentication → Settings → Authorized domains).",
  "auth/operation-not-allowed": "Google sign-in isn't enabled for this project yet — an admin needs to turn it on in the Firebase console.",
  "auth/network-request-failed": "Network error — check your connection and try again.",
  "auth/too-many-requests": "Too many attempts. Wait a bit before trying again.",
  "auth/account-exists-with-different-credential":
    "This email is already linked to Google sign-in. Use \"Continue with Google\" instead.",
  "auth/invalid-api-key": "This site's Firebase project isn't configured yet — see firebase-config.js.",
  "auth/api-key-not-valid": "This site's Firebase project isn't configured yet — see firebase-config.js.",
  "auth/configuration-not-found": "This site's Firebase project isn't configured yet — see firebase-config.js.",
  "auth/app-not-authorized": "This site's Firebase project isn't configured yet — see firebase-config.js.",
  "auth/invalid-app-credential": "This site's Firebase project isn't configured yet — see firebase-config.js.",
};

export function getFriendlyAuthError(error) {
  const code = error && error.code;
  return ERROR_MESSAGES[code] || "Something went wrong. Try again in a moment.";
}

// ------------------------------------------------
// Sign in / up / out
// ------------------------------------------------
export function signInGoogle() {
  return signInWithPopup(auth, googleProvider);
}

export function signUpEmail(email, password) {
  // No separate "name" input — identity comes from the directory-claim
  // step right after this, so the account's displayName is synced
  // there (see claimStudentIdentity) instead of asked for twice.
  return createUserWithEmailAndPassword(auth, email, password);
}

export function signInEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

export function signOutUser() {
  return signOut(auth);
}

// ------------------------------------------------
// Profile documents (users/{uid})
// ------------------------------------------------
function profileRef(uid) {
  return doc(db, "users", uid);
}

export async function getProfile(uid) {
  const snap = await getDoc(profileRef(uid));
  return snap.exists() ? snap.data() : null;
}

// Firestore reads issued the instant onAuthStateChanged fires can hit
// a brief window where the ID token hasn't finished propagating to
// the Firestore SDK's channel yet — especially right after a fresh
// sign-out/sign-in cycle — and come back permission-denied even
// though the rules would normally allow them. subscribeAuth used to
// swallow that as "no profile," which is exactly what made an
// already-claimed account get asked to pick a student all over again
// on every re-login. A couple of short retries absorbs that window.
async function getProfileWithRetry(uid, attempts = 3, baseDelayMs = 200) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await getProfile(uid);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// ------------------------------------------------
// Local claim cache
// ------------------------------------------------
// A same-browser, per-uid memory of the last claimedStudentId we
// actually saw succeed. This exists purely as a bridge for the
// getProfileWithRetry window above: if EVERY retry throws (a longer
// permission-propagation stall than 3 tries covers, a flaky
// connection, etc.), the old behavior was to fall back to
// profile = null — which is exactly what forced an already-claimed
// person back through the "which one are you?" modal on some
// sign-ins. Now that case falls back to this cache instead. It is
// never treated as more trustworthy than a real Firestore read —
// it only fills the gap when Firestore couldn't be reached at all.
function claimCacheKey(uid) {
  return `8cm:claimedStudent:${uid}`;
}

function cacheClaim(uid, studentId, studentName) {
  try {
    localStorage.setItem(claimCacheKey(uid), JSON.stringify({ id: studentId, name: studentName }));
  } catch (err) {
    // Private browsing / storage disabled — the cache is a nice-to-have
    // fallback, not something the app depends on to function.
  }
}

function getCachedClaim(uid) {
  try {
    const raw = localStorage.getItem(claimCacheKey(uid));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

export function computeIsAdmin(user, profile) {
  if (!user) return false;
  if (user.email === ADMIN_EMAIL) return true;
  return !!(profile && profile.admin === true);
}

// Creates a bare profile doc right after signup/first Google sign-in,
// before identity claiming happens. Safe to call repeatedly.
export async function ensureProfileDoc(user) {
  await setDoc(
    profileRef(user.uid),
    {
      email: user.email || "",
      displayName: user.displayName || "",
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );
}

// Returns the uid that already claimed this student, or null if free.
export async function findExistingClaim(studentId) {
  const q = query(collection(db, "users"), where("claimedStudentId", "==", studentId));
  const snap = await getDocs(q);
  let claimedBy = null;
  snap.forEach((docSnap) => {
    claimedBy = docSnap.id;
  });
  return claimedBy;
}

// Links a Firebase account to one directory entry for the mandatory
// first-time pick. Throws { code: "identity/already-claimed" } if
// someone else got there first, or { code: "identity/already-bound" }
// if THIS account already has a student linked — from here on,
// changing it is switchStudentIdentity's job (the explicit "Switch
// student" action), not this function's.
export async function claimStudentIdentity(uid, student, currentProfile) {
  if (currentProfile && currentProfile.claimedStudentId && currentProfile.claimedStudentId !== student.id) {
    const err = new Error("This account is already permanently linked to a different student.");
    err.code = "identity/already-bound";
    throw err;
  }

  const existing = await findExistingClaim(student.id);
  if (existing && existing !== uid) {
    const err = new Error("That student has already been claimed by another account.");
    err.code = "identity/already-claimed";
    throw err;
  }

  await setDoc(
    profileRef(uid),
    {
      claimedStudentId: student.id,
      claimedStudentName: student.name,
      admin: false,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  cacheClaim(uid, student.id, student.name);

  // Keep the Firebase Auth displayName (used for e.g. Google-side UI)
  // in sync with the name the student actually claimed.
  if (auth.currentUser && auth.currentUser.uid === uid) {
    try {
      await updateProfile(auth.currentUser, { displayName: student.name });
    } catch (err) {
      console.error("Failed to sync displayName after claim:", err);
    }
  }
}

// Changes an ALREADY-claimed account to a different student, on
// purpose — this is the explicit "Switch student" action, distinct
// from claimStudentIdentity above (which is the mandatory first-time
// pick and refuses to overwrite an existing claim). Still refuses if
// someone else already has the target student linked. Deliberately
// does not touch the `admin` field, so switching students never
// silently strips admin access.
export async function switchStudentIdentity(uid, student) {
  const existing = await findExistingClaim(student.id);
  if (existing && existing !== uid) {
    const err = new Error("That student has already been claimed by another account.");
    err.code = "identity/already-claimed";
    throw err;
  }

  await setDoc(
    profileRef(uid),
    {
      claimedStudentId: student.id,
      claimedStudentName: student.name,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  cacheClaim(uid, student.id, student.name);

  if (auth.currentUser && auth.currentUser.uid === uid) {
    try {
      await updateProfile(auth.currentUser, { displayName: student.name });
    } catch (err) {
      console.error("Failed to sync displayName after switch:", err);
    }
  }
}

// ------------------------------------------------
// Global auth state
// ------------------------------------------------
// callback receives { user, profile, admin }. `user` is the raw
// Firebase user (or null when signed out); `profile` is the Firestore
// users/{uid} doc (or null until it loads / if it doesn't exist yet).
export function subscribeAuth(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      callback({ user: null, profile: null, admin: false });
      return;
    }

    let profile = null;
    try {
      profile = await getProfileWithRetry(user.uid);
    } catch (err) {
      console.error("Failed to load profile after retries:", err);
      // Firestore was unreachable for the whole retry window — fall
      // back to the last claim this browser confirmed rather than
      // treating this uid as unclaimed and re-showing the picker.
      const cached = getCachedClaim(user.uid);
      if (cached) {
        profile = { claimedStudentId: cached.id, claimedStudentName: cached.name };
      }
    }

    if (profile && profile.claimedStudentId) {
      cacheClaim(user.uid, profile.claimedStudentId, profile.claimedStudentName);
    }

    callback({ user, profile, admin: computeIsAdmin(user, profile) });
  });
}

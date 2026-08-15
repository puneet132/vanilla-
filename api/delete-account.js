// Permanently erases an account and everything attached to it.
//
// Required for a product holding this much personal data (name, phone, email,
// employment history, salary expectations) to be defensible: a user must be
// able to withdraw it, not just stop using the app. Deleting individual
// applications was previously the only removal path available.
//
// Order matters. Provider keys and Firestore data go first, while the caller's
// token is still valid; the auth user is deleted last, because once it is gone
// the token can no longer be verified and any remaining cleanup would be
// stranded with no way to authorise it.
const admin = require("firebase-admin");
const { verifyIdToken, firestore, getAdminApp } = require("./_firebaseAdmin");
const { PROVIDERS } = require("./_llm");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { idToken, confirm } = req.body || {};

  let decoded;
  try {
    decoded = await verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: "invalid or expired session — please sign in again" });
  }

  // A typed confirmation, checked server-side too. Stops a stray client call
  // from wiping an account on its own.
  if (confirm !== "DELETE") {
    return res.status(400).json({ error: "confirmation phrase missing" });
  }

  const uid = decoded.uid;
  const db = firestore();

  try {
    // 1. Encrypted provider keys. Deleting a document that doesn't exist is a
    //    no-op in Firestore, so no need to check first.
    await Promise.all(
      PROVIDERS.map(p => db.collection("serverOnly_providerKeys").doc(`${uid}_${p}`).delete())
    );

    // 2. Profile document and the whole applications subcollection. A plain
    //    .delete() on the parent would orphan the subcollection rather than
    //    remove it — Firestore documents and subcollections are independent.
    await db.recursiveDelete(db.collection("users").doc(uid));

    // 3. The auth record itself, last.
    await admin.auth(getAdminApp()).deleteUser(uid);

    return res.status(200).json({ ok: true });
  } catch (e) {
    // Partial failure is possible (e.g. Firestore succeeded, auth delete did
    // not). Say so plainly rather than reporting a clean success.
    return res.status(500).json({ error: "account deletion did not complete — some data may remain. Please try again." });
  }
};

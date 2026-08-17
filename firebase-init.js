// Firebase web config is NOT a secret — it identifies which Firebase project to talk
// to, security is enforced by Firestore rules + Admin SDK, not by hiding this object.
// Fill these in after creating your Firebase project (see README.md → Setup).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, reauthenticateWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCp9RhfIJOnZ33n8G_cPLR7Rgn1Yq1crDE",
  authDomain: "vanilla-1c9bb.firebaseapp.com",
  projectId: "vanilla-1c9bb",
  storageBucket: "vanilla-1c9bb.firebasestorage.app",
  messagingSenderId: "576540236184",
  appId: "1:576540236184:web:daf1e4a544ae70a50f73ed"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

// Deliberately a SECOND provider, not an extra scope on the sign-in one.
//
// Gmail access is requested incrementally — only when someone actually clicks
// "Save to Gmail drafts", never at sign-up. Bolting gmail.compose onto the
// sign-in provider would show every new user a scary "Vanilla wants to manage
// your email" consent screen before they've seen the product work once, and
// would make the whole app unusable for anyone who declines it.
//
// gmail.compose creates and updates drafts. It cannot send, and it cannot read
// existing mail — the narrowest scope that does this job.
export const gmailProvider = new GoogleAuthProvider();
gmailProvider.addScope("https://www.googleapis.com/auth/gmail.compose");

export { signInWithPopup, reauthenticateWithPopup, onAuthStateChanged, signOut, GoogleAuthProvider };

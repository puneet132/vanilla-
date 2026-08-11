// Firebase web config is NOT a secret — it identifies which Firebase project to talk
// to, security is enforced by Firestore rules + Admin SDK, not by hiding this object.
// Fill these in after creating your Firebase project (see README.md → Setup).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
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
export { signInWithPopup, onAuthStateChanged, signOut };

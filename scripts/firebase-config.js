/**
 * Cloud sync is entirely OPTIONAL. The whole app works fully offline,
 * on-device, without ever touching this file — that stays true even
 * after you fill it in, for anyone who doesn't choose to sign in.
 *
 * To turn cross-device sync on for your archive:
 *   1. Go to https://console.firebase.google.com and create a project
 *      (the free "Spark" plan is plenty for this).
 *   2. Build > Authentication > Sign-in method > enable "Google".
 *   3. Build > Firestore Database > Create database (start in
 *      "production mode" — the rules file below locks it down).
 *   4. Project settings (gear icon, top left) > General > "Your apps"
 *      > Add app > Web (the </> icon) > copy the firebaseConfig
 *      object it shows you into FIREBASE_CONFIG below.
 *   5. Authentication > Settings > "Authorized domains" > add your
 *      site's real domain (e.g. 3nding.top). Google sign-in refuses
 *      to run on domains that aren't on this list.
 *   6. Firestore Database > Rules tab > paste in firestore.rules
 *      (included alongside this file) > Publish. This makes sure
 *      each signed-in person can only read/write their own data.
 *
 * Until you replace the placeholder apiKey below, the "Cloud sync"
 * button stays hidden in the app and nothing here ever runs.
 */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBOq3UP0pkIEzc3X9IX_bAPEEnXVa9yklI",
  authDomain: "ending-archive.firebaseapp.com",
  projectId: "ending-archive",
  storageBucket: "ending-archive.firebasestorage.app",
  messagingSenderId: "206642227328",
  appId: "1:206642227328:web:1470bbde16d95fde251e65",
  measurementId: "G-C3JE36ETQB",
};

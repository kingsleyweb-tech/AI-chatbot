import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { browserLocalPersistence, getAuth, indexedDBLocalPersistence, initializeAuth, browserPopupRedirectResolver } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
  type Firestore,
} from 'firebase/firestore';

/**
 * Sign-in redirects and popups run through `https://<authDomain>/__/auth/handler`.
 * When that is a different site from the app (the default *.firebaseapp.com),
 * browsers that partition third-party storage (Safari, installed PWAs, newer
 * Chrome) can lose the result, so the user lands back on the login page.
 * VITE_FIREBASE_AUTH_DOMAIN=auto serves the handler from the app's own domain
 * (vercel.json proxies /__/auth/* to Firebase). Each such domain must be an
 * authorized domain in Firebase and an allowed redirect URI for Google/Apple.
 */
function authDomain(): string | undefined {
  const configured = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined;
  if (configured !== 'auto') return configured;
  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  return local ? `${import.meta.env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com` : window.location.host;
}

const config: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: authDomain(),
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

export const firebaseConfigured = Boolean(config.apiKey && config.projectId && config.appId);

export const app = initializeApp(
  firebaseConfigured ? config : { apiKey: 'missing', projectId: 'missing', appId: 'missing' },
);

function createAuth() {
  try {
    return initializeAuth(app, {
      persistence: [indexedDBLocalPersistence, browserLocalPersistence],
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  } catch {
    return getAuth(app);
  }
}
export const auth = createAuth();

function createDb(): Firestore {
  try {
    // Offline cache: conversations load instantly and survive app restarts.
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    });
  } catch {
    return initializeFirestore(app, { localCache: memoryLocalCache(), ignoreUndefinedProperties: true });
  }
}
export const db = createDb();

/** Analytics is optional and only loaded in production when supported. */
export async function initAnalytics() {
  if (!import.meta.env.PROD || !config.measurementId || !firebaseConfigured) return;
  try {
    const { getAnalytics, isSupported } = await import('firebase/analytics');
    if (await isSupported()) getAnalytics(app);
  } catch {
    /* analytics is non-essential */
  }
}

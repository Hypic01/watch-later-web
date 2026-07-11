// Session handling for both modes. Real mode: Supabase Google OAuth, token
// auto-refreshed by supabase-js. Dev mode: "dev:<email>" token in localStorage
// against a DEV_FAKE_AUTH server.
import { supabase, isDevAuth } from "./supabase.js";

const DEV_KEY = "wll-dev-email";

export async function getToken() {
  if (isDevAuth) {
    const email = localStorage.getItem(DEV_KEY);
    return email ? `dev:${email}` : null;
  }
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function signInWithGoogle() {
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${location.origin}/app` },
  });
}

export function signInDev(email) {
  localStorage.setItem(DEV_KEY, email.trim().toLowerCase());
}

export async function signOut() {
  if (isDevAuth) localStorage.removeItem(DEV_KEY);
  else await supabase.auth.signOut();
  location.reload();
}

export async function hasSession() {
  return (await getToken()) !== null;
}

export function onAuthChange(cb) {
  if (isDevAuth) return () => {};
  const { data } = supabase.auth.onAuthStateChange(() => cb());
  return () => data.subscription.unsubscribe();
}

export { isDevAuth };

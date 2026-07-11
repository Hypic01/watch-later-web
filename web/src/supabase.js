// Supabase client for Google sign-in. When the env isn't configured (local
// dev), auth falls back to DEV mode: the server accepts "dev:<email>" tokens
// when started with DEV_FAKE_AUTH=1.
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && anonKey ? createClient(url, anonKey) : null;
export const isDevAuth = !supabase;

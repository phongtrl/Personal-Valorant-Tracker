// Supabase > Project Settings > API. Fill in both values to turn on Google sign-in and sync.
// The anon (publishable) key is meant to be public: the row-level security rules in supabase.sql protect the data.
// Never put a service_role key here.
window.SUPABASE_CONFIG = {
  url: "https://bifvfebjatnlelksolwo.supabase.co",
  anonKey: "sb_publishable_GYVE3UZcjowlAndYJe8Y0g_Q5dlbCwW"  // publishable key, safe in the browser
};

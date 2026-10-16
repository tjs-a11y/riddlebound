// Public settings for the member pages. Both Supabase values are PUBLIC by design (they ship in
// every browser); the secret key never appears on this site. Leave supabaseKey empty to show
// "joining opens soon" instead of the sign-in form.
window.RB_CONFIG = {
  api: "https://riddlebound.vercel.app",
  supabaseUrl: "",
  supabaseKey: "", // the "publishable" key (sb_publishable_...), or the legacy anon key
};

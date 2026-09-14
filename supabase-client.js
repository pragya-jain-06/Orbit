(() => {
  const config = window.ORBIT_PUBLIC_CONFIG || {};
  if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase) return;
  window.orbitSupabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
})();
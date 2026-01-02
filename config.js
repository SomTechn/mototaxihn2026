// REEMPLAZA CON TUS CLAVES REALES DE SUPABASE
const SUPABASE_URL = 'https://brtiamwcdlwfyyprlevw.supabase.co'; 
const SUPABASE_KEY = 'sb_publishable_g8ETwpbbpEFR64zacmx_cw_L3Yxg7Zt';

if (typeof supabase !== 'undefined') {
    window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log("✅ Supabase inicializado");
} else {
    console.error("❌ Librería Supabase no cargada");
}
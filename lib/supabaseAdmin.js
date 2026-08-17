import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://ewgtpxomgkpbmfyddypw.supabase.co';

// One service-role client per invocation. Never expose SUPABASE_SERVICE_ROLE_KEY
// to the browser - it bypasses RLS entirely, which is exactly why it's the only
// thing allowed to call the vault_* RPCs (see sql/001_vault_keys.sql).
export function getServiceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('Server not configured (SUPABASE_SERVICE_ROLE_KEY missing)');
  return createClient(SUPABASE_URL, serviceKey);
}

// Every route that used to trust a client-sent x-*-key header now trusts the
// user's own Supabase session instead - this verifies the bearer token and
// returns the real user id, so callers can never act as anyone but themselves.
export async function getAuthedUserId(req, supabase) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

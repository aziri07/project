// ربط حسابات المنصات عبر OAuth.
// POST {action:"start", network:"meta"|"x", brand_id}  (مع توكن المستخدم) => {url}
// GET  ?code=...&state=...                                  (عودة المنصة)  => تحويل للوحة
// الأسرار: APP_URL, META_APP_ID, META_APP_SECRET, X_CLIENT_ID, X_CLIENT_SECRET
// انشره مع verify_jwt = false لأن عودة المنصة لا تحمل توكن المستخدم؛ الدالة تتحقق بنفسها.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const REDIRECT = `${SB_URL}/functions/v1/social-connect`;
const APP_URL = Deno.env.get("APP_URL") ?? "";
const GRAPH = "https://graph.facebook.com/v21.0";
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const back = (q: string) => Response.redirect(`${APP_URL}#accounts?${q}`, 302);

async function saveAccount(o: {
  owner_id: string; brand_id: string; network: string; external_id: string; handle: string;
  followers: number; access_token: string; refresh_token?: string | null; expires_at?: string | null;
}) {
  const { data, error } = await admin.from("social_accounts").upsert({
    owner_id: o.owner_id, brand_id: o.brand_id, network: o.network, external_id: o.external_id,
    handle: o.handle, followers: o.followers, status: "connected", connected_at: new Date().toISOString(),
  }, { onConflict: "brand_id,network,external_id" }).select("id").single();
  if (error) throw new Error(error.message);
  await admin.from("social_tokens").upsert({
    account_id: data.id, access_token: o.access_token,
    refresh_token: o.refresh_token ?? null, expires_at: o.expires_at ?? null,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // ---------- بدء الربط ----------
  if (req.method === "POST") {
    const userClient = createClient(SB_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "سجّل الدخول أولًا" }, 401);
    const { network, brand_id } = await req.json().catch(() => ({}));
    const { data: brand } = await userClient.from("brands").select("id").eq("id", brand_id).maybeSingle();
    if (!brand) return json({ error: "العلامة التجارية غير موجودة" }, 404);

    const state = randomString();
    if (network === "meta") {
      if (!Deno.env.get("META_APP_ID")) return json({ error: "ربط Meta غير مفعّل بعد في الخادم" }, 501);
      await admin.from("oauth_states").insert({ state, user_id: user.id, brand_id, network });
      const p = new URLSearchParams({
        client_id: Deno.env.get("META_APP_ID")!, redirect_uri: REDIRECT, state, response_type: "code",
        scope: "pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,business_management",
      });
      return json({ url: `https://www.facebook.com/v21.0/dialog/oauth?${p}` });
    }
    if (network === "x") {
      if (!Deno.env.get("X_CLIENT_ID")) return json({ error: "ربط X غير مفعّل بعد في الخادم" }, 501);
      const verifier = randomString(48);
      const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      await admin.from("oauth_states").insert({ state, user_id: user.id, brand_id, network, code_verifier: verifier });
      const p = new URLSearchParams({
        response_type: "code", client_id: Deno.env.get("X_CLIENT_ID")!, redirect_uri: REDIRECT, state,
        scope: "tweet.read tweet.write users.read offline.access",
        code_challenge: challenge, code_challenge_method: "S256",
      });
      return json({ url: `https://x.com/i/oauth2/authorize?${p}` });
    }
    return json({ error: "هذه الشبكة غير مفعّلة بعد" }, 501);
  }

  // ---------- العودة من المنصة ----------
  const u = new URL(req.url);
  const code = u.searchParams.get("code"), state = u.searchParams.get("state");
  if (!code || !state) return back("error=" + encodeURIComponent(u.searchParams.get("error_description") ?? "تم إلغاء الربط"));

  const { data: st } = await admin.from("oauth_states").select("*").eq("state", state).maybeSingle();
  if (!st) return back("error=" + encodeURIComponent("انتهت صلاحية طلب الربط، حاول مجددًا"));
  await admin.from("oauth_states").delete().eq("state", state);
  if (Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) return back("error=" + encodeURIComponent("انتهت مهلة الربط"));

  try {
    let added = 0;
    if (st.network === "meta") {
      const id = Deno.env.get("META_APP_ID")!, secret = Deno.env.get("META_APP_SECRET")!;
      const t1 = await (await fetch(`${GRAPH}/oauth/access_token?` + new URLSearchParams({
        client_id: id, client_secret: secret, redirect_uri: REDIRECT, code,
      }))).json();
      if (!t1.access_token) throw new Error(t1.error?.message ?? "فشل تبادل الرمز");
      const t2 = await (await fetch(`${GRAPH}/oauth/access_token?` + new URLSearchParams({
        grant_type: "fb_exchange_token", client_id: id, client_secret: secret, fb_exchange_token: t1.access_token,
      }))).json();
      const userToken = t2.access_token ?? t1.access_token;
      const pages = await (await fetch(`${GRAPH}/me/accounts?` + new URLSearchParams({
        fields: "id,name,access_token,fan_count,instagram_business_account{id,username,followers_count}",
        access_token: userToken,
      }))).json();
      for (const pg of pages.data ?? []) {
        await saveAccount({ owner_id: st.user_id, brand_id: st.brand_id, network: "facebook", external_id: pg.id,
          handle: pg.name, followers: pg.fan_count ?? 0, access_token: pg.access_token });
        added++;
        const ig = pg.instagram_business_account;
        if (ig) {
          await saveAccount({ owner_id: st.user_id, brand_id: st.brand_id, network: "instagram", external_id: ig.id,
            handle: "@" + ig.username, followers: ig.followers_count ?? 0, access_token: pg.access_token });
          added++;
        }
      }
      if (!added) throw new Error("لم نجد صفحات فيسبوك مرتبطة بحسابك");
    } else if (st.network === "x") {
      const id = Deno.env.get("X_CLIENT_ID")!, secret = Deno.env.get("X_CLIENT_SECRET")!;
      const tok = await (await fetch("https://api.x.com/2/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(`${id}:${secret}`) },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: st.code_verifier }),
      })).json();
      if (!tok.access_token) throw new Error(tok.error_description ?? "فشل تبادل الرمز");
      const me = await (await fetch("https://api.x.com/2/users/me?user.fields=public_metrics", {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      })).json();
      await saveAccount({ owner_id: st.user_id, brand_id: st.brand_id, network: "x", external_id: me.data.id,
        handle: "@" + me.data.username, followers: me.data.public_metrics?.followers_count ?? 0,
        access_token: tok.access_token, refresh_token: tok.refresh_token,
        expires_at: new Date(Date.now() + (tok.expires_in ?? 7200) * 1000).toISOString() });
      added = 1;
    }
    return back(`connected=${added}`);
  } catch (e) {
    return back("error=" + encodeURIComponent((e as Error).message));
  }
});

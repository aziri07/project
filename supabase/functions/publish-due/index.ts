// ينشر المنشورات التي حان موعدها. يستدعيه pg_cron كل دقيقة.
// السرّ المطلوب: CRON_SECRET (يُرسل في الترويسة x-cron-secret). انشره مع verify_jwt = false.
import { createClient } from "npm:@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v21.0";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Account = { id: string; external_id: string; network: string };
type Token = { access_token: string; refresh_token: string | null; expires_at: string | null };
type Post = { id: string; brand_id: string; text: string; media_url: string | null; networks: string[] };

async function xToken(acc: Account, t: Token): Promise<string> {
  if (!t.expires_at || new Date(t.expires_at).getTime() - Date.now() > 120_000 || !t.refresh_token) return t.access_token;
  const id = Deno.env.get("X_CLIENT_ID")!, secret = Deno.env.get("X_CLIENT_SECRET")!;
  const r = await (await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(`${id}:${secret}`) },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token }),
  })).json();
  if (!r.access_token) {
    await admin.from("social_accounts").update({ status: "expired" }).eq("id", acc.id);
    throw new Error("انتهت صلاحية ربط حساب X، أعد ربطه");
  }
  await admin.from("social_tokens").update({
    access_token: r.access_token, refresh_token: r.refresh_token ?? t.refresh_token,
    expires_at: new Date(Date.now() + (r.expires_in ?? 7200) * 1000).toISOString(),
  }).eq("account_id", acc.id);
  return r.access_token;
}

async function publishOne(post: Post, acc: Account, t: Token): Promise<string> {
  switch (acc.network) {
    case "facebook": {
      const body = new URLSearchParams({ access_token: t.access_token });
      let endpoint = `${GRAPH}/${acc.external_id}/feed`;
      if (post.media_url) { endpoint = `${GRAPH}/${acc.external_id}/photos`; body.set("url", post.media_url); body.set("caption", post.text); }
      else body.set("message", post.text);
      const r = await (await fetch(endpoint, { method: "POST", body })).json();
      if (!r.id && !r.post_id) throw new Error(r.error?.message ?? "فشل النشر على فيسبوك");
      return r.post_id ?? r.id;
    }
    case "instagram": {
      if (!post.media_url) throw new Error("إنستغرام يتطلب صورة مع المنشور");
      const c = await (await fetch(`${GRAPH}/${acc.external_id}/media`, {
        method: "POST", body: new URLSearchParams({ image_url: post.media_url, caption: post.text, access_token: t.access_token }),
      })).json();
      if (!c.id) throw new Error(c.error?.message ?? "فشل تجهيز الصورة لإنستغرام");
      const p = await (await fetch(`${GRAPH}/${acc.external_id}/media_publish`, {
        method: "POST", body: new URLSearchParams({ creation_id: c.id, access_token: t.access_token }),
      })).json();
      if (!p.id) throw new Error(p.error?.message ?? "فشل النشر على إنستغرام");
      return p.id;
    }
    case "x": {
      const token = await xToken(acc, t);
      const r = await (await fetch("https://api.x.com/2/tweets", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: post.text.slice(0, 280) }),
      })).json();
      if (!r.data?.id) throw new Error(r.detail ?? r.title ?? "فشل النشر على X");
      return r.data.id;
    }
    default:
      throw new Error("النشر على هذه الشبكة غير مفعّل بعد");
  }
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return new Response("forbidden", { status: 403 });

  // احجز المنشورات المستحقة (التحديث المشروط يمنع نشرها مرتين)
  const { data: due } = await admin.from("posts").select("id")
    .eq("status", "scheduled").lte("scheduled_at", new Date().toISOString()).limit(25);
  let done = 0;
  for (const { id } of due ?? []) {
    const { data: post } = await admin.from("posts").update({ status: "publishing" })
      .eq("id", id).eq("status", "scheduled").select("id,brand_id,text,media_url,networks").maybeSingle();
    if (!post) continue;

    const results: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const net of post.networks as string[]) {
      const { data: accs } = await admin.from("social_accounts").select("id,external_id,network")
        .eq("brand_id", post.brand_id).eq("network", net).eq("status", "connected");
      if (!accs?.length) { errors.push(`${net}: لا يوجد حساب مربوط`); continue; }
      for (const acc of accs) {
        const { data: tok } = await admin.from("social_tokens").select("*").eq("account_id", acc.id).single();
        try {
          results[`${net}:${acc.external_id}`] = { ok: true, id: await publishOne(post, acc, tok) };
        } catch (e) {
          const msg = (e as Error).message;
          results[`${net}:${acc.external_id}`] = { ok: false, error: msg };
          errors.push(`${net}: ${msg}`);
        }
      }
    }
    const anyOk = Object.values(results).some((r) => (r as { ok: boolean }).ok);
    await admin.from("posts").update({
      status: anyOk ? "published" : "failed", results, error: errors.length ? errors.join(" | ") : null,
    }).eq("id", post.id);
    done++;
  }
  return new Response(JSON.stringify({ processed: done }), { headers: { "Content-Type": "application/json" } });
});

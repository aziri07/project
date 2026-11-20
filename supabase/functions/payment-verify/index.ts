// يتحقق من عملية دفع Moyasar ويفعّل اشتراك العميل 30 يومًا.
// السرّ المطلوب: MOYASAR_SECRET_KEY
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "سجّل الدخول أولًا" }, 401);

  const { payment_id } = await req.json().catch(() => ({}));
  if (!payment_id || !/^[\w-]{8,64}$/.test(payment_id)) return json({ error: "رقم عملية غير صالح" }, 400);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // عملية مستخدمة من قبل؟
  const { data: used } = await admin.from("payments").select("id,status").eq("provider_payment_id", payment_id).maybeSingle();
  if (used) return json({ ok: used.status === "paid", already: true });

  // جلب العملية من Moyasar بالمفتاح السري (لا نثق بما يرسله المتصفح)
  const secret = Deno.env.get("MOYASAR_SECRET_KEY")!;
  const r = await fetch(`https://api.moyasar.com/v1/payments/${payment_id}`, {
    headers: { Authorization: "Basic " + btoa(secret + ":") },
  });
  if (!r.ok) return json({ error: "لم يتم العثور على العملية لدى بوابة الدفع" }, 404);
  const pay = await r.json();

  const planId = pay?.metadata?.plan_id;
  if (pay?.metadata?.user_id !== user.id || !planId) return json({ error: "العملية لا تخص حسابك" }, 403);

  const { data: plan } = await admin.from("plans").select("*").eq("id", planId).single();
  if (!plan) return json({ error: "الباقة غير موجودة" }, 404);

  const expected = Math.round(Number(plan.price_monthly) * 100); // Moyasar يحسب بالهللة
  const valid = pay.status === "paid" && pay.amount === expected && pay.currency === plan.currency;

  await admin.from("payments").insert({
    user_id: user.id, plan_id: plan.id, amount: pay.amount / 100, currency: pay.currency,
    status: valid ? "paid" : (pay.status ?? "unknown"), provider_payment_id: payment_id, raw: pay,
  });
  if (!valid) return json({ error: "لم تكتمل عملية الدفع أو المبلغ غير مطابق" }, 402);

  // تمديد الاشتراك 30 يومًا من تاريخ الانتهاء الحالي إن كان ساريًا ولنفس الباقة
  const { data: sub } = await admin.from("subscriptions").select("*").eq("user_id", user.id).maybeSingle();
  const now = Date.now();
  const base = sub?.plan_id === plan.id && sub?.current_period_end && new Date(sub.current_period_end).getTime() > now
    ? new Date(sub.current_period_end).getTime() : now;
  const end = new Date(base + 30 * 864e5).toISOString();

  await admin.from("subscriptions").upsert({
    user_id: user.id, plan_id: plan.id, status: "active", current_period_end: end, updated_at: new Date().toISOString(),
  });
  return json({ ok: true, plan: plan.name, current_period_end: end });
});

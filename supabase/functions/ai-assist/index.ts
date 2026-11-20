// مساعد الكتابة بـ Claude: يكتب المنشورات ويحسّنها ويقترح الهاشتاقات والأفكار.
// السرّ المطلوب: ANTHROPIC_API_KEY
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const NET_RULES: Record<string, string> = {
  x: "إكس: 280 حرفًا كحد أقصى، جملة افتتاحية قوية، هاشتاق أو اثنان فقط.",
  instagram: "إنستغرام: سطر أول جذاب، فقرات قصيرة، دعوة لاتخاذ إجراء، 5-10 هاشتاقات في النهاية.",
  facebook: "فيسبوك: نبرة حوارية، سؤال يشجع التعليقات، هاشتاقات قليلة.",
  tiktok: "تيك توك: وصف قصير جدًا وحيوي مع 3-5 هاشتاقات رائجة.",
  linkedin: "لينكدإن: نبرة مهنية، فكرة أو درس واضح، بلا مبالغة.",
  youtube: "يوتيوب: عنوان جذاب ثم وصف من سطرين.",
};

const TASKS: Record<string, (i: Input) => string> = {
  write: (i) => `اكتب منشورًا جاهزًا للنشر عن: ${i.brief}`,
  improve: (i) => `حسّن هذا المنشور مع الحفاظ على معناه، واجعله أوضح وأكثر جاذبية:\n\n${i.text}`,
  hashtags: (i) => `اقترح هاشتاقات مناسبة (عربية وإنجليزية) لهذا المنشور. أعد الهاشتاقات فقط في سطر واحد:\n\n${i.text || i.brief}`,
  ideas: (i) => `اقترح 5 أفكار منشورات متنوعة عن: ${i.brief}. لكل فكرة سطر واحد يبدأ بشرطة.`,
};

type Input = { task: string; brief?: string; text?: string; networks?: string[]; tone?: string; brand?: string };

const SYSTEM = `أنت كاتب محتوى عربي محترف لوسائل التواصل الاجتماعي داخل منصة "رَصد".
- اكتب بالعربية الفصحى المبسطة إلا إذا طُلبت لهجة.
- أعد نص المنشور النهائي فقط، بلا مقدمات أو شرح أو علامات اقتباس.
- إذا ذُكرت أكثر من شبكة، اكتب نصًا واحدًا يناسبها جميعًا مع احترام أقصر حد.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "الطريقة غير مدعومة" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "سجّل الدخول أولًا" }, 401);

  // الباقة والاستهلاك الشهري
  const { data: usage, error: uErr } = await userClient.rpc("my_usage");
  if (uErr) return json({ error: "تعذّر قراءة الاشتراك" }, 500);
  const { data: profile } = await userClient.from("profiles").select("role").eq("id", user.id).single();
  const isAdmin = profile?.role === "admin";
  const limit = usage?.plan?.ai_requests_month ?? 0;
  if (!isAdmin) {
    if (!usage?.plan) return json({ error: "لا يوجد اشتراك فعّال" }, 402);
    if (usage.ai_month >= limit) return json({ error: `استنفدت طلبات المساعد هذا الشهر (${limit}).` }, 402);
  }

  let input: Input;
  try { input = await req.json(); } catch { return json({ error: "طلب غير صالح" }, 400); }
  const build = TASKS[input.task];
  if (!build) return json({ error: "مهمة غير معروفة" }, 400);
  if (!(input.brief?.trim() || input.text?.trim())) return json({ error: "اكتب فكرة أو نصًا أولًا" }, 400);

  const rules = (input.networks ?? []).map((n) => NET_RULES[n]).filter(Boolean).join("\n");
  const prompt = [
    input.brand ? `العلامة التجارية: ${input.brand}` : "",
    input.tone ? `النبرة المطلوبة: ${input.tone}` : "",
    rules ? `قواعد الشبكات:\n${rules}` : "",
    build(input),
  ].filter(Boolean).join("\n\n");

  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      // deno-lint-ignore no-explicit-any
      fallbacks: "default" as any,
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{ role: "user", content: prompt.slice(0, 8000) }],
    });

    if (response.stop_reason === "refusal") {
      return json({ error: "لم يتمكن المساعد من كتابة هذا المحتوى. جرّب صياغة أخرى." }, 422);
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text).join("\n").trim();

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("ai_usage").insert({
      user_id: user.id, task: input.task,
      input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens,
    });

    return json({ text, remaining: isAdmin ? null : Math.max(0, limit - usage.ai_month - 1) });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "المساعد مشغول، حاول بعد دقيقة." }, 429);
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "مفتاح Claude غير مضبوط في الخادم." }, 500);
    if (e instanceof Anthropic.APIError) return json({ error: `خطأ من Claude (${e.status})` }, 502);
    return json({ error: "تعذّر الاتصال بالمساعد" }, 502);
  }
});

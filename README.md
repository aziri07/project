# رَصد — منصة SaaS لإدارة وجدولة السوشيال ميديا

## مكوّنات النظام

| الجزء | الملف | الوظيفة |
|---|---|---|
| قاعدة البيانات | `supabase/migrations/001_schema.sql` | المستخدمون والأدوار (مدير/عميل)، الباقات، الاشتراكات، المدفوعات، العلامات، الحسابات، المنشورات، حدود كل باقة، وصلاحيات الصفوف |
| الناشر الآلي | `supabase/migrations/002_publish_cron.sql` + `functions/publish-due` | ينشر المنشورات المستحقة كل دقيقة |
| مساعد Claude | `functions/ai-assist` | يكتب المنشورات ويحسّنها ويقترح الهاشتاقات والأفكار، ويحسب الاستهلاك حسب الباقة |
| الدفع | `functions/payment-verify` | يتحقق من عملية Moyasar بالمفتاح السري ثم يفعّل الاشتراك 30 يومًا |
| ربط المنصات | `functions/social-connect` | OAuth لفيسبوك وإنستغرام (عبر Meta) وإكس |
| الواجهة | `web/index.html` | صفحة الدخول والباقات، لوحة العميل، لوحة مدير النظام |

## خطوات التشغيل

### 1) Supabase
1. أنشئ مشروعًا من supabase.com/dashboard (الخطة المجانية تكفي للبداية). المنطقة: Frankfurt.
2. أخبر Claude باسم المشروع، وسيطبّق قاعدة البيانات وينشر الدوال مباشرة. أو نفّذ `001_schema.sql` يدويًا من SQL Editor.
3. من **Authentication → URL Configuration** ضع رابط موقعك في Site URL.

### 2) أسرار الدوال (Edge Function Secrets)
| السر | من أين |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `MOYASAR_SECRET_KEY` | لوحة Moyasar → Settings → API Keys (ابدأ بمفتاح الاختبار `sk_test_`) |
| `APP_URL` | رابط موقعك، مثل `https://rasd.example.com/` |
| `META_APP_ID`, `META_APP_SECRET` | developers.facebook.com → تطبيق من نوع Business |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | developer.x.com → OAuth 2.0، نوع التطبيق Confidential |
| `CRON_SECRET` | أي نص عشوائي طويل (نفس القيمة في `002_publish_cron.sql`) |

رابط العودة (Redirect URI) الذي تضعه في تطبيقي Meta وX:
`https://YOUR-PROJECT.supabase.co/functions/v1/social-connect`

### 3) نشر الدوال
- `ai-assist` و`payment-verify`: مع التحقق من JWT.
- `social-connect` و`publish-due`: **بدون** التحقق من JWT (تتحققان بنفسيهما).

### 4) الواجهة
عدّل `RASD_CONFIG` أعلى `web/index.html` (رابط المشروع، المفتاح العام، مفتاح Moyasar العام `pk_test_`)،
ثم ارفع الملف على أي استضافة ثابتة (Vercel أو Netlify أو Cloudflare Pages أو استضافتك).

### 5) حساب مدير النظام
سجّل في الموقع ببريدك، ثم نفّذ:
```sql
update public.profiles set role = 'admin' where email = 'بريدك@example.com';
```

## قبل الإطلاق للعملاء
- **Meta**: النشر لصفحات العملاء يحتاج مراجعة التطبيق (App Review) لصلاحيات `pages_manage_posts` و`instagram_content_publish`، والتحقق من النشاط التجاري. حتى ذلك الحين يعمل الربط مع الحسابات المضافة كمختبِرين في التطبيق فقط.
- **X**: النشر يحتاج خطة API مدفوعة تسمح بالكتابة حسب حجم الاستخدام.
- **TikTok وLinkedIn وYouTube**: لكل منها برنامج مطوّرين ومراجعة؛ الأزرار ظاهرة في الواجهة بعلامة «قريبًا»، وتُضاف بنفس نمط `social-connect` و`publish-due`.
- **Moyasar**: فعّل الحساب التجاري للانتقال من مفاتيح الاختبار إلى المفاتيح الحية. أضف لاحقًا Webhook لتأكيد المدفوعات حتى لو أغلق العميل الصفحة قبل العودة.
- الاشتراك يتجدد يدويًا كل 30 يومًا. التجديد التلقائي يحتاج حفظ البطاقة (Tokenization) لدى Moyasar، وهو مرحلة لاحقة.
- المدير يستطيع من «العملاء» تفعيل اشتراك يدويًا (تحويل بنكي) أو منح فترة تجريبية أو إيقاف حساب.

-- رَصد: منصة إدارة السوشيال ميديا متعددة العملاء
-- الأدوار: admin (مدير النظام) / client (عميل مشترك)

create extension if not exists pgcrypto;

-- ============ الجداول ============

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'client' check (role in ('admin','client')),
  created_at  timestamptz not null default now()
);

create table public.plans (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  description       text,
  price_monthly     numeric(10,2) not null default 0,
  currency          text not null default 'SAR',
  max_brands        int  not null default 1,
  max_accounts      int  not null default 3,
  max_posts_month   int  not null default 30,
  ai_requests_month int  not null default 20,
  networks          text[] not null default '{facebook,instagram,x}',
  is_active         boolean not null default true,
  sort              int not null default 0,
  created_at        timestamptz not null default now()
);

create table public.subscriptions (
  user_id            uuid primary key references public.profiles(id) on delete cascade,
  plan_id            uuid references public.plans(id),
  status             text not null default 'inactive'
                     check (status in ('trialing','active','past_due','canceled','inactive')),
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);

create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  plan_id             uuid references public.plans(id),
  amount              numeric(10,2) not null,
  currency            text not null,
  status              text not null,
  provider            text not null default 'moyasar',
  provider_payment_id text unique,
  raw                 jsonb,
  created_at          timestamptz not null default now()
);

create table public.brands (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name       text not null,
  color      text not null default '#0B7A75',
  created_at timestamptz not null default now()
);

create table public.social_accounts (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles(id) on delete cascade,
  brand_id     uuid not null references public.brands(id) on delete cascade,
  network      text not null check (network in ('facebook','instagram','x','tiktok','linkedin','youtube')),
  external_id  text not null,
  handle       text,
  followers    int not null default 0,
  status       text not null default 'connected' check (status in ('connected','expired','error')),
  connected_at timestamptz not null default now(),
  unique (brand_id, network, external_id)
);

-- رموز الوصول للمنصات: لا يقرؤها إلا الخادم (service role)
create table public.social_tokens (
  account_id    uuid primary key references public.social_accounts(id) on delete cascade,
  access_token  text not null,
  refresh_token text,
  expires_at    timestamptz
);

create table public.oauth_states (
  state         text primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  brand_id      uuid not null references public.brands(id) on delete cascade,
  network       text not null,
  code_verifier text,
  created_at    timestamptz not null default now()
);

create table public.posts (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  brand_id     uuid not null references public.brands(id) on delete cascade,
  text         text not null,
  media_url    text,
  networks     text[] not null default '{}',
  scheduled_at timestamptz,
  status       text not null default 'draft'
               check (status in ('draft','scheduled','publishing','published','failed')),
  error        text,
  results      jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index posts_due_idx on public.posts (status, scheduled_at);
create index posts_owner_idx on public.posts (owner_id);

create table public.ai_usage (
  id            bigserial primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  task          text,
  input_tokens  int,
  output_tokens int,
  created_at    timestamptz not null default now()
);
create index ai_usage_user_idx on public.ai_usage (user_id, created_at);

-- ============ دوال مساعدة ============

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- الباقة الفعّالة لمستخدم (null إن لم يكن له اشتراك ساري)
create or replace function public.active_plan(uid uuid) returns public.plans
language sql stable security definer set search_path = '' as $$
  select p.* from public.subscriptions s
  join public.plans p on p.id = s.plan_id
  where s.user_id = uid
    and s.status in ('active','trialing')
    and (s.current_period_end is null or s.current_period_end > now());
$$;

-- استهلاك العميل الحالي مقارنة بحدود باقته (تستخدمه لوحة العميل)
create or replace function public.my_usage() returns json
language plpgsql stable security definer set search_path = '' as $$
declare p public.plans; uid uuid := auth.uid();
begin
  p := public.active_plan(uid);
  return json_build_object(
    'plan', case when p.id is null then null else row_to_json(p) end,
    'brands',   (select count(*) from public.brands where owner_id = uid),
    'accounts', (select count(*) from public.social_accounts where owner_id = uid),
    'posts_month', (select count(*) from public.posts where owner_id = uid
                    and status in ('scheduled','publishing','published')
                    and created_at >= date_trunc('month', now())),
    'ai_month', (select count(*) from public.ai_usage where user_id = uid
                 and created_at >= date_trunc('month', now()))
  );
end $$;

-- إحصاءات مدير النظام
create or replace function public.admin_stats() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'غير مصرح'; end if;
  return json_build_object(
    'clients',      (select count(*) from public.profiles where role = 'client'),
    'active_subs',  (select count(*) from public.subscriptions where status in ('active','trialing')
                     and (current_period_end is null or current_period_end > now())),
    'mrr',          (select coalesce(sum(p.price_monthly),0) from public.subscriptions s join public.plans p on p.id = s.plan_id
                     where s.status = 'active' and (s.current_period_end is null or s.current_period_end > now())),
    'revenue_month',(select coalesce(sum(amount),0) from public.payments where status = 'paid'
                     and created_at >= date_trunc('month', now())),
    'posts_month',  (select count(*) from public.posts where created_at >= date_trunc('month', now())),
    'accounts',     (select count(*) from public.social_accounts),
    'ai_month',     (select count(*) from public.ai_usage where created_at >= date_trunc('month', now()))
  );
end $$;

-- ============ مشغّلات (Triggers) ============

-- ملف شخصي تلقائي لكل مستخدم جديد
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
  insert into public.subscriptions (user_id, status) values (new.id, 'inactive');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- منع العميل من ترقية نفسه إلى مدير
create or replace function public.guard_role() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role <> old.role and not public.is_admin() and auth.uid() is not null then
    raise exception 'لا يمكنك تغيير الصلاحية';
  end if;
  return new;
end $$;
create trigger profiles_guard_role before update on public.profiles
  for each row execute function public.guard_role();

-- حدود الباقة: العلامات التجارية
create or replace function public.enforce_brand_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.plans;
begin
  if exists (select 1 from public.profiles where id = new.owner_id and role = 'admin') then return new; end if;
  p := public.active_plan(new.owner_id);
  if p.id is null then raise exception 'لا يوجد اشتراك فعّال. اختر باقة أولًا.'; end if;
  if (select count(*) from public.brands where owner_id = new.owner_id) >= p.max_brands then
    raise exception 'وصلت إلى حد العلامات التجارية في باقتك (%). رقِّ باقتك لإضافة المزيد.', p.max_brands;
  end if;
  return new;
end $$;
create trigger brands_limit before insert on public.brands
  for each row execute function public.enforce_brand_limit();

-- حدود الباقة: الحسابات المربوطة والشبكات المسموحة
create or replace function public.enforce_account_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.plans;
begin
  if exists (select 1 from public.profiles where id = new.owner_id and role = 'admin') then return new; end if;
  p := public.active_plan(new.owner_id);
  if p.id is null then raise exception 'لا يوجد اشتراك فعّال.'; end if;
  if not (new.network = any (p.networks)) then
    raise exception 'شبكة % غير متاحة في باقتك.', new.network;
  end if;
  if (select count(*) from public.social_accounts where owner_id = new.owner_id) >= p.max_accounts then
    raise exception 'وصلت إلى حد الحسابات المربوطة في باقتك (%).', p.max_accounts;
  end if;
  return new;
end $$;
create trigger accounts_limit before insert on public.social_accounts
  for each row execute function public.enforce_account_limit();

-- حدود الباقة: عدد المنشورات المجدولة شهريًا + ملكية العلامة
create or replace function public.enforce_post_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.plans; n int;
begin
  new.updated_at := now();
  -- العميل لا يعدّل منشورًا نُشر أو قيد النشر، ولا يضع حالة النشر بنفسه (الناشر الآلي يعمل بدون auth.uid)
  if auth.uid() is not null and not public.is_admin() then
    if tg_op = 'UPDATE' and old.status in ('publishing','published') then
      raise exception 'لا يمكن تعديل منشور تم نشره';
    end if;
    if new.status not in ('draft','scheduled') then
      raise exception 'حالة غير مسموحة';
    end if;
  end if;
  if not exists (select 1 from public.brands where id = new.brand_id and owner_id = new.owner_id) then
    raise exception 'العلامة التجارية لا تخصك';
  end if;
  if new.status = 'scheduled' and new.scheduled_at is null then
    raise exception 'حدّد موعد النشر';
  end if;
  if new.status = 'scheduled' and (tg_op = 'INSERT' or old.status in ('draft','failed'))
     and not exists (select 1 from public.profiles where id = new.owner_id and role = 'admin') then
    p := public.active_plan(new.owner_id);
    if p.id is null then raise exception 'لا يوجد اشتراك فعّال.'; end if;
    select count(*) into n from public.posts where owner_id = new.owner_id
      and status in ('scheduled','publishing','published') and created_at >= date_trunc('month', now());
    if n >= p.max_posts_month then
      raise exception 'وصلت إلى حد المنشورات الشهري في باقتك (%).', p.max_posts_month;
    end if;
  end if;
  return new;
end $$;
create trigger posts_rules before insert or update on public.posts
  for each row execute function public.enforce_post_rules();

-- ============ صلاحيات الصفوف (RLS) ============

alter table public.profiles        enable row level security;
alter table public.plans           enable row level security;
alter table public.subscriptions   enable row level security;
alter table public.payments        enable row level security;
alter table public.brands          enable row level security;
alter table public.social_accounts enable row level security;
alter table public.social_tokens   enable row level security;
alter table public.oauth_states    enable row level security;
alter table public.posts           enable row level security;
alter table public.ai_usage        enable row level security;

-- الرموز وحالات الربط: لا وصول من المتصفح إطلاقًا
revoke all on public.social_tokens, public.oauth_states from anon, authenticated;

create policy "profiles read"   on public.profiles for select to authenticated using (id = (select auth.uid()) or public.is_admin());
create policy "profiles update" on public.profiles for update to authenticated using (id = (select auth.uid()) or public.is_admin());

create policy "plans read"  on public.plans for select to anon, authenticated using (is_active or public.is_admin());
create policy "plans admin" on public.plans for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "subs read"  on public.subscriptions for select to authenticated using (user_id = (select auth.uid()) or public.is_admin());
create policy "subs admin" on public.subscriptions for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "payments read" on public.payments for select to authenticated using (user_id = (select auth.uid()) or public.is_admin());

create policy "brands own" on public.brands for all to authenticated
  using (owner_id = (select auth.uid()) or public.is_admin())
  with check (owner_id = (select auth.uid()) or public.is_admin());

create policy "accounts read"   on public.social_accounts for select to authenticated using (owner_id = (select auth.uid()) or public.is_admin());
create policy "accounts delete" on public.social_accounts for delete to authenticated using (owner_id = (select auth.uid()) or public.is_admin());

create policy "posts own" on public.posts for all to authenticated
  using (owner_id = (select auth.uid()) or public.is_admin())
  with check (owner_id = (select auth.uid()) or public.is_admin());

create policy "ai read" on public.ai_usage for select to authenticated using (user_id = (select auth.uid()) or public.is_admin());

revoke execute on function public.admin_stats() from anon;
revoke execute on function public.my_usage() from anon;

-- ============ تخزين الصور ============

insert into storage.buckets (id, name, public) values ('media', 'media', true)
  on conflict (id) do nothing;

create policy "media upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "media delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ============ الباقات الافتراضية ============

insert into public.plans (name, description, price_monthly, max_brands, max_accounts, max_posts_month, ai_requests_month, networks, sort) values
 ('الأساسية',   'لأصحاب المشاريع الصغيرة',          49,  1,  3,   30,   20, '{facebook,instagram,x}', 1),
 ('الاحترافية', 'للمسوّقين ومتاجر النمو',            149, 3,  10,  150,  150, '{facebook,instagram,x,tiktok,linkedin,youtube}', 2),
 ('الوكالات',   'للوكالات التي تدير عملاء متعددين', 399, 15, 50,  1000, 1000, '{facebook,instagram,x,tiktok,linkedin,youtube}', 3);

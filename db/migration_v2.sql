-- ============================================================
-- 暑假打卡工具 · v2 多租户迁移脚本
-- 执行方式：在 Supabase SQL Editor 中一次性运行
-- 影响范围：仅 sc_* 表，不动 hs_users
-- 可回滚：本脚本有对应的 rollback_v2.sql
-- ============================================================

BEGIN;

-- ==========================================
-- 1. 创建 sc_tenants（空间表）
-- ==========================================
CREATE TABLE IF NOT EXISTS sc_tenants (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  admin_passcode_hash   text,                          -- 管理员注册口令 hash；NULL = 无口令（如华宇之家）
  admin_passcode_salt   text,                          -- 盐 = 创建日期 YYYY-MM-DD
  created_by            text not null,                 -- 创建者 username（始终是超管）
  created_at            timestamptz default now()
);

-- ==========================================
-- 2. 创建 sc_memberships（绑定关系，替代旧 sc_admins）
-- ==========================================
CREATE TABLE IF NOT EXISTS sc_memberships (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references sc_tenants(id) on delete cascade,
  username    text not null,
  role        text not null default 'member' check (role in ('super_admin','admin','member')),
  status      text not null default 'active' check (status in ('active','pending','rejected')),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  UNIQUE(tenant_id, username)                         -- 同一人在同一空间只有一条记录
);

-- 普通用户全局只能有一个 active 绑定（super_admin 除外）
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_one_active
  ON sc_memberships (username) WHERE status = 'active' AND role != 'super_admin';

CREATE INDEX IF NOT EXISTS idx_memberships_tenant  ON sc_memberships(tenant_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user    ON sc_memberships(username);

-- ==========================================
-- 3. 所有 sc_* 业务表加 tenant_id（先 nullable，回填后改 NOT NULL）
-- ==========================================
ALTER TABLE sc_categories   ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE sc_items        ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE sc_checkins     ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE sc_prizes       ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE sc_redemptions  ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE sc_balances     ADD COLUMN IF NOT EXISTS tenant_id uuid;

-- ==========================================
-- 4. 创建默认空间「华宇之家」
-- ==========================================
INSERT INTO sc_tenants (id, name, admin_passcode_hash, admin_passcode_salt, created_by)
VALUES (
  'a0000000-0000-0000-0000-000000000001',           -- 固定 UUID，方便回填
  '华宇之家',
  NULL,                                               -- 无口令，老用户直接归入
  NULL,
  'qianteng'                                          -- 你的超管账号
);

-- ==========================================
-- 5. 回填所有现有数据的 tenant_id = 华宇之家
-- ==========================================
UPDATE sc_categories   SET tenant_id = 'a0000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE sc_items        SET tenant_id = 'a0000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE sc_checkins     SET tenant_id = 'a0000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE sc_prizes       SET tenant_id = 'a0000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE sc_redemptions  SET tenant_id = 'a0000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE sc_balances     SET tenant_id = 'a0000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;

-- ==========================================
-- 6. tenant_id 改为 NOT NULL
-- ==========================================
ALTER TABLE sc_categories   ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sc_items        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sc_checkins     ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sc_prizes       ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sc_redemptions  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sc_balances     ALTER COLUMN tenant_id SET NOT NULL;

-- ==========================================
-- 7. 迁移旧 sc_admins → sc_memberships
--    + 你的超管账号
--    + 所有现有普通用户
-- ==========================================

-- 7a. 你的超管账号
INSERT INTO sc_memberships (tenant_id, username, role, status)
VALUES ('a0000000-0000-0000-0000-000000000001', 'qianteng', 'super_admin', 'active')
ON CONFLICT (tenant_id, username) DO NOTHING;

-- 7b. 旧管理员 → 华宇之家 admin
INSERT INTO sc_memberships (tenant_id, username, role, status)
SELECT 'a0000000-0000-0000-0000-000000000001', username, 'admin', 'active'
FROM sc_admins
WHERE username != 'qianteng'                          -- 避免与超管冲突
ON CONFLICT (tenant_id, username) DO NOTHING;

-- 7c. 所有 hs_users 中不在 sc_admins 的 → 华宇之家 member
INSERT INTO sc_memberships (tenant_id, username, role, status)
SELECT 'a0000000-0000-0000-0000-000000000001', hu.username, 'member', 'active'
FROM hs_users hu
WHERE NOT EXISTS (SELECT 1 FROM sc_memberships m WHERE m.username = hu.username)
ON CONFLICT (tenant_id, username) DO NOTHING;

-- ==========================================
-- 8. 重建约束和索引
-- ==========================================

-- sc_balances 主键改为 (tenant_id, username)
ALTER TABLE sc_balances DROP CONSTRAINT IF EXISTS sc_balances_pkey;
ALTER TABLE sc_balances ADD PRIMARY KEY (tenant_id, username);

-- sc_checkins 加 tenant_id 索引
CREATE INDEX IF NOT EXISTS idx_sc_checkins_tenant ON sc_checkins(tenant_id);

-- sc_redemptions 加 tenant_id 索引
CREATE INDEX IF NOT EXISTS idx_sc_redemptions_tenant ON sc_redemptions(tenant_id);

-- sc_categories / sc_items / sc_prizes 加 tenant_id 索引
CREATE INDEX IF NOT EXISTS idx_sc_categories_tenant  ON sc_categories(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sc_items_tenant       ON sc_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sc_prizes_tenant      ON sc_prizes(tenant_id);

-- ==========================================
-- 9. 为 sc_checkins 增加 checkin_at 列（如果缺失）
--    旧 schema.sql 没有此列，但旧 RPC 用到了
-- ==========================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='sc_checkins' AND column_name='checkin_at') THEN
    ALTER TABLE sc_checkins ADD COLUMN checkin_at timestamptz default now();
  END IF;
END $$;

-- sc_redemptions 的 redeemed_at（旧 schema 有 created_at，但旧 RPC 用 redeemed_at）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='sc_redemptions' AND column_name='redeemed_at') THEN
    ALTER TABLE sc_redemptions ADD COLUMN redeemed_at timestamptz default now();
  END IF;
END $$;

-- ==========================================
-- 10. RLS 策略（tenant 隔离）
-- ==========================================
ALTER TABLE sc_tenants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sc_memberships ENABLE ROW LEVEL SECURITY;

-- sc_tenants：公开读（供未绑定用户浏览可选空间）
DROP POLICY IF EXISTS "public read tenants" ON sc_tenants;
CREATE POLICY "public read tenants" ON sc_tenants FOR SELECT USING (true);

-- sc_memberships：只读自己的
DROP POLICY IF EXISTS "read own memberships" ON sc_memberships;
CREATE POLICY "read own memberships" ON sc_memberships FOR SELECT
  USING (username = current_setting('request.jwt.claims', true)::json->>'sub'
         OR username = 'qianteng');  -- 超管可读全部

COMMIT;

-- ==========================================
-- 迁移完成检查
-- ==========================================
SELECT 'sc_tenants' AS tbl, count(*) AS rows FROM sc_tenants
UNION ALL
SELECT 'sc_memberships', count(*)::text FROM sc_memberships
UNION ALL
SELECT 'sc_categories', count(*)::text FROM sc_categories WHERE tenant_id IS NOT NULL
UNION ALL
SELECT 'sc_checkins', count(*)::text FROM sc_checkins WHERE tenant_id IS NOT NULL;

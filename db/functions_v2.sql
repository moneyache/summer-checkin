-- ============================================================
-- 暑假打卡工具 · v2 多租户 RPC 函数
-- 部署方式：在 Supabase SQL Editor 中运行完整脚本
-- 前提：migration_v2.sql 已执行完毕
-- ============================================================

-- ==========================================
-- 0. 基础权限函数
-- ==========================================

-- 是否为超管
CREATE OR REPLACE FUNCTION sc_is_super_admin(p_username text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS(
    SELECT 1 FROM sc_memberships
    WHERE username = p_username AND status = 'active' AND role = 'super_admin'
  );
$$;

-- 是否为某空间的管理员（含 super_admin）
CREATE OR REPLACE FUNCTION sc_is_tenant_admin(p_tenant_id uuid, p_username text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS(
    SELECT 1 FROM sc_memberships
    WHERE tenant_id = p_tenant_id
      AND username = p_username
      AND status = 'active'
      AND role IN ('super_admin', 'admin')
  );
$$;

-- 保留旧函数兼容（过渡期），指向新的租户管理员检查
CREATE OR REPLACE FUNCTION sc_is_admin(p_username text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS(
    SELECT 1 FROM sc_memberships
    WHERE username = p_username AND status = 'active' AND role IN ('super_admin', 'admin')
  );
$$;

-- ==========================================
-- 1. 空间管理
-- ==========================================

-- 1a. 超管创建空间
CREATE OR REPLACE FUNCTION sc_create_tenant(
  p_username text,
  p_name text,
  p_admin_passcode text
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tenant_id uuid;
  v_salt text;
  v_hash text;
BEGIN
  IF NOT sc_is_super_admin(p_username) THEN
    RETURN json_build_object('ok', false, 'error', '仅超级管理员可创建空间');
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RETURN json_build_object('ok', false, 'error', '空间名称不能为空');
  END IF;
  IF p_admin_passcode IS NULL OR length(p_admin_passcode) < 3 THEN
    RETURN json_build_object('ok', false, 'error', '管理员口令至少3位');
  END IF;

  v_tenant_id := gen_random_uuid();
  v_salt := to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD');
  v_hash := md5(p_admin_passcode || '_' || v_salt);

  INSERT INTO sc_tenants (id, name, admin_passcode_hash, admin_passcode_salt, created_by)
  VALUES (v_tenant_id, p_name, v_hash, v_salt, p_username);

  -- 超管自动加入
  INSERT INTO sc_memberships (tenant_id, username, role, status)
  VALUES (v_tenant_id, p_username, 'super_admin', 'active')
  ON CONFLICT (tenant_id, username) DO NOTHING;

  RETURN json_build_object('ok', true, 'tenant_id', v_tenant_id, 'name', p_name);
END;
$$;

-- 1b. 注册/绑定：凭口令成为空间管理员
CREATE OR REPLACE FUNCTION sc_bind_with_passcode(
  p_username text,
  p_passcode text
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tenant record;
  v_hash text;
BEGIN
  -- 检查是否已有 active 绑定（普通用户只能绑一个空间）
  IF EXISTS (
    SELECT 1 FROM sc_memberships
    WHERE username = p_username AND status = 'active' AND role != 'super_admin'
  ) THEN
    RETURN json_build_object('ok', false, 'error', '你已绑定到其他空间，如需更换请先退出当前空间');
  END IF;

  -- 遍历所有有口令的空间
  FOR v_tenant IN
    SELECT * FROM sc_tenants WHERE admin_passcode_hash IS NOT NULL
  LOOP
    v_hash := md5(p_passcode || '_' || v_tenant.admin_passcode_salt);
    IF v_hash = v_tenant.admin_passcode_hash THEN
      -- 口令匹配，绑定为管理员
      INSERT INTO sc_memberships (tenant_id, username, role, status)
      VALUES (v_tenant.id, p_username, 'admin', 'active')
      ON CONFLICT (tenant_id, username)
      DO UPDATE SET role = 'admin', status = 'active', updated_at = now();

      RETURN json_build_object(
        'ok', true,
        'tenant_id', v_tenant.id,
        'tenant_name', v_tenant.name,
        'role', 'admin'
      );
    END IF;
  END LOOP;

  RETURN json_build_object('ok', false, 'error', '口令无效，未匹配到任何空间');
END;
$$;

-- 1c. 列出所有空间（供未绑定用户选择）
CREATE OR REPLACE FUNCTION sc_list_tenants()
RETURNS TABLE(
  id uuid,
  name text,
  member_count bigint,
  created_at timestamptz
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT
    t.id,
    t.name,
    (SELECT count(*) FROM sc_memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS member_count,
    t.created_at
  FROM sc_tenants t
  ORDER BY t.created_at;
$$;

-- 1d. 查询用户的活跃空间（登录分流用）
CREATE OR REPLACE FUNCTION sc_my_tenants(p_username text)
RETURNS TABLE(
  tenant_id uuid,
  tenant_name text,
  role text
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT m.tenant_id, t.name, m.role
  FROM sc_memberships m
  JOIN sc_tenants t ON t.id = m.tenant_id
  WHERE m.username = p_username AND m.status = 'active'
  ORDER BY
    CASE m.role
      WHEN 'super_admin' THEN 0
      WHEN 'admin' THEN 1
      ELSE 2
    END,
    m.created_at;
$$;

-- 1e. 超管切换空间
CREATE OR REPLACE FUNCTION sc_switch_tenant(
  p_username text,
  p_tenant_id uuid
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tenant sc_tenants;
  v_membership sc_memberships;
BEGIN
  SELECT * INTO v_membership FROM sc_memberships
  WHERE tenant_id = p_tenant_id AND username = p_username AND status = 'active';

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', '无权限访问该空间');
  END IF;

  SELECT * INTO v_tenant FROM sc_tenants WHERE id = p_tenant_id;

  RETURN json_build_object(
    'ok', true,
    'tenant_id', v_tenant.id,
    'tenant_name', v_tenant.name,
    'role', v_membership.role
  );
END;
$$;

-- ==========================================
-- 2. 申请与审批
-- ==========================================

-- 2a. 申请加入空间
CREATE OR REPLACE FUNCTION sc_apply_join(
  p_username text,
  p_tenant_id uuid
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- 检查是否已有 active 绑定
  IF EXISTS (
    SELECT 1 FROM sc_memberships
    WHERE username = p_username AND status = 'active' AND role != 'super_admin'
  ) THEN
    RETURN json_build_object('ok', false, 'error', '你已绑定到其他空间');
  END IF;

  -- 检查是否已有待审批申请
  IF EXISTS (
    SELECT 1 FROM sc_memberships
    WHERE username = p_username AND tenant_id = p_tenant_id AND status = 'pending'
  ) THEN
    RETURN json_build_object('ok', false, 'error', '你已提交过申请，请等待审批');
  END IF;

  INSERT INTO sc_memberships (tenant_id, username, role, status)
  VALUES (p_tenant_id, p_username, 'member', 'pending')
  ON CONFLICT (tenant_id, username)
  DO UPDATE SET status = 'pending', role = 'member', updated_at = now();

  RETURN json_build_object('ok', true, 'message', '申请已提交，等待管理员审批');
END;
$$;

-- 2b. 管理员查看待审批列表
CREATE OR REPLACE FUNCTION sc_list_applications(
  p_tenant_id uuid,
  p_username text
) RETURNS TABLE(
  username text,
  created_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT sc_is_tenant_admin(p_tenant_id, p_username) THEN
    RAISE EXCEPTION '无权限';
  END IF;
  RETURN QUERY
    SELECT m.username, m.created_at
    FROM sc_memberships m
    WHERE m.tenant_id = p_tenant_id AND m.status = 'pending'
    ORDER BY m.created_at;
END;
$$;

-- 2c. 审批通过
CREATE OR REPLACE FUNCTION sc_approve_application(
  p_tenant_id uuid,
  p_admin_username text,
  p_applicant_username text
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT sc_is_tenant_admin(p_tenant_id, p_admin_username) THEN
    RETURN json_build_object('ok', false, 'error', '无权限');
  END IF;

  -- 检查申请人是否已在其他空间有 active 绑定
  IF EXISTS (
    SELECT 1 FROM sc_memberships
    WHERE username = p_applicant_username AND status = 'active'
      AND tenant_id != p_tenant_id AND role != 'super_admin'
  ) THEN
    RETURN json_build_object('ok', false, 'error', '该用户已绑定到其他空间');
  END IF;

  UPDATE sc_memberships
  SET status = 'active', updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND username = p_applicant_username
    AND status = 'pending';

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', '未找到待审批的申请');
  END IF;

  RETURN json_build_object('ok', true, 'message', '已通过');
END;
$$;

-- 2d. 拒绝申请
CREATE OR REPLACE FUNCTION sc_reject_application(
  p_tenant_id uuid,
  p_admin_username text,
  p_applicant_username text
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT sc_is_tenant_admin(p_tenant_id, p_admin_username) THEN
    RETURN json_build_object('ok', false, 'error', '无权限');
  END IF;

  UPDATE sc_memberships
  SET status = 'rejected', updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND username = p_applicant_username
    AND status = 'pending';

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', '未找到待审批的申请');
  END IF;

  RETURN json_build_object('ok', true, 'message', '已拒绝');
END;
$$;

-- 2e. 管理员移除成员（删绑定 + 清打卡记录）
CREATE OR REPLACE FUNCTION sc_remove_member(
  p_tenant_id uuid,
  p_admin_username text,
  p_member_username text
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count int;
BEGIN
  IF NOT sc_is_tenant_admin(p_tenant_id, p_admin_username) THEN
    RETURN json_build_object('ok', false, 'error', '无权限');
  END IF;

  -- 不能移除超管
  IF EXISTS (
    SELECT 1 FROM sc_memberships
    WHERE tenant_id = p_tenant_id AND username = p_member_username AND role = 'super_admin'
  ) THEN
    RETURN json_build_object('ok', false, 'error', '不能移除超级管理员');
  END IF;

  -- 删除打卡记录
  DELETE FROM sc_checkins WHERE tenant_id = p_tenant_id AND username = p_member_username;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- 删除兑换记录
  DELETE FROM sc_redemptions WHERE tenant_id = p_tenant_id AND username = p_member_username;

  -- 删除积分余额
  DELETE FROM sc_balances WHERE tenant_id = p_tenant_id AND username = p_member_username;

  -- 删除绑定关系
  DELETE FROM sc_memberships WHERE tenant_id = p_tenant_id AND username = p_member_username;

  RETURN json_build_object(
    'ok', true,
    'message', '已移除',
    'deleted_checkins', v_count
  );
END;
$$;

-- ==========================================
-- 3. 打卡（改造：加 tenant_id）
-- ==========================================
DROP FUNCTION IF EXISTS sc_do_checkin(text,uuid,uuid,text,int,date);
CREATE OR REPLACE FUNCTION sc_do_checkin(
  p_tenant_id uuid,
  p_username text,
  p_category_id uuid,
  p_item_id uuid,
  p_custom_text text,
  p_points int,
  p_checkin_date date default NULL
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_date date;
  v_key  text;
  v_rowcount int;
  v_existing sc_checkins;
BEGIN
  v_date := COALESCE(p_checkin_date, (current_timestamp AT TIME ZONE 'Asia/Shanghai')::date);
  v_key := md5(p_tenant_id::text || '|' || p_username || '|' || v_date || '|' ||
               coalesce(p_category_id::text,'') || '|' || coalesce(p_item_id::text,'') || '|' ||
               coalesce(p_custom_text,''));

  INSERT INTO sc_checkins (tenant_id, username, category_id, item_id, custom_text, points, checkin_date, idem_key, checkin_at)
  VALUES (p_tenant_id, p_username, p_category_id, p_item_id, nullif(p_custom_text,''), p_points, v_date, v_key, current_timestamp)
  ON CONFLICT (idem_key) DO NOTHING;

  GET DIAGNOSTICS v_rowcount = ROW_COUNT;

  IF v_rowcount > 0 THEN
    INSERT INTO sc_balances (tenant_id, username, points)
    VALUES (p_tenant_id, p_username, p_points)
    ON CONFLICT (tenant_id, username)
    DO UPDATE SET points = sc_balances.points + p_points, updated_at = now();

    RETURN json_build_object(
      'is_new', true,
      'earned', p_points,
      'balance', (SELECT points FROM sc_balances WHERE tenant_id = p_tenant_id AND username = p_username)
    );
  ELSE
    SELECT * INTO v_existing FROM sc_checkins WHERE idem_key = v_key;
    RETURN json_build_object(
      'is_new', false,
      'earned', 0,
      'balance', (SELECT points FROM sc_balances WHERE tenant_id = p_tenant_id AND username = p_username),
      'existing_points', coalesce(v_existing.points, 0)
    );
  END IF;
END;
$$;

-- ==========================================
-- 4. 兑换（改造：加 tenant_id）
-- ==========================================
DROP FUNCTION IF EXISTS sc_redeem(text,uuid,text);
CREATE OR REPLACE FUNCTION sc_redeem(
  p_tenant_id uuid,
  p_username text,
  p_prize_id uuid,
  p_idem_key text
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_prize sc_prizes;
  v_balance int;
  v_rowcount int;
  v_existing sc_redemptions;
BEGIN
  SELECT * INTO v_existing FROM sc_redemptions WHERE idem_key = p_idem_key;
  IF FOUND THEN
    RETURN json_build_object(
      'ok', true, 'duplicate', true,
      'balance', (SELECT points FROM sc_balances WHERE tenant_id = p_tenant_id AND username = p_username),
      'prize_name', v_existing.prize_name, 'cost', v_existing.cost
    );
  END IF;

  SELECT * INTO v_prize FROM sc_prizes WHERE id = p_prize_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', '奖品不存在');
  END IF;

  SELECT coalesce(points,0) INTO v_balance
  FROM sc_balances WHERE tenant_id = p_tenant_id AND username = p_username;

  IF v_balance < v_prize.cost THEN
    RETURN json_build_object('ok', false, 'error', '积分不足');
  END IF;

  IF v_prize.stock IS NOT NULL AND v_prize.stock <= 0 THEN
    RETURN json_build_object('ok', false, 'error', '该奖品已兑换完');
  END IF;

  INSERT INTO sc_redemptions (tenant_id, username, prize_id, prize_name, cost, idem_key, redeemed_at)
  VALUES (p_tenant_id, p_username, p_prize_id, v_prize.name, v_prize.cost, p_idem_key, current_timestamp)
  ON CONFLICT (idem_key) DO NOTHING;

  GET DIAGNOSTICS v_rowcount = ROW_COUNT;

  IF v_rowcount = 0 THEN
    SELECT * INTO v_existing FROM sc_redemptions WHERE idem_key = p_idem_key;
    RETURN json_build_object(
      'ok', true, 'duplicate', true,
      'balance', v_balance,
      'prize_name', v_existing.prize_name, 'cost', v_existing.cost
    );
  END IF;

  UPDATE sc_balances
  SET points = points - v_prize.cost, updated_at = now()
  WHERE tenant_id = p_tenant_id AND username = p_username;

  IF v_prize.stock IS NOT NULL THEN
    UPDATE sc_prizes SET stock = stock - 1 WHERE id = p_prize_id;
  END IF;

  RETURN json_build_object(
    'ok', true, 'duplicate', false,
    'balance', (SELECT points FROM sc_balances WHERE tenant_id = p_tenant_id AND username = p_username),
    'prize_name', v_prize.name, 'cost', v_prize.cost
  );
END;
$$;

-- ==========================================
-- 5. 查询函数（改造：加 tenant_id）
-- ==========================================

-- 查余额
DROP FUNCTION IF EXISTS sc_get_balance(text);
CREATE OR REPLACE FUNCTION sc_get_balance(p_tenant_id uuid, p_username text)
RETURNS int LANGUAGE sql SECURITY DEFINER AS $$
  SELECT coalesce((
    SELECT points FROM sc_balances
    WHERE tenant_id = p_tenant_id AND username = p_username
  ), 0);
$$;

-- 我的打卡记录
DROP FUNCTION IF EXISTS sc_my_checkins(text);
CREATE OR REPLACE FUNCTION sc_my_checkins(p_tenant_id uuid, p_username text)
RETURNS TABLE(
  username text, category_id uuid, item_id uuid,
  custom_text text, points int, checkin_date date, checkin_at_sh text
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT c.username, c.category_id, c.item_id, c.custom_text, c.points, c.checkin_date,
         to_char(c.checkin_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
  FROM sc_checkins c
  WHERE c.tenant_id = p_tenant_id AND c.username = p_username
  ORDER BY c.checkin_at DESC NULLS LAST;
$$;

-- 我的兑换记录
DROP FUNCTION IF EXISTS sc_my_redemptions(text);
CREATE OR REPLACE FUNCTION sc_my_redemptions(p_tenant_id uuid, p_username text)
RETURNS TABLE(
  username text, prize_id uuid, prize_name text, cost int, redeemed_at_sh text
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT r.username, r.prize_id, r.prize_name, r.cost,
         to_char(r.redeemed_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
  FROM sc_redemptions r
  WHERE r.tenant_id = p_tenant_id AND r.username = p_username
  ORDER BY r.redeemed_at DESC NULLS LAST;
$$;

-- ==========================================
-- 6. 管理员总览（改造：按租户范围）
-- ==========================================
DROP FUNCTION IF EXISTS sc_admin_overview(text);
CREATE OR REPLACE FUNCTION sc_admin_overview(p_tenant_id uuid, p_username text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  result json;
BEGIN
  IF NOT sc_is_tenant_admin(p_tenant_id, p_username) THEN
    RETURN json_build_object('ok', false, 'error', '无权限');
  END IF;

  SELECT json_build_object(
    'users', coalesce((
      SELECT json_agg(u) FROM (
        SELECT
          m.username,
          coalesce(b.points, 0) as balance,
          coalesce((
            SELECT sum(c.points) FROM sc_checkins c
            WHERE c.tenant_id = p_tenant_id AND c.username = m.username
          ), 0) as earned,
          coalesce((
            SELECT sum(r.cost) FROM sc_redemptions r
            WHERE r.tenant_id = p_tenant_id AND r.username = m.username
          ), 0) as spent,
          (SELECT count(*) FROM sc_checkins c
           WHERE c.tenant_id = p_tenant_id AND c.username = m.username) as checkins
        FROM sc_memberships m
        LEFT JOIN sc_balances b ON b.tenant_id = p_tenant_id AND b.username = m.username
        WHERE m.tenant_id = p_tenant_id AND m.status = 'active' AND m.role = 'member'
      ) u
    ), '[]'::json),
    'checkins', coalesce((
      SELECT json_agg(row_to_json(c)) FROM (
        SELECT username, category_id, item_id, custom_text, points, checkin_date,
               to_char(checkin_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS checkin_at_sh
        FROM sc_checkins
        WHERE tenant_id = p_tenant_id
        ORDER BY checkin_at DESC NULLS LAST
      ) c
    ), '[]'::json),
    'redemptions', coalesce((
      SELECT json_agg(row_to_json(r)) FROM (
        SELECT username, prize_id, prize_name, cost,
               to_char(redeemed_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS redeemed_at_sh
        FROM sc_redemptions
        WHERE tenant_id = p_tenant_id
        ORDER BY redeemed_at DESC NULLS LAST
      ) r
    ), '[]'::json)
  ) INTO result;

  RETURN json_build_object('ok', true, 'data', result);
END;
$$;

-- ==========================================
-- 7. 配置管理（改造：加 tenant_id）
-- ==========================================

-- 大类
DROP FUNCTION IF EXISTS sc_upsert_category(text,uuid,text,boolean);
CREATE OR REPLACE FUNCTION sc_upsert_category(
  p_tenant_id uuid, p_username text,
  p_id uuid, p_name text, p_allow_custom boolean
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT sc_is_tenant_admin(p_tenant_id, p_username) THEN
    RETURN json_build_object('ok', false, 'error', '无权限');
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO sc_categories (tenant_id, name, allow_custom, created_by)
    VALUES (p_tenant_id, p_name, p_allow_custom, p_username)
    RETURNING id INTO v_id;
    RETURN json_build_object('ok', true, 'id', v_id, 'action', 'insert');
  ELSE
    UPDATE sc_categories SET name = p_name, allow_custom = p_allow_custom
    WHERE id = p_id AND tenant_id = p_tenant_id;
    v_id := p_id;
    RETURN json_build_object('ok', true, 'id', v_id, 'action', 'update');
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS sc_delete_category(text,uuid);
CREATE OR REPLACE FUNCTION sc_delete_category(p_tenant_id uuid, p_username text, p_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT sc_is_tenant_admin(p_tenant_id, p_username) THEN
    RETURN json_build_object('ok', false, 'error', '无权限');
  END IF;
  DELETE FROM sc_categories WHERE id = p_id AND tenant_id = p_tenant_id;
  RETURN json_build_object('ok', true);
END;
$$;

-- 细项
DROP FUNCTION IF EXISTS sc_upsert_item(text,uuid,uuid,text,int);
CREATE OR REPLACE FUNCTION sc_upsert_item(
  p_tenant_id uuid, p_username text,
  p_category_id uuid, p_id uuid, p_name text, p_points int
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT sc_is_tenant_admin(p_tenant_id, p_username) THEN
    RETURN json_build_object('ok', false, 'error', '无权限');
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO sc_items (tenant_id, category_id, name, points)
    VALUES (p_tenant_id, p_category_id, p_name, p_points)
    RETURNING id INTO v_id;
    RETURN json_build_object('ok', true, 'id', v_id, 'action', 'insert');
  ELSE
    UPDATE sc_items SET name = p_name, points = p_points, category_id = p_category_id
    WHERE id = p_id AND tenant_id = p_tenant_id;
    v_id := p_id;
    RETURN json_build_object('ok', true, 'id', v_id, 'action', 'update');
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS sc_delete_item(text,uuid);
CREATE OR REPLACE FUNCTION sc_delete_item(p_tenant_id uuid, p_username text, p_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT sc_is_tenant_admin(p_tenant_id, p_username) THEN
    RETURN json_build_object('ok', false, 'error', '无权限');
  END IF;
  DELETE FROM sc_items WHERE id = p_id AND tenant_id = p_tenant_id;
  RETURN json_build_object('ok', true);
END;
$$;

-- 奖品
DROP FUNCTION IF EXISTS sc_upsert_prize(text,uuid,text,text,int,text,int);
CREATE OR REPLACE FUNCTION sc_upsert_prize(
  p_tenant_id uuid, p_username text,
  p_id uuid, p_name text, p_description text, p_cost int, p_emoji text, p_stock int
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT sc_is_tenant_admin(p_tenant_id, p_username) THEN
    RETURN json_build_object('ok', false, 'error', '无权限');
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO sc_prizes (tenant_id, name, description, cost, emoji, stock, created_by)
    VALUES (p_tenant_id, p_name, p_description, p_cost, p_emoji, p_stock, p_username)
    RETURNING id INTO v_id;
    RETURN json_build_object('ok', true, 'id', v_id, 'action', 'insert');
  ELSE
    UPDATE sc_prizes
    SET name = p_name, description = p_description, cost = p_cost,
        emoji = p_emoji, stock = p_stock
    WHERE id = p_id AND tenant_id = p_tenant_id;
    v_id := p_id;
    RETURN json_build_object('ok', true, 'id', v_id, 'action', 'update');
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS sc_delete_prize(text,uuid);
CREATE OR REPLACE FUNCTION sc_delete_prize(p_tenant_id uuid, p_username text, p_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT sc_is_tenant_admin(p_tenant_id, p_username) THEN
    RETURN json_build_object('ok', false, 'error', '无权限');
  END IF;
  DELETE FROM sc_prizes WHERE id = p_id AND tenant_id = p_tenant_id;
  RETURN json_build_object('ok', true);
END;
$$;

-- ==========================================
-- 8. 授权
-- ==========================================
GRANT EXECUTE ON FUNCTION sc_is_super_admin(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_is_tenant_admin(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_is_admin(text) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION sc_create_tenant(text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_bind_with_passcode(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_list_tenants() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_my_tenants(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_switch_tenant(text, uuid) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION sc_apply_join(text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_list_applications(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_approve_application(uuid, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_reject_application(uuid, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_remove_member(uuid, text, text) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION sc_do_checkin(uuid, text, uuid, uuid, text, int, date) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_redeem(uuid, text, uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_get_balance(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_my_checkins(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_my_redemptions(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_admin_overview(uuid, text) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION sc_upsert_category(uuid, text, uuid, text, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_delete_category(uuid, text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_upsert_item(uuid, text, uuid, uuid, text, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_delete_item(uuid, text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_upsert_prize(uuid, text, uuid, text, text, int, text, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_delete_prize(uuid, text, uuid) TO anon, authenticated;

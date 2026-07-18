-- ============================================================
-- 暑假打卡工具 · 超管后台 RPC
-- 部署：python3 .build/run_sql.py db/functions_admin.sql
-- ============================================================

-- 超管：列出所有用户及其空间绑定关系
CREATE OR REPLACE FUNCTION sc_admin_all_users(p_username text)
RETURNS TABLE(
  username text,
  tenant_id uuid,
  tenant_name text,
  role text,
  status text,
  created_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT sc_is_super_admin(p_username) THEN
    RAISE EXCEPTION '仅超级管理员可访问';
  END IF;
  RETURN QUERY
    SELECT
      hu.username,
      m.tenant_id,
      t.name AS tenant_name,
      m.role,
      m.status,
      hu.created_at
    FROM hs_users hu
    LEFT JOIN sc_memberships m ON m.username = hu.username
    LEFT JOIN sc_tenants t ON t.id = m.tenant_id
    ORDER BY hu.created_at DESC;
END;
$$;

-- 超管：删除空间（级联删除所有数据）
CREATE OR REPLACE FUNCTION sc_admin_delete_tenant(
  p_username text,
  p_tenant_id uuid
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_name text;
BEGIN
  IF NOT sc_is_super_admin(p_username) THEN
    RETURN json_build_object('ok', false, 'error', '仅超级管理员可操作');
  END IF;

  SELECT name INTO v_name FROM sc_tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', '空间不存在');
  END IF;

  -- 级联删除：sc_tenants 表有 ON DELETE CASCADE，所以删主表即可
  DELETE FROM sc_tenants WHERE id = p_tenant_id;

  RETURN json_build_object('ok', true, 'deleted', v_name);
END;
$$;

-- 超管：修改成员角色
CREATE OR REPLACE FUNCTION sc_admin_set_role(
  p_username text,
  p_tenant_id uuid,
  p_member_username text,
  p_new_role text
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT sc_is_super_admin(p_username) THEN
    RETURN json_build_object('ok', false, 'error', '仅超级管理员可操作');
  END IF;

  IF p_new_role NOT IN ('admin', 'member') THEN
    RETURN json_build_object('ok', false, 'error', '角色只能是 admin 或 member');
  END IF;

  -- 不能改自己的角色
  IF p_member_username = p_username THEN
    RETURN json_build_object('ok', false, 'error', '不能修改自己的角色');
  END IF;

  UPDATE sc_memberships
  SET role = p_new_role, updated_at = now()
  WHERE tenant_id = p_tenant_id AND username = p_member_username AND role != 'super_admin';

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', '未找到该成员或该成员为超管');
  END IF;

  RETURN json_build_object('ok', true, 'message', '角色已更新为 ' || p_new_role);
END;
$$;

-- 超管：强制将用户绑定到某空间（绕过审批）
CREATE OR REPLACE FUNCTION sc_admin_bind_user(
  p_username text,
  p_tenant_id uuid,
  p_member_username text,
  p_role text DEFAULT 'member'
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT sc_is_super_admin(p_username) THEN
    RETURN json_build_object('ok', false, 'error', '仅超级管理员可操作');
  END IF;

  -- 先移除该用户的现有 active 绑定（非超管）
  DELETE FROM sc_memberships
  WHERE username = p_member_username AND status = 'active' AND role != 'super_admin';

  -- 插入新绑定
  INSERT INTO sc_memberships (tenant_id, username, role, status)
  VALUES (p_tenant_id, p_member_username, p_role, 'active')
  ON CONFLICT (tenant_id, username)
  DO UPDATE SET role = p_role, status = 'active', updated_at = now();

  RETURN json_build_object('ok', true, 'message', '已绑定');
END;
$$;

GRANT EXECUTE ON FUNCTION sc_admin_all_users(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_admin_delete_tenant(text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_admin_set_role(text, uuid, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sc_admin_bind_user(text, uuid, text, text) TO anon, authenticated;

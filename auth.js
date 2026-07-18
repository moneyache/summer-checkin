/**
 * 暑假打卡工具 · 用户认证模块（v2 多租户）
 *
 * 复用「上下五千年」历史学习站的 Supabase 项目与 hs_users 表，
 * 因此两个站点的账号密码完全通用。
 *
 * 密码安全策略（与历史站一致）：
 *   salt = 用户创建日期的日期部分（YYYY-MM-DD）
 *   password_hash = MD5(密码 + "_" + salt)
 *   cookie token = MD5(用户名 + password_hash + 固定密钥)
 *
 * 多租户（v2）：
 *   - 注册时如输入空间管理员口令 → 绑定为该空间 admin
 *   - 注册时无口令 → 未绑定，需选择空间申请加入
 *   - 登录后查 sc_my_tenants 确定路由
 *   - Cookie sc_last_tenant 记忆上次空间
 *   - 超管可在页面顶部切换空间
 */

// ==========================================
// Supabase 配置（与历史站相同项目，账号通用）
// ==========================================
const SUPABASE_URL = 'https://sucecjwfpslxnisvyetq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1Y2VjandmcHNseG5pc3Z5ZXRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1Mjk2ODcsImV4cCI6MjA5NzEwNTY4N30.sF6wjjDLkzY7kNg_etNhqYjvdtEwdr3TAGkdVnjl3QE';
const TABLE_USERS = 'hs_users';
const COOKIE_SECRET = 'sc-secret-summer-checkin-2026';
const CK_USER = 'sc_user';
const CK_TOKEN = 'sc_token';
const CK_LAST_TENANT = 'sc_last_tenant';

// ==========================================
// Cookie 工具
// ==========================================
function setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + (days * 86400000));
  document.cookie = name + '=' + encodeURIComponent(value) + ';path=/;expires=' + d.toUTCString() + ';SameSite=Lax';
}
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}
function deleteCookie(name) {
  document.cookie = name + '=;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT;SameSite=Lax';
}

// ==========================================
// MD5（使用 crypto-js）
// ==========================================
function md5(str) {
  return CryptoJS.MD5(str).toString();
}
function hashPassword(password, dateSalt) {
  return md5(password + '_' + dateSalt);
}
function extractDateSalt(createdAt) {
  return createdAt ? createdAt.substring(0, 10) : '';
}
function computeToken(username, passwordHash) {
  return md5(username + '_' + passwordHash + '_' + COOKIE_SECRET);
}

// ==========================================
// Supabase 客户端
// ==========================================
let _sbClient = null;
function getSupabase() {
  if (!_sbClient) {
    _sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _sbClient;
}

// ==========================================
// 注册
// ==========================================
async function registerUser(username, password, passcode) {
  if (!username || !password) {
    return { success: false, error: '用户名和密码不能为空' };
  }
  if (username.length < 2 || username.length > 30) {
    return { success: false, error: '用户名长度 2-30 个字符' };
  }
  if (password.length < 4) {
    return { success: false, error: '密码至少 4 个字符' };
  }

  const sb = getSupabase();

  const { data: existing } = await sb
    .from(TABLE_USERS)
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (existing) {
    return { success: false, error: '用户名已被注册' };
  }

  const now = new Date();
  const dateSalt = now.toISOString().substring(0, 10);
  const passwordHash = hashPassword(password, dateSalt);
  const createdAt = dateSalt + 'T' +
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0') + '+08:00';

  const { data, error } = await sb
    .from(TABLE_USERS)
    .insert([{ username: username, password_hash: passwordHash, created_at: createdAt }])
    .select('created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return { success: false, error: '用户名已被注册' };
    }
    return { success: false, error: '注册失败，请稍后重试' };
  }

  setLoginCookie(username, passwordHash);

  // 若填写了空间管理员口令，尝试绑定
  let bindResult = null;
  if (passcode && passcode.trim().length > 0) {
    try {
      const { data: r } = await sb.rpc('sc_bind_with_passcode', {
        p_username: username,
        p_passcode: passcode.trim()
      });
      bindResult = r;
    } catch (e) {
      return { success: false, error: '绑定空间失败: ' + (e.message || '未知错误') };
    }
  }

  return {
    success: true,
    username: username,
    bindResult: bindResult  // { ok, tenant_id, tenant_name, role } 或 { ok:false, error }
  };
}

// ==========================================
// 登录
// ==========================================
async function loginUser(username, password) {
  if (!username || !password) {
    return { success: false, error: '请输入用户名和密码' };
  }
  const sb = getSupabase();
  const { data: user, error } = await sb
    .from(TABLE_USERS)
    .select('password_hash, created_at')
    .eq('username', username)
    .maybeSingle();
  if (error || !user) {
    return { success: false, error: '用户名或密码错误' };
  }
  const dateSalt = extractDateSalt(user.created_at);
  const inputHash = hashPassword(password, dateSalt);
  if (inputHash !== user.password_hash) {
    return { success: false, error: '用户名或密码错误' };
  }
  setLoginCookie(username, user.password_hash);
  return { success: true, username: username };
}

// ==========================================
// Cookie 登录态管理
// ==========================================
function setLoginCookie(username, passwordHash) {
  const token = computeToken(username, passwordHash);
  setCookie(CK_USER, username, 30);
  setCookie(CK_TOKEN, token, 30);
}
function clearLoginCookie() {
  deleteCookie(CK_USER);
  deleteCookie(CK_TOKEN);
}

async function checkLoginStatus() {
  const username = getCookie(CK_USER);
  const token = getCookie(CK_TOKEN);
  if (!username || !token) {
    return { loggedIn: false, username: null };
  }
  const sb = getSupabase();
  const { data: user, error } = await sb
    .from(TABLE_USERS)
    .select('password_hash')
    .eq('username', username)
    .maybeSingle();
  if (error || !user) {
    clearLoginCookie();
    return { loggedIn: false, username: null };
  }
  const expectedToken = computeToken(username, user.password_hash);
  if (token !== expectedToken) {
    clearLoginCookie();
    return { loggedIn: false, username: null };
  }
  return { loggedIn: true, username: username };
}

// ==========================================
// 多租户：空间上下文
// ==========================================

/**
 * 获取当前空间上下文
 * 优先 URL 参数 ?tenant=xxx，其次 Cookie sc_last_tenant
 * 返回 { tenant_id, tenant_name, role }
 */
function getTenantFromCookie() {
  return getCookie(CK_LAST_TENANT);
}

function setTenantCookie(tenantId) {
  setCookie(CK_LAST_TENANT, tenantId, 365);
}

/**
 * 查询用户的所有活跃空间
 */
async function fetchMyTenants(username) {
  try {
    const { data } = await getSupabase().rpc('sc_my_tenants', { p_username: username });
    return data || [];
  } catch (e) {
    return [];
  }
}

/**
 * 登录后路由：根据空间数量决定去向
 * 返回 { action: 'enter'|'picker'|'nosapce', tenant?, tenants? }
 */
async function routeAfterLogin(username) {
  const tenants = await fetchMyTenants(username);

  if (tenants.length === 0) {
    return { action: 'nospace', username: username };
  }

  if (tenants.length === 1) {
    const t = tenants[0];
    setTenantCookie(t.tenant_id);
    return { action: 'enter', tenant: t, username: username };
  }

  // 多个空间：看 Cookie
  const lastId = getTenantFromCookie();
  const found = tenants.find(t => t.tenant_id === lastId);
  if (found) {
    return { action: 'enter', tenant: found, username: username };
  }

  return { action: 'picker', tenants: tenants, username: username };
}

/**
 * 获取当前登录用户+空间的完整上下文
 * 用于主应用页面初始化
 */
async function initTenantContext() {
  const status = await checkLoginStatus();
  if (!status.loggedIn) {
    return { loggedIn: false };
  }

  const tenants = await fetchMyTenants(status.username);

  // 尝试从 Cookie 恢复上次空间
  const lastId = getTenantFromCookie();
  const current = tenants.find(t => t.tenant_id === lastId);

  if (current) {
    return {
      loggedIn: true,
      username: status.username,
      tenant: current,
      allTenants: tenants,
      isSuperAdmin: current.role === 'super_admin'
    };
  }

  // Cookie 里的空间失效或不存在
  if (tenants.length === 1) {
    setTenantCookie(tenants[0].tenant_id);
    return {
      loggedIn: true,
      username: status.username,
      tenant: tenants[0],
      allTenants: tenants,
      isSuperAdmin: tenants[0].role === 'super_admin'
    };
  }

  if (tenants.length === 0) {
    return { loggedIn: true, username: status.username, tenant: null, allTenants: [], isSuperAdmin: false };
  }

  // 多个空间且 Cookie 不在列表中 → 需要选择
  return { loggedIn: true, username: status.username, tenant: null, allTenants: tenants, needPick: true };
}

// ==========================================
// 管理员判断（v2：按空间）
// ==========================================
async function isAdmin(username) {
  if (!username) return false;
  // 兼容旧调用：查询是否为任意空间的 admin
  try {
    const { data } = await getSupabase().rpc('sc_is_admin', { p_username: username });
    return !!data;
  } catch (e) {
    return false;
  }
}

async function isTenantAdmin(tenantId, username) {
  if (!tenantId || !username) return false;
  try {
    const { data } = await getSupabase().rpc('sc_is_tenant_admin', {
      p_tenant_id: tenantId, p_username: username
    });
    return !!data;
  } catch (e) {
    return false;
  }
}

async function isSuperAdmin(username) {
  if (!username) return false;
  try {
    const { data } = await getSupabase().rpc('sc_is_super_admin', { p_username: username });
    return !!data;
  } catch (e) {
    return false;
  }
}

// ==========================================
// 空间操作
// ==========================================

/** 超管创建空间 */
async function createTenant(name, passcode) {
  const user = getCookie(CK_USER);
  try {
    const { data } = await getSupabase().rpc('sc_create_tenant', {
      p_username: user, p_name: name, p_admin_passcode: passcode
    });
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 列出所有空间（供未绑定用户选择） */
async function listTenants() {
  try {
    const { data } = await getSupabase().rpc('sc_list_tenants');
    return data || [];
  } catch (e) {
    return [];
  }
}

/** 申请加入空间 */
async function applyJoin(tenantId) {
  const user = getCookie(CK_USER);
  try {
    const { data } = await getSupabase().rpc('sc_apply_join', {
      p_username: user, p_tenant_id: tenantId
    });
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 超管切换空间 */
async function switchTenant(tenantId) {
  const user = getCookie(CK_USER);
  try {
    const { data } = await getSupabase().rpc('sc_switch_tenant', {
      p_username: user, p_tenant_id: tenantId
    });
    if (data && data.ok) {
      setTenantCookie(tenantId);
    }
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ==========================================
// 退出登录
// ==========================================
function logoutUser() {
  clearLoginCookie();
  window.location.href = 'login.html';
}

// ==========================================
// 共享头部登录态显示（.auth-status 容器）
// ==========================================
async function initAuthUI() {
  const status = await checkLoginStatus();
  const containers = document.querySelectorAll('.auth-status');
  containers.forEach(el => {
    if (status.loggedIn) {
      el.innerHTML = '<span class="auth-user">' + escapeHtml(status.username) + '</span>' +
        '<a href="javascript:void(0)" onclick="logoutUser()" class="auth-logout">退出</a>';
    } else {
      el.innerHTML = '<a href="login.html" class="auth-login">登录</a>' +
        '<a href="register.html" class="auth-register">注册</a>';
    }
    el.classList.add('auth-loaded');
  });
}

/** 渲染空间切换器（超管专用，放在 .tenant-switcher 容器内） */
async function initTenantSwitcher(currentTenantId) {
  const user = getCookie(CK_USER);
  if (!user) return;

  const isSuper = await isSuperAdmin(user);
  const containers = document.querySelectorAll('.tenant-switcher');
  if (!isSuper || containers.length === 0) return;

  const tenants = await fetchMyTenants(user);
  if (tenants.length <= 1) return;

  const options = tenants.map(t =>
    '<option value="' + t.tenant_id + '"' +
    (t.tenant_id === currentTenantId ? ' selected' : '') + '>' +
    escapeHtml(t.tenant_name) + (t.role === 'super_admin' ? ' [超管]' : '') +
    '</option>'
  ).join('');

  containers.forEach(el => {
    el.innerHTML = '<select onchange="onTenantSwitch(this.value)" class="tenant-select">' +
      options + '</select>';
  });
}

async function onTenantSwitch(tenantId) {
  const result = await switchTenant(tenantId);
  if (result && result.ok) {
    window.location.reload();
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAuthUI);
} else {
  initAuthUI();
}

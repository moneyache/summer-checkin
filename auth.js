/**
 * 暑假打卡工具 · 用户认证模块
 *
 * 复用「上下五千年」历史学习站的 Supabase 项目与 hs_users 表，
 * 因此两个站点的账号密码完全通用。
 *
 * 密码安全策略（与历史站一致）：
 *   salt = 用户创建日期的日期部分（YYYY-MM-DD）
 *   password_hash = MD5(密码 + "_" + salt)
 *   cookie token = MD5(用户名 + password_hash + 固定密钥)
 *
 * 管理员：注册时填写口令 "qtqtqt" 即成为管理员；不填或填错则为普通账号。
 *        （普通账号亦可后续由管理员在数据库侧授权，本前端不提供自助提权）
 */

// ==========================================
// Supabase 配置（与历史站相同项目，账号通用）
// ==========================================
const SUPABASE_URL = 'https://sucecjwfpslxnisvyetq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1Y2VjandmcHNseG5pc3Z5ZXRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1Mjk2ODcsImV4cCI6MjA5NzEwNTY4N30.sF6wjjDLkzY7kNg_etNhqYjvdtEwdr3TAGkdVnjl3QE';
const TABLE_USERS = 'hs_users';
const COOKIE_SECRET = 'sc-secret-summer-checkin-2026';
// 本项目使用独立的 cookie 名，避免与历史站（hs_user/hs_token）在同一域名下冲突
const CK_USER = 'sc_user';
const CK_TOKEN = 'sc_token';
const ADMIN_PASSCODE = 'qtqtqt';

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
// 注册（支持可选管理员口令）
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

  // 若填写了管理员口令，则尝试发放管理员权限
  let isAdmin = false;
  if (passcode && passcode.length > 0) {
    try {
      const { data: g } = await sb.rpc('sc_grant_admin', { p_username: username, p_passcode: passcode });
      isAdmin = !!(g && g.admin);
    } catch (e) { /* 忽略，保持普通账号 */ }
  }

  return { success: true, isAdmin: isAdmin };
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
  return { success: true };
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

async function isAdmin(username) {
  if (!username) return false;
  try {
    const { data } = await getSupabase().rpc('sc_is_admin', { p_username: username });
    return !!data;
  } catch (e) {
    return false;
  }
}

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

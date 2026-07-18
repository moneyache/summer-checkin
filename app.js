/* ============================================================
 * 暑假打卡小能手 · 主应用（SPA）v2 多租户
 * 普通用户：打卡(音效+鼓励+幂等) / 我的记录 / 积分商城 / 我的兑换
 * 管理员（空间级）：打卡配置 / 总览 / 成员管理 / 审批
 * 超管：空间切换 / 创建空间
 * 依赖：auth.js（Supabase 登录态、多租户上下文）、Supabase RPC
 * ============================================================ */

// ---------- 状态 ----------
let USER = null;                       // { username, role, balance }
let CURRENT_TENANT = null;             // { tenant_id, tenant_name, role }
let ALL_TENANTS = [];                  // 超管的所有空间列表
let CFG = { categories: [], itemsByCat: {}, prizes: [] };
let TODAY = shanghaiDate();
let DONE = new Set();                  // 今天已打卡的 key: catId|itemId 或 catId|c:customText
let AUDIO = null;
let ADMIN_CAT = null;                  // 管理员细项配置当前选中的大类
const PRAISE = ['太棒啦！', '你真厉害！', '继续保持哦！', '打卡小能手！', '好样的！', '进步看得见！', '坚持就是胜利！', '为你点赞！', '今天也很努力！'];

// ---------- 工具 ----------
function $(s) { return document.querySelector(s); }
function shanghaiDate() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function fmtTime(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[1].slice(2) + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return m[1].slice(2) + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
  return s;
}
function catEmoji(name) {
  if (/语文/.test(name)) return '📖';
  if (/数学/.test(name)) return '🔢';
  if (/英语/.test(name)) return '🔤';
  if (/运动/.test(name)) return '⚽';
  if (/科普/.test(name)) return '🔬';
  if (/音乐|美术|艺术/.test(name)) return '🎨';
  return '⭐';
}

// ---------- 提示 / 庆祝 / 音效 ----------
let toastTimer = null;
function toast(msg, type) {
  const el = $('#toast'); if (!el) return;
  el.textContent = msg; el.className = 'show'; if (type) el.classList.add(type);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}
function celebrate(big, msg, sub) {
  const old = document.querySelector('.celebrate'); if (old) old.remove();
  const c = document.createElement('div'); c.className = 'celebrate';
  c.innerHTML = '<div class="pop"><div class="big">' + big + '</div><div class="msg">' + esc(msg) + '</div>' +
    (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
  document.body.appendChild(c);
  setTimeout(() => c.remove(), 1500);
}
function flyStarFrom(el) {
  const r = el.getBoundingClientRect();
  const s = document.createElement('div'); s.className = 'fly-star'; s.textContent = '⭐';
  s.style.left = (r.left + r.width / 2 - 14) + 'px';
  s.style.top = (r.top + r.height / 2 - 14) + 'px';
  document.body.appendChild(s); setTimeout(() => s.remove(), 900);
}
function getAudio() {
  if (!AUDIO) { try { AUDIO = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AUDIO = null; } }
  return AUDIO;
}
function tone(freq, start, dur, type, gain) {
  const ac = getAudio(); if (!ac) return;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type || 'sine'; o.frequency.value = freq;
  o.connect(g); g.connect(ac.destination);
  const t = ac.currentTime + start;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain || 0.2, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t); o.stop(t + dur);
}
function playCheckinSound() { const ac = getAudio(); if (ac && ac.resume) ac.resume(); tone(523, 0, 0.18, 'triangle', 0.22); tone(659, 0.12, 0.18, 'triangle', 0.22); tone(784, 0.24, 0.32, 'triangle', 0.22); }
function playRewardSound() { const ac = getAudio(); if (ac && ac.resume) ac.resume(); [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.1, 0.32, 'square', 0.16)); }

// ---------- 空间管理 ----------
function tid() { return CURRENT_TENANT ? CURRENT_TENANT.tenant_id : null; }

// ---------- 数据加载 ----------
async function loadConfig() {
  const sb = getSupabase();
  const t = tid();
  const [cats, items, prizes] = await Promise.all([
    sb.from('sc_categories').select('*').eq('tenant_id', t).order('sort_order'),
    sb.from('sc_items').select('*').eq('tenant_id', t).order('sort_order'),
    sb.from('sc_prizes').select('*').eq('tenant_id', t).order('sort_order'),
  ]);
  CFG.categories = cats.data || [];
  CFG.prizes = prizes.data || [];
  CFG.itemsByCat = {};
  (items.data || []).forEach(it => { (CFG.itemsByCat[it.category_id] = CFG.itemsByCat[it.category_id] || []).push(it); });
}
async function loadBalance() {
  const { data } = await getSupabase().rpc('sc_get_balance', { p_tenant_id: tid(), p_username: USER.username });
  return data || 0;
}
async function buildDone() {
  DONE = new Set();
  const { data } = await getSupabase().rpc('sc_my_checkins', { p_tenant_id: tid(), p_username: USER.username });
  (data || []).forEach(r => { if (r.checkin_date === TODAY) DONE.add(r.category_id + '|' + (r.item_id || ('c:' + r.custom_text))); });
}

// ---------- 头部 / 导航 / 路由 ----------
function renderHeader() {
  const isAdm = CURRENT_TENANT && (CURRENT_TENANT.role === 'admin' || CURRENT_TENANT.role === 'super_admin');
  const roleBadge = CURRENT_TENANT.role === 'super_admin' ? '<span class="badge-role">超管</span>'
    : (isAdm ? '<span class="badge-role">管理员</span>' : '<span class="badge-role">成员</span>');
  const tenantSwitcher = CURRENT_TENANT.role === 'super_admin' && ALL_TENANTS.length > 1
    ? '<select class="tenant-select" onchange="onTenantSwitch(this.value)">' +
      ALL_TENANTS.map(t => '<option value="' + t.tenant_id + '"' +
        (t.tenant_id === CURRENT_TENANT.tenant_id ? ' selected' : '') + '>' +
        esc(t.tenant_name) + '</option>').join('') + '</select>'
    : '';

  $('#header').innerHTML =
    '<div class="top">' +
      '<div class="brand"><span class="logo">🏖️</span> 暑假打卡小能手' +
        '<span class="tenant-name">' + esc(CURRENT_TENANT.tenant_name) + '</span></div>' +
      '<div class="user-area">' + tenantSwitcher +
        '<span class="balance-pill" id="balPill">' + USER.balance + ' 分</span>' +
        '<span>' + esc(USER.username) + '</span>' + roleBadge +
        '<a href="javascript:void(0)" class="logout" onclick="logoutUser()">退出</a>' +
      '</div>' +
    '</div>';
}
function updateBalance(n) {
  USER.balance = n;
  const el = $('#balPill'); if (el) el.textContent = n + ' 分';
}
function renderNav() {
  const tabs = [
    ['checkin', '🌞', '打卡'],
    ['records', '📒', '我的记录'],
    ['mall', '🛍️', '积分商城'],
    ['redeem', '🧾', '我的兑换'],
  ];
  const isAdm = CURRENT_TENANT && (CURRENT_TENANT.role === 'admin' || CURRENT_TENANT.role === 'super_admin');
  if (isAdm) { tabs.push(['admin', '⚙️', '配置']); tabs.push(['overview', '📊', '总览']); }
  const cur = location.hash.replace('#', '') || 'checkin';
  $('#nav').innerHTML = tabs.map(t =>
    '<button class="' + (t[0] === cur ? 'active' : '') + '" onclick="location.hash=\'' + t[0] + '\'"><span class="ic">' + t[1] + '</span>' + t[2] + '</button>'
  ).join('');
}
function route() {
  renderNav();
  const h = location.hash.replace('#', '') || 'checkin';
  const map = { checkin: renderCheckin, records: renderRecords, mall: renderMall, redeem: renderRedeem, admin: renderAdmin, overview: renderOverview };
  (map[h] || renderCheckin)();
}

// ---------- 视图：打卡 ----------
async function renderCheckin() {
  buildDone();
  const cats = CFG.categories;
  if (!cats.length) { $('#view').innerHTML = '<div class="empty">还没有打卡内容，等管理员来配置吧～</div>'; return; }
  let html = '<div class="section-title">🌞 今天打卡 <span class="muted" style="font-weight:400">' + TODAY + '</span></div>';
  html += '<p class="muted" style="margin-bottom:14px">选择一个大类，点一点就完成今天的打卡，还能听鼓励哦！</p>';
  html += '<div class="grid cols-3">';
  cats.forEach(c => {
    const n = (CFG.itemsByCat[c.id] || []).length;
    html += '<div class="cat-card" data-cat="' + c.id + '">' +
      '<div class="emoji">' + catEmoji(c.name) + '</div>' +
      '<div class="name">' + esc(c.name) + '</div>' +
      '<div class="meta">' + n + '个细项' + (c.allow_custom ? ' · 可自填' : '') + '</div>' +
      '</div>';
  });
  html += '</div>';
  $('#view').innerHTML = html;
  $('#view').querySelectorAll('.cat-card').forEach(el => {
    el.addEventListener('click', () => { const cat = CFG.categories.find(c => c.id === el.dataset.cat); openCheckinModal(cat); });
  });
}
function openCheckinModal(cat) {
  const items = CFG.itemsByCat[cat.id] || [];
  let html = '<p class="muted" style="margin-bottom:12px">点一下就打卡，今天已打卡的会变成绿色 ✅</p>';
  items.forEach(it => {
    const done = DONE.has(cat.id + '|' + it.id);
    html += '<button class="item-btn ' + (done ? 'done' : '') + '" data-cat="' + cat.id + '" data-item="' + it.id + '" data-points="' + it.points + '"' + (done ? ' disabled' : '') + '>' +
      '<span>' + esc(it.name) + '</span><span class="pts">+' + it.points + '</span></button>';
  });
  if (cat.allow_custom) {
    html += '<div style="margin-top:10px;border-top:1px dashed #EEE;padding-top:12px">' +
      '<div class="muted" style="margin-bottom:6px">✍️ 我还可以自己填做了啥（如：篮球 / 跑步 / 游泳）</div>' +
      '<div class="custom-row"><input id="customText" placeholder="我做了…" maxlength="20"><button id="customBtn">打卡 +3</button></div></div>';
  }
  const modal = openModal(catEmoji(cat.name) + ' ' + esc(cat.name), html);
  modal.querySelectorAll('.item-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const catObj = CFG.categories.find(c => c.id === btn.dataset.cat);
      const itObj = (CFG.itemsByCat[catObj.id] || []).find(i => i.id === btn.dataset.item);
      const res = await doCheckin(catObj, itObj, null, parseInt(btn.dataset.points, 10));
      if (res) {
        DONE.add(catObj.id + '|' + itObj.id);
        btn.classList.add('done');
        if (res.is_new) { celebrate('🎉', '打卡成功！', '+' + res.earned + ' 积分 · ' + PRAISE[Math.floor(Math.random() * PRAISE.length)]); playCheckinSound(); flyStarFrom(btn); }
        else { toast('今天已经打过卡啦～'); }
        updateBalance(res.balance);
      } else { btn.disabled = false; }
    });
  });
  const cb = modal.querySelector('#customBtn');
  if (cb) {
    cb.addEventListener('click', async () => {
      const inp = modal.querySelector('#customText');
      const txt = inp.value.trim();
      if (!txt) { toast('先写一下你做了啥吧～'); return; }
      cb.disabled = true;
      const res = await doCheckin(cat, null, txt, 3);
      if (res) {
        if (res.is_new) { celebrate('🎉', '打卡成功！', '+' + res.earned + ' 积分 · ' + txt); playCheckinSound(); }
        else toast('今天已经打过卡啦～');
        updateBalance(res.balance); inp.value = '';
      }
      cb.disabled = false;
    });
  }
}
async function doCheckin(category, item, customText, points) {
  const { data, error } = await getSupabase().rpc('sc_do_checkin', {
    p_tenant_id: tid(),
    p_username: USER.username,
    p_category_id: category.id,
    p_item_id: item ? item.id : null,
    p_custom_text: customText || null,
    p_points: points,
  });
  if (error) { toast('打卡失败：' + (error.message || '请重试'), 'error'); return null; }
  return data;
}

// ---------- 视图：我的记录 ----------
let MY_CHECKINS = null;
let RECFILTER = { time: 'all', date: '', cat: 'all', item: 'all' };

function balanceCard() {
  return '<div class="card" style="text-align:center"><div class="muted">我的总积分</div><div style="font-size:32px;font-weight:800;color:var(--orange-deep)">' + USER.balance + ' 分</div></div>';
}
function recInfo(r) {
  const cat = CFG.categories.find(c => c.id === r.category_id);
  const it = r.item_id ? (CFG.itemsByCat[r.category_id] || []).find(i => i.id === r.item_id) : null;
  const title = it ? it.name : (r.custom_text || '自定义');
  return { catId: r.category_id, catName: cat ? cat.name : '', title: title, date: r.checkin_date, hasItem: !!it };
}
function optionsHtml(pairs, cur) {
  return pairs.map(p => '<option value="' + esc(p[0]) + '"' + (String(p[0]) === String(cur) ? ' selected' : '') + '>' + esc(p[1]) + '</option>').join('');
}
function dateDaysAgoSH(n) {
  const [y, m, d] = TODAY.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() - n);
  return base.toISOString().slice(0, 10);
}
function recDistinctItems(list, catId) {
  const set = new Set();
  list.forEach(r => { const i = recInfo(r); if (catId === 'all' || i.catId === catId) set.add(i.title); });
  return Array.from(set);
}
function recPassFilter(r) {
  const f = RECFILTER, i = recInfo(r);
  if (f.time === 'today' && i.date !== TODAY) return false;
  if (f.time === '7d' && i.date < dateDaysAgoSH(6)) return false;
  if (f.time === 'month' && i.date.slice(0, 7) !== TODAY.slice(0, 7)) return false;
  if (f.time === 'pick' && f.date && i.date !== f.date) return false;
  if (f.cat !== 'all' && i.catId !== f.cat) return false;
  if (f.item !== 'all' && i.title !== f.item) return false;
  return true;
}
async function renderRecords() {
  const { data, error } = await getSupabase().rpc('sc_my_checkins', { p_tenant_id: tid(), p_username: USER.username });
  MY_CHECKINS = error ? [] : (data || []);
  drawRecords();
}
function drawRecords() {
  const all = MY_CHECKINS || [];
  const f = RECFILTER;
  let html = '<div class="section-title">📒 我的打卡记录</div>' + balanceCard();
  const timeOpts = [['all', '全部时间'], ['today', '今天'], ['7d', '近7天'], ['month', '本月'], ['pick', '指定日期']];
  const catOpts = [['all', '全部大类']].concat(CFG.categories.map(c => [c.id, c.name]));
  const itemOpts = [['all', '全部细项']].concat(recDistinctItems(all, f.cat).map(t => [t, t]));
  html += '<div class="rec-filter">' +
    '<select id="fTime" onchange="onRecFilter()">' + optionsHtml(timeOpts, f.time) + '</select>' +
    '<input type="date" id="fDate" onchange="onRecFilter()" value="' + esc(f.date) + '" style="' + (f.time === 'pick' ? '' : 'display:none') + '">' +
    '<select id="fCat" onchange="onRecCatChange()">' + optionsHtml(catOpts, f.cat) + '</select>' +
    '<select id="fItem" onchange="onRecFilter()">' + optionsHtml(itemOpts, f.item) + '</select>' +
    '</div>';
  const list = all.filter(recPassFilter);
  const gain = list.reduce((a, r) => a + (r.points || 0), 0);
  html += '<div class="rec-summary">共 <b>' + list.length + '</b> 条 · 累计 <b>+' + gain + '</b> 分</div>';
  if (!list.length) {
    html += '<div class="empty">' + (all.length ? '没有符合筛选条件的记录～换个条件试试' : '还没有打卡记录哦，去打卡赚积分吧！') + '</div>';
  } else {
    html += '<div class="card">';
    list.forEach(r => {
      const i = recInfo(r);
      const sub = i.catName + ' · ' + fmtTime(r.checkin_at_sh || i.date);
      html += '<div class="rec"><div class="left"><div class="title">' + esc(i.title) + '</div><div class="sub">' + esc(sub) + '</div></div><div class="pts">+' + r.points + '</div></div>';
    });
    html += '</div>';
  }
  $('#view').innerHTML = html;
}
function onRecFilter() {
  RECFILTER.time = $('#fTime').value;
  const fd = $('#fDate'); if (fd) RECFILTER.date = fd.value;
  RECFILTER.cat = $('#fCat').value;
  const fi = $('#fItem'); RECFILTER.item = fi ? fi.value : 'all';
  drawRecords();
}
function onRecCatChange() {
  RECFILTER.cat = $('#fCat').value;
  RECFILTER.item = 'all';
  drawRecords();
}

// ---------- 视图：积分商城 ----------
async function renderMall() {
  const b = USER.balance;
  let html = '<div class="section-title">🛍️ 积分商城</div>';
  html += '<div class="card" style="text-align:center"><div class="muted">我的总积分</div><div style="font-size:34px;font-weight:800;color:var(--orange-deep)">' + b + ' 分</div></div>';
  if (!CFG.prizes.length) { html += '<div class="empty">还没有上架奖品，等管理员来配置吧～</div>'; }
  else {
    html += '<div class="grid cols-2">';
    CFG.prizes.forEach(p => {
      const can = b >= p.cost && (p.stock === null || p.stock > 0);
      const stockTxt = p.stock === null ? '库存充足' : ('剩余 ' + p.stock);
      html += '<div class="prize-card">' +
        '<div class="emoji">' + esc(p.emoji || '🎁') + '</div>' +
        '<div class="pname">' + esc(p.name) + '</div>' +
        '<div class="pdesc">' + esc(p.description || '') + '</div>' +
        '<div class="pcost">' + p.cost + ' 积分</div>' +
        '<div class="stock">' + stockTxt + '</div>' +
        '<button data-prize="' + p.id + '"' + (can ? '' : ' disabled') + '>' + (b < p.cost ? '积分不够' : '兑 换') + '</button>' +
        '</div>';
    });
    html += '</div>';
  }
  $('#view').innerHTML = html;
  $('#view').querySelectorAll('button[data-prize]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const p = CFG.prizes.find(x => x.id === btn.dataset.prize);
      await doRedeem(p);
    });
  });
}
async function doRedeem(prize) {
  const idem = tid() + '|' + USER.username + '|' + prize.id + '|' + Date.now() + '|' + Math.random().toString(36).slice(2);
  const { data, error } = await getSupabase().rpc('sc_redeem', { p_tenant_id: tid(), p_username: USER.username, p_prize_id: prize.id, p_idem_key: idem });
  if (error) { toast('兑换失败：' + (error.message || '请重试'), 'error'); return; }
  if (!data.ok) { toast(data.error || '兑换失败', 'error'); return; }
  if (data.duplicate) { toast('已经兑换过啦～'); updateBalance(data.balance); return; }
  updateBalance(data.balance);
  celebrate('🎁', '兑换成功！', prize.name + ' · -' + data.cost + ' 积分');
  playRewardSound();
  renderMall();
}

// ---------- 视图：我的兑换 ----------
async function renderRedeem() {
  const { data, error } = await getSupabase().rpc('sc_my_redemptions', { p_tenant_id: tid(), p_username: USER.username });
  let html = '<div class="section-title">🧾 我的积分消耗</div>' + balanceCard();
  if (error || !data || !data.length) { html += '<div class="empty">还没有兑换过奖品哦～</div>'; }
  else {
    html += '<div class="card">';
    data.forEach(r => {
      const dt = fmtTime(r.redeemed_at_sh || '');
      html += '<div class="rec"><div class="left"><div class="title">' + esc(r.prize_name || '奖品') + '</div><div class="sub">' + esc(dt) + '</div></div><div class="pts minus">-' + r.cost + '</div></div>';
    });
    html += '</div>';
  }
  $('#view').innerHTML = html;
}

// ---------- 视图：管理员配置 ----------
async function renderAdmin() {
  if (!ADMIN_CAT && CFG.categories.length) ADMIN_CAT = CFG.categories[0].id;
  let html = '<div class="section-title">⚙️ 打卡配置（管理员）</div>';
  // 大类
  html += '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><b>📚 打卡大类</b><button class="btn-sm btn-edit" onclick="adminOpenCat(null)">➕ 添加</button></div>';
  CFG.categories.forEach(c => {
    html += '<div class="rec"><div class="left"><div class="title">' + esc(c.name) + (c.allow_custom ? ' <span class="tag custom">可自填</span>' : '') + '</div><div class="sub">细项 ' + ((CFG.itemsByCat[c.id] || []).length) + ' 个</div></div>' +
      '<div style="display:flex;gap:6px"><button class="btn-sm btn-edit" onclick="adminOpenCat(\'' + c.id + '\')">编辑</button><button class="btn-sm btn-del" onclick="adminDelCat(\'' + c.id + '\')">删除</button></div></div>';
  });
  html += '</div>';
  // 细项
  html += '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><b>✅ 细项与分数</b><button class="btn-sm btn-edit" onclick="adminOpenItem(null)">➕ 添加</button></div>';
  html += '<div class="field"><select id="adminCatSel" onchange="adminCatChange(this.value)">';
  CFG.categories.forEach(c => { html += '<option value="' + c.id + '"' + (c.id === ADMIN_CAT ? ' selected' : '') + '>' + esc(c.name) + '</option>'; });
  html += '</select></div>';
  const items = CFG.itemsByCat[ADMIN_CAT] || [];
  if (!items.length) html += '<div class="muted">该大类还没有细项</div>';
  items.forEach(it => {
    html += '<div class="rec"><div class="left"><div class="title">' + esc(it.name) + '</div></div><div style="display:flex;gap:6px;align-items:center"><span class="pts" style="margin-right:6px">+' + it.points + '</span><button class="btn-sm btn-edit" onclick="adminOpenItem(\'' + it.id + '\')">编辑</button><button class="btn-sm btn-del" onclick="adminDelItem(\'' + it.id + '\')">删除</button></div></div>';
  });
  html += '</div>';
  // 奖品
  html += '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><b>🎁 兑换奖品</b><button class="btn-sm btn-edit" onclick="adminOpenPrize(null)">➕ 添加</button></div>';
  CFG.prizes.forEach(p => {
    const stock = p.stock === null ? '不限量' : ('剩 ' + p.stock);
    html += '<div class="rec"><div class="left"><div class="title">' + esc(p.emoji || '🎁') + ' ' + esc(p.name) + '</div><div class="sub">' + p.cost + ' 积分 · ' + stock + '</div></div><div style="display:flex;gap:6px"><button class="btn-sm btn-edit" onclick="adminOpenPrize(\'' + p.id + '\')">编辑</button><button class="btn-sm btn-del" onclick="adminDelPrize(\'' + p.id + '\')">删除</button></div></div>';
  });
  html += '</div>';

  // 成员管理（管理员专属）
  html += '<div class="card"><b>👥 成员管理</b>';
  html += '<div id="memberList" style="margin-top:8px"><button class="btn-sm btn-edit" onclick="loadMembers()">加载成员列表</button></div>';
  html += '<div id="pendingApps" style="margin-top:12px"></div>';
  html += '</div>';

  $('#view').innerHTML = html;
}
function adminCatChange(v) { ADMIN_CAT = v; renderAdmin(); }
function adminOpenCat(id) {
  const c = id ? CFG.categories.find(x => x.id === id) : null;
  const html =
    '<div class="field"><label>大类名称</label><input id="f_name" value="' + (c ? esc(c.name) : '') + '" placeholder="如：语文学习"></div>' +
    '<div class="field"><label class="checkbox-row"><input type="checkbox" id="f_custom"' + (c && c.allow_custom ? ' checked' : '') + '> 允许孩子自己填写细项（如运动项目）</label></div>' +
    '<div class="modal-actions"><button class="btn-ghost" onclick="closeModal()">取消</button><button class="btn-primary" style="width:auto;flex:1" onclick="adminSaveCat(\'' + (id || '') + '\')">保存</button></div>';
  openModal(id ? '编辑大类' : '添加大类', html);
}
function adminSaveCat(id) {
  const name = $('#f_name').value.trim(); if (!name) { toast('请填写名称', 'error'); return; }
  const allow_custom = $('#f_custom').checked;
  getSupabase().rpc('sc_upsert_category', { p_tenant_id: tid(), p_username: USER.username, p_id: id || null, p_name: name, p_allow_custom: allow_custom })
    .then(async ({ data, error }) => {
      if (error || !data || !data.ok) { toast((data && data.error) || '保存失败', 'error'); return; }
      closeModal(); toast('已保存', 'success'); await loadConfig(); renderAdmin();
    });
}
function adminDelCat(id) {
  if (!confirm('确定删除该大类及其细项？')) return;
  getSupabase().rpc('sc_delete_category', { p_tenant_id: tid(), p_username: USER.username, p_id: id })
    .then(async ({ error }) => { if (error) { toast('删除失败', 'error'); return; } await loadConfig(); toast('已删除'); renderAdmin(); });
}
function adminOpenItem(id) {
  const it = id ? (CFG.itemsByCat[ADMIN_CAT] || []).find(x => x.id === id) : null;
  const cat = CFG.categories.find(c => c.id === ADMIN_CAT);
  const html =
    '<p class="muted" style="margin-bottom:10px">所属大类：<b>' + esc(cat ? cat.name : '') + '</b></p>' +
    '<div class="field"><label>细项名称</label><input id="f_name" value="' + (it ? esc(it.name) : '') + '" placeholder="如：拼音 / 练字"></div>' +
    '<div class="field"><label>打卡得分</label><input id="f_pts" type="number" min="0" value="' + (it ? it.points : 2) + '"></div>' +
    '<div class="modal-actions"><button class="btn-ghost" onclick="closeModal()">取消</button><button class="btn-primary" style="width:auto;flex:1" onclick="adminSaveItem(\'' + (id || '') + '\')">保存</button></div>';
  openModal(id ? '编辑细项' : '添加细项', html);
}
function adminSaveItem(id) {
  const name = $('#f_name').value.trim(); if (!name) { toast('请填写名称', 'error'); return; }
  const pts = parseInt($('#f_pts').value, 10) || 0;
  getSupabase().rpc('sc_upsert_item', { p_tenant_id: tid(), p_username: USER.username, p_category_id: ADMIN_CAT, p_id: id || null, p_name: name, p_points: pts })
    .then(async ({ data, error }) => { if (error || !data || !data.ok) { toast((data && data.error) || '保存失败', 'error'); return; } closeModal(); toast('已保存', 'success'); await loadConfig(); renderAdmin(); });
}
function adminDelItem(id) {
  if (!confirm('删除该细项？')) return;
  getSupabase().rpc('sc_delete_item', { p_tenant_id: tid(), p_username: USER.username, p_id: id })
    .then(async ({ error }) => { if (error) { toast('删除失败', 'error'); return; } await loadConfig(); toast('已删除'); renderAdmin(); });
}
function adminOpenPrize(id) {
  const p = id ? CFG.prizes.find(x => x.id === id) : null;
  const html =
    '<div class="field"><label>奖品名称</label><input id="f_name" value="' + (p ? esc(p.name) : '') + '" placeholder="如：一个西瓜"></div>' +
    '<div class="field"><label>图标 Emoji</label><input id="f_emoji" value="' + (p ? esc(p.emoji || '') : '') + '" placeholder="🍉" maxlength="4"></div>' +
    '<div class="field"><label>描述</label><input id="f_desc" value="' + (p ? esc(p.description || '') : '') + '" placeholder="一句话介绍"></div>' +
    '<div class="field row2"><div><label>兑换积分</label><input id="f_cost" type="number" min="0" value="' + (p ? p.cost : 10) + '"></div>' +
    '<div><label>库存(留空=不限)</label><input id="f_stock" type="number" min="0" placeholder="不限" value="' + (p && p.stock != null ? p.stock : '') + '"></div></div>' +
    '<div class="modal-actions"><button class="btn-ghost" onclick="closeModal()">取消</button><button class="btn-primary" style="width:auto;flex:1" onclick="adminSavePrize(\'' + (id || '') + '\')">保存</button></div>';
  openModal(id ? '编辑奖品' : '添加奖品', html);
}
function adminSavePrize(id) {
  const name = $('#f_name').value.trim(); if (!name) { toast('请填写名称', 'error'); return; }
  const emoji = $('#f_emoji').value.trim(), desc = $('#f_desc').value.trim();
  const cost = parseInt($('#f_cost').value, 10) || 0;
  const stockRaw = $('#f_stock').value.trim();
  const stock = stockRaw === '' ? null : (parseInt(stockRaw, 10) || 0);
  getSupabase().rpc('sc_upsert_prize', { p_tenant_id: tid(), p_username: USER.username, p_id: id || null, p_name: name, p_description: desc, p_cost: cost, p_emoji: emoji, p_stock: stock })
    .then(async ({ data, error }) => { if (error || !data || !data.ok) { toast((data && data.error) || '保存失败', 'error'); return; } closeModal(); toast('已保存', 'success'); await loadConfig(); renderAdmin(); });
}
function adminDelPrize(id) {
  if (!confirm('下架该奖品？')) return;
  getSupabase().rpc('sc_delete_prize', { p_tenant_id: tid(), p_username: USER.username, p_id: id })
    .then(async ({ error }) => { if (error) { toast('删除失败', 'error'); return; } await loadConfig(); toast('已删除'); renderAdmin(); });
}

// ---------- 成员管理 ----------
async function loadMembers() {
  const { data } = await getSupabase().rpc('sc_admin_overview', { p_tenant_id: tid(), p_username: USER.username });
  if (!data || !data.ok) { document.getElementById('memberList').innerHTML = '<span class="muted">加载失败</span>'; return; }
  const users = data.data.users || [];
  let html = '<div class="table-wrap"><table class="tbl"><thead><tr><th>成员</th><th>打卡</th><th>积分</th><th>操作</th></tr></thead><tbody>';
  users.forEach(u => {
    html += '<tr><td>' + esc(u.username) + '</td><td>' + u.checkins + '</td><td>' + u.balance + '</td>' +
      '<td><button class="btn-sm btn-del" onclick="removeMember(\'' + u.username + '\')">移除</button></td></tr>';
  });
  html += '</tbody></table></div>';
  document.getElementById('memberList').innerHTML = html;

  // 加载待审批
  loadPendingApps();
}
async function loadPendingApps() {
  const { data } = await getSupabase().rpc('sc_list_applications', { p_tenant_id: tid(), p_username: USER.username });
  if (!data || !data.length) {
    document.getElementById('pendingApps').innerHTML = '<div class="muted">没有待审批的申请</div>';
    return;
  }
  let html = '<b>📋 待审批申请</b><div class="table-wrap"><table class="tbl"><thead><tr><th>申请人</th><th>申请时间</th><th>操作</th></tr></thead><tbody>';
  data.forEach(r => {
    html += '<tr><td>' + esc(r.username) + '</td><td>' + fmtTime(r.created_at) + '</td>' +
      '<td><button class="btn-sm btn-edit" onclick="approveApp(\'' + r.username + '\')">通过</button> ' +
      '<button class="btn-sm btn-del" onclick="rejectApp(\'' + r.username + '\')">拒绝</button></td></tr>';
  });
  html += '</tbody></table></div>';
  document.getElementById('pendingApps').innerHTML = html;
}
async function removeMember(username) {
  if (!confirm('确定移除成员 ' + username + '？其打卡记录和积分将被清除。')) return;
  const { data } = await getSupabase().rpc('sc_remove_member', { p_tenant_id: tid(), p_admin_username: USER.username, p_member_username: username });
  if (!data || !data.ok) { toast(data ? data.error : '操作失败', 'error'); return; }
  toast('已移除');
  loadMembers();
}
async function approveApp(username) {
  const { data } = await getSupabase().rpc('sc_approve_application', { p_tenant_id: tid(), p_admin_username: USER.username, p_applicant_username: username });
  if (!data || !data.ok) { toast(data ? data.error : '操作失败', 'error'); return; }
  toast('已通过');
  loadPendingApps();
}
async function rejectApp(username) {
  const { data } = await getSupabase().rpc('sc_reject_application', { p_tenant_id: tid(), p_admin_username: USER.username, p_applicant_username: username });
  if (!data || !data.ok) { toast(data ? data.error : '操作失败', 'error'); return; }
  toast('已拒绝');
  loadPendingApps();
}

// ---------- 视图：管理员总览 ----------
let OV = null;
let OV_PAGE = 1;
const OV_PAGE_SIZE = 30;

async function renderOverview() {
  const { data, error } = await getSupabase().rpc('sc_admin_overview', { p_tenant_id: tid(), p_username: USER.username });
  if (error) { $('#view').innerHTML = '<div class="empty">加载失败</div>'; return; }
  if (!data || !data.ok) { $('#view').innerHTML = '<div class="empty">' + (data ? data.error : '无权限') + '</div>'; return; }
  OV = data.data;
  OV_PAGE = 1;
  drawOverview();
}
function drawOverview() {
  const d = OV;
  let html = '<div class="section-title">📊 总览（管理员）</div>';

  html += '<div class="card"><div style="display:flex;align-items:center;gap:6px"><b>👧 所有账号积分</b><span class="muted" style="font-weight:400">（点用户名看打卡趋势）</span></div>' +
    '<div class="table-wrap" style="margin-top:8px"><table class="tbl"><thead><tr><th>账号</th><th>已赚</th><th>已花</th><th>余额</th><th>打卡</th></tr></thead><tbody>';
  (d.users || []).forEach(u => {
    html += '<tr><td><span class="lk">' + esc(u.username) + '</span></td><td>+' + u.earned + '</td><td>-' + u.spent + '</td><td><b>' + u.balance + '</b></td><td>' + u.checkins + '</td></tr>';
    html += '<tr class="trend-row" style="display:none"><td colspan="5">' + userTrendHtml(u.username) + '</td></tr>';
  });
  html += '</tbody></table></div></div>';

  const list = (d.checkins || []).slice().sort((a, b) => (b.checkin_at_sh || '').localeCompare(a.checkin_at_sh || ''));
  const totalPages = Math.max(1, Math.ceil(list.length / OV_PAGE_SIZE));
  if (OV_PAGE > totalPages) OV_PAGE = totalPages;
  const start = (OV_PAGE - 1) * OV_PAGE_SIZE;
  const pageRows = list.slice(start, start + OV_PAGE_SIZE);
  html += '<div class="card"><div style="display:flex;align-items:center;gap:6px"><b>✅ 全部打卡记录</b>' +
    '<span class="muted" style="font-weight:400">（共 ' + list.length + ' 条 · 按打卡时间倒序）</span></div>' +
    '<div class="table-wrap" style="margin-top:8px"><table class="tbl"><thead><tr><th class="cell-user">账号</th><th class="cell-cat">大类</th><th class="cell-item">细项</th><th class="cell-pts">分</th><th class="cell-time">时间</th></tr></thead><tbody>';
  pageRows.forEach(r => {
    const cat = CFG.categories.find(c => c.id === r.category_id);
    const it = r.item_id ? (CFG.itemsByCat[r.category_id] || []).find(i => i.id === r.item_id) : null;
    const title = it ? it.name : (r.custom_text || '自定义');
    html += '<tr><td class="cell-user">' + esc(r.username) + '</td><td class="cell-cat">' + esc(cat ? cat.name : '') + '</td><td class="cell-item">' + esc(title) + (r.custom_text && it ? ' (' + esc(r.custom_text) + ')' : '') + '</td><td class="cell-pts">+' + r.points + '</td><td class="cell-time">' + esc(fmtTime(r.checkin_at_sh || r.checkin_date)) + '</td></tr>';
  });
  html += '</tbody></table></div>' + pagerHtml(OV_PAGE, totalPages, 'ovGoPage') + '</div>';

  html += '<div class="card"><b>🛒 全部兑换消耗</b><div class="table-wrap" style="margin-top:8px"><table class="tbl"><thead><tr><th>账号</th><th>奖品</th><th>消耗</th><th class="cell-time">时间</th></tr></thead><tbody>';
  (d.redemptions || []).forEach(r => {
    const dt = fmtTime(r.redeemed_at_sh || '');
    html += '<tr><td class="cell-user">' + esc(r.username) + '</td><td class="cell-item">' + esc(r.prize_name || '') + '</td><td class="cell-pts">-' + r.cost + '</td><td class="cell-time">' + esc(dt) + '</td></tr>';
  });
  html += '</tbody></table></div></div>';

  $('#view').innerHTML = html;
  $('#view').querySelectorAll('.lk').forEach(el => {
    el.addEventListener('click', () => {
      const row = el.closest('tr').nextElementSibling;
      if (row && row.classList.contains('trend-row')) row.style.display = (row.style.display === 'none') ? 'table-row' : 'none';
    });
  });
}
function ovGoPage(p) { OV_PAGE = p; drawOverview(); }
function pagerHtml(page, total, fn) {
  if (total <= 1) return '';
  let s = '<div class="pager">';
  s += '<button class="pg-btn" ' + (page <= 1 ? 'disabled' : '') + ' onclick="' + fn + '(' + (page - 1) + ')">‹ 上一页</button>';
  s += '<span class="pager-info">第 ' + page + ' / ' + total + ' 页</span>';
  s += '<button class="pg-btn" ' + (page >= total ? 'disabled' : '') + ' onclick="' + fn + '(' + (page + 1) + ')">下一页 ›</button>';
  s += '</div>';
  return s;
}
function userTrendHtml(username) {
  const rows = (OV.checkins || []).filter(r => r.username === username);
  if (!rows.length) return '<div class="muted">暂无打卡记录</div>';
  const byDay = {};
  rows.forEach(r => {
    const day = r.checkin_date;
    if (!byDay[day]) byDay[day] = { pts: 0, cnt: 0 };
    byDay[day].pts += (r.points || 0);
    byDay[day].cnt += 1;
  });
  const days = Object.keys(byDay).sort();
  const totalPts = rows.reduce((a, r) => a + (r.points || 0), 0);
  const maxPts = Math.max(1, ...days.map(d => byDay[d].pts));
  const bars = days.map(d => {
    const h = Math.max(8, Math.round(byDay[d].pts / maxPts * 100));
    return '<div class="bar-col" title="' + d + '：' + byDay[d].cnt + ' 次 · +' + byDay[d].pts + ' 分">' +
      '<div class="bar-val">' + byDay[d].cnt + '</div>' +
      '<div class="bar-fill" style="height:' + h + '%"></div>' +
      '<div class="bar-date">' + d.slice(5) + '</div></div>';
  }).join('');
  return '<div class="trend"><div class="trend-sum">📈 ' + esc(username) + ' 的打卡趋势：共 <b>' + rows.length + '</b> 次 · 累计 <b>+' + totalPts + '</b> 分 · 活跃 <b>' + days.length + '</b> 天</div><div class="bars">' + bars + '</div></div>';
}

// ---------- Modal ----------
function openModal(title, bodyHtml) {
  closeModal();
  const mask = document.createElement('div'); mask.className = 'modal-mask';
  mask.innerHTML = '<div class="modal"><h3>' + title + '</h3><div class="modal-body">' + bodyHtml + '</div></div>';
  document.getElementById('modal-root').appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask) closeModal(); });
  return mask.querySelector('.modal');
}
function closeModal() { const m = $('.modal-mask'); if (m) m.remove(); }

// ---------- 初始化 ----------
(async function init() {
  const ctx = await initTenantContext();
  if (!ctx.loggedIn) { location.href = 'login.html'; return; }
  if (ctx.needPick || !ctx.tenant) { location.href = 'spaces.html'; return; }

  CURRENT_TENANT = ctx.tenant;
  ALL_TENANTS = ctx.allTenants || [];
  USER = { username: ctx.username, role: ctx.tenant.role, balance: 0 };
  await loadConfig();
  USER.balance = await loadBalance();
  renderHeader();
  window.addEventListener('hashchange', route);
  route();
})();

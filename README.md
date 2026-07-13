# 暑假打卡小能手 · 项目框架说明

> 小朋友暑期打卡赚积分的 **PWA 网站**，可安装到手机桌面。
> 模仿「儿子历史故事学习」的架构，复用其账号体系，独立工程部署。

---

## 0. 一句话总览

- **前端**：纯静态 HTML/JS/CSS（无构建步骤），挂在 **GitHub Pages**。
- **后端**：复用历史站的 **Supabase** 项目（`sucecjwfpslxnisvyetq`），认证用历史站的 `hs_users` 表，**打卡/商城等业务数据全部用新的 `sc_*` 表 + 一组 SECURITY DEFINER 的 RPC**。
- **账号通用**：历史站和本站的账号密码完全互通（同一套 `hs_users` + 同一套密码哈希方案）。
- **管理员**：通过注册时输入口令 `qtqtqt` 成为管理员；历史站现有账号全是普通账号。

---

## 1. 线上地址 & 仓库

| 项 | 值 |
|---|---|
| 线上站点 | https://moneyache.github.io/summer-checkin/ |
| GitHub 仓库 | https://github.com/moneyache/summer-checkin （`main` 分支） |
| Supabase 项目 | `sucecjwfpslxnisvyetq`（与历史站共用） |
| 管理员口令 | `qtqtqt` |

---

## 2. 整体架构

```
┌──────────────┐    HTTPS (REST + RPC)     ┌──────────────────────────────┐
│  浏览器 PWA   │ ───────────────────────▶ │  Supabase (Postgres)          │
│ 静态 HTML/JS  │ ◀─────────────────────── │  sucecjwfpslxnisvyetq         │
│ (GitHub Pages)│    anon key 调用 RPC      │                              │
└──────────────┘                           │  • hs_users   (认证, 复用)    │
                                           │  • sc_*       (业务表)        │
                                           │  • sc_*_rpc   (SECURITY DEFINER)
                                           └──────────────────────────────┘
```

要点：
- 前端**不持有任何密钥**，只用 Supabase 的 **anon public key** 调 RPC。
- 所有写操作都经过 RPC（SECURITY DEFINER），由函数内部判断权限，**前端无法绕过敏感表**（普通用户只能读自己的数据）。
- 配置表（`sc_categories / sc_items / sc_prizes`）对 anon **只读公开**，其余表关闭直读。

---

## 3. 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML5 + CSS3 + 原生 JS（SPA 单页应用，无框架、无打包） |
| 路由 | 前端 hash 路由（`#checkin` / `#records` / `#store` / `#mine` / `#config` / `#overview`） |
| 存储 | Supabase Postgres（认证复用历史站 `hs_users`） |
| 登录态 | Cookie（本项目独立名 `sc_user` / `sc_token`，避免与历史站 `hs_user` 冲突） |
| 音效 | Web Audio API 现场合成（无音频文件，离线可用） |
| PWA | manifest.json + service worker（cache-first 缓存静态资源）+ 192/512 图标 |
| 部署 | GitHub Pages（main 分支根目录） |

---

## 4. 认证机制

复用历史项目的方案，三处关键点：

1. **账号互通**：登录/注册都读写同一个 `hs_users` 表 → 两站账号密码通用。
2. **密码方案**：沿用 `MD5(密码 + "_" + 注册日期)` 的哈希；注册日期存于 `hs_users`，登录时按 `username` 取出注册日期再算哈希比对。
3. **管理员判定**：登录后额外查 `sc_admins` 表（成员=管理员）。注册时调用 `sc_grant_admin(p_username, p_passcode)`：
   - 口令 == `qtqtqt` → 写入 `sc_admins`，成为管理员；
   - 口令为空 / 错误 → 不写，普通账号。
4. **登录态**：写入 `sc_user`（用户名）与 `sc_token`（校验串）两个 Cookie；页面加载时 `auth.js` 读取并校验，未登录跳转 `login.html`。

相关代码：`auth.js`（登录/注册/登出/管理员判断）、`login.html`、`register.html`（含可选口令框）。

---

## 5. 数据库设计（`sc_*` 表）

| 表 | 作用 | 关键字段 |
|---|---|---|
| `sc_admins` | 管理员名单（成员即管理员） | `username` PK |
| `sc_categories` | 打卡大类 | `name`, `allow_custom`(是否允许孩子自填细项), `default_points`(自填细项默认分), `sort_order` |
| `sc_items` | 大类下的细项 | `category_id` FK, `name`, `points`, `sort_order` |
| `sc_checkins` | 打卡记录 | `username`, `category_id`, `item_id`, `custom_text`, `points`, `checkin_date`, **`idem_key` UNIQUE** |
| `sc_prizes` | 奖品配置（积分商城） | `name`, `description`, `cost`(所需积分), `emoji`, `stock`(null=不限), `sort_order` |
| `sc_redemptions` | 兑换记录 | `username`, `prize_id`, `prize_name`, `cost`, **`idem_key` UNIQUE** |
| `sc_balances` | 积分余额 | `username` PK, `points`（由 RPC 原子维护） |

**行级安全（RLS）**
- `sc_categories / sc_items / sc_prizes`：公开 `SELECT`（anon 可读，供商城/配置展示）。
- 其余表：启用 RLS 但**不建直读 policy** → 只能通过下面的 RPC 访问，普通用户只能取自己的行。

---

## 6. RPC 函数清单

所有 RPC 均为 `SECURITY DEFINER`，已 `GRANT EXECUTE` 给 `anon, authenticated`。
**普通用户类函数**无额外权限闸门（只能操作传入的 `p_username` 自己的数据）；**管理员类函数**第一行都会 `IF NOT sc_is_admin(...) RETURN 无权限`。

| 函数 | 职责 | 关键参数 | 权限 |
|---|---|---|---|
| `sc_is_admin(p_username)` | 是否管理员 | — | 公开 |
| `sc_do_checkin(p_username, p_category_id, p_item_id, p_custom_text, p_points, p_checkin_date?)` | **幂等打卡**：同一天+同用户+同大类/细项/自填文本仅记一次；新打卡则同步加 `sc_balances` | 日期默认按 `Asia/Shanghai` | 普通 |
| `sc_redeem(p_username, p_prize_id, p_idem_key)` | **原子兑换**：先验积分/库存 → 写兑换 → 扣余额 → 减库存；幂等（idem_key 唯一） | — | 普通 |
| `sc_get_balance(p_username)` | 查余额 | — | 普通 |
| `sc_my_checkins(p_username)` | 我的打卡记录 | — | 普通 |
| `sc_my_redemptions(p_username)` | 我的兑换记录 | — | 普通 |
| `sc_admin_overview(p_username)` | 管理员总览：所有普通账号(余额/已赚/已花/次数) + 全部打卡 + 全部兑换 | — | 管理员 |
| `sc_upsert_category / sc_delete_category` | 增改/删大类 | 含 `p_allow_custom`, `p_default_points` | 管理员 |
| `sc_upsert_item / sc_delete_item` | 增改/删细项 | `p_category_id`, `p_points` | 管理员 |
| `sc_upsert_prize / sc_delete_prize` | 增改/删奖品 | `p_cost`, `p_emoji`, `p_stock` | 管理员 |
| `sc_grant_admin(p_username, p_passcode)` | 注册时发放管理员（口令 `qtqtqt`） | — | 公开 |

> 注：`sc_upsert_category` 实际签名为 5 参 `(p_username, p_id, p_name, p_allow_custom, p_default_points)`。

---

## 7. 前端文件结构与职责

| 文件 | 职责 |
|---|---|
| `index.html` | SPA 外壳：顶部导航 + 各页容器；加载 PWA、注册 SW |
| `app.js` | 全部业务逻辑：加载配置、打卡/记录/商城/兑换/我的/配置/总览各视图渲染、音效、动画、RPC 调用 |
| `auth.js` | 认证：登录/注册/登出、`isAdmin()`、Cookie 读写、密码哈希 |
| `login.html` | 登录页 |
| `register.html` | 注册页（含「管理员口令（选填）」输入框） |
| `styles.css` | 儿童向夏日主题样式（橙/黄/绿）、响应式 |
| `manifest.json` | PWA 清单（standalone 显示、图标、主题色） |
| `sw.js` | Service Worker：cache-first 缓存静态资源，支持离线 |
| `icons/icon-192.png`, `icons/icon-512.png` | PWA 图标（含 maskable 适配） |

**视图（hash 路由）**
- 普通用户：`#checkin` 打卡（音效+鼓励+飞星）· `#records` 我的打卡记录 · `#store` 积分商城+兑换 · `#mine` 我的消耗记录
- 管理员额外：`#config` 配置大类/细项/奖品 · `#overview` 全站总览

---

## 8. 核心业务流程

### 8.1 打卡（幂等）
1. 用户选大类 → 选细项（或自填文本，若 `allow_custom`）；点击「打卡」。
2. 前端调用 `sc_do_checkin(..., p_points)`，`idem_key = md5(用户|日期(上海时区)|大类|细项|自填文本)`。
3. 数据库 `ON CONFLICT (idem_key) DO NOTHING`：
   - 新记录 → 返回 `is_new=true`，并原子加 `sc_balances.points`；
   - 已存在 → 返回 `is_new=false`，**不重复加分**，前端提示「今天已经打过卡啦」。
4. 成功后播放合成音效 + 鼓励语 + 飞星动画，刷新余额。

### 8.2 兑换（原子 + 幂等）
1. 用户在商城点「兑换」，`idem_key` 由前端用 `username + prize_id + 时间戳/随机` 生成。
2. `sc_redeem` 内部：先查 `idem_key` 是否已存在（防网络重试重复扣）→ 校验积分充足、库存充足 → 写兑换记录（`ON CONFLICT DO NOTHING`）→ 扣余额 → 减库存 → 返回最新余额。
3. 任一步不满足返回错误（积分不足 / 已兑换完 / 重复兑换），前端提示。

### 8.3 管理配置
管理员在 `#config` 调用对应 `sc_upsert_*` / `sc_delete_*` RPC；在 `#overview` 调用 `sc_admin_overview` 看全站数据。

---

## 9. 幂等性设计总结

| 场景 | 幂等键 | 机制 |
|---|---|---|
| 打卡 | `md5(用户\|日期\|大类\|细项\|自填文本)` | 唯一约束 + `ON CONFLICT DO NOTHING`；重复只返回已有记录，不加分 |
| 兑换 | 前端生成的 `idem_key`（用户+奖品+随机/时间） | 唯一约束 + 前置查重；重复返回同一结果，不重复扣 |

时区：打卡日期按 `Asia/Shanghai` 分界（函数内 `current_timestamp AT TIME ZONE 'Asia/Shanghai'`），避免跨零点混乱。

---

## 10. PWA 说明

- `manifest.json`：`display: standalone`、`theme_color`/`background_color`、192/512 图标、含 `purpose: any maskable`。
- `sw.js`：安装时预缓存核心静态资源，`fetch` 用 cache-first 策略 → 二次访问及离线可打开。
- 安装：手机浏览器「分享 → 添加到主屏幕」即生成桌面图标，像 App 一样启动。

---

## 11. 部署与更新流程

1. 改完前端文件后，`git add` → `git commit` → `git push origin main`。
2. GitHub Pages 监听 main 分支根目录，**推送即自动重新部署**（通常 1 分钟内生效，硬刷新清缓存）。
3. 注意：`.build/` 与 `.workbuddy/` 已被 `.gitignore` 屏蔽，**不会进公开仓库**。

---

## 12. 运维：改数据库结构

改表/函数/种子数据一律用项目内脚本（**`.build/` 本地保留、不入库**）：

```bash
cd .build
python3 run_sql.py schema.sql        # 或 functions.sql / seed.sql / patch.sql
```

- 脚本走 Supabase **Management API**（POST `/v1/projects/{ref}/database/query`），用文件头部的 service token。
- ⚠️ **必须带浏览器 User-Agent**，否则 Cloudflare 返回 `1010` 拒绝。脚本已内置。
- 新增/修改 RPC 后记得补 `GRANT EXECUTE ... TO anon, authenticated;`。

---

## 13. 安全注意事项

- ❗ **`.build/` 含 Supabase service token，已被 `.gitignore` 屏蔽，绝不可提交到公开仓库。**
- 前端只持 anon key；所有越权敏感操作都在 `SECURITY DEFINER` RPC 内校验（管理员函数首行 `sc_is_admin` 闸门）。
- 普通用户的读操作只能取自己 `username` 的数据；其它表直读被 RLS 关闭。
- 兑换/打卡幂等键由数据库唯一约束兜底，前端重试不会造成重复加分/扣费。

---

## 14. 默认种子数据（seed.sql，仅首次空表时写入）

- **大类（5）**：语文学习 / 数学学习 / 英语学习 / 运动(allow_custom=true) / 科普学习
- **细项（15）**：如语文-拼音(2)/练字(2)/唐诗(3)/阅读30分钟(5)；运动-跳绳(3)/拍球(3)（运动可自填，自填得 `default_points` 分）；等。
- **奖品（5）**：一个西瓜🍉(30) / 一个冰淇淋🍦(15) / 一块钱💰(10) / 神秘小礼物🎁(50) / 一次旅行🏖️(200)，默认均不限库存。

---

## 15. 故障排查

| 现象 | 排查 |
|---|---|
| 登录提示密码错误但历史站能登 | 确认同一 Supabase 项目；密码哈希依赖 `hs_users` 的注册日期字段，需与历史站一致 |
| 改库脚本报 `1010` | 缺浏览器 UA → 用 `run_sql.py`（已内置），不要裸 curl |
| 打卡不加分 | 多半当天已打过同项（幂等）；查 `sc_checkins.idem_key` |
| 兑换提示积分不足 | 查 `sc_balances.points`；兑换按总余额扣减 |
| PWA 不提示安装 | 需 HTTPS + manifest 正确 + 已注册 SW；GitHub Pages 已是 HTTPS |

---

_最后更新：2026-07-13_

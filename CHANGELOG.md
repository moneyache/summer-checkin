# 变更记录 · CHANGELOG

> 暑假打卡小能手（`moneyache/summer-checkin`）的变更历史。
> 项目上下文见 `agent.md`，完整系统架构见 `README.md`。
> 遵循「较新的在上」的倒序排列。

## 2026-07-18 · v2 多租户架构

### 新增
- **多租户空间体系**：超管可创建多个「空间」，每个空间独立配置打卡项、积分商城、成员
- 角色体系：`super_admin`（仅超管）/ `admin`（凭空间口令注册）/ `member`（申请审批加入）
- 新建 `sc_tenants` 空间表、`sc_memberships` 绑定关系表（替代旧 `sc_admins`）
- 所有 `sc_*` 业务表新增 `tenant_id` 列，积分主键升级为 `(tenant_id, username)`
- 新增 10 个 RPC：建空间、口令绑定、申请审批、成员管理、空间切换
- 新增 `spaces.html` 选择空间/申请加入/口令绑定页
- 超管头部空间切换器，Cookie `sc_last_tenant` 记忆上次空间
- 管理员可审批新成员申请、移除成员（含清除打卡记录）

### 改动
- 登录后走 `routeAfterLogin` 按空间数量分流（无空间→选择页 / 有空间→首页）
- 注册口令从全局管理员改为**空间管理员口令**，匹配后自动绑定为空间 admin
- 现有数据全部归入默认空间「华宇之家」

### 涉及文件
- `db/migration_v2.sql`、`db/functions_v2.sql`（24 个 RPC）
- `auth.js`、`app.js`、`spaces.html`、`login.html`、`register.html`、`styles.css`

---
## 2026-07-16 · 修复：打卡/兑换时间 +8 小时时区 bug

### 修复（线上已部署 + 历史数据已回写）
- **根因**：`sc_do_checkin` / `sc_redeem` 曾用 `current_timestamp AT TIME ZONE 'Asia/Shanghai'` 写入 `timestamptz` 列 `checkin_at` / `redeemed_at`。该写法把「上海墙钟时间」当成了无时区时间戳，Postgres 再按 UTC 解释存储 → 实际存成了「上海时间 +8h」；而显示侧 `to_char(checkin_at AT TIME ZONE 'Asia/Shanghai', ...)` 又转换一次，导致**上午打卡显示为下午（如 09:59 → 17:59）**。
- **修复**：写入值改为 `current_timestamp`（即真实 instant，显示侧 `AT TIME ZONE` 转换正确）。涉及 `.build/functions.sql`（`sc_do_checkin` / `sc_redeem` 的 INSERT）与 `.build/migrate_time.sql`（两列 `DEFAULT`）。
- **历史数据回写**：`created_at`（由 `default now()` 写入，永不受时区 bug 影响）即真实插入瞬间，已用它对 `checkin_at` / `redeemed_at` 全量回写（`.build/fix_time.sql`，幂等）。今日（2026-07-16）那条 17:59 已修正为 09:59；旧记录的「中午12:00占位」也升级为真实打卡时刻。
- **验证**：`checkin_at_sh` 与 `created_at_sh` 现已完全一致（hour_diff=0）。
- **无需改前端**：页面直接读 RPC 返回的 `checkin_at_sh` / `redeemed_at_sh`，刷新即生效。

---

## 2026-07-15 · 总览表格列宽优化（细项列加宽）

### 优化
- **总览「全部打卡记录」细项列加宽**（`app.js` / `styles.css`）：手机上细项列被其它列挤压、文字逐字换行导致行高过高、难看。改为给「账号 / 大类 / 分 / 时间」短列加 `white-space:nowrap` 固定最小宽度，细项列设 `min-width:120px` 并吸收剩余宽度，正常换行不再逐字断行。
- **「全部兑换消耗」奖品列同步加宽**：同一列宽规则应用到兑换表的奖品列，移动端展示一致。
- **Service Worker 缓存升 `v4` → `v5`**（`sw.js`）：因改动了 `app.js` / `styles.css`（均在预缓存清单），升版本号强制 PWA 拉取新资源，用户无需手动硬刷新。

---

## 2026-07-15 · 工程化：pre-push 防漏 hook

### 新增
- **`pre-push` 防漏 hook**（`.githooks/pre-push`，经 `git config core.hooksPath .githooks` 启用）：每次 `git push` 到 main 前，若本轮含功能/代码改动但未更新 `CHANGELOG.md`，则**拦截 push**并提示先补；commit message 含 `[skip-changelog]` 可跳过检查。
- **`scripts/changelog-draft.sh`**：被拦截时一键生成 CHANGELOG 草稿（含待 push 的 commit 列表与涉及文件），插入文件顶部当日区块，润色后提交即可。
- 注：克隆到新机器后需先运行 `git config core.hooksPath .githooks` 才会启用该 hook。

---

## 2026-07-15 · 总览优化 + 打卡/兑换时间

### 新增
- **总览页打卡记录分页**（`app.js`）：全部打卡记录改为 **30 条/页**，默认按 **打卡时间倒序**（最新在前）；底部「上一页 / 第 X / Y 页 / 下一页」分页控件。
- **点击打卡人展开趋势**（`app.js` / `styles.css`）：总览「所有账号积分」表中，用户名变为可点击链接，**点一下在该账号下方展开「打卡统计趋势」**——按天聚合的柱状图（每日得分）+ 汇总（总次数 / 累计得分 / 活跃天数）；再次点击收起。
- **打卡与兑换记录均带「时分秒」**：
  - 数据库新增 `sc_checkins.checkin_at`、`sc_redemptions.redeemed_at`（timestamptz，上海时区）。
  - **历史记录缺失时间 → 统一初始化为当日中午 12:00**（上海时区）；新增动作自动写入当前精确时间。
  - 总览的「全部打卡记录 / 全部兑换消耗」、以及用户侧「我的记录 / 我的兑换」均展示时间列（最终格式 `YY-MM-DD HH:MM`，见下方优化记录）。

### 变更
- RPC `sc_admin_overview`：打卡/兑换子查询改为显式字段，返回 `checkin_at_sh` / `redeemed_at_sh`（上海时区格式化字符串）并按时间倒序。
- RPC `sc_my_checkins` / `sc_my_redemptions`：返回类型调整为 TABLE，附带格式化时间字段。
- 迁移脚本：`.build/migrate_time.sql`（加列 + 历史回填 + 默认值）。
- `sw.js` 缓存版本 `v3` → `v4`（发布时间列等结构变化，触发 PWA 更新）。

### 优化（后续微调，同日迭代）

- **时间合并为单列 + 收窄列宽**（commit `7305a5a`）：总览打卡表 / 兑换表原本「日期」「时间」分两列，改为单列「时间」；`.cell-time` 改 11px 浅灰 + `width:1%`，把横向空间让给「细项」列，避免其他列被挤换行。
- **修复「日期 + 日期+时间」重复展示**（commit `0578bc7`）：「我的记录」手机卡片曾把纯日期 `i.date` 与含日期的 `checkin_at_sh` 拼在一起，出现 `2026-07-15 2026-07-15 14:54:07` 重复；统一改为单列 `fmtTime(checkin_at_sh)` 展示，所有展示点（总览打卡/兑换、我的打卡/兑换）全部走 `fmtTime`，只留一列。
- **时间格式压缩为两位年**（commit `b951291`）：`fmtTime` 输出从 `2026-07-15 14:54` 进一步压缩为 `26-07-15 14:54`（两位年、去秒），缩短列宽。期间 GitHub 443 临时不可达，本地提交 `b951291` 后重试推送成功。

---

## [Unreleased] · 2026-07-13

### 新增
- **我的记录支持筛选**（`app.js` / `styles.css`）：
  - 「我的记录」页新增筛选栏，可按 **时间 / 大类 / 细项** 三个维度组合筛选。
  - 时间维度：全部时间 / 今天 / 近7天 / 本月 / **指定日期**（选「指定日期」时出现日期选择器）；日期分界按 `Asia/Shanghai`。
  - 大类维度：全部大类 + 管理员配置的各大类；切换大类时自动重置细项选择。
  - 细项维度：随所选大类动态列出记录中实际出现过的细项（名称去重，含孩子自填内容）。
  - 顶部实时显示「共 N 条 · 累计 +M 分」汇总；筛选在本地内存进行，切换即时无需重新请求。
- **CHANGELOG.md**：建立本变更记录文件；`agent.md` 已指向此处查阅变更历史。

### 变更
- `sw.js` 缓存版本 `summer-checkin-v2` → `v3`（发布记录筛选功能，触发 PWA 自动更新）。

---

## 2026-07-13 · 登录/注册修复（commit `91ad6e5`）

### 修复
- **登录/注册在国内网络下失败**：根因是页面用 `cdn.jsdelivr.net` 加载 `supabase-js` / `crypto-js`，该 CDN 在国内被墙/超时导致库加载不出、抛 `ReferenceError`。
  - 将两库 UMD 构建下载进仓库 `vendor/`，三处 HTML 改相对路径引用，彻底去除外部 CDN 依赖。
  - `sw.js` 缓存升 `v2` 并纳入 `vendor/*.js`；login/register 补 favicon 消除 404。
  - 用无头浏览器「完全屏蔽 jsdelivr」复测：注册/登录均成功、零报错，确认根治。

### 变更
- `README.md` 移出 GitHub 仓库（`git rm --cached` + `.gitignore`），仅本地留存（含管理员口令等敏感信息）。
- 随后 `agent.md` 亦按同规则加入 `.gitignore`，本地留存不入库（commit `dd7bb3e`）。

---

## 2026-07-13 · 项目文档（commit `d32a64d`）

### 新增
- `README.md`：项目整体框架说明（架构 / 认证 / 表结构 / RPC 清单 / 幂等设计 / 部署运维 / 安全 / 种子数据 / 排障）。

---

## 2026-07-13 · 首次发布（commit `6cad095`）

### 新增
- **暑假打卡小能手** 从零搭建并上线 GitHub Pages。
- 复用「儿子历史故事学习」的 Supabase 项目与 `hs_users` 表做认证，两站账号密码通用。
- 支持凭管理员口令注册管理员（口令值见本地 `README.md` / `agent.md`）；`sc_*` 业务表 + 一组 SECURITY DEFINER RPC（幂等打卡、原子兑换、管理员配置与受限读取）。
- 普通用户：每日打卡（音效+鼓励+飞星动画+幂等）、我的记录、积分商城、兑换（原子扣分+幂等）、我的消耗记录。
- 管理员：配置大类/细项/自定义开关/奖品、查看所有账号打卡与积分消耗总览。
- PWA 支持：`manifest.json` + `sw.js` + 192/512 图标，可添加到主屏离线使用。

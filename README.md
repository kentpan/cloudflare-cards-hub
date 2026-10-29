# 卡密资源交付系统 v1.0.3

跑在 **Cloudflare Pages** 上的**数字资源**卡密自动交付系统：
源码 / 软件包 / zip / rar / PPT / 文档 / 图片（单个 ≤100MB）等任意文件都能卖。小黄鱼等平台买家付款后，对接系统 POST 一下发卡接口 → 买家拿到「`/s/` 加密提取页链接」→ 打开即自动核销（免输卡密、免提取码），命令 / 下载链接全部加密，看不到真实文件路径。

> 免费额度：Pages Functions 仅 `/api/*` 与 `/s/*` 计请求（免费 10 万次/天），`public/` 静态页面走 CDN 完全免费不限量。

## ✨ 特性

- **8 位卡密**：大小写英文 + 数字混合（区分大小写），简洁好输入；**发货时才实时生成**，每单一号不占库存
- **任意资源分发**：不再限定资源类型，源码 / 软件包 / zip / rar / PPT / 文档 / 图片…（单个 ≤100MB）全部可卖；未填名称自动用上传文件名
- **加密分享链接（v1.0.3）**：`JWT_SECRET`（AES-256-GCM）把「文件路径 + 卡密」加密成 `/s/xxxxx` 短链——提取页与下载直链统一走 /s/，**自带卡密、免提取码**，买家看不到真实路径；管理面板内置「分享链接解密」工具
- **发卡 API**：`POST /api/issue`（`Authorization: Bearer <APIKEY>`，参数 `{title, price, script_id}`，script_id 必填否则 404），返回「/s/ 加密提取页链接」或「/s/ 加密直接命令」
- **类网盘提取页**：买家打开 /s/ 链接即自动核销提取，零输入，附使用说明
- **管理面板**（`/admin`，ADMIN_SECRET 登录）：
  - 仪表盘：发卡 / 核销 / 交易金额 / APIKEY 调用 四大图表（chart.js 本地化，无外网依赖）
  - 资源管理：任意类型文件 CRUD + 分页，上传（≤100MB）到 **R2**（**D1 只存 path**），支持**外链资源**；可配置 **R2 CDN 访问域名**
  - 卡密管理：批量生成 / 作废 / 恢复 / 删除 / 搜索筛选 / 分页
  - 订单记录：金额、卡密、**调用方来源（APIKEY）**一目了然
  - **APIKEY 管理（v1.0.2）**：CRUD + 分页列表；每把 key 可配置**有效期**与**限速**（默认 30 次 / 60s）；**默认脱敏显示**、可查看、可复制；独立**调用统计**图表；订单按 key 区分调用方来源
  - 系统设置：站点标题 / 站点域名（**多个，; 分隔**） / 交付方式 / 命令模板 / R2 CDN 域名 / GitHub 下载代理 / **分享链接解密工具** / 提取码
- **GitHub 自动部署**：配置 `CLOUDFLARE_API_TOKEN` + `ADMIN_SECRET` 两个 Secret（可选加 `JWT_SECRET`），push main 即自动发布
- **沙盒本地运行**：`node + node:sqlite` 自动适配，`.env` 等价于运行环境变量（`DATABASE_URI` 指定 SQLite 文件，默认 `prisma/cards-download.db`），无需 Cloudflare 账号即可全流程自测
- **配套 gh-proxy Worker**：GitHub 文件下载加速代理；管理面板「系统设置 → GitHub 下载代理」填入 Worker 域名后，随包 payload.ps1 / bat 内 `{{GH_PROXY}}` 占位符在买家下载时自动替换为该代理（默认首选，公共镜像兑底），也可配合「外链资源」加速 GitHub 托管的文件

## 📦 目录结构

```
cards-download/
├─ functions/
│  ├─ api/[[path]].js            # 全部后端业务（Pages Functions 路由模式）
│  └─ s/[[path]].js              # /s/<token> 加密分享路由（薄包装，复用主路由器）
├─ public/
│  ├─ index.html                 # 买家提取页（类网盘，/s/ 链接免输入自动核销）
│  ├─ admin.html / admin.js / admin.css   # 管理面板
│  ├─ vendor/chart.umd.js        # chart.js 4.4.7 本地副本
│  └─ favicon.svg
├─ prisma/
│  └─ schema.sql                 # D1 建表参考（系统也会自动建表+迁移；本地 SQLite 库文件默认也放这里）
├─ scripts/                      # 示例脚本（可上传到 R2 测试，也支持任意类型资源）
│  ├─ beautify-powershell.bat
│  └─ payload.ps1
├─ worker/
│  ├─ gh-proxy-worker.js         # 配套：GitHub 文件下载加速代理 Worker
│  └─ wrangler-gh-proxy.toml.example
├─ local/
│  ├─ dev-server.mjs             # 沙盒本地服务（node:sqlite 适配 D1 / 目录适配 R2）
│  └─ daemon.mjs                 # setsid + 双 fork 孤儿进程持久化启动器
├─ .github/workflows/pages-deploy.yml   # GitHub 自动部署（push main 即发布）
├─ deploy.config.js              # 部署配置（项目名 / D1 名 / R2 桶名）
├─ wrangler.toml.example         # wrangler 本地调试参考
├─ .env                          # 沙盒本地环境变量（随包自带，ADMIN_SECRET 默认 admin123）
├─ .env.example                  # 沙盒本地环境变量参考模板
├─ .gitattributes                # 保护 bat 的 CRLF 换行
└─ .gitignore                    # 排除 .env / 本地数据 / 日志
```

## 🚀 部署方式一：GitHub 自动部署（推荐）

1. 把本目录推到一个 **GitHub 仓库**（私有即可）
2. Cloudflare Dashboard → My Profile → API Tokens → 创建 Token：
   模板 **Edit Cloudflare Workers**，再追加权限 `Cloudflare Pages → Edit`、`D1 → Edit`、`Workers R2 Storage → Edit`
3. GitHub 仓库 → Settings → Secrets and variables → Actions → 配置 **2 个 Secret**：
   | Secret | 说明 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | 上一步创建的 Token |
   | `ADMIN_SECRET` | 管理面板登录密钥（自定长随机串，如 `openssl rand -hex 24`）|
4. push 到 `main` 分支 → Actions 自动执行：
   - 自动创建 Pages 项目 / D1 / R2（deploy.config.js 里可改名称）
   - 动态生成 wrangler.toml 并绑定 `DATABASE` / `BUCKET`
   - 把 `ADMIN_SECRET` 写入 **Pages 运行环境 Secret**（等价于控制台手工配置）
   - `wrangler pages deploy public` 发布
5. 部署完成后访问 `https://<项目名>.pages.dev/admin`，输入 ADMIN_SECRET 登录

> 首次登录后请到「资源管理」上传资源 → 「卡密管理」生成卡密 → 「APIKEY 管理」创建对接密钥。

## 🚀 部署方式二：控制台手动部署

1. Cloudflare Pages → Create project → **Direct Upload**（或连接 Git 仓库，构建命令留空，输出目录 `public`）
2. 项目 → Settings → Bindings：
   - **D1** → 变量名 `DATABASE`（绑定任一 D1 数据库）
   - **R2** → 变量名 `BUCKET`（绑定任一 R2 存储桶）
3. Settings → Environment variables（Production + Preview 都要）→ 添加 **Secret**：`ADMIN_SECRET`
4. 上传本目录（functions/ + public/ 等）部署即可

## 💻 沙盒 / 本地运行（无需 Cloudflare 账号）

要求 Node ≥ 22.5（内置 `node:sqlite`）。沙盒已验证 Node 24 可用。

```bash
cd cards-download
# .env 已随包自带（ADMIN_SECRET 默认 admin123，等价于 Pages 运行环境变量），按需修改
node local/dev-server.mjs     # 前台运行
# 或：持久化运行（setsid + 双 fork 孤儿进程，脱离终端/工具进程树）
setsid node local/daemon.mjs
tail -f dev-server.log        # 看日志；停止：pkill -f dev-server.mjs
```

- `local/dev-server.mjs` 会用 **node:sqlite 模拟 D1**（库文件由 `.env` 的 `DATABASE_URI` 指定，默认 `prisma/cards-download.db`）、用 `local/r2data/` 目录模拟 R2，业务代码与线上 `functions/api/[[path]].js` 完全同一份
- `.env` 里的 `ADMIN_SECRET` / `JWT_SECRET` / `ISSUE_APIKEY` / `DATABASE_URI` **等价于 Pages 运行环境变量**（仅本地生效；线上仍以 Pages 控制台 / GitHub Secrets 为准）
- 包内 `.env` 自带演示密钥 `ADMIN_SECRET=admin123` 与随机 `JWT_SECRET`，开箱即用；**生产环境务必换成长随机串**
- 访问 `http://127.0.0.1:3000/`（提取页）、`/admin`（管理面板）

## 🔑 API 文档

### 发卡接口（对接小黄鱼等自动发货系统）

```bash
curl -X POST https://你的域名/api/issue \
  -H "Authorization: Bearer ak-xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"title":"Windows 终端美化服务","price":"5.88","script_id":1}'
```

成功响应（交付方式 = 提取页链接）：

```json
{
  "ok": true,
  "data": {
    "key": "x7Kp2Qm9",
    "title": "Windows 终端美化服务",
    "price": 5.88,
    "url": "https://你的域名/s/AEz9xK_3mQ2pL8vR5tY1wN4cD7bF6hJ0",
    "max_uses": 1,
    "script": "Windows 终端美化服务"
  }
}
```

- `url` 是 **`/s/` 加密提取页链接**：token 内加密了卡密，买家打开即自动核销，无需输入任何东西
- 交付方式 = 直接命令时，返回体带 `command` 字段（无 `url`），命令里的下载地址同样是 `/s/` 加密链接
- **`script_id` 必填**（后台「资源管理」里的资源 ID），未指定或无效直接返回 **404**
- 可选参数：`max_uses`（1-999）、`expires_hours`（有效期）、`deliver`（link/command/both，临时覆盖后台配置）

### 其他接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康自检（D1 / R2 / ADMIN_SECRET 状态）|
| POST | `/api/redeem` | 核销卡密 `{key, pwd?}`（或 `{s: token}` 免输入）→ 返回 /s/ 加密命令与下载地址 |
| GET | `/api/file/<path>` | R2 资源代理下载（未配 CDN 域名时的兜底）|
| GET | `/s/<token>` | 加密分享路由：提取页 token → 整页；下载 token → 校验后下发 / 302 外链 |
| GET | `/api/public/config` | 提取页初始化配置 |
| * | `/api/admin/*` | 管理接口（Bearer 登录 token，见 `[[path]].js` 头部注释）|

## 🔗 配套：GitHub 文件下载加速代理（gh-proxy）

部署专属 Worker（推荐，独立域名不限速，也可在管理面板改成任意其他代理域名）：

```bash
cd worker
cp wrangler-gh-proxy.toml.example wrangler.toml   # 按需改 name
npx wrangler deploy                                # 或控制台粘贴 gh-proxy-worker.js
```

部署后得到 `https://gh-proxy.你的子域.workers.dev`，用法：

```
/https://raw.githubusercontent.com/user/repo/main/payload.ps1   # 完整链接前缀式
/gh/user/repo@main/scripts/payload.ps1                          # raw 短链
/rel/user/repo@v1.0.2/beautify.zip                              # Release 附件
/arc/user/repo@main                                             # 源码 zip
```

### 让随包载荷自动走专属代理（已内置支持）

随包 payload.ps1 / beautify-powershell.bat 内已写入 `$GH_PROXY = '{{GH_PROXY}}'` 占位符：

1. 管理面板「系统设置 → GitHub 下载代理」填入 `https://gh-proxy.你的子域.workers.dev`（或任意其他代理域名）
2. 上传随包载荷到「资源管理」
3. 买家经 `/api/file/` 或 R2 CDN 下载时，系统自动把 `{{GH_PROXY}}` 替换为配置的代理地址，载荷下载 oh-my-posh / Nerd Font 时**优先走专属代理**，失败自动回退 ghfast.top / gh-proxy.com / 直连
4. 管理面板未配置时占位符替换为空串，载荷走内置公共镜像，开箱即用

> 直接从 GitHub 等渠道分发随包载荷（未经本系统下发）时，占位符不会被替换，载荷自动跳过专属代理，仅用公共镜像；也可手动把 `$GH_PROXY` 改为具体代理地址。

### 外链资源加速

管理面板「资源管理 → 添加外链」填：`https://gh-proxy.xxx.workers.dev/https://raw.githubusercontent.com/...`，买家提取到的命令即走 Cloudflare 加速。支持 `GITHUB_TOKEN`（私有仓库/提速）与 `REPO_WHITELIST`（防盗刷白名单）。

## ❓ FAQ

**ADMIN_SECRET 在哪配置？**
Cloudflare Pages 运行环境 Secret（控制台 Settings → Environment variables；或 GitHub Secrets 让 CI 自动注入）。**不存 D1、不进代码库**。修改后所有登录会话立即失效。

**JWT_SECRET 在哪配置？有什么用？**
同样是 Pages 运行环境 Secret（可选）。`/s/` 加密分享链接用它做 AES-256-GCM 加解密（文件路径 + 卡密）；未配置时自动退回用 `ADMIN_SECRET` 派生。**更换后旧 /s/ 链接全部失效**（解不开即 404），需重新发卡。

**加密链接 /s/ 被分享出去了怎么办？**
后台「卡密管理」把对应卡密**作废**即可——提取页与下载直链都会即时失效（每次 /s/ 下载都会实时校验卡密状态）。

**提取页还要买家输入提取码吗？**
不需要。`/s/` 加密链接自带卡密，打开即自动核销；仅当买家手动走 `/?key=卡密` 旧入口且后台设置了提取码时才需要输入。

**忘了 APIKEY？**
管理面板「APIKEY 管理」点「查看」即可显示完整 key（默认列表脱敏）；每把 key 独立停用/删除，互不影响。

**卡密区分大小写吗？**
区分。8 位 `A-Z a-z 0-9` 混合，复制粘贴即可，无需手敲。

**已产生的 v1.0.1 旧数据兼容吗？**
兼容。首次请求自动执行增量迁移（orders 表补 `apikey_id/apikey_name` 列），旧订单来源显示为「默认密钥」；旧版 `ISSUE_APIKEY` 环境变量仍可继续调用。

**/api/issue 被刷怎么办？**
每把 APIKEY 默认限速 30 次/60s（可调），另有全局 IP 级兜底限速；被泄露的 key 在后台一键停用即可。

## 📜 版本历史

| 版本 | 更新 |
|---|---|
| v1.0.3 | **资源分发**：去掉脚本类型限制，任意文件（≤100MB）都可上架，未填名称自动用文件名，文案全面「脚本→资源」；**加密分享**：JWT_SECRET + AES-256-GCM，提取页/下载统一 `/s/<token>` 短链（自带卡密，看不到真实路径），管理面板新增「分享链接解密」工具；提取页 /s/ 链接免输入卡密与提取码，自动核销；站点域名支持绑定多个（; 分隔）；删除「默认发卡脚本」，/api/issue 无 script_id 直接 404；schema.sql 迁入 prisma/，.env 新增 DATABASE_URI（本地 SQLite 库文件）与 JWT_SECRET |
| v1.0.2 | APIKEY 多密钥管理（CRUD/分页/有效期/限速/脱敏/调用统计）；订单记录调用方来源；仪表盘新增 APIKEY 调用趋势图；沙盒本地运行（node + node:sqlite + .env）；setsid 双 fork 持久化启动器；GitHub 自动部署工作流（pages-deploy.yml + deploy.config.js）；配套 gh-proxy GitHub 下载加速 Worker，管理面板可配置下载代理并自动注入随包脚本（{{GH_PROXY}}）；脚本支持外链模式 |
| v1.0.1 | 卡密简化为 8 位大小写英文+数字；新增管理面板（ADMIN_SECRET 登录）；脚本 R2 上传（D1 只存 path）+ R2 CDN 域名配置；删除 _worker.js 改用 functions/api/[[path]].js 路由模式；小黄鱼发卡对接 /api/issue；chart.js 交易金额与卡密使用统计；清理所有无效引用文案 |
| v1.0.0 | 首版：KV 迁移 D1，Cloudflare Pages 部署 |

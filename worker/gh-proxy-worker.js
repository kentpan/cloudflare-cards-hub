/**
 * ============================================================================
 *  GitHub 文件下载加速代理（卡密资源分发系统 v1.0.4 配套 Worker）
 * ============================================================================
 *  用途：国内 / 弱网环境下加速下载 GitHub 文件（raw / Release / 源码包）。
 *  配合卡密分发系统：管理面板「系统设置 → GitHub 下载代理」填入本 Worker 地址，
 *  随包 payload.ps1 / bat 内 {{GH_PROXY}} 占位符即自动替换为本代理（默认首选）；
 *  也可在「资源管理 → 添加外链」直接填本代理地址加速 GitHub 外链资源。
 *
 *  ── 部署方式一（控制台粘贴，推荐新手）──────────────────────────────────
 *    1. Cloudflare Dashboard → Workers & Pages → Create application → Worker
 *    2. 部署后在「Edit code」中粘贴本文件全部内容 → Save and Deploy
 *    3. 得到地址：https://<worker名>.<子域>.workers.dev
 *
 *  ── 部署方式二（wrangler CLI）─────────────────────────────────────────
 *    cp worker/wrangler-gh-proxy.toml.example worker/wrangler.toml（按需改名）
 *    cd worker && npx wrangler deploy
 *
 *  ── 用法（三种形式）───────────────────────────────────────────────────
 *    ① 完整链接前缀式：
 *       https://<worker>/https://raw.githubusercontent.com/user/repo/main/a.ps1
 *       https://<worker>/https://github.com/user/repo/releases/download/v1.0/a.zip
 *    ② 短链 raw：  /gh/<user>/<repo>@<分支或tag>/<文件路径>
 *       例：/gh/user/repo@main/scripts/payload.ps1（@main 省略时默认 main）
 *    ③ 短链 Release 附件：/rel/<user>/<repo>@<tag>/<文件名>
 *       例：/rel/user/repo@v1.0.2/beautify.zip
 *    ④ 短链 源码包：/arc/<user>/<repo>@<分支>  →  zip（heads）
 *                   /arct/<user>/<repo>@<tag>  →  zip（tags）
 *
 *  ── 可选配置（Worker → Settings → Variables and Secrets）───────────────
 *    GITHUB_TOKEN    Secret。提升 API/raw 速率限制，并支持私有仓库下载
 *    REPO_WHITELIST  纯文本变量。逗号分隔白名单（如 user/repo,user2/repo2），
 *                    留空 = 不限制；配置后仅代理白名单仓库，防止被盗刷
 * ============================================================================
 */

// 允许代理的上游域名（白名单，防止变成开放代理）
const ALLOW_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'api.github.com',
]);

// 默认仓库白名单（留空不限制；也可用环境变量 REPO_WHITELIST 覆盖）
const DEFAULT_WHITELIST = '';

const UA = 'gh-proxy-worker (+https://developers.cloudflare.com/workers/)';

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

function helpText(base) {
  return jsonResp({
    name: 'GitHub File Download Proxy',
    version: '1.0.0',
    companion: '卡密资源分发系统 v1.0.4 · 管理面板「资源管理 → 添加外链」直接填本代理地址',
    usage: {
      full_url: `${base}/https://raw.githubusercontent.com/user/repo/main/file.ps1`,
      raw_short: `${base}/gh/user/repo@main/path/file.ps1`,
      release: `${base}/rel/user/repo@v1.0.0/file.zip`,
      archive_branch: `${base}/arc/user/repo@main`,
      archive_tag: `${base}/arct/user/repo@v1.0.0`,
    },
    whitelist: '可用环境变量 REPO_WHITELIST 限制可代理的仓库（逗号分隔 user/repo）',
  });
}

// 从上游路径中提取 user/repo 用于白名单校验
function repoOf(targetUrl) {
  const m = targetUrl.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/|$)/);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : null;
}

function whitelistHit(env, targetUrl) {
  const list = String(env && env.REPO_WHITELIST ? env.REPO_WHITELIST : DEFAULT_WHITELIST)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return true; // 未配置 = 不限制
  const repo = repoOf(targetUrl);
  return !!repo && list.includes(repo);
}

// 解析短链 → 上游完整 URL
function resolveShortForm(pathname, search) {
  const p = pathname.replace(/^\/+|\/+$/g, '');
  if (!p) return null;

  // ① 完整 URL 前缀式
  if (/^https?:\/\//i.test(p)) {
    return { url: p + (search || '') };
  }

  const seg = p.split('/');
  const kind = seg.shift();

  // ② /gh/<user>/<repo>[@<ref>]/<path...>  → raw
  if (kind === 'gh' && seg.length >= 2) {
    let repo = seg.shift();
    let ref = 'main';
    const at = repo.indexOf('@');
    if (at > 0) {
      ref = repo.slice(at + 1) || 'main';
      repo = repo.slice(0, at);
    }
    const rest = seg.join('/');
    if (!rest) return null;
    return { url: `https://raw.githubusercontent.com/${repo}/${ref}/${rest}` };
  }

  // ③ /rel/<user>/<repo>[@<tag>]/<文件名>  → Release 附件
  if (kind === 'rel' && seg.length >= 3) {
    let repo = seg.shift();
    let tag = '';
    const at = repo.indexOf('@');
    if (at > 0) {
      tag = repo.slice(at + 1);
      repo = repo.slice(0, at);
    }
    if (!tag) return null;
    return { url: `https://github.com/${repo}/releases/download/${tag}/${seg.join('/')}` };
  }

  // ④ /arc|arct/<user>/<repo>[@<ref>]  → 源码 zip
  if ((kind === 'arc' || kind === 'arct') && seg.length >= 1) {
    let repo = seg.shift();
    let ref = kind === 'arc' ? 'main' : '';
    const at = repo.indexOf('@');
    if (at > 0) {
      ref = repo.slice(at + 1);
      repo = repo.slice(0, at);
    }
    if (!ref) return null;
    const refType = kind === 'arc' ? 'heads' : 'tags';
    return { url: `https://codeload.github.com/${repo}/zip/refs/${refType}/${ref}` };
  }

  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 首页 / 健康检查 → 用法说明
    if (url.pathname === '/' || url.pathname === '/health') {
      return helpText(url.origin);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResp({ error: '仅支持 GET / HEAD' }, 405);
    }

    const resolved = resolveShortForm(url.pathname, url.search);
    if (!resolved) {
      return jsonResp({ error: '无法解析目标地址', hint: '访问 / 查看用法' }, 400);
    }

    let target;
    try {
      target = new URL(resolved.url);
    } catch {
      return jsonResp({ error: '目标地址无效' }, 400);
    }

    if (!ALLOW_HOSTS.has(target.hostname)) {
      return jsonResp({ error: `上游域名不在白名单: ${target.hostname}` }, 403);
    }
    if (!whitelistHit(env, target)) {
      return jsonResp({ error: '该仓库不在 REPO_WHITELIST 白名单内' }, 403);
    }

    // 转发请求头：Range 断点续传 + 可选 GitHub Token
    const headers = { 'User-Agent': UA, Accept: '*/*' };
    const range = request.headers.get('range');
    if (range) headers.Range = range;
    const token = env && env.GITHUB_TOKEN ? String(env.GITHUB_TOKEN) : '';
    if (token) headers.Authorization = `Bearer ${token}`;

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      redirect: 'follow',
      cf: request.method === 'GET'
        ? { cacheEverything: true, cacheTtl: target.hostname === 'raw.githubusercontent.com' ? 86400 : 300 }
        : undefined,
    });

    if (!upstream.ok && upstream.status !== 206) {
      const body = await upstream.text().catch(() => '');
      return jsonResp(
        {
          error: `上游返回 ${upstream.status}`,
          target: target.toString(),
          hint:
            upstream.status === 404
              ? '文件不存在：检查分支 / tag / 路径是否正确（私有仓库需配置 GITHUB_TOKEN）'
              : upstream.status === 403 || upstream.status === 429
                ? '触发 GitHub 速率限制：可在 Worker 环境变量配置 GITHUB_TOKEN 提升'
                : body.slice(0, 300),
        },
        upstream.status === 404 ? 404 : 502
      );
    }

    // 流式转发，保留下载体验相关的响应头
    const out = new Headers();
    for (const h of ['content-type', 'content-length', 'content-disposition', 'accept-ranges', 'content-range', 'last-modified', 'etag']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    if (!out.has('content-type')) out.set('content-type', 'application/octet-stream');
    out.set('Access-Control-Allow-Origin', '*');
    out.set('Cache-Control', 'public, max-age=300');
    out.set('X-Proxy-By', 'gh-proxy-worker');

    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};

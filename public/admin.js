/* ══════════════ 管理面板逻辑 ══════════════ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var TOKEN_KEY = 'cards_admin_token';
  var state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    view: 'dash',
    scripts: { page: 1, total: 0, size: 20 },
    cards: { page: 1, total: 0, size: 20, selected: new Set() },
    orders: { page: 1, total: 0, size: 20 },
    apikeys: { page: 1, total: 0, size: 20 },
    revealedKeys: {},
    keyStatsId: null,
    scriptOptions: [],
    charts: {},
    renamingId: null,
    uploadFile: null,
  };

  /* ─────────── 基础 ─────────── */
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = 'toast' + (isErr ? ' err' : ''); }, 2400);
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body })
      .then(function (res) {
        return res.json().catch(function () {
          return { ok: false, error: '响应解析失败（status ' + res.status + '）' };
        }).then(function (data) {
          if (res.status === 401 && state.token) {
            state.token = '';
            localStorage.removeItem(TOKEN_KEY);
            showGate('登录会话已过期，请重新登录');
            throw new Error('会话已过期');
          }
          if (!res.ok || !data.ok) throw new Error(data.error || '请求失败（' + res.status + '）');
          return data.data !== undefined ? data.data : data;
        });
      });
  }

  function fmtSize(n) {
    if (n == null) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function fmtTime(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    function pad(x) { return String(x).padStart(2, '0'); }
  }
  function fmtMoney(n) { return '¥' + Number(n || 0).toFixed(2); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function copyText(text, tip) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(tip || '已复制'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast(tip || '已复制');
    }
  }

  function renderPager(el, page, size, total, goFn) {
    var pages = Math.max(1, Math.ceil(total / size));
    el.innerHTML = '';
    var prev = document.createElement('button');
    prev.textContent = '‹ 上一页';
    prev.disabled = page <= 1;
    prev.onclick = function () { goFn(page - 1); };
    var info = document.createElement('span');
    info.textContent = '第 ' + page + ' / ' + pages + ' 页 · 共 ' + total + ' 条';
    var next = document.createElement('button');
    next.textContent = '下一页 ›';
    next.disabled = page >= pages;
    next.onclick = function () { goFn(page + 1); };
    el.appendChild(prev);
    el.appendChild(info);
    el.appendChild(next);
  }

  /* ─────────── 认证 ─────────── */
  function showGate(msg) {
    $('app').style.display = 'none';
    $('gate').style.display = 'flex';
    if (msg) {
      var w = $('gateWarn');
      w.style.display = 'block';
      w.innerHTML = msg;
    }
  }
  function showApp() {
    $('gate').style.display = 'none';
    $('app').style.display = 'flex';
    switchView('dash');
  }

  function bootstrap() {
    fetch('/api/admin/bootstrap').then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok) { showGate('系统初始化失败：' + esc(res.error || '')); return; }
      var d = res.data;
      $('verText').textContent = 'v' + d.version;
      if (!d.db) { showGate('D1 数据库未绑定：请到 Pages 控制台 → Settings → Bindings 添加 <b>D1</b>，变量名 <code>DATABASE</code>'); return; }
      if (!d.admin_secret_configured) {
        showGate('尚未配置 <b>ADMIN_SECRET</b>：请到 Cloudflare Pages 控制台 → Settings → Environment variables（Production + Preview）添加类型为 <b>Secret</b> 的变量 <code>ADMIN_SECRET</code>，保存后重新部署即可登录。');
        return;
      }
      if (state.token) {
        // 校验旧 token
        api('/api/admin/overview').then(function () { showApp(); }).catch(function () {
          state.token = '';
          localStorage.removeItem(TOKEN_KEY);
          showGate('');
        });
      } else {
        showGate('');
      }
    }).catch(function () { showGate('无法连接服务器，请稍后刷新'); });
  }

  function doLogin() {
    var secret = $('secretInput').value;
    if (!secret) { toast('请输入 ADMIN_SECRET', true); return; }
    $('loginBtn').disabled = true;
    $('loginBtn').textContent = '验证中…';
    api('/api/admin/login', { method: 'POST', body: JSON.stringify({ admin_secret: secret }) })
      .then(function (d) {
        state.token = d.token;
        localStorage.setItem(TOKEN_KEY, d.token);
        $('secretInput').value = '';
        showApp();
        toast('登录成功');
      })
      .catch(function (e) { toast(e.message, true); })
      .finally(function () {
        $('loginBtn').disabled = false;
        $('loginBtn').textContent = '登 录';
      });
  }
  $('loginBtn').onclick = doLogin;
  $('secretInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  $('logoutBtn').onclick = function () {
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    location.reload();
  };

  /* ─────────── 视图切换 ─────────── */
  var loadOnce = {};
  function switchView(name) {
    state.view = name;
    document.querySelectorAll('.nav-item').forEach(function (n) {
      n.classList.toggle('active', n.dataset.view === name);
    });
    document.querySelectorAll('.view').forEach(function (v) { v.style.display = 'none'; });
    $('view-' + name).style.display = 'block';
    if (name === 'dash') loadDash();
    if (name === 'scripts') loadScripts(1);
    if (name === 'cards') { loadScriptOptions(); loadCards(1); }
    if (name === 'orders') loadOrders(1);
    if (name === 'apikeys') loadApikeys(1);
    if (name === 'settings') { loadScriptOptions().then(loadSettings); }
  }
  document.querySelectorAll('.nav-item').forEach(function (n) {
    n.onclick = function () { switchView(n.dataset.view); };
  });

  /* ─────────── 仪表盘 ─────────── */
  var CHART_COLORS = ['#3fb950', '#58a6ff', '#d29922', '#f85149', '#bc8cff', '#39c5cf', '#ff7b72', '#7ee787'];

  function loadDash() {
    api('/api/admin/overview').then(function (d) {
      $('stCardsTotal').textContent = d.cards.total;
      $('stCardsAvail').textContent = d.cards.available;
      $('stAmount').innerHTML = fmtMoney(d.orders.amount).replace('¥', '&yen;');
      $('stToday').innerHTML = fmtMoney(d.today.amount).replace('¥', '&yen;') +
        ' <span style="font-size:12px;color:var(--muted)">发卡 ' + d.today.issued + ' · 核销 ' + d.today.redeemed + ' · 调用 ' + (d.today.calls || 0) + '</span>';

      var b = d.bindings;
      $('bindStrip').innerHTML =
        '<span class="' + (b.db ? 'bind-ok' : 'bind-miss') + '">● D1 ' + (b.db ? '已绑定' : '未绑定') + '</span>' +
        '<span class="' + (b.r2 ? 'bind-ok' : 'bind-miss') + '">● R2 ' + (b.r2 ? '已绑定' : '未绑定（资源上传不可用）') + '</span>' +
        '<span class="' + (b.admin_secret ? 'bind-ok' : 'bind-miss') + '">● ADMIN_SECRET ' + (b.admin_secret ? '已配置' : '未配置') + '</span>' +
        '<span class="' + ((d.apikeys && d.apikeys.active > 0) ? 'bind-ok' : 'bind-miss') + '">● APIKEY ' + (d.apikeys ? d.apikeys.active + '/' + d.apikeys.total + ' 可用' : '0/0 可用') + (b.issue_apikey_env ? ' · 旧版 ISSUE_APIKEY 兼容中' : '') + '</span>';
    }).catch(function (e) { toast(e.message, true); });

    api('/api/admin/stats?days=30').then(function (d) { renderCharts(d); }).catch(function () {});
  }
  $('refreshDash').onclick = loadDash;

  function renderCharts(d) {
    if (typeof Chart === 'undefined') { toast('chart.js 加载失败', true); return; }
    Object.keys(state.charts).forEach(function (k) { state.charts[k].destroy(); });

    var gridColor = 'rgba(139,148,158,.15)';
    var tickColor = '#8b949e';
    var baseOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: tickColor, boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: tickColor, font: { size: 10 }, maxTicksLimit: 12 }, grid: { color: gridColor } },
        y: { ticks: { color: tickColor, font: { size: 10 } }, grid: { color: gridColor }, beginAtZero: true },
      },
    };

    state.charts.trend = new Chart($('chartTrend'), {
      type: 'line',
      data: {
        labels: d.labels,
        datasets: [
          { label: '发卡', data: d.issued, borderColor: '#3fb950', backgroundColor: 'rgba(63,185,80,.15)', fill: true, tension: .35, pointRadius: 2 },
          { label: '核销', data: d.redeemed, borderColor: '#d29922', backgroundColor: 'rgba(210,153,34,.12)', fill: true, tension: .35, pointRadius: 2 },
        ],
      },
      options: baseOpts,
    });

    state.charts.amount = new Chart($('chartAmount'), {
      type: 'bar',
      data: {
        labels: d.labels,
        datasets: [{ label: '金额 ¥', data: d.amount, backgroundColor: 'rgba(63,185,80,.55)', borderColor: '#3fb950', borderWidth: 1, borderRadius: 4 }],
      },
      options: JSON.parse(JSON.stringify(baseOpts)),
    });

    state.charts.calls = new Chart($('chartCalls'), {
      type: 'bar',
      data: {
        labels: d.labels,
        datasets: [{ label: '发卡调用', data: d.apikey_calls || [], backgroundColor: 'rgba(88,166,255,.45)', borderColor: '#58a6ff', borderWidth: 1, borderRadius: 4 }],
      },
      options: JSON.parse(JSON.stringify(baseOpts)),
    });

    var shareLabels = d.script_usage.map(function (x) { return x.name; });
    var shareData = d.script_usage.map(function (x) { return x.count; });
    state.charts.share = new Chart($('chartShare'), {
      type: 'doughnut',
      data: {
        labels: shareLabels.length ? shareLabels : ['暂无数据'],
        datasets: [{ data: shareData.length ? shareData : [1], backgroundColor: CHART_COLORS, borderWidth: 0 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { color: tickColor, boxWidth: 12, font: { size: 11 } } } },
      },
    });
  }

  /* ─────────── 分享链接解密（v1.0.3） ─────────── */
  $('decodeBtn').onclick = function () {
    var input = $('decodeInput').value.trim();
    if (!input) { toast('请输入 /s/ 加密链接或 token', true); return; }
    api('/api/admin/decode', { method: 'POST', body: JSON.stringify({ input: input }) })
      .then(function (d) {
        var box = $('decodeResult');
        box.style.display = 'block';
        var rows = [
          ['类型', d.type === 'p' ? '提取页链接（自带卡密）' : '资源下载链接（自带卡密）'],
          ['卡密', d.key || '-'],
          ['文件名', d.filename || '-'],
          ['指向', d.path || '-'],
          ['真实地址', d.real_url || '-'],
        ];
        box.innerHTML = '<h4>&#10003; 解密成功 · 点击值即可复制</h4>' + rows.map(function (r) {
          return '<div class="decode-row"><b>' + r[0] + '</b><code class="td-mono" title="点击复制" onclick="adminCopyText(this.textContent)">' + esc(r[1]) + '</code></div>';
        }).join('');
      })
      .catch(function (e) { toast(e.message, true); });
  };
  $('decodeClearBtn').onclick = function () {
    $('decodeInput').value = '';
    $('decodeResult').style.display = 'none';
    $('decodeResult').innerHTML = '';
  };
  window.adminCopyText = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制 ✓'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('已复制 ✓');
    }
  };

  /* ─────────── 资源管理 ─────────── */
  function loadScripts(page) {
    var q = $('scriptSearch').value.trim();
    api('/api/admin/scripts?page=' + page + '&size=' + state.scripts.size + '&q=' + encodeURIComponent(q))
      .then(function (d) {
        state.scripts.page = d.page;
        state.scripts.total = d.total;
        var tb = $('scriptTbody');
        if (!d.list.length) {
          tb.innerHTML = '<tr><td colspan="9" class="empty-row">还没有资源，点击右上角「上传资源」</td></tr>';
        } else {
          tb.innerHTML = d.list.map(function (s) {
            var isExt = /^https?:/i.test(s.path || '');
            return '<tr>' +
              '<td>' + esc(s.name) + '</td>' +
              '<td class="td-mono">' + esc(s.filename) + '</td>' +
              '<td>' + (isExt ? '<span class="tag yellow">外链</span> ' : '') + '<span class="tag ' + (s.type === 'ps1' ? 'green' : s.type === 'bat' || s.type === 'cmd' ? 'yellow' : 'gray') + '">' + esc(s.type) + '</span></td>' +
              '<td class="td-dim">' + (isExt ? '外部链接' : fmtSize(s.size)) + '</td>' +
              '<td class="td-path" title="' + esc(s.path) + '">' + esc(s.path) + '</td>' +
              '<td class="td-dim">' + s.card_count + ' 张</td>' +
              '<td><span class="tag ' + (s.status === 'active' ? 'green' : 'gray') + '">' + (s.status === 'active' ? '启用' : '停用') + '</span></td>' +
              '<td class="td-dim">' + fmtTime(s.created_at) + '</td>' +
              '<td><div class="row-actions">' +
                '<button class="btn-sm" onclick="adminRename(' + s.id + ',' + esc(JSON.stringify(s.name)) + ')">改名</button>' +
                (isExt
                  ? '<button class="btn-sm" onclick="adminReplaceUrl(' + s.id + ')">改链接</button>'
                  : '<button class="btn-sm" onclick="adminReplace(' + s.id + ')">换文件</button>') +
                '<button class="btn-sm" onclick="adminToggleScript(' + s.id + ',\'' + s.status + '\')">' + (s.status === 'active' ? '停用' : '启用') + '</button>' +
                '<button class="btn-sm danger" onclick="adminDeleteScript(' + s.id + ')">删除</button>' +
              '</div></td></tr>';
          }).join('');
        }
        renderPager($('scriptPager'), d.page, d.size, d.total, loadScripts);
      })
      .catch(function (e) { toast(e.message, true); });
  }
  $('scriptSearch').addEventListener('input', debounce(function () { loadScripts(1); }, 400));

  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  // 上传弹窗
  $('uploadBtn').onclick = function () {
    $('uploadModal').style.display = 'flex';
    $('dzFile').textContent = '';
    $('uploadName').value = '';
    state.uploadFile = null;
  };
  $('pickFileBtn').onclick = function () { $('fileInput').click(); };
  $('fileInput').onchange = function () { setUploadFile(this.files[0]); };
  var dz = $('dropZone');
  dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', function () { dz.classList.remove('dragover'); });
  dz.addEventListener('drop', function (e) {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (e.dataTransfer.files.length) setUploadFile(e.dataTransfer.files[0]);
  });
  function setUploadFile(f) {
    if (!f) return;
    // v1.0.3：任意类型资源，单个 ≤100MB
    if (f.size > 100 * 1024 * 1024) { toast('文件超过 100MB 上限', true); return; }
    state.uploadFile = f;
    $('dzFile').textContent = '✓ ' + f.name + '（' + fmtSize(f.size) + '）';
    if (!$('uploadName').value) $('uploadName').value = f.name;
  }
  $('doUploadBtn').onclick = function () {
    if (!state.uploadFile) { toast('请先选择资源文件', true); return; }
    var fd = new FormData();
    fd.append('file', state.uploadFile);
    fd.append('name', $('uploadName').value.trim());
    var btn = $('doUploadBtn');
    btn.disabled = true;
    btn.textContent = '上传中…';
    api('/api/admin/scripts', { method: 'POST', body: fd })
      .then(function () {
        toast('上传成功');
        $('uploadModal').style.display = 'none';
        loadScripts(1);
        loadScriptOptions();
      })
      .catch(function (e) { toast(e.message, true); })
      .finally(function () { btn.disabled = false; btn.textContent = '上传'; });
  };

  // 重命名
  window.adminRename = function (id, name) {
    state.renamingId = id;
    $('renameInput').value = name;
    $('renameModal').style.display = 'flex';
  };
  $('doRenameBtn').onclick = function () {
    var name = $('renameInput').value.trim();
    if (!name) { toast('名称不能为空', true); return; }
    api('/api/admin/scripts/' + state.renamingId, { method: 'PUT', body: JSON.stringify({ name: name }) })
      .then(function () {
        toast('已改名');
        $('renameModal').style.display = 'none';
        loadScripts(state.scripts.page);
        loadScriptOptions();
      })
      .catch(function (e) { toast(e.message, true); });
  };

  // 替换文件
  window.adminReplace = function (id) {
    var input = document.createElement('input');
    input.type = 'file';
    input.onchange = function () {
      if (!input.files.length) return;
      var fd = new FormData();
      fd.append('file', input.files[0]);
      api('/api/admin/scripts/' + id, { method: 'PUT', body: fd })
        .then(function () { toast('文件已替换（旧对象已删除）'); loadScripts(state.scripts.page); })
        .catch(function (e) { toast(e.message, true); });
    };
    input.click();
  };

  // 替换外链
  window.adminReplaceUrl = function (id) {
    var url = prompt('新的资源直链 URL（任意类型，可填 gh-proxy 加速地址）');
    if (!url || !url.trim()) return;
    api('/api/admin/scripts/' + id, { method: 'PUT', body: JSON.stringify({ url: url.trim() }) })
      .then(function () { toast('链接已更新'); loadScripts(state.scripts.page); loadScriptOptions(); })
      .catch(function (e) { toast(e.message, true); });
  };

  // 添加外链资源
  $('extLinkBtn').onclick = function () {
    var url = prompt('资源直链 URL（任意类型）\n可填 GitHub 地址配合配套 gh-proxy Worker 加速，例：\nhttps://你的worker.workers.dev/https://raw.githubusercontent.com/user/repo/main/payload.ps1');
    if (!url || !url.trim()) return;
    api('/api/admin/scripts', { method: 'POST', body: JSON.stringify({ url: url.trim() }) })
      .then(function () { toast('外链资源已添加'); loadScripts(1); loadScriptOptions(); })
      .catch(function (e) { toast(e.message, true); });
  };

  // 启停
  window.adminToggleScript = function (id, status) {
    api('/api/admin/scripts/' + id, { method: 'PUT', body: JSON.stringify({ status: status === 'active' ? 'disabled' : 'active' }) })
      .then(function () { toast('已更新'); loadScripts(state.scripts.page); })
      .catch(function (e) { toast(e.message, true); });
  };

  // 删除
  window.adminDeleteScript = function (id) {
    if (!confirm('删除资源会解绑其所有卡密并删除 R2 文件，确定？')) return;
    api('/api/admin/scripts/' + id, { method: 'DELETE' })
      .then(function () { toast('已删除'); loadScripts(state.scripts.page); loadScriptOptions(); })
      .catch(function (e) { toast(e.message, true); });
  };

  /* ─────────── 卡密管理 ─────────── */
  function loadScriptOptions() {
    return api('/api/admin/scripts?size=100').then(function (d) {
      state.scriptOptions = d.list;
      var html = d.list.map(function (s) {
        return '<option value="' + s.id + '">' + esc(s.name) + '（' + s.type + '）</option>';
      }).join('');
      $('genScript').innerHTML = html || '<option value="">—— 请先上传资源 ——</option>';
      return d;
    });
  }

  function loadCards(page) {
    var q = $('cardSearch').value.trim();
    var status = $('cardStatusFilter').value;
    api('/api/admin/cards?page=' + page + '&size=' + state.cards.size + '&q=' + encodeURIComponent(q) + '&status=' + status)
      .then(function (d) {
        state.cards.page = d.page;
        state.cards.total = d.total;
        var tb = $('cardTbody');
        if (!d.list.length) {
          tb.innerHTML = '<tr><td colspan="9" class="empty-row">暂无卡密</td></tr>';
        } else {
          tb.innerHTML = d.list.map(function (c) {
            var stTag = c.status === 'revoked'
              ? '<span class="tag red">已作废</span>'
              : (c.used_count >= c.max_uses ? '<span class="tag gray">已用完</span>' : '<span class="tag green">可用</span>');
            var order = c.order_title
              ? '<div>' + esc(c.order_title) + '</div><div class="td-dim">¥' + Number(c.order_price || 0).toFixed(2) + ' · ' +
                (c.order_status === 'used' ? '已使用' : '未使用') + '</div>'
              : '<span class="td-dim">-</span>';
            return '<tr>' +
              '<td><input type="checkbox" class="card-sel" data-id="' + c.id + '"' + (state.cards.selected.has(c.id) ? ' checked' : '') + '></td>' +
              '<td><span class="td-key" data-key="' + esc(c.card_key) + '" title="点击复制">' + esc(c.card_key) + '</span></td>' +
              '<td>' + (c.script_name ? esc(c.script_name) : '<span class="td-dim">未绑定</span>') + '</td>' +
              '<td class="td-dim">' + c.used_count + ' / ' + c.max_uses + '</td>' +
              '<td>' + stTag + '</td>' +
              '<td>' + order + '</td>' +
              '<td class="td-dim" title="' + esc(c.note) + '">' + esc((c.note || '').slice(0, 14)) + '</td>' +
              '<td class="td-dim">' + fmtTime(c.created_at) + '</td>' +
              '<td><div class="row-actions">' +
                (c.status === 'active'
                  ? '<button class="btn-sm danger" onclick="adminCardAct([' + c.id + '],\'revoke\')">作废</button>'
                  : '<button class="btn-sm" onclick="adminCardAct([' + c.id + '],\'restore\')">恢复</button>') +
                '<button class="btn-sm danger" onclick="adminCardAct([' + c.id + '],\'delete\')">删除</button>' +
              '</div></td></tr>';
          }).join('');
        }
        renderPager($('cardPager'), d.page, d.size, d.total, loadCards);
        updateBatchBar();
        // 事件绑定
        tb.querySelectorAll('.td-key').forEach(function (el) {
          el.onclick = function () { copyText(el.dataset.key, '卡密已复制：' + el.dataset.key); };
        });
        tb.querySelectorAll('.card-sel').forEach(function (el) {
          el.onchange = function () {
            var id = Number(el.dataset.id);
            if (el.checked) state.cards.selected.add(id);
            else state.cards.selected.delete(id);
            updateBatchBar();
          };
        });
      })
      .catch(function (e) { toast(e.message, true); });
  }
  $('cardSearch').addEventListener('input', debounce(function () { loadCards(1); }, 400));
  $('cardStatusFilter').onchange = function () { loadCards(1); };
  $('cardSelAll').onchange = function () {
    var checked = $('cardSelAll').checked;
    document.querySelectorAll('.card-sel').forEach(function (el) {
      el.checked = checked;
      var id = Number(el.dataset.id);
      if (checked) state.cards.selected.add(id);
      else state.cards.selected.delete(id);
    });
    updateBatchBar();
  };
  function updateBatchBar() {
    var n = state.cards.selected.size;
    $('cardBatchBar').style.display = n ? 'flex' : 'none';
    $('selCount').textContent = n;
  }
  document.querySelectorAll('#cardBatchBar .btn-sm').forEach(function (btn) {
    btn.onclick = function () { adminCardAct(Array.from(state.cards.selected), btn.dataset.act); };
  });
  window.adminCardAct = function (ids, action) {
    if (!ids.length) { toast('未选择卡密', true); return; }
    if (action === 'delete' && !confirm('删除后卡密与订单记录一并清除，确定？')) return;
    api('/api/admin/card-action', { method: 'POST', body: JSON.stringify({ ids: ids, action: action }) })
      .then(function () {
        toast('操作成功');
        state.cards.selected.clear();
        $('cardSelAll').checked = false;
        loadCards(state.cards.page);
      })
      .catch(function (e) { toast(e.message, true); });
  };

  // 生成卡密弹窗
  $('genCardBtn').onclick = function () {
    if (!state.scriptOptions.length) { toast('请先上传资源再生成卡密', true); return; }
    $('genModal').style.display = 'flex';
    $('genResult').style.display = 'none';
  };
  $('doGenBtn').onclick = function () {
    var btn = $('doGenBtn');
    btn.disabled = true;
    btn.textContent = '生成中…';
    api('/api/admin/cards', {
      method: 'POST',
      body: JSON.stringify({
        script_id: $('genScript').value,
        count: $('genCount').value,
        max_uses: $('genMaxUses').value,
        expires_hours: $('genExpires').value,
        title: $('genTitle').value.trim() || '后台生成',
        price: $('genPrice').value,
        note: $('genNote').value.trim(),
      }),
    })
      .then(function (d) {
        $('genResult').style.display = 'block';
        $('genResultCount').textContent = d.count;
        $('genKeys').innerHTML = d.keys.map(function (k) { return '<span data-k="' + k + '">' + k + '</span>'; }).join('');
        $('genKeys').querySelectorAll('span').forEach(function (el) {
          el.onclick = function () { copyText(el.dataset.k, '已复制：' + el.dataset.k); };
        });
        $('copyAllKeysBtn').onclick = function () { copyText(d.keys.join('\n'), '已复制 ' + d.keys.length + ' 张卡密'); };
        toast('已生成 ' + d.count + ' 张卡密');
        loadScriptOptions();
      })
      .catch(function (e) { toast(e.message, true); })
      .finally(function () { btn.disabled = false; btn.textContent = '生成'; });
  };

  /* ─────────── 订单 ─────────── */
  function loadOrders(page) {
    var q = $('orderSearch').value.trim();
    var source = $('orderSourceFilter').value;
    api('/api/admin/orders?page=' + page + '&size=' + state.orders.size + '&q=' + encodeURIComponent(q) + '&source=' + source)
      .then(function (d) {
        state.orders.page = d.page;
        state.orders.total = d.total;
        var tb = $('orderTbody');
        if (!d.list.length) {
          tb.innerHTML = '<tr><td colspan="6" class="empty-row">暂无订单 · 对接 /api/issue 后自动发货记录在此</td></tr>';
        } else {
          tb.innerHTML = d.list.map(function (o) {
            return '<tr>' +
              '<td class="td-dim">' + fmtTime(o.created_at) + '</td>' +
              '<td>' + esc(o.title) + '</td>' +
              '<td class="td-mono">' + fmtMoney(o.price) + '</td>' +
              '<td><span class="td-key" data-key="' + esc(o.card_key) + '">' + esc(o.card_key) + '</span></td>' +
              '<td><span class="tag ' + (o.status === 'used' ? 'green' : o.status === 'refunded' ? 'red' : 'yellow') + '">' +
                (o.status === 'used' ? '已使用' : o.status === 'refunded' ? '已退款' : '待使用') + '</span></td>' +
              '<td>' + (o.source === 'api'
                ? '<span class="tag green">' + esc(o.apikey_name || 'API') + '</span>'
                : '<span class="tag gray">后台</span>') + '</td>' +
              '</tr>';
          }).join('');
        }
        renderPager($('orderPager'), d.page, d.size, d.total, loadOrders);
        tb.querySelectorAll('.td-key').forEach(function (el) {
          el.onclick = function () { copyText(el.dataset.key, '卡密已复制'); };
        });
      })
      .catch(function (e) { toast(e.message, true); });
  }
  $('orderSearch').addEventListener('input', debounce(function () { loadOrders(1); }, 400));
  $('orderSourceFilter').onchange = function () { loadOrders(1); };

  /* ─────────── 设置 ─────────── */
  function loadSettings() {
    api('/api/admin/settings').then(function (d) {
      $('setTitle').value = d.site_title || '';
      $('setSiteUrl').value = d.site_url || '';
      var mode = document.querySelector('input[name=delivery][value=' + (d.delivery_mode || 'link') + ']');
      if (mode) mode.checked = true;
      $('setTemplate').value = d.command_template || '';
      $('setR2Cdn').value = d.r2_cdn_base || '';
      $('setGhProxy').value = d.gh_proxy_base || '';
      $('shareStatus').innerHTML = d.share_pwd_set
        ? '已设置提取码：仅手动输卡密的旧入口（/?key=）需要输入；/s/ 加密链接自带授权，无需提取码'
        : '未设置提取码：买家打开 /s/ 加密链接即自动核销，零输入';
      $('setSharePwd').value = '';
      $('legacyKeyNote').textContent = d.apikey_source === 'env'
        ? '检测到环境变量 ISSUE_APIKEY（旧版单密钥模式，仍兼容可用）；建议迁移到「APIKEY 管理」。'
        : '旧版后台单密钥仅作兑底兼容，建议使用「APIKEY 管理」创建多把可区分调用方的 key。';
      $('adminSecretStatus').innerHTML = d.admin_secret_env
        ? '<span class="bind-ok">● 已在 Pages 环境变量中配置</span>'
        : '<span class="bind-miss">● 未配置</span>';
      $('r2Status').textContent = d.r2_cdn_base
        ? '资源直链前缀：' + d.r2_cdn_base + '/<path>'
        : '未配置 CDN 域名：资源直链将走 /api/file/ 代理（占用 Functions 额度），建议配置 R2 自定义域或 r2.dev 域名';
    }).catch(function (e) { toast(e.message, true); });
  }

  $('saveSettingsBtn').onclick = function () {
    var sharePwd = $('setSharePwd').value;
    var body = {
      site_title: $('setTitle').value.trim(),
      site_url: $('setSiteUrl').value.trim(),
      delivery_mode: (document.querySelector('input[name=delivery]:checked') || {}).value || 'link',
      command_template: $('setTemplate').value,
      r2_cdn_base: $('setR2Cdn').value.trim(),
      gh_proxy_base: $('setGhProxy').value.trim(),
    };
    if (sharePwd === 'CLEAR') body.share_pwd = '';
    else if (sharePwd) body.share_pwd = sharePwd;
    var btn = $('saveSettingsBtn');
    btn.disabled = true;
    btn.textContent = '保存中…';
    api('/api/admin/settings', { method: 'POST', body: JSON.stringify(body) })
      .then(function () {
        toast('设置已保存');
        $('setSharePwd').value = '';
        loadSettings();
      })
      .catch(function (e) { toast(e.message, true); })
      .finally(function () { btn.disabled = false; btn.textContent = '保存设置'; });
  };

  /* ─────────── APIKEY 管理（v1.0.2） ─────────── */
  function loadApikeys(page) {
    var q = $('apikeySearch').value.trim();
    api('/api/admin/apikeys?page=' + page + '&size=' + state.apikeys.size + '&q=' + encodeURIComponent(q))
      .then(function (d) {
        state.apikeys.page = d.page;
        state.apikeys.total = d.total;
        var tb = $('apikeyTbody');
        if (!d.list.length) {
          tb.innerHTML = '<tr><td colspan="9" class="empty-row">还没有 APIKEY，点击右上角「新建 APIKEY」</td></tr>';
        } else {
          tb.innerHTML = d.list.map(function (k) {
            var shown = state.revealedKeys[k.id] || k.key;
            var expired = k.expired || (k.expires_at && k.expires_at < Date.now());
            var stTag = k.status === 'disabled'
              ? '<span class="tag gray">已停用</span>'
              : (expired ? '<span class="tag red">已过期</span>' : '<span class="tag green">启用中</span>');
            return '<tr>' +
              '<td>' + esc(k.name) + '</td>' +
              '<td><span class="td-key" data-kid="' + k.id + '" title="点击复制完整 APIKEY">' + esc(shown) + '</span></td>' +
              '<td>' + stTag + '</td>' +
              '<td class="td-dim">' + k.rate_limit + ' 次 / ' + k.rate_window + 's</td>' +
              '<td class="td-dim">' + (k.expires_at ? fmtTime(k.expires_at) : '永久') + '</td>' +
              '<td class="td-dim">' + k.order_count + ' 单 / ' + fmtMoney(k.order_amount) + '</td>' +
              '<td class="td-dim">' + k.calls + ' 次</td>' +
              '<td class="td-dim">' + (k.last_used_at ? fmtTime(k.last_used_at) : '从未') + '</td>' +
              '<td><div class="row-actions">' +
                '<button class="btn-sm" onclick="adminRevealKey(' + k.id + ')">查看</button>' +
                '<button class="btn-sm" onclick="adminToggleKey(' + k.id + ',\'' + k.status + '\')">' + (k.status === 'active' ? '停用' : '启用') + '</button>' +
                '<button class="btn-sm" onclick="adminKeyStats(' + k.id + ',\'' + esc(k.name) + '\')">统计</button>' +
                '<button class="btn-sm danger" onclick="adminDeleteKey(' + k.id + ',\'' + esc(k.name) + '\')">删除</button>' +
              '</div></td></tr>';
          }).join('');
        }
        renderPager($('apikeyPager'), d.page, d.size, d.total, loadApikeys);
        tb.querySelectorAll('.td-key').forEach(function (el) {
          el.onclick = function () { adminCopyKey(Number(el.dataset.kid)); };
        });
      })
      .catch(function (e) { toast(e.message, true); });
  }
  $('apikeySearch').addEventListener('input', debounce(function () { loadApikeys(1); }, 400));

  function fetchFullKey(id) {
    if (state.revealedKeys[id]) return Promise.resolve(state.revealedKeys[id]);
    return api('/api/admin/apikeys/' + id).then(function (d) {
      state.revealedKeys[id] = d.key;
      return d.key;
    });
  }
  window.adminRevealKey = function (id) {
    fetchFullKey(id).then(function () {
      loadApikeys(state.apikeys.page);
      toast('已显示完整 APIKEY');
    }).catch(function (e) { toast(e.message, true); });
  };
  window.adminCopyKey = function (id) {
    fetchFullKey(id).then(function (full) { copyText(full, '完整 APIKEY 已复制'); })
      .catch(function (e) { toast(e.message, true); });
  };
  window.adminToggleKey = function (id, status) {
    api('/api/admin/apikeys/' + id, { method: 'PUT', body: JSON.stringify({ status: status === 'active' ? 'disabled' : 'active' }) })
      .then(function () { toast('已更新'); loadApikeys(state.apikeys.page); })
      .catch(function (e) { toast(e.message, true); });
  };
  window.adminDeleteKey = function (id, name) {
    if (!confirm('删除 APIKEY「' + name + '」后调用立即失效，其调用统计一并清除，确定？')) return;
    api('/api/admin/apikeys/' + id, { method: 'DELETE' })
      .then(function () {
        toast('已删除');
        delete state.revealedKeys[id];
        loadApikeys(state.apikeys.page);
      })
      .catch(function (e) { toast(e.message, true); });
  };

  // 新建 APIKEY
  $('newKeyBtn').onclick = function () {
    $('apikeyModal').style.display = 'flex';
    $('keyResult').style.display = 'none';
    $('keyName').value = '';
    setTimeout(function () { $('keyName').focus(); }, 50);
  };
  $('doCreateKeyBtn').onclick = function () {
    var btn = $('doCreateKeyBtn');
    btn.disabled = true;
    btn.textContent = '创建中…';
    api('/api/admin/apikeys', {
      method: 'POST',
      body: JSON.stringify({
        name: $('keyName').value.trim(),
        expires_days: $('keyExpires').value,
        rate_limit: $('keyRateLimit').value,
        rate_window: $('keyRateWindow').value,
      }),
    })
      .then(function (d) {
        state.revealedKeys[d.id] = d.key;
        $('keyResult').style.display = 'block';
        $('keyResultBox').textContent = d.key;
        $('copyNewKeyBtn').onclick = function () { copyText(d.key, '完整 APIKEY 已复制'); };
        loadApikeys(1);
        toast('APIKEY 创建成功，请立即复制保存');
      })
      .catch(function (e) { toast(e.message, true); })
      .finally(function () { btn.disabled = false; btn.textContent = '创建'; });
  };

  // 调用统计弹窗
  window.adminKeyStats = function (id, name) {
    state.keyStatsId = id;
    $('keyStatsName').textContent = name;
    $('keyStatsDays').value = '7';
    $('keyStatsModal').style.display = 'flex';
    renderKeyStats(7);
  };
  $('keyStatsDays').onchange = function () { renderKeyStats(Number($('keyStatsDays').value)); };
  function renderKeyStats(days) {
    api('/api/admin/apikeys/' + state.keyStatsId + '/stats?days=' + days).then(function (d) {
      $('keyStatsMeta').innerHTML =
        '成功 <b>' + d.totals.ok + '</b> 次 · 失败 <span style="color:var(--danger)">' + d.totals.fail + '</span> 次 · ' +
        '发卡 <b>' + d.totals.orders + '</b> 单 · 成交 ' + fmtMoney(d.totals.revenue) +
        '<br>限速 ' + d.key.rate_limit + ' 次 / ' + d.key.rate_window + 's · 有效期至 ' +
        (d.key.expires_at ? fmtTime(d.key.expires_at) : '永久') +
        ' · 最后调用 ' + (d.key.last_used_at ? fmtTime(d.key.last_used_at) : '从未');
      if (typeof Chart === 'undefined') return;
      if (state.charts.keyCalls) state.charts.keyCalls.destroy();
      var gridColor = 'rgba(139,148,158,.15)';
      var tickColor = '#8b949e';
      state.charts.keyCalls = new Chart($('chartKeyCalls'), {
        type: 'bar',
        data: {
          labels: d.labels,
          datasets: [
            { label: '成功', data: d.ok_daily, backgroundColor: 'rgba(63,185,80,.55)', borderColor: '#3fb950', borderWidth: 1, borderRadius: 4, stack: 's' },
            { label: '失败/限速', data: d.fail_daily, backgroundColor: 'rgba(248,81,73,.55)', borderColor: '#f85149', borderWidth: 1, borderRadius: 4, stack: 's' },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: tickColor, boxWidth: 12, font: { size: 11 } } } },
          scales: {
            x: { stacked: true, ticks: { color: tickColor, font: { size: 10 }, maxTicksLimit: 10 }, grid: { color: gridColor } },
            y: { stacked: true, beginAtZero: true, ticks: { color: tickColor, font: { size: 10 }, precision: 0 }, grid: { color: gridColor } },
          },
        },
      });
    }).catch(function (e) { toast(e.message, true); });
  }

  /* ─────────── 弹窗通用关闭 ─────────── */
  document.querySelectorAll('.modal-mask').forEach(function (mask) {
    mask.addEventListener('click', function (e) {
      if (e.target === mask) mask.style.display = 'none';
    });
    mask.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.onclick = function () { mask.style.display = 'none'; };
    });
  });

  /* ─────────── 启动 ─────────── */
  bootstrap();
})();

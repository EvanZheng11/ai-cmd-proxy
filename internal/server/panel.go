package server

// panelHTML is the embedded admin panel (single file, no external assets)
const panelHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CommandCode Proxy 管理面板</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; background: #f5f5f7; color: #1d1d1f; min-height: 100vh; }
.container { max-width: 1080px; margin: 0 auto; padding: 24px; }
h1 { font-size: 22px; margin-bottom: 6px; display: flex; align-items: center; gap: 10px; }
h1 span { color: #0071e3; }
.subtitle { font-size: 13px; color: #86868b; margin-bottom: 20px; }

/* stats */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 24px; }
.stat-card { background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 16px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.stat-value { font-size: 28px; font-weight: 700; color: #0071e3; }
.stat-label { font-size: 12px; color: #86868b; margin-top: 4px; }
.stat-card.ok .stat-value { color: #34c759; }
.stat-card.warn .stat-value { color: #ff9500; }
.stat-card.err .stat-value { color: #ff3b30; }

/* tabs */
.tabs { display: flex; gap: 4px; margin-bottom: 20px; background: #fff; border-radius: 10px; padding: 4px; border: 1px solid #e5e5e5; flex-wrap: wrap; }
.tab { padding: 9px 18px; border-radius: 8px; border: none; background: transparent; color: #86868b; cursor: pointer; font-size: 14px; font-weight: 500; transition: all .2s; }
.tab.active { background: #0071e3; color: #fff; }
.tab:hover:not(.active) { background: #f0f0f0; }

/* actions */
.actions { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
input[type="text"], input[type="password"], input[type="number"] { background: #fff; border: 1px solid #d2d2d7; border-radius: 8px; padding: 9px 12px; color: #1d1d1f; font-size: 14px; flex: 1; min-width: 180px; }
input::placeholder { color: #aeaeb2; }
button { padding: 9px 16px; border-radius: 8px; border: 1px solid #d2d2d7; background: #fff; color: #1d1d1f; cursor: pointer; font-size: 13px; font-weight: 500; white-space: nowrap; transition: all .15s; }
button:hover { background: #f5f5f7; }
button.primary { background: #0071e3; border-color: #0071e3; color: #fff; }
button.primary:hover { background: #0077ed; }
button.danger { background: #ff3b30; border-color: #ff3b30; color: #fff; }
button.danger:hover { background: #ff453a; }
button.small { padding: 5px 10px; font-size: 12px; }

/* key list */
.key-list { display: flex; flex-direction: column; gap: 10px; }
.key-item { background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 14px 16px; display: flex; align-items: center; gap: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); flex-wrap: wrap; }
.key-item.cooling { border-color: #ff9500; }
.key-item.disabled { opacity: 0.55; background: #f9f9f9; }
.key-item.quota-disabled { border-color: #ff3b30; background: #fff5f5; }
.key-status { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.key-status.ok { background: #34c759; }
.key-status.cooling { background: #ff9500; animation: pulse 1.5s infinite; }
.key-status.disabled { background: #d2d2d7; }
.key-status.quota { background: #ff3b30; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
.key-info { flex: 1; min-width: 220px; }
.key-name { font-size: 14px; font-weight: 600; }
.key-hash { font-size: 12px; color: #86868b; font-family: 'SF Mono', Monaco, monospace; margin-top: 2px; }
.key-stats { display: flex; gap: 14px; margin-top: 5px; font-size: 12px; color: #86868b; flex-wrap: wrap; }
.key-actions { display: flex; gap: 6px; }

/* health */
.health-results { margin-top: 16px; }
.health-item { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; flex-wrap: wrap; }
.health-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.health-dot.ok { background: #34c759; }
.health-dot.rate_limited { background: #ff9500; }
.health-dot.auth_error, .health-dot.error, .health-dot.timeout { background: #ff3b30; }
.health-dot.disabled { background: #d2d2d7; }

/* models */
.model-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
.model-card { background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 16px; transition: all .2s; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.model-card:hover { border-color: #0071e3; box-shadow: 0 2px 8px rgba(0,113,227,0.1); transform: translateY(-2px); }
.model-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; }
.model-name { font-size: 15px; font-weight: 600; word-break: break-all; }
.model-vendor { font-size: 11px; color: #0071e3; background: #eef4ff; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
.model-id { font-size: 12px; color: #86868b; font-family: 'SF Mono', Monaco, monospace; margin-bottom: 8px; word-break: break-all; }
.model-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.model-tag { background: #f0f0f0; padding: 3px 8px; border-radius: 6px; font-size: 11px; color: #1d1d1f; }

/* sync bar */
.sync-bar { display: flex; align-items: center; gap: 12px; background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; color: #86868b; flex-wrap: wrap; }
.sync-bar .badge { padding: 2px 10px; border-radius: 10px; font-size: 12px; font-weight: 600; }
.sync-bar .badge.ok { background: #e8f8ee; color: #1d9a50; }
.sync-bar .badge.error { background: #ffecec; color: #d63031; }

/* settings */
.settings { background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 20px; max-width: 640px; }
.set-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid #f0f0f0; flex-wrap: wrap; }
.set-row:last-child { border-bottom: none; }
.set-label { font-size: 14px; font-weight: 500; }
.set-desc { font-size: 12px; color: #86868b; margin-top: 2px; }
.set-input { width: 140px; }

/* toast */
.toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 10px; font-size: 14px; font-weight: 500; z-index: 999; animation: slideIn .3s; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
.toast.ok { background: #34c759; color: #fff; }
.toast.err { background: #ff3b30; color: #fff; }
@keyframes slideIn { from { transform: translateX(100px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
.empty { color: #86868b; text-align: center; padding: 36px; background: #fff; border-radius: 12px; border: 1px dashed #d2d2d7; }
</style>
</head>
<body>
<div class="container">
  <h1>⚡ <span>CommandCode Proxy</span> 管理面板</h1>
  <div class="subtitle">多 Key 轮询 · 自动冷却 · 模型自动同步 · 兼容 OpenAI API</div>

  <div class="stats" id="stats">
    <div class="stat-card"><div class="stat-value" id="s-total">-</div><div class="stat-label">总 Key</div></div>
    <div class="stat-card ok"><div class="stat-value" id="s-available">-</div><div class="stat-label">可用</div></div>
    <div class="stat-card warn"><div class="stat-value" id="s-cooling">-</div><div class="stat-label">冷却中</div></div>
    <div class="stat-card err"><div class="stat-value" id="s-quota">-</div><div class="stat-label">限额禁用</div></div>
    <div class="stat-card"><div class="stat-value" id="s-models">-</div><div class="stat-label">模型</div></div>
    <div class="stat-card err"><div class="stat-value" id="s-errors">-</div><div class="stat-label">总错误</div></div>
  </div>

  <div class="tabs">
    <button class="tab active" onclick="switchTab('keys',this)">🔑 Key 管理</button>
    <button class="tab" onclick="switchTab('models',this)">📦 可用模型</button>
    <button class="tab" onclick="switchTab('settings',this)">⚙️ 设置</button>
  </div>

  <div id="tab-keys">
    <div class="actions">
      <input type="text" id="newKey" placeholder="输入新的 API Key (user_...)">
      <input type="text" id="newName" placeholder="备注名（可选）" style="max-width:150px">
      <button class="primary" onclick="addKey()">添加 Key</button>
      <button onclick="healthCheck()">🩺 一键检测</button>
    </div>
    <div class="key-list" id="keyList"></div>
    <div class="health-results" id="healthResults"></div>
  </div>

  <div id="tab-models" style="display:none">
    <div class="sync-bar" id="syncBar">加载中...</div>
    <div class="model-grid" id="modelGrid"></div>
  </div>

  <div id="tab-settings" style="display:none">
    <div class="settings" id="settingsForm">加载中...</div>
  </div>
</div>

<script>
function switchTab(tab, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-keys').style.display = tab === 'keys' ? 'block' : 'none';
  document.getElementById('tab-models').style.display = tab === 'models' ? 'block' : 'none';
  document.getElementById('tab-settings').style.display = tab === 'settings' ? 'block' : 'none';
  if (tab === 'models') loadModels();
  if (tab === 'settings') loadSettings();
}

async function load() {
  try {
    const resp = await fetch('/api/keys');
    const data = await resp.json();
    renderStats(data.stats);
    renderKeys(data.keys);
  } catch(e) { toast('加载失败: ' + e.message, true); }
  try {
    const resp = await fetch('/api/stats');
    const data = await resp.json();
    document.getElementById('s-models').textContent = data.models_count;
  } catch(e) {}
}

function renderStats(s) {
  document.getElementById('s-total').textContent = s.total;
  document.getElementById('s-available').textContent = s.available;
  document.getElementById('s-cooling').textContent = s.cooling;
  document.getElementById('s-quota').textContent = s.disabled_by_quota || 0;
  document.getElementById('s-errors').textContent = s.total_errors;
}

function renderKeys(keys) {
  const list = document.getElementById('keyList');
  if (!keys.length) { list.innerHTML = '<div class="empty">暂无 Key，请在上方添加</div>'; return; }
  list.innerHTML = keys.map(k => {
    let cls = 'key-item';
    if (!k.enabled || k.disabled_reason === 'manual') cls += ' disabled';
    else if (k.disabled_reason) cls += ' quota-disabled';
    else if (k.is_cooling) cls += ' cooling';
    let sc = 'ok', sl = '✅ 可用';
    if (!k.enabled || k.disabled_reason === 'manual') { sc = 'disabled'; sl = '⏸ 手动禁用'; }
    else if (k.disabled_reason === '5h_quota') { sc = 'quota'; sl = '⛔ 5h 限额'; }
    else if (k.disabled_reason === 'period_quota') { sc = 'quota'; sl = '⛔ 周期限额'; }
    else if (k.is_cooling) { sc = 'cooling'; sl = '⏳ 冷却'; }
    const left = k.is_cooling ? Math.max(0, Math.round(k.cooldown_left)) : 0;
    const btn = k.disabled_reason ? '手动恢复' : (k.enabled ? '禁用' : '启用');
    return '<div class="' + cls + '">' +
      '<div class="key-status ' + sc + '"></div>' +
      '<div class="key-info">' +
        '<div class="key-name">' + esc(k.name) + ' <span style="font-size:12px;color:#86868b;font-weight:400">' + sl + '</span></div>' +
        '<div class="key-hash">' + esc(k.short_key || k.key) + '</div>' +
        '<div class="key-stats">' +
          '<span>📊 ' + k.request_count + ' 次</span>' +
          '<span>❌ ' + k.error_count + ' 次</span>' +
          (k.is_cooling ? '<span>⏳ ' + left + 's</span>' : '') +
          (k.last_error ? '<span title="' + esc(k.last_error) + '">⚠️ ' + esc(k.last_error).substring(0, 40) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="key-actions">' +
        '<button class="small" onclick="toggleKey(\'' + escJS(k.key) + '\')">' + btn + '</button>' +
        '<button class="small danger" onclick="removeKey(\'' + escJS(k.key) + '\',\'' + escJS(k.name) + '\')">删除</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function addKey() {
  const key = document.getElementById('newKey').value.trim();
  const name = document.getElementById('newName').value.trim();
  if (!key) return toast('请输入 Key', true);
  try {
    const resp = await fetch('/api/keys', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({key, name})
    });
    const data = await resp.json();
    if (data.ok) { toast('添加成功'); document.getElementById('newKey').value=''; document.getElementById('newName').value=''; load(); }
    else toast(data.error || '添加失败', true);
  } catch(e) { toast('添加失败: ' + e.message, true); }
}

async function removeKey(key, name) {
  if (!confirm('确认删除 ' + name + '？')) return;
  try {
    const resp = await fetch('/api/keys/' + encodeURIComponent(key), {method:'DELETE'});
    const data = await resp.json();
    if (data.ok) { toast('已删除'); load(); } else toast(data.error, true);
  } catch(e) { toast('删除失败', true); }
}

async function toggleKey(key) {
  try {
    const resp = await fetch('/api/keys/' + encodeURIComponent(key), {method:'PUT'});
    const data = await resp.json();
    if (data.ok) { toast('已切换'); load(); } else toast(data.error, true);
  } catch(e) { toast('操作失败', true); }
}

async function healthCheck() {
  const div = document.getElementById('healthResults');
  div.innerHTML = '<div style="color:#86868b;padding:16px;background:#fff;border-radius:12px">检测中...（每个 Key 约 1-3 秒）</div>';
  try {
    const resp = await fetch('/api/health');
    const data = await resp.json();
    const map = {ok:'✅ 可用',rate_limited:'⚠️ 限流',auth_error:'❌ 认证失败',error:'❌ 异常',timeout:'⏱ 超时',disabled:'⏸ 已禁用'};
    div.innerHTML = '<h3 style="margin-bottom:10px;font-size:15px">🩺 检测结果</h3>' +
      data.results.map(r =>
        '<div class="health-item"><div class="health-dot ' + r.status + '"></div>' +
        '<span style="flex:1">' + esc(r.name) + ' <span style="color:#86868b;font-size:12px">' + esc(r.key) + '</span></span>' +
        '<span>' + (map[r.status]||r.status) + (r.detail ? ' (' + esc(r.detail) + ')' : '') + '</span>' +
        '<span style="color:#86868b">' + r.latency_ms + 'ms</span></div>'
      ).join('');
    load();
  } catch(e) { div.innerHTML = '<div style="color:#ff3b30;padding:16px">检测失败: ' + e.message + '</div>'; }
}

async function loadModels() {
  try {
    const resp = await fetch('/api/models');
    const data = await resp.json();
    const st = data.status;
    const badge = st.last_result === 'error' ? '<span class="badge error">同步失败</span>' : '<span class="badge ok">已同步</span>';
    const last = st.last_sync ? new Date(st.last_sync).toLocaleString('zh-CN') : '从未同步';
    document.getElementById('syncBar').innerHTML =
      badge + '<span>模型数: <b>' + data.models.length + '</b></span>' +
      '<span>上次同步: ' + last + '</span>' +
      (st.last_message ? '<span>' + esc(st.last_message) + '</span>' : '') +
      '<button class="small" onclick="syncModels()">🔄 立即同步</button>';
    const grid = document.getElementById('modelGrid');
    if (!data.models.length) { grid.innerHTML = '<div class="empty">暂无模型</div>'; return; }
    grid.innerHTML = data.models.map(m =>
      '<div class="model-card">' +
        '<div class="model-header"><span class="model-name">' + esc(m.name) + '</span>' +
        '<span class="model-vendor">' + esc(m.vendor) + '</span></div>' +
        '<div class="model-id">' + esc(m.id) + '</div>' +
        '<div class="model-tags">' +
          '<span class="model-tag">短名: ' + esc(m.short_name) + '</span>' +
          '<span class="model-tag">' + (m.source === 'synced' ? '🔄 自动同步' : '内置') + '</span>' +
        '</div>' +
      '</div>'
    ).join('');
  } catch(e) { document.getElementById('syncBar').innerHTML = '加载失败: ' + e.message; }
}

async function syncModels() {
  try {
    const resp = await fetch('/api/models/sync', {method:'POST'});
    const data = await resp.json();
    if (data.ok) { toast('同步成功: ' + data.count + ' 个模型'); loadModels(); load(); }
    else toast(data.error || '同步失败', true);
  } catch(e) { toast('同步失败: ' + e.message, true); }
}

async function loadSettings() {
  try {
    const resp = await fetch('/api/config');
    const cfg = await resp.json();
    document.getElementById('settingsForm').innerHTML =
      row('监听地址', 'host', cfg.host, '0.0.0.0 允许局域网访问，127.0.0.1 仅本机') +
      row('监听端口', 'port', cfg.port, '重启后生效') +
      row('上游地址', 'upstream_base', cfg.upstream_base, 'CommandCode API 地址') +
      row('冷却时间(秒)', 'cooldown_seconds', cfg.cooldown_seconds, 'Key 429 后的冷却时长') +
      row('模型同步间隔(小时)', 'sync_interval_hours', cfg.sync_interval_hours, '0 表示关闭自动同步') +
      toggleRow('调试日志', 'debug', cfg.debug, '打印完整请求/响应事件流') +
      toggleRow('自动禁用', 'auto_disable_enabled', cfg.auto_disable.enabled, '连续冷却即错自动禁用 Key') +
      '<div style="margin-top:16px"><button class="primary" onclick="saveSettings()">保存设置</button></div>';
  } catch(e) { document.getElementById('settingsForm').innerHTML = '加载失败: ' + e.message; }
}

function row(label, key, value, desc) {
  return '<div class="set-row"><div><div class="set-label">' + label + '</div><div class="set-desc">' + desc + '</div></div>' +
    '<input class="set-input" type="text" id="set-' + key + '" value="' + esc(String(value)) + '"></div>';
}
function toggleRow(label, key, value, desc) {
  return '<div class="set-row"><div><div class="set-label">' + label + '</div><div class="set-desc">' + desc + '</div></div>' +
    '<input type="checkbox" id="set-' + key + '" ' + (value ? 'checked' : '') + ' style="width:18px;height:18px"></div>';
}

async function saveSettings() {
  const body = {
    host: document.getElementById('set-host').value,
    port: document.getElementById('set-port').value,
    upstream_base: document.getElementById('set-upstream_base').value,
    cooldown_seconds: parseInt(document.getElementById('set-cooldown_seconds').value) || 300,
    sync_interval_hours: parseInt(document.getElementById('set-sync_interval_hours').value) || 0,
    debug: document.getElementById('set-debug').checked,
    auto_disable: { enabled: document.getElementById('set-auto_disable_enabled').checked }
  };
  try {
    const resp = await fetch('/api/config', {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (data.ok) toast('已保存（部分设置重启后生效）');
    else toast(data.error || '保存失败', true);
  } catch(e) { toast('保存失败: ' + e.message, true); }
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escJS(s) { return String(s == null ? '' : s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast ' + (isErr ? 'err' : 'ok');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
load();
</script>
</body>
</html>
`

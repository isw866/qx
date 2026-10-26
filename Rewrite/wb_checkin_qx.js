/**
 * WorkBuddy (腾讯 CodeBuddy) 每日签到 — QuantumultX 版
 *
 * 移植自 Python 项目: https://github.com/Cat-zaizai/ZaiZaiCat-Checkin/tree/main/script/workbuddy
 * 接口实现与官方客户端 / cockpit-tools 保持一致:
 *   - 签到状态: POST /v2/billing/meter/checkin-activity-status (失败回退 /v2/billing/meter/checkin-status)
 *   - 每日签到: POST /v2/billing/meter/daily-checkin
 *   - 刷新令牌: POST /v2/plugin/auth/token/refresh (请求头 X-Refresh-Token)
 *
 * ========================= QuantumultX 配置 =========================
 *
 * 一、定时签到 (必需), 在 [task_local] 中添加 (URL 换成你实际托管的脚本地址):
 *   0 9 * * * https://raw.githubusercontent.com/你的用户名/你的仓库/main/wb_checkin_qx.js, tag=WorkBuddy签到, enabled=true
 *
 * 二、自动抓取令牌 (可选但推荐), 在 [rewrite_local] 中添加 (同一脚本地址):
 *   ^https?:\/\/(www\.)?codebuddy\.cn url script-request-header https://你的脚本地址/wb_checkin_qx.js
 *   并在 [mitm] 中追加 hostname (与已有 hostname 逗号合并, 勿覆盖):
 *   hostname = www.codebuddy.cn
 *   开启 MITM 并安装信任 QX 证书后, 用 Safari 访问 https://www.codebuddy.cn 登录,
 *   弹出「令牌捕获成功」通知即完成配置, 无需手动抓包。
 *   ⚠️ 脚本地址务必用 iPhone 上可达的 URL (在 Safari 里能直接打开看到源码)。
 *      raw.githubusercontent.com 在国内经常无法访问, 推荐用 jsDelivr:
 *      https://cdn.jsdelivr.net/gh/用户名/仓库名@main/wb_checkin_qx.js
 *      或将脚本放入 iCloud「Quantumult X/Scripts」后用本地文件名引用。
 *
 * ========================= 账号配置 (二选一) =========================
 * 方式A: 抓包捕获 —— 见上文第二步, 令牌自动写入 QX 持久化存储, 多账号可分别登录捕获。
 * 方式B: 手动填写 —— 在下方 MANUAL_ACCOUNTS 中粘贴账号信息 (可从桌面端
 *        ZaiZaiCat-Checkin 的 config/token.json 中直接复制账号对象)。
 * ====================================================================
 *
 * 与 Python 版的差异:
 *   - 配置/令牌回写走 QX 持久化存储 (key: wb_checkin_accounts), 不依赖 config 文件
 *   - 结果推送走 QX 本地通知 ($notify)
 *   - 无启动错峰 jitter; 多账号间隔缩短为 1.5~3s (QX 脚本有总时长限制, 可自行调整)
 */

'use strict';

/* ==================== 使用前配置区 ==================== */

// 方式B: 手动填写账号 (方式A 抓包捕获则留空即可)
const MANUAL_ACCOUNTS = [
  // {
  //   account_name: '主号',
  //   access_token: '你的访问令牌',
  //   refresh_token: '你的刷新令牌(强烈建议填写, 过期可自动续期)',
  //   uid: '你的用户ID',
  //   enterprise_id: '',
  //   domain: '',
  // },
];

// 运行参数
const CFG = {
  baseUrl: 'https://www.codebuddy.cn',
  // 网关会拒绝缺少浏览器 UA 的请求 (403 / code=10085), 与官方客户端保持一致
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  timeout: 12000,   // 单请求超时 (ms)
  delayMin: 1500,   // 多账号随机间隔下限 (ms)
  delayMax: 3000,   // 多账号随机间隔上限 (ms), 对应 Python 版 5-10s, QX 有限时故缩短
  notify: true,     // 结束后弹本地通知
  captureDebug: true, // 排障开关: 改为 true 后, Safari 访问 codebuddy.cn 每个被 QX 拦截的请求都会弹调试通知
                       // (会提示 rewrite/MITM 是否生效、请求里有没有 Authorization), 排查完务必改回 false
};

/* ================ 以下为脚本主体, 一般无需修改 ================ */

const STORE_KEY = 'wb_checkin_accounts';

// 签到状态接口, 按顺序尝试, 前者失败时回退到后者 (对齐 api.py CHECKIN_STATUS_PATHS)
const CHECKIN_STATUS_PATHS = [
  '/v2/billing/meter/checkin-activity-status',
  '/v2/billing/meter/checkin-status',
];
const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin';
const TOKEN_REFRESH_PATH = '/v2/plugin/auth/token/refresh';

/* ---------- QX / Surge 兼容层 ---------- */

function storeGet(key) {
  try {
    if (typeof $prefs !== 'undefined' && $prefs && $prefs.valueForKey) return $prefs.valueForKey(key) || null;
    if (typeof $persistentStore !== 'undefined' && $persistentStore) return $persistentStore.read(key);
  } catch (e) { /* ignore */ }
  return null;
}

function storeSet(value, key) {
  try {
    if (typeof $prefs !== 'undefined' && $prefs && $prefs.setValueForKey) return $prefs.setValueForKey(value, key);
    if (typeof $persistentStore !== 'undefined' && $persistentStore) return $persistentStore.write(value, key);
  } catch (e) { /* ignore */ }
  return false;
}

function notify(title, subtitle, content) {
  try {
    if (typeof $notify !== 'undefined') {
      $notify(title, subtitle || '', content || '');
    } else if (typeof $notification !== 'undefined' && $notification && $notification.post) {
      $notification.post(title, subtitle || '', content || '');
    }
  } catch (e) { /* ignore */ }
}

function log(msg) { try { console.log(String(msg)); } catch (e) { /* ignore */ } }

/* ---------- 通用工具 (对齐 api.py _pick_bool / _pick_int) ---------- */

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// 宽松读取布尔值, 兼容 true/1/'true' 等写法
function pickBool(data, snake, camel, dft) {
  if (!data || typeof data !== 'object') return dft;
  const raw = data[snake] !== undefined ? data[snake] : data[camel];
  if (raw === undefined || raw === null) return dft;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return dft;
}

// 宽松读取整数值, 兼容下划线和驼峰命名
function pickInt(data, snake, camel) {
  if (!data || typeof data !== 'object') return null;
  const raw = data[snake] !== undefined ? data[snake] : data[camel];
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'boolean') return null;
  if (typeof raw === 'number' && isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string') {
    const s = raw.trim().replace(/^-/, '');
    if (/^\d+$/.test(s)) return parseInt(raw.trim(), 10);
  }
  return null;
}

/* ---------- 账号存储 ---------- */

function loadStored() {
  const raw = storeGet(STORE_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveStored(list) { return storeSet(JSON.stringify(list), STORE_KEY); }

function sameAccount(a, b) {
  if (!a || !b) return false;
  if (a.uid && b.uid) return String(a.uid) === String(b.uid);
  if (a.access_token && b.access_token) return a.access_token === b.access_token;
  return !!a.account_name && a.account_name === b.account_name;
}

// 合并账号: 持久化存储里的令牌更新鲜, 优先; 再补充手动配置中不重复的账号 (按 uid/令牌去重)
function mergeAccounts() {
  const merged = [];
  const push = (acc) => {
    if (acc && acc.access_token && !merged.some((x) => sameAccount(x, acc))) merged.push(acc);
  };
  loadStored().forEach(push);
  (Array.isArray(MANUAL_ACCOUNTS) ? MANUAL_ACCOUNTS : []).forEach(push);
  return merged;
}

// 令牌刷新后回写持久化存储 (对齐 main.py _save_refreshed_token)
function persistRefreshed(acc) {
  try {
    const list = loadStored();
    const idx = list.findIndex((x) => sameAccount(x, acc));
    if (idx >= 0) {
      list[idx].access_token = acc.access_token;
      if (acc.refresh_token) list[idx].refresh_token = acc.refresh_token;
      if (acc.domain) list[idx].domain = acc.domain;
      if (acc.uid && !list[idx].uid) list[idx].uid = acc.uid;
      if (acc.account_name && !list[idx].account_name) list[idx].account_name = acc.account_name;
    } else {
      list.push({
        account_name: acc.account_name || '账号' + (acc.uid ? String(acc.uid).slice(-4) : String(list.length + 1)),
        access_token: acc.access_token,
        refresh_token: acc.refresh_token || '',
        uid: acc.uid || '',
        enterprise_id: acc.enterprise_id || '',
        domain: acc.domain || '',
      });
    }
    saveStored(list);
    log('💾 新令牌已写回本地存储');
  } catch (e) {
    log('⚠️ 回写令牌失败: ' + e);
  }
}

/* ---------- 请求层 (对齐 api.py WorkBuddyAPI) ---------- */

// 构造请求头, 与官方 buildHeaders(session) 对齐
function buildHeaders(acc) {
  const headers = {
    'Authorization': 'Bearer ' + acc.access_token,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': acc.user_agent || CFG.userAgent,
  };
  if (acc.uid) headers['X-User-Id'] = String(acc.uid);
  if (acc.enterprise_id) {
    headers['X-Enterprise-Id'] = String(acc.enterprise_id);
    headers['X-Tenant-Id'] = String(acc.enterprise_id);
  }
  if (acc.domain) headers['X-Domain'] = String(acc.domain);
  return headers;
}

function errString(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch (x) { return String(e); }
}

// 解析响应, 对齐 api.py _post: 仅 401 视为令牌失效; code==0 视为成功
function analyzeResponse(path, resp) {
  if (String(resp.statusCode) === '401') {
    return { success: false, error: '令牌已失效 (http=401)', error_type: 'token_expired' };
  }

  let body;
  try {
    body = JSON.parse(resp.body);
  } catch (e) {
    return {
      success: false,
      error: '解析 ' + path + ' 响应失败: ' + String(resp.body || '').slice(0, 200),
      error_type: 'parse',
    };
  }

  const message = body.message || body.msg || 'unknown error';
  const status = Number(resp.statusCode) || 0;
  if (status < 200 || status >= 300) {
    return {
      success: false,
      error: '请求 ' + path + ' 失败 (http=' + status + '): ' + message,
      error_type: 'http',
    };
  }

  const code = body.code === undefined ? -1 : body.code;
  if (code !== 0) {
    let error_type = 'business';
    const m = String(message);
    if (code === 401 || m.indexOf('登录') >= 0 || m.toLowerCase().indexOf('token') >= 0) {
      error_type = 'token_expired';
    }
    return { success: false, error: message + ' (code=' + code + ')', error_type: error_type, code: code, body: body };
  }

  if (body.data === undefined) {
    return { success: false, error: path + ' 响应缺少 data 字段', error_type: 'parse' };
  }
  return { success: true, data: body.data || {} };
}

function post(acc, path, extraHeaders) {
  return new Promise((resolve) => {
    const headers = buildHeaders(acc);
    if (extraHeaders) {
      for (const k in extraHeaders) headers[k] = extraHeaders[k];
    }
    const opts = {
      url: CFG.baseUrl + path,
      method: 'POST',
      headers: headers,
      body: '{}',
      timeout: CFG.timeout,
    };
    $task.fetch(opts).then(
      (resp) => resolve(analyzeResponse(path, resp)),
      (err) => resolve({
        success: false,
        error: '请求 ' + path + ' 失败: ' + errString(err),
        error_type: 'network',
      })
    );
  });
}

// 使用 refresh_token 换取新 access_token (对齐 api.py refresh_access_token)
async function refreshAccessToken(acc) {
  if (!acc.refresh_token) {
    return { success: false, error: '账号未配置 refresh_token，无法自动续期' };
  }
  const result = await post(acc, TOKEN_REFRESH_PATH, { 'X-Refresh-Token': acc.refresh_token });
  if (!result.success) {
    return { success: false, error: result.error || '刷新令牌失败' };
  }
  const data = result.data || {};
  const newAccess = data.accessToken || data.access_token;
  if (!newAccess) {
    return { success: false, error: '刷新响应中缺少 accessToken' };
  }
  acc.access_token = newAccess;
  acc.refresh_token = data.refreshToken || data.refresh_token || acc.refresh_token;
  acc.domain = data.domain || acc.domain;
  acc._refreshed = true;
  log('🔄 访问令牌已刷新');
  return { success: true, access_token: acc.access_token, refresh_token: acc.refresh_token, domain: acc.domain };
}

// POST + 令牌过期自动刷新重试一次 (对齐 api.py _post_with_retry)
async function postWithRetry(acc, path) {
  const result = await post(acc, path);
  if (result.success || result.error_type !== 'token_expired') return result;
  if (!acc.refresh_token) return result;
  log('⚠️ 令牌已过期，尝试自动刷新...');
  const rf = await refreshAccessToken(acc);
  if (!rf.success) {
    return { success: false, error: '令牌过期且刷新失败: ' + rf.error, error_type: 'token_expired' };
  }
  return post(acc, path);
}

// 查询今日签到状态, 优先 activity-status, 失败回退 checkin-status (对齐 api.py get_checkin_status)
async function getCheckinStatus(acc) {
  const errors = [];
  for (const path of CHECKIN_STATUS_PATHS) {
    const result = await postWithRetry(acc, path);
    if (result.success) return parseCheckinStatus(result.data);
    errors.push(result.error || '未知错误');
    // 令牌问题无需继续回退, 直接返回
    if (result.error_type === 'token_expired') {
      return { success: false, error: result.error, error_type: 'token_expired' };
    }
  }
  return { success: false, error: '查询签到状态失败: ' + errors.join(' | '), error_type: 'api' };
}

// 解析签到状态数据, 兼容下划线与驼峰命名 (对齐 api.py _parse_checkin_status)
function parseCheckinStatus(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  return {
    success: true,
    // 缺省按已激活处理: 有 data 即认为活动可用, 显式 false 才视为关闭
    active: pickBool(data, 'active', 'Active', true),
    today_checked_in: pickBool(data, 'today_checked_in', 'todayCheckedIn', false),
    streak_days: pickInt(data, 'streak_days', 'streakDays') || 0,
    daily_credit: pickInt(data, 'daily_credit', 'dailyCredit') || 0,
    today_credit: pickInt(data, 'today_credit', 'todayCredit'),
    next_streak_day: pickInt(data, 'next_streak_day', 'nextStreakDay'),
    is_streak_day: pickBool(data, 'is_streak_day', 'isStreakDay', false),
    streak_bonus_days: pickInt(data, 'streak_bonus_days', 'streakBonusDays'),
    streak_bonus_credit: pickInt(data, 'streak_bonus_credit', 'streakBonusCredit'),
    checkin_dates: data.checkin_dates || data.checkinDates || [],
  };
}

// 执行每日签到 (对齐 api.py daily_checkin)
async function dailyCheckin(acc) {
  const result = await postWithRetry(acc, DAILY_CHECKIN_PATH);
  if (!result.success) {
    // code != 0 属于业务错误 (如今日已签到), 保留原始信息交由上层判断
    return { success: false, error: result.error || '签到失败', error_type: result.error_type || 'api' };
  }
  let data = result.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};

  // code == 0 时若未显式返回 success 字段, 默认视为成功
  const success = data.success === undefined ? true : !!data.success;
  let credit = pickInt(data, 'credit', 'today_credit');
  if (credit === null) credit = pickInt(data, 'todayCredit', 'credit');

  return {
    success: success,
    message: data.message || (success ? '签到成功' : '签到失败'),
    credit: credit,
    streak_days: pickInt(data, 'streak_days', 'streakDays'),
    is_streak_day: pickBool(data, 'is_streak_day', 'isStreakDay', false),
    next_checkin_in: pickInt(data, 'next_checkin_in', 'nextCheckinIn'),
    reward: data.reward,
  };
}

/* ---------- 业务流程 (对齐 main.py process_account / run) ---------- */

async function processAccount(acc) {
  const account_name = acc.account_name || acc.email || '未命名账号';
  const result = {
    account_name: account_name,
    success: false,
    message: '',
    already_checked: false,
    credit: null,
    streak_days: null,
  };

  try {
    log('====== 开始处理账号: ' + account_name + ' ======');
    if (!acc.access_token) {
      result.message = '账号配置中缺少 access_token';
      log('❌ ' + account_name + ': ' + result.message);
      return result;
    }

    // 查询签到状态
    const status = await getCheckinStatus(acc);
    if (!status.success) {
      const msg = status.error || '查询签到状态失败';
      result.message = status.error_type === 'token_expired' ? msg + '，请重新导入账号' : msg;
      log('❌ ' + account_name + ' ' + result.message);
      return result;
    }

    log('📊 连签天数: ' + (status.streak_days || 0) + ' 天 | 每日积分: ' + (status.daily_credit || 0));

    // 活动未开启
    if (!status.active) {
      result.success = true;
      result.message = '签到活动未开启或不适用';
      log('ℹ️ ' + account_name + ' 签到活动未开启');
      return result;
    }

    // 今日已签到
    if (status.today_checked_in) {
      result.success = true;
      result.already_checked = true;
      result.message = '今日已签到';
      result.credit = status.today_credit;
      result.streak_days = status.streak_days;
      log('✅ ' + account_name + ' 今日已签到');
      return result;
    }

    // 执行签到
    const checkin = await dailyCheckin(acc);
    if (checkin.success) {
      result.success = true;
      result.message = checkin.message || '签到成功';
      result.credit = checkin.credit;
      result.streak_days = checkin.streak_days;
      log('✅ ' + account_name + ' 签到成功'
        + (checkin.credit !== null ? ' | 🎁 积分 +' + checkin.credit : '')
        + (checkin.streak_days !== null ? ' | 🔥 连签 ' + checkin.streak_days + ' 天' : '')
        + (checkin.is_streak_day ? ' | 🎉 触发连签奖励' : ''));
    } else {
      // 签到失败后复查状态, 可能是并发导致的"已签到"
      const latest = await getCheckinStatus(acc);
      if (latest.success && latest.today_checked_in) {
        result.success = true;
        result.already_checked = true;
        result.message = '今日已签到';
        result.streak_days = latest.streak_days;
        log('✅ ' + account_name + ' 今日已签到');
      } else {
        result.message = checkin.error || '签到失败';
        log('❌ ' + account_name + ' 签到失败: ' + result.message);
      }
    }
  } catch (e) {
    result.message = '处理账号时发生异常: ' + errString(e);
    log('❌ ' + result.message);
  }

  // 令牌被刷新过则回写 (比 Python 版更稳: 所有分支统一在函数尾部回写)
  if (acc._refreshed) persistRefreshed(acc);
  return result;
}

async function main() {
  const accounts = mergeAccounts();
  if (!accounts.length) {
    log('⚠️ 未找到任何账号: 请通过抓包捕获 (见脚本头部说明) 或在 MANUAL_ACCOUNTS 中手动填写');
    notify('WorkBuddy签到', '⚠️ 未配置账号', '请先抓包捕获令牌 (Safari 登录 codebuddy.cn) 或在脚本 MANUAL_ACCOUNTS 中手动填写');
    return;
  }

  log('=========================================');
  log('WorkBuddy 自动签到任务开始, 共 ' + accounts.length + ' 个账号');
  log('=========================================');

  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    results.push(await processAccount(accounts[i]));
    // 账号间随机间隔, 错开请求
    if (i < accounts.length - 1) {
      const d = randInt(CFG.delayMin, CFG.delayMax);
      log('⏱️ 等待 ' + d + ' ms 后处理下一个账号...');
      await sleep(d);
    }
  }

  // 统计 (对齐 main.py _print_summary / _send_notification)
  const total = results.length;
  const success = results.filter((r) => r.success).length;
  const already = results.filter((r) => r.already_checked).length;
  const failed = total - success;

  const lines = [
    '📊 总账号数: ' + total,
    '✅ 签到成功: ' + (success - already),
    '📅 今日已签: ' + already,
    '❌ 签到失败: ' + failed,
    '',
    '📋 详细结果:',
  ];
  for (const r of results) {
    lines.push((r.success ? '✅' : '❌') + ' ' + r.account_name + ': ' + r.message);
    const parts = [];
    if (r.credit !== null && r.credit !== undefined) parts.push('积分 +' + r.credit);
    if (r.streak_days !== null && r.streak_days !== undefined) parts.push('连签 ' + r.streak_days + ' 天');
    if (parts.length) lines.push('    🎁 ' + parts.join(' | '));
  }
  const content = lines.join('\n');
  log(content);

  if (CFG.notify) {
    notify('WorkBuddy签到',
      '成功 ' + (success - already) + ' / 已签 ' + already + ' / 失败 ' + failed,
      content);
  }
}

/* ---------- 抓包捕获模式 (由 [rewrite_local] script-request-header 触发) ---------- */

function lowerKeys(headers) {
  const out = {};
  try {
    for (const k in headers) out[String(k).toLowerCase()] = headers[k];
  } catch (e) { /* ignore */ }
  return out;
}

function capture() {
  try {
    const h = lowerKeys(($request && $request.headers) || {});
    const url = String(($request && $request.url) || '');
    const auth = String(h['authorization'] || '');

    // 调试模式: 证明 rewrite/MITM 链路是否打通、请求里有没有带鉴权头
    if (CFG.captureDebug) {
      const keys = Object.keys(h).join(', ') || '(无请求头)';
      notify('WB捕获调试',
        '✅ rewrite 已生效, 脚本被正常调用',
        'URL: ' + url.slice(0, 90)
        + '\n请求头字段: ' + keys.slice(0, 200)
        + '\n鉴权: ' + (auth ? '有 Authorization (若见「令牌捕获成功」即配置完成)' : '❌ 无 Authorization —— 页面还没发出带 token 的请求, 请在网页里点几个页面/刷新一次'));
    }

    if (auth.toLowerCase().indexOf('bearer ') !== 0) return;
    const token = auth.slice(7).trim();
    if (!token) return;

    const uid = String(h['x-user-id'] || '');
    const refresh = String(h['x-refresh-token'] || '');
    const ent = String(h['x-enterprise-id'] || h['x-tenant-id'] || '');
    const domain = String(h['x-domain'] || '');

    const list = loadStored();
    let acc = list.find((a) => (uid && a.uid === uid) || a.access_token === token);
    let action = '';

    if (acc) {
      let changed = false;
      if (acc.access_token !== token) { acc.access_token = token; changed = true; }
      if (refresh && acc.refresh_token !== refresh) { acc.refresh_token = refresh; changed = true; }
      if (ent && acc.enterprise_id !== ent) { acc.enterprise_id = ent; changed = true; }
      if (domain && acc.domain !== domain) { acc.domain = domain; changed = true; }
      if (uid && !acc.uid) { acc.uid = uid; changed = true; }
      if (changed) action = 'update';
    } else {
      acc = {
        account_name: '账号' + (uid ? String(uid).slice(-4) : String(list.length + 1)),
        access_token: token,
        refresh_token: refresh,
        uid: uid,
        enterprise_id: ent,
        domain: domain,
      };
      list.push(acc);
      action = 'new';
    }

    if (action) {
      saveStored(list);
      notify('WorkBuddy签到',
        action === 'new' ? '🎉 令牌捕获成功' : '🔁 令牌已更新',
        '账号: ' + (acc.account_name || '未命名') + (uid ? '\nUID: ' + uid : ''));
      log('WorkBuddy 令牌' + (action === 'new' ? '捕获成功' : '已更新'));
    }
  } catch (e) {
    log('capture error: ' + errString(e));
  }
}

/* ---------- 入口: 有 $request 即抓包模式, 否则定时签到模式 ---------- */

if (typeof $request !== 'undefined' && $request && $request.headers) {
  capture();
  $done({});
} else {
  main().then(() => $done(), () => $done());
}

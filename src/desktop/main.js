const { app, BrowserWindow, ipcMain, shell, screen, session, globalShortcut, dialog, protocol } = require('electron');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { execFile, spawn } = require('child_process');
const { prepareSodaBridgeDeployment } = require('./soda-bridge-deployment');

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    corsEnabled: true,
    supportFetchAPI: true,
  },
}]);

let mainWindow = null;
let localServer = null;
let mainServerPort = 0;
let sodaBridgeDeploymentPromise = null;
let sodaBridgeDeploymentResult = null;
let sodaQrWindow = null;
let sodaQrSerial = 0;
let sodaQrCreatePromise = null;
let sodaQrImage = '';
let sodaQrImageSerial = 0;
let desktopLyricsWindow = null;
let desktopLyricsState = {};
let desktopLyricsUserBounds = null;
let desktopLyricsProgrammaticMove = false;
let desktopLyricsPointerCapture = false;
let desktopLyricsMouseIgnored = null;
let desktopLyricsMousePoller = null;
let desktopLyricsMousePollerBuffer = '';
let desktopLyricsHotBounds = null;
let desktopLyricsLastMiddleAt = 0;
let wallpaperWindow = null;
let wallpaperState = {};
let htmlFullscreenActive = false;
let windowFullscreenActive = false;
let mainWindowStateTimer = null;
const registeredGlobalHotkeys = new Map();

const WINDOWED_ASPECT = 16 / 9;
const WINDOWED_SCALE = 3 / 4;
const WINDOWED_MARGIN = 32;
const MIN_WINDOWED_WIDTH = 960;
const MIN_WINDOWED_HEIGHT = 540;
const SODA_QR_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.5.2 Chrome/136.0.7103.59 Electron/36.4.0-rs.29.release.main.0 TTElectron/36.4.0-rs.29.release.main.0 Safari/537.36';
const APP_NAME = 'Mineradio';
const APP_USER_MODEL_ID = 'com.mineradio.desktop';
const APP_ICON_ICO = path.join(__dirname, '..', 'build', 'icon.ico');
const NETEASE_LOGIN_PARTITION = 'persist:mineradio-netease-login';
const NETEASE_LOGIN_URL = 'https://music.163.com/#/login';
const QQ_LOGIN_PARTITION = 'persist:mineradio-qqmusic-login';
const QQ_LOGIN_URL = 'https://y.qq.com/n/ryqq/profile';
const KUGOU_LOGIN_PARTITION = 'persist:mineradio-kugou-login';
const KUGOU_LOGIN_URL = 'https://www.kugou.com/';
const SODA_LOGIN_PARTITION = 'persist:mineradio-soda-login';
const SODA_LOGIN_PATH = '/soda-login/login.html';
const SODA_QR_NEXT_URL = 'https://api.qishui.com';
const SODA_QR_ENDPOINTS = [
  'https://api.qishui.com/*',
  'https://*.qishui.com/*',
  'https://bff-pc.qishui.com/*',
  'https://luna-pc.bytedance.net/*',
  'https://*.bytedance.com/*',
  'https://*.bytedance.net/*',
  'https://*.snssdk.com/*',
  'https://*.douyin.com/*',
];
const SODA_QR_DEVICE_FILE = 'soda-login-device.json';
let sodaQrHeadersConfigured = false;
let sodaQrConfirmedAt = 0;
// Captured in memory only. The QR token is never written to diagnostics.
let sodaQrNetworkToken = '';
let sodaQrDiagnostics = createSodaQrDiagnostics();

function createSodaQrDiagnostics() {
  return {
    startedAt: 0,
    getQrcode: { method: '', status: 0, count: 0, requestKeys: [], responseKeys: [], tokenCaptured: false },
    checkQrconnect: {
      method: '', status: 0, count: 0, qrStatus: '', requestKeys: [], queryKeys: [], responseCookies: [],
      responseKeys: [], errorCode: '', message: '',
    },
    responseCookies: [],
    stateHistory: [],
    confirmedAt: 0,
    sessionCookies: [],
    manualCookieWrites: [],
    cookieWriteErrors: [],
    completion: { started: false, loaded: false },
  };
}

function resetSodaQrDiagnostics() {
  sodaQrDiagnostics = createSodaQrDiagnostics();
  sodaQrNetworkToken = '';
  sodaQrDiagnostics.startedAt = Date.now();
  persistSodaQrDiagnostics();
}

function persistSodaQrDiagnostics() {
  try {
    if (!app.isReady()) return;
    const output = path.join(app.getPath('userData'), 'soda-qr-diagnostics.json');
    fs.writeFileSync(output, JSON.stringify(sodaQrDiagnostics, null, 2), { mode: 0o600 });
  } catch (_) {}
}

function sodaQrRequestPath(value) {
  try { return new URL(String(value || '')).pathname; } catch (_) { return ''; }
}

function isSodaQrConfirmedStatus(value) {
  const status = String(value || '').toLowerCase();
  return status === 'confirmed' || status === '3';
}

function isSodaQrReusableStatus(value) {
  const status = String(value || '').toLowerCase();
  return !['expired', '4', '5', 'refused', 'confirmed', '3'].includes(status);
}

function recordSodaQrState(status, source) {
  const normalized = String(status || '').toLowerCase();
  if (!normalized) return;
  const history = sodaQrDiagnostics.stateHistory || (sodaQrDiagnostics.stateHistory = []);
  const last = history[history.length - 1];
  if (!last || last.status !== normalized) {
    history.push({ status: normalized, source: String(source || 'unknown'), at: Date.now() });
    if (history.length > 24) history.shift();
  }
}

function sodaQrRequestKeys(details) {
  const chunks = Array.isArray(details && details.uploadData) ? details.uploadData : [];
  const raw = chunks
    .map(item => item && item.bytes ? Buffer.from(item.bytes).toString('utf8') : '')
    .filter(Boolean)
    .join('&');
  if (!raw) return [];
  return [...new Set(raw.split('&').map((part) => {
    const index = part.indexOf('=');
    const encoded = index < 0 ? part : part.slice(0, index);
    try { return decodeURIComponent(encoded.replace(/\+/g, ' ')); } catch (_) { return encoded; }
  }).filter(Boolean))].slice(0, 32);
}

function sodaQrQueryKeys(requestUrl) {
  try {
    return [...new URL(String(requestUrl || '')).searchParams.keys()]
      .filter(Boolean)
      .slice(0, 32);
  } catch (_) {
    return [];
  }
}

function firstSodaQrResponseValue(result, payload, keys) {
  for (const key of keys) {
    const value = payload && payload[key] != null ? payload[key] : result && result[key];
    if (value != null && String(value) !== '') return value;
  }
  return '';
}

function updateSodaQrResponseDiagnostics(result, source) {
  const payload = result && (result.data || result) || {};
  const check = sodaQrDiagnostics.checkQrconnect;
  const before = JSON.stringify({
    qrStatus: check.qrStatus,
    responseKeys: check.responseKeys,
    errorCode: check.errorCode,
    message: check.message,
    confirmedAt: sodaQrDiagnostics.confirmedAt,
  });
  const keys = new Set([
    ...Object.keys(result && typeof result === 'object' ? result : {}),
    ...Object.keys(payload && typeof payload === 'object' ? payload : {}),
  ]);
  check.responseKeys = [...keys].filter(Boolean).slice(0, 32);

  const errorCode = String(firstSodaQrResponseValue(result, payload, ['error_code', 'errorCode']) || '');
  const message = String(firstSodaQrResponseValue(result, payload, ['description', 'message', 'error']) || '');
  check.errorCode = errorCode && errorCode !== '0' ? errorCode.slice(0, 80) : '';
  check.message = /^(success|ok)$/i.test(message) ? '' : message.slice(0, 180);

  const status = String(firstSodaQrResponseValue(result, payload, ['status']) || '').toLowerCase();
  if (status) {
    check.qrStatus = status;
    recordSodaQrState(status, source);
    if (isSodaQrConfirmedStatus(status) && !sodaQrDiagnostics.confirmedAt) {
      sodaQrConfirmedAt = Date.now();
      sodaQrDiagnostics.confirmedAt = sodaQrConfirmedAt;
    }
  }
  const after = JSON.stringify({
    qrStatus: check.qrStatus,
    responseKeys: check.responseKeys,
    errorCode: check.errorCode,
    message: check.message,
    confirmedAt: sodaQrDiagnostics.confirmedAt,
  });
  if (before !== after) persistSodaQrDiagnostics();
  return status;
}

async function refreshSodaQrPageStatus() {
  if (!sodaQrWindow || sodaQrWindow.isDestroyed()) return '';
  const detail = await sodaQrWindow.webContents.executeJavaScript(`(() => {
    const result = window.__mineradioSodaQrCheckResponse || null;
    const payload = result && (result.data || result) || {};
    return {
      status: String(payload.status || result && result.status || ''),
      error_code: String(payload.error_code || result && result.error_code || ''),
      description: String(payload.description || result && result.description || ''),
      message: String(payload.message || result && result.message || ''),
    };
  })()`, true).catch(() => null);
  if (!detail || typeof detail !== 'object') return '';
  return updateSodaQrResponseDiagnostics(detail, 'page');
}

function addSodaQrDiagnosticCookie(name, domain, target) {
  const entry = {
    name: String(name || '').slice(0, 80),
    domain: String(domain || '').replace(/^\./, '').toLowerCase().slice(0, 160),
  };
  if (!entry.name || !entry.domain) return;
  if (!(target || []).some(item => item.name === entry.name && item.domain === entry.domain)) {
    target.push(entry);
  }
}

function sodaSetCookieDiagnostic(value, requestUrl) {
  const first = String(value || '').split(';', 1)[0] || '';
  const name = first.slice(0, first.indexOf('=')).trim();
  let domain = '';
  try { domain = new URL(String(requestUrl || '')).hostname; } catch (_) {}
  const declaredDomain = String(value || '').match(/;\s*domain=([^;]+)/i);
  if (declaredDomain && declaredDomain[1]) domain = declaredDomain[1];
  return { name, domain };
}

function parseSodaResponseCookie(header, requestUrl) {
  const parts = String(header || '').split(';').map(value => value.trim()).filter(Boolean);
  const first = parts.shift() || '';
  const equalAt = first.indexOf('=');
  if (equalAt < 1) return null;
  const name = first.slice(0, equalAt).trim();
  const value = first.slice(equalAt + 1);
  const attributes = {};
  parts.forEach((part) => {
    const index = part.indexOf('=');
    const key = (index < 0 ? part : part.slice(0, index)).trim().toLowerCase();
    attributes[key] = index < 0 ? true : part.slice(index + 1).trim();
  });

  let host = '';
  try { host = new URL(String(requestUrl || '')).hostname.toLowerCase(); } catch (_) { return null; }
  const domain = String(attributes.domain || host).replace(/^\./, '').toLowerCase();
  if (!name || !domain || !isSodaCookieDomain(domain)) return null;

  const cookie = {
    url: `https://${domain}/`,
    name,
    value,
    domain: `.${domain}`,
    path: String(attributes.path || '/'),
    secure: true,
    httpOnly: attributes.httponly === true,
    sameSite: 'no_restriction',
  };
  const maxAge = Number(attributes['max-age']);
  if (Number.isFinite(maxAge)) {
    cookie.expirationDate = Math.max(0, Math.floor(Date.now() / 1000) + maxAge);
  } else {
    const expires = Date.parse(String(attributes.expires || ''));
    if (Number.isFinite(expires)) cookie.expirationDate = Math.floor(expires / 1000);
  }
  return cookie;
}

function recordSodaCookieWrite(cookie, error) {
  const target = error ? sodaQrDiagnostics.cookieWriteErrors : sodaQrDiagnostics.manualCookieWrites;
  const item = {
    name: String(cookie && cookie.name || '').slice(0, 80),
    domain: String(cookie && cookie.domain || '').replace(/^\./, '').toLowerCase().slice(0, 160),
  };
  if (error) item.error = String(error && error.code || error && error.message || 'COOKIE_WRITE_FAILED').slice(0, 100);
  if (!item.name || !item.domain) return;
  if (!target.some(entry => entry.name === item.name && entry.domain === item.domain)) target.push(item);
  persistSodaQrDiagnostics();
}

function sodaQrDiagnosticMessage() {
  const check = sodaQrDiagnostics.checkQrconnect || {};
  const responseCookies = sodaQrDiagnostics.responseCookies || [];
  const sessionNames = new Set(['sessionid', 'sessionid_ss', 'sid_tt']);
  if (check.errorCode) {
    return `Soda QR polling was rejected (${check.errorCode}${check.message ? `: ${check.message}` : ''})`;
  }
  if (Number(check.status || 0) >= 400) {
    return `扫码确认请求失败（HTTP ${check.status}，SODA_QR_CHECK_HTTP_FAILED）`;
  }
  if (!responseCookies.some(cookie => sessionNames.has(String(cookie.name || '').toLowerCase()))) {
    return '扫码已确认，但登录响应没有返回会话 Cookie（SODA_QR_NO_SET_COOKIE）';
  }
  if (!Array.isArray(sodaQrDiagnostics.sessionCookies) || !sodaQrDiagnostics.sessionCookies.length) {
    if (Array.isArray(sodaQrDiagnostics.cookieWriteErrors) && sodaQrDiagnostics.cookieWriteErrors.length) {
      return '扫码已确认，但会话 Cookie 写入被系统拒绝（SODA_QR_COOKIE_WRITE_FAILED）';
    }
    return '扫码已确认，但会话 Cookie 未写入本地分区（SODA_QR_COOKIE_NOT_STORED）';
  }
  return '扫码已确认，但登录会话未完成（SODA_QR_CONFIRM_NO_SESSION）';
}

function updateSodaQrStatusFromResponse(body) {
  try {
    const result = JSON.parse(String(body || ''));
    updateSodaQrResponseDiagnostics(result, 'network');
  } catch (_) {}
}

function extractSodaQrToken(result) {
  const containers = [
    result,
    result && result.data,
    result && result.data && result.data.data,
    result && result.result,
  ].filter(value => value && typeof value === 'object');
  for (const payload of containers) {
    const direct = String(payload.token || payload.qr_token || payload.qrcode_token || '').trim();
    if (direct) return direct;
    const indexUrl = String(payload.qrcode_index_url || payload.qrcodeIndexUrl || '').trim();
    if (indexUrl) {
      try {
        const token = String(new URL(indexUrl).searchParams.get('token') || '').trim();
        if (token) return token;
      } catch (_) {}
    }
  }
  return '';
}

function captureSodaQrNetworkResponse(body, requestPath) {
  let result;
  try { result = JSON.parse(String(body || '')); } catch (_) { return; }
  if (String(requestPath || '').endsWith('/get_qrcode/')) {
    const payload = result && (result.data || result) || {};
    const keys = new Set([
      ...Object.keys(result && typeof result === 'object' ? result : {}),
      ...Object.keys(payload && typeof payload === 'object' ? payload : {}),
    ]);
    sodaQrDiagnostics.getQrcode.responseKeys = [...keys].filter(Boolean).slice(0, 32);
    sodaQrNetworkToken = extractSodaQrToken(result);
    sodaQrDiagnostics.getQrcode.tokenCaptured = !!sodaQrNetworkToken;
    persistSodaQrDiagnostics();
  } else if (String(requestPath || '').endsWith('/check_qrconnect/')) {
    updateSodaQrResponseDiagnostics(result, 'network');
  }
}

async function createSodaQrImageFromToken(token) {
  const value = String(token || '').trim();
  if (!value) return '';
  const scanUrl = new URL('https://bff-pc.qishui.com/light/invoke/scan_login');
  scanUrl.searchParams.set('token', value);
  scanUrl.searchParams.set('os', 'Windows');
  scanUrl.searchParams.set('computer_name', process.env.COMPUTERNAME || 'Mineradio');
  return QRCode.toDataURL(scanUrl.toString(), {
    margin: 1,
    width: 300,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFFFF' },
  });
}

const CHROMIUM_PERFORMANCE_SWITCHES = [
  ['autoplay-policy', 'no-user-gesture-required'],
  ['ignore-gpu-blocklist'],
  ['enable-gpu-rasterization'],
  ['enable-oop-rasterization'],
  ['enable-zero-copy'],
  ['enable-accelerated-2d-canvas'],
  ['disable-background-timer-throttling'],
  ['disable-renderer-backgrounding'],
  ['disable-backgrounding-occluded-windows'],
  ['force_high_performance_gpu'],
  ['use-angle', 'd3d11'],
];
for (const [name, value] of CHROMIUM_PERFORMANCE_SWITCHES) {
  if (value == null) app.commandLine.appendSwitch(name);
  else app.commandLine.appendSwitch(name, value);
}
const gotSingleInstanceLock = app.requestSingleInstanceLock();

const QQ_LOGIN_COOKIE_PRIORITY = [
  'uin',
  'qqmusic_uin',
  'wxuin',
  'login_type',
  'qm_keyst',
  'qqmusic_key',
  'p_skey',
  'skey',
  'psrf_qqopenid',
  'psrf_qqunionid',
  'psrf_qqaccess_token',
  'psrf_qqrefresh_token',
  'wxopenid',
  'wxunionid',
  'wxrefresh_token',
  'wxskey',
  'p_uin',
  'ptcz',
  'RK',
];
const NETEASE_LOGIN_COOKIE_PRIORITY = [
  'MUSIC_U',
  '__csrf',
  'NMTID',
  'MUSIC_A',
  '__remember_me',
  '_ntes_nuid',
  '_ntes_nnid',
  'WEVNSM',
  'WNMCID',
  'JSESSIONID-WYYY',
];
const KUGOU_LOGIN_COOKIE_PRIORITY = [
  'KuGoo',
  'kg_mid',
  'kg_dfid',
  'KugooID',
  'userid',
  'token',
  't',
];
const SODA_LOGIN_COOKIE_PRIORITY = [
  'sessionid',
  'sessionid_ss',
  'sid_tt',
  'uid_tt',
  'uid_tt_ss',
  'passport_assist_user',
  'sid_guard',
  'sid_ucp_v1',
  'ssid_ucp_v1',
  'ttwid',
  'msToken',
];

function findOpenPort(startPort) {
  return new Promise((resolve, reject) => {
    function tryPort(port) {
      const tester = net.createServer();

      tester.once('error', (err) => {
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          tryPort(port + 1);
          return;
        }
        reject(err);
      });

      tester.once('listening', () => {
        tester.close(() => resolve(port));
      });

      tester.listen(port, '127.0.0.1');
    }

    tryPort(startPort);
  });
}

function prepareBundledSodaBridge(force) {
  if (!force && sodaBridgeDeploymentPromise) return sodaBridgeDeploymentPromise;
  sodaBridgeDeploymentPromise = prepareSodaBridgeDeployment({
    userData: app.getPath('userData'),
    env: process.env,
  }).then(result => {
    sodaBridgeDeploymentResult = result;
    if (result && result.ok && result.root && result.executable) {
      process.env.SODA_MUSIC_HOME = result.root;
      process.env.SODA_BRIDGE_EXECUTABLE = result.executable;
      process.env.SODA_BRIDGE_ARCHIVE = String(result.status && result.status.archive && result.status.archive.target || '');
      delete process.env.SODA_BRIDGE_DEPLOYMENT_ERROR;
    } else {
      delete process.env.SODA_BRIDGE_EXECUTABLE;
      delete process.env.SODA_BRIDGE_ARCHIVE;
      process.env.SODA_BRIDGE_DEPLOYMENT_ERROR = String(result && result.error || 'SODA_DEPLOY_FAILED');
    }
    return result;
  }).catch(error => {
    const result = { ok: false, error: String(error && error.code || 'SODA_DEPLOY_FAILED') };
    sodaBridgeDeploymentResult = result;
    delete process.env.SODA_BRIDGE_ARCHIVE;
    process.env.SODA_BRIDGE_DEPLOYMENT_ERROR = result.error;
    return result;
  });
  return sodaBridgeDeploymentPromise;
}

async function getSodaBridgeRuntimeStatus() {
  const previous = sodaBridgeDeploymentResult;
  const result = previous && previous.ok
    ? previous
    : await prepareBundledSodaBridge(!!previous);
  return {
    ok: !!(result && result.ok),
    state: String(result && result.state || 'failed'),
    error: String(result && result.error || ''),
    profile: String(result && result.profile && result.profile.id || ''),
  };
}

function waitForServer(server) {
  if (!server || server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function sendWindowState(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('desktop-window-state', getWindowState(win));
}

function sendGlobalHotkeyAction(action) {
  if (!mainWindow || mainWindow.isDestroyed() || !action) return;
  mainWindow.webContents.send('mineradio-global-hotkey', { action });
}

function unregisterMineradioGlobalHotkeys() {
  for (const accelerator of registeredGlobalHotkeys.keys()) {
    try { globalShortcut.unregister(accelerator); } catch (e) {}
  }
  registeredGlobalHotkeys.clear();
}

function configureMineradioGlobalHotkeys(bindings = []) {
  unregisterMineradioGlobalHotkeys();
  const results = [];
  const seen = new Set();
  for (const item of Array.isArray(bindings) ? bindings : []) {
    const action = item && String(item.action || '').trim();
    const accelerator = item && String(item.accelerator || '').trim();
    if (!action || !accelerator || seen.has(accelerator)) continue;
    seen.add(accelerator);
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, () => sendGlobalHotkeyAction(action));
    } catch (error) {
      registered = false;
    }
    if (registered) {
      registeredGlobalHotkeys.set(accelerator, action);
      results.push({ action, accelerator, ok: true });
    } else {
      results.push({
        action,
        accelerator,
        ok: false,
        conflict: {
          sourceName: '系统 / 其他软件',
          sourceIcon: 'warning',
          reason: '该组合键已被占用或被系统保留',
        },
      });
    }
  }
  return { ok: true, results };
}

function scheduleWindowStateSend(win, delay = 80) {
  if (!win || win.isDestroyed()) return;
  if (mainWindowStateTimer) clearTimeout(mainWindowStateTimer);
  mainWindowStateTimer = setTimeout(() => {
    mainWindowStateTimer = null;
    sendWindowState(win);
  }, delay);
}

function rectsOverlapOnY(a, b) {
  if (!a || !b) return false;
  const aTop = Number(a.y) || 0;
  const bTop = Number(b.y) || 0;
  const aBottom = aTop + (Number(a.height) || 0);
  const bBottom = bTop + (Number(b.height) || 0);
  return aBottom > bTop && bBottom > aTop;
}

function getDisplayState(win) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : primary;
  const bounds = display && display.bounds ? display.bounds : primary.bounds;
  const displayId = display && display.id;
  const primaryId = primary && primary.id;
  const edgeTolerance = 2;
  const hasDisplayOnLeft = displays.some((candidate) => {
    if (!candidate || candidate.id === displayId || !candidate.bounds) return false;
    return rectsOverlapOnY(bounds, candidate.bounds)
      && Math.abs((candidate.bounds.x + candidate.bounds.width) - bounds.x) <= edgeTolerance;
  });
  const hasDisplayOnRight = displays.some((candidate) => {
    if (!candidate || candidate.id === displayId || !candidate.bounds) return false;
    return rectsOverlapOnY(bounds, candidate.bounds)
      && Math.abs((bounds.x + bounds.width) - candidate.bounds.x) <= edgeTolerance;
  });
  return {
    displayId,
    primaryDisplayId: primaryId,
    isPrimaryDisplay: !!(display && primary && display.id === primary.id),
    hasDisplayOnLeft,
    hasDisplayOnRight,
    displayBounds: bounds ? {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    } : null,
  };
}

function getWindowState(win) {
  if (!win || win.isDestroyed()) return {
    isMaximized: false,
    isNativeFullScreen: false,
    isHtmlFullScreen: false,
    isWindowFullScreen: false,
    isFullScreen: false,
    isMinimized: false,
    isVisible: false,
    isFocused: false,
    isPrimaryDisplay: true,
    hasDisplayOnLeft: false,
    hasDisplayOnRight: false,
    displayBounds: null,
  };
  return {
    isMaximized: win.isMaximized(),
    isNativeFullScreen: win.isFullScreen(),
    isHtmlFullScreen: htmlFullscreenActive,
    isWindowFullScreen: windowFullscreenActive,
    isFullScreen: win.isFullScreen() || htmlFullscreenActive || windowFullscreenActive,
    isMinimized: win.isMinimized(),
    isVisible: win.isVisible(),
    isFocused: win.isFocused(),
    ...getDisplayState(win),
  };
}

function getSenderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  sendWindowState(mainWindow);
  return true;
}

function getUpdateDownloadDir() {
  return path.join(app.getPath('userData'), 'updates');
}

function shouldEnsureDesktopShortcut() {
  if (process.platform !== 'win32') return false;
  if (process.env.MINERADIO_NO_DESKTOP_SHORTCUT === '1') return false;
  return app.isPackaged || process.env.MINERADIO_CREATE_DESKTOP_SHORTCUT === '1';
}

function ensureDesktopShortcut() {
  if (!shouldEnsureDesktopShortcut()) return { ok: false, skipped: true };
  try {
    const shortcutPath = path.join(app.getPath('desktop'), `${APP_NAME}.lnk`);
    const target = process.execPath;
    const shortcut = {
      target,
      cwd: path.dirname(target),
      args: '',
      description: 'Mineradio desktop music player',
      icon: fs.existsSync(APP_ICON_ICO) ? APP_ICON_ICO : target,
      iconIndex: 0,
      appUserModelId: APP_USER_MODEL_ID,
    };

    if (fs.existsSync(shortcutPath) && shell.readShortcutLink) {
      try {
        const existing = shell.readShortcutLink(shortcutPath);
        if (existing &&
            path.resolve(existing.target || '') === path.resolve(target) &&
            path.resolve(existing.cwd || '') === path.resolve(path.dirname(target)) &&
            String(existing.args || '') === '') {
          return { ok: true, path: shortcutPath, existing: true };
        }
      } catch (_) {}
      shell.writeShortcutLink(shortcutPath, 'replace', shortcut);
    } else {
      shell.writeShortcutLink(shortcutPath, 'create', shortcut);
    }
    return { ok: true, path: shortcutPath, created: true };
  } catch (e) {
    console.warn('Desktop shortcut creation skipped:', e.message);
    return { ok: false, error: e.message || 'DESKTOP_SHORTCUT_FAILED' };
  }
}

function parseCookieHeader(cookieText) {
  const out = {};
  String(cookieText || '').split(';').forEach((part) => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const idx = raw.indexOf('=');
    if (idx <= 0) return;
    out[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  });
  return out;
}

function qqCookieHasLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  const rawUin = Number(obj.login_type) === 2
    ? (obj.wxuin || obj.uin || obj.p_uin || '')
    : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin || '');
  const uin = String(rawUin).replace(/\D/g, '');
  const musicKey = obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.p_skey || obj.skey ||
    obj.psrf_qqaccess_token || obj.psrf_qqrefresh_token || obj.wxrefresh_token || obj.wxskey || '';
  return !!(uin && musicKey);
}

function qqCookieHasPlaybackLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  const rawUin = Number(obj.login_type) === 2
    ? (obj.wxuin || obj.uin || obj.p_uin || '')
    : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin || '');
  const uin = String(rawUin).replace(/\D/g, '');
  const playbackKey = obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.wxskey || '';
  return !!(uin && playbackKey);
}

function neteaseCookieHasLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  return !!obj.MUSIC_U;
}

function kugouCookieHasLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  const userId = String(obj.userid || obj.KugooID || obj.kugou_id || '').replace(/\D/g, '');
  const authToken = obj.token || obj.KuGoo || obj.t || '';
  return !!(userId && authToken);
}

function isQQCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === 'qq.com' || normalized.endsWith('.qq.com') || normalized.endsWith('qqmusic.qq.com');
}

function isNeteaseCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === '163.com' || normalized.endsWith('.163.com') ||
    normalized === 'music.163.com' || normalized.endsWith('.music.163.com') ||
    normalized === 'netease.com' || normalized.endsWith('.netease.com');
}

function isKugouCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === 'kugou.com' || normalized.endsWith('.kugou.com') ||
    normalized === 'kgimg.com' || normalized.endsWith('.kgimg.com');
}

function isSodaCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === 'qishui.com' || normalized.endsWith('.qishui.com') ||
    normalized === 'bytedance.com' || normalized.endsWith('.bytedance.com') ||
    normalized === 'bytedance.net' || normalized.endsWith('.bytedance.net') ||
    normalized === 'snssdk.com' || normalized.endsWith('.snssdk.com') ||
    normalized === 'douyin.com' || normalized.endsWith('.douyin.com');
}

function buildCookieHeaderFor(cookies, isAllowedDomain, priority) {
  const picked = new Map();
  (cookies || []).forEach((cookie) => {
    if (!cookie || !cookie.name || !isAllowedDomain(cookie.domain)) return;
    picked.set(cookie.name, cookie.value || '');
  });

  const ordered = [];
  (priority || []).forEach((name) => {
    if (picked.has(name)) {
      ordered.push([name, picked.get(name)]);
      picked.delete(name);
    }
  });
  picked.forEach((value, name) => ordered.push([name, value]));

  return ordered
    .filter(([name, value]) => name && value != null && String(value) !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function buildCookieHeader(cookies) {
  return buildCookieHeaderFor(cookies, isQQCookieDomain, QQ_LOGIN_COOKIE_PRIORITY);
}

async function readQQLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeader(cookies);
}

async function readNeteaseLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeaderFor(cookies, isNeteaseCookieDomain, NETEASE_LOGIN_COOKIE_PRIORITY);
}

async function readKugouLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeaderFor(cookies, isKugouCookieDomain, KUGOU_LOGIN_COOKIE_PRIORITY);
}

async function readSodaLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeaderFor(cookies, isSodaCookieDomain, SODA_LOGIN_COOKIE_PRIORITY);
}

function sodaCookieHasLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  return !!(obj.sessionid || obj.sessionid_ss || obj.sid_tt);
}

function isSodaSessionCookie(cookie) {
  if (!cookie || !isSodaCookieDomain(cookie.domain)) return false;
  return ['sessionid', 'sessionid_ss', 'sid_tt'].includes(String(cookie.name || '').toLowerCase())
    && String(cookie.value || '').length > 0;
}

async function openNeteaseMusicLoginWindow(owner) {
  const cookieSession = session.fromPartition(NETEASE_LOGIN_PARTITION);
  const initialCookie = await readNeteaseLoginCookieHeader(cookieSession);
  if (neteaseCookieHasLogin(initialCookie)) return { ok: true, cookie: initialCookie, reused: true };

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;

    const loginWindow = new BrowserWindow({
      width: 940,
      height: 760,
      minWidth: 780,
      minHeight: 580,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: '网易云音乐登录',
      backgroundColor: '#111111',
      icon: APP_ICON_ICO,
      webPreferences: {
        partition: NETEASE_LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
      resolve(result);
    };

    const checkCookies = async () => {
      try {
        const cookie = await readNeteaseLoginCookieHeader(cookieSession);
        if (neteaseCookieHasLogin(cookie)) {
          finish({ ok: true, cookie });
        }
      } catch (e) {
        console.warn('Netease login cookie check failed:', e.message);
      }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\/([^/]+\.)?(163|music\.163|netease)\.com/i.test(url)) {
        loginWindow.loadURL(url).catch((e) => console.warn('Netease login popup navigation failed:', e.message));
      } else if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      return;
      loginWindow.webContents.executeJavaScript(`
        setTimeout(() => {
          const docs = [document];
          document.querySelectorAll('iframe').forEach((frame) => {
            try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (_) {}
          });
          for (const doc of docs) {
            const nodes = Array.from(doc.querySelectorAll('a, button, span, div'));
            const loginNode = nodes.find((node) => {
              const text = (node.textContent || '').trim();
              if (!/登录|立即登录/.test(text)) return false;
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
            if (loginNode) { loginNode.click(); return true; }
          }
          return false;
        }, 900);
      `, true).catch(() => {});
    });

    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      if (pollTimer) clearInterval(pollTimer);
      try {
        const cookie = await readNeteaseLoginCookieHeader(cookieSession);
        resolve(neteaseCookieHasLogin(cookie)
          ? { ok: true, cookie, partial: !qqCookieHasPlaybackLogin(cookie) }
          : { ok: false, cancelled: true, message: '网易云登录窗口已关闭' });
      } catch (e) {
        resolve({ ok: false, error: e.message || '网易云登录窗口已关闭' });
      }
    });

    pollTimer = setInterval(checkCookies, 1200);
    loginWindow.loadURL(NETEASE_LOGIN_URL).catch((e) => finish({ ok: false, error: e.message }));
  });
}

async function openQQMusicLoginWindow(owner) {
  const cookieSession = session.fromPartition(QQ_LOGIN_PARTITION);
  const initialCookie = await readQQLoginCookieHeader(cookieSession);
  if (qqCookieHasPlaybackLogin(initialCookie)) return { ok: true, cookie: initialCookie, reused: true };

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let warmupStarted = false;

    const loginWindow = new BrowserWindow({
      width: 900,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: 'QQ 音乐登录',
      backgroundColor: '#111111',
      icon: APP_ICON_ICO,
      webPreferences: {
        partition: QQ_LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
      resolve(result);
    };

    const checkCookies = async () => {
      try {
        const cookie = await readQQLoginCookieHeader(cookieSession);
        if (qqCookieHasPlaybackLogin(cookie)) {
          finish({ ok: true, cookie });
        } else if (qqCookieHasLogin(cookie) && !warmupStarted) {
          warmupStarted = true;
          setTimeout(() => {
            if (!settled && loginWindow && !loginWindow.isDestroyed()) {
              loginWindow.loadURL('https://y.qq.com/n/ryqq/player').catch((e) => console.warn('QQ login warmup navigation failed:', e.message));
            }
          }, 900);
        }
      } catch (e) {
        console.warn('QQ login cookie check failed:', e.message);
      }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        loginWindow.loadURL(url).catch((e) => console.warn('QQ login popup navigation failed:', e.message));
      } else {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      loginWindow.webContents.executeJavaScript(`
        setTimeout(() => {
          const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
          const loginNode = nodes.find((node) => {
            const text = (node.textContent || '').trim();
            if (!/登录|登陆/.test(text)) return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (loginNode) loginNode.click();
        }, 700);
      `, true).catch(() => {});
    });

    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      if (pollTimer) clearInterval(pollTimer);
      try {
        const cookie = await readQQLoginCookieHeader(cookieSession);
        resolve(qqCookieHasLogin(cookie)
          ? { ok: true, cookie }
          : { ok: false, cancelled: true, message: 'QQ 登录窗口已关闭' });
      } catch (e) {
        resolve({ ok: false, error: e.message || 'QQ 登录窗口已关闭' });
      }
    });

    pollTimer = setInterval(checkCookies, 1200);
    loginWindow.loadURL(QQ_LOGIN_URL).catch((e) => finish({ ok: false, error: e.message }));
  });
}

async function openKugouMusicLoginWindow(owner) {
  const cookieSession = session.fromPartition(KUGOU_LOGIN_PARTITION);
  await clearKugouMusicLoginSession();

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;

    const loginWindow = new BrowserWindow({
      width: 920,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: 'Kugou Music Login',
      backgroundColor: '#111111',
      icon: APP_ICON_ICO,
      webPreferences: {
        partition: KUGOU_LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
      resolve(result);
    };

    const checkCookies = async () => {
      try {
        const cookie = await readKugouLoginCookieHeader(cookieSession);
        if (kugouCookieHasLogin(cookie)) {
          finish({ ok: true, cookie });
        }
      } catch (e) {
        console.warn('Kugou login cookie check failed:', e.message);
      }
    };

    const localJson = (pathname) => new Promise((ok, fail) => {
      const port = mainServerPort || Number(process.env.PORT) || 3000;
      const req = http.get(`http://127.0.0.1:${port}${pathname}`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const data = body ? JSON.parse(body) : {};
            if (res.statusCode >= 400) {
              const err = new Error(data.message || data.error || `HTTP_${res.statusCode}`);
              err.data = data;
              fail(err);
              return;
            }
            ok(data);
          } catch (e) {
            fail(e);
          }
        });
      });
      req.setTimeout(12000, () => req.destroy(new Error('Kugou login request timeout')));
      req.on('error', fail);
    });

    const startKugouQrLogin = async () => {
      try {
        const qr = await localJson('/api/kugou/login/qr/key?t=' + Date.now());
        const key = qr && (qr.key || qr.qrcode);
        if (!key || !qr.url) throw new Error('Kugou QR login URL missing');
        await loginWindow.loadURL(qr.url);
        const pollLogin = async () => {
          try {
            const data = await localJson('/api/kugou/login/qr/check?key=' + encodeURIComponent(key) + '&t=' + Date.now());
            if (data && data.code === 803 && data.loggedIn) {
              finish(Object.assign({ ok: true }, data));
            } else if (data && data.code === 800) {
              finish({ ok: false, error: data.message || 'Kugou QR expired, please try again' });
            }
          } catch (e) {
            console.warn('Kugou QR login check failed:', e.message);
          }
        };
        pollTimer = setInterval(pollLogin, 1200);
        pollLogin();
      } catch (e) {
        console.warn('Kugou QR login failed, falling back to web home:', e.message);
        pollTimer = setInterval(checkCookies, 1200);
        loginWindow.loadURL(KUGOU_LOGIN_URL).catch((err) => finish({ ok: false, error: err.message }));
      }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\/([^/]+\.)?kugou\.com/i.test(url) || /^https?:\/\/([^/]+\.)?kgimg\.com/i.test(url)) {
        loginWindow.loadURL(url).catch((e) => console.warn('Kugou login popup navigation failed:', e.message));
      } else if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      loginWindow.webContents.executeJavaScript(`
        setTimeout(() => {
          const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
          const loginNode = nodes.find((node) => {
            const text = (node.textContent || '').trim();
            if (!/登录|登陆|立即登录/.test(text)) return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (loginNode) loginNode.click();
        }, 700);
      `, true).catch(() => {});
    });

    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      if (pollTimer) clearInterval(pollTimer);
      try {
        const cookie = await readKugouLoginCookieHeader(cookieSession);
        resolve(kugouCookieHasLogin(cookie)
          ? { ok: true, cookie }
          : { ok: false, cancelled: true, message: 'Kugou login window closed' });
      } catch (e) {
        resolve({ ok: false, error: e.message || 'Kugou login window closed' });
      }
    });

    startKugouQrLogin();
  });
}

async function clearQQMusicLoginSession() {
  const cookieSession = session.fromPartition(QQ_LOGIN_PARTITION);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  return { ok: true };
}

async function openSodaMusicLoginWindow(owner) {
  const cookieSession = session.fromPartition(SODA_LOGIN_PARTITION);
  cookieSession.webRequest.onBeforeRequest({ urls: ['https://api.qishui.com/passport/web/*'] }, (details, callback) => {
    try {
      const target = new URL(details.url);
      if (target.searchParams.get('passport_jssdk_version') === '3.5.2') {
        callback({});
        return;
      }
      target.searchParams.set('version_code', '30502');
      target.searchParams.set('version_name', '3.5.2');
      target.searchParams.set('app_version', '3.5.2');
      target.searchParams.set('passport_jssdk_version', '3.5.2');
      target.searchParams.set('device_platform', 'pc');
      callback({ redirectURL: target.toString() });
    } catch (_) {
      callback({});
    }
  });
  const initialCookie = await readSodaLoginCookieHeader(cookieSession);
  if (sodaCookieHasLogin(initialCookie)) return { ok: true, cookie: initialCookie, reused: true, version: '3.5.2' };

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let loadTimeout = null;
    const loginWindow = new BrowserWindow({
      width: 920,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: '汽水音乐登录',
      backgroundColor: '#111111',
      icon: APP_ICON_ICO,
      webPreferences: {
        partition: SODA_LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: false,
      },
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (loadTimeout) clearTimeout(loadTimeout);
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      resolve(result);
    };
    const checkCookies = async () => {
      try {
        const cookie = await readSodaLoginCookieHeader(cookieSession);
        if (sodaCookieHasLogin(cookie)) finish({ ok: true, cookie, version: '3.5.2' });
      } catch (e) {
        console.warn('Soda login cookie check failed:', e.message);
      }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\/([^/]+\.)?(qishui|bytedance|douyin)\.com/i.test(url)) {
        loginWindow.loadURL(url).catch((e) => console.warn('Soda login popup navigation failed:', e.message));
      } else if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });
    loginWindow.webContents.on('did-finish-load', checkCookies);
    loginWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
      if (isMainFrame) finish({ ok: false, error: 'SODA_LOGIN_PAGE_LOAD_FAILED', message: description || validatedUrl || String(code) });
    });
    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      if (pollTimer) clearInterval(pollTimer);
      try {
        const cookie = await readSodaLoginCookieHeader(cookieSession);
        resolve(sodaCookieHasLogin(cookie)
          ? { ok: true, cookie, version: '3.5.2' }
          : { ok: false, cancelled: true, message: '汽水音乐登录窗口已关闭' });
      } catch (e) {
        resolve({ ok: false, error: e.message || '汽水音乐登录窗口已关闭' });
      }
    });
    pollTimer = setInterval(checkCookies, 1200);
    loadTimeout = setTimeout(() => {
      finish({ ok: false, error: 'SODA_LOGIN_PAGE_TIMEOUT', message: '汽水音乐登录页加载超时，请检查网络后重试' });
    }, 20000);
    const port = mainServerPort || Number(process.env.PORT) || 3000;
    const globalConfig = encodeURIComponent(JSON.stringify({
      os: 'Windows',
      computerName: process.env.COMPUTERNAME || 'Mineradio',
      deviceId: String(Date.now()) + String(process.pid),
      installId: String(Date.now()) + String(process.pid),
      fontPrefix: '',
    }));
    loginWindow.loadURL(`http://127.0.0.1:${port}${SODA_LOGIN_PATH}?global_config=${globalConfig}`).catch((e) => finish({ ok: false, error: e.message }));
  });
}

function sodaLoginPageUrl() {
  const device = getSodaQrDevice();
  const globalConfig = encodeURIComponent(JSON.stringify({
    os: 'Windows',
    computerName: process.env.COMPUTERNAME || 'Mineradio',
    deviceId: device.deviceId,
    installId: device.installId,
    fontPrefix: '',
  }));
  const port = mainServerPort || Number(process.env.PORT) || 3000;
  return `http://127.0.0.1:${port}${SODA_LOGIN_PATH}?global_config=${globalConfig}`;
}

function getSodaQrDevice() {
  const devicePath = path.join(app.getPath('userData'), SODA_QR_DEVICE_FILE);
  try {
    const saved = JSON.parse(fs.readFileSync(devicePath, 'utf8'));
    if (saved && /^\d{16,20}$/.test(String(saved.deviceId || ''))
      && /^\d{16,20}$/.test(String(saved.installId || ''))) {
      return { deviceId: String(saved.deviceId), installId: String(saved.installId) };
    }
  } catch (_) {}

  const createDeviceId = () => {
    const prefix = String(Math.floor(100 + Math.random() * 900));
    return prefix + String(Date.now()).slice(-13);
  };
  const device = {
    deviceId: createDeviceId(),
    installId: createDeviceId(),
  };
  try { fs.writeFileSync(devicePath, JSON.stringify(device), { mode: 0o600 }); } catch (_) {}
  return device;
}

function configureSodaQrRequestHeaders(cookieSession) {
  if (sodaQrHeadersConfigured) return;
  cookieSession.webRequest.onBeforeRequest({
    urls: [
      'https://api.qishui.com/passport/web/get_qrcode/*',
      'https://api.qishui.com/passport/web/check_qrconnect/*',
    ],
  }, (details, callback) => {
    try {
      const filter = cookieSession.webRequest.filterResponseData(details.id);
      const chunks = [];
      filter.ondata = (event) => {
        chunks.push(Buffer.from(event.data));
        filter.write(event.data);
      };
      filter.onstop = () => {
        captureSodaQrNetworkResponse(
          Buffer.concat(chunks).toString('utf8'),
          sodaQrRequestPath(details.url),
        );
        filter.end();
      };
      filter.onerror = () => filter.disconnect();
    } catch (_) {}
    callback({});
  });
  cookieSession.webRequest.onBeforeSendHeaders({ urls: SODA_QR_ENDPOINTS }, (details, callback) => {
    const requestPath = sodaQrRequestPath(details.url);
    if (requestPath.endsWith('/get_qrcode/')) {
      sodaQrDiagnostics.getQrcode.method = String(details.method || '');
      sodaQrDiagnostics.getQrcode.count = Number(sodaQrDiagnostics.getQrcode.count || 0) + 1;
      sodaQrDiagnostics.getQrcode.requestKeys = sodaQrQueryKeys(details.url);
    } else if (requestPath.endsWith('/check_qrconnect/')) {
      sodaQrDiagnostics.checkQrconnect.method = String(details.method || '');
      sodaQrDiagnostics.checkQrconnect.count = Number(sodaQrDiagnostics.checkQrconnect.count || 0) + 1;
      sodaQrDiagnostics.checkQrconnect.requestKeys = sodaQrRequestKeys(details);
      sodaQrDiagnostics.checkQrconnect.queryKeys = sodaQrQueryKeys(details.url);
    }
    const headers = { ...details.requestHeaders };
    delete headers.Referer;
    delete headers.referer;
    delete headers.Origin;
    delete headers.origin;
    headers['User-Agent'] = SODA_QR_USER_AGENT;
    headers['sec-ch-ua'] = '"Not.A/Brand";v="99", "Chromium";v="136"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
    callback({ requestHeaders: headers });
  });
  cookieSession.webRequest.onHeadersReceived({ urls: SODA_QR_ENDPOINTS }, (details, callback) => {
    const responseHeaders = Object.fromEntries(
      Object.entries(details.responseHeaders || {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const setCookies = responseHeaders['set-cookie'] || [];
    const requestPath = sodaQrRequestPath(details.url);
    const responseCookies = (Array.isArray(setCookies) ? setCookies : [setCookies])
      .filter(Boolean)
      .map(value => sodaSetCookieDiagnostic(value, details.url));
    responseCookies.forEach(cookie => addSodaQrDiagnosticCookie(
      cookie.name,
      cookie.domain,
      sodaQrDiagnostics.responseCookies,
    ));
    if (requestPath.endsWith('/get_qrcode/')) {
      sodaQrDiagnostics.getQrcode.status = Number(details.statusCode || 0);
    } else if (requestPath.endsWith('/check_qrconnect/')) {
      sodaQrDiagnostics.checkQrconnect.status = Number(details.statusCode || 0);
      responseCookies.forEach(cookie => addSodaQrDiagnosticCookie(
        cookie.name,
        cookie.domain,
        sodaQrDiagnostics.checkQrconnect.responseCookies,
      ));
    }
    persistSodaQrDiagnostics();
    responseHeaders['set-cookie'] = (Array.isArray(setCookies) ? setCookies : [setCookies])
      .filter(Boolean)
      .map((value) => {
        const cookie = String(value);
        return /samesite\s*=\s*none/i.test(cookie)
          ? cookie
          : `${cookie}; SameSite=None; Secure`;
      });
    responseHeaders['access-control-allow-origin'] = ['*'];
    responseHeaders['access-control-expose-headers'] = ['*'];
    callback({ responseHeaders });

    // Electron may reject a cross-site Set-Cookie on some Windows builds even
    // after the response header is normalized. Persist the same cookie through
    // CookieStore as a compatibility fallback; values never leave this process.
    void Promise.all((Array.isArray(setCookies) ? setCookies : [setCookies]).map(async (value) => {
      const cookie = parseSodaResponseCookie(value, details.url);
      if (!cookie) return;
      try {
        await cookieSession.cookies.set(cookie);
        recordSodaCookieWrite(cookie);
      } catch (error) {
        recordSodaCookieWrite(cookie, error);
      }
    }));
  });
  sodaQrHeadersConfigured = true;
}

function closeSodaQrWindow(expectedWindow) {
  if (expectedWindow && sodaQrWindow !== expectedWindow) return false;
  const target = expectedWindow || sodaQrWindow;
  sodaQrSerial++;
  if (!target) {
    sodaQrImage = '';
    sodaQrImageSerial = 0;
    return false;
  }
  if (sodaQrWindow === target) {
    sodaQrWindow = null;
    sodaQrImage = '';
    sodaQrImageSerial = 0;
  }
  if (!target.isDestroyed()) target.destroy();
  return true;
}

async function completeSodaQrLogin(loginWindow, cookieSession, serial) {
  if (sodaQrWindow !== loginWindow || sodaQrSerial !== serial) return false;
  const before = await readSodaLoginCookieHeader(cookieSession);
  if (sodaCookieHasLogin(before)) return true;
  if (!loginWindow || loginWindow.isDestroyed() || sodaQrWindow !== loginWindow || sodaQrSerial !== serial) return false;

  // The official web-scope success handler always navigates to `next` after
  // confirmation. The response does not have to contain a redirect URL.
  sodaQrDiagnostics.completion.started = true;
  persistSodaQrDiagnostics();
  void loginWindow.loadURL(SODA_QR_NEXT_URL)
    .then(() => {
      sodaQrDiagnostics.completion.loaded = true;
      persistSodaQrDiagnostics();
    })
    .catch(() => {});
  for (let attempt = 0; attempt < 48; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (sodaQrWindow !== loginWindow || sodaQrSerial !== serial) return false;
    const cookie = await readSodaLoginCookieHeader(cookieSession);
    if (sodaCookieHasLogin(cookie)) return true;
  }
  return false;
}

function getReusableSodaQr() {
  const check = sodaQrDiagnostics.checkQrconnect || {};
  const qrStatus = String(check.qrStatus || '');
  if (!sodaQrWindow || sodaQrWindow.isDestroyed() || sodaQrImageSerial !== sodaQrSerial || !sodaQrImage) return null;
  if (check.errorCode) return null;
  if (!isSodaQrReusableStatus(qrStatus)) return null;
  return { ok: true, img: sodaQrImage, version: '3.5.2', source: 'official-canvas', reused: true };
}

async function createSodaMusicQr(options) {
  const force = !!(options && options.force);
  if (sodaQrCreatePromise) return sodaQrCreatePromise;
  const reusable = !force ? getReusableSodaQr() : null;
  if (reusable) return reusable;

  const requestGeneration = sodaQrSerial;
  sodaQrCreatePromise = createSodaMusicQrFresh(requestGeneration)
    .finally(() => { sodaQrCreatePromise = null; });
  return sodaQrCreatePromise;
}

async function createSodaMusicQrFresh(requestGeneration) {
  const cookieSession = session.fromPartition(SODA_LOGIN_PARTITION);
  configureSodaQrRequestHeaders(cookieSession);
  const initialCookie = await readSodaLoginCookieHeader(cookieSession);
  if (requestGeneration !== sodaQrSerial) throw new Error('SODA_QR_CREATE_CANCELLED');
  if (sodaCookieHasLogin(initialCookie)) return { ok: true, loggedIn: true, cookie: initialCookie, version: '3.5.2' };

  closeSodaQrWindow();
  const serial = ++sodaQrSerial;
  resetSodaQrDiagnostics();
  const loginWindow = new BrowserWindow({
    // Soda's QR SDK stops polling when document.visibilityState is hidden.
    // Keep this window visible to Chromium but place it outside the desktop.
    x: -10000,
    y: -10000,
    width: 2,
    height: 2,
    show: true,
    opacity: 0.01,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      partition: SODA_LOGIN_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: false,
      backgroundThrottling: false,
    },
  });
  sodaQrWindow = loginWindow;
  loginWindow.webContents.setUserAgent(SODA_QR_USER_AGENT);
  loginWindow.setMenuBarVisibility(false);
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loginWindow.on('ready-to-show', () => {
    if (loginWindow.isDestroyed()) return;
    loginWindow.setOpacity(0.01);
    loginWindow.setPosition(-10000, -10000, false);
    loginWindow.showInactive();
  });
  let sessionCookieObserved = false;
  let confirmedAt = 0;
  const cookieObserver = (_event, cookie, cause, removed) => {
    if (sodaQrWindow === loginWindow && sodaQrSerial === serial && !removed && isSodaSessionCookie(cookie)) {
      sessionCookieObserved = true;
      sodaQrConfirmedAt = Date.now();
      addSodaQrDiagnosticCookie(cookie.name, cookie.domain, sodaQrDiagnostics.sessionCookies);
      persistSodaQrDiagnostics();
    }
  };
  cookieSession.cookies.on('changed', cookieObserver);
  let completionStarted = false;
  let completionPromise = null;
  const confirmedObserver = setInterval(async () => {
    if (loginWindow.isDestroyed() || sodaQrWindow !== loginWindow || sodaQrSerial !== serial) return;
    const result = await loginWindow.webContents.executeJavaScript(`(() => {
      const raw = window.__mineradioSodaQrCheckResponse || null;
      const payload = raw && (raw.data || raw) || {};
      return {
        status: String(payload.status || raw && raw.status || ''),
        error_code: String(payload.error_code || raw && raw.error_code || ''),
        description: String(payload.description || raw && raw.description || ''),
        message: String(payload.message || raw && raw.message || ''),
      };
    })()`, true).catch(() => null);
    const pageStatus = result && updateSodaQrResponseDiagnostics(result, 'observer');
    const confirmedByPage = isSodaQrConfirmedStatus(pageStatus);
    const confirmedByNetwork = sodaQrDiagnostics.confirmedAt >= sodaQrDiagnostics.startedAt
      && sodaQrDiagnostics.confirmedAt > 0;
    if (!confirmedByPage && !confirmedByNetwork) return;
    if (!confirmedAt) {
      confirmedAt = sodaQrDiagnostics.confirmedAt || Date.now();
      sodaQrConfirmedAt = confirmedAt;
      sodaQrDiagnostics.confirmedAt = confirmedAt;
      persistSodaQrDiagnostics();
    }
    if (!sessionCookieObserved && Date.now() - confirmedAt > 20000) return;
    if (completionStarted || completionPromise) return;
    completionStarted = true;
    completionPromise = completeSodaQrLogin(loginWindow, cookieSession, serial).catch(() => false);
    await completionPromise;
  }, 250);
  loginWindow.on('closed', () => {
    clearInterval(confirmedObserver);
    cookieSession.cookies.removeListener('changed', cookieObserver);
    if (sodaQrWindow === loginWindow) {
      sodaQrWindow = null;
      if (sodaQrImageSerial === serial) {
        sodaQrImage = '';
        sodaQrImageSerial = 0;
      }
    }
  });

  let loadError = null;
  const loadPromise = loginWindow.loadURL(sodaLoginPageUrl())
    .catch((error) => { loadError = error; });
  await Promise.race([
    loadPromise,
    new Promise(resolve => setTimeout(resolve, 12000)),
  ]);
  if (loadError) {
    closeSodaQrWindow(loginWindow);
    throw loadError;
  }
  const deadline = Date.now() + 45000;
  while (serial === sodaQrSerial && !loginWindow.isDestroyed() && Date.now() < deadline) {
    // Some VM/remote-desktop GPU configurations complete the API request but
    // never paint the SDK canvas. Generate the same scan URL from the token
    // captured by the main-process response filter in that case.
    if (sodaQrNetworkToken) {
      const fallbackImage = await createSodaQrImageFromToken(sodaQrNetworkToken).catch(() => '');
      if (fallbackImage) {
        if (sodaQrWindow !== loginWindow || sodaQrSerial !== serial) break;
        sodaQrDiagnostics.getQrcode.imageSource = 'network-token';
        persistSodaQrDiagnostics();
        sodaQrImage = fallbackImage;
        sodaQrImageSerial = serial;
        return { ok: true, img: fallbackImage, version: '3.5.2', source: 'network-token' };
      }
    }
    const pageState = await loginWindow.webContents.executeJavaScript(`(() => {
      const canvas = document.querySelector('.qrcode canvas');
      let img = '';
      if (canvas && canvas.width >= 64 && canvas.height >= 64) {
        try {
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let darkPixels = 0;
          for (let i = 0; i < pixels.length; i += 32) {
            if (pixels[i + 3] > 24 && pixels[i] < 230 && pixels[i + 1] < 230 && pixels[i + 2] < 230) darkPixels++;
          }
          if (darkPixels >= 24) img = canvas.toDataURL('image/png');
        } catch (_) {}
      }
      const error = Array.from(document.querySelectorAll('.qrcode .error, .error'))
        .map(node => String(node.textContent || '').trim())
        .find(Boolean) || '';
      return {
        img,
        error,
        payload: window.__mineradioSodaQrResponse || null,
      };
    })()`, true).catch(() => null);
    if (pageState && pageState.img) {
      if (sodaQrWindow !== loginWindow || sodaQrSerial !== serial) break;
      sodaQrImage = pageState.img;
      sodaQrImageSerial = serial;
      return { ok: true, img: pageState.img, version: '3.5.2', source: 'official-canvas' };
    }
    const payload = pageState && pageState.payload;
    if (payload) {
      const data = payload && (payload.data || payload) || {};
      // The QR endpoint already returns a complete PNG data URL. Prefer it
      // over canvas extraction so VMs without a working compositor still
      // receive the exact image generated by the official service.
      const responseImage = String(data.qrcode || data.qr_code || '').trim();
      if (/^data:image\/(?:png|jpeg|jpg);base64,/i.test(responseImage)) {
        if (sodaQrWindow !== loginWindow || sodaQrSerial !== serial) break;
        sodaQrDiagnostics.getQrcode.imageSource = 'network-response';
        persistSodaQrDiagnostics();
        sodaQrImage = responseImage;
        sodaQrImageSerial = serial;
        return { ok: true, img: responseImage, version: '3.5.2', source: 'network-response' };
      }
      if (data.error_code || payload.message === 'error') {
        throw new Error(data.description || payload.message || 'SODA_QR_REQUEST_FAILED');
      }
      const indexUrl = String(data.qrcode_index_url || '').trim();
      let token = String(data.token || data.qr_token || '').trim();
      if (!token && indexUrl) {
        try { token = new URL(indexUrl).searchParams.get('token') || ''; } catch (_) {}
      }
      if (!token) throw new Error('SODA_QR_TOKEN_MISSING');
      const img = await createSodaQrImageFromToken(token);
      if (sodaQrWindow !== loginWindow || sodaQrSerial !== serial) break;
      sodaQrImage = img;
      sodaQrImageSerial = serial;
      return { ok: true, img, version: '3.5.2' };
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const diagnostics = await loginWindow.webContents.executeJavaScript(`({
    requests: window.__mineradioSodaRequests || [],
    error: Array.from(document.querySelectorAll('.qrcode .error, .error')).map(node => String(node.textContent || '').trim()).find(Boolean) || '',
    readyState: document.readyState,
  })`, true).catch(() => ({}));
  closeSodaQrWindow(loginWindow);
  throw new Error('SODA_QR_GENERATION_TIMEOUT:' + JSON.stringify(diagnostics).slice(0, 800));
}

async function getSodaMusicQrLoginStatus() {
  await refreshSodaQrPageStatus();
  const cookieSession = session.fromPartition(SODA_LOGIN_PARTITION);
  const cookie = await readSodaLoginCookieHeader(cookieSession);
  if (sodaCookieHasLogin(cookie)) {
    sodaQrConfirmedAt = 0;
    closeSodaQrWindow();
  }
  const qrStatus = String(sodaQrDiagnostics.checkQrconnect && sodaQrDiagnostics.checkQrconnect.qrStatus || '').toLowerCase();
  const qrCheck = sodaQrDiagnostics.checkQrconnect || {};
  const qrExpired = qrStatus === 'expired' || qrStatus === '4' || qrStatus === '5' || qrStatus === 'refused';
  const qrScanned = qrStatus === 'scanned' || qrStatus === '2';
  const confirmationExpired = sodaQrConfirmedAt > 0 && sodaQrConfirmedAt <= Date.now() - 20000;
  const checkRejected = !!qrCheck.errorCode;
  const protocolUnrecognized = !qrStatus && Number(qrCheck.count || 0) >= 4 && !checkRejected;
  const error = qrExpired
    ? 'SODA_QR_EXPIRED'
    : (checkRejected ? 'SODA_QR_CHECK_REJECTED' : (confirmationExpired ? 'SODA_QR_CONFIRM_NO_SESSION' : (protocolUnrecognized ? 'SODA_QR_PROTOCOL_UNRECOGNIZED' : '')));
  const message = qrExpired
    ? 'Soda QR expired or was refused. Generate a new QR code and try again.'
    : (checkRejected
      ? sodaQrDiagnosticMessage()
      : (confirmationExpired
        ? sodaQrDiagnosticMessage()
        : (protocolUnrecognized ? 'Soda QR polling returned no recognizable state.' : '')));
  return sodaCookieHasLogin(cookie)
    ? { ok: true, loggedIn: true, cookie, version: '3.5.2', diagnostics: sodaQrDiagnostics }
    : {
      ok: true,
      loggedIn: false,
      confirmed: sodaQrConfirmedAt > Date.now() - 20000,
      scanned: qrScanned,
      error,
      message,
      version: '3.5.2',
      diagnostics: sodaQrDiagnostics,
    };
}

async function clearNeteaseMusicLoginSession() {
  const cookieSession = session.fromPartition(NETEASE_LOGIN_PARTITION);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  return { ok: true };
}

async function clearKugouMusicLoginSession() {
  const cookieSession = session.fromPartition(KUGOU_LOGIN_PARTITION);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  return { ok: true };
}

async function clearSodaMusicLoginSession() {
  closeSodaQrWindow();
  const cookieSession = session.fromPartition(SODA_LOGIN_PARTITION);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  return { ok: true };
}

function getWindowedBounds(win) {
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const basis = display.bounds || area;
  const maxWidth = Math.max(640, area.width - WINDOWED_MARGIN);
  const maxHeight = Math.max(360, area.height - WINDOWED_MARGIN);

  let width = Math.round(basis.width * WINDOWED_SCALE);
  let height = Math.round(width / WINDOWED_ASPECT);
  const scaledHeight = Math.round(basis.height * WINDOWED_SCALE);

  if (height > scaledHeight) {
    height = scaledHeight;
    width = Math.round(height * WINDOWED_ASPECT);
  }

  if (width < MIN_WINDOWED_WIDTH && maxWidth >= MIN_WINDOWED_WIDTH && maxHeight >= MIN_WINDOWED_HEIGHT) {
    width = MIN_WINDOWED_WIDTH;
    height = MIN_WINDOWED_HEIGHT;
  }

  if (width > maxWidth) {
    width = maxWidth;
    height = Math.round(width / WINDOWED_ASPECT);
  }
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(height * WINDOWED_ASPECT);
  }

  width = Math.round(width);
  height = Math.round(height);

  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

function applyWindowedBounds(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize();
  win.setMinimumSize(MIN_WINDOWED_WIDTH, MIN_WINDOWED_HEIGHT);
  win.setBounds(getWindowedBounds(win), false);
  sendWindowState(win);
}

function exitFullscreenToWindow(win) {
  if (!win || win.isDestroyed()) return;
  windowFullscreenActive = false;

  if (!win.isFullScreen()) {
    applyWindowedBounds(win);
    return;
  }

  let applied = false;
  const applyOnce = () => {
    if (applied || !win || win.isDestroyed() || win.isFullScreen()) return;
    applied = true;
    applyWindowedBounds(win);
  };

  win.once('leave-full-screen', () => setTimeout(applyOnce, 50));
  win.setFullScreen(false);
  setTimeout(applyOnce, 500);
}

function toggleFullscreen(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen() || windowFullscreenActive) {
    exitFullscreenToWindow(win);
    return;
  }
  windowFullscreenActive = true;
  win.setFullScreen(true);
  sendWindowState(win);
}

function overlayUrl(page) {
  const port = mainServerPort || process.env.PORT || 3000;
  return `http://127.0.0.1:${port}/${page}`;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function desktopLyricsDefaultBounds(payload = desktopLyricsState) {
  const display = desktopLyricsUserBounds
    ? screen.getDisplayMatching(desktopLyricsUserBounds)
    : screen.getPrimaryDisplay();
  const bounds = display.bounds;
  const yRatio = clampNumber(payload.y, 0.08, 0.92, 0.76);
  const width = Math.round(Math.min(Math.max(880, bounds.width * 0.72), bounds.width - 96));
  const height = Math.round(Math.min(Math.max(340, bounds.height * 0.38), 560, bounds.height - 96));
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + bounds.height * yRatio - height / 2),
    width,
    height,
  };
}

function constrainDesktopLyricsBounds(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const area = display.bounds;
  const next = {
    ...bounds,
    width: Math.round(Math.min(Math.max(320, bounds.width), area.width)),
    height: Math.round(Math.min(Math.max(180, bounds.height), area.height)),
  };
  const maxX = area.x + Math.max(0, area.width - next.width);
  const maxY = area.y + Math.max(0, area.height - next.height);
  next.x = Math.round(clampNumber(next.x, area.x, maxX, area.x));
  next.y = Math.round(clampNumber(next.y, area.y, maxY, area.y));
  return next;
}

function setDesktopLyricsBounds(bounds) {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  const nextBounds = constrainDesktopLyricsBounds(bounds);
  const currentBounds = desktopLyricsWindow.getBounds();
  if (
    currentBounds.x === nextBounds.x
    && currentBounds.y === nextBounds.y
    && currentBounds.width === nextBounds.width
    && currentBounds.height === nextBounds.height
  ) {
    return;
  }
  desktopLyricsProgrammaticMove = true;
  desktopLyricsWindow.setBounds(nextBounds, false);
  setTimeout(() => {
    desktopLyricsProgrammaticMove = false;
  }, 120);
}

function rememberDesktopLyricsBounds() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsProgrammaticMove) return;
  desktopLyricsUserBounds = desktopLyricsWindow.getBounds();
}

function applyDesktopLyricsMouseBehavior() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  const locked = desktopLyricsState.clickThrough !== false;
  const shouldIgnore = locked || !desktopLyricsPointerCapture;
  if (desktopLyricsMouseIgnored === shouldIgnore) return;
  desktopLyricsMouseIgnored = shouldIgnore;
  desktopLyricsWindow.setIgnoreMouseEvents(shouldIgnore, { forward: true });
}

function desktopLyricsHotBoundsOnScreen() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return null;
  const winBounds = desktopLyricsWindow.getBounds();
  const rel = desktopLyricsHotBounds;
  if (!rel) return winBounds;
  return {
    x: winBounds.x + rel.left,
    y: winBounds.y + rel.top,
    width: Math.max(1, rel.right - rel.left),
    height: Math.max(1, rel.bottom - rel.top),
  };
}

function pointInBounds(point, bounds) {
  if (!point || !bounds) return false;
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}

function handleDesktopLyricsGlobalMiddleClick() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  if (!desktopLyricsState.enabled) return;
  const now = Date.now();
  if (now - desktopLyricsLastMiddleAt < 260) return;
  const point = screen.getCursorScreenPoint();
  if (!pointInBounds(point, desktopLyricsHotBoundsOnScreen())) return;
  desktopLyricsLastMiddleAt = now;
  const nextLocked = desktopLyricsState.clickThrough === false;
  desktopLyricsState = { ...desktopLyricsState, clickThrough: nextLocked };
  desktopLyricsPointerCapture = !nextLocked;
  applyDesktopLyricsMouseBehavior();
  broadcastDesktopLyricsLockState();
}

function startDesktopLyricsMousePoller() {
  if (process.platform !== 'win32' || desktopLyricsMousePoller) return;
  const script = `
$ErrorActionPreference = "SilentlyContinue"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MineradioMousePoll {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
}
"@
$prev = $false
while ($true) {
  $down = (([MineradioMousePoll]::GetAsyncKeyState(4) -band 0x8000) -ne 0)
  if ($down -and -not $prev) {
    [Console]::Out.WriteLine("MMB")
    [Console]::Out.Flush()
  }
  $prev = $down
  Start-Sleep -Milliseconds 24
}
`;
  try {
    desktopLyricsMousePoller = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    desktopLyricsMousePoller.stdout.on('data', (chunk) => {
      desktopLyricsMousePollerBuffer += chunk.toString('utf8');
      const lines = desktopLyricsMousePollerBuffer.split(/\r?\n/);
      desktopLyricsMousePollerBuffer = lines.pop() || '';
      lines.forEach((line) => {
        if (line.trim() === 'MMB') handleDesktopLyricsGlobalMiddleClick();
      });
    });
    desktopLyricsMousePoller.on('exit', () => {
      desktopLyricsMousePoller = null;
      desktopLyricsMousePollerBuffer = '';
    });
    desktopLyricsMousePoller.on('error', () => {
      desktopLyricsMousePoller = null;
      desktopLyricsMousePollerBuffer = '';
    });
  } catch (e) {
    desktopLyricsMousePoller = null;
    desktopLyricsMousePollerBuffer = '';
  }
}

function stopDesktopLyricsMousePoller() {
  if (!desktopLyricsMousePoller) return;
  try {
    desktopLyricsMousePoller.kill();
  } catch (e) {}
  desktopLyricsMousePoller = null;
  desktopLyricsMousePollerBuffer = '';
}

function broadcastDesktopLyricsLockState() {
  const locked = desktopLyricsState.clickThrough !== false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mineradio-desktop-lyrics-lock-state', { locked });
  }
  sendDesktopLyricsState();
}

function broadcastDesktopLyricsEnabledState(enabled) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mineradio-desktop-lyrics-enabled-state', { enabled: !!enabled });
  }
}

function positionDesktopLyricsWindow(payload = desktopLyricsState, options = {}) {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  const shouldUseManualBounds = desktopLyricsUserBounds && !options.force;
  setDesktopLyricsBounds(shouldUseManualBounds ? desktopLyricsUserBounds : desktopLyricsDefaultBounds(payload));
  if (typeof desktopLyricsWindow.setOpacity === 'function') {
    desktopLyricsWindow.setOpacity(clampNumber(payload.opacity, 0.28, 1, 0.92));
  }
}

function sendDesktopLyricsState() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  desktopLyricsWindow.webContents.send('mineradio-desktop-lyrics-state', desktopLyricsState);
}

function createDesktopLyricsWindow(payload = {}) {
  const previousY = desktopLyricsState.y;
  const previousOpacity = desktopLyricsState.opacity;
  desktopLyricsState = { ...desktopLyricsState, ...payload, enabled: true };
  const hasY = Object.prototype.hasOwnProperty.call(payload || {}, 'y');
  const nextY = clampNumber(desktopLyricsState.y, 0.08, 0.92, 0.76);
  const yChanged = hasY && Number.isFinite(Number(previousY)) && Math.abs(nextY - clampNumber(previousY, 0.08, 0.92, 0.76)) > 0.001;
  const opacityChanged = Object.prototype.hasOwnProperty.call(payload || {}, 'opacity')
    && Math.abs(clampNumber(desktopLyricsState.opacity, 0.28, 1, 0.92) - clampNumber(previousOpacity, 0.28, 1, 0.92)) > 0.001;
  if (yChanged) desktopLyricsUserBounds = null;
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    if (yChanged) {
      positionDesktopLyricsWindow(desktopLyricsState, { force: yChanged });
    } else if (opacityChanged && typeof desktopLyricsWindow.setOpacity === 'function') {
      desktopLyricsWindow.setOpacity(clampNumber(desktopLyricsState.opacity, 0.28, 1, 0.92));
    }
    applyDesktopLyricsMouseBehavior();
    sendDesktopLyricsState();
    return desktopLyricsWindow;
  }

  desktopLyricsWindow = new BrowserWindow({
    width: 920,
    height: 190,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    focusable: false,
    skipTaskbar: true,
    show: false,
    title: 'Mineradio Desktop Lyrics',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  try {
    desktopLyricsWindow.setAlwaysOnTop(true, 'screen-saver');
    desktopLyricsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) {
    console.warn('Desktop lyrics topmost setup skipped:', e.message);
  }
  startDesktopLyricsMousePoller();
  applyDesktopLyricsMouseBehavior();
  positionDesktopLyricsWindow(desktopLyricsState, { force: yChanged || !desktopLyricsUserBounds });
  desktopLyricsWindow.once('ready-to-show', () => {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
    desktopLyricsWindow.showInactive();
    sendDesktopLyricsState();
  });
  desktopLyricsWindow.webContents.once('did-finish-load', sendDesktopLyricsState);
  desktopLyricsWindow.on('closed', () => {
    desktopLyricsWindow = null;
    desktopLyricsMouseIgnored = null;
  });
  desktopLyricsWindow.on('moved', rememberDesktopLyricsBounds);
  desktopLyricsWindow.loadURL(overlayUrl('desktop-lyrics.html')).catch((e) => console.warn('Desktop lyrics load failed:', e.message));
  return desktopLyricsWindow;
}

function closeDesktopLyricsWindow() {
  desktopLyricsState = { ...desktopLyricsState, enabled: false };
  desktopLyricsPointerCapture = false;
  desktopLyricsMouseIgnored = null;
  desktopLyricsHotBounds = null;
  stopDesktopLyricsMousePoller();
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    sendDesktopLyricsState();
    desktopLyricsWindow.close();
  }
  desktopLyricsWindow = null;
  broadcastDesktopLyricsEnabledState(false);
}

function nativeWindowHandleDecimal(win) {
  const handle = win.getNativeWindowHandle();
  if (process.arch === 'x64') return handle.readBigUInt64LE(0).toString();
  return String(handle.readUInt32LE(0));
}

function attachWallpaperToWorkerW(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  const hwnd = nativeWindowHandleDecimal(win);
  const script = `
$ErrorActionPreference = "Stop"
if (-not ("MineradioNativeWin" -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MineradioNativeWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
}
"@
}
$progman = [MineradioNativeWin]::FindWindow("Progman", $null)
$result = [IntPtr]::Zero
[MineradioNativeWin]::SendMessageTimeout($progman, 0x052C, [IntPtr]::Zero, [IntPtr]::Zero, 0, 1000, [ref]$result) | Out-Null
$script:workerw = [IntPtr]::Zero
$enum = [MineradioNativeWin+EnumWindowsProc]{
  param([IntPtr]$top, [IntPtr]$param)
  $shell = [MineradioNativeWin]::FindWindowEx($top, [IntPtr]::Zero, "SHELLDLL_DefView", $null)
  if ($shell -ne [IntPtr]::Zero) {
    $script:workerw = [MineradioNativeWin]::FindWindowEx([IntPtr]::Zero, $top, "WorkerW", $null)
  }
  return $true
}
[MineradioNativeWin]::EnumWindows($enum, [IntPtr]::Zero) | Out-Null
if ($script:workerw -eq [IntPtr]::Zero) { $script:workerw = $progman }
$target = [IntPtr]::new([Int64]${hwnd})
[MineradioNativeWin]::SetParent($target, $script:workerw) | Out-Null
[MineradioNativeWin]::SetWindowPos($target, [IntPtr]::Zero, 0, 0, 0, 0, 0x0013) | Out-Null
`;
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    timeout: 5000,
  }, (error) => {
    if (error) console.warn('Wallpaper WorkerW attach failed:', error.message);
  });
}

function positionWallpaperWindow() {
  if (!wallpaperWindow || wallpaperWindow.isDestroyed()) return;
  const bounds = screen.getPrimaryDisplay().bounds;
  wallpaperWindow.setBounds(bounds, false);
}

function sendWallpaperState() {
  if (!wallpaperWindow || wallpaperWindow.isDestroyed()) return;
  wallpaperWindow.webContents.send('mineradio-wallpaper-state', wallpaperState);
}

function createWallpaperWindow(payload = {}) {
  wallpaperState = { ...wallpaperState, ...payload, enabled: true };
  if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
    positionWallpaperWindow();
    sendWallpaperState();
    return wallpaperWindow;
  }
  const bounds = screen.getPrimaryDisplay().bounds;
  wallpaperWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: false,
    backgroundColor: '#050608',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    title: 'Mineradio Wallpaper',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  wallpaperWindow.setIgnoreMouseEvents(true, { forward: true });
  wallpaperWindow.once('ready-to-show', () => {
    if (!wallpaperWindow || wallpaperWindow.isDestroyed()) return;
    positionWallpaperWindow();
    wallpaperWindow.showInactive();
    attachWallpaperToWorkerW(wallpaperWindow);
    sendWallpaperState();
  });
  wallpaperWindow.webContents.once('did-finish-load', sendWallpaperState);
  wallpaperWindow.on('closed', () => {
    wallpaperWindow = null;
  });
  wallpaperWindow.loadURL(overlayUrl('wallpaper.html')).catch((e) => console.warn('Wallpaper load failed:', e.message));
  return wallpaperWindow;
}

function closeWallpaperWindow() {
  wallpaperState = { ...wallpaperState, enabled: false };
  if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
    sendWallpaperState();
    wallpaperWindow.close();
  }
  wallpaperWindow = null;
}

function closeOverlayWindows() {
  closeSodaQrWindow();
  closeDesktopLyricsWindow();
  closeWallpaperWindow();
}

ipcMain.handle('desktop-window-minimize', (event) => {
  getSenderWindow(event)?.minimize();
});

ipcMain.handle('desktop-window-toggle-maximize', (event) => {
  toggleFullscreen(getSenderWindow(event));
});

ipcMain.handle('desktop-window-toggle-fullscreen', (event) => {
  toggleFullscreen(getSenderWindow(event));
});

ipcMain.handle('desktop-window-exit-fullscreen-windowed', (event) => {
  exitFullscreenToWindow(getSenderWindow(event));
});

ipcMain.handle('desktop-window-get-state', (event) => {
  return getWindowState(getSenderWindow(event));
});

ipcMain.handle('desktop-window-close', (event) => {
  getSenderWindow(event)?.close();
});

ipcMain.handle('mineradio-hotkeys-configure-global', (_event, bindings) => {
  return configureMineradioGlobalHotkeys(bindings);
});

ipcMain.handle('mineradio-export-json-file', async (event, payload = {}) => {
  try {
    const owner = getSenderWindow(event);
    const defaultName = String(payload.defaultName || 'mineradio-export.json').replace(/[\\/:*?"<>|]+/g, '-');
    const result = await dialog.showSaveDialog(owner, {
      title: '导出 Mineradio 存档',
      defaultPath: defaultName.toLowerCase().endsWith('.json') ? defaultName : `${defaultName}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const text = typeof payload.text === 'string' ? payload.text : JSON.stringify(payload.data || {}, null, 2);
    fs.writeFileSync(result.filePath, text, 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message || 'EXPORT_FAILED' };
  }
});

ipcMain.handle('mineradio-import-json-file', async (event) => {
  try {
    const owner = getSenderWindow(event);
    const result = await dialog.showOpenDialog(owner, {
      title: '导入 Mineradio 存档',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true };
    const filePath = result.filePaths[0];
    const text = fs.readFileSync(filePath, 'utf8');
    return { ok: true, filePath, text };
  } catch (e) {
    return { ok: false, error: e.message || 'IMPORT_FAILED' };
  }
});

ipcMain.handle('netease-music-open-login', async (event) => {
  return openNeteaseMusicLoginWindow(getSenderWindow(event));
});

ipcMain.handle('netease-music-clear-login', async () => {
  return clearNeteaseMusicLoginSession();
});

ipcMain.handle('qq-music-open-login', async (event) => {
  return openQQMusicLoginWindow(getSenderWindow(event));
});

ipcMain.handle('qq-music-clear-login', async () => {
  return clearQQMusicLoginSession();
});

ipcMain.handle('kugou-music-open-login', async (event) => {
  return openKugouMusicLoginWindow(getSenderWindow(event));
});

ipcMain.handle('kugou-music-clear-login', async () => {
  return clearKugouMusicLoginSession();
});

ipcMain.handle('soda-music-open-login', async (_event, options) => {
  return createSodaMusicQr(options);
});

ipcMain.handle('soda-music-create-qr', async (_event, options) => {
  return createSodaMusicQr(options);
});

ipcMain.handle('soda-music-qr-login-status', async () => {
  return getSodaMusicQrLoginStatus();
});

ipcMain.handle('soda-music-runtime-status', async () => {
  return getSodaBridgeRuntimeStatus();
});

ipcMain.handle('soda-music-clear-login', async () => {
  return clearSodaMusicLoginSession();
});

ipcMain.handle('mineradio-open-update-installer', async (_event, filePath) => {
  try {
    const target = path.resolve(String(filePath || ''));
    const updateDir = path.resolve(getUpdateDownloadDir());
    if (!target || !target.startsWith(updateDir + path.sep)) {
      return { ok: false, error: 'INVALID_UPDATE_PATH' };
    }
    if (!fs.existsSync(target)) return { ok: false, error: 'UPDATE_FILE_MISSING' };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'OPEN_UPDATE_FAILED' };
  }
});

ipcMain.handle('mineradio-restart-app', async () => {
  try {
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'RESTART_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-enabled', async (_event, enabled, payload) => {
  try {
    if (enabled) {
      createDesktopLyricsWindow(payload || {});
      broadcastDesktopLyricsEnabledState(true);
    } else {
      closeDesktopLyricsWindow();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-update', async (_event, payload) => {
  try {
    const nextState = { ...desktopLyricsState, ...(payload || {}) };
    if (nextState.enabled) {
      createDesktopLyricsWindow(payload || {});
    } else if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
      desktopLyricsState = nextState;
      sendDesktopLyricsState();
    } else {
      desktopLyricsState = nextState;
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_UPDATE_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-dragging', async () => {
  return { ok: true };
});

ipcMain.handle('mineradio-desktop-lyrics-set-pointer-capture', async (_event, active) => {
  try {
    desktopLyricsPointerCapture = !!active;
    applyDesktopLyricsMouseBehavior();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_POINTER_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-hot-bounds', async (_event, bounds) => {
  try {
    const left = clampNumber(bounds && bounds.left, -2000, 4000, 0);
    const top = clampNumber(bounds && bounds.top, -2000, 4000, 0);
    const right = clampNumber(bounds && bounds.right, left + 1, 6000, left + 1);
    const bottom = clampNumber(bounds && bounds.bottom, top + 1, 6000, top + 1);
    desktopLyricsHotBounds = { left, top, right, bottom };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_HOT_BOUNDS_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-lock-state', async (_event, locked) => {
  try {
    desktopLyricsState = { ...desktopLyricsState, clickThrough: !!locked };
    if (desktopLyricsState.clickThrough !== false) desktopLyricsPointerCapture = false;
    applyDesktopLyricsMouseBehavior();
    broadcastDesktopLyricsLockState();
    return { ok: true, locked: desktopLyricsState.clickThrough !== false };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_LOCK_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-move-by', async (_event, dx, dy) => {
  try {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return { ok: false, error: 'NO_DESKTOP_LYRICS_WINDOW' };
    if (desktopLyricsState.clickThrough !== false) return { ok: false, error: 'DESKTOP_LYRICS_LOCKED' };
    const bounds = desktopLyricsWindow.getBounds();
    const next = {
      ...bounds,
      x: Math.round(bounds.x + clampNumber(dx, -160, 160, 0)),
      y: Math.round(bounds.y + clampNumber(dy, -160, 160, 0)),
    };
    desktopLyricsWindow.setBounds(next, false);
    desktopLyricsUserBounds = desktopLyricsWindow.getBounds();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_MOVE_FAILED' };
  }
});

ipcMain.handle('mineradio-wallpaper-set-enabled', async (_event, enabled, payload) => {
  try {
    if (enabled) createWallpaperWindow(payload || {});
    else closeWallpaperWindow();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'WALLPAPER_FAILED' };
  }
});

ipcMain.handle('mineradio-wallpaper-update', async (_event, payload) => {
  try {
    wallpaperState = { ...wallpaperState, ...(payload || {}) };
    if (wallpaperState.enabled) {
      createWallpaperWindow(wallpaperState);
      if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
        positionWallpaperWindow();
        sendWallpaperState();
      }
    } else if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
      sendWallpaperState();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'WALLPAPER_UPDATE_FAILED' };
  }
});

function isTrustedMineradioOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch (_) {
    return false;
  }
}

function configureLocalPermissionHandlers() {
  const allow = (permission, url) => permission === 'geolocation' && isTrustedMineradioOrigin(url);
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return allow(permission, requestingOrigin || webContents.getURL());
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allow(permission, details && details.requestingUrl || webContents.getURL()));
  });
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }
  htmlFullscreenActive = false;
  windowFullscreenActive = false;

  if (localServer && localServer.listening) {
    const address = localServer.address();
    mainServerPort = address && typeof address === 'object' ? Number(address.port) : mainServerPort;
  } else {
    const port = await findOpenPort(3000);
    mainServerPort = port;

    process.env.HOST = '127.0.0.1';
    process.env.PORT = String(port);
    process.env.COOKIE_FILE = path.join(app.getPath('userData'), '.cookie');
    process.env.QQ_COOKIE_FILE = path.join(app.getPath('userData'), '.qq-cookie');
    process.env.KUGOU_COOKIE_FILE = path.join(app.getPath('userData'), '.kugou-cookie');
    process.env.SODA_COOKIE_FILE = path.join(app.getPath('userData'), '.soda-cookie');
    process.env.SODA_RUNTIME_STATE_DIR = path.join(app.getPath('userData'), 'soda-runtime');
    process.env.MINERADIO_UPDATE_DIR = getUpdateDownloadDir();
    process.env.SODA_BRIDGE_PORT = String(await findOpenPort(17891));
    await prepareBundledSodaBridge();
    try {
      const legacyQQCookie = path.join(__dirname, '..', '.qq-cookie');
      if (fs.existsSync(legacyQQCookie)) {
        if (!fs.existsSync(process.env.QQ_COOKIE_FILE)) {
          fs.copyFileSync(legacyQQCookie, process.env.QQ_COOKIE_FILE);
        }
        fs.unlinkSync(legacyQQCookie);
      }
    } catch (e) {
      console.warn('QQ cookie migration skipped:', e.message);
    }
    try {
      const legacySodaCookie = path.join(__dirname, '..', '.soda-cookie');
      if (fs.existsSync(legacySodaCookie) && !fs.existsSync(process.env.SODA_COOKIE_FILE)) {
        fs.copyFileSync(legacySodaCookie, process.env.SODA_COOKIE_FILE);
      }
    } catch (e) {
      console.warn('Soda cookie migration skipped:', e.message);
    }

    const serverPath = path.join(__dirname, '..', 'server.js');
    delete require.cache[require.resolve(serverPath)];
    localServer = require(serverPath);
    await waitForServer(localServer);
  }

  const port = mainServerPort || Number(process.env.PORT) || 3000;

  const initialBounds = getWindowedBounds();

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 960,
    minHeight: 540,
    show: false,
    frame: false,
    fullscreen: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    autoHideMenuBar: true,
    title: APP_NAME,
    icon: APP_ICON_ICO,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
    sendWindowState(mainWindow);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'Escape' || input.code === 'Escape') && mainWindow.isFullScreen()) {
      event.preventDefault();
      exitFullscreenToWindow(mainWindow);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    sendWindowState(mainWindow);
  });

  mainWindow.on('maximize', () => sendWindowState(mainWindow));
  mainWindow.on('unmaximize', () => sendWindowState(mainWindow));
  mainWindow.on('minimize', () => sendWindowState(mainWindow));
  mainWindow.on('restore', () => sendWindowState(mainWindow));
  mainWindow.on('show', () => sendWindowState(mainWindow));
  mainWindow.on('hide', () => sendWindowState(mainWindow));
  mainWindow.on('focus', () => sendWindowState(mainWindow));
  mainWindow.on('blur', () => sendWindowState(mainWindow));
  mainWindow.on('move', () => scheduleWindowStateSend(mainWindow));
  mainWindow.on('resize', () => scheduleWindowStateSend(mainWindow));
  mainWindow.on('closed', () => {
    if (mainWindowStateTimer) {
      clearTimeout(mainWindowStateTimer);
      mainWindowStateTimer = null;
    }
    closeOverlayWindows();
    mainWindow = null;
  });
  mainWindow.on('enter-full-screen', () => {
    windowFullscreenActive = true;
    sendWindowState(mainWindow);
  });
  mainWindow.on('leave-full-screen', () => {
    windowFullscreenActive = false;
    setTimeout(() => applyWindowedBounds(mainWindow), 50);
  });
  mainWindow.on('enter-html-full-screen', () => {
    htmlFullscreenActive = true;
    sendWindowState(mainWindow);
  });
  mainWindow.on('leave-html-full-screen', () => {
    htmlFullscreenActive = false;
    setTimeout(() => applyWindowedBounds(mainWindow), 50);
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`).catch((e) => {
    console.error('Mineradio main window load failed:', e.message);
    throw e;
  });
  return mainWindow;
}

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!focusMainWindow()) {
      app.whenReady().then(() => createWindow()).catch((e) => console.error('Second instance window restore failed:', e));
    }
  });

  app.whenReady().then(async () => {
    ensureDesktopShortcut();
    configureLocalPermissionHandlers();
    screen.on('display-metrics-changed', () => {
      positionDesktopLyricsWindow();
      positionWallpaperWindow();
      scheduleWindowStateSend(mainWindow);
    });
    screen.on('display-added', () => scheduleWindowStateSend(mainWindow));
    screen.on('display-removed', () => scheduleWindowStateSend(mainWindow));
    await createWindow();
  });

  app.on('activate', () => {
    if (!focusMainWindow()) createWindow().catch((e) => console.error('App activate window restore failed:', e));
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    unregisterMineradioGlobalHotkeys();
    closeOverlayWindows();
    if (localServer && typeof localServer.stopSodaBridge === 'function') localServer.stopSodaBridge();
    if (localServer && localServer.close) localServer.close();
  });
}

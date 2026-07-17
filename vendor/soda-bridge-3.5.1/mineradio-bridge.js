const port = Number(process.env.MINERADIO_SODA_BRIDGE_PORT || 0);
const token = String(process.env.MINERADIO_SODA_BRIDGE_TOKEN || '');

if (port && token) {
  const http = require('http');
  const path = require('path');
  const crypto = require('crypto');
  const fs = require('fs');
  const os = require('os');
  const zlib = require('zlib');
  const { app, BrowserWindow, net, session } = require('electron');
  const bridgeOnly = process.env.MINERADIO_SODA_BRIDGE_ONLY === '1';

  const suppressBridgeWindow = window => {
    if (!window || window.isDestroyed()) return;
    const hide = () => {
      try { if (!window.isDestroyed()) window.hide(); } catch (_) {}
    };
    try { window.setSkipTaskbar(true); } catch (_) {}
    try { window.show = () => {}; } catch (_) {}
    try { window.showInactive = () => {}; } catch (_) {}
    window.on('show', hide);
    window.on('ready-to-show', hide);
    hide();
  };
  if (bridgeOnly) app.on('browser-window-created', (_event, window) => suppressBridgeWindow(window));

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = req => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (_) { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });

  const withSessionCookies = async (cookie, task) => {
    const cookieJar = session.defaultSession.cookies;
    const previous = await cookieJar.get({ domain: 'qishui.com' });
    const incoming = String(cookie || '').split(';').map(value => value.trim()).filter(Boolean).map(value => {
      const index = value.indexOf('=');
      return index > 0 ? { name: value.slice(0, index).trim(), value: value.slice(index + 1).trim() } : null;
    }).filter(Boolean);
    for (const item of incoming) {
      await cookieJar.set({ url: 'https://api.qishui.com', name: item.name, value: item.value, path: '/', secure: true, httpOnly: true });
    }
    try {
      return await task();
    } finally {
      const current = await cookieJar.get({ domain: 'qishui.com' });
      for (const item of current) await cookieJar.remove('https://api.qishui.com', item.name).catch(() => {});
      for (const item of previous) {
        await cookieJar.set({ url: `https://${item.domain.replace(/^\./, '')}`, name: item.name, value: item.value, path: item.path || '/', secure: item.secure, httpOnly: item.httpOnly, expirationDate: item.expirationDate }).catch(() => {});
      }
    }
  };

  const playerVideos = player => {
    try {
      const model = JSON.parse(player && player.video_model || 'null');
      return Array.isArray(model && model.video_list) ? model.video_list.filter(item => item && item.main_url) : [];
    } catch (_) {
      return [];
    }
  };

  const sodaVideoMeta = video => video && video.video_meta && typeof video.video_meta === 'object' ? video.video_meta : {};
  const sodaVideoSourceQuality = video => String(sodaVideoMeta(video).quality || '').trim().toLowerCase();
  const sodaVideoBitrate = video => Number(sodaVideoMeta(video).real_bitrate || sodaVideoMeta(video).bitrate || 0) || 0;
  const sodaLevelForVideo = video => ({
    medium: 'standard',
    higher: 'exhigh',
    highest: 'lossless',
    hi_res: 'hires',
    spatial: 'jymaster',
  })[sodaVideoSourceQuality(video)] || 'standard';
  const sodaQualityCandidates = {
    standard: ['medium'],
    exhigh: ['higher', 'medium'],
    lossless: ['highest', 'higher', 'medium'],
    hires: ['hi_res', 'highest', 'higher', 'medium'],
    jymaster: ['spatial', 'hi_res', 'highest', 'higher', 'medium'],
  };
  const selectSodaVideo = (videos, preference) => {
    const list = (videos || []).filter(video => video && video.main_url);
    if (!list.length) return null;
    const desired = sodaQualityCandidates[String(preference || 'hires').toLowerCase()] || sodaQualityCandidates.hires;
    for (const quality of desired) {
      const match = list.find(video => sodaVideoSourceQuality(video) === quality);
      if (match) return match;
    }
    return list.slice().sort((left, right) => sodaVideoBitrate(right) - sodaVideoBitrate(left))[0];
  };

  const getPlayer = async body => {
    const id = String(body.id || '').trim();
    let vid = String(body.vid || '');
    const cookie = String(body.cookie || '');
    const requestedQuality = String(body.quality || 'hires').trim().toLowerCase();
    const sessionId = (/(?:^|;\s*)sessionid=([^;]+)/.exec(cookie) || [])[1] || '';
    const sessionSs = (/(?:^|;\s*)sessionid_ss=([^;]+)/.exec(cookie) || [])[1] || '';
    if (!id || (!sessionId && !sessionSs)) throw new Error('SODA_LOGIN_REQUIRED');
    const version = '3.5.2';
    const versionCode = 30502;
    if (!vid) {
      const detail = await getTrackV2({ id, cookie });
      const player = detail && (detail.track_player || detail.player_info || (Array.isArray(detail.player_infos) && detail.player_infos[0]));
      try {
        const videos = playerVideos(player);
        const video = selectSodaVideo(videos, requestedQuality);
        if (video && video.main_url) {
          const spade = video.encrypt_info && video.encrypt_info.spade_a;
          const decryptionKey = spade ? await require(path.join(__dirname, 'device.node')).decodeSpade(spade) : '';
          return { ok: true, url: String(video.main_url), decryptionKey: String(decryptionKey || ''), expireAt: Number(detail && detail.expire_at || 0) || 0, level: sodaLevelForVideo(video), sourceQuality: sodaVideoSourceQuality(video), br: sodaVideoBitrate(video) };
        }
      } catch (_) {}
      const tracks = [
        detail && detail.track,
        detail && detail.track_wrapper && detail.track_wrapper.track,
        detail && detail.track_wrapper && detail.track_wrapper.media && detail.track_wrapper.media.track,
      ];
      vid = String(tracks.map(track => track && (track.vid || track.video_id)).find(Boolean) || '');
      if (!vid) throw new Error('SODA_TRACK_VID_UNAVAILABLE');
    }
    const target = new URL('https://api.qishui.com/luna/media-player');
    Object.entries({ aid: '386088', device_platform: 'pc', version_name: version, version_code: String(versionCode), vid, media_type: 'track', media_id: id, queue_type: 'normal', enable_refresh_api: 'true', enable_dash: 'false' }).forEach(([key, value]) => target.searchParams.set(key, value));
    const requestBody = JSON.stringify({ vid, media_type: 'track', media_id: id, queue_type: 'normal', enable_refresh_api: true, enable_dash: false, scene_name: 'play_page' });
    const resolved = await withSessionCookies(cookie, async () => {
      const response = await net.fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        body: requestBody,
      });
      const data = JSON.parse(await response.text());
      const player = data && (data.track_player || data.player_info || (Array.isArray(data.player_infos) && data.player_infos[0]));
      try {
        const videos = playerVideos(player);
        const video = selectSodaVideo(videos, requestedQuality);
        if (video && video.main_url) {
          const spade = video.encrypt_info && video.encrypt_info.spade_a;
          const decryptionKey = spade ? await require(path.join(__dirname, 'device.node')).decodeSpade(spade) : '';
          return { data, playInfo: null, directUrl: String(video.main_url), decryptionKey: String(decryptionKey || ''), level: sodaLevelForVideo(video), sourceQuality: sodaVideoSourceQuality(video), br: sodaVideoBitrate(video) };
        }
      } catch (_) {}
      const playerInfoUrl = String(player && (player.url_player_info || player.url || player.play_url) || '');
      if (!playerInfoUrl) return { data, playInfo: null };
      const playInfoResponse = await net.fetch(playerInfoUrl);
      return { data, playInfo: JSON.parse(await playInfoResponse.text()) };
    });
    const data = resolved.data;
    const apiCode = Number(data && data.status_code || 0);
    if (apiCode) throw new Error(data && data.status_info && data.status_info.status_msg || data && data.message || `SODA_API_${apiCode}`);
    const list = resolved.playInfo && resolved.playInfo.Result && resolved.playInfo.Result.Data && resolved.playInfo.Result.Data.PlayInfoList;
    const first = Array.isArray(list) ? list.find(item => item && item.MainPlayUrl) : null;
    const url = String(resolved.directUrl || first && (first.MainPlayUrl || first.BackupPlayUrl) || '');
    if (!url) throw new Error('SODA_PLAYER_URL_UNAVAILABLE');
    return { ok: true, url, decryptionKey: String(resolved.decryptionKey || ''), expireAt: Number(data && data.expire_at || 0) || 0, level: String(resolved.level || 'standard'), sourceQuality: String(resolved.sourceQuality || ''), br: Number(resolved.br) || 0 };
  };

  const getTrackV2 = async body => {
    const id = String(body.id || '').trim();
    const cookie = String(body.cookie || '');
    const sessionId = (/(?:^|;\s*)sessionid=([^;]+)/.exec(cookie) || [])[1] || '';
    const sessionSs = (/(?:^|;\s*)sessionid_ss=([^;]+)/.exec(cookie) || [])[1] || '';
    if (!id || (!sessionId && !sessionSs)) throw new Error('SODA_LOGIN_REQUIRED');

    const version = '3.5.2';
    const versionCode = 30502;
    let device = {};
    try {
      device = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(app.getPath('userData'), 'DeviceV1'))).toString('utf8')) || {};
    } catch (_) {}
    const deviceId = String(device.did || '');
    const installId = String(device.iid || '');
    const request = {
      track_id: id,
      media_type: 'track',
      queue_type: '',
      enable_refresh_api: true,
      scene_name: 'play_page',
    };
    const query = {
      aid: '386088',
      app_name: 'luna_pc',
      region: 'cn',
      geo_region: 'cn',
      os_region: 'cn',
      sim_region: '',
      device_id: deviceId,
      iid: installId,
      cdid: '',
      version_name: version,
      version_code: String(versionCode),
      channel: 'official',
      build_mode: '',
      network_carrier: '',
      ac: 'wifi',
      tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
      resolution: '',
      device_platform: 'windows',
      device_type: 'Windows',
      os_version: os.version(),
      fp: deviceId,
    };
    return withSessionCookies(cookie, async () => {
      let lastError = null;
      for (const pathname of ['/luna/pc/track_v2', '/luna/track_v2']) {
        const target = new URL(`https://api.qishui.com${pathname}`);
        Object.entries(query).forEach(([key, value]) => target.searchParams.set(key, value));
        const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
        if (!window) throw new Error('SODA_RENDERER_UNAVAILABLE');
        const response = await window.webContents.executeJavaScript(`
          (async () => {
            const response = await fetch(${JSON.stringify(target.toString())}, {
              method: 'POST',
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: ${JSON.stringify(JSON.stringify(request))},
            });
            return { status: response.status, text: await response.text() };
          })()
        `, true);
        let data;
        try { data = JSON.parse(response.text); }
        catch (_) { lastError = new Error('SODA_TRACK_RESPONSE_INVALID'); continue; }
        const apiCode = Number(data && data.status_code || 0);
        if (!apiCode) return data || {};
        lastError = new Error(data && data.status_info && data.status_info.status_msg || data && data.message || `SODA_API_${apiCode}`);
      }
      throw lastError || new Error('SODA_TRACK_UNAVAILABLE');
    });
  };

  const getLyrics = async body => {
    const data = await getTrackV2(body);
    return { ok: true, lyric: data && data.lyric || null };
  };

  const start = () => {
    if (bridgeOnly) BrowserWindow.getAllWindows().forEach(suppressBridgeWindow);
    http.createServer(async (req, res) => {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
      if (!local.includes(req.socket.remoteAddress || '')) return send(res, 403, { ok: false, error: 'LOCAL_ONLY' });
      if (req.headers['x-mineradio-soda-bridge'] !== token) return send(res, 401, { ok: false, error: 'UNAUTHORIZED' });
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, ready: true });
      if (req.method !== 'POST' || !['/player', '/lyric'].includes(req.url)) return send(res, 404, { ok: false, error: 'NOT_FOUND' });
      try {
        const body = await readBody(req);
        send(res, 200, req.url === '/lyric' ? await getLyrics(body) : await getPlayer(body));
      }
      catch (error) { send(res, 502, { ok: false, error: error.message || String(error) }); }
    }).listen(port, '127.0.0.1');
  };

  app.whenReady().then(() => setTimeout(start, 3500));
}

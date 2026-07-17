'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BRIDGE_MARKER = Buffer.from('MINERADIO_SODA_BRIDGE_PORT');
const DEFAULT_PATCH_ROOT = path.join(__dirname, '..', 'build', 'soda-bridge');

function deploymentError(code, details) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details || {});
  return error;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toUpperCase();
}

function readJson(filePath, errorCode) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw deploymentError(errorCode || 'SODA_DEPLOY_MANIFEST_INVALID', { cause: error });
  }
}

function isSafeRelativePath(value) {
  const text = String(value || '').replace(/\\/g, '/');
  return !!text && !text.startsWith('/') && !text.split('/').includes('..');
}

function resolveInside(root, relativePath) {
  if (!isSafeRelativePath(relativePath)) throw deploymentError('SODA_DEPLOY_MANIFEST_INVALID');
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(root, relativePath);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw deploymentError('SODA_DEPLOY_MANIFEST_INVALID');
  }
  return target;
}

function loadManifest(patchRoot) {
  const manifest = readJson(path.join(patchRoot, 'manifest.json'), 'SODA_DEPLOY_MANIFEST_MISSING');
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.profiles)) {
    throw deploymentError('SODA_DEPLOY_MANIFEST_INVALID');
  }
  manifest.profiles.forEach(profile => {
    if (!profile || !profile.id || !isSafeRelativePath(profile.executable)
      || !/^[A-Fa-f0-9]{64}$/.test(String(profile.executableSha256 || ''))
      || !Array.isArray(profile.files) || !profile.files.length) {
      throw deploymentError('SODA_DEPLOY_MANIFEST_INVALID');
    }
    profile.files.forEach(file => {
      if (!file || !isSafeRelativePath(file.target) || !isSafeRelativePath(file.payload)
        || !/^[A-Fa-f0-9]{64}$/.test(String(file.sourceSha256 || ''))
        || !/^[A-Fa-f0-9]{64}$/.test(String(file.patchedSha256 || ''))) {
        throw deploymentError('SODA_DEPLOY_MANIFEST_INVALID');
      }
    });
  });
  return manifest;
}

function uniquePaths(values) {
  const seen = new Set();
  return values.filter(value => {
    if (!value) return false;
    let resolved;
    try { resolved = path.resolve(value); } catch (_) { return false; }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeInstallRoot(candidate) {
  if (!candidate) return '';
  let current = path.resolve(String(candidate).trim());
  try {
    if (fs.existsSync(current) && fs.statSync(current).isFile()) current = path.dirname(current);
  } catch (_) {}
  const base = path.basename(current).toLowerCase();
  if (base === 'packages') return path.dirname(current);
  if (/^\d+(?:\.\d+)+$/.test(base)) {
    const parent = path.dirname(current);
    return path.basename(parent).toLowerCase() === 'packages' ? path.dirname(parent) : parent;
  }
  return current;
}

const WINDOWS_UNINSTALL_QUERY = String.raw`
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$hives = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$items = foreach ($hive in $hives) {
  if (Test-Path -LiteralPath $hive) {
    Get-ChildItem -LiteralPath $hive -ErrorAction SilentlyContinue | ForEach-Object {
      $value = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
      [pscustomobject]@{
        DisplayName = [string]$value.DisplayName
        InstallLocation = [Environment]::ExpandEnvironmentVariables([string]$value.InstallLocation)
        DisplayIcon = [Environment]::ExpandEnvironmentVariables([string]$value.DisplayIcon)
        UninstallString = [Environment]::ExpandEnvironmentVariables([string]$value.UninstallString)
      }
    }
  }
}
ConvertTo-Json -InputObject @($items) -Compress
`;

function readRegistryUninstallEntries(runCommand) {
  try {
    const output = (runCommand || execFileSync)('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_UNINSTALL_QUERY,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 12000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const text = String(output || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.filter(entry => entry && typeof entry === 'object');
  } catch (_) {
    return [];
  }
}

function expandRegistryEnvironment(value, env) {
  const source = String(value || '');
  const variables = env || process.env;
  return source.replace(/%([^%]+)%/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : match
  ));
}

function registryDirectoryValue(value, env) {
  const text = expandRegistryEnvironment(value, env).trim();
  const quoted = /^"([^"]+)"\s*$/.exec(text);
  return (quoted ? quoted[1] : text).trim();
}

function registryCommandExecutable(value, env) {
  const text = expandRegistryEnvironment(value, env).trim();
  const quoted = /^"([^"]+)"/.exec(text);
  if (quoted) return quoted[1].trim();
  const unquoted = /^(.+?\.(?:exe|com|bat|cmd))(?:\s|,|$)/i.exec(text);
  return unquoted ? unquoted[1].trim() : '';
}

function isSodaClientExecutable(filePath) {
  return /^(?:SodaMusic|SodaMusicLauncher)\.exe$/i.test(path.basename(String(filePath || '')));
}

function isSodaUninstaller(filePath) {
  return /^(?:unins\d*|uninstall(?:er)?|sodamusic(?:launcher)?(?:uninstall|uninstaller)?)\.exe$/i
    .test(path.basename(String(filePath || '')));
}

function isSodaUninstallEntry(entry, env) {
  const displayName = String(entry && entry.DisplayName || '').trim();
  const displayIcon = registryCommandExecutable(entry && entry.DisplayIcon, env);
  return /(?:^|\s)(?:soda\s*music|sodamusic)(?:\s|$)|\u6c7d\u6c34\u97f3\u4e50/i.test(displayName)
    || isSodaClientExecutable(displayIcon);
}

function registryRootsFromEntries(entries, env) {
  const roots = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isSodaUninstallEntry(entry, env)) continue;

    const installLocation = registryDirectoryValue(entry.InstallLocation, env);
    if (installLocation) roots.push(normalizeInstallRoot(installLocation));

    const displayIcon = registryCommandExecutable(entry.DisplayIcon, env);
    if (isSodaClientExecutable(displayIcon)) roots.push(normalizeInstallRoot(path.dirname(displayIcon)));

    const uninstallExecutable = registryCommandExecutable(entry.UninstallString, env);
    if (isSodaUninstaller(uninstallExecutable)) {
      roots.push(normalizeInstallRoot(path.dirname(uninstallExecutable)));
    }
  }
  return uniquePaths(roots);
}

function registryInstallRoots(options) {
  options = options || {};
  if ((options.platform || process.platform) !== 'win32') return [];
  const entries = Array.isArray(options.entries)
    ? options.entries
    : readRegistryUninstallEntries(options.runCommand);
  return registryRootsFromEntries(entries, options.env || process.env);
}

function discoverInstallRoots(env) {
  env = env || process.env;
  const localAppData = env.LOCALAPPDATA || '';
  const programFiles = env.PROGRAMFILES || '';
  const programFilesX86 = env['PROGRAMFILES(X86)'] || '';
  return uniquePaths([
    env.SODA_MUSIC_HOME,
    path.join(localAppData, 'SodaMusic'),
    path.join(localAppData, 'Programs', 'SodaMusic'),
    path.join(programFiles, 'Soda Music'),
    path.join(programFilesX86, 'Soda Music'),
    'D:\\汽水音乐\\Soda Music',
    ...registryInstallRoots({ env }),
  ].filter(Boolean).map(normalizeInstallRoot)).filter(root => fs.existsSync(root));
}

function profileMatchesLayout(root, profile) {
  const executable = resolveInside(root, profile.executable);
  if (!fs.existsSync(executable) || sha256File(executable) !== String(profile.executableSha256).toUpperCase()) return false;
  return profile.files.every(file => fs.existsSync(resolveInside(root, file.target)));
}

function profileHasExecutable(root, profile) {
  const executable = resolveInside(root, profile.executable);
  return fs.existsSync(executable) && sha256File(executable) === String(profile.executableSha256).toUpperCase();
}

function profileStatus(root, profile) {
  const files = profile.files.map(file => {
    const target = resolveInside(root, file.target);
    const currentSha256 = sha256File(target);
    const sourceSha256 = String(file.sourceSha256).toUpperCase();
    const patchedSha256 = String(file.patchedSha256).toUpperCase();
    return {
      ...file,
      target,
      currentSha256,
      sourceSha256,
      patchedSha256,
      state: currentSha256 === patchedSha256 ? 'patched' : (currentSha256 === sourceSha256 ? 'source' : 'unknown'),
    };
  });
  const archive = files.find(file => file.bridgeArchive) || files.find(file => /app\.asar$/i.test(file.target));
  const archiveHasBridge = !!(archive && fs.readFileSync(archive.target).includes(BRIDGE_MARKER));
  return {
    files,
    archive,
    archiveHasBridge,
    fullyPatched: files.every(file => file.state === 'patched') && archiveHasBridge,
    hasUnknown: files.some(file => file.state === 'unknown'),
  };
}

function backupPathFor(file) {
  return `${file.target}.mineradio-bridge-backup-${file.sourceSha256.slice(0, 12).toLowerCase()}`;
}

function syncFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    // Some Windows filesystems reject fsync for ordinary files. Hash verification remains mandatory.
    if (!error || !['EPERM', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function writeState(stateFile, value) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const stage = `${stateFile}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(stage, JSON.stringify(value, null, 2), { mode: 0o600 });
    syncFile(stage);
    fs.renameSync(stage, stateFile);
  } catch (_) {}
}

function recoverInterruptedDeployment(root, profile, stateFile) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_) {
    return false;
  }
  if (!state || !['swapping', 'rollback_failed'].includes(state.state) || state.profile !== profile.id) return false;
  if (path.resolve(String(state.installRoot || '')) !== path.resolve(root) || !Array.isArray(state.files)) return false;

  const expected = new Map(profile.files.map(file => {
    const target = resolveInside(root, file.target);
    return [target, { file, target, backup: backupPathFor({ target, sourceSha256: file.sourceSha256 }) }];
  }));
  for (const entry of state.files) {
    const target = path.resolve(String(entry && entry.target || ''));
    const item = expected.get(target);
    if (!item || path.resolve(String(entry.backup || '')) !== path.resolve(item.backup)) {
      throw deploymentError('SODA_DEPLOY_RECOVERY_STATE_INVALID', { stateFile });
    }
  }

  for (const item of expected.values()) {
    const targetExists = fs.existsSync(item.target);
    const targetHash = targetExists ? sha256File(item.target) : '';
    if (targetHash === String(item.file.sourceSha256).toUpperCase()) continue;
    if (!fs.existsSync(item.backup) || sha256File(item.backup) !== String(item.file.sourceSha256).toUpperCase()) {
      throw deploymentError('SODA_DEPLOY_RECOVERY_FAILED', { target: item.target });
    }
    fs.copyFileSync(item.backup, item.target);
    if (sha256File(item.target) !== String(item.file.sourceSha256).toUpperCase()) {
      throw deploymentError('SODA_DEPLOY_RECOVERY_FAILED', { target: item.target });
    }
  }
  writeState(stateFile, {
    schemaVersion: 1,
    state: 'recovered',
    profile: profile.id,
    installRoot: root,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

function mapFileError(error) {
  if (error && (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES')) {
    return deploymentError('SODA_DEPLOY_TARGET_LOCKED', { cause: error });
  }
  return error;
}

function isSodaMusicRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const output = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq SodaMusic.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /"SodaMusic\.exe"/i.test(output);
  } catch (_) {
    return false;
  }
}

function restoreChangedFiles(changed) {
  const failures = [];
  for (const item of changed.slice().reverse()) {
    try {
      if (fs.existsSync(item.target) && sha256File(item.target) === item.sourceSha256) continue;
      if (fs.existsSync(item.target)) {
        const failed = `${item.target}.mineradio-failed-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
        fs.renameSync(item.target, failed);
        fs.copyFileSync(item.backup, item.target);
        fs.unlinkSync(failed);
      } else {
        fs.copyFileSync(item.backup, item.target);
      }
      if (sha256File(item.target) !== item.sourceSha256) throw new Error('restore hash mismatch');
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function deployProfile(root, profile, patchRoot, stateFile, options) {
  const status = profileStatus(root, profile);
  const executable = resolveInside(root, profile.executable);
  if (status.fullyPatched) {
    writeState(stateFile, {
      schemaVersion: 1,
      state: 'ready',
      profile: profile.id,
      installRoot: root,
      executable,
      archive: status.archive && status.archive.target,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, state: 'already_patched', root, executable, profile, status };
  }
  if (status.hasUnknown) {
    throw deploymentError('SODA_DEPLOY_SOURCE_HASH_MISMATCH', { root, profile: profile.id });
  }
  const clientRunning = options && typeof options.isSodaMusicRunning === 'function'
    ? !!options.isSodaMusicRunning()
    : isSodaMusicRunning();
  if (clientRunning) {
    throw deploymentError('SODA_DEPLOY_CLIENT_RUNNING', { root, profile: profile.id });
  }

  const pending = status.files.filter(file => file.state === 'source');
  const staged = [];
  const changed = [];
  writeState(stateFile, {
    schemaVersion: 1,
    state: 'staging',
    profile: profile.id,
    installRoot: root,
    executable,
    updatedAt: new Date().toISOString(),
  });

  try {
    for (const file of pending) {
      const payload = resolveInside(patchRoot, file.payload);
      if (!fs.existsSync(payload)) throw deploymentError('SODA_DEPLOY_PAYLOAD_MISSING', { payload: file.payload });
      if (sha256File(payload) !== file.patchedSha256) {
        throw deploymentError('SODA_DEPLOY_PAYLOAD_HASH_MISMATCH', { payload: file.payload });
      }
      const stage = `${file.target}.mineradio-stage-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      fs.copyFileSync(payload, stage);
      syncFile(stage);
      if (sha256File(stage) !== file.patchedSha256) {
        throw deploymentError('SODA_DEPLOY_PAYLOAD_HASH_MISMATCH', { payload: file.payload });
      }
      staged.push({ ...file, stage, backup: backupPathFor(file) });
    }

    for (const item of staged) {
      if (fs.existsSync(item.backup)) {
        if (sha256File(item.backup) !== item.sourceSha256) {
          throw deploymentError('SODA_DEPLOY_BACKUP_CONFLICT', { backup: item.backup });
        }
      } else {
        fs.copyFileSync(item.target, item.backup);
        syncFile(item.backup);
        if (sha256File(item.backup) !== item.sourceSha256) {
          throw deploymentError('SODA_DEPLOY_BACKUP_CONFLICT', { backup: item.backup });
        }
      }
      changed.push(item);
    }

    writeState(stateFile, {
      schemaVersion: 1,
      state: 'swapping',
      profile: profile.id,
      installRoot: root,
      executable,
      files: changed.map(item => ({ target: item.target, backup: item.backup })),
      updatedAt: new Date().toISOString(),
    });
    for (const item of staged) {
      const displaced = `${item.target}.mineradio-replace-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
      fs.renameSync(item.target, displaced);
      try {
        fs.renameSync(item.stage, item.target);
        fs.unlinkSync(displaced);
      } catch (error) {
        try {
          if (fs.existsSync(item.target)) fs.unlinkSync(item.target);
          if (fs.existsSync(displaced)) fs.renameSync(displaced, item.target);
        } catch (_) {}
        throw error;
      }
    }

    const verified = profileStatus(root, profile);
    if (!verified.fullyPatched) throw deploymentError('SODA_DEPLOY_VERIFY_FAILED', { root, profile: profile.id });
    writeState(stateFile, {
      schemaVersion: 1,
      state: 'ready',
      profile: profile.id,
      installRoot: root,
      executable,
      archive: verified.archive && verified.archive.target,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, state: 'deployed', root, executable, profile, status: verified };
  } catch (error) {
    const cleanupFailures = restoreChangedFiles(changed);
    const code = cleanupFailures.length ? 'SODA_DEPLOY_ROLLBACK_FAILED' : (error.code || 'SODA_DEPLOY_RENAME_FAILED');
    writeState(stateFile, {
      schemaVersion: 1,
      state: cleanupFailures.length ? 'rollback_failed' : 'rolled_back',
      profile: profile.id,
      installRoot: root,
      executable,
      error: code,
      updatedAt: new Date().toISOString(),
    });
    throw deploymentError(code, { cause: error, root, profile: profile.id });
  } finally {
    staged.forEach(item => {
      try { if (fs.existsSync(item.stage)) fs.unlinkSync(item.stage); } catch (_) {}
    });
  }
}

async function prepareSodaBridgeDeployment(options) {
  options = options || {};
  const patchRoot = options.patchRoot || DEFAULT_PATCH_ROOT;
  const userData = options.userData || path.join(process.env.APPDATA || process.cwd(), 'Mineradio');
  const stateFile = path.join(userData, 'soda-runtime', 'bridge-deployment.json');
  const supportsNoAsar = !!(process.versions && process.versions.electron)
    || Object.prototype.hasOwnProperty.call(process, 'noAsar');
  const previousNoAsar = process.noAsar;
  if (supportsNoAsar) process.noAsar = true;
  try {
    try {
      const manifest = loadManifest(patchRoot);
      const roots = Array.isArray(options.roots)
        ? uniquePaths(options.roots.map(normalizeInstallRoot)).filter(root => fs.existsSync(root))
        : discoverInstallRoots(options.env || process.env);
      if (!roots.length) throw deploymentError('SODA_DEPLOY_NOT_INSTALLED');
      let foundSupportedLayout = false;
      let lastError = null;
      for (const root of roots) {
        for (const profile of manifest.profiles) {
          if (!profileHasExecutable(root, profile)) continue;
          try {
            recoverInterruptedDeployment(root, profile, stateFile);
          } catch (error) {
            lastError = mapFileError(error);
            continue;
          }
          if (!profileMatchesLayout(root, profile)) continue;
          foundSupportedLayout = true;
          try {
            return { ...deployProfile(root, profile, patchRoot, stateFile, options), stateFile };
          } catch (error) {
            lastError = mapFileError(error);
          }
        }
      }
      if (lastError) throw lastError;
      throw deploymentError(foundSupportedLayout ? 'SODA_DEPLOY_LAYOUT_INVALID' : 'SODA_DEPLOY_VERSION_UNSUPPORTED');
    } catch (error) {
      const code = error && error.code || 'SODA_DEPLOY_FAILED';
      const result = { ok: false, state: 'failed', error: code, stateFile };
      writeState(stateFile, {
        schemaVersion: 1,
        state: 'failed',
        error: code,
        updatedAt: new Date().toISOString(),
      });
      return result;
    }
  } finally {
    if (supportsNoAsar) process.noAsar = previousNoAsar;
  }
}

module.exports = {
  BRIDGE_MARKER,
  DEFAULT_PATCH_ROOT,
  discoverInstallRoots,
  registryInstallRoots,
  registryRootsFromEntries,
  registryCommandExecutable,
  isSodaUninstallEntry,
  prepareSodaBridgeDeployment,
  profileStatus,
  isSodaMusicRunning,
  sha256File,
};

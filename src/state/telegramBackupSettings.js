const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;

export function getTelegramBackupSettingsRow(db) {
  return db.prepare('SELECT * FROM telegram_backup_settings WHERE id = 1').get();
}

export function resolveTelegramBackupConfig(config, db) {
  const row = getTelegramBackupSettingsRow(db);
  const dbSaved = Boolean(row?.updated_by || pickString(row?.bot_token, null) || pickString(row?.chat_id, null));
  const envEnabled = parseEnvBool(config.telegramBackupEnabled);
  const envAutoAfterSync = parseEnvBool(config.telegramBackupAutoAfterSync);
  const envAutoSchedule = parseEnvBool(config.telegramBackupAutoSchedule);

  return {
    enabled: dbSaved ? Boolean(row.enabled) : envEnabled,
    botToken: pickString(row?.bot_token, config.telegramBackupBotToken),
    chatId: pickString(row?.chat_id, config.telegramBackupChatId),
    autoAfterAssetSync: dbSaved ? Boolean(row.auto_after_asset_sync) : envAutoAfterSync,
    autoScheduleEnabled: dbSaved ? Boolean(row.auto_schedule_enabled) : envAutoSchedule,
    autoScheduleTimeUtc: pickString(row?.auto_schedule_time_utc, '04:00') || '04:00',
    pinMasterCatalog: row?.pin_master_catalog == null ? true : Boolean(row.pin_master_catalog),
    incrementalDefault: row?.incremental_default == null ? true : Boolean(row.incremental_default),
    silentUploads: row?.silent_uploads == null ? true : Boolean(row.silent_uploads),
    maxChunkBytes: row?.max_chunk_bytes ?? config.telegramBackupMaxChunkBytes ?? 50331648,
    rateLimitMs: row?.rate_limit_ms ?? config.telegramBackupRateLimitMs ?? 3000,
    lastScheduleRunDate: row?.last_schedule_run_date ?? null,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
    configured: Boolean(
      (pickString(row?.bot_token, config.telegramBackupBotToken))
      && (pickString(row?.chat_id, config.telegramBackupChatId)),
    ),
  };
}

export function toPublicTelegramBackupSettings(effective, { includeToken = false } = {}) {
  return {
    enabled: effective.enabled,
    bot_token: includeToken ? effective.botToken : maskBotToken(effective.botToken),
    bot_token_set: Boolean(effective.botToken),
    chat_id: effective.chatId ?? '',
    auto_after_asset_sync: effective.autoAfterAssetSync,
    auto_schedule_enabled: effective.autoScheduleEnabled,
    auto_schedule_time_utc: effective.autoScheduleTimeUtc,
    pin_master_catalog: effective.pinMasterCatalog,
    incremental_default: effective.incrementalDefault,
    silent_uploads: effective.silentUploads,
    max_chunk_bytes: effective.maxChunkBytes,
    max_chunk_mb: Math.round(effective.maxChunkBytes / (1024 * 1024)),
    rate_limit_ms: effective.rateLimitMs,
    configured: effective.configured,
    updated_at: effective.updatedAt,
    updated_by: effective.updatedBy,
  };
}

export function validateTelegramBackupSettingsInput(input) {
  const patch = {};
  if (input.enabled != null) patch.enabled = Boolean(input.enabled);
  if (input.auto_after_asset_sync != null) patch.auto_after_asset_sync = Boolean(input.auto_after_asset_sync);
  if (input.auto_schedule_enabled != null) patch.auto_schedule_enabled = Boolean(input.auto_schedule_enabled);
  if (input.pin_master_catalog != null) patch.pin_master_catalog = Boolean(input.pin_master_catalog);
  if (input.incremental_default != null) patch.incremental_default = Boolean(input.incremental_default);
  if (input.silent_uploads != null) patch.silent_uploads = Boolean(input.silent_uploads);

  if (input.chat_id != null) {
    const chatId = String(input.chat_id).trim();
    if (!chatId) return { ok: false, message: 'Informe o chat_id do canal.' };
    if (!/^-?\d+$/.test(chatId) && !chatId.startsWith('@')) {
      return { ok: false, message: 'chat_id inválido (use -100… ou @canal).' };
    }
    patch.chat_id = chatId;
  }

  if (input.bot_token != null) {
    const token = String(input.bot_token).trim();
    if (token && token !== '••••••••' && !token.includes('•')) {
      if (!BOT_TOKEN_RE.test(token)) {
        return { ok: false, message: 'Token do bot inválido (formato 123456789:ABC...).' };
      }
      patch.bot_token = token;
    }
  }

  if (input.auto_schedule_time_utc != null) {
    const time = String(input.auto_schedule_time_utc).trim();
    if (!/^\d{2}:\d{2}$/.test(time)) {
      return { ok: false, message: 'Horário UTC inválido (use HH:MM).' };
    }
    patch.auto_schedule_time_utc = time;
  }

  if (input.max_chunk_bytes != null) {
    const bytes = Number.parseInt(String(input.max_chunk_bytes), 10);
    if (!Number.isFinite(bytes) || bytes < 1024 * 1024) {
      return { ok: false, message: 'max_chunk_bytes deve ser >= 1 MB.' };
    }
    patch.max_chunk_bytes = bytes;
  } else if (input.max_chunk_mb != null) {
    const mb = Number.parseInt(String(input.max_chunk_mb), 10);
    if (!Number.isFinite(mb) || mb < 1) {
      return { ok: false, message: 'Tamanho do chunk inválido.' };
    }
    patch.max_chunk_bytes = mb * 1024 * 1024;
  }

  if (input.rate_limit_ms != null) {
    const ms = Number.parseInt(String(input.rate_limit_ms), 10);
    if (!Number.isFinite(ms) || ms < 500) {
      return { ok: false, message: 'rate_limit_ms deve ser >= 500.' };
    }
    patch.rate_limit_ms = ms;
  }

  return { ok: true, patch };
}

export function updateTelegramBackupSettings(db, patch, { updatedBy = null } = {}) {
  const current = getTelegramBackupSettingsRow(db) ?? {};
  const next = {
    enabled: patch.enabled != null ? (patch.enabled ? 1 : 0) : (current.enabled ?? 0),
    bot_token: patch.bot_token != null ? patch.bot_token : current.bot_token,
    chat_id: patch.chat_id != null ? patch.chat_id : current.chat_id,
    auto_after_asset_sync: patch.auto_after_asset_sync != null ? (patch.auto_after_asset_sync ? 1 : 0) : (current.auto_after_asset_sync ?? 0),
    auto_schedule_enabled: patch.auto_schedule_enabled != null ? (patch.auto_schedule_enabled ? 1 : 0) : (current.auto_schedule_enabled ?? 0),
    auto_schedule_time_utc: patch.auto_schedule_time_utc ?? current.auto_schedule_time_utc ?? '04:00',
    pin_master_catalog: patch.pin_master_catalog != null ? (patch.pin_master_catalog ? 1 : 0) : (current.pin_master_catalog ?? 1),
    incremental_default: patch.incremental_default != null ? (patch.incremental_default ? 1 : 0) : (current.incremental_default ?? 1),
    silent_uploads: patch.silent_uploads != null ? (patch.silent_uploads ? 1 : 0) : (current.silent_uploads ?? 1),
    max_chunk_bytes: patch.max_chunk_bytes ?? current.max_chunk_bytes ?? 50331648,
    rate_limit_ms: patch.rate_limit_ms ?? current.rate_limit_ms ?? 3000,
    updated_by: updatedBy,
  };

  db.prepare(`
    INSERT INTO telegram_backup_settings (
      id, enabled, bot_token, chat_id, auto_after_asset_sync, auto_schedule_enabled,
      auto_schedule_time_utc, pin_master_catalog, incremental_default, silent_uploads,
      max_chunk_bytes, rate_limit_ms, updated_at, updated_by
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
    ON CONFLICT(id) DO UPDATE SET
      enabled = excluded.enabled,
      bot_token = excluded.bot_token,
      chat_id = excluded.chat_id,
      auto_after_asset_sync = excluded.auto_after_asset_sync,
      auto_schedule_enabled = excluded.auto_schedule_enabled,
      auto_schedule_time_utc = excluded.auto_schedule_time_utc,
      pin_master_catalog = excluded.pin_master_catalog,
      incremental_default = excluded.incremental_default,
      silent_uploads = excluded.silent_uploads,
      max_chunk_bytes = excluded.max_chunk_bytes,
      rate_limit_ms = excluded.rate_limit_ms,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(
    next.enabled,
    next.bot_token ?? null,
    next.chat_id ?? null,
    next.auto_after_asset_sync,
    next.auto_schedule_enabled,
    next.auto_schedule_time_utc,
    next.pin_master_catalog,
    next.incremental_default,
    next.silent_uploads,
    next.max_chunk_bytes,
    next.rate_limit_ms,
    next.updated_by,
  );

  return getTelegramBackupSettingsRow(db);
}

export function markTelegramBackupScheduleRan(db, date) {
  db.prepare(`
    UPDATE telegram_backup_settings
    SET last_schedule_run_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `).run(date);
}

export function maskBotToken(token) {
  if (!token) return '';
  const value = String(token);
  const colon = value.indexOf(':');
  if (colon < 0) return '••••••••';
  const prefix = value.slice(0, colon + 1);
  const secret = value.slice(colon + 1);
  if (secret.length <= 4) return `${prefix}••••`;
  return `${prefix}${'•'.repeat(Math.min(secret.length - 4, 12))}${secret.slice(-4)}`;
}

function pickString(primary, fallback) {
  const a = primary != null && String(primary).trim() ? String(primary).trim() : '';
  if (a) return a;
  const b = fallback != null && String(fallback).trim() ? String(fallback).trim() : '';
  return b || null;
}

function parseEnvBool(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

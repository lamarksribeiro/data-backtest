import { parseCatalogJson } from './catalog.js';
import { createTelegramClient, telegramRefFromMessage } from './telegramClient.js';

export function isMasterCatalogMessage(message) {
  const doc = message?.document;
  if (!doc?.file_id) return false;
  const name = String(doc.file_name || '').toLowerCase();
  const caption = String(message.caption || '');
  if (name === 'master_catalog.json' || name.endsWith('/master_catalog.json')) return true;
  if (caption.includes('#master_catalog')) return true;
  if (caption.includes('#GLBackup') && caption.includes('master_catalog')) return true;
  return false;
}

export function summarizeMasterCatalog(master) {
  const underlyings = [];
  let partitionCount = 0;
  for (const asset of master.assets || []) {
    if (asset.underlying) underlyings.push(asset.underlying);
    partitionCount += Number(asset.partitions || 0);
  }
  return {
    backup_run_id: master.backup_run_id ?? null,
    created_at: master.created_at ?? null,
    asset_count: master.assets?.length ?? 0,
    partition_count: partitionCount,
    underlyings,
  };
}

export async function discoverTelegramBackupCatalog({ backupConfig, fetchImpl }) {
  if (!backupConfig?.botToken || !backupConfig?.chatId) {
    return { ok: false, code: 'NOT_CONFIGURED', message: 'Token do bot e chat_id são obrigatórios.' };
  }

  const client = createTelegramClient({
    botToken: backupConfig.botToken,
    chatId: backupConfig.chatId,
    rateLimitMs: backupConfig.rateLimitMs,
    fetchImpl,
  });

  let chat;
  try {
    chat = await client.getChat();
  } catch (err) {
    return { ok: false, code: 'CHAT_UNREACHABLE', message: err.message };
  }

  const candidates = [];
  if (chat?.pinned_message && isMasterCatalogMessage(chat.pinned_message)) {
    candidates.push({ source: 'pinned', message: chat.pinned_message });
  }

  if (!candidates.length) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'Nenhum master_catalog.json fixado no canal. Fixe o catálogo mestre no backup ou informe o file_id manualmente.',
      chat_title: chat?.title ?? null,
    };
  }

  for (const candidate of candidates) {
    try {
      const ref = telegramRefFromMessage(candidate.message);
      const buf = await client.downloadFile(ref.file_id);
      const master = parseCatalogJson(buf);
      if (master.kind !== 'master_catalog') {
        continue;
      }
      const summary = summarizeMasterCatalog(master);
      return {
        ok: true,
        master_file_id: ref.file_id,
        message_id: ref.message_id,
        file_name: ref.file_name,
        source: candidate.source,
        discovered_at: new Date().toISOString(),
        chat_title: chat?.title ?? null,
        ...summary,
      };
    } catch {
      // try next candidate
    }
  }

  return {
    ok: false,
    code: 'INVALID_CATALOG',
    message: 'Mensagem fixada não é um master_catalog válido.',
    chat_title: chat?.title ?? null,
  };
}

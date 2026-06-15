/** Limite de download via Bot API (getFile) — arquivos maiores retornam "file is too big". */
export const TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/** Tamanho máximo seguro por chunk (margem abaixo do limite de download). */
export const TELEGRAM_MAX_CHUNK_BYTES = 19 * 1024 * 1024;

/** Padrão recomendado para backup/restauração round-trip via bot. */
export const TELEGRAM_DEFAULT_CHUNK_BYTES = 18 * 1024 * 1024;

export function clampTelegramChunkBytes(bytes) {
  const n = Number.parseInt(String(bytes), 10);
  if (!Number.isFinite(n)) return TELEGRAM_DEFAULT_CHUNK_BYTES;
  return Math.min(Math.max(n, 1024 * 1024), TELEGRAM_MAX_CHUNK_BYTES);
}

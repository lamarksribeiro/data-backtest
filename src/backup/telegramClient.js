import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const API_BASE = 'https://api.telegram.org';

export function createTelegramClient({ botToken, chatId, rateLimitMs = 3000, fetchImpl = globalThis.fetch }) {
  if (!botToken) throw new Error('Telegram bot token is required');
  if (!chatId) throw new Error('Telegram chat_id is required');

  let lastRequestAt = 0;

  async function throttle() {
    const now = Date.now();
    const wait = rateLimitMs - (now - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  }

  async function apiCall(method, body, { multipart = false } = {}) {
    await throttle();
    const url = `${API_BASE}/bot${botToken}/${method}`;
    const init = multipart
      ? { method: 'POST', body }
      : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };
    const res = await fetchImpl(url, init);
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(data.description || `Telegram API ${method} failed`);
      err.code = data.error_code;
      throw err;
    }
    return data.result;
  }

  return {
    async sendMessage(text, { disableNotification = false } = {}) {
      return apiCall('sendMessage', {
        chat_id: chatId,
        text,
        disable_notification: disableNotification,
        disable_web_page_preview: true,
      });
    },

    async sendDocument(filePath, { caption = '', filename, disableNotification = false } = {}) {
      const buffer = await readFile(filePath);
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', new Blob([buffer]), filename || basename(filePath));
      if (caption) form.append('caption', caption.slice(0, 1024));
      form.append('disable_notification', disableNotification ? 'true' : 'false');
      return apiCall('sendDocument', form, { multipart: true });
    },

    async sendDocumentBuffer(buffer, { filename, caption = '', disableNotification = false } = {}) {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', new Blob([buffer]), filename);
      if (caption) form.append('caption', caption.slice(0, 1024));
      form.append('disable_notification', disableNotification ? 'true' : 'false');
      return apiCall('sendDocument', form, { multipart: true });
    },

    async pinChatMessage(messageId) {
      return apiCall('pinChatMessage', {
        chat_id: chatId,
        message_id: messageId,
        disable_notification: true,
      });
    },

    async getFile(fileId) {
      return apiCall('getFile', { file_id: fileId });
    },

    async downloadFile(fileId) {
      const file = await this.getFile(fileId);
      const filePath = file.file_path;
      const url = `${API_BASE}/file/bot${botToken}/${filePath}`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`Failed to download Telegram file: ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    },

    async downloadMessageDocument(message) {
      const doc = message?.document;
      if (!doc?.file_id) throw new Error('Message has no document');
      return this.downloadFile(doc.file_id);
    },
  };
}

export function telegramRefFromMessage(message) {
  const doc = message?.document;
  return {
    message_id: message?.message_id,
    file_id: doc?.file_id,
    file_name: doc?.file_name,
    file_size: doc?.file_size,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Composer attachments, v1: the file's bytes ride the run input as an inline
// base64 content part, which the BFF forwards as an A2A FilePart
// (go spec: file {name, mimeType, bytes}). No upload service exists fleet-local,
// and the inline path keeps the egress boundary intact — bytes go to the BFF
// only, the same as the prompt text.

import type { AttachmentAdapter } from '@assistant-ui/react';

const MAX_INLINE_BYTES = 5 * 1024 * 1024;

// The BFF refuses anything else with `attachment_type_unsupported`, so the
// picker must not offer it either.
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv']);

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      // data:<mime>;base64,XXXX — the prefix is not part of the A2A bytes field.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export const fleetAttachments: AttachmentAdapter = {
  accept: [...ALLOWED_TYPES].join(','),
  async add({ file }) {
    if (!ALLOWED_TYPES.has(file.type)) throw new Error(`unsupported attachment type "${file.type || file.name}"`);
    if (file.size > MAX_INLINE_BYTES) throw new Error('attachment is larger than 5 MB');
    return {
      id: globalThis.crypto.randomUUID(),
      type: file.type.startsWith('image/') ? 'image' : 'document',
      name: file.name,
      contentType: file.type,
      file,
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  },
  async send(attachment) {
    const { file } = attachment;
    const data = await readBase64(file);
    const mimeType = file.type || 'application/octet-stream';
    return {
      ...attachment,
      status: { type: 'complete' },
      content: mimeType.startsWith('image/')
        ? [{ type: 'image', image: `data:${mimeType};base64,${data}`, filename: file.name }]
        : [{ type: 'file', data, mimeType, filename: file.name }],
    };
  },
  async remove() {},
};

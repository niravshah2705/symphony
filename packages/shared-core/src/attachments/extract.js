'use strict';

const MAX_EXTRACTED_TEXT_CHARS = 2_000_000; // caps embedding-call cost/latency on pathological files

function boundText(raw) {
  const text = String(raw || '');
  if (text.length > MAX_EXTRACTED_TEXT_CHARS) {
    return { text: text.slice(0, MAX_EXTRACTED_TEXT_CHARS), truncated: true };
  }
  return { text, truncated: false };
}

async function extractPdf(buffer) {
  // pdf-parse v2 API: a stateful PDFParse instance, not the v1 default-export function.
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return boundText(result.text);
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(buffer) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.extractRawText({ buffer });
  return boundText(value);
}

function extractTxt(buffer) {
  return boundText(buffer.toString('utf8'));
}

/**
 * Extract plain text from an attachment's raw bytes, per its resolved type.
 * Only called for `extractable: true` types (pdf/docx/txt) — legacy .doc and
 * images are never routed here; callers should check `extractable` first.
 */
async function extractText(buffer, typeKey) {
  switch (typeKey) {
    case 'pdf':
      return extractPdf(buffer);
    case 'docx':
      return extractDocx(buffer);
    case 'txt':
      return extractTxt(buffer);
    default:
      throw new Error(`extractText called for a non-extractable type: "${typeKey}".`);
  }
}

module.exports = { extractText, MAX_EXTRACTED_TEXT_CHARS };

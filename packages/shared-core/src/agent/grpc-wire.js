'use strict';

/**
 * Shared minimal protobuf wire codec + gRPC message framing.
 *
 * Lifted out of the retired OpenShell client so every gRPC-over-HTTP/2 caller —
 * today `./substrate.js` — drives a control plane without carrying its own copy
 * of the wire primitives.
 */

// ── Minimal Protobuf Wire Encoder / Decoder ─────────────────────────────────

function encodeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) {
    v = BigInt.asUintN(64, v);
  }
  const bytes = [];
  while (v > 0x7fn) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function pbVarint(fieldNumber, value) {
  if (value === undefined || value === null || value === false || value === 0) {
    return Buffer.alloc(0);
  }
  const num = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(num)]);
}

function pbBytes(fieldNumber, buf) {
  if (!buf) return Buffer.alloc(0);
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  if (b.length === 0) return Buffer.alloc(0);
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(b.length), b]);
}

function pbString(fieldNumber, str) {
  if (str === undefined || str === null || str === '') return Buffer.alloc(0);
  return pbBytes(fieldNumber, Buffer.from(String(str), 'utf8'));
}

function pbMessage(fieldNumber, parts) {
  const buf = Buffer.isBuffer(parts)
    ? parts
    : Buffer.concat((parts || []).filter((p) => p && p.length > 0));
  if (buf.length === 0) return Buffer.alloc(0);
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(buf.length), buf]);
}

function pbMapStringString(fieldNumber, record) {
  if (!record || typeof record !== 'object') return Buffer.alloc(0);
  const entries = [];
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null) continue;
    const entry = Buffer.concat([pbString(1, String(k)), pbString(2, String(v))]);
    entries.push(Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(entry.length), entry]));
  }
  return entries.length ? Buffer.concat(entries) : Buffer.alloc(0);
}

function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error('Protobuf varint overflow');
    }
  }
  throw new Error('Truncated protobuf varint');
}

function skipWireType(buf, offset, wireType) {
  if (wireType === 0) {
    const v = decodeVarint(buf, offset);
    return v.nextOffset;
  } else if (wireType === 1) {
    return offset + 8;
  } else if (wireType === 2) {
    const len = decodeVarint(buf, offset);
    return len.nextOffset + Number(len.value);
  } else if (wireType === 3) {
    // Start group: skip fields until end group (wireType 4) matching fieldNumber or group end
    let currentOffset = offset;
    while (currentOffset < buf.length) {
      const tag = decodeVarint(buf, currentOffset);
      currentOffset = tag.nextOffset;
      const subWireType = Number(tag.value & 0x7n);
      if (subWireType === 4) {
        break; // End group
      }
      currentOffset = skipWireType(buf, currentOffset, subWireType);
    }
    return currentOffset;
  } else if (wireType === 5) {
    return offset + 4;
  } else {
    throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
}

function decodeFields(buf) {
  const fields = new Map();
  let offset = 0;
  while (offset < buf.length) {
    const tag = decodeVarint(buf, offset);
    offset = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x7n);
    let value;
    if (wireType === 0) {
      const v = decodeVarint(buf, offset);
      offset = v.nextOffset;
      value = Number(v.value);
    } else if (wireType === 1) {
      value = buf.subarray(offset, offset + 8);
      offset += 8;
    } else if (wireType === 2) {
      const len = decodeVarint(buf, offset);
      offset = len.nextOffset;
      const byteLen = Number(len.value);
      value = buf.subarray(offset, offset + byteLen);
      offset += byteLen;
    } else if (wireType === 3) {
      // Start group: skip until group end (wireType 4)
      const groupStart = offset;
      offset = skipWireType(buf, offset, 3);
      value = buf.subarray(groupStart, offset);
    } else if (wireType === 4) {
      // End group marker, stop parsing if present at top level
      break;
    } else if (wireType === 5) {
      value = buf.subarray(offset, offset + 4);
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
    if (!fields.has(fieldNumber)) fields.set(fieldNumber, []);
    fields.get(fieldNumber).push({ wireType, value });
  }
  return fields;
}

function getString(fields, fieldNumber, fallback = '') {
  const list = fields.get(fieldNumber);
  if (!list || list.length === 0) return fallback;
  const last = list[list.length - 1];
  return Buffer.isBuffer(last.value) ? last.value.toString('utf8') : String(last.value ?? fallback);
}

function getStrings(fields, fieldNumber) {
  const list = fields.get(fieldNumber) || [];
  return list
    .map((item) => (Buffer.isBuffer(item.value) ? item.value.toString('utf8') : String(item.value ?? '')))
    .filter(Boolean);
}

function getVarint(fields, fieldNumber, fallback = 0) {
  const list = fields.get(fieldNumber);
  if (!list || list.length === 0) return fallback;
  const last = list[list.length - 1];
  return typeof last.value === 'number' ? last.value : fallback;
}

function getSubmessages(fields, fieldNumber) {
  const list = fields.get(fieldNumber) || [];
  return list
    .filter((item) => Buffer.isBuffer(item.value))
    .map((item) => decodeFields(item.value));
}

function getSubmessage(fields, fieldNumber) {
  const subs = getSubmessages(fields, fieldNumber);
  return subs.length ? subs[subs.length - 1] : null;
}

function getMapStringString(fields, fieldNumber) {
  const out = {};
  for (const sub of getSubmessages(fields, fieldNumber)) {
    const k = getString(sub, 1);
    const v = getString(sub, 2);
    if (k) out[k] = v;
  }
  return out;
}

// ── gRPC Framing ────────────────────────────────────────────────────────────

function frameGrpcMessage(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
  const header = Buffer.alloc(5);
  header[0] = 0; // uncompressed
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function unframeGrpcMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const compressed = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    if (offset + 5 + length > buffer.length) break;
    const msg = buffer.subarray(offset + 5, offset + 5 + length);
    messages.push({ compressed, data: msg });
    offset += 5 + length;
  }
  return messages;
}

module.exports = {
  encodeVarint,
  encodeTag,
  pbVarint,
  pbBytes,
  pbString,
  pbMessage,
  pbMapStringString,
  decodeVarint,
  skipWireType,
  decodeFields,
  getString,
  getStrings,
  getVarint,
  getSubmessages,
  getSubmessage,
  getMapStringString,
  frameGrpcMessage,
  unframeGrpcMessages,
};

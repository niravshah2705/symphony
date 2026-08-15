const SAFE_ABSOLUTE_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const ESCAPABLE_INLINE_CHARACTERS = new Set(['\\', '`', '*', '_', '[', ']', '(', ')']);

function pushText(tokens, value) {
  if (!value) return;
  const previous = tokens[tokens.length - 1];
  if (previous?.type === 'text') previous.value += value;
  else tokens.push({ type: 'text', value });
}

/**
 * Return a browser-safe Markdown link destination, or an empty string when the
 * destination could execute script or escape the supported URL forms.
 */
export function normalizeLegalLink(value) {
  if (typeof value !== 'string') return '';
  const href = value.trim();
  if (!href || CONTROL_CHARACTERS.test(href)) return '';

  // Fragment, hash-route, and root-relative links stay on this deployment.
  if (href.startsWith('#')) return href;
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  if (href.startsWith('./') || href.startsWith('../')) return href;

  try {
    const parsed = new URL(href);
    return SAFE_ABSOLUTE_PROTOCOLS.has(parsed.protocol.toLowerCase()) ? href : '';
  } catch {
    return '';
  }
}

function closingParenthesis(source, openingIndex) {
  let depth = 1;
  for (let index = openingIndex + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === '(') depth += 1;
    if (source[index] !== ')') continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function inlineTokens(value, { allowLinks = true } = {}) {
  const source = String(value ?? '');
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    if (
      character === '\\'
      && index + 1 < source.length
      && ESCAPABLE_INLINE_CHARACTERS.has(source[index + 1])
    ) {
      pushText(tokens, source[index + 1]);
      index += 2;
      continue;
    }

    if (character === '`') {
      const closing = source.indexOf('`', index + 1);
      if (closing > index + 1) {
        tokens.push({ type: 'code', value: source.slice(index + 1, closing) });
        index = closing + 1;
        continue;
      }
    }

    if (source.startsWith('**', index) || source.startsWith('__', index)) {
      const marker = source.slice(index, index + 2);
      const closing = source.indexOf(marker, index + 2);
      if (closing > index + 2) {
        tokens.push({
          type: 'strong',
          children: inlineTokens(source.slice(index + 2, closing), { allowLinks }),
        });
        index = closing + 2;
        continue;
      }
    }

    if (character === '*' || character === '_') {
      const closing = source.indexOf(character, index + 1);
      if (closing > index + 1) {
        tokens.push({
          type: 'emphasis',
          children: inlineTokens(source.slice(index + 1, closing), { allowLinks }),
        });
        index = closing + 1;
        continue;
      }
    }

    if (allowLinks && character === '[') {
      const labelEnd = source.indexOf('](', index + 1);
      if (labelEnd > index + 1) {
        const destinationEnd = closingParenthesis(source, labelEnd + 1);
        if (destinationEnd > labelEnd + 2) {
          const label = source.slice(index + 1, labelEnd);
          const destination = source.slice(labelEnd + 2, destinationEnd);
          tokens.push({
            type: 'link',
            href: normalizeLegalLink(destination),
            children: inlineTokens(label, { allowLinks: false }),
          });
          index = destinationEnd + 1;
          continue;
        }
      }
    }

    pushText(tokens, character);
    index += 1;
  }

  return tokens;
}

export function parseLegalInline(value) {
  return inlineTokens(value);
}

function listLine(line) {
  const ordered = line.match(/^ {0,3}(\d{1,9})[.)][\t ]+(.+)$/u);
  if (ordered) {
    return {
      ordered: true,
      start: Number.parseInt(ordered[1], 10),
      content: ordered[2].trim(),
    };
  }

  const unordered = line.match(/^ {0,3}[-+*][\t ]+(.+)$/u);
  return unordered
    ? { ordered: false, start: 1, content: unordered[1].trim() }
    : null;
}

function isThematicBreak(line) {
  const trimmed = line.trim();
  return /^-{3,}$/u.test(trimmed) || /^\*{3,}$/u.test(trimmed) || /^_{3,}$/u.test(trimmed);
}

function startsBlock(line) {
  return /^ {0,3}#{1,6}(?:[\t ]+|$)/u.test(line)
    || /^ {0,3}>/u.test(line)
    || Boolean(listLine(line))
    || isThematicBreak(line);
}

/**
 * Parse the deliberately small legal-document Markdown dialect. Unsupported
 * syntax is preserved as text, which keeps HTML-like input inert.
 */
export function parseLegalMarkdown(value) {
  const lines = String(value ?? '').replace(/\r\n?/gu, '\n').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})(?:[\t ]+)(.*)$/u);
    if (heading) {
      const content = heading[2].replace(/[\t ]+#+[\t ]*$/u, '').trim();
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: inlineTokens(content),
      });
      index += 1;
      continue;
    }

    if (isThematicBreak(line)) {
      blocks.push({ type: 'thematicBreak' });
      index += 1;
      continue;
    }

    if (/^ {0,3}>/u.test(line)) {
      const quoteLines = [];
      while (index < lines.length) {
        const quote = lines[index].match(/^ {0,3}>[\t ]?(.*)$/u);
        if (!quote) break;
        quoteLines.push(quote[1]);
        index += 1;
      }
      blocks.push({
        type: 'blockquote',
        children: parseLegalMarkdown(quoteLines.join('\n')),
      });
      continue;
    }

    const firstItem = listLine(line);
    if (firstItem) {
      const items = [];
      let current = '';
      const ordered = firstItem.ordered;
      const start = firstItem.start;

      while (index < lines.length) {
        const candidate = listLine(lines[index]);
        if (candidate && candidate.ordered === ordered) {
          if (current) items.push(inlineTokens(current));
          current = candidate.content;
          index += 1;
          continue;
        }
        if (current && /^[\t ]+/u.test(lines[index]) && lines[index].trim()) {
          current += ` ${lines[index].trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      if (current) items.push(inlineTokens(current));
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({
      type: 'paragraph',
      children: inlineTokens(paragraph.join(' ')),
    });
  }

  return blocks;
}

function appendInline(documentRef, parent, tokens) {
  for (const token of tokens) {
    if (token.type === 'text') {
      parent.append(documentRef.createTextNode(token.value));
      continue;
    }
    if (token.type === 'code') {
      const code = documentRef.createElement('code');
      code.append(documentRef.createTextNode(token.value));
      parent.append(code);
      continue;
    }
    if (token.type === 'strong' || token.type === 'emphasis') {
      const element = documentRef.createElement(token.type === 'strong' ? 'strong' : 'em');
      appendInline(documentRef, element, token.children);
      parent.append(element);
      continue;
    }
    if (token.type === 'link') {
      if (!token.href) {
        appendInline(documentRef, parent, token.children);
        continue;
      }
      const anchor = documentRef.createElement('a');
      anchor.setAttribute('href', token.href);
      if (/^https?:\/\//iu.test(token.href)) {
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
      }
      appendInline(documentRef, anchor, token.children);
      parent.append(anchor);
    }
  }
}

function appendBlock(documentRef, parent, block) {
  if (block.type === 'heading' || block.type === 'paragraph') {
    const tag = block.type === 'heading' ? `h${block.level}` : 'p';
    const element = documentRef.createElement(tag);
    appendInline(documentRef, element, block.children);
    parent.append(element);
    return;
  }

  if (block.type === 'thematicBreak') {
    parent.append(documentRef.createElement('hr'));
    return;
  }

  if (block.type === 'blockquote') {
    const quote = documentRef.createElement('blockquote');
    for (const child of block.children) appendBlock(documentRef, quote, child);
    parent.append(quote);
    return;
  }

  if (block.type === 'list') {
    const list = documentRef.createElement(block.ordered ? 'ol' : 'ul');
    if (block.ordered && block.start !== 1) list.setAttribute('start', String(block.start));
    for (const item of block.items) {
      const listItem = documentRef.createElement('li');
      appendInline(documentRef, listItem, item);
      list.append(listItem);
    }
    parent.append(list);
  }
}

/** Render legal Markdown exclusively through DOM creation and text nodes. */
export function renderLegalMarkdown(value, { documentRef = globalThis.document } = {}) {
  if (
    !documentRef
    || typeof documentRef.createElement !== 'function'
    || typeof documentRef.createTextNode !== 'function'
    || typeof documentRef.createDocumentFragment !== 'function'
  ) {
    throw new TypeError('A DOM-compatible document is required to render legal Markdown.');
  }

  const fragment = documentRef.createDocumentFragment();
  for (const block of parseLegalMarkdown(value)) appendBlock(documentRef, fragment, block);
  return fragment;
}

export const parseMarkdown = parseLegalMarkdown;
export const renderMarkdown = renderLegalMarkdown;

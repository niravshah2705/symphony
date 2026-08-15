import { clear, el } from '../dom.js';
import { renderLegalMarkdown } from '../legal-markdown.mjs';

const LEGAL_DOCUMENTS = Object.freeze({
  privacy: Object.freeze({
    label: 'Privacy Notice',
    url: '/legal/privacy.md',
  }),
  terms: Object.freeze({
    label: 'Terms of Use',
    url: '/legal/terms.md',
  }),
});

async function renderLegalDocument(view, descriptor) {
  const documentHost = el('article', {
    class: 'legal-document',
    lang: 'en',
    dir: 'ltr',
    dataset: { i18nSkip: 'true' },
    'aria-label': descriptor.label,
    'aria-busy': 'true',
  }, [
    el('p', { class: 'loading', role: 'status' }, `Loading ${descriptor.label}…`),
  ]);
  clear(view).append(documentHost);

  try {
    const response = await fetch(descriptor.url, {
      cache: 'no-cache',
      headers: { Accept: 'text/markdown' },
    });
    if (!response.ok) throw new Error(`Request failed with status ${response.status}.`);

    const markdown = await response.text();
    documentHost.replaceChildren(renderLegalMarkdown(markdown));
    documentHost.removeAttribute('aria-busy');
  } catch (error) {
    const retry = el('button', { class: 'btn', type: 'button' }, 'Try again');
    retry.addEventListener('click', () => {
      void renderLegalDocument(view, descriptor);
    });
    documentHost.replaceChildren(
      el('h1', {}, descriptor.label),
      el('div', { class: 'error-banner', role: 'alert' }, [
        el('strong', {}, `${descriptor.label} could not be loaded.`),
        el('p', {}, error?.message || 'Try again in a moment.'),
      ]),
      retry,
    );
    documentHost.removeAttribute('aria-busy');
  }
}

export function renderPrivacy(view) {
  return renderLegalDocument(view, LEGAL_DOCUMENTS.privacy);
}

export function renderTerms(view) {
  return renderLegalDocument(view, LEGAL_DOCUMENTS.terms);
}

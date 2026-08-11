import { api } from '../api.js';
import { el, clear } from '../dom.js';
import { t } from '../i18n.js';

export function invitationTokenFromHash(hash = window.location.hash) {
  const match = String(hash || '').match(/^#\/invite(?:\?([^#]*))?$/);
  if (!match) return '';
  try {
    return new URLSearchParams(match[1] || '').get('token')?.trim() || '';
  } catch (_) {
    return '';
  }
}

export async function renderInvitation(view) {
  const token = invitationTokenFromHash();
  clear(view);
  const status = el('p', { class: 'auth-copy', role: 'status' },
    token ? t('invitationBody') : t('invalidInvitation'));
  const accept = el('button', {
    class: 'primary auth-continue',
    type: 'button',
    disabled: !token,
  }, t('acceptInvitation'));

  accept.addEventListener('click', async () => {
    if (!token) return;
    accept.disabled = true;
    accept.textContent = t('acceptingInvitation');
    status.textContent = t('acceptingInvitation');
    try {
      await api.org.acceptInvitation(token);
      // Remove the sensitive fragment from browser history before the post-accept
      // reload refreshes accessible context. The token never enters location.search.
      window.history.replaceState(null, '', '#/organization');
      status.textContent = t('invitationAccepted');
      window.setTimeout(() => window.location.reload(), 250);
    } catch (error) {
      status.textContent = error?.message || t('invalidInvitation');
      accept.textContent = t('acceptInvitation');
      accept.disabled = false;
    }
  });

  view.append(el('section', { class: 'auth-card invitation-card', 'aria-labelledby': 'invitation-title' }, [
    el('span', { class: 'auth-badge' }, t('invitation')),
    el('h1', { id: 'invitation-title' }, t('invitationTitle')),
    status,
    el('div', { class: 'auth-actions' }, [accept]),
  ]));
}

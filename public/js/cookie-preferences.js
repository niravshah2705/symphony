import { getAnalyticsConsent, setAnalyticsConsent } from './google-analytics.mjs';

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableControls(dialog) {
  return Array.from(dialog.querySelectorAll(FOCUSABLE)).filter((node) => !node.hidden);
}

export function initCookiePreferences({
  trigger = document.getElementById('cookie-preferences-trigger'),
  dialog = document.getElementById('cookie-preferences-dialog'),
} = {}) {
  if (!trigger || !dialog) return null;

  const form = dialog.querySelector('form');
  const analytics = dialog.querySelector('#cookie-analytics');
  const cancel = dialog.querySelector('[data-cookie-cancel]');
  const save = dialog.querySelector('[data-cookie-save]');
  const error = dialog.querySelector('#cookie-preferences-error');
  if (!form || !analytics || !cancel || !save || !error) return null;

  let opener = null;
  let initialChoice = 'enabled';

  const clearError = () => {
    error.hidden = true;
    error.textContent = '';
  };
  const restoreFocus = () => {
    const target = opener;
    opener = null;
    if (target?.isConnected) target.focus();
  };
  const close = (value = 'cancel') => {
    if (dialog.open && typeof dialog.close === 'function') dialog.close(value);
    else {
      dialog.removeAttribute('open');
      restoreFocus();
    }
  };

  trigger.addEventListener('click', () => {
    opener = trigger;
    initialChoice = getAnalyticsConsent();
    analytics.checked = initialChoice === 'enabled';
    clearError();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    window.requestAnimationFrame(() => analytics.focus());
  });

  cancel.addEventListener('click', () => close('cancel'));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close('cancel');
  });
  dialog.addEventListener('close', restoreFocus);

  // Native modal dialogs contain focus in current browsers. Keep an explicit
  // cycle as well so keyboard containment remains deterministic in browsers
  // with partial <dialog> implementations.
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = focusableControls(dialog);
    if (!controls.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearError();
    const nextChoice = analytics.checked ? 'enabled' : 'disabled';
    save.disabled = true;
    try {
      setAnalyticsConsent(nextChoice);
    } catch {
      error.textContent = 'We could not save your choice. Check browser storage settings and try again.';
      error.hidden = false;
      save.disabled = false;
      save.focus();
      return;
    }

    save.disabled = false;
    if (nextChoice === initialChoice) {
      close('saved');
      return;
    }

    // setAnalyticsConsent has already stopped future events and revoked loaded
    // GA consent. Reloading preserves the hash and ensures the next startup
    // either creates no GA state at all or resumes tracking after re-enabling.
    close('saved');
    window.setTimeout(() => window.location.reload(), 0);
  });

  return Object.freeze({ open: () => trigger.click(), dialog });
}

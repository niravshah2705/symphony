import { api } from '../api.js';
import { clear, el, errorBanner, loading, toast } from '../dom.js';
import { icon } from '../icons.js';

const CHECKS = [
  { id: 'pan', label: 'PAN card', hint: 'Verified PAN facts with last four digits only.' },
  { id: 'ageProof', label: 'Age proof', hint: 'Date of birth and current age from an approved issued document.' },
  { id: 'degree', label: 'College degree', hint: 'Degree credentials through DigiLocker/NAD when available.' },
  { id: 'apaar', label: 'APAAR / ABC', hint: 'Academic identity linkage used as supporting evidence.' },
];

function statusTone(status) {
  if (status === 'verified') return 'ok';
  if (status === 'failed' || status === 'revoked') return 'err';
  return 'warn';
}

function factRows(result) {
  if (!result) return [el('p', { class: 'muted' }, 'No verified facts yet.')];
  const rows = [];
  if (result.pan) {
    rows.push(['PAN', result.pan.status === 'verified' ? `Verified ending ${result.pan.panLast4}` : result.pan.status]);
  }
  if (result.ageProof) {
    rows.push(['Age proof', result.ageProof.status === 'verified' ? `${result.ageProof.ageYears} years, DOB ${result.ageProof.dateOfBirth}` : result.ageProof.status]);
  }
  if (result.academic) {
    rows.push(['Degree', result.academic.degreeVerified ? `${result.academic.awardName || 'Degree'} · ${result.academic.institutionName || 'Institution verified'}` : result.academic.status]);
    rows.push(['APAAR / ABC', result.academic.apaarIdPresent ? `APAAR present${result.academic.abcLinked ? ', ABC linked' : ''}` : 'Not present']);
  }
  return rows.map(([label, value]) => el('div', { class: 'metric-card' }, [
    el('span', { class: 'metric-label' }, label),
    el('strong', { class: 'metric-value', dataset: { userContent: 'true' } }, value || 'Unavailable'),
  ]));
}

function sessionPanel(state, rerender) {
  if (!state.session) {
    return el('section', { class: 'operational-panel' }, [
      el('div', { class: 'panel-heading' }, [
        el('h2', {}, 'Verification session'),
        el('span', { class: 'status-pill warn' }, 'Not started'),
      ]),
      el('p', { class: 'muted' }, 'Start consent to fetch issued documents. The service stores normalized facts only and enforces unique PAN/APAAR claims.'),
    ]);
  }

  const session = state.session;
  const complete = el('button', { class: 'btn', type: 'button' }, 'Complete demo verification');
  const refresh = el('button', { class: 'btn', type: 'button' }, 'Refresh');
  const revoke = el('button', { class: 'btn danger', type: 'button' }, 'Revoke');

  complete.addEventListener('click', async () => {
    complete.disabled = true;
    try {
      const out = await api.identity.completeMock(session.sessionId);
      state.session = out.session;
      state.result = out.result;
      toast('Verification completed.', 'ok');
      rerender();
    } catch (err) {
      toast(err.message || 'Verification failed.', 'err');
    } finally {
      complete.disabled = false;
    }
  });

  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    try {
      const out = await api.identity.getResult(session.sessionId);
      state.session = out.session;
      state.result = out.result;
      rerender();
    } catch (err) {
      toast(err.message || 'Could not refresh verification.', 'err');
    } finally {
      refresh.disabled = false;
    }
  });

  revoke.addEventListener('click', async () => {
    revoke.disabled = true;
    try {
      const out = await api.identity.revoke(session.sessionId);
      state.session = out.session;
      toast('Verification session revoked.', 'ok');
      rerender();
    } catch (err) {
      toast(err.message || 'Could not revoke session.', 'err');
    } finally {
      revoke.disabled = false;
    }
  });

  return el('section', { class: 'operational-panel' }, [
    el('div', { class: 'panel-heading' }, [
      el('h2', {}, 'Verification session'),
      el('span', { class: `status-pill ${statusTone(session.status)}` }, session.status),
    ]),
    el('div', { class: 'metric-grid' }, factRows(state.result)),
    el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, [
      session.authorizeUrl ? el('a', { class: 'btn primary', href: session.authorizeUrl, target: '_blank', rel: 'noreferrer' }, ['Open consent', icon('external', { size: 16 })]) : null,
      session.status !== 'verified' && session.status !== 'revoked' ? complete : null,
      refresh,
      session.status !== 'revoked' ? revoke : null,
    ]),
  ]);
}

export async function renderIdentity(view) {
  const state = { session: null, result: null };
  const selected = new Set(['pan', 'ageProof', 'degree', 'apaar']);
  const render = () => {
    const checks = CHECKS.map((check) => {
      const input = el('input', { type: 'checkbox', value: check.id, checked: selected.has(check.id), style: 'width:auto' });
      input.addEventListener('change', () => {
        if (input.checked) selected.add(check.id);
        else selected.delete(check.id);
      });
      return el('label', { class: 'metric-card', style: 'cursor:pointer' }, [
        el('div', { class: 'row', style: 'gap:8px' }, [input, el('strong', {}, check.label)]),
        el('p', { class: 'muted' }, check.hint),
      ]);
    });

    const start = el('button', { class: 'btn primary', type: 'button' }, 'Start DigiLocker consent');
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        const out = await api.identity.createSession([...selected]);
        state.session = { ...out.session, authorizeUrl: out.authorizeUrl };
        state.result = null;
        toast('Consent session created.', 'ok');
        render();
      } catch (err) {
        toast(err.message || 'Could not start verification.', 'err');
      } finally {
        start.disabled = false;
      }
    });

    clear(view).append(
      el('div', { class: 'operational-root' }, [
        el('section', { class: 'operational-head' }, [
          el('div', {}, [
            el('h1', {}, 'Identity verification'),
            el('p', {}, 'Consent-based checks for PAN, age proof, college degree, and APAAR / ABC linkage. PAN and APAAR identifiers are uniquely claimed across users using hashed records.'),
          ]),
        ]),
        el('section', { class: 'operational-panel' }, [
          el('div', { class: 'panel-heading' }, [
            el('h2', {}, 'Checks'),
            el('span', { class: 'status-pill ok' }, 'Facts only'),
          ]),
          el('div', { class: 'metric-grid' }, checks),
          start,
        ]),
        sessionPanel(state, render),
      ]),
    );
  };

  clear(view).append(loading('Loading identity verification...'));
  try {
    await api.identity.getSession('__missing__').catch(() => null);
  } catch (err) {
    clear(view).append(errorBanner(err.message || 'Identity verification is unavailable.'));
    return;
  }
  render();
}

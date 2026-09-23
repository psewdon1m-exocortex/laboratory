import { bindDialogInteraction, bindActionGeometry } from './ui-interactions.js';

export function openRestoreOverlay({ request, onComplete }) {
  const previous = document.activeElement;
  const el = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
  const dialog = el('dialog', undefined, 'exo-update exo-initialize laboratory');
  const title = el('h2', 'Restore snapshot'); title.id = 'restore-' + crypto.randomUUID(); dialog.setAttribute('aria-labelledby', title.id);
  const header = el('header'), close = el('button', '×', 'close'); close.type = 'button'; close.setAttribute('aria-label', 'Close restore');
  header.append(title, close);
  const body = el('div', undefined, 'exo-update-content');
  const description = el('p', 'Choose a local ZIP. Its contents and integrity are checked before you can confirm replacement.');
  const file = el('input'); file.type = 'file'; file.accept = '.zip,application/zip'; file.hidden = true; file.setAttribute('aria-label', 'Local snapshot archive');
  const browse = el('button', 'Browse local snapshot archive'); browse.type = 'button'; browse.onclick = () => { file.value = ''; file.click(); };
  const state = el('p', 'Choose archive'); state.setAttribute('role', 'status');
  const metadata = el('dl', undefined, 'meta'); metadata.hidden = true;
  const progress = el('progress'); progress.max = 1; progress.hidden = true; progress.setAttribute('aria-label', 'Restore progress');
  const error = el('p', '', 'error'); error.setAttribute('role', 'alert');
  const consent = el('label', undefined, 'saved'), checkbox = el('input'); checkbox.type = 'checkbox';
  consent.append(checkbox, el('span', 'Replace current content and settings with this snapshot and end active sessions.')); consent.hidden = true;
  const actions = el('div', undefined, 'actions'), cancel = el('button', 'Cancel'), restore = el('button', 'Restore this snapshot', 'danger');
  cancel.type = restore.type = 'button'; restore.disabled = true;
  actions.append(cancel, restore); body.append(description, file, browse, state, metadata, progress, error, consent, actions); dialog.append(header, body);
  let selected, inspection, busy = false, closed = false, completed = false;
  const dismiss = () => { if (!busy) dialog.close(); };
  close.onclick = cancel.onclick = dismiss;
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  function pending(value, message) {
    busy = value; state.textContent = message; progress.hidden = !value;
    close.disabled = cancel.disabled = browse.disabled = checkbox.disabled = value;
    restore.disabled = value || !inspection || !checkbox.checked;
    dialog.setAttribute('aria-busy', String(value));
  }
  checkbox.onchange = () => { restore.disabled = busy || !inspection || !checkbox.checked; };
  file.onchange = async () => {
    if (!file.files?.[0] || busy) return;
    selected = file.files[0]; inspection = undefined; checkbox.checked = false; error.textContent = ''; metadata.hidden = consent.hidden = true;
    pending(true, 'Checking archive integrity and compatibility…');
    try {
      const data = new FormData(); data.append('file', selected);
      const result = await request('/api/admin/restore/inspect', { method: 'POST', body: data });
      if (closed) return;
      inspection = result;
      metadata.replaceChildren();
      for (const [label, value] of [['Archive', selected.name], ['Size', result.sizeBytes + ' bytes'], ['Created', result.createdAt || 'Not recorded'], ['Version', result.version || 'Not recorded'], ['Schema', result.schema], ['SHA-256', result.sha256]]) metadata.append(el('dt', label), el('dd', String(value)));
      metadata.hidden = consent.hidden = false;
      pending(false, 'Archive verified. Review its details and confirm replacement.');
    } catch (failure) { if (!closed) { error.textContent = failure.message; pending(false, 'Archive could not be verified. Choose another ZIP to retry.'); } }
  };
  restore.onclick = async () => {
    if (busy || !inspection || !selected || !checkbox.checked) return;
    pending(true, 'Restoring verified snapshot… Keep this window open until the server reports the result.'); error.textContent = '';
    try {
      const data = new FormData(); data.append('file', selected);
      await request('/api/admin/restore', { method: 'POST', body: data, headers: { 'X-Backup-SHA256': inspection.sha256 } });
      if (closed) return;
      completed = true;
      pending(false, 'Restore completed. Sign in again to continue.');
      progress.hidden = false; progress.value = 1; consent.hidden = true; restore.hidden = true; browse.hidden = true;
      cancel.textContent = 'Sign in again';
    } catch (failure) { if (!closed) { error.textContent = failure.message; pending(false, 'Restore was not confirmed. Review the error before retrying.'); } }
  };
  document.body.append(dialog); dialog.showModal(); bindDialogInteraction(dialog); const stopGeometry = bindActionGeometry(dialog); browse.focus();
  dialog.addEventListener('close', () => { closed = true; selected = inspection = undefined; file.value = ''; stopGeometry(); dialog.remove(); if (completed) onComplete(); else if (previous?.isConnected) previous.focus(); }, { once: true });
}

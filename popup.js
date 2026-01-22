async function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

function el(id) {
  return document.getElementById(id);
}

function setStatus(text) {
  el('status').textContent = text || '';
}

async function loadSetsInto(selectEl, sets, placeholder) {
  selectEl.innerHTML = '';
  if (placeholder) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    selectEl.appendChild(opt);
  }
  for (const s of sets) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    selectEl.appendChild(opt);
  }
}

async function refresh() {
  setStatus('');
  const [{ stateRes }, { setsRes }] = await Promise.all([
    sendMessage({ type: 'getState' }).then((r) => ({ stateRes: r })),
    sendMessage({ type: 'listSets' }).then((r) => ({ setsRes: r }))
  ]);

  if (!stateRes?.ok) {
    setStatus(stateRes?.error || 'Failed to load state');
    return;
  }
  if (!setsRes?.ok) {
    setStatus(setsRes?.error || 'Failed to load sets');
    return;
  }

  const state = stateRes.state;
  const sets = setsRes.sets;

  el('enabled').checked = !!state.enabled;
  el('locked').checked = !!state.locked;
  el('pinnedCount').value = String(state.pinnedCount ?? 0);

  await loadSetsInto(el('defaultSet'), sets, '(none)');
  await loadSetsInto(el('ruleSet'), sets, '(pick a set)');

  el('defaultSet').value = state.defaultSetId || '';
}

async function patchState(patch) {
  const res = await sendMessage({ type: 'setState', patch });
  if (!res?.ok) throw new Error(res?.error || 'Failed to save');
}

document.addEventListener('DOMContentLoaded', async () => {
  await refresh();

  el('enabled').addEventListener('change', async () => {
    try {
      await patchState({ enabled: el('enabled').checked });
      setStatus('Saved.');
    } catch (e) {
      setStatus(e.message);
    }
  });

  el('locked').addEventListener('change', async () => {
    try {
      await patchState({ locked: el('locked').checked });
      setStatus('Saved.');
    } catch (e) {
      setStatus(e.message);
    }
  });

  el('pinnedCount').addEventListener('change', async () => {
    try {
      const n = Math.max(0, Number(el('pinnedCount').value || 0));
      await patchState({ pinnedCount: n });
      setStatus('Saved.');
    } catch (e) {
      setStatus(e.message);
    }
  });

  el('defaultSet').addEventListener('change', async () => {
    try {
      const v = el('defaultSet').value || null;
      await patchState({ defaultSetId: v });
      setStatus('Saved.');
    } catch (e) {
      setStatus(e.message);
    }
  });

  el('rerender').addEventListener('click', async () => {
    setStatus('Applying…');
    const res = await sendMessage({ type: 'rerenderNow' });
    setStatus(res?.ok ? 'Applied.' : res?.error || 'Failed.');
  });

  el('restore').addEventListener('click', async () => {
    setStatus('Restoring…');
    const res = await sendMessage({ type: 'restoreLastBackup' });
    setStatus(res?.ok ? 'Restored.' : res?.error || 'Failed.');
  });

  el('openBookmarks').addEventListener('click', async () => {
    chrome.tabs.create({ url: 'chrome://bookmarks/' });
  });

  el('addRule').addEventListener('click', async () => {
    try {
      const host = (el('ruleHost').value || '').trim().toLowerCase();
      const setId = el('ruleSet').value;
      if (!host) throw new Error('Enter a host like github.com');
      if (!setId) throw new Error('Pick a set');

      const stateRes = await sendMessage({ type: 'getState' });
      if (!stateRes?.ok) throw new Error(stateRes?.error || 'Failed to read state');
      const rules = Array.isArray(stateRes.state.rules) ? stateRes.state.rules.slice() : [];

      const idx = rules.findIndex((r) => r.matchType === 'hostEquals' && (r.pattern || '').toLowerCase() === host);
      const rule = { matchType: 'hostEquals', pattern: host, setId };
      if (idx >= 0) rules[idx] = rule;
      else rules.unshift(rule);

      await patchState({ rules });
      setStatus('Rule saved.');
    } catch (e) {
      setStatus(e.message);
    }
  });
});

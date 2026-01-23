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

function setDiag(text) {
  const d = el('diag');
  if (d) d.textContent = text || '';
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
  setDiag('');
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

  // Sync warning
  const warn = el('syncWarning');
  if (warn) {
    warn.hidden = !!state.syncWarningAcknowledged;
    el('ackSync').checked = false;
  }

  el('mode').value = state.mode || 'automatic';
  el('switchTrigger').value = state.switchTrigger || 'activation';

  el('enabled').checked = !!state.enabled;
  el('locked').checked = !!state.locked;
  el('pinnedCount').value = String(state.pinnedCount ?? 0);
  const rl = el('renderLocation');
  if (rl) rl.value = state.renderLocation || 'markerFolder';

  await loadSetsInto(el('defaultSet'), sets, '(none)');
  await loadSetsInto(el('ruleSet'), sets, '(pick a set)');

  el('defaultSet').value = state.defaultSetId || '';

  if (state.pausedUntil && Date.now() < state.pausedUntil) {
    const ms = state.pausedUntil - Date.now();
    const mins = Math.ceil(ms / 60000);
    setDiag(`Paused for ~${mins} min.`);
  } else if (state.mode === 'local') {
    setDiag('Local UI mode: no bookmark writes.');
  } else if (state.mode === 'manual') {
    setDiag('Manual mode: switching only on button/hotkey.');
  }

  if (state.lastError) {
    setDiag(`Last error: ${state.lastError}`);
  }

  // Local preview panel
  const pv = el('localPreview');
  if (pv) {
    const show = state.mode === 'local';
    pv.hidden = !show;
    if (show) {
      const preview = await sendMessage({ type: 'getLocalPreview' });
      if (preview?.ok) {
        el('pvHost').textContent = preview.host || '(none)';
        el('pvSet').textContent = preview.setTitle || '(no match)';
        const ul = el('pvItems');
        ul.innerHTML = '';
        for (const it of preview.items || []) {
          const li = document.createElement('li');
          if (it.type === 'bookmark') li.textContent = `${it.title}`;
          else li.textContent = `${it.title} (folder${typeof it.childCount === 'number' ? `, ${it.childCount} items` : ''})`;
          ul.appendChild(li);
        }
      } else {
        el('pvHost').textContent = '';
        el('pvSet').textContent = '';
      }
    }
  }
}

async function patchState(patch) {
  const res = await sendMessage({ type: 'setState', patch });
  if (!res?.ok) throw new Error(res?.error || 'Failed to save');
}

document.addEventListener('DOMContentLoaded', async () => {
  await refresh();

  el('dismissSync').addEventListener('click', async () => {
    try {
      if (!el('ackSync').checked) {
        setStatus('Please tick “I understand” first.');
        return;
      }
      await patchState({ syncWarningAcknowledged: true });
      await refresh();
    } catch (e) {
      setStatus(e.message);
    }
  });

  el('mode').addEventListener('change', async () => {
    try {
      await patchState({ mode: el('mode').value });
      setStatus('Saved.');
      await refresh();
    } catch (e) {
      setStatus(e.message);
    }
  });

  el('switchTrigger').addEventListener('change', async () => {
    try {
      await patchState({ switchTrigger: el('switchTrigger').value });
      setStatus('Saved.');
    } catch (e) {
      setStatus(e.message);
    }
  });

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

  const rl = el('renderLocation');
  if (rl) {
    rl.addEventListener('change', async () => {
      try {
        await patchState({ renderLocation: rl.value || 'markerFolder' });
        setStatus('Saved.');
      } catch (e) {
        setStatus(e.message);
      }
    });
  }

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

  async function pauseMinutes(mins) {
    const until = Date.now() + mins * 60_000;
    await patchState({ pausedUntil: until });
    await refresh();
  }

  el('pause5').addEventListener('click', async () => {
    try {
      await pauseMinutes(5);
      setStatus('Paused.');
    } catch (e) {
      setStatus(e.message);
    }
  });
  el('pause15').addEventListener('click', async () => {
    try {
      await pauseMinutes(15);
      setStatus('Paused.');
    } catch (e) {
      setStatus(e.message);
    }
  });
  el('pause60').addEventListener('click', async () => {
    try {
      await pauseMinutes(60);
      setStatus('Paused.');
    } catch (e) {
      setStatus(e.message);
    }
  });

  el('resetManaged').addEventListener('click', async () => {
    setStatus('Resetting…');
    const res = await sendMessage({ type: 'resetManaged' });
    setStatus(res?.ok ? 'Reset.' : res?.error || 'Failed.');
  });

  el('openOptions').addEventListener('click', async () => {
    chrome.runtime.openOptionsPage();
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

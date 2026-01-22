async function sendBgMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function $(id) {
  return document.getElementById(id);
}

function setStatus(text) {
  $('status').textContent = text || '';
}

function mkOption(value, label) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  return opt;
}

function renderRules(rules, sets) {
  const root = $('rules');
  root.innerHTML = '';

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const row = document.createElement('div');
    row.className = 'rule';
    row.dataset.index = String(i);

    const mt = document.createElement('select');
    mt.className = 'matchType';
    mt.appendChild(mkOption('hostEquals', 'hostEquals'));
    mt.appendChild(mkOption('hostSuffix', 'hostSuffix'));
    mt.appendChild(mkOption('regex', 'regex'));
    mt.value = r.matchType || 'hostEquals';

    const pat = document.createElement('input');
    pat.className = 'pattern';
    pat.type = 'text';
    pat.placeholder = 'github.com / .google.com / ^(.*)$';
    pat.value = r.pattern || '';

    const setSel = document.createElement('select');
    setSel.className = 'setId';
    for (const s of sets) setSel.appendChild(mkOption(s.id, s.title));
    setSel.value = r.setId || (sets[0]?.id ?? '');

    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'danger';
    del.addEventListener('click', () => {
      rules.splice(i, 1);
      renderRules(rules, sets);
    });

    row.appendChild(mt);
    row.appendChild(pat);
    row.appendChild(setSel);
    row.appendChild(del);
    root.appendChild(row);
  }
}

function readRulesFromUI() {
  const rows = Array.from(document.querySelectorAll('.rule'));
  return rows.map((row) => {
    const matchType = row.querySelector('.matchType')?.value || 'hostEquals';
    const pattern = row.querySelector('.pattern')?.value || '';
    const setId = row.querySelector('.setId')?.value || '';
    return { matchType, pattern, setId };
  });
}

async function patchState(patch) {
  const res = await sendBgMessage({ type: 'setState', patch });
  if (!res?.ok) throw new Error(res?.error || 'Failed to save');
}

document.addEventListener('DOMContentLoaded', async () => {
  setStatus('Loading…');

  const stateRes = await sendBgMessage({ type: 'getState' });
  const setsRes = await sendBgMessage({ type: 'listSets' });
  if (!stateRes?.ok) return setStatus(stateRes?.error || 'Failed to load state');
  if (!setsRes?.ok) return setStatus(setsRes?.error || 'Failed to load sets');

  const state = stateRes.state;
  const sets = setsRes.sets;

  // Settings
  $('mode').value = state.mode || 'automatic';
  $('switchTrigger').value = state.switchTrigger || 'activation';
  $('pinnedCount').value = String(state.pinnedCount ?? 0);

  const defaultSet = $('defaultSet');
  defaultSet.innerHTML = '';
  defaultSet.appendChild(mkOption('', '(none)'));
  for (const s of sets) defaultSet.appendChild(mkOption(s.id, s.title));
  defaultSet.value = state.defaultSetId || '';

  // Diagnostics
  $('lastAppliedHost').textContent = state.lastAppliedHost || '(none)';
  $('lastError').textContent = state.lastError || '(none)';

  // Rules
  const rules = Array.isArray(state.rules) ? state.rules.slice() : [];
  renderRules(rules, sets);

  $('addRule').addEventListener('click', () => {
    rules.push({ matchType: 'hostEquals', pattern: '', setId: sets[0]?.id ?? '' });
    renderRules(rules, sets);
  });

  $('saveRules').addEventListener('click', async () => {
    try {
      const nextRules = readRulesFromUI();
      await patchState({ rules: nextRules });
      setStatus('Rules saved.');
    } catch (e) {
      setStatus(e.message);
    }
  });

  // Settings change handlers
  $('mode').addEventListener('change', async () => {
    try {
      await patchState({ mode: $('mode').value });
      setStatus('Saved.');
    } catch (e) {
      setStatus(e.message);
    }
  });

  $('switchTrigger').addEventListener('change', async () => {
    try {
      await patchState({ switchTrigger: $('switchTrigger').value });
      setStatus('Saved.');
    } catch (e) {
      setStatus(e.message);
    }
  });

  $('pinnedCount').addEventListener('change', async () => {
    try {
      const n = Math.max(0, Number($('pinnedCount').value || 0));
      await patchState({ pinnedCount: n });
      setStatus('Saved.');
    } catch (e) {
      setStatus(e.message);
    }
  });

  defaultSet.addEventListener('change', async () => {
    try {
      await patchState({ defaultSetId: defaultSet.value || null });
      setStatus('Saved.');
    } catch (e) {
      setStatus(e.message);
    }
  });

  // Preview
  $('previewBtn').addEventListener('click', async () => {
    try {
      const host = ($('previewHost').value || '').trim().toLowerCase();
      if (!host) throw new Error('Enter a host like github.com');

      const res = await sendBgMessage({ type: 'previewForHost', host });
      if (!res?.ok) throw new Error(res?.error || 'Preview failed');

      $('previewSet').textContent = res.setTitle || '(no match)';
      const ul = $('previewItems');
      ul.innerHTML = '';
      for (const it of res.items || []) {
        const li = document.createElement('li');
        if (it.type === 'bookmark') li.textContent = `${it.title}`;
        else li.textContent = `${it.title} (folder${typeof it.childCount === 'number' ? `, ${it.childCount} items` : ''})`;
        ul.appendChild(li);
      }
      setStatus('Preview loaded.');
    } catch (e) {
      setStatus(e.message);
    }
  });

  setStatus('');
});
async function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function el(id) {
  return document.getElementById(id);
}

function setSaveStatus(t) {
  el('saveStatus').textContent = t || '';
}

function ruleRowTemplate(rule, sets) {
  const row = document.createElement('div');
  row.className = 'ruleRow';

  const type = document.createElement('select');
  type.innerHTML = `
    <option value="hostEquals">host equals</option>
    <option value="hostSuffix">host suffix</option>
    <option value="regex">regex</option>
  `;
  type.value = rule.matchType || 'hostEquals';

  const pattern = document.createElement('input');
  pattern.type = 'text';
  pattern.placeholder = 'github.com or .google.com';
  pattern.value = rule.pattern || '';

  const setSel = document.createElement('select');
  for (const s of sets) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    setSel.appendChild(opt);
  }
  setSel.value = rule.setId || (sets[0] ? sets[0].id : '');

  const del = document.createElement('button');
  del.textContent = 'Delete';
  del.addEventListener('click', () => {
    row.remove();
  });

  row.appendChild(type);
  row.appendChild(pattern);
  row.appendChild(setSel);
  row.appendChild(del);

  row.__getRule = () => ({
    matchType: type.value,
    pattern: pattern.value.trim(),
    setId: setSel.value
  });

  return row;
}

async function load() {
  const stateRes = await sendMessage({ type: 'getState' });
  const setsRes = await sendMessage({ type: 'listSets' });
  if (!stateRes?.ok) throw new Error(stateRes?.error || 'Failed to load state');
  if (!setsRes?.ok) throw new Error(setsRes?.error || 'Failed to load sets');

  const state = stateRes.state;
  const sets = setsRes.sets;

  el('mode').value = state.mode || 'automatic';
  el('switchPolicy').value = state.switchPolicy || 'both';
  el('nonWeb').value = state.nonWebBehavior || 'ignore';

  // sync warning
  const dismissed = !!state.syncWarningDismissed;
  el('syncWarn').style.display = dismissed ? 'none' : 'block';

  const rulesWrap = el('rules');
  rulesWrap.innerHTML = '';
  const rules = Array.isArray(state.rules) ? state.rules : [];
  for (const r of rules) {
    rulesWrap.appendChild(ruleRowTemplate(r, sets));
  }

  el('addRule').onclick = () => {
    rulesWrap.appendChild(ruleRowTemplate({ matchType: 'hostEquals', pattern: '', setId: sets[0]?.id }, sets));
  };

  el('saveRules').onclick = async () => {
    try {
      setSaveStatus('Saving…');
      const rows = Array.from(rulesWrap.querySelectorAll('.ruleRow'));
      const nextRules = rows
        .map((r) => r.__getRule())
        .filter((r) => r.pattern && r.setId);

      const patch = {
        mode: el('mode').value,
        switchPolicy: el('switchPolicy').value,
        nonWebBehavior: el('nonWeb').value,
        rules: nextRules
      };
      const res = await sendMessage({ type: 'setState', patch });
      if (!res?.ok) throw new Error(res?.error || 'Save failed');
      setSaveStatus('Saved.');
    } catch (e) {
      setSaveStatus(e.message);
    }
  };

  el('dismissSync').onclick = async () => {
    await sendMessage({ type: 'dismissSyncWarning' });
    el('syncWarn').style.display = 'none';
  };

  async function runPreview(host, useActive) {
    const res = await sendMessage({ type: 'preview', host, useActive: !!useActive });
    if (!res?.ok) {
      el('previewOut').textContent = res?.error || 'Preview failed.';
      return;
    }
    el('previewOut').textContent = JSON.stringify(res.preview, null, 2);
  }

  el('preview').onclick = async () => {
    const host = (el('previewHost').value || '').trim();
    await runPreview(host, false);
  };

  el('previewActive').onclick = async () => {
    await runPreview('', true);
  };
}

document.addEventListener('DOMContentLoaded', () => {
  load().catch((e) => {
    setSaveStatus(e.message);
  });
});

/*
  barpilot - Context-Switched Bookmarks Bar

  Safety principles:
  - Canonical sets live under: Other Bookmarks / ContextBar / Sets
  - We only delete/move items we created in the managed region, tracked by ID.
  - Before applying, we create BOTH:
    - a real bookmarks backup folder
    - a JSON snapshot of the bar structure
*/

// -----------------------------
// Defaults / constants
// -----------------------------

const STORAGE_KEYS = {
  enabled: 'enabled',
  locked: 'locked',
  pinnedCount: 'pinnedCount',
  rules: 'rules',
  defaultSetId: 'defaultSetId',
  lastAppliedHost: 'lastAppliedHost',
  lastApplyAt: 'lastApplyAt',
  inProgress: 'inProgress',
  pendingHost: 'pendingHost',
  managed: 'managed',
  snapshots: 'snapshots',
  lastBackupFolderId: 'lastBackupFolderId',
  candidateHost: 'candidateHost',
  candidateSince: 'candidateSince'
};

const DEFAULTS = {
  enabled: true,
  locked: false,
  pinnedCount: 3,
  rules: [],
  defaultSetId: null,
  lastAppliedHost: null,
  lastApplyAt: 0,
  inProgress: null,
  pendingHost: null,
  managed: { lastRenderedIds: [], lastStagingFolderId: null },
  snapshots: [],
  lastBackupFolderId: null,
  candidateHost: null,
  candidateSince: 0
};

const LIMITS = {
  snapshotsMax: 20
};

const TIMING = {
  debounceMs: 500,
  dwellMs: 800,
  minIntervalMs: 1500,
  inProgressStaleMs: 30_000
};

const ALARMS = {
  candidate: 'candidate-apply'
};

const CONTEXTBAR = {
  rootName: 'ContextBar',
  setsName: 'Sets',
  backupsName: 'Backups',
  trashName: 'Trash'
};

// -----------------------------
// Small promise wrappers
// -----------------------------

function storageGet(keysObj) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keysObj, resolve);
  });
}

function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, resolve);
  });
}

function bookmarksGetTree() {
  return new Promise((resolve) => chrome.bookmarks.getTree(resolve));
}

function bookmarksGet(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.get(id, (nodes) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(nodes);
    });
  });
}

function bookmarksGetChildren(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getChildren(id, (nodes) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(nodes);
    });
  });
}

function bookmarksCreate(createDetails) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.create(createDetails, (node) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(node);
    });
  });
}

function bookmarksMove(id, moveDetails) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.move(id, moveDetails, (node) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(node);
    });
  });
}

function bookmarksRemoveTree(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.removeTree(id, () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve();
    });
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, resolve));
}

function alarmsCreate(name, alarmInfo) {
  return new Promise((resolve) => {
    chrome.alarms.create(name, alarmInfo);
    resolve();
  });
}

function alarmsClear(name) {
  return new Promise((resolve) => chrome.alarms.clear(name, resolve));
}

// -----------------------------
// URL / matching
// -----------------------------

function isSupportedWebUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function hostFromUrl(url) {
  if (!isSupportedWebUrl(url)) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function ruleMatchesHost(rule, host) {
  if (!rule || !host) return false;
  const matchType = rule.matchType;
  const pattern = (rule.pattern || '').toLowerCase();

  if (matchType === 'hostEquals') {
    return host === pattern;
  }

  if (matchType === 'hostSuffix') {
    // Common pattern: ".google.com" should match "docs.google.com"
    if (!pattern) return false;
    return host === pattern.replace(/^\./, '') || host.endsWith(pattern);
  }

  if (matchType === 'regex') {
    try {
      return new RegExp(rule.pattern).test(host);
    } catch {
      return false;
    }
  }

  return false;
}

async function resolveSetIdForHost(host) {
  const { rules, defaultSetId } = await storageGet({
    [STORAGE_KEYS.rules]: DEFAULTS.rules,
    [STORAGE_KEYS.defaultSetId]: DEFAULTS.defaultSetId
  });

  // Deterministic priority
  const exact = (rules || []).filter((r) => r.matchType === 'hostEquals' && ruleMatchesHost(r, host));
  if (exact.length) return exact[0].setId;

  const suffix = (rules || []).filter((r) => r.matchType === 'hostSuffix' && ruleMatchesHost(r, host));
  if (suffix.length) return suffix[0].setId;

  const regex = (rules || []).filter((r) => r.matchType === 'regex' && ruleMatchesHost(r, host));
  if (regex.length) return regex[0].setId;

  return defaultSetId || null;
}

// -----------------------------
// Bookmark helpers
// -----------------------------

async function getBarAndOtherRootIds() {
  const tree = await bookmarksGetTree();
  const root = tree?.[0];
  const children = root?.children;
  if (!children || children.length < 2) throw new Error('Unexpected bookmarks root structure');

  // The first two are typically: Bookmarks bar, Other bookmarks.
  const bar = children[0];
  const other = children[1];
  if (!bar?.id || !other?.id) throw new Error('Could not discover bar/other root IDs');
  return { barRootId: bar.id, otherRootId: other.id };
}

async function findChildFolderByTitle(parentId, title) {
  const kids = await bookmarksGetChildren(parentId);
  return kids.find((n) => !n.url && n.title === title) || null;
}

async function findOrCreateFolderPath(pathParts, rootId) {
  let currentId = rootId;
  for (const part of pathParts) {
    const existing = await findChildFolderByTitle(currentId, part);
    if (existing) {
      currentId = existing.id;
      continue;
    }
    const created = await bookmarksCreate({ parentId: currentId, title: part });
    currentId = created.id;
  }
  return currentId;
}

async function getAncestorsInclusive(id) {
  const out = [];
  let currentId = id;
  for (let i = 0; i < 50; i++) {
    const nodes = await bookmarksGet(currentId);
    const node = nodes?.[0];
    if (!node) break;
    out.push(node);
    if (!node.parentId) break;
    currentId = node.parentId;
  }
  return out; // [node, parent, ...]
}

async function isDescendantOf(id, ancestorId) {
  const chain = await getAncestorsInclusive(id);
  return chain.some((n) => n.id === ancestorId);
}

async function ensureContextBarFolders(otherRootId) {
  const contextRootId = await findOrCreateFolderPath([CONTEXTBAR.rootName], otherRootId);
  const setsRootId = await findOrCreateFolderPath([CONTEXTBAR.rootName, CONTEXTBAR.setsName], otherRootId);
  const backupsRootId = await findOrCreateFolderPath([CONTEXTBAR.rootName, CONTEXTBAR.backupsName], otherRootId);
  const trashRootId = await findOrCreateFolderPath([CONTEXTBAR.rootName, CONTEXTBAR.trashName], otherRootId);
  return { contextRootId, setsRootId, backupsRootId, trashRootId };
}

async function readSubtreeAsDTO(rootId) {
  const nodes = await bookmarksGet(rootId);
  const root = nodes[0];
  const dto = { title: root.title };
  if (root.url) {
    dto.url = root.url;
    return dto;
  }
  const children = await bookmarksGetChildren(rootId);
  dto.children = [];
  for (const c of children) {
    dto.children.push(await readSubtreeAsDTO(c.id));
  }
  return dto;
}

async function copySubtree(srcId, dstParentId) {
  // returns created IDs (top-down)
  const nodes = await bookmarksGet(srcId);
  const src = nodes[0];
  if (!src) return [];

  if (src.url) {
    const node = await bookmarksCreate({ parentId: dstParentId, title: src.title, url: src.url });
    return [node.id];
  }

  const folder = await bookmarksCreate({ parentId: dstParentId, title: src.title });
  const created = [folder.id];
  const children = await bookmarksGetChildren(srcId);
  for (const c of children) {
    created.push(...(await copySubtree(c.id, folder.id)));
  }
  return created;
}

function isoStamp() {
  // safe-ish for titles
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// -----------------------------
// Snapshot / backup / restore
// -----------------------------

async function snapshotBar(host, barRootId, pinnedCount) {
  const barDto = await readSubtreeAsDTO(barRootId);
  const { snapshots } = await storageGet({ [STORAGE_KEYS.snapshots]: DEFAULTS.snapshots });
  const next = [{ ts: Date.now(), host, pinnedCount, barTree: barDto }, ...(snapshots || [])];
  await storageSet({ [STORAGE_KEYS.snapshots]: next.slice(0, LIMITS.snapshotsMax) });
}

async function backupBar(host, barRootId, backupsRootId) {
  const folderTitle = `${isoStamp()} - ${host || 'unknown'}`;
  const backupFolder = await bookmarksCreate({ parentId: backupsRootId, title: folderTitle });
  const barChildren = await bookmarksGetChildren(barRootId);
  for (const c of barChildren) {
    await copySubtree(c.id, backupFolder.id);
  }
  await storageSet({ [STORAGE_KEYS.lastBackupFolderId]: backupFolder.id });
  return backupFolder.id;
}

async function restoreFromBackup(barRootId, backupFolderId) {
  if (!backupFolderId) throw new Error('No last backup folder is available');
  const barChildren = await bookmarksGetChildren(barRootId);
  for (const c of barChildren) {
    await bookmarksRemoveTree(c.id);
  }
  const backupChildren = await bookmarksGetChildren(backupFolderId);
  for (const c of backupChildren) {
    await copySubtree(c.id, barRootId);
  }
}

// -----------------------------
// Apply engine
// -----------------------------

async function getActiveHost() {
  const tabs = await tabsQuery({ active: true, lastFocusedWindow: true });
  const tab = tabs?.[0];
  if (!tab) return null;
  return hostFromUrl(tab.url);
}

async function scheduleCandidateSwitch(host) {
  // store candidate and set alarm
  await storageSet({
    [STORAGE_KEYS.candidateHost]: host,
    [STORAGE_KEYS.candidateSince]: Date.now()
  });
  await alarmsClear(ALARMS.candidate);
  await alarmsCreate(ALARMS.candidate, { when: Date.now() + TIMING.debounceMs });
}

async function verifyTopLevel(setId, barRootId, pinnedCount) {
  const setKids = await bookmarksGetChildren(setId);
  const barKids = await bookmarksGetChildren(barRootId);
  const managed = barKids.slice(pinnedCount);
  if (managed.length !== setKids.length) return false;
  for (let i = 0; i < setKids.length; i++) {
    const a = setKids[i];
    const b = managed[i];
    if ((a.title || '') !== (b.title || '')) return false;
    if (!!a.url !== !!b.url) return false;
    if (a.url && b.url && a.url !== b.url) return false;
  }
  return true;
}

async function applyHost(host, reason = 'auto') {
  const state = await storageGet({
    [STORAGE_KEYS.enabled]: DEFAULTS.enabled,
    [STORAGE_KEYS.locked]: DEFAULTS.locked,
    [STORAGE_KEYS.pinnedCount]: DEFAULTS.pinnedCount,
    [STORAGE_KEYS.lastApplyAt]: DEFAULTS.lastApplyAt,
    [STORAGE_KEYS.inProgress]: DEFAULTS.inProgress,
    [STORAGE_KEYS.pendingHost]: DEFAULTS.pendingHost,
    [STORAGE_KEYS.managed]: DEFAULTS.managed
  });

  if (!state.enabled || state.locked) return;

  const now = Date.now();
  if (now - (state.lastApplyAt || 0) < TIMING.minIntervalMs && reason !== 'manual') {
    return;
  }

  // Mutex
  if (state.inProgress) {
    await storageSet({ [STORAGE_KEYS.pendingHost]: host });
    return;
  }

  const opId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await storageSet({ [STORAGE_KEYS.inProgress]: { opId, startedAt: now } });

  try {
    const setId = await resolveSetIdForHost(host);
    if (!setId) return;

    const { barRootId, otherRootId } = await getBarAndOtherRootIds();
    const { setsRootId, backupsRootId, trashRootId } = await ensureContextBarFolders(otherRootId);

    // Validate that setId is under ContextBar/Sets
    const ok = await isDescendantOf(setId, setsRootId);
    if (!ok) throw new Error('Refusing to apply: target set is not under ContextBar/Sets');

    const pinnedCount = Math.max(0, Number(state.pinnedCount || 0));

    // Snapshot + Backup
    await snapshotBar(host, barRootId, pinnedCount);
    await backupBar(host, barRootId, backupsRootId);

    // Create staging folder under the bar
    const stagingTitle = `__ContextBarStaging ${opId}`;
    const stagingFolder = await bookmarksCreate({ parentId: barRootId, title: stagingTitle });
    await storageSet({
      [STORAGE_KEYS.managed]: {
        ...(state.managed || DEFAULTS.managed),
        lastStagingFolderId: stagingFolder.id
      }
    });

    // Copy set into staging
    const setChildren = await bookmarksGetChildren(setId);
    for (const c of setChildren) {
      await copySubtree(c.id, stagingFolder.id);
    }

    // Compute current children and managed deletion candidates
    const barChildren = await bookmarksGetChildren(barRootId);
    const managedRegion = barChildren.slice(pinnedCount);
    const lastRenderedIds = state.managed?.lastRenderedIds || [];
    const eligible = managedRegion.filter((n) => lastRenderedIds.includes(n.id));

    // Move old managed items to Trash (safest)
    if (eligible.length) {
      const trashBucket = await bookmarksCreate({
        parentId: trashRootId,
        title: `${isoStamp()} - ${host || 'unknown'}`
      });
      for (const n of eligible) {
        await bookmarksMove(n.id, { parentId: trashBucket.id });
      }
    }

    // Move staging children into the bar at pinnedCount
    const stagingChildren = await bookmarksGetChildren(stagingFolder.id);
    const renderedTopLevelIds = [];
    let idx = pinnedCount;
    for (const n of stagingChildren) {
      const moved = await bookmarksMove(n.id, { parentId: barRootId, index: idx });
      renderedTopLevelIds.push(moved.id);
      idx++;
    }

    // Remove staging folder
    await bookmarksRemoveTree(stagingFolder.id);

    // Record state
    await storageSet({
      [STORAGE_KEYS.managed]: {
        lastRenderedIds: renderedTopLevelIds,
        lastStagingFolderId: null
      },
      [STORAGE_KEYS.lastAppliedHost]: host,
      [STORAGE_KEYS.lastApplyAt]: Date.now()
    });

    // Verify (shallow)
    const verified = await verifyTopLevel(setId, barRootId, pinnedCount);
    if (!verified) {
      const { lastBackupFolderId } = await storageGet({
        [STORAGE_KEYS.lastBackupFolderId]: DEFAULTS.lastBackupFolderId
      });
      await restoreFromBackup(barRootId, lastBackupFolderId);
      throw new Error('Verification failed; restored from last backup');
    }
  } finally {
    // Release mutex
    await storageSet({ [STORAGE_KEYS.inProgress]: null });
    const { pendingHost } = await storageGet({ [STORAGE_KEYS.pendingHost]: DEFAULTS.pendingHost });
    if (pendingHost && pendingHost !== host) {
      await storageSet({ [STORAGE_KEYS.pendingHost]: null });
      // apply the latest pending request
      await applyHost(pendingHost, 'queued');
    } else {
      await storageSet({ [STORAGE_KEYS.pendingHost]: null });
    }
  }
}

async function cleanupStaleState() {
  const { inProgress, managed } = await storageGet({
    [STORAGE_KEYS.inProgress]: DEFAULTS.inProgress,
    [STORAGE_KEYS.managed]: DEFAULTS.managed
  });

  if (inProgress && Date.now() - inProgress.startedAt > TIMING.inProgressStaleMs) {
    await storageSet({ [STORAGE_KEYS.inProgress]: null, [STORAGE_KEYS.pendingHost]: null });
  }

  const { barRootId } = await getBarAndOtherRootIds();
  if (managed?.lastStagingFolderId) {
    try {
      await bookmarksRemoveTree(managed.lastStagingFolderId);
    } catch {
      // ignore if it no longer exists
    }
    await storageSet({
      [STORAGE_KEYS.managed]: {
        ...(managed || DEFAULTS.managed),
        lastStagingFolderId: null
      }
    });
  }

  // Defensive: remove any leftover staging folders by title prefix
  try {
    const kids = await bookmarksGetChildren(barRootId);
    const leftovers = kids.filter((n) => !n.url && (n.title || '').startsWith('__ContextBarStaging '));
    for (const f of leftovers) {
      await bookmarksRemoveTree(f.id);
    }
  } catch {
    // ignore
  }
}

// -----------------------------
// Event wiring
// -----------------------------

chrome.runtime.onInstalled.addListener(async () => {
  // Initialize default keys if missing
  const existing = await storageGet({});
  const toSet = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!(k in existing)) toSet[k] = v;
  }
  if (Object.keys(toSet).length) await storageSet(toSet);
});

chrome.runtime.onStartup?.addListener(async () => {
  await cleanupStaleState();
  const host = await getActiveHost();
  if (host) await scheduleCandidateSwitch(host);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || alarm.name !== ALARMS.candidate) return;

  const { candidateHost, candidateSince, lastApplyAt, enabled, locked } = await storageGet({
    [STORAGE_KEYS.candidateHost]: DEFAULTS.candidateHost,
    [STORAGE_KEYS.candidateSince]: DEFAULTS.candidateSince,
    [STORAGE_KEYS.lastApplyAt]: DEFAULTS.lastApplyAt,
    [STORAGE_KEYS.enabled]: DEFAULTS.enabled,
    [STORAGE_KEYS.locked]: DEFAULTS.locked
  });

  if (!enabled || locked) return;
  if (!candidateHost) return;

  const activeNow = await getActiveHost();
  if (activeNow !== candidateHost) return;
  if (Date.now() - (candidateSince || 0) < TIMING.dwellMs) {
    // not dwelled long enough; reschedule
    await alarmsCreate(ALARMS.candidate, { when: Date.now() + (TIMING.dwellMs - (Date.now() - candidateSince)) });
    return;
  }

  if (Date.now() - (lastApplyAt || 0) < TIMING.minIntervalMs) return;
  await applyHost(candidateHost, 'auto');
});

chrome.tabs.onActivated.addListener(async () => {
  const host = await getActiveHost();
  if (host) await scheduleCandidateSwitch(host);
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (!changeInfo || !changeInfo.url) return;
  const host = hostFromUrl(changeInfo.url);
  if (!host) return;
  if (!tab.active) return;
  await scheduleCandidateSwitch(host);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'getState') {
        const s = await storageGet({
          [STORAGE_KEYS.enabled]: DEFAULTS.enabled,
          [STORAGE_KEYS.locked]: DEFAULTS.locked,
          [STORAGE_KEYS.pinnedCount]: DEFAULTS.pinnedCount,
          [STORAGE_KEYS.rules]: DEFAULTS.rules,
          [STORAGE_KEYS.defaultSetId]: DEFAULTS.defaultSetId,
          [STORAGE_KEYS.lastAppliedHost]: DEFAULTS.lastAppliedHost,
          [STORAGE_KEYS.lastBackupFolderId]: DEFAULTS.lastBackupFolderId
        });
        sendResponse({ ok: true, state: s });
        return;
      }

      if (msg?.type === 'setState') {
        await storageSet(msg.patch || {});
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'listSets') {
        const { otherRootId } = await getBarAndOtherRootIds();
        const { setsRootId } = await ensureContextBarFolders(otherRootId);
        const kids = await bookmarksGetChildren(setsRootId);
        const sets = kids
          .filter((n) => !n.url)
          .map((n) => ({ id: n.id, title: n.title }));
        sendResponse({ ok: true, sets });
        return;
      }

      if (msg?.type === 'rerenderNow') {
        const host = await getActiveHost();
        await applyHost(host, 'manual');
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'restoreLastBackup') {
        const { barRootId } = await getBarAndOtherRootIds();
        const { lastBackupFolderId } = await storageGet({
          [STORAGE_KEYS.lastBackupFolderId]: DEFAULTS.lastBackupFolderId
        });
        await restoreFromBackup(barRootId, lastBackupFolderId);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message' });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();

  return true;
});

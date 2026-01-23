/*
  BarPilot - Context-Switched Bookmarks Bar

  Safety principles:
  - Canonical sets live under: Other Bookmarks / BarPilot / Sets
  - We only delete/move items we created in the managed region, tracked by ID.
  - Before applying, we create BOTH:
    - a real bookmarks backup folder
    - a JSON snapshot of the bar structure
*/

// -----------------------------
// Defaults / constants
// -----------------------------

const STORAGE_KEYS = {
  schemaVersion: 'schemaVersion',
  enabled: 'enabled',
  locked: 'locked',
  mode: 'mode',
  renderLocation: 'renderLocation',
  lastRenderLocationUsed: 'lastRenderLocationUsed',
  barModeBaselineBackupFolderId: 'barModeBaselineBackupFolderId',
  switchTrigger: 'switchTrigger',
  pausedUntil: 'pausedUntil',
  syncWarningAcknowledged: 'syncWarningAcknowledged',
  pinnedCount: 'pinnedCount',
  rules: 'rules',
  defaultSetId: 'defaultSetId',
  lastAppliedHost: 'lastAppliedHost',
  lastApplyAt: 'lastApplyAt',
  lastError: 'lastError',
  inProgress: 'inProgress',
  pendingHost: 'pendingHost',
  managed: 'managed',
  snapshots: 'snapshots',
  lastBackupFolderId: 'lastBackupFolderId',
  candidateHost: 'candidateHost',
  candidateSince: 'candidateSince'
};

const DEFAULTS = {
  schemaVersion: 1,
  enabled: true,
  locked: false,
  mode: 'automatic', // automatic | manual | local
  // Where the active set is rendered:
  // - 'markerFolder': inside a visible marker folder on the bar (safest)
  // - 'bar': directly onto the bookmarks bar after pinned items
  renderLocation: 'markerFolder',
  lastRenderLocationUsed: 'markerFolder',
  barModeBaselineBackupFolderId: null,
  switchTrigger: 'activation', // activation | navigation
  pausedUntil: 0,
  syncWarningAcknowledged: false,
  pinnedCount: 3,
  rules: [],
  defaultSetId: null,
  lastAppliedHost: null,
  lastApplyAt: 0,
  lastError: null,
  inProgress: null,
  pendingHost: null,
  managed: { markerFolderId: null, lastRenderedIds: [], lastStagingFolderId: null },
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
  minIntervalMs: 2000,
  inProgressStaleMs: 30_000
};

const ALARMS = {
  candidate: 'candidate-apply'
};

const BARPILOT = {
  rootNames: ['BarPilot', 'ContextBar'],
  setsName: 'Sets',
  backupsName: 'Backups',
  trashName: 'Trash'
};

const MARKER = {
  title: '— BarPilot —'
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

  // Prefer well-known IDs when available (helps in localized Chrome builds).
  const barById = children.find((c) => c.id === '1');
  const otherById = children.find((c) => c.id === '2');

  // Fallback: the first two are typically: Bookmarks bar, Other bookmarks.
  const bar = barById || children[0];
  const other = otherById || children[1];
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

async function findExistingBarPilotRoot(otherRootId) {
  const kids = await bookmarksGetChildren(otherRootId);
  for (const name of BARPILOT.rootNames) {
    const found = kids.find((n) => !n.url && n.title === name);
    if (found) return found;
  }
  return null;
}

async function ensureBarPilotFolders(otherRootId) {
  const existingRoot = await findExistingBarPilotRoot(otherRootId);
  const rootTitle = existingRoot?.title || BARPILOT.rootNames[0];
  const rootId = existingRoot?.id || (await findOrCreateFolderPath([rootTitle], otherRootId));

  const setsRootId = await findOrCreateFolderPath([rootTitle, BARPILOT.setsName], otherRootId);
  const backupsRootId = await findOrCreateFolderPath([rootTitle, BARPILOT.backupsName], otherRootId);
  const trashRootId = await findOrCreateFolderPath([rootTitle, BARPILOT.trashName], otherRootId);
  return { rootId, rootTitle, setsRootId, backupsRootId, trashRootId };
}

async function ensureMarkerFolder(barRootId, pinnedCount, managedState) {
  // Chrome will throw "Index out of bounds" if index > current children length.
  // If user sets pinnedCount larger than the bar length, treat it as "append at end".
  const clampBoundaryIndex = async () => {
    const siblings = await bookmarksGetChildren(barRootId);
    return Math.min(Math.max(0, Number(pinnedCount || 0)), siblings.length);
  };

  // 1) Try stored markerFolderId
  const storedId = managedState?.markerFolderId;
  if (storedId) {
    try {
      const nodes = await bookmarksGet(storedId);
      const node = nodes?.[0];
      if (node && !node.url && node.parentId === barRootId) {
        // ensure it is at the boundary index
        const siblings = await bookmarksGetChildren(barRootId);
        const idx = siblings.findIndex((n) => n.id === storedId);
        const boundary = Math.min(Math.max(0, Number(pinnedCount || 0)), siblings.length);
        if (idx !== boundary) {
          await bookmarksMove(storedId, { parentId: barRootId, index: boundary });
        }
        return storedId;
      }
    } catch {
      // ignore and fall through
    }
  }

  // 2) Find by title
  const kids = await bookmarksGetChildren(barRootId);
  const existing = kids.find((n) => !n.url && n.title === MARKER.title);
  if (existing) {
    const idx = kids.findIndex((n) => n.id === existing.id);
    const boundary = Math.min(Math.max(0, Number(pinnedCount || 0)), kids.length);
    if (idx !== boundary) {
      await bookmarksMove(existing.id, { parentId: barRootId, index: boundary });
    }
    return existing.id;
  }

  // 3) Create new marker folder
  const boundary = await clampBoundaryIndex();
  const created = await bookmarksCreate({ parentId: barRootId, title: MARKER.title, index: boundary });
  return created.id;
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
  return await backupBarToFolder({
    parentId: backupsRootId,
    title: `${isoStamp()} - ${host || 'unknown'}`,
    barRootId,
    setAsLastBackup: true
  });
}

async function backupBarToFolder({ parentId, title, barRootId, setAsLastBackup }) {
  const backupFolder = await bookmarksCreate({ parentId, title });
  const barChildren = await bookmarksGetChildren(barRootId);
  for (const c of barChildren) {
    await copySubtree(c.id, backupFolder.id);
  }
  if (setAsLastBackup) {
    await storageSet({ [STORAGE_KEYS.lastBackupFolderId]: backupFolder.id });
  }
  return backupFolder.id;
}

async function findMarkerFolderOnBar(barRootId) {
  const kids = await bookmarksGetChildren(barRootId);
  return kids.find((n) => !n.url && n.title === MARKER.title) || null;
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

async function isPausedOrManualOrLocal() {
  const { enabled, locked, mode, pausedUntil } = await storageGet({
    [STORAGE_KEYS.enabled]: DEFAULTS.enabled,
    [STORAGE_KEYS.locked]: DEFAULTS.locked,
    [STORAGE_KEYS.mode]: DEFAULTS.mode,
    [STORAGE_KEYS.pausedUntil]: DEFAULTS.pausedUntil
  });
  if (!enabled || locked) return true;
  if (mode !== 'automatic') return true;
  if (pausedUntil && Date.now() < pausedUntil) return true;
  return false;
}

async function scheduleCandidateSwitch(host) {
  if (!host) return;
  if (await isPausedOrManualOrLocal()) return;

  // store candidate and set alarm
  await storageSet({
    [STORAGE_KEYS.candidateHost]: host,
    [STORAGE_KEYS.candidateSince]: Date.now()
  });
  await alarmsClear(ALARMS.candidate);
  await alarmsCreate(ALARMS.candidate, { when: Date.now() + TIMING.debounceMs });
}

async function verifyRenderedTopLevel(setId, renderLocation, barRootId, pinnedCount, markerFolderId) {
  const setKids = await bookmarksGetChildren(setId);

  if (renderLocation === 'bar') {
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

  // default: markerFolder
  const markerKids = await bookmarksGetChildren(markerFolderId);
  const managed = markerKids.slice(0, setKids.length);
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
    [STORAGE_KEYS.schemaVersion]: DEFAULTS.schemaVersion,
    [STORAGE_KEYS.enabled]: DEFAULTS.enabled,
    [STORAGE_KEYS.locked]: DEFAULTS.locked,
    [STORAGE_KEYS.mode]: DEFAULTS.mode,
    [STORAGE_KEYS.renderLocation]: DEFAULTS.renderLocation,
    [STORAGE_KEYS.lastRenderLocationUsed]: DEFAULTS.lastRenderLocationUsed,
    [STORAGE_KEYS.barModeBaselineBackupFolderId]: DEFAULTS.barModeBaselineBackupFolderId,
    [STORAGE_KEYS.pausedUntil]: DEFAULTS.pausedUntil,
    [STORAGE_KEYS.pinnedCount]: DEFAULTS.pinnedCount,
    [STORAGE_KEYS.lastApplyAt]: DEFAULTS.lastApplyAt,
    [STORAGE_KEYS.inProgress]: DEFAULTS.inProgress,
    [STORAGE_KEYS.pendingHost]: DEFAULTS.pendingHost,
    [STORAGE_KEYS.managed]: DEFAULTS.managed
  });

  if (!state.enabled || state.locked) return;
  if (reason === 'auto') {
    if (state.mode !== 'automatic') return;
    if (state.pausedUntil && Date.now() < state.pausedUntil) return;
  }

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
    const { rootId, rootTitle, setsRootId, backupsRootId, trashRootId } = await ensureBarPilotFolders(otherRootId);

    // Validate that setId is under BarPilot/Sets (or migrated legacy root)
    const ok = await isDescendantOf(setId, setsRootId);
    if (!ok) throw new Error(`Refusing to apply: target set is not under ${rootTitle}/Sets`);

    const pinnedCount = Math.max(0, Number(state.pinnedCount || 0));
    const renderLocation = state.renderLocation || DEFAULTS.renderLocation;
    const lastRenderLocationUsed = state.lastRenderLocationUsed || DEFAULTS.lastRenderLocationUsed;

    // If switching out of direct-to-bar mode, restore the baseline bar first so the user gets their bar back.
    if (lastRenderLocationUsed === 'bar' && renderLocation !== 'bar' && state.barModeBaselineBackupFolderId) {
      await restoreFromBackup(barRootId, state.barModeBaselineBackupFolderId);
      // Baseline was used; clear it so future switches create a fresh one.
      await storageSet({ [STORAGE_KEYS.barModeBaselineBackupFolderId]: null });
    }

    // In direct-to-bar mode, always remove the marker folder if it exists (even if it's inside the "pinned" region).
    // This prevents ending up with BOTH marker folder + direct-to-bar items when toggling modes.
    if (renderLocation === 'bar') {
      const marker = await findMarkerFolderOnBar(barRootId);
      if (marker) {
        const trashBucket = await bookmarksCreate({
          parentId: trashRootId,
          title: `${isoStamp()} - removed marker`
        });
        await bookmarksMove(marker.id, { parentId: trashBucket.id });
      }
    }

    // Clamp the "pinned boundary" so bookmark operations never use an out-of-range index.
    const barChildrenBefore = await bookmarksGetChildren(barRootId);
    const boundaryIndex = Math.min(pinnedCount, barChildrenBefore.length);

    // Snapshot + Backup
    await snapshotBar(host, barRootId, pinnedCount);
    await backupBar(host, barRootId, backupsRootId);

    // If switching INTO direct-to-bar mode, capture a baseline backup of the user's bar (without setting "last backup").
    if (lastRenderLocationUsed !== 'bar' && renderLocation === 'bar' && !state.barModeBaselineBackupFolderId) {
      const baselineId = await backupBarToFolder({
        parentId: backupsRootId,
        title: `${isoStamp()} - baseline before direct-to-bar`,
        barRootId,
        setAsLastBackup: false
      });
      await storageSet({ [STORAGE_KEYS.barModeBaselineBackupFolderId]: baselineId });
    }

    let markerFolderId = null;
    let stagingParentId = rootId;
    if (renderLocation !== 'bar') {
      // Marker folder mode: ensure marker folder is present at the boundary index
      markerFolderId = await ensureMarkerFolder(barRootId, boundaryIndex, state.managed);
      stagingParentId = markerFolderId;
    }

    // Create staging folder (location depends on render mode)
    const stagingTitle = `__BarPilotStaging ${opId}`;
    const stagingFolder = await bookmarksCreate({ parentId: stagingParentId, title: stagingTitle });
    await storageSet({
      [STORAGE_KEYS.managed]: {
        ...(state.managed || DEFAULTS.managed),
        markerFolderId: renderLocation === 'bar' ? null : markerFolderId,
        lastStagingFolderId: stagingFolder.id
      }
    });

    // Copy set into staging
    const setChildren = await bookmarksGetChildren(setId);
    for (const c of setChildren) {
      await copySubtree(c.id, stagingFolder.id);
    }

    // Clear the managed region
    if (renderLocation === 'bar') {
      // In direct-to-bar mode, the managed region is everything after pinnedCount.
      // We move it to Trash (backup already exists) so switching is deterministic.
      const managedRegion = barChildrenBefore.slice(boundaryIndex);
      if (managedRegion.length) {
        const trashBucket = await bookmarksCreate({
          parentId: trashRootId,
          title: `${isoStamp()} - ${host || 'unknown'}`
        });
        for (const n of managedRegion) {
          await bookmarksMove(n.id, { parentId: trashBucket.id });
        }
      }
    } else {
      // Marker folder mode: only move what we previously rendered (inside marker folder)
      const markerChildren = await bookmarksGetChildren(markerFolderId);
      const lastRenderedIds = state.managed?.lastRenderedIds || [];
      const eligible = markerChildren.filter((n) => lastRenderedIds.includes(n.id));

      if (eligible.length) {
        const trashBucket = await bookmarksCreate({
          parentId: trashRootId,
          title: `${isoStamp()} - ${host || 'unknown'}`
        });
        for (const n of eligible) {
          await bookmarksMove(n.id, { parentId: trashBucket.id });
        }
      }
    }

    // Move staging children into the target location
    const stagingChildren = await bookmarksGetChildren(stagingFolder.id);
    const renderedTopLevelIds = [];
    let idx = 0;
    const targetParentId = renderLocation === 'bar' ? barRootId : markerFolderId;
    const targetIndexBase = renderLocation === 'bar' ? boundaryIndex : 0;
    for (const n of stagingChildren) {
      const moved = await bookmarksMove(n.id, { parentId: targetParentId, index: targetIndexBase + idx });
      renderedTopLevelIds.push(moved.id);
      idx++;
    }

    // Remove staging folder
    await bookmarksRemoveTree(stagingFolder.id);

    // Record state
    await storageSet({
      [STORAGE_KEYS.managed]: {
        markerFolderId: renderLocation === 'bar' ? null : markerFolderId,
        lastRenderedIds: renderedTopLevelIds,
        lastStagingFolderId: null
      },
      [STORAGE_KEYS.lastAppliedHost]: host,
      [STORAGE_KEYS.lastApplyAt]: Date.now(),
      [STORAGE_KEYS.lastRenderLocationUsed]: renderLocation
    });

    // Verify (shallow)
    const verified = await verifyRenderedTopLevel(setId, renderLocation, barRootId, boundaryIndex, markerFolderId);
    if (!verified) {
      const { lastBackupFolderId } = await storageGet({
        [STORAGE_KEYS.lastBackupFolderId]: DEFAULTS.lastBackupFolderId
      });
      await restoreFromBackup(barRootId, lastBackupFolderId);
      throw new Error('Verification failed; restored from last backup');
    }
  } catch (e) {
    await storageSet({ [STORAGE_KEYS.lastError]: e?.message || String(e) });
    throw e;
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
    const leftovers = kids.filter((n) => !n.url && (n.title || '').startsWith('__BarPilotStaging '));
    for (const f of leftovers) {
      await bookmarksRemoveTree(f.id);
    }
  } catch {
    // ignore
  }

  // Also check under Other Bookmarks / BarPilot root (used by direct-to-bar mode)
  try {
    const { otherRootId } = await getBarAndOtherRootIds();
    const { rootId } = await ensureBarPilotFolders(otherRootId);
    const kids = await bookmarksGetChildren(rootId);
    const leftovers = kids.filter((n) => !n.url && (n.title || '').startsWith('__BarPilotStaging '));
    for (const f of leftovers) {
      await bookmarksRemoveTree(f.id);
    }
  } catch {
    // ignore
  }
}

async function migrateStorageIfNeeded() {
  const { schemaVersion } = await storageGet({ [STORAGE_KEYS.schemaVersion]: 0 });
  if (!schemaVersion || schemaVersion < 1) {
    // First stable schema
    await storageSet({
      [STORAGE_KEYS.schemaVersion]: 1,
      [STORAGE_KEYS.mode]: DEFAULTS.mode,
      [STORAGE_KEYS.switchTrigger]: DEFAULTS.switchTrigger,
      [STORAGE_KEYS.pausedUntil]: DEFAULTS.pausedUntil,
      [STORAGE_KEYS.syncWarningAcknowledged]: DEFAULTS.syncWarningAcknowledged,
      [STORAGE_KEYS.lastError]: DEFAULTS.lastError
    });
  }
}

// -----------------------------
// Event wiring
// -----------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await migrateStorageIfNeeded();

  // Initialize default keys if missing
  const existing = await storageGet({});
  const toSet = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!(k in existing)) toSet[k] = v;
  }
  if (Object.keys(toSet).length) await storageSet(toSet);
});

chrome.runtime.onStartup?.addListener(async () => {
  await migrateStorageIfNeeded();
  await cleanupStaleState();
  const host = await getActiveHost();
  if (host) await scheduleCandidateSwitch(host);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || alarm.name !== ALARMS.candidate) return;

  const { candidateHost, candidateSince, lastApplyAt, enabled, locked, mode, pausedUntil } = await storageGet({
    [STORAGE_KEYS.candidateHost]: DEFAULTS.candidateHost,
    [STORAGE_KEYS.candidateSince]: DEFAULTS.candidateSince,
    [STORAGE_KEYS.lastApplyAt]: DEFAULTS.lastApplyAt,
    [STORAGE_KEYS.enabled]: DEFAULTS.enabled,
    [STORAGE_KEYS.locked]: DEFAULTS.locked,
    [STORAGE_KEYS.mode]: DEFAULTS.mode,
    [STORAGE_KEYS.pausedUntil]: DEFAULTS.pausedUntil
  });

  if (!enabled || locked) return;
  if (mode !== 'automatic') return;
  if (pausedUntil && Date.now() < pausedUntil) return;
  if (!candidateHost) return;

  const since = Number(candidateSince);
  const sinceMs = Number.isFinite(since) && since > 0 ? since : 0;

  const activeNow = await getActiveHost();
  if (activeNow !== candidateHost) return;

  const elapsedMs = Date.now() - sinceMs;
  if (elapsedMs < TIMING.dwellMs) {
    // not dwelled long enough; reschedule
    const remainingMs = Math.max(50, TIMING.dwellMs - elapsedMs);
    await alarmsCreate(ALARMS.candidate, { when: Date.now() + remainingMs });
    return;
  }

  if (Date.now() - (lastApplyAt || 0) < TIMING.minIntervalMs) return;
  try {
    await applyHost(candidateHost, 'auto');
  } catch (e) {
    // applyHost already records lastError; avoid unhandled rejection in MV3 alarm handler.
    console.warn('BarPilot: auto applyHost failed', e);
  }
});

chrome.tabs.onActivated.addListener(async () => {
  const { switchTrigger } = await storageGet({ [STORAGE_KEYS.switchTrigger]: DEFAULTS.switchTrigger });
  if (switchTrigger !== 'activation') return;
  const host = await getActiveHost();
  if (host) await scheduleCandidateSwitch(host);
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (!changeInfo || !changeInfo.url) return;
  const { switchTrigger } = await storageGet({ [STORAGE_KEYS.switchTrigger]: DEFAULTS.switchTrigger });
  if (switchTrigger !== 'navigation') return;

  const host = hostFromUrl(changeInfo.url);
  if (!host) return;
  if (!tab.active) return;
  await scheduleCandidateSwitch(host);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const host = await getActiveHost();
  if (host) await scheduleCandidateSwitch(host);
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === 'toggle-lock') {
      const { locked } = await storageGet({ [STORAGE_KEYS.locked]: DEFAULTS.locked });
      await storageSet({ [STORAGE_KEYS.locked]: !locked });
      return;
    }
    if (command === 'toggle-enabled') {
      const { enabled } = await storageGet({ [STORAGE_KEYS.enabled]: DEFAULTS.enabled });
      await storageSet({ [STORAGE_KEYS.enabled]: !enabled });
      return;
    }
    if (command === 'rerender-now') {
      const host = await getActiveHost();
      await applyHost(host, 'manual');
      return;
    }
  } catch (e) {
    await storageSet({ [STORAGE_KEYS.lastError]: e?.message || String(e) });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'getState') {
        const s = await storageGet({
          [STORAGE_KEYS.schemaVersion]: DEFAULTS.schemaVersion,
          [STORAGE_KEYS.enabled]: DEFAULTS.enabled,
          [STORAGE_KEYS.locked]: DEFAULTS.locked,
          [STORAGE_KEYS.mode]: DEFAULTS.mode,
          [STORAGE_KEYS.renderLocation]: DEFAULTS.renderLocation,
          [STORAGE_KEYS.switchTrigger]: DEFAULTS.switchTrigger,
          [STORAGE_KEYS.pausedUntil]: DEFAULTS.pausedUntil,
          [STORAGE_KEYS.syncWarningAcknowledged]: DEFAULTS.syncWarningAcknowledged,
          [STORAGE_KEYS.pinnedCount]: DEFAULTS.pinnedCount,
          [STORAGE_KEYS.rules]: DEFAULTS.rules,
          [STORAGE_KEYS.defaultSetId]: DEFAULTS.defaultSetId,
          [STORAGE_KEYS.lastAppliedHost]: DEFAULTS.lastAppliedHost,
          [STORAGE_KEYS.lastBackupFolderId]: DEFAULTS.lastBackupFolderId,
          [STORAGE_KEYS.lastError]: DEFAULTS.lastError
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
        const { setsRootId } = await ensureBarPilotFolders(otherRootId);
        const kids = await bookmarksGetChildren(setsRootId);
        const sets = kids
          .filter((n) => !n.url)
          .map((n) => ({ id: n.id, title: n.title }));
        sendResponse({ ok: true, sets });
        return;
      }

      if (msg?.type === 'previewForHost') {
        const host = (msg.host || '').trim().toLowerCase();
        if (!host) {
          sendResponse({ ok: true, host: null, setId: null, setTitle: null, items: [] });
          return;
        }
        const setId = await resolveSetIdForHost(host);
        if (!setId) {
          sendResponse({ ok: true, host, setId: null, setTitle: null, items: [] });
          return;
        }
        const setNode = (await bookmarksGet(setId))?.[0];
        const kids = await bookmarksGetChildren(setId);
        const items = [];
        for (const k of kids) {
          if (k.url) {
            items.push({ type: 'bookmark', title: k.title, url: k.url });
          } else {
            const c = await bookmarksGetChildren(k.id);
            items.push({ type: 'folder', title: k.title, childCount: c.length });
          }
        }
        sendResponse({ ok: true, host, setId, setTitle: setNode?.title || null, items });
        return;
      }

      if (msg?.type === 'getLocalPreview') {
        const host = await getActiveHost();
        if (!host) {
          sendResponse({ ok: true, host: null, setId: null, setTitle: null, items: [] });
          return;
        }
        const setId = await resolveSetIdForHost(host);
        if (!setId) {
          sendResponse({ ok: true, host, setId: null, setTitle: null, items: [] });
          return;
        }
        const setNode = (await bookmarksGet(setId))?.[0];
        const kids = await bookmarksGetChildren(setId);
        const items = [];
        for (const k of kids) {
          if (k.url) {
            items.push({ type: 'bookmark', title: k.title, url: k.url });
          } else {
            const c = await bookmarksGetChildren(k.id);
            items.push({ type: 'folder', title: k.title, childCount: c.length });
          }
        }
        sendResponse({ ok: true, host, setId, setTitle: setNode?.title || null, items });
        return;
      }

      if (msg?.type === 'rerenderNow') {
        const host = await getActiveHost();
        await applyHost(host, 'manual');
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'resetManaged') {
        const { barRootId, otherRootId } = await getBarAndOtherRootIds();
        const { trashRootId } = await ensureBarPilotFolders(otherRootId);
        const { managed, pinnedCount, renderLocation } = await storageGet({
          [STORAGE_KEYS.managed]: DEFAULTS.managed,
          [STORAGE_KEYS.pinnedCount]: DEFAULTS.pinnedCount,
          [STORAGE_KEYS.renderLocation]: DEFAULTS.renderLocation
        });

        const pc = Math.max(0, Number(pinnedCount || 0));
        const rl = renderLocation || DEFAULTS.renderLocation;

        if (rl === 'bar') {
          const barChildren = await bookmarksGetChildren(barRootId);
          const boundaryIndex = Math.min(pc, barChildren.length);
          const managedRegion = barChildren.slice(boundaryIndex);
          if (managedRegion.length) {
            const trashBucket = await bookmarksCreate({
              parentId: trashRootId,
              title: `${isoStamp()} - reset`
            });
            for (const n of managedRegion) {
              await bookmarksMove(n.id, { parentId: trashBucket.id });
            }
          }
          await storageSet({
            [STORAGE_KEYS.managed]: { markerFolderId: null, lastRenderedIds: [], lastStagingFolderId: null }
          });
        } else {
          const boundaryIndex = Math.min(pc, (await bookmarksGetChildren(barRootId)).length);
          const markerFolderId = await ensureMarkerFolder(barRootId, boundaryIndex, managed);
          const markerChildren = await bookmarksGetChildren(markerFolderId);
          if (markerChildren.length) {
            const trashBucket = await bookmarksCreate({
              parentId: trashRootId,
              title: `${isoStamp()} - reset`
            });
            for (const n of markerChildren) {
              await bookmarksMove(n.id, { parentId: trashBucket.id });
            }
          }

          await storageSet({
            [STORAGE_KEYS.managed]: { markerFolderId, lastRenderedIds: [], lastStagingFolderId: null }
          });
        }
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

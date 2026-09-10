const STORAGE_KEY = "brain-map-v1";
const POSITION_KEY = `${STORAGE_KEY}-cy-positions`;
const PATH_TEXT_SCALE_KEY = `${STORAGE_KEY}-path-text-scale`;
const BACKUP_SNAPSHOT_KEY = `${STORAGE_KEY}-backup-snapshots`;
const SUPABASE_URL = "https://pjyqpbsyryrjrjhzptya.supabase.co";
const SUPABASE_KEY = "sb_publishable_GnE9iXy2uw8oBStdXzp5IA_VPBo03DK";
const CLOUD_TABLE = "brain_map_state";
const CLOUD_ROW_KEY = "main";
let supabaseClient = null;
let cloudUser = null;
let cloudSyncTimer = null;
let cloudPollingTimer = null;
let cloudApplyingState = false;
let cloudLastUpdatedAt = null;
let cloudLastError = "";

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function normalize(label) {
  return label.trim().replace(/\s+/g, "").toLowerCase();
}

function node(id, label) {
  const now = new Date().toISOString();
  return { id, label, normalizedLabel: normalize(label), createdAt: now, updatedAt: now };
}

function episode(nodeIds, startedAt, aware = false, pauseMarkers = [], meta = {}) {
  return {
    id: uid(),
    startedAt,
    completedAt: startedAt,
    status: "completed",
    aware,
    pauseMarkers,
    source: meta.source || null,
    bodySkipped: Boolean(meta.bodySkipped),
    steps: nodeIds.map((nodeId, order) => ({ id: uid(), nodeId, order }))
  };
}

function plannedEdge(fromNodeId, toNodeId, createdAt = new Date().toISOString()) {
  return {
    id: uid(),
    fromNodeId,
    toNodeId,
    createdAt,
    status: "active",
    firstWalkedEpisodeId: null,
    firstWalkedAt: null
  };
}

function daysAgo(days, hour, minute) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

const seed = {
  nodes: [
    node("anxiety", "焦虑"),
    node("food", "吃东西"),
    node("maocai", "冒菜"),
    node("carb", "晕碳"),
    node("cant-work", "工作做不了"),
    node("sleep", "睡觉"),
    node("phone", "刷手机"),
    node("more-anxiety", "更焦虑"),
    node("cat", "撸猫"),
    node("light-food", "轻食"),
    node("work", "继续工作"),
    node("mentor", "看到导师消息"),
    node("nervous", "紧张"),
    node("avoid-open", "不敢打开"),
    node("tired", "累"),
    node("lie-down", "躺下")
  ],
  episodes: [
    episode(["anxiety", "food", "maocai", "carb", "cant-work", "sleep", "more-anxiety"], daysAgo(1, 21, 13)),
    episode(["anxiety", "food", "maocai", "carb", "sleep"], daysAgo(2, 13, 2)),
    episode(["anxiety", "food", "light-food", "work"], daysAgo(2, 18, 42)),
    episode(["anxiety", "phone", "more-anxiety"], daysAgo(3, 22, 15)),
    episode(["anxiety", "phone", "more-anxiety"], daysAgo(4, 17, 40)),
    episode(["anxiety", "cat", "work"], daysAgo(5, 19, 12)),
    episode(["mentor", "nervous", "avoid-open", "phone", "more-anxiety"], daysAgo(6, 10, 30)),
    episode(["tired", "lie-down", "phone", "sleep"], daysAgo(6, 15, 25)),
    episode(["anxiety", "food", "maocai", "carb", "sleep"], daysAgo(8, 20, 1)),
    episode(["anxiety", "food", "light-food", "work"], daysAgo(10, 12, 2)),
    episode(["anxiety", "cat", "work"], daysAgo(12, 16, 33))
  ],
  plannedEdges: [
    plannedEdge("food", "light-food", daysAgo(13, 9, 0))
  ],
  newPathEdgeKeys: []
};

let state = hydratePlannedEdges(loadState());
saveState();
let graph = { nodes: [], edges: [] };
let selectedNodeId = "anxiety";
let pathStartId = "anxiety";
let focusMode = false;
let recording = [];
let recordingFromPath = false;
let recordingPauses = [];
let recordingSource = null;
let recordingBodyPromptDone = false;
let recordingBodySkipped = false;
let newNodeContext = "path";
let hiddenRecorderOptionIds = new Set();
let temporaryNodeIds = new Set();
let freshRecordingNodeIds = new Set();
let freshRecordingEdgeKeys = new Set();
let expandedPathNodeIds = new Set();
let editingNodeId = null;
let savedPositions = loadPositions();
let pauseTimer = null;
let pauseRemaining = 10;
let draftBarHideTimer = null;
let activeGuidedEpisodeId = null;
let hiddenStartNodeIds = new Set(JSON.parse(localStorage.getItem(`${STORAGE_KEY}-hidden-starts`) || "[]"));
let selectedHistoryEpisodeIds = new Set();
let selectedDeletedEpisodeIds = new Set();
let changeRange = "today";
let expandedChangeInsightIds = new Set();
let pathTextScale = Number(localStorage.getItem(PATH_TEXT_SCALE_KEY) || "1.06");
let pendingDeletePathOption = null;
let selectedOldStepOption = null;

const els = {
  range: document.getElementById("rangeSelect"),
  cloudSyncButton: document.getElementById("cloudSyncButton"),
  cloudSyncDialog: document.getElementById("cloudSyncDialog"),
  cloudSyncStatus: document.getElementById("cloudSyncStatus"),
  cloudLoginFields: document.getElementById("cloudLoginFields"),
  cloudEmail: document.getElementById("cloudEmail"),
  cloudPassword: document.getElementById("cloudPassword"),
  cloudLogin: document.getElementById("cloudLogin"),
  cloudUploadLocal: document.getElementById("cloudUploadLocal"),
  cloudUseRemote: document.getElementById("cloudUseRemote"),
  cloudRefresh: document.getElementById("cloudRefresh"),
  cloudLogout: document.getElementById("cloudLogout"),
  recordButton: document.getElementById("recordButton"),
  recordPanel: document.getElementById("recordPanel"),
  recordTitle: document.getElementById("recordTitle"),
  currentPath: document.getElementById("currentPath"),
  choiceGrid: document.getElementById("choiceGrid"),
  pathPickerActions: document.getElementById("pathPickerActions"),
  confirmOldStep: document.getElementById("confirmOldStep"),
  cancelOldStep: document.getElementById("cancelOldStep"),
  backRecord: document.getElementById("backRecord"),
  cancelRecord: document.getElementById("cancelRecord"),
  awareToggle: document.getElementById("awareToggle"),
  pauseStep: document.getElementById("pauseStep"),
  undoStep: document.getElementById("undoStep"),
  finishRecord: document.getElementById("finishRecord"),
  startPickerButton: document.getElementById("startPickerButton"),
  startPickerPanel: document.getElementById("startPickerPanel"),
  startSearchInput: document.getElementById("startSearchInput"),
  recentStarts: document.getElementById("recentStarts"),
  startOptionsList: document.getElementById("startOptionsList"),
  pathRecordButton: document.getElementById("pathRecordButton"),
  pathAddOld: document.getElementById("pathAddOld"),
  pathDraftBar: document.getElementById("pathDraftBar"),
  pathDraftLine: document.getElementById("pathDraftLine"),
  pathAddNext: document.getElementById("pathAddNext"),
  pathPause: document.getElementById("pathPause"),
  pathUndo: document.getElementById("pathUndo"),
  pathCancel: document.getElementById("pathCancel"),
  pathFinish: document.getElementById("pathFinish"),
  pathView: document.getElementById("pathView"),
  pathMap: document.getElementById("pathMap"),
  pathContextMenu: document.getElementById("pathContextMenu"),
  pathContextDelete: document.getElementById("pathContextDelete"),
  pathShell: document.querySelector(".path-shell"),
  pathTextSmaller: document.getElementById("pathTextSmaller"),
  pathTextLarger: document.getElementById("pathTextLarger"),
  pathInsight: document.getElementById("pathInsight"),
  changeRangeButtons: document.querySelectorAll("[data-change-range]"),
  pauseCard: document.getElementById("pauseCard"),
  pauseCountdown: document.getElementById("pauseCountdown"),
  pausePrompt: document.getElementById("pausePrompt"),
  skipPause: document.getElementById("skipPause"),
  historyList: document.getElementById("historyList"),
  exportData: document.getElementById("exportData"),
  importData: document.getElementById("importData"),
  importDataInput: document.getElementById("importDataInput"),
  restoreSnapshot: document.getElementById("restoreSnapshot"),
  trashList: document.getElementById("trashList"),
  dialog: document.getElementById("newNodeDialog"),
  newNodeInput: document.getElementById("newNodeInput"),
  newNodeTitle: document.getElementById("newNodeTitle"),
  nodeMatches: document.getElementById("nodeMatches"),
  confirmNewNode: document.getElementById("confirmNewNode"),
  deleteConfirmDialog: document.getElementById("deleteConfirmDialog"),
  deleteConfirmText: document.getElementById("deleteConfirmText"),
  confirmDeletePath: document.getElementById("confirmDeletePath"),
  cancelDeletePath: document.getElementById("cancelDeletePath")
};

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});
els.range.addEventListener("change", render);
els.cloudSyncButton.addEventListener("click", openCloudSyncDialog);
els.cloudLogin.addEventListener("click", loginCloudSync);
els.cloudLogout.addEventListener("click", logoutCloudSync);
els.cloudUploadLocal.addEventListener("click", () => pushCloudState({ force: true }));
els.cloudUseRemote.addEventListener("click", pullCloudState);
els.cloudRefresh.addEventListener("click", refreshCloudState);
els.changeRangeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    changeRange = button.dataset.changeRange || "today";
    expandedChangeInsightIds = new Set();
    renderInsightsPlaceholder();
  });
});
els.startPickerButton.addEventListener("click", () => {
  els.startPickerPanel.classList.toggle("hidden");
  els.startSearchInput.focus();
});
els.startSearchInput.addEventListener("input", renderPathStartOptions);
els.pathRecordButton.addEventListener("click", () => {
  closeStartPicker();
  startPathRecording(pathStartId);
});
els.pathAddOld.addEventListener("click", () => openNewNodeDialog("path-old"));
els.pathAddNext.addEventListener("click", () => openNewNodeDialog("path-new"));
els.pathPause.addEventListener("click", addPausePoint);
els.skipPause.addEventListener("click", finishPauseCard);
els.pathUndo.addEventListener("click", undoStep);
els.pathCancel.addEventListener("click", stopRecording);
els.pathFinish.addEventListener("click", finishRecord);
els.pathTextSmaller.addEventListener("click", () => setPathTextScale(pathTextScale - 0.06));
els.pathTextLarger.addEventListener("click", () => setPathTextScale(pathTextScale + 0.06));
els.pathShell.addEventListener("scroll", positionPathDraftBar);
window.addEventListener("resize", positionPathDraftBar);
els.pathDraftBar.addEventListener("pointerenter", clearPathDraftBarAutoHide);
els.pathDraftBar.addEventListener("pointerleave", schedulePathDraftBarAutoHide);
els.pathDraftBar.addEventListener("click", schedulePathDraftBarAutoHide);
els.pathContextDelete.addEventListener("click", () => {
  hidePathContextMenu();
  if (!pendingDeletePathOption) return;
  const target = getNode(pendingDeletePathOption.toNodeId);
  openDeletePathConfirm(pendingDeletePathOption.fromNodeId, pendingDeletePathOption.toNodeId, target?.label || "这个选项");
});
els.exportData.addEventListener("click", exportDataBackup);
els.importData.addEventListener("click", () => els.importDataInput.click());
els.importDataInput.addEventListener("change", importDataBackup);
els.restoreSnapshot.addEventListener("click", restoreLatestSnapshot);
els.recordButton.addEventListener("click", () => startRecording());
els.cancelRecord.addEventListener("click", stopRecording);
els.backRecord.addEventListener("click", goBackRecordStep);
els.cancelOldStep.addEventListener("click", hideOldStepChoices);
els.confirmOldStep.addEventListener("click", confirmOldStepChoice);
els.pauseStep.addEventListener("click", addPausePoint);
els.undoStep.addEventListener("click", undoStep);
els.finishRecord.addEventListener("click", finishRecord);
els.newNodeInput.addEventListener("input", renderNodeMatches);
document.addEventListener("keydown", handleShortcuts);
els.confirmNewNode.addEventListener("click", (event) => {
  event.preventDefault();
  addNewNodeFromDialog();
});
els.confirmDeletePath.addEventListener("click", (event) => {
  event.preventDefault();
  if (pendingDeletePathOption) {
    deletePathOption(pendingDeletePathOption.fromNodeId, pendingDeletePathOption.toNodeId);
    pendingDeletePathOption = null;
  }
  els.deleteConfirmDialog.close();
});
els.cancelDeletePath.addEventListener("click", () => {
  pendingDeletePathOption = null;
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest?.(".path-context-menu")) hidePathContextMenu();
  if (els.startPickerPanel.classList.contains("hidden")) return;
  if (event.target.closest?.(".start-picker")) return;
  closeStartPicker();
});

applyPathTextScale();
render();
initCloudSync();

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    return clone(seed);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.nodes || !parsed.episodes) return clone(seed);
    let migrated = false;
    if (!parsed.plannedEdges) {
      parsed.plannedEdges = [];
      migrated = true;
    }
    if (!parsed.hiddenPathOptions) {
      parsed.hiddenPathOptions = [];
      migrated = true;
    }
    if (!parsed.newPathEdgeKeys) {
      parsed.newPathEdgeKeys = [];
      migrated = true;
    }
    parsed.plannedEdges = parsed.plannedEdges.map((edge) => {
      if (edge.firstWalkedEpisodeId !== undefined && edge.firstWalkedAt !== undefined) return edge;
      migrated = true;
      return { firstWalkedEpisodeId: null, firstWalkedAt: null, ...edge };
    });
    if (removeVerificationTestData(parsed)) migrated = true;
    if (migrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    return parsed;
  } catch {
    return clone(seed);
  }
}

function removeVerificationTestData(parsed) {
  const testLabels = new Set(["测试起点0950", "测试旧步0950", "测试新路0950"]);
  const testNodeIds = new Set(parsed.nodes.filter((n) => testLabels.has(n.label)).map((n) => n.id));
  if (!testNodeIds.size) return false;
  parsed.nodes = parsed.nodes.filter((n) => !testNodeIds.has(n.id));
  parsed.episodes = parsed.episodes.filter((ep) => orderedIds(ep).every((id) => !testNodeIds.has(id)));
  parsed.plannedEdges = (parsed.plannedEdges || []).filter((edge) => !testNodeIds.has(edge.fromNodeId) && !testNodeIds.has(edge.toNodeId));
  parsed.hiddenPathOptions = (parsed.hiddenPathOptions || []).filter((key) => key.split("->").every((id) => !testNodeIds.has(id)));
  parsed.newPathEdgeKeys = (parsed.newPathEdgeKeys || []).filter((key) => key.split("->").every((id) => !testNodeIds.has(id)));
  return true;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleCloudSync();
}

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;
  if (!window.supabase?.createClient) return null;
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return supabaseClient;
}

function setCloudStatus(message, error = "") {
  cloudLastError = error;
  if (els.cloudSyncStatus) els.cloudSyncStatus.textContent = message;
  renderCloudSyncState();
}

function renderCloudSyncState() {
  if (!els.cloudSyncButton) return;
  els.cloudSyncButton.classList.toggle("is-on", Boolean(cloudUser));
  els.cloudSyncButton.classList.toggle("has-error", Boolean(cloudLastError));
  if (cloudLastError) {
    els.cloudSyncButton.textContent = "同步需检查";
  } else if (cloudUser && cloudLastUpdatedAt) {
    els.cloudSyncButton.textContent = "已云同步";
  } else if (cloudUser) {
    els.cloudSyncButton.textContent = "云同步已登录";
  } else {
    els.cloudSyncButton.textContent = "本机保存";
  }
  if (!els.cloudLoginFields) return;
  els.cloudLoginFields.classList.toggle("hidden", Boolean(cloudUser));
  els.cloudLogin.classList.toggle("hidden", Boolean(cloudUser));
  els.cloudLogout.classList.toggle("hidden", !cloudUser);
  els.cloudUploadLocal.disabled = !cloudUser;
  els.cloudUseRemote.disabled = !cloudUser;
  els.cloudRefresh.disabled = !cloudUser;
}

function cloudRowId() {
  return cloudUser ? `${cloudUser.id}:${CLOUD_ROW_KEY}` : CLOUD_ROW_KEY;
}

async function initCloudSync() {
  renderCloudSyncState();
  const client = getSupabaseClient();
  if (!client) {
    setCloudStatus("Supabase SDK 没加载成功；本机保存不受影响。", "sdk-missing");
    return;
  }
  const { data } = await client.auth.getSession();
  cloudUser = data.session?.user || null;
  if (!cloudUser) {
    setCloudStatus("本机数据已保存。登录后会同步到 Brain Map 单独的数据表。");
    return;
  }
  setCloudStatus(`已登录：${cloudUser.email || "当前账号"}。本机保存正常。`);
  startCloudPolling();
  refreshCloudState({ silent: true });
}

function openCloudSyncDialog() {
  renderCloudSyncState();
  if (!cloudUser && !cloudLastError) {
    setCloudStatus("本机数据已保存。登录后只读写 brain_map_state，不影响投稿管理系统。");
  }
  els.cloudSyncDialog.showModal();
}

async function loginCloudSync() {
  const client = getSupabaseClient();
  if (!client) {
    setCloudStatus("Supabase SDK 没加载成功；本机保存不受影响。", "sdk-missing");
    return;
  }
  const email = els.cloudEmail.value.trim();
  const password = els.cloudPassword.value;
  if (!email || !password) {
    setCloudStatus("先填邮箱和密码。");
    return;
  }
  setCloudStatus("正在登录...");
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    setCloudStatus(`登录失败：${error.message}`, error.message);
    return;
  }
  cloudUser = data.user;
  els.cloudPassword.value = "";
  setCloudStatus(`已登录：${cloudUser.email || email}。正在检查云端数据...`);
  startCloudPolling();
  const row = await fetchCloudRow();
  if (!row) {
    await pushCloudState({ force: true });
    return;
  }
  cloudLastUpdatedAt = row.updated_at;
  setCloudStatus("云端已有 Brain Map 数据。为避免覆盖本机，请选择“上传本机”或“使用云端”。");
}

async function logoutCloudSync() {
  const client = getSupabaseClient();
  stopCloudPolling();
  if (client) await client.auth.signOut();
  cloudUser = null;
  cloudLastUpdatedAt = null;
  setCloudStatus("已退出云同步。本机保存不受影响。");
}

function startCloudPolling() {
  stopCloudPolling();
  cloudPollingTimer = window.setInterval(() => refreshCloudState({ silent: true }), 15000);
}

function stopCloudPolling() {
  if (cloudPollingTimer) window.clearInterval(cloudPollingTimer);
  cloudPollingTimer = null;
}

function scheduleCloudSync() {
  if (cloudApplyingState || !cloudUser) return;
  if (cloudSyncTimer) window.clearTimeout(cloudSyncTimer);
  cloudSyncTimer = window.setTimeout(() => pushCloudState(), 900);
}

async function fetchCloudRow() {
  const client = getSupabaseClient();
  if (!client || !cloudUser) return null;
  const { data, error } = await client
    .from(CLOUD_TABLE)
    .select("id,user_id,state,updated_at")
    .eq("id", cloudRowId())
    .eq("user_id", cloudUser.id)
    .maybeSingle();
  if (error) {
    setCloudStatus(`云同步还没准备好：${error.message}`, error.message);
    return null;
  }
  return data || null;
}

async function pushCloudState(options = {}) {
  const client = getSupabaseClient();
  if (!client || !cloudUser) return;
  if (cloudSyncTimer) window.clearTimeout(cloudSyncTimer);
  cloudSyncTimer = null;
  const payload = backupPayload("cloud-sync");
  const updatedAt = new Date().toISOString();
  const { error } = await client
    .from(CLOUD_TABLE)
    .upsert({
      id: cloudRowId(),
      user_id: cloudUser.id,
      state: payload,
      updated_at: updatedAt
    }, { onConflict: "id" });
  if (error) {
    setCloudStatus(`同步失败：${error.message}`, error.message);
    return;
  }
  cloudLastUpdatedAt = updatedAt;
  const suffix = options.force ? "已上传本机数据。" : "本机改动已同步。";
  setCloudStatus(`${suffix} 上次同步 ${formatTime(updatedAt)}。`);
}

async function pullCloudState() {
  const row = await fetchCloudRow();
  if (!row?.state) {
    setCloudStatus("云端还没有 Brain Map 数据，可以先点“上传本机”。");
    return;
  }
  saveBackupSnapshot("before-use-cloud");
  applyCloudPayload(row.state);
  cloudLastUpdatedAt = row.updated_at;
  setCloudStatus(`已使用云端数据。本机旧状态已存入“恢复删除前”。`);
}

async function refreshCloudState(options = {}) {
  if (!cloudUser) return;
  const row = await fetchCloudRow();
  if (!row) {
    if (!options.silent) setCloudStatus("云端还没有 Brain Map 数据，可以上传本机。");
    return;
  }
  const changed = cloudLastUpdatedAt && row.updated_at && row.updated_at !== cloudLastUpdatedAt;
  cloudLastUpdatedAt = row.updated_at;
  if (changed) {
    setCloudStatus("云端有更新。为避免覆盖本机，请点“使用云端”手动拉取。");
  } else if (!options.silent) {
    setCloudStatus(`云端正常。上次更新 ${formatTime(row.updated_at)}。`);
  } else {
    renderCloudSyncState();
  }
}

function applyCloudPayload(payload) {
  if (!payload?.state?.nodes || !payload.state?.episodes) {
    setCloudStatus("云端数据格式不对，没有覆盖本机。", "invalid-cloud-state");
    return;
  }
  cloudApplyingState = true;
  state = hydratePlannedEdges(payload.state);
  hiddenStartNodeIds = new Set(payload.hiddenStartNodeIds || []);
  pathTextScale = Number(payload.pathTextScale || pathTextScale);
  savedPositions = payload.savedPositions || {};
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  localStorage.setItem(`${STORAGE_KEY}-hidden-starts`, JSON.stringify([...hiddenStartNodeIds]));
  localStorage.setItem(PATH_TEXT_SCALE_KEY, String(pathTextScale));
  localStorage.setItem(POSITION_KEY, JSON.stringify(savedPositions));
  selectedHistoryEpisodeIds = new Set();
  selectedDeletedEpisodeIds = new Set();
  const firstStart = startOptions().find((item) => !hiddenStartNodeIds.has(item.id));
  pathStartId = firstStart?.id || null;
  selectedNodeId = pathStartId;
  applyPathTextScale();
  cloudApplyingState = false;
  render();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setPathTextScale(value) {
  pathTextScale = clamp(Number(value) || 1, 0.86, 1.28);
  localStorage.setItem(PATH_TEXT_SCALE_KEY, String(pathTextScale));
  scheduleCloudSync();
  applyPathTextScale();
  renderPathView();
}

function applyPathTextScale() {
  document.documentElement.style.setProperty("--path-node-font-size", `${Math.round(16 * pathTextScale)}px`);
  document.documentElement.style.setProperty("--path-edge-label-font-size", `${Math.round(13 * pathTextScale)}px`);
}

function backupPayload(reason = "manual") {
  return {
    app: "Brain Map",
    version: 1,
    reason,
    exportedAt: new Date().toISOString(),
    state: clone(state),
    hiddenStartNodeIds: [...hiddenStartNodeIds],
    pathTextScale,
    savedPositions: clone(savedPositions)
  };
}

function exportDataBackup() {
  const payload = backupPayload("manual-export");
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = payload.exportedAt.replace(/[:.]/g, "-");
  link.href = url;
  link.download = `brain-map-backup-${stamp}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function importDataBackup(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const payload = JSON.parse(String(reader.result || "{}"));
      if (!payload.state?.nodes || !payload.state?.episodes) throw new Error("invalid");
      saveBackupSnapshot("before-import");
      state = hydratePlannedEdges(payload.state);
      hiddenStartNodeIds = new Set(payload.hiddenStartNodeIds || []);
      pathTextScale = Number(payload.pathTextScale || pathTextScale);
      savedPositions = payload.savedPositions || {};
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      localStorage.setItem(`${STORAGE_KEY}-hidden-starts`, JSON.stringify([...hiddenStartNodeIds]));
      localStorage.setItem(PATH_TEXT_SCALE_KEY, String(pathTextScale));
      localStorage.setItem(POSITION_KEY, JSON.stringify(savedPositions));
      selectedHistoryEpisodeIds = new Set();
      const firstStart = startOptions().find((item) => !hiddenStartNodeIds.has(item.id));
      pathStartId = firstStart?.id || null;
      selectedNodeId = pathStartId;
      applyPathTextScale();
      render();
      scheduleCloudSync();
    } catch {
      window.alert("这个备份文件不能读取。");
    }
  });
  reader.readAsText(file);
}

function saveBackupSnapshot(reason) {
  const snapshots = JSON.parse(localStorage.getItem(BACKUP_SNAPSHOT_KEY) || "[]");
  snapshots.unshift(backupPayload(reason));
  localStorage.setItem(BACKUP_SNAPSHOT_KEY, JSON.stringify(snapshots.slice(0, 5)));
}

function restoreLatestSnapshot() {
  const snapshots = JSON.parse(localStorage.getItem(BACKUP_SNAPSHOT_KEY) || "[]");
  const latest = snapshots[0];
  if (!latest) {
    window.alert("还没有删除前快照。");
    return;
  }
  state = hydratePlannedEdges(latest.state);
  hiddenStartNodeIds = new Set(latest.hiddenStartNodeIds || []);
  pathTextScale = Number(latest.pathTextScale || pathTextScale);
  savedPositions = latest.savedPositions || {};
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  localStorage.setItem(`${STORAGE_KEY}-hidden-starts`, JSON.stringify([...hiddenStartNodeIds]));
  localStorage.setItem(PATH_TEXT_SCALE_KEY, String(pathTextScale));
  localStorage.setItem(POSITION_KEY, JSON.stringify(savedPositions));
  selectedHistoryEpisodeIds = new Set();
  const firstStart = startOptions().find((item) => !hiddenStartNodeIds.has(item.id));
  pathStartId = firstStart?.id || null;
  selectedNodeId = pathStartId;
  applyPathTextScale();
  render();
  scheduleCloudSync();
}

function pathOptionKey(fromNodeId, toNodeId) {
  return `${fromNodeId}->${toNodeId}`;
}

function isHiddenPathOption(fromNodeId, toNodeId) {
  return (state.hiddenPathOptions || []).includes(pathOptionKey(fromNodeId, toNodeId));
}

function hydratePlannedEdges(sourceState) {
  let changed = false;
  sourceState.plannedEdges = (sourceState.plannedEdges || []).map((edge) => {
    const hydrated = {
      firstWalkedEpisodeId: null,
      firstWalkedAt: null,
      ...edge
    };
    if (hydrated.status === "active") {
      const firstEpisode = firstEpisodeWalkingEdge(sourceState, hydrated.fromNodeId, hydrated.toNodeId);
      if (firstEpisode) {
        hydrated.status = "converted";
        hydrated.firstWalkedEpisodeId = firstEpisode.id;
        hydrated.firstWalkedAt = firstEpisode.completedAt || firstEpisode.startedAt;
        changed = true;
      }
    }
    return hydrated;
  });
  if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(sourceState));
  return sourceState;
}

function firstEpisodeWalkingEdge(sourceState, fromNodeId, toNodeId) {
  return sourceState.episodes
    .filter((ep) => ep.status === "completed")
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
    .find((ep) => {
      const ids = orderedIds(ep);
      for (let i = 0; i < ids.length - 1; i += 1) {
        if (ids[i] === fromNodeId && ids[i + 1] === toNodeId) return true;
      }
      return false;
    });
}

function loadPositions() {
  try {
    return JSON.parse(localStorage.getItem(POSITION_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePositions() {
  localStorage.setItem(POSITION_KEY, JSON.stringify(savedPositions));
  scheduleCloudSync();
}

function filteredEpisodes() {
  if (els.range.value === "all") return state.episodes.filter((e) => e.status === "completed");
  const days = Number(els.range.value);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return state.episodes.filter((e) => e.status === "completed" && new Date(e.startedAt).getTime() >= since);
}

function previousWindowEpisodes() {
  if (els.range.value === "all") return [];
  const days = Number(els.range.value);
  const now = Date.now();
  const currentStart = now - days * 24 * 60 * 60 * 1000;
  const previousStart = now - days * 2 * 24 * 60 * 60 * 1000;
  return state.episodes.filter((e) => {
    const t = new Date(e.startedAt).getTime();
    return e.status === "completed" && t >= previousStart && t < currentStart;
  });
}

function orderedIds(ep) {
  return [...ep.steps].sort((a, b) => a.order - b.order).map((s) => s.nodeId);
}

function orderedLabelsWithPauses(ep) {
  const ids = orderedIds(ep);
  const pauseIndexes = new Set((ep.pauseMarkers || []).map((marker) => marker.afterStepIndex));
  const parts = [];
  ids.forEach((id, index) => {
    parts.push(getNode(id)?.label || "未知");
    if (pauseIndexes.has(index)) parts.push("⏸");
  });
  return parts.join(" -> ");
}

function buildGraph(sourceState, episodes = filteredEpisodes()) {
  const nodes = new Map(sourceState.nodes.map((n) => [n.id, { ...n, count: 0 }]));
  const edges = new Map();
  episodes.forEach((ep) => {
    const ids = orderedIds(ep);
    ids.forEach((id) => {
      const n = nodes.get(id);
      if (n) {
        n.count += 1;
        n.lastSeenAt = ep.startedAt;
      }
    });
    for (let i = 0; i < ids.length - 1; i += 1) {
      const key = `${ids[i]}->${ids[i + 1]}`;
      const edge = edges.get(key) || { id: key, fromNodeId: ids[i], toNodeId: ids[i + 1], count: 0 };
      edge.count += 1;
      edge.lastSeenAt = ep.startedAt;
      edges.set(key, edge);
    }
  });
  return {
    nodes: Array.from(nodes.values()).filter((n) => n.count > 0),
    edges: Array.from(edges.values())
  };
}

function render() {
  graph = buildGraph(state);
  renderPathStartOptions();
  renderPathView();
  renderPathDraftBar();
  renderInsightsPlaceholder();
  renderHistory();
  renderOther();
  renderRecorder();
}

function graphForCurrentMode() {
  if (!focusMode || !selectedNodeId) return graph;
  const ids = new Set([selectedNodeId]);
  graph.edges.forEach((edge) => {
    if (edge.fromNodeId === selectedNodeId) ids.add(edge.toNodeId);
    if (edge.toNodeId === selectedNodeId) ids.add(edge.fromNodeId);
  });
  return {
    nodes: graph.nodes.filter((n) => ids.has(n.id)),
    edges: graph.edges.filter((e) => ids.has(e.fromNodeId) && ids.has(e.toNodeId))
  };
}

function renderPathStartOptions() {
  const allStarts = startOptions();
  const starts = allStarts.filter((item) => !hiddenStartNodeIds.has(item.id));
  const activeStart = activeRecordingStartOption();
  const canKeepActiveStart = Boolean(activeStart);
  if (canKeepActiveStart && pathStartId !== activeStart.id) pathStartId = activeStart.id;
  if (!canKeepActiveStart && !starts.find((item) => item.id === pathStartId)) pathStartId = starts[0]?.id || null;
  const current = starts.find((item) => item.id === pathStartId)
    || (canKeepActiveStart && activeStart.id === pathStartId ? activeStart : null)
    || looseStartOption(pathStartId);
  els.startPickerButton.textContent = current ? startLabel(current, false, false) : "选择起点";
  els.pathRecordButton.disabled = !current;
  const q = normalize(els.startSearchInput.value || "");
  const pickerStarts = canKeepActiveStart && !starts.some((item) => item.id === activeStart.id)
    ? [activeStart, ...starts]
    : starts;
  const filtered = q
    ? startSearchOptions(q, pickerStarts, allStarts)
    : pickerStarts;
  const recent = recentStartOptions()
    .filter((item) => !hiddenStartNodeIds.has(item.id))
    .filter((item) => !q || normalize(item.label).includes(q))
    .slice(0, 5);
  els.recentStarts.innerHTML = recent.map((item) => startButton(item, "start-chip")).join("")
    || "<p class='muted start-empty'>没有可选起点。</p>";
  const createFromSearch = startSearchCreateOption(q, filtered);
  els.startOptionsList.innerHTML = [
    ...filtered.map((item) => startButton(item, "start-option")),
    createFromSearch
  ].join("")
    || "<p class='muted start-empty'>没有匹配起点。</p>";
  [...els.recentStarts.querySelectorAll("[data-start-id]"), ...els.startOptionsList.querySelectorAll("[data-start-id]")].forEach((button) => {
    button.addEventListener("click", () => choosePathStart(button.dataset.startId));
  });
  els.startOptionsList.querySelectorAll("[data-create-start]").forEach((button) => {
    button.addEventListener("click", () => chooseOrCreateStartFromSearch(button.dataset.createStart));
  });
  [...els.recentStarts.querySelectorAll("[data-hide-start]"), ...els.startOptionsList.querySelectorAll("[data-hide-start]")].forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      hideStartOption(button.dataset.hideStart);
    });
  });
}

function startButton(item, className) {
  return `
    <span class="start-option-row ${className}">
      <button type="button" class="start-option-main" data-start-id="${item.id}">${escapeHtml(startLabel(item, false))}</button>
      <button type="button" class="start-option-delete" data-hide-start="${item.id}" aria-label="删除 ${escapeHtml(item.label)}">×</button>
    </span>
  `;
}

function startLabel(item, withArrow = true, showCount = true) {
  const suffix = item.isDraft ? "正在记" : `${item.count} 次`;
  return showCount ? `${item.label} · ${suffix}${withArrow ? "⌄" : ""}` : `${item.label}${withArrow ? "⌄" : ""}`;
}

function looseStartOption(id) {
  if (!id || hiddenStartNodeIds.has(id)) return null;
  const n = state.nodes.find((item) => item.id === id);
  return n ? { id: n.id, label: n.label, count: 0 } : null;
}

function startSearchOptions(query, visibleStarts, allStarts) {
  const byId = new Map(allStarts.map((item) => [item.id, item]));
  const results = [];
  visibleStarts
    .filter((item) => normalize(item.label).includes(query))
    .forEach((item) => results.push(item));
  state.nodes
    .filter((n) => n.normalizedLabel.includes(query) || query.includes(n.normalizedLabel))
    .forEach((n) => {
      if (results.some((item) => item.id === n.id)) return;
      const counted = byId.get(n.id);
      results.push(counted || { id: n.id, label: n.label, count: 0 });
    });
  return results.slice(0, 8);
}

function startSearchCreateOption(query, results) {
  const label = els.startSearchInput.value.trim();
  if (!query || !label) return "";
  const exact = results.some((item) => normalize(item.label) === query);
  if (exact) return "";
  return `
    <span class="start-option-row start-option">
      <button type="button" class="start-option-main" data-create-start="${escapeHtml(label)}">用「${escapeHtml(label)}」作为起点</button>
    </span>
  `;
}

function chooseOrCreateStartFromSearch(label) {
  const normalized = normalize(label);
  if (!normalized) return;
  let existing = state.nodes.find((n) => n.normalizedLabel === normalized);
  if (!existing) {
    existing = node(uid(), label.trim());
    state.nodes.push(existing);
    saveState();
  }
  choosePathStart(existing.id);
}

function activeRecordingStartOption() {
  if (!isRecordingActive() || !recording.length) return null;
  const id = recording[0];
  const observed = startOptions().find((item) => item.id === id);
  return observed || { id, label: getNode(id)?.label || "未知", count: 0, isDraft: true };
}

function hideStartOption(nodeId) {
  saveBackupSnapshot("before-hide-start");
  hiddenStartNodeIds.add(nodeId);
  localStorage.setItem(`${STORAGE_KEY}-hidden-starts`, JSON.stringify([...hiddenStartNodeIds]));
  scheduleCloudSync();
  if (pathStartId === nodeId) {
    pathStartId = null;
    selectedNodeId = null;
    expandedPathNodeIds = new Set();
    els.pathInsight.innerHTML = "";
    els.pathInsight.classList.add("hidden");
  }
  render();
  if (!els.recentStarts.querySelector("[data-start-id]") && !els.startOptionsList.querySelector("[data-start-id]")) closeStartPicker();
}

function restoreStartOption(nodeId) {
  hiddenStartNodeIds.delete(nodeId);
  localStorage.setItem(`${STORAGE_KEY}-hidden-starts`, JSON.stringify([...hiddenStartNodeIds]));
  scheduleCloudSync();
  render();
}

function choosePathStart(id) {
  hiddenStartNodeIds.delete(id);
  localStorage.setItem(`${STORAGE_KEY}-hidden-starts`, JSON.stringify([...hiddenStartNodeIds]));
  scheduleCloudSync();
  pathStartId = id;
  selectedNodeId = id;
  expandedPathNodeIds = new Set();
  closeStartPicker();
  render();
}

function closeStartPicker() {
  els.startPickerPanel.classList.add("hidden");
  els.startSearchInput.value = "";
}

function recentStartOptions() {
  const seen = new Set();
  const result = [];
  filteredEpisodes()
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .forEach((ep) => {
      const first = orderedIds(ep)[0];
      if (!first || seen.has(first)) return;
      seen.add(first);
      const count = startOptions().find((item) => item.id === first)?.count || 1;
      result.push({ id: first, label: getNode(first)?.label || "未知", count });
    });
  return result;
}

function buildPathTree(startId, maxDepth = 5) {
  const root = { id: startId, nodeId: startId, count: 0, depth: 0, children: new Map(), episodes: [] };
  filteredEpisodes().forEach((ep) => {
    const ids = orderedIds(ep);
    const startIndex = ids.indexOf(startId);
    if (startIndex < 0) return;
    const slice = ids.slice(startIndex, startIndex + maxDepth + 1);
    root.count += 1;
    root.episodes.push(ep);
    let current = root;
    for (let i = 1; i < slice.length; i += 1) {
      const id = slice[i];
      if (isHiddenPathOption(slice[i - 1], id)) break;
      if (!current.children.has(id)) {
        current.children.set(id, { id: `${current.id}/${id}/${i}`, nodeId: id, count: 0, depth: i, children: new Map(), episodes: [] });
      }
      current = current.children.get(id);
      markIntendedPath(current, slice[i - 1], id);
      markNewPath(current, slice[i - 1], id);
      current.count += 1;
      current.episodes.push(ep);
    }
  });
  attachPlannedEdges(root, maxDepth);
  return root;
}

function attachPlannedEdges(root, maxDepth) {
  const byNodeId = new Map();
  collectTreeNodes(root, byNodeId);
  state.plannedEdges
    .filter((edge) => edge.status === "active" && !isHiddenPathOption(edge.fromNodeId, edge.toNodeId))
    .forEach((edge) => {
      const parent = byNodeId.get(edge.fromNodeId);
      if (!parent || parent.depth >= maxDepth) return;
      if (!parent.children.has(edge.toNodeId)) {
        parent.children.set(edge.toNodeId, {
          id: `${parent.id}/${edge.toNodeId}/planned`,
          nodeId: edge.toNodeId,
          count: 0,
          depth: parent.depth + 1,
          children: new Map(),
          episodes: [],
          intendedStatus: "active"
        });
      } else {
        parent.children.get(edge.toNodeId).intendedStatus = "active";
      }
    });
}

function markIntendedPath(branch, fromNodeId, toNodeId) {
  const intended = state.plannedEdges.find((edge) => edge.status !== "archived" && edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId);
  if (intended) branch.intendedStatus = intended.status;
}

function markNewPath(branch, fromNodeId, toNodeId) {
  if ((state.newPathEdgeKeys || []).includes(pathOptionKey(fromNodeId, toNodeId))) branch.markedNew = true;
}

function isIntendedBranch(branch) {
  return branch.intendedStatus === "active" || branch.intendedStatus === "converted";
}

function collectTreeNodes(branch, byNodeId) {
  if (!byNodeId.has(branch.nodeId)) byNodeId.set(branch.nodeId, branch);
  branch.children.forEach((child) => collectTreeNodes(child, byNodeId));
}

function applyProgressiveExpansion(root) {
  let trunk = root;
  while (trunk) {
    trunk.autoExpanded = true;
    const children = sortedChildren(trunk);
    const main = children[0];
    trunk.visibleChildren = children.filter((child, index) => {
      if (index === 0) return true;
      if (expandedPathNodeIds.has(trunk.nodeId)) return true;
      if (recording.includes(child.nodeId)) return true;
      return child.depth <= 1;
    });
    trunk.hasHiddenChildren = children.length > trunk.visibleChildren.length;
    trunk.visibleChildren.forEach((child) => {
      if (child !== main && !expandedPathNodeIds.has(child.nodeId) && !recording.includes(child.nodeId)) {
        child.visibleChildren = [];
        child.hasHiddenChildren = child.children.size > 0;
      }
    });
    trunk = main;
  }
  markExpandedBranches(root);
}

function markExpandedBranches(branch) {
  const children = sortedChildren(branch);
  if (!branch.visibleChildren) branch.visibleChildren = [];
  if (expandedPathNodeIds.has(branch.nodeId) || recording.includes(branch.nodeId)) {
  branch.visibleChildren = children;
  }
  branch.hiddenChildren = children.filter((child) => !branch.visibleChildren.includes(child));
  branch.hasHiddenChildren = children.length > branch.visibleChildren.length;
  branch.visibleChildren.forEach(markExpandedBranches);
}

function sortedChildren(branch) {
  return Array.from(branch.children.values()).sort((a, b) => b.count - a.count);
}

function renderPathView() {
  if (!pathStartId) {
    els.pathMap.innerHTML = "";
    els.pathMap.setAttribute("viewBox", "0 0 1320 620");
    els.pathInsight.innerHTML = "";
    els.pathInsight.classList.add("hidden");
    return;
  }
  const root = buildPathTree(pathStartId);
  attachDraftToTree(root);
  applyProgressiveExpansion(root);
  const choicePoints = deriveChoicePoints();
  const svg = els.pathMap;
  svg.innerHTML = "";
  svg.setAttribute("viewBox", "0 0 1320 620");
  const nodes = [];
  const edges = [];
  const maxCount = Math.max(1, root.count);
  const rowHeight = 82;
  let cursor = 0;

  function measure(branch) {
    const visibleChildren = branch.visibleChildren || [];
    if (!visibleChildren.length) {
      branch.leaves = 1;
      return 1;
    }
    branch.leaves = visibleChildren.reduce((sum, child) => sum + measure(child), 0);
    return branch.leaves;
  }

  function place(branch, depth, parent) {
    const x = 92 + depth * 205;
    branch.parentNodeId = parent?.nodeId || null;
    branch.pathIds = parent ? [...parent.pathIds, branch.nodeId] : [branch.nodeId];
    const visibleChildren = branch.visibleChildren || [];
    if (!visibleChildren.length) {
      branch.y = 92 + cursor * rowHeight;
      cursor += 1;
    } else {
      visibleChildren.forEach((child) => place(child, depth + 1, branch));
      const ys = visibleChildren.map((child) => child.y);
      branch.y = ys.reduce((sum, y) => sum + y, 0) / ys.length;
    }
    branch.x = x;
    nodes.push(branch);
    if (parent) edges.push({ from: parent, to: branch, count: branch.count });
  }

  measure(root);
  place(root, 0, null);
  const height = Math.max(620, 160 + cursor * rowHeight);
  svg.setAttribute("viewBox", `0 0 1320 ${height}`);

  edges.forEach((edge) => {
    const parentTotal = Math.max(1, edge.from.count);
    const pct = edge.count ? Math.round((edge.count / parentTotal) * 100) : 0;
    const strokeWidth = 1.5 + (edge.count / maxCount) * 13;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", pathEdgeClass(edge.from.nodeId, edge.to.nodeId, edge.count / maxCount < 0.28, edge.to.intendedStatus, edge.to.draftFresh || edge.to.markedNew));
    path.setAttribute("d", pathCurve(edge.from, edge.to));
    path.setAttribute("stroke-width", edge.to.intendedStatus === "active" && edge.count === 0 ? 2.2 : strokeWidth);
    svg.appendChild(path);

    const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hitPath.setAttribute("class", "path-edge-hit");
    hitPath.setAttribute("d", pathCurve(edge.from, edge.to));
    hitPath.setAttribute("stroke-width", 24);
    hitPath.setAttribute("tabindex", "0");
    hitPath.setAttribute("role", "button");
    hitPath.setAttribute("aria-label", `${getNode(edge.from.nodeId)?.label || "未知"} 到 ${getNode(edge.to.nodeId)?.label || "未知"}，${edge.count} 次，占 ${pct}%`);
    hitPath.addEventListener("click", () => renderEdgeInsight(edge, pct));
    hitPath.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      renderEdgeInsight(edge, pct);
    });
    svg.appendChild(hitPath);

    const choicePoint = choicePoints.get(choicePointKey(edge.from.nodeId, edge.to.nodeId));
    if (choicePoint) renderChoicePointMarker(svg, edge, choicePoint);

    const edgeLabel = pathEdgeLabel(edge, pct);
    if (!edgeLabel) return;
    const labelPosition = pathEdgeLabelPosition(edge.from, edge.to);
    const labelHit = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    labelHit.setAttribute("class", "path-edge-label-hit");
    labelHit.setAttribute("x", labelPosition.x - 38);
    labelHit.setAttribute("y", labelPosition.y - 19);
    labelHit.setAttribute("width", 76);
    labelHit.setAttribute("height", 30);
    labelHit.setAttribute("rx", 8);
    labelHit.setAttribute("tabindex", "0");
    labelHit.setAttribute("role", "button");
    labelHit.setAttribute("aria-label", `${getNode(edge.from.nodeId)?.label || "未知"} 到 ${getNode(edge.to.nodeId)?.label || "未知"}，${edge.count} 次，占 ${pct}%`);
    labelHit.addEventListener("click", () => renderEdgeInsight(edge, pct));
    labelHit.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      renderEdgeInsight(edge, pct);
    });
    svg.appendChild(labelHit);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("class", pathEdgeLabelClass(edge.from.nodeId, edge.to.nodeId, edge.to.draftFresh || edge.to.markedNew || edge.to.intendedStatus));
    label.setAttribute("x", labelPosition.x);
    label.setAttribute("y", labelPosition.y);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("tabindex", "0");
    label.setAttribute("role", "button");
    label.setAttribute("aria-label", `${getNode(edge.from.nodeId)?.label || "未知"} 到 ${getNode(edge.to.nodeId)?.label || "未知"}，${edge.count} 次，占 ${pct}%`);
    label.addEventListener("click", () => renderEdgeInsight(edge, pct));
    label.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      renderEdgeInsight(edge, pct);
    });
    label.textContent = edgeLabel;
    svg.appendChild(label);
  });

  renderPauseMarkers(svg, nodes);

  nodes.forEach((branch) => {
    const nodeInfo = getNode(branch.nodeId);
    const label = nodeInfo?.label || "未知";
    const width = pathNodeDesiredWidth(label);
    const heightBox = pathNodeHeight(branch);
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", pathNodeClass(branch.nodeId, isIntendedBranch(branch), branch.draftFresh || branch.markedNew));
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute("aria-label", `${label}，双击编辑`);
    group.addEventListener("click", (event) => {
      handlePathNodeClick(branch.nodeId);
    });
    group.addEventListener("contextmenu", (event) => {
      if (!recordingFromPath || !shouldShowPathNodeDelete(branch)) return;
      event.preventDefault();
      event.stopPropagation();
      openPathContextMenu(event, branch.parentNodeId, branch.nodeId);
    });
    group.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      openEditNodeDialog(branch.nodeId);
    });
    group.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      openEditNodeDialog(branch.nodeId);
    });
    group.dataset.nodeId = branch.nodeId;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", branch.x - width / 2);
    rect.setAttribute("y", branch.y - heightBox / 2);
    rect.setAttribute("width", width);
    rect.setAttribute("height", heightBox);
    rect.setAttribute("rx", 8);
    group.appendChild(rect);

    const hit = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    hit.setAttribute("x", branch.x - width / 2 - 10);
    hit.setAttribute("y", branch.y - heightBox / 2 - 10);
    hit.setAttribute("width", width + 20);
    hit.setAttribute("height", heightBox + 20);
    hit.setAttribute("rx", 10);
    hit.setAttribute("fill", "transparent");
    group.appendChild(hit);

    const showStartAction = !recordingFromPath && branch.nodeId === selectedNodeId;
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", branch.x);
    text.setAttribute("y", branch.y);
    text.textContent = branch.hasHiddenChildren ? `${label} ›` : label;
    group.appendChild(text);

    if (showStartAction) {
      renderStartHereButton(group, branch, width, heightBox);
    }
    if (shouldShowPathNodeDelete(branch)) {
      renderNodeMenuButton(group, branch, width, heightBox);
    }
    svg.appendChild(group);
  });

  renderPathInsight(root);
}

function pathNodeDesiredWidth(label) {
  const textUnits = [...label].reduce((sum, char) => sum + (/[\u4e00-\u9fff]/.test(char) ? 0.98 : 0.52), 0);
  const textWidth = textUnits * 16 * pathTextScale;
  return Math.round(Math.max(42, Math.min(152, textWidth + 8 * pathTextScale)));
}

function pathNodeHeight(branch) {
  return Math.round((branch.depth === 0 ? 38 : 34) * pathTextScale);
}

function shouldShowPathNodeDelete(branch) {
  if (!branch.parentNodeId) return false;
  if (recordingFromPath && branch.nodeId === recording[0]) return false;
  return true;
}

function renderStartHereButton(group, branch, width, heightBox) {
  const x = branch.x + width / 2 + 10;
  const y = branch.y;
  const action = document.createElementNS("http://www.w3.org/2000/svg", "g");
  action.setAttribute("class", "path-node-action");
  action.setAttribute("tabindex", "0");
  action.setAttribute("role", "button");
  action.setAttribute("aria-label", "从这里记录");
  action.addEventListener("click", (event) => {
    event.stopPropagation();
    continuePathRecording(branch.pathIds);
  });
  action.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    continuePathRecording(branch.pathIds);
  });

  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = "从这里记录";
  action.appendChild(title);

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", x);
  circle.setAttribute("cy", y);
  circle.setAttribute("r", 10);
  action.appendChild(circle);

  const horizontal = document.createElementNS("http://www.w3.org/2000/svg", "line");
  horizontal.setAttribute("x1", x - 4.5);
  horizontal.setAttribute("y1", y);
  horizontal.setAttribute("x2", x + 4.5);
  horizontal.setAttribute("y2", y);
  action.appendChild(horizontal);

  const vertical = document.createElementNS("http://www.w3.org/2000/svg", "line");
  vertical.setAttribute("x1", x);
  vertical.setAttribute("y1", y - 4.5);
  vertical.setAttribute("x2", x);
  vertical.setAttribute("y2", y + 4.5);
  action.appendChild(vertical);
  group.appendChild(action);
}

function renderNodeMenuButton(group, branch, width, heightBox) {
  const x = branch.x + width / 2 + 10;
  const y = branch.y + heightBox / 2 + 5;
  const action = document.createElementNS("http://www.w3.org/2000/svg", "g");
  action.setAttribute("class", "path-node-menu");
  action.setAttribute("tabindex", "0");
  action.setAttribute("role", "button");
  action.setAttribute("aria-label", "更多操作");
  action.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openPathContextMenu(event, branch.parentNodeId, branch.nodeId);
  });
  action.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    openPathContextMenu(event, branch.parentNodeId, branch.nodeId);
  });

  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = "更多操作";
  action.appendChild(title);

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", x);
  circle.setAttribute("cy", y);
  circle.setAttribute("r", 9);
  action.appendChild(circle);

  const dots = document.createElementNS("http://www.w3.org/2000/svg", "text");
  dots.setAttribute("x", x);
  dots.setAttribute("y", y - 1.5);
  dots.textContent = "⋯";
  action.appendChild(dots);
  group.appendChild(action);
}

function openPathContextMenu(event, fromNodeId, toNodeId) {
  if (!fromNodeId || !toNodeId) return;
  pendingDeletePathOption = { fromNodeId, toNodeId };
  const viewRect = els.pathView.getBoundingClientRect();
  const left = clamp(event.clientX - viewRect.left, 8, viewRect.width - 96);
  const top = clamp(event.clientY - viewRect.top, 8, viewRect.height - 52);
  els.pathContextMenu.style.left = `${Math.round(left)}px`;
  els.pathContextMenu.style.top = `${Math.round(top)}px`;
  els.pathContextMenu.classList.remove("hidden");
}

function hidePathContextMenu() {
  els.pathContextMenu.classList.add("hidden");
}

function openDeletePathConfirm(fromNodeId, toNodeId, label) {
  if (!fromNodeId || !toNodeId) return;
  pendingDeletePathOption = { fromNodeId, toNodeId };
  els.deleteConfirmText.textContent = `确定要删除「${label}」这个选项吗？删除后会从当前路径里隐藏。`;
  els.deleteConfirmDialog.showModal();
}

function deletePathOption(fromNodeId, toNodeId) {
  clearPauseTimer();
  els.pauseCard.classList.add("hidden");
  saveBackupSnapshot("before-delete-path-option");
  const key = pathOptionKey(fromNodeId, toNodeId);
  if (!state.hiddenPathOptions) state.hiddenPathOptions = [];
  if (!state.hiddenPathOptions.includes(key)) state.hiddenPathOptions.push(key);
  state.plannedEdges = state.plannedEdges.map((edge) => (
    edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId
      ? { ...edge, status: "archived" }
      : edge
  ));
  if (recordingFromPath) {
    const deleteIndex = recording.findIndex((id, index) => index > 0 && recording[index - 1] === fromNodeId && id === toNodeId);
    if (deleteIndex >= 0) {
      recording = recording.slice(0, deleteIndex);
      recordingPauses = recordingPauses.filter((marker) => marker.afterStepIndex < recording.length);
    }
  }
  saveState();
  render();
}

function deriveChoicePoints() {
  const points = new Map();
  filteredEpisodes().forEach((ep) => {
    const ids = orderedIds(ep);
    (ep.pauseMarkers || []).forEach((marker) => {
      const fromNodeId = ids[marker.afterStepIndex];
      const toNodeId = ids[marker.afterStepIndex + 1] || null;
      if (!fromNodeId) return;
      const key = choicePointKey(fromNodeId, toNodeId);
      const point = points.get(key) || {
        key,
        fromNodeId,
        toNodeId,
        pauseCount: 0,
        episodeIds: [],
        nextSteps: new Map()
      };
      point.pauseCount += 1;
      point.episodeIds.push(ep.id);
      if (toNodeId) point.nextSteps.set(toNodeId, (point.nextSteps.get(toNodeId) || 0) + 1);
      points.set(key, point);
    });
  });
  return points;
}

function choicePointKey(fromNodeId, toNodeId) {
  return `${fromNodeId}->${toNodeId || "__end__"}`;
}

function renderChoicePointMarker(svg, edge, choicePoint) {
  const x = (edge.from.x + edge.to.x) / 2;
  const y = (edge.from.y + edge.to.y) / 2 + 20;
  const radius = Math.min(15, 8 + choicePoint.pauseCount * 1.5);
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", "choice-point");
  group.setAttribute("tabindex", "0");
  group.setAttribute("role", "button");
  group.setAttribute("aria-label", `这里有 ${choicePoint.pauseCount} 次暂停`);
  group.addEventListener("click", (event) => {
    event.stopPropagation();
    renderChoicePointDetail(choicePoint);
  });
  group.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    renderChoicePointDetail(choicePoint);
  });

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", x);
  circle.setAttribute("cy", y);
  circle.setAttribute("r", radius);
  group.appendChild(circle);

  const dot = document.createElementNS("http://www.w3.org/2000/svg", "text");
  dot.setAttribute("x", x);
  dot.setAttribute("y", y - 1);
  dot.textContent = "●";
  group.appendChild(dot);

  const pause = document.createElementNS("http://www.w3.org/2000/svg", "text");
  pause.setAttribute("class", "choice-pause");
  pause.setAttribute("x", x);
  pause.setAttribute("y", y + 17);
  pause.textContent = "⏸";
  group.appendChild(pause);

  svg.appendChild(group);
}

function renderChoicePointDetail(choicePoint) {
  const fromLabel = getNode(choicePoint.fromNodeId)?.label || "这里";
  const toLabel = choicePoint.toNodeId ? getNode(choicePoint.toNodeId)?.label || "下一步" : "路径末尾";
  const nextRows = Array.from(choicePoint.nextSteps.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([nodeId, count]) => `<div class="choice-next-row">→ ${escapeHtml(getNode(nodeId)?.label || "未知")} · ${count} 次</div>`)
    .join("");
  els.pathInsight.classList.remove("hidden");
  els.pathInsight.innerHTML = `
    <h2>${escapeHtml(fromLabel)} → ${escapeHtml(toLabel)}</h2>
    <p class="muted">这里有 ${choicePoint.pauseCount} 次，你没有立刻跟着反应走。</p>
    <div class="detail-grid">
      <div class="detail-box">
        <h3>曾经发生</h3>
        <p class="muted">停 · ${choicePoint.pauseCount} 次</p>
      </div>
      <div class="detail-box">
        <h3>暂停之后</h3>
        ${nextRows || "<p class='muted'>这次暂停发生在路径最后一步之后。</p>"}
      </div>
    </div>
  `;
}

function pathEdgeLabel(edge, pct) {
  if (edge.to.draftFresh) return "0 次 · 🌱";
  if (edge.to.draft && edge.count === 0) return "0 次";
  if (edge.to.intendedStatus === "active" && edge.to.count === 0) return "0 次 · 🌱";
  if (edge.to.markedNew) return `${edge.count} 次 · 🌱`;
  if (edge.to.intendedStatus === "converted") return `${edge.to.count} 次 · 🌱`;
  if (edge.count <= 1 && pct === 100) return "";
  return `${edge.count} 次`;
}

function pathNodeCountLabel(branch) {
  if (branch.intendedStatus === "active" && branch.count === 0) return "0 次 · 🌱";
  if (branch.markedNew) return `${branch.count} 次 · 🌱`;
  if (branch.intendedStatus === "converted") return `${branch.count} 次 · 🌱`;
  return `${branch.count} 次`;
}

function renderPauseMarkers(svg, nodes) {
  if (!recordingFromPath || !recordingPauses.length) return;
  const byNodeId = new Map(nodes.map((branch) => [branch.nodeId, branch]));
  recordingPauses.forEach((marker) => {
    const fromId = recording[marker.afterStepIndex];
    const toId = recording[marker.afterStepIndex + 1];
    const from = byNodeId.get(fromId);
    const to = byNodeId.get(toId);
    const x = from && to ? (from.x + to.x) / 2 : (from?.x || 120) + 96;
    const y = from && to ? (from.y + to.y) / 2 + 24 : from?.y || 100;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", "pause-marker");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", x);
    circle.setAttribute("cy", y);
    circle.setAttribute("r", 15);
    group.appendChild(circle);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", x);
    text.setAttribute("y", y + 1);
    text.textContent = "⏸";
    group.appendChild(text);
    svg.appendChild(group);
  });
}

function pathCurve(from, to) {
  const mid = (to.x - from.x) * 0.52;
  return `M${from.x + 48} ${from.y} C${from.x + mid} ${from.y} ${to.x - mid} ${to.y} ${to.x - 48} ${to.y}`;
}

function pathEdgeLabelPosition(from, to) {
  return {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2 - 12
  };
}

function renderPathInsight(root) {
  els.pathInsight.innerHTML = "";
  els.pathInsight.classList.add("hidden");
}

function renderEdgeInsight(edge, pct) {
  const from = getNode(edge.from.nodeId)?.label || "未知";
  const to = getNode(edge.to.nodeId)?.label || "未知";
  const total = Math.max(1, edge.from.count);
  els.pathInsight.classList.remove("hidden");
  els.pathInsight.innerHTML = `
    <section class="edge-insight">
      <h2>${escapeHtml(from)} -> ${escapeHtml(to)}</h2>
      <p>${edge.count} 次 · ${pct}%</p>
    </section>
  `;
}

function renderInsightsPlaceholder() {
  const grid = document.getElementById("changeGrid");
  if (!grid) return;
  try {
    renderChangeRangeTabs();
    const payload = buildInsightPayload(changeRange);
    const insights = mockAiInsightProvider(payload).slice(0, 3);
    grid.innerHTML = `
      <div class="ai-change-page">
        <section class="ai-change-summary">
          <h3>${escapeHtml(aiSummaryLine(payload, insights))}</h3>
          <p>基于${payload.label} ${payload.episodes.length} 次真实记录</p>
        </section>
        ${insights.length ? insights.map((insight, index) => renderAiInsightCard(insight, index)).join("") : `
          <section class="ai-empty-state">今天还没有明显需要特别留意的事情。</section>
        `}
      </div>
    `;
    grid.querySelectorAll("[data-toggle-evidence]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.toggleEvidence;
        if (expandedChangeInsightIds.has(id)) expandedChangeInsightIds.delete(id);
        else expandedChangeInsightIds.add(id);
        renderInsightsPlaceholder();
      });
    });
  } catch (error) {
    grid.innerHTML = `
      <section class="change-card wide">
        <h2>变化</h2>
        <p class="muted">变化页暂时没有渲染出来：${escapeHtml(error.message || error)}</p>
      </section>
    `;
    console.error(error);
  }
}

function renderChangeRangeTabs() {
  els.changeRangeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.changeRange === changeRange);
  });
}

function aiSummaryLine(payload, insights) {
  if (!payload.episodes.length) return `AI ${payload.label}还没有足够记录可读`;
  if (!insights.length) return `AI ${payload.label}还没有看见特别需要留意的事`;
  return `AI ${payload.label}看见了 ${insights.length} 件值得留意的事`;
}

function renderAiInsightCard(insight, index) {
  const isOpen = expandedChangeInsightIds.has(insight.id);
  return `
    <section class="ai-insight-card">
      <div class="ai-insight-kicker">✦ ${String(index + 1).padStart(2, "0")} · AI Insight</div>
      <h3>${escapeHtml(insight.title)}</h3>
      <p>${escapeHtml(insight.body)}</p>
      <button class="evidence-toggle" type="button" data-toggle-evidence="${escapeHtml(insight.id)}">
        ${isOpen ? "收起证据" : "查看证据"} →
      </button>
      ${isOpen ? renderInsightEvidence(insight.evidenceEpisodeIds) : ""}
    </section>
  `;
}

function renderInsightEvidence(episodeIds) {
  const episodes = episodeIds
    .map((id) => state.episodes.find((ep) => ep.id === id))
    .filter(Boolean)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 4);
  if (!episodes.length) return "";
  return `
    <div class="ai-evidence">
      <div class="ai-evidence-title">证据</div>
      ${episodes.map((ep) => `
        <div class="ai-evidence-row">${formatTime(ep.startedAt)}　${escapeHtml(orderedLabelsWithPauses(ep))}</div>
      `).join("")}
    </div>
  `;
}

function buildInsightPayload(range = "today") {
  const { label, episodes, previousEpisodes } = changeRangeEpisodeSets(range);
  return {
    label,
    range,
    episodes,
    previousEpisodes,
    nodeFacts: nodeFactsForEpisodes(episodes),
    edgeFacts: edgeFactsForEpisodes(episodes, previousEpisodes),
    pauseFacts: pauseFactsForEpisodes(episodes)
  };
}

function changeRangeEpisodeSets(range) {
  if (range === "today") {
    return {
      label: "今天",
      episodes: episodesOnLocalDay(0),
      previousEpisodes: episodesOnLocalDay(-1)
    };
  }
  const days = range === "7" ? 7 : 30;
  return {
    label: `最近 ${days} 天`,
    episodes: episodesInRollingWindow(days, 0),
    previousEpisodes: episodesInRollingWindow(days, 1)
  };
}

function localDayBounds(offsetDays = 0) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function episodesOnLocalDay(offsetDays = 0) {
  const { start, end } = localDayBounds(offsetDays);
  return state.episodes.filter((ep) => {
    const t = new Date(ep.startedAt).getTime();
    return ep.status === "completed" && t >= start && t < end;
  });
}

function episodesInRollingWindow(days, previousOffset = 0) {
  const end = Date.now() - previousOffset * days * 24 * 60 * 60 * 1000;
  const start = end - days * 24 * 60 * 60 * 1000;
  return state.episodes.filter((ep) => {
    const t = new Date(ep.startedAt).getTime();
    return ep.status === "completed" && t >= start && t < end;
  });
}

function nodeFactsForEpisodes(episodes) {
  const facts = new Map();
  episodes.forEach((ep) => {
    orderedIds(ep).forEach((id, index) => {
      const fact = facts.get(id) || {
        id,
        label: getNode(id)?.label || "未知",
        count: 0,
        episodeIds: new Set(),
        positions: []
      };
      fact.count += 1;
      fact.episodeIds.add(ep.id);
      fact.positions.push(index);
      facts.set(id, fact);
    });
  });
  return Array.from(facts.values())
    .map((fact) => ({ ...fact, episodeIds: [...fact.episodeIds] }))
    .sort((a, b) => b.count - a.count);
}

function edgeFactsForEpisodes(episodes, previousEpisodes) {
  const current = edgeCountsFor(episodes);
  const previous = edgeCountsFor(previousEpisodes);
  const episodeIdsByEdge = new Map();
  episodes.forEach((ep) => {
    const ids = orderedIds(ep);
    for (let i = 0; i < ids.length - 1; i += 1) {
      const key = `${ids[i]}->${ids[i + 1]}`;
      const idsForEdge = episodeIdsByEdge.get(key) || new Set();
      idsForEdge.add(ep.id);
      episodeIdsByEdge.set(key, idsForEdge);
    }
  });
  return Array.from(current.entries())
    .map(([key, count]) => ({
      key,
      count,
      before: previous.get(key) || 0,
      episodeIds: [...(episodeIdsByEdge.get(key) || [])]
    }))
    .sort((a, b) => (b.count - b.before) - (a.count - a.before));
}

function pauseFactsForEpisodes(episodes) {
  const facts = [];
  episodes.forEach((ep) => {
    const ids = orderedIds(ep);
    (ep.pauseMarkers || []).forEach((marker) => {
      const afterNodeId = ids[marker.afterStepIndex];
      facts.push({
        episodeId: ep.id,
        afterNodeId,
        afterLabel: getNode(afterNodeId)?.label || "这一步",
        afterStepIndex: marker.afterStepIndex
      });
    });
  });
  return facts;
}

function mockAiInsightProvider(payload) {
  if (!payload.episodes.length) return [];
  const insights = [];
  const usedIds = new Set();
  const addInsight = (insight) => {
    if (!insight || usedIds.has(insight.id) || insights.length >= 3) return;
    usedIds.add(insight.id);
    insights.push(insight);
  };

  const bodyFact = payload.nodeFacts.find((fact) => fact.count >= 2 && looksLikeBodySignal(fact.label));
  addInsight(bodyFact && {
    id: `body-${bodyFact.id}`,
    title: "一个身体信号反复出现",
    body: `${payload.label}有 ${bodyFact.count} 次记录出现了「${bodyFact.label}」。这可能不是普通内容，而是一个值得继续观察的身体信号。`,
    evidenceEpisodeIds: bodyFact.episodeIds
  });

  const pauseFact = payload.pauseFacts[0];
  addInsight(pauseFact && {
    id: `pause-${pauseFact.episodeId}-${pauseFact.afterStepIndex}`,
    title: "这里出现了一次暂停",
    body: `${payload.label}有一次在「${pauseFact.afterLabel}」之后出现了暂停，然后才继续下一步。这是这段记录里一次不同的地方。`,
    evidenceEpisodeIds: [pauseFact.episodeId]
  });

  const changedEdge = payload.edgeFacts.find((edge) => edge.count >= 2 && edge.count > edge.before);
  addInsight(changedEdge && {
    id: `edge-${changedEdge.key}`,
    title: changedEdge.before ? "一条路变得更明显" : "一条路新出现",
    body: `${payload.label}里「${edgeKeyLabel(changedEdge.key)}」出现了 ${changedEdge.count} 次。它比上个时间段更明显，值得先被看见。`,
    evidenceEpisodeIds: changedEdge.episodeIds
  });

  const repeatedNode = payload.nodeFacts.find((fact) => fact.count >= 3 && !usedIds.has(`body-${fact.id}`));
  addInsight(repeatedNode && {
    id: `node-${repeatedNode.id}`,
    title: "一个节点反复出现",
    body: `${payload.label}里「${repeatedNode.label}」反复出现了 ${repeatedNode.count} 次。它可能是最近路径里一个稳定的中转点。`,
    evidenceEpisodeIds: repeatedNode.episodeIds
  });

  return insights;
}

function looksLikeBodySignal(label) {
  return /胸|喉|胃|心跳|肩|背|头|脸|紧|堵|火|热|麻|痛|缩|酸|胀/.test(label);
}

function edgeCountsFor(episodes, startId = null) {
  const counts = new Map();
  episodes.forEach((ep) => {
    const ids = orderedIds(ep);
    const startIndex = startId ? ids.indexOf(startId) : 0;
    if (startIndex < 0) return;
    for (let i = startIndex; i < ids.length - 1; i += 1) {
      if (isHiddenPathOption(ids[i], ids[i + 1])) continue;
      const key = `${ids[i]}->${ids[i + 1]}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  });
  return counts;
}

function growingPaths(startId = null) {
  const current = edgeCountsFor(filteredEpisodes(), startId);
  const previous = edgeCountsFor(previousWindowEpisodes(), startId);
  return Array.from(current.entries())
    .map(([key, now]) => ({ key, now, before: previous.get(key) || 0 }))
    .filter((item) => item.now > item.before)
    .sort((a, b) => (b.now - b.before) - (a.now - a.before));
}

function fadingPaths(startId = null) {
  const current = edgeCountsFor(filteredEpisodes(), startId);
  const previous = edgeCountsFor(previousWindowEpisodes(), startId);
  return Array.from(previous.entries())
    .map(([key, before]) => ({ key, now: current.get(key) || 0, before }))
    .filter((item) => item.before > item.now)
    .sort((a, b) => (b.before - b.now) - (a.before - a.now));
}

function changeRow(item) {
  return `
    <div class="insight-row">
      <div>
        <div class="insight-main">${escapeHtml(edgeKeyLabel(item.key))}</div>
        <div class="insight-sub">前一窗口 ${item.before} 次 · 当前 ${item.now} 次</div>
      </div>
      <div class="insight-value">${item.now > item.before ? "↑" : "↓"} ${Math.abs(item.now - item.before)}</div>
    </div>
  `;
}

function plannedRow(edge) {
  return `
    <div class="insight-row">
      <div>
        <div class="insight-main">${escapeHtml(getNode(edge.fromNodeId)?.label || "")} -> ${escapeHtml(getNode(edge.toNodeId)?.label || "")}</div>
        <div class="insight-sub">0 次 · New</div>
      </div>
      <div class="insight-value">🌱</div>
    </div>
  `;
}

function edgeKeyLabel(key) {
  const [from, to] = key.split("->");
  return `${getNode(from)?.label || from} -> ${getNode(to)?.label || to}`;
}

function attachDraftToTree(root) {
  if (!isRecordingActive() || !recording.length) return;
  if (recording[0] !== root.nodeId) return;
  let current = root;
  for (let i = 1; i < recording.length; i += 1) {
    const id = recording[i];
    const fromId = current.nodeId;
    const draftFresh = freshRecordingNodeIds.has(id) || freshRecordingEdgeKeys.has(`${fromId}->${id}`);
    if (!current.children.has(id)) {
      current.children.set(id, { id: `${current.id}/${id}/draft`, nodeId: id, count: 0, depth: i, children: new Map(), episodes: [], draft: true, draftFresh });
    } else if (draftFresh) {
      current.children.get(id).draftFresh = true;
    }
    current = current.children.get(id);
  }
}

function pathNodeClass(nodeId, planned = false, draftFresh = false) {
  const classes = ["path-node"];
  const index = recording.indexOf(nodeId);
  if (index >= 0) classes.push("recorded");
  if (recordingFromPath && recording[recording.length - 1] === nodeId) classes.push("current");
  if (freshRecordingNodeIds.has(nodeId) || planned || draftFresh) classes.push("new");
  if (recordingFromPath && recording.length && index < 0 && !isAvailableNext(nodeId)) classes.push("dimmed");
  if (nodeId === selectedNodeId) classes.push("selected");
  return classes.join(" ");
}

function pathEdgeClass(fromId, toId, weak, intendedStatus = null, draftFresh = false) {
  const classes = ["path-edge"];
  if (weak) classes.push("weak");
  if (isRecordedEdge(fromId, toId)) classes.push("recorded");
  if (freshRecordingEdgeKeys.has(`${fromId}->${toId}`) || freshRecordingNodeIds.has(toId) || intendedStatus || draftFresh) classes.push("new");
  if (intendedStatus === "active") classes.push("intended");
  if (intendedStatus === "converted") classes.push("converted");
  if (recordingFromPath && recording.length && !isRecordedEdge(fromId, toId) && fromId !== recording[recording.length - 1]) classes.push("dimmed");
  return classes.join(" ");
}

function pathEdgeLabelClass(fromId, toId, fresh = false) {
  const classes = ["path-edge-label"];
  if (fresh) classes.push("new");
  if (recordingFromPath && recording.length && !isRecordedEdge(fromId, toId) && fromId !== recording[recording.length - 1]) classes.push("dimmed-label");
  return classes.join(" ");
}

function isRecordedEdge(fromId, toId) {
  for (let i = 0; i < recording.length - 1; i += 1) {
    if (recording[i] === fromId && recording[i + 1] === toId) return true;
  }
  return false;
}

function isAvailableNext(nodeId) {
  const current = recording[recording.length - 1];
  if (!current) return true;
  if (recording.includes(nodeId)) return true;
  return graph.edges.some((edge) => edge.fromNodeId === current && edge.toNodeId === nodeId)
    || state.plannedEdges.some((edge) => edge.status === "active" && edge.fromNodeId === current && edge.toNodeId === nodeId);
}

function handlePathNodeClick(nodeId) {
  selectedNodeId = nodeId;
  if (!recordingFromPath) {
    if (expandedPathNodeIds.has(nodeId)) {
      expandedPathNodeIds.delete(nodeId);
    } else {
      expandedPathNodeIds.add(nodeId);
    }
    render();
    return;
  }
  const existingIndex = recording.indexOf(nodeId);
  if (existingIndex >= 0) {
    if (existingIndex === recording.length - 1 && els.pathDraftBar.classList.contains("hidden")) {
      renderPathDraftBar();
      return;
    }
    recording = recording.slice(0, existingIndex + 1);
    pathStartId = recording[0];
    render();
    return;
  }
  const current = recording[recording.length - 1];
  const canMove = graph.edges.some((edge) => edge.fromNodeId === current && edge.toNodeId === nodeId)
    || state.plannedEdges.some((edge) => edge.status === "active" && edge.fromNodeId === current && edge.toNodeId === nodeId)
    || temporaryNodeIds.has(nodeId);
  if (canMove) {
    recording.push(nodeId);
    render();
    return;
  }
  const parentIndex = recording.findIndex((id) => graph.edges.some((edge) => edge.fromNodeId === id && edge.toNodeId === nodeId));
  if (parentIndex >= 0) {
    recording = recording.slice(0, parentIndex + 1);
    recording.push(nodeId);
    render();
  }
}

function startPathRecording(startId) {
  if (!startId) return;
  recordingFromPath = true;
  recording = [startId];
  recordingPauses = [];
  freshRecordingNodeIds = new Set();
  freshRecordingEdgeKeys = new Set();
  selectedNodeId = startId;
  pathStartId = startId;
  els.recordPanel.dataset.surface = "";
  els.recordPanel.classList.add("hidden");
  render();
}

function continuePathRecording(pathIds) {
  const ids = Array.isArray(pathIds) ? pathIds.filter(Boolean) : [];
  if (!ids.length) return;
  recordingFromPath = true;
  recording = [...ids];
  recordingPauses = [];
  freshRecordingNodeIds = new Set();
  freshRecordingEdgeKeys = new Set();
  selectedNodeId = ids[ids.length - 1];
  pathStartId = ids[0];
  els.recordPanel.dataset.surface = "";
  els.recordPanel.classList.add("hidden");
  render();
}

function renderPathDraftBar() {
  const active = recordingFromPath && recording.length;
  if (!active) clearPathDraftBarAutoHide();
  els.pathDraftBar.classList.toggle("hidden", !active);
  if (!active) return;
  els.pathDraftBar.classList.remove("is-fading");
  els.pathDraftLine.textContent = draftPathLabel();
  els.pathUndo.disabled = recording.length <= 1;
  els.pathFinish.disabled = recording.length === 0;
  requestAnimationFrame(positionPathDraftBar);
  schedulePathDraftBarAutoHide();
}

function schedulePathDraftBarAutoHide() {
  clearPathDraftBarAutoHide();
  if (!recordingFromPath || !recording.length || els.pathDraftBar.classList.contains("hidden")) return;
  draftBarHideTimer = window.setTimeout(() => {
    els.pathDraftBar.classList.add("is-fading");
    draftBarHideTimer = window.setTimeout(() => {
      els.pathDraftBar.classList.add("hidden");
      els.pathDraftBar.classList.remove("is-fading");
      draftBarHideTimer = null;
    }, 220);
  }, 3000);
}

function clearPathDraftBarAutoHide() {
  if (draftBarHideTimer) window.clearTimeout(draftBarHideTimer);
  draftBarHideTimer = null;
  els.pathDraftBar.classList.remove("is-fading");
}

function positionPathDraftBar() {
  if (!recordingFromPath || !recording.length || els.pathDraftBar.classList.contains("hidden")) return;
  const currentId = recording[recording.length - 1];
  const nodeEl = Array.from(els.pathMap.querySelectorAll(".path-node")).find((item) => item.dataset.nodeId === currentId);
  if (!nodeEl) return;
  const nodeRect = nodeEl.getBoundingClientRect();
  const viewRect = els.pathView.getBoundingClientRect();
  const barRect = els.pathDraftBar.getBoundingClientRect();
  const anchorX = nodeRect.right - viewRect.left;
  const firstButtonWidth = els.pathAddOld.getBoundingClientRect().width || 92;
  let left = anchorX - firstButtonWidth - 9;
  let top = nodeRect.top - viewRect.top + nodeRect.height / 2 - barRect.height / 2;
  const maxLeft = viewRect.width - barRect.width - 12;
  if (left > maxLeft) left = nodeRect.left - viewRect.left - barRect.width - 14;
  left = clamp(left, 10, Math.max(10, maxLeft));
  top = clamp(top, 92, Math.max(92, viewRect.height - barRect.height - 12));
  els.pathDraftBar.style.setProperty("--draft-bar-left", `${Math.round(left)}px`);
  els.pathDraftBar.style.setProperty("--draft-bar-top", `${Math.round(top)}px`);
}

function showOldStepChoices() {
  if (!recordingFromPath || !recording.length) return;
  selectedOldStepOption = null;
  els.recordPanel.dataset.surface = "path-picker";
  els.recordPanel.classList.remove("hidden");
  renderRecorder();
}

function hideOldStepChoices() {
  selectedOldStepOption = null;
  els.recordPanel.classList.add("hidden");
  renderRecorder();
}

function confirmOldStepChoice() {
  if (!selectedOldStepOption) return;
  chooseRecorderOption("path", selectedOldStepOption);
  hideOldStepChoices();
  render();
}

function draftPathLabel() {
  const pauseIndexes = new Set(recordingPauses.map((marker) => marker.afterStepIndex));
  const parts = [];
  recording.forEach((id, index) => {
    parts.push(getNode(id)?.label || "未知");
    if (pauseIndexes.has(index)) parts.push("⏸");
  });
  return parts.join(" -> ");
}

function removeDraftStep(index) {
  if (!recordingFromPath || index < 0 || index >= recording.length) return;
  clearPauseTimer();
  els.pauseCard.classList.add("hidden");
  recording.splice(index, 1);
  recordingPauses = recordingPauses
    .filter((marker) => marker.afterStepIndex !== index && marker.afterStepIndex < recording.length + 1)
    .map((marker) => marker.afterStepIndex > index ? { ...marker, afterStepIndex: marker.afterStepIndex - 1 } : marker);
  if (!recording.length) {
    stopRecording();
    return;
  }
  pathStartId = recording[0];
  selectedNodeId = recording[recording.length - 1];
  render();
}

function addPausePoint() {
  if (!recording.length) return;
  const afterStepIndex = recording.length - 1;
  if (recordingPauses.some((marker) => marker.afterStepIndex === afterStepIndex)) return;
  recordingPauses.push({ id: uid(), afterStepIndex, createdAt: new Date().toISOString() });
  renderRecorder();
  renderPathDraftBar();
  renderPathView();
  startPauseCard();
}

function startPauseCard() {
  clearPauseTimer();
  pauseRemaining = 10;
  els.pauseCard.classList.remove("hidden");
  updatePauseCard();
  pauseTimer = window.setInterval(() => {
    pauseRemaining -= 1;
    updatePauseCard();
    if (pauseRemaining <= 0) finishPauseCard();
  }, 1000);
}

function updatePauseCard() {
  els.pauseCountdown.textContent = pauseRemaining > 0 ? String(pauseRemaining) : "";
  if (pauseRemaining >= 8) {
    els.pausePrompt.textContent = "先别反应。";
  } else if (pauseRemaining >= 4) {
    els.pausePrompt.textContent = "身体哪里最明显？";
  } else if (pauseRemaining >= 1) {
    els.pausePrompt.textContent = "不需要让它消失。";
  } else {
    els.pausePrompt.textContent = "现在，你想怎么走？";
  }
}

function finishPauseCard() {
  clearPauseTimer();
  pauseRemaining = 0;
  els.pauseCountdown.textContent = "";
  els.pausePrompt.textContent = "现在，你想怎么走？";
  window.setTimeout(() => {
    els.pauseCard.classList.add("hidden");
  }, 1300);
}

function clearPauseTimer() {
  if (pauseTimer) window.clearInterval(pauseTimer);
  pauseTimer = null;
}

function pathChanges(startId) {
  const currentRoot = buildPathTree(startId);
  const previousRoot = buildPathTreeFromEpisodes(startId, previousWindowEpisodes());
  const current = firstStepRatios(currentRoot);
  const previous = firstStepRatios(previousRoot);
  const result = new Map();
  current.forEach((item, key) => {
    const before = previous.get(key);
    result.set(key, {
      ...item,
      previousPct: before?.pct || 0,
      deltaPct: Math.round((item.pct - (before?.pct || 0)) * 100),
      delta: item.count - (before?.count || 0),
      isNew: !before
    });
  });
  return result;
}

function buildPathTreeFromEpisodes(startId, episodes, maxDepth = 5) {
  const root = { id: startId, nodeId: startId, count: 0, depth: 0, children: new Map(), episodes: [] };
  episodes.forEach((ep) => {
    const ids = orderedIds(ep);
    const startIndex = ids.indexOf(startId);
    if (startIndex < 0) return;
    const slice = ids.slice(startIndex, startIndex + maxDepth + 1);
    root.count += 1;
    let current = root;
    for (let i = 1; i < slice.length; i += 1) {
      const id = slice[i];
      if (isHiddenPathOption(slice[i - 1], id)) break;
      if (!current.children.has(id)) {
        current.children.set(id, { id: `${current.id}/${id}/${i}`, nodeId: id, count: 0, depth: i, children: new Map(), episodes: [] });
      }
      current = current.children.get(id);
      current.count += 1;
    }
  });
  return root;
}

function firstStepRatios(root) {
  const result = new Map();
  Array.from(root.children.values()).forEach((child) => {
    const label = `${getNode(root.nodeId)?.label || ""} -> ${getNode(child.nodeId)?.label || ""}`;
    result.set(`${root.nodeId}->${child.nodeId}`, {
      label,
      nodeId: child.nodeId,
      count: child.count,
      pct: child.count / Math.max(1, root.count)
    });
  });
  return result;
}

function changeText(change) {
  if (!change || els.range.value === "all") return "";
  if (change.isNew) return "· 新出现";
  if (change.deltaPct > 0) return `· ↑ ${change.deltaPct}%`;
  if (change.deltaPct < 0) return `· ↓ ${Math.abs(change.deltaPct)}%`;
  return "· 持平";
}

function renderMap() {
  if (!window.cytoscape) {
    els.brainMap.innerHTML = "<div class='map-error'>全局地图引擎没有加载成功；路径视图仍可使用。</div>";
    return;
  }
  const current = graphForCurrentMode();
  const maxNode = Math.max(1, ...current.nodes.map((n) => n.count));
  const maxEdge = Math.max(1, ...current.edges.map((e) => e.count));
  const elements = [
    ...current.nodes.map((n) => ({
      group: "nodes",
      data: {
        id: n.id,
        label: n.label,
        count: n.count,
        size: 14 + Math.sqrt(n.count / maxNode) * 34
      },
      position: savedPositions[layoutKey()]?.[n.id]
    })),
    ...current.edges.map((e) => ({
      group: "edges",
      data: {
        id: e.id,
        source: e.fromNodeId,
        target: e.toNodeId,
        count: e.count,
        width: 1 + (e.count / maxEdge) * 9,
        opacity: 0.12 + (e.count / maxEdge) * 0.62,
        label: `${getNode(e.fromNodeId)?.label || ""} -> ${getNode(e.toNodeId)?.label || ""} · ${e.count} 次`
      }
    }))
  ];

  if (!cy) {
    cy = cytoscape({
      container: els.brainMap,
      elements,
      minZoom: 0.22,
      maxZoom: 2.8,
      wheelSensitivity: 0.18,
      style: cytoscapeStyle(),
      layout: layoutForCurrentMode()
    });
    bindCyEvents();
  } else {
    cy.elements().remove();
    cy.add(elements);
    cy.style(cytoscapeStyle());
    cy.layout(layoutForCurrentMode()).run();
  }
  els.focusToggle.textContent = focusMode ? "退出聚焦" : "聚焦";
  setTimeout(() => {
    selectCyNode(selectedNodeId);
    updateZoomClasses();
  }, 60);
}

function cytoscapeStyle() {
  return [
    {
      selector: "node",
      style: {
        width: "data(size)",
        height: "data(size)",
        "background-color": "#b89457",
        "background-opacity": 0.88,
        "border-width": 1,
        "border-color": "rgba(255,255,255,0.45)",
        label: "data(label)",
        "font-size": 12,
        "font-family": "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        color: "#1b231f",
        "text-outline-width": 2,
        "text-outline-color": "#fffaf0",
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 7,
        "overlay-opacity": 0
      }
    },
    {
      selector: "edge",
      style: {
        width: "data(width)",
        "line-color": "#9b8352",
        "line-opacity": "data(opacity)",
        "target-arrow-shape": "triangle",
        "target-arrow-color": "#9b8352",
        "target-arrow-fill": "filled",
        "arrow-scale": 0.72,
        "curve-style": "bezier",
        "control-point-step-size": 42,
        "overlay-opacity": 0
      }
    },
    {
      selector: "node:selected, node.active",
      style: {
        "background-color": "#d49a29",
        "border-width": 4,
        "border-color": "#f4dfa0",
        "z-index": 20
      }
    },
    { selector: "node.dim", style: { opacity: 0.14, label: "" } },
    { selector: "edge.dim", style: { opacity: 0.05, "target-arrow-opacity": 0.05 } },
    {
      selector: "edge.active",
      style: {
        "line-color": "#d49a29",
        "target-arrow-color": "#d49a29",
        "line-opacity": 0.92,
        "z-index": 10
      }
    },
    { selector: ".zoomed-out-low", style: { label: "" } }
  ];
}

function layoutForCurrentMode() {
  if (focusMode) return { name: "preset", fit: true, padding: 82, positions: focusPositions() };
  if (savedPositions[layoutKey()]) return { name: "preset", fit: false, positions: savedPositions[layoutKey()] };
  return {
    name: "cose",
    fit: true,
    padding: 76,
    animate: false,
    nodeRepulsion: 9800,
    idealEdgeLength: (edge) => 220 - Math.min(130, edge.data("count") * 24),
    edgeElasticity: (edge) => 80 + edge.data("count") * 40,
    nestingFactor: 1.2,
    gravity: 0.55,
    numIter: 1400,
    initialTemp: 180,
    coolingFactor: 0.94,
    minTemp: 1
  };
}

function focusPositions() {
  const current = graphForCurrentMode();
  const incoming = current.edges.filter((e) => e.toNodeId === selectedNodeId).sort((a, b) => b.count - a.count);
  const outgoing = current.edges.filter((e) => e.fromNodeId === selectedNodeId).sort((a, b) => b.count - a.count);
  const positions = { [selectedNodeId]: { x: 0, y: 0 } };
  placeFocusColumn(incoming.map((e) => e.fromNodeId), positions, -280);
  placeFocusColumn(outgoing.map((e) => e.toNodeId), positions, 280);
  return positions;
}

function placeFocusColumn(ids, positions, x) {
  const unique = Array.from(new Set(ids)).filter((id) => id !== selectedNodeId);
  const gap = 112;
  const start = -((unique.length - 1) * gap) / 2;
  unique.forEach((id, index) => {
    positions[id] = { x, y: start + index * gap };
  });
}

function bindCyEvents() {
  cy.on("tap", "node", (event) => {
    selectedNodeId = event.target.id();
    selectCyNode(selectedNodeId);
    renderDetail();
    renderFocus();
  });
  cy.on("dbltap", "node", (event) => {
    selectedNodeId = event.target.id();
    focusMode = true;
    render();
    cy.fit(undefined, 86);
  });
  cy.on("mouseover", "node", (event) => highlightNeighborhood(event.target));
  cy.on("mouseout", "node", clearHighlight);
  cy.on("mouseover", "edge", showEdgeTooltip);
  cy.on("mouseout", "edge", hideEdgeTooltip);
  cy.on("dragfree", "node", rememberPositions);
  cy.on("zoom", updateZoomClasses);
  cy.on("pan", hideEdgeTooltip);
}

function selectCyNode(id) {
  if (!cy || !id) return;
  cy.elements().unselect();
  const nodeItem = cy.getElementById(id);
  if (nodeItem.length) nodeItem.select();
}

function highlightNeighborhood(nodeItem) {
  cy.elements().addClass("dim");
  nodeItem.removeClass("dim").addClass("active");
  nodeItem.connectedEdges().removeClass("dim").addClass("active");
  nodeItem.connectedEdges().connectedNodes().removeClass("dim");
}

function clearHighlight() {
  cy.elements().removeClass("dim active");
  selectCyNode(selectedNodeId);
}

function showEdgeTooltip(event) {
  const edge = event.target;
  const point = edge.renderedMidpoint();
  els.edgeTooltip.textContent = edge.data("label");
  els.edgeTooltip.style.left = `${point.x + 12}px`;
  els.edgeTooltip.style.top = `${point.y + 12}px`;
  els.edgeTooltip.classList.remove("hidden");
}

function hideEdgeTooltip() {
  els.edgeTooltip.classList.add("hidden");
}

function rememberPositions() {
  const key = layoutKey();
  savedPositions[key] = {};
  cy.nodes().forEach((n) => {
    savedPositions[key][n.id()] = n.position();
  });
  savePositions();
}

function updateZoomClasses() {
  if (!cy) return;
  const zoom = cy.zoom();
  const maxCount = Math.max(1, ...graph.nodes.map((n) => n.count));
  cy.nodes().forEach((n) => {
    n.toggleClass("zoomed-out-low", zoom < 0.72 && n.data("count") / maxCount < 0.56 && n.id() !== selectedNodeId);
  });
}

function layoutKey() {
  return `${els.range.value}:${focusMode ? `focus:${selectedNodeId}` : "global"}`;
}

function handleSearch() {
  const q = normalize(els.search.value);
  if (!q || !cy) return;
  const found = state.nodes.find((n) => n.normalizedLabel.includes(q));
  if (!found) return;
  selectedNodeId = found.id;
  focusMode = false;
  render();
  const cyNode = cy.getElementById(found.id);
  if (cyNode.length) {
    cy.animate({ center: { eles: cyNode }, zoom: Math.max(1.12, cy.zoom()) }, { duration: 240 });
    selectCyNode(found.id);
  }
}

function handleShortcuts(event) {
  if (els.dialog.open) {
    if (event.key === "Enter") {
      event.preventDefault();
      addNewNodeFromDialog();
    }
    return;
  }
  if (!recordingFromPath && els.recordPanel.classList.contains("hidden")) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    finishRecord();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    stopRecording();
    return;
  }
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    openNewNodeDialog();
    return;
  }
  if (event.key.toLowerCase() === "p") {
    event.preventDefault();
    addPausePoint();
    return;
  }
  if (event.key === "Backspace" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z")) {
    event.preventDefault();
    undoStep();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    finishRecord();
  }
}

function renderDetail() {
  const n = getNode(selectedNodeId);
  if (!n) return;
  const incoming = graph.edges.filter((e) => e.toNodeId === n.id).sort((a, b) => b.count - a.count);
  const outgoing = graph.edges.filter((e) => e.fromNodeId === n.id).sort((a, b) => b.count - a.count);
  const paths = commonPathsFrom(n.id).slice(0, 4);
  els.nodeDetail.innerHTML = `
    <div class="record-head">
      <div>
        <h2>${escapeHtml(n.label)} · ${n.count || 0} 次</h2>
        <p class="muted">最近出现：${formatTime(n.lastSeenAt)}</p>
      </div>
      <button class="primary" data-start="${n.id}">从这里记录</button>
    </div>
    <div class="detail-grid">
      <div class="detail-box"><h3>通常从哪里来</h3>${edgeButtons(incoming, "fromNodeId")}</div>
      <div class="detail-box"><h3>通常走向哪里</h3>${edgeButtons(outgoing, "toNodeId")}</div>
      <div class="detail-box"><h3>常见后续路径</h3>${paths.length ? paths.map((p) => `<button class="link-button">${escapeHtml(p)}</button>`).join("") : "<p class='muted'>还没有足够记录。</p>"}</div>
    </div>
  `;
  els.nodeDetail.querySelector("[data-start]").addEventListener("click", () => continuePathRecording(pathIdsForSelectedNode(n.id)));
  els.nodeDetail.querySelectorAll("[data-node]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedNodeId = button.dataset.node;
      render();
    });
  });
}

function edgeButtons(edges, nodeKey) {
  if (!edges.length) return "<p class='muted'>暂无记录。</p>";
  return edges.slice(0, 5).map((edge) => {
    const label = getNode(edge[nodeKey])?.label || "未知";
    return `<button class="link-button" data-node="${edge[nodeKey]}">${escapeHtml(label)} · ${edge.count} 次</button>`;
  }).join("");
}

function commonPathsFrom(nodeId) {
  const paths = filteredEpisodes()
    .map((ep) => orderedIds(ep))
    .map((ids) => ids.slice(ids.indexOf(nodeId)).filter(Boolean))
    .filter((ids) => ids[0] === nodeId && ids.length > 1)
    .map((ids) => ids.slice(0, 5).map((id) => getNode(id)?.label).join(" -> "));
  const counts = new Map();
  paths.forEach((p) => counts.set(p, (counts.get(p) || 0) + 1));
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([p, count]) => `${p} · ${count} 次`);
}

function renderFocus() {
  if (!els.focusContent) return;
  const n = getNode(selectedNodeId);
  if (!n) {
    els.focusContent.textContent = "先在地图里点击一个节点。";
    return;
  }
  const incoming = graph.edges.filter((e) => e.toNodeId === n.id).sort((a, b) => b.count - a.count);
  const outgoing = graph.edges.filter((e) => e.fromNodeId === n.id).sort((a, b) => b.count - a.count);
  els.focusContent.innerHTML = `
    <div>
      <h2>${escapeHtml(n.label)} 的局部路径</h2>
      <p class="muted">在地图页点“聚焦”，只看这个节点的一阶来路和去路。</p>
    </div>
    <div class="detail-grid">
      <div class="detail-box"><h3>从哪里来</h3>${edgeButtons(incoming, "fromNodeId")}</div>
      <div class="detail-box"><h3>往哪里走</h3>${edgeButtons(outgoing, "toNodeId")}</div>
      <div class="detail-box"><h3>后续路径</h3>${commonPathsFrom(n.id).slice(0, 4).map((p) => `<button class="link-button">${escapeHtml(p)}</button>`).join("") || "<p class='muted'>暂无。</p>"}</div>
    </div>
  `;
}

function renderHistory() {
  const episodes = filteredEpisodes().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const deletedEpisodes = state.episodes
    .filter((ep) => ep.status === "deleted")
    .sort((a, b) => new Date(b.deletedAt || b.startedAt) - new Date(a.deletedAt || a.startedAt));
  selectedHistoryEpisodeIds = new Set([...selectedHistoryEpisodeIds].filter((id) => episodes.some((ep) => ep.id === id)));
  selectedDeletedEpisodeIds = new Set([...selectedDeletedEpisodeIds].filter((id) => deletedEpisodes.some((ep) => ep.id === id)));
  els.historyList.innerHTML = `
    <section class="history-section">
      <div class="history-bulk-actions">
        <h3>历史记录</h3>
        <span>已选 ${selectedHistoryEpisodeIds.size} 条</span>
        <button type="button" class="secondary" data-select-visible ${episodes.length ? "" : "disabled"}>全选本页</button>
        <button type="button" class="ghost delete" data-delete-selected ${selectedHistoryEpisodeIds.size ? "" : "disabled"}>删除所选</button>
      </div>
      ${episodes.length ? episodes.map((ep) => historyEpisodeRow(ep, selectedHistoryEpisodeIds, "select-episode", "delete")).join("") : "<p class='muted'>还没有记录。</p>"}
    </section>
    <section class="history-section">
      <div class="history-bulk-actions">
        <h3>恢复</h3>
        <span>已选 ${selectedDeletedEpisodeIds.size} 条</span>
        <button type="button" class="secondary" data-select-deleted-visible ${deletedEpisodes.length ? "" : "disabled"}>全选已删除</button>
        <button type="button" class="secondary" data-restore-selected ${selectedDeletedEpisodeIds.size ? "" : "disabled"}>恢复所选</button>
      </div>
      ${deletedEpisodes.length ? deletedEpisodes.map((ep) => historyEpisodeRow(ep, selectedDeletedEpisodeIds, "select-deleted-episode", "restore")).join("") : "<p class='muted'>没有已删除记录。</p>"}
    </section>
  `;
  els.historyList.querySelectorAll("[data-select-episode]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) selectedHistoryEpisodeIds.add(input.dataset.selectEpisode);
      else selectedHistoryEpisodeIds.delete(input.dataset.selectEpisode);
      renderHistory();
    });
  });
  els.historyList.querySelector("[data-select-visible]")?.addEventListener("click", () => {
    const allSelected = episodes.every((ep) => selectedHistoryEpisodeIds.has(ep.id));
    episodes.forEach((ep) => {
      if (allSelected) selectedHistoryEpisodeIds.delete(ep.id);
      else selectedHistoryEpisodeIds.add(ep.id);
    });
    renderHistory();
  });
  els.historyList.querySelector("[data-delete-selected]")?.addEventListener("click", () => {
    deleteEpisodes([...selectedHistoryEpisodeIds]);
  });
  els.historyList.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      deleteEpisodes([button.dataset.delete]);
    });
  });
  els.historyList.querySelectorAll("[data-select-deleted-episode]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) selectedDeletedEpisodeIds.add(input.dataset.selectDeletedEpisode);
      else selectedDeletedEpisodeIds.delete(input.dataset.selectDeletedEpisode);
      renderHistory();
    });
  });
  els.historyList.querySelector("[data-select-deleted-visible]")?.addEventListener("click", () => {
    const allSelected = deletedEpisodes.every((ep) => selectedDeletedEpisodeIds.has(ep.id));
    deletedEpisodes.forEach((ep) => {
      if (allSelected) selectedDeletedEpisodeIds.delete(ep.id);
      else selectedDeletedEpisodeIds.add(ep.id);
    });
    renderHistory();
  });
  els.historyList.querySelector("[data-restore-selected]")?.addEventListener("click", () => {
    restoreEpisodes([...selectedDeletedEpisodeIds]);
  });
  els.historyList.querySelectorAll("[data-restore]").forEach((button) => {
    button.addEventListener("click", () => {
      restoreEpisodes([button.dataset.restore]);
    });
  });
}

function historyEpisodeRow(ep, selectedSet, selectName, action) {
  const labels = orderedLabelsWithPauses(ep);
  const checked = selectedSet.has(ep.id) ? "checked" : "";
  const actionButton = action === "restore"
    ? `<button class="secondary" data-restore="${ep.id}">恢复</button>`
    : `<button class="ghost delete" data-delete="${ep.id}">删除</button>`;
  const dataAttr = selectName === "select-deleted-episode"
    ? `data-select-deleted-episode="${ep.id}"`
    : `data-select-episode="${ep.id}"`;
  return `
    <article class="episode ${action === "restore" ? "deleted-episode" : ""}">
      <label class="episode-select">
        <input type="checkbox" ${dataAttr} ${checked}>
      </label>
      <div>
        <div class="episode-time">${formatTime(ep.startedAt)}</div>
        <div>${ep.aware ? "◉ " : ""}${escapeHtml(labels)}</div>
      </div>
      ${actionButton}
    </article>
  `;
}

function deleteEpisodes(ids) {
  const idsToDelete = new Set(ids);
  if (!idsToDelete.size) return;
  saveBackupSnapshot("before-delete-episodes");
  state.episodes = state.episodes.map((ep) => (
    idsToDelete.has(ep.id) ? { ...ep, status: "deleted", deletedAt: new Date().toISOString() } : ep
  ));
  selectedHistoryEpisodeIds = new Set([...selectedHistoryEpisodeIds].filter((id) => !idsToDelete.has(id)));
  saveState();
  render();
}

function restoreEpisodes(ids) {
  const idsToRestore = new Set(ids);
  if (!idsToRestore.size) return;
  state.episodes = state.episodes.map((ep) => (
    idsToRestore.has(ep.id) ? { ...ep, status: "completed", deletedAt: null } : ep
  ));
  selectedDeletedEpisodeIds = new Set([...selectedDeletedEpisodeIds].filter((id) => !idsToRestore.has(id)));
  saveState();
  render();
}

function pruneNewPathEdgeKeys() {
  if (!state.newPathEdgeKeys?.length) return;
  const observedKeys = new Set();
  state.episodes
    .filter((ep) => ep.status === "completed")
    .forEach((ep) => {
      const ids = orderedIds(ep);
      for (let i = 0; i < ids.length - 1; i += 1) {
        observedKeys.add(pathOptionKey(ids[i], ids[i + 1]));
      }
    });
  state.newPathEdgeKeys = state.newPathEdgeKeys.filter((key) => observedKeys.has(key));
}

function renderOther() {
  if (!els.trashList) return;
  const hiddenStarts = startOptions().filter((item) => hiddenStartNodeIds.has(item.id));
  const hiddenPaths = (state.hiddenPathOptions || []).map((key) => {
    const [fromNodeId, toNodeId] = key.split("->");
    return {
      key,
      fromNodeId,
      toNodeId,
      label: `${getNode(fromNodeId)?.label || "未知"} -> ${getNode(toNodeId)?.label || "未知"}`
    };
  });
  els.trashList.innerHTML = `
    <section class="trash-section">
      <h3>回收站</h3>
      <p class="muted">这里放被你从选择里隐藏的起点和路径，不影响历史记录。</p>
    </section>
    <section class="trash-section">
      <h3>隐藏的起点</h3>
      <div class="trash-items">
        ${hiddenStarts.length ? hiddenStarts.map((item) => `
          <div class="trash-row">
            <span>${escapeHtml(item.label)} · ${item.count} 次</span>
            <button type="button" class="secondary" data-restore-start="${item.id}">恢复</button>
          </div>
        `).join("") : "<p class='muted'>没有隐藏的起点。</p>"}
      </div>
    </section>
    <section class="trash-section">
      <h3>隐藏的路径选项</h3>
      <div class="trash-items">
        ${hiddenPaths.length ? hiddenPaths.map((item) => `
          <div class="trash-row">
            <span>${escapeHtml(item.label)}</span>
            <button type="button" class="secondary" data-restore-path="${item.key}">恢复</button>
          </div>
        `).join("") : "<p class='muted'>没有隐藏的路径选项。</p>"}
      </div>
    </section>
  `;
  els.trashList.querySelectorAll("[data-restore-start]").forEach((button) => {
    button.addEventListener("click", () => restoreStartOption(button.dataset.restoreStart));
  });
  els.trashList.querySelectorAll("[data-restore-path]").forEach((button) => {
    button.addEventListener("click", () => restorePathOption(button.dataset.restorePath));
  });
}

function restorePathOption(key) {
  state.hiddenPathOptions = (state.hiddenPathOptions || []).filter((item) => item !== key);
  saveState();
  render();
}

function showView(view) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active-view"));
  document.getElementById(`${view}View`).classList.add("active-view");
  if (view === "change") renderInsightsPlaceholder();
}

function startRecording(startId) {
  recording = startId ? [startId] : [];
  recordingFromPath = false;
  recordingPauses = [];
  activeGuidedEpisodeId = null;
  recordingSource = null;
  recordingBodyPromptDone = Boolean(startId);
  recordingBodySkipped = false;
  hiddenRecorderOptionIds = new Set();
  freshRecordingNodeIds = new Set();
  freshRecordingEdgeKeys = new Set();
  newNodeContext = "path";
  els.recordPanel.dataset.surface = "guided";
  els.recordPanel.classList.remove("hidden");
  renderRecorder();
}

function stopRecording(options = { discardTemporary: true }) {
  clearPauseTimer();
  clearPathDraftBarAutoHide();
  els.pauseCard.classList.add("hidden");
  const hasAutosavedEpisode = Boolean(activeGuidedEpisodeId);
  if (options.discardTemporary && !hasAutosavedEpisode && temporaryNodeIds.size) {
    state.nodes = state.nodes.filter((n) => !temporaryNodeIds.has(n.id));
    state.plannedEdges = state.plannedEdges.filter((edge) => !temporaryNodeIds.has(edge.fromNodeId) && !temporaryNodeIds.has(edge.toNodeId));
    saveState();
  }
  recording = [];
  recordingFromPath = false;
  recordingPauses = [];
  recordingSource = null;
  recordingBodyPromptDone = false;
  recordingBodySkipped = false;
  newNodeContext = "path";
  activeGuidedEpisodeId = null;
  selectedOldStepOption = null;
  hiddenRecorderOptionIds = new Set();
  temporaryNodeIds = new Set();
  freshRecordingNodeIds = new Set();
  freshRecordingEdgeKeys = new Set();
  els.awareToggle.checked = false;
  els.recordPanel.dataset.surface = "";
  els.pathDraftBar.classList.add("hidden");
  els.recordPanel.classList.add("hidden");
  renderRecorder();
  render();
}

function undoStep() {
  clearPauseTimer();
  els.pauseCard.classList.add("hidden");
  if (recordingFromPath && recording.length <= 1) return;
  recording.pop();
  recordingPauses = recordingPauses.filter((marker) => marker.afterStepIndex < recording.length);
  if (!recordingFromPath) {
    if (recording.length <= 1) {
      recordingBodyPromptDone = Boolean(recording.length);
      recordingBodySkipped = false;
    }
    syncGuidedAutosave();
  }
  renderRecorder();
  render();
}

function finishRecord() {
  if (!recording.length) return;
  const finishedEpisode = upsertRecordingEpisode();
  persistFreshRecordingEdges();
  convertPlannedEdgesForEpisode(finishedEpisode);
  saveState();
  selectedNodeId = recording[0];
  pathStartId = recording[0];
  stopRecording({ discardTemporary: false });
  render();
}

function upsertRecordingEpisode() {
  const pauses = recordingPauses.map((marker) => ({ ...marker }));
  const existingIndex = activeGuidedEpisodeId
    ? state.episodes.findIndex((ep) => ep.id === activeGuidedEpisodeId)
    : -1;
  const existing = existingIndex >= 0 ? state.episodes[existingIndex] : null;
  const saved = episode(recording, existing?.startedAt || new Date().toISOString(), els.awareToggle.checked || pauses.length > 0, pauses, {
    source: recordingSource,
    bodySkipped: recordingBodySkipped
  });
  if (existing) {
    saved.id = existing.id;
    saved.startedAt = existing.startedAt;
    saved.completedAt = new Date().toISOString();
    state.episodes[existingIndex] = saved;
  } else {
    activeGuidedEpisodeId = saved.id;
    state.episodes.push(saved);
  }
  return saved;
}

function syncGuidedAutosave() {
  if (recordingFromPath) return;
  if (!recording.length) {
    removeGuidedAutosave();
    return;
  }
  const saved = upsertRecordingEpisode();
  persistFreshRecordingEdges();
  convertPlannedEdgesForEpisode(saved);
  selectedNodeId = recording[0];
  pathStartId = recording[0];
  saveState();
}

function removeGuidedAutosave() {
  if (!activeGuidedEpisodeId) return;
  state.episodes = state.episodes.filter((ep) => ep.id !== activeGuidedEpisodeId);
  activeGuidedEpisodeId = null;
  saveState();
}

function goBackRecordStep() {
  if (recordingFromPath) return;
  const stage = recorderStage();
  if (stage === "trigger") {
    recordingSource = null;
  } else if (stage === "body") {
    recording.pop();
    recordingBodyPromptDone = false;
    recordingBodySkipped = false;
  } else if (stage === "path") {
    if (recordingBodySkipped && recording.length === 1) {
      recordingBodyPromptDone = false;
      recordingBodySkipped = false;
    } else if (recording.length) {
      recording.pop();
      if (recording.length <= 1) {
        recordingBodyPromptDone = Boolean(recording.length);
        recordingBodySkipped = false;
      }
    }
  }
  syncGuidedAutosave();
  renderRecorder();
  render();
}

function persistFreshRecordingEdges() {
  if (!freshRecordingEdgeKeys.size) return;
  const next = new Set(state.newPathEdgeKeys || []);
  freshRecordingEdgeKeys.forEach((key) => next.add(key));
  state.newPathEdgeKeys = [...next];
}

function convertPlannedEdgesForEpisode(ep) {
  const ids = orderedIds(ep);
  const walkedKeys = new Set();
  for (let i = 0; i < ids.length - 1; i += 1) {
    walkedKeys.add(`${ids[i]}->${ids[i + 1]}`);
  }
  state.plannedEdges.forEach((edge) => {
    const key = `${edge.fromNodeId}->${edge.toNodeId}`;
    if (edge.status !== "active" || !walkedKeys.has(key)) return;
    edge.status = "converted";
    edge.firstWalkedEpisodeId = ep.id;
    edge.firstWalkedAt = ep.completedAt || ep.startedAt;
  });
}

function renderRecorder() {
  const currentId = recording[recording.length - 1];
  const stage = recorderStage();
  els.recordPanel.dataset.stage = stage;
  els.recordTitle.textContent = recordingFromPath ? "选择旧的一步" : recorderTitle(stage, currentId);
  els.currentPath.textContent = recording.length ? draftPathLabel() : "还没有选择起点";
  const isPathPicker = recordingFromPath && stage === "path" && !els.recordPanel.classList.contains("hidden");
  els.pathPickerActions.classList.toggle("hidden", !isPathPicker);
  els.cancelRecord.classList.toggle("hidden", isPathPicker);
  els.backRecord.classList.toggle("hidden", recordingFromPath || (!recordingSource && !recording.length));
  els.confirmOldStep.disabled = !selectedOldStepOption;
  els.undoStep.disabled = recording.length === 0;
  els.finishRecord.disabled = recording.length === 0;
  els.choiceGrid.innerHTML = "";
  if (stage === "source") {
    renderSourceChoices();
    return;
  }
  const options = (stage === "body" ? bodyOptions() : currentId ? nextOptions(currentId) : startOptions())
    .filter((option) => !hiddenRecorderOptionIds.has(option.id || option.label));
  options.forEach((option) => {
    const card = document.createElement("div");
    card.className = "choice-card choice-card-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-card-main";
    if (selectedOldStepOption?.id === option.id) {
      button.classList.add("selected-old-step");
    }
    button.innerHTML = `<strong>${escapeHtml(option.label)}</strong><span>${option.count} 次</span>`;
    button.addEventListener("click", () => {
      if (isPathPicker) {
        selectedOldStepOption = option;
        renderRecorder();
        return;
      }
      chooseRecorderOption(stage, option);
      syncGuidedAutosave();
      if (recordingFromPath) els.recordPanel.classList.add("hidden");
      render();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "choice-card-delete";
    remove.setAttribute("aria-label", `删除 ${option.label}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      hiddenRecorderOptionIds.add(option.id || option.label);
      renderRecorder();
    });
    card.append(button, remove);
    els.choiceGrid.appendChild(card);
  });
  if (stage === "body") {
    const skip = document.createElement("button");
    skip.className = "choice-card";
    skip.innerHTML = "<strong>暂时没注意到身体</strong><span>跳过，继续记录后面</span>";
    skip.addEventListener("click", () => {
      recordingBodyPromptDone = true;
      recordingBodySkipped = true;
      syncGuidedAutosave();
      renderRecorder();
    });
    els.choiceGrid.appendChild(skip);
  }
  const add = document.createElement("button");
  const addContext = addNodeContextForStage(stage);
  add.className = `choice-card ${addContext === "path-old" ? "old-choice-card" : "add-choice-card"}`;
  add.innerHTML = newNodeButtonLabel(stage, addContext);
  add.addEventListener("click", () => openNewNodeDialog(addContext));
  els.choiceGrid.appendChild(add);
}

function chooseRecorderOption(stage, option) {
  let id = option.id;
  if (stage === "body" && !id) {
    const created = node(uid(), option.label);
    state.nodes.push(created);
    temporaryNodeIds.add(created.id);
    id = created.id;
  }
  recording.push(id);
  if (recording.length === 1) {
    selectedNodeId = id;
    pathStartId = id;
  }
  if (stage === "body") {
    recordingBodyPromptDone = true;
    recordingBodySkipped = false;
  }
}

function pathIdsForSelectedNode(nodeId) {
  if (!pathStartId || pathStartId === nodeId) return [nodeId];
  const root = buildPathTree(pathStartId);
  const found = findPathIds(root, nodeId, [root.nodeId]);
  return found || [nodeId];
}

function findPathIds(branch, nodeId, pathIds) {
  if (branch.nodeId === nodeId) return pathIds;
  const children = Array.from(branch.children.values()).sort((a, b) => b.count - a.count);
  for (const child of children) {
    const found = findPathIds(child, nodeId, [...pathIds, child.nodeId]);
    if (found) return found;
  }
  return null;
}

function recorderStage() {
  if (recordingFromPath) return "path";
  if (!recordingSource && !recording.length) return "source";
  if (!recording.length) return "trigger";
  if (!recordingBodyPromptDone && recording.length === 1) return "body";
  return "path";
}

function recorderTitle(stage, currentId) {
  if (stage === "source") return "刚才，是从哪里开始的？";
  if (stage === "trigger") return recordingSource === "external" ? "发生了什么？" : "想到了什么？";
  if (stage === "body") return "身体哪里最明显？";
  return currentId ? "接下来呢？" : "从哪里开始？";
}

function renderSourceChoices() {
  [
    { source: "external", label: "外部", hint: "发生了什么" },
    { source: "internal", label: "内部", hint: "想到了什么" }
  ].forEach((item) => {
    const button = document.createElement("button");
    button.className = "choice-card source-card";
    button.innerHTML = `<strong>${item.label}</strong><span>${item.hint}</span>`;
    button.addEventListener("click", () => {
      recordingSource = item.source;
      renderRecorder();
    });
    els.choiceGrid.appendChild(button);
  });
}

function addNodeContextForStage(stage) {
  if (recordingFromPath && stage === "path") return "path-old";
  return stage;
}

function newNodeButtonLabel(stage, context = stage) {
  if (stage === "trigger") return "<strong>+ 新的触发</strong><span>记录刚才的开始</span>";
  if (stage === "body") return "<strong>+ 自己写</strong><span>添加身体感觉</span>";
  if (context === "path-old") return "<strong>+ 旧的一步</strong><span>我判断这是旧行为</span>";
  return "<strong>+ 新的一步</strong><span>上面没有，就自己写</span>";
}

function startOptions() {
  const counts = new Map();
  filteredEpisodes().forEach((ep) => {
    const first = orderedIds(ep)[0];
    if (first) counts.set(first, (counts.get(first) || 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([id, count]) => ({ id, label: getNode(id)?.label || "未知", count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function bodyOptions() {
  const presets = ["胸口紧", "喉咙堵", "心跳快", "胃缩", "肩膀紧"];
  const counts = new Map();
  state.nodes.forEach((n) => {
    if (presets.includes(n.label)) counts.set(n.id, 0);
  });
  filteredEpisodes().forEach((ep) => {
    orderedIds(ep).forEach((id) => {
      const label = getNode(id)?.label;
      if (presets.includes(label)) counts.set(id, (counts.get(id) || 0) + 1);
    });
  });
  presets.forEach((label) => {
    if ([...counts.keys()].some((id) => getNode(id)?.label === label)) return;
    const existing = state.nodes.find((n) => n.normalizedLabel === normalize(label));
    if (existing) counts.set(existing.id, 0);
  });
  return presets.map((label) => {
    const existing = state.nodes.find((n) => n.normalizedLabel === normalize(label));
    return { id: existing?.id || null, label, count: existing ? counts.get(existing.id) || 0 : 0 };
  });
}

function nextOptions(nodeId) {
  const allTimeGraph = buildGraph(state, state.episodes.filter((ep) => ep.status === "completed"));
  return allTimeGraph.edges
    .filter((e) => e.fromNodeId === nodeId && !isHiddenPathOption(e.fromNodeId, e.toNodeId))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((e) => ({ id: e.toNodeId, label: getNode(e.toNodeId)?.label || "未知", count: e.count }));
}

function openNewNodeDialog(context = "path") {
  editingNodeId = null;
  newNodeContext = context;
  els.newNodeInput.value = "";
  els.nodeMatches.innerHTML = "";
  els.newNodeTitle.textContent = newNodeTitle(context);
  els.newNodeInput.placeholder = newNodePlaceholder(context);
  els.confirmNewNode.textContent = confirmNewNodeLabel(context);
  els.dialog.showModal();
  setTimeout(() => els.newNodeInput.focus(), 0);
}

function openEditNodeDialog(nodeId) {
  const target = getNode(nodeId);
  if (!target) return;
  editingNodeId = nodeId;
  newNodeContext = "edit-node";
  els.newNodeInput.value = target.label;
  els.nodeMatches.innerHTML = "";
  els.newNodeTitle.textContent = "编辑卡片";
  els.newNodeInput.placeholder = "修改这个卡片的文字";
  els.confirmNewNode.textContent = "保存";
  els.dialog.showModal();
  setTimeout(() => {
    els.newNodeInput.focus();
    els.newNodeInput.select();
  }, 0);
}

function newNodeTitle(context) {
  if (context === "trigger") return recordingSource === "external" ? "新的外部触发" : "新的内部触发";
  if (context === "body") return "写下身体感觉";
  if (context === "path-new") return "新的路径";
  if (context === "path-old") return "旧的一步";
  if (isRecordingActive()) return "添加这次发生的一步";
  return "种下 0 次新路";
}

function newNodePlaceholder(context) {
  if (context === "trigger") return recordingSource === "external" ? "例如：导师发消息、工作被打断" : "例如：想到明天汇报、突然想到论文";
  if (context === "body") return "例如：胸口紧、喉咙堵、胃里发紧";
  if (context === "path-new") return "例如：想逃开、喝水、打开消息";
  if (context === "path-old") return "例如：洗脸、刷手机、躺下";
  if (isRecordingActive()) return "例如：想逃开、刷手机、打开消息";
  return "我下次想试：例如轻食、喝水、打开消息";
}

function confirmNewNodeLabel(context) {
  if (context === "trigger") return "记录";
  if (context === "body") return "加入";
  return isRecordingActive() ? "加入这次记录" : "种下";
}

function isRecordingActive() {
  return recordingFromPath || !els.recordPanel.classList.contains("hidden");
}

function shouldCreateIntendedPath(context) {
  return context !== "trigger" && context !== "body" && !isRecordingActive();
}

function markFreshRecordingStep(toNodeId) {
  if (newNodeContext !== "path-new") return;
  const fromNodeId = recording[recording.length - 1];
  freshRecordingNodeIds.add(toNodeId);
  if (fromNodeId && fromNodeId !== toNodeId) freshRecordingEdgeKeys.add(`${fromNodeId}->${toNodeId}`);
}

function addNewNodeFromDialog() {
  const label = els.newNodeInput.value.trim();
  if (!label) return;
  if (newNodeContext === "edit-node") {
    updateNodeLabel(editingNodeId, label);
    editingNodeId = null;
    els.dialog.close();
    render();
    return;
  }
  let existing = state.nodes.find((n) => n.normalizedLabel === normalize(label));
  if (!existing) {
    existing = node(uid(), label);
    state.nodes.push(existing);
    if (isRecordingActive()) temporaryNodeIds.add(existing.id);
    saveState();
  }
  if (shouldCreateIntendedPath(newNodeContext)) addPlannedEdgeFromCurrent(existing.id);
  if (isRecordingActive()) {
    markFreshRecordingStep(existing.id);
    recording.push(existing.id);
    if (recording.length === 1) {
      selectedNodeId = existing.id;
      pathStartId = existing.id;
    }
  }
  if (newNodeContext === "body") {
    recordingBodyPromptDone = true;
    recordingBodySkipped = false;
  }
  syncGuidedAutosave();
  els.dialog.close();
  render();
}

function updateNodeLabel(nodeId, label) {
  const target = state.nodes.find((n) => n.id === nodeId);
  if (!target) return;
  target.label = label;
  target.normalizedLabel = normalize(label);
  target.updatedAt = new Date().toISOString();
  saveState();
}

function addPlannedEdgeFromCurrent(toNodeId) {
  const fromNodeId = recording[recording.length - 1] || selectedNodeId || pathStartId;
  if (!fromNodeId || fromNodeId === toNodeId) return;
  const exists = state.plannedEdges.some((edge) => edge.status !== "archived" && edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId);
  const alreadyObserved = hasObservedEdge(fromNodeId, toNodeId);
  if (!exists && !alreadyObserved) {
    state.plannedEdges.push(plannedEdge(fromNodeId, toNodeId));
    saveState();
  }
}

function hasObservedEdge(fromNodeId, toNodeId) {
  return state.episodes
    .filter((ep) => ep.status === "completed")
    .some((ep) => {
      const ids = orderedIds(ep);
      for (let i = 0; i < ids.length - 1; i += 1) {
        if (ids[i] === fromNodeId && ids[i + 1] === toNodeId) return true;
      }
      return false;
    });
}

function renderNodeMatches() {
  if (newNodeContext === "edit-node") {
    els.nodeMatches.innerHTML = "";
    return;
  }
  const q = normalize(els.newNodeInput.value);
  if (!q) {
    els.nodeMatches.innerHTML = "";
    return;
  }
  const matches = state.nodes
    .filter((n) => n.normalizedLabel.includes(q) || q.includes(n.normalizedLabel))
    .slice(0, 5);
  els.nodeMatches.innerHTML = matches.map((n, index) => {
    const prefix = index === 0 && n.normalizedLabel === q ? "使用已有节点" : "相似节点";
    return `<button type="button" class="node-match" data-use-node="${n.id}">${prefix}：${escapeHtml(n.label)}</button>`;
  }).join("");
  els.nodeMatches.querySelectorAll("[data-use-node]").forEach((button) => {
    button.addEventListener("click", () => {
      if (shouldCreateIntendedPath(newNodeContext)) addPlannedEdgeFromCurrent(button.dataset.useNode);
      if (isRecordingActive()) {
        markFreshRecordingStep(button.dataset.useNode);
        recording.push(button.dataset.useNode);
        if (recording.length === 1) {
          selectedNodeId = button.dataset.useNode;
          pathStartId = button.dataset.useNode;
        }
      }
      if (newNodeContext === "body") {
        recordingBodyPromptDone = true;
        recordingBodySkipped = false;
      }
      els.dialog.close();
      render();
    });
  });
}

function getNode(id) {
  return graph.nodes.find((n) => n.id === id) || state.nodes.find((n) => n.id === id);
}

function formatTime(iso) {
  if (!iso) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(iso));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

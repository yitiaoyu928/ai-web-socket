function createEmptyAgentState() {
  return {
    workspace_configured: false,
    workspace_root: "",
    file_count: 0,
    dir_count: 0,
    language_summary: [],
    important_files: [],
    notes: [],
    tree_preview: [],
    pending: [],
    pending_count: 0,
    awaiting_confirm: false,
    last_action: "",
    updated_at: "",
  };
}

const state = {
  currentTab: null,
  linkStatus: "unlink",
  model: "-----",
  agentState: createEmptyAgentState(),
};

const messages = [];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const value = index === 0 ? Math.round(size) : size.toFixed(1);
  return `${value} ${units[index]}`;
}

function formatTime(value) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function normalizeAgentState(raw) {
  const base = createEmptyAgentState();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  return {
    ...base,
    ...raw,
    language_summary: Array.isArray(raw.language_summary) ? raw.language_summary : [],
    important_files: Array.isArray(raw.important_files) ? raw.important_files : [],
    notes: Array.isArray(raw.notes) ? raw.notes : [],
    tree_preview: Array.isArray(raw.tree_preview) ? raw.tree_preview : [],
    pending: Array.isArray(raw.pending) ? raw.pending : [],
  };
}

function parseWsEnvelope(raw) {
  if (typeof raw !== "string") {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function renderHeader() {
  document.getElementById("model-pill").textContent = `AI: ${state.model}`;
}

function renderConnection() {
  const button = document.getElementById("connect-btn");
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");

  if (state.linkStatus === "link") {
    button.textContent = "断开连接";
    button.className = "btn disconnect";
    dot.className = "dot connected";
    text.textContent = "已连接";
  } else {
    button.textContent = "连接 WebSocket";
    button.className = "btn";
    dot.className = "dot";
    text.textContent = "未连接";
  }
}

function renderAgentStatus() {
  const data = state.agentState || createEmptyAgentState();
  const mode = document.getElementById("agent-mode");
  const stateText = document.getElementById("agent-state-text");
  const action = document.getElementById("agent-action");
  const root = document.getElementById("workspace-root");
  const files = document.getElementById("stat-files");
  const dirs = document.getElementById("stat-dirs");
  const pending = document.getElementById("stat-pending");
  const hint = document.getElementById("agent-hint");
  const pendingList = document.getElementById("pending-list");
  const pendingEmpty = document.getElementById("pending-empty");
  const summaryList = document.getElementById("summary-list");
  const treePreview = document.getElementById("tree-preview");
  const workspaceDetails = document.getElementById("workspace-details");

  if (!data.workspace_configured) {
    mode.textContent = "未初始化";
    mode.className = "mode-pill idle";
    stateText.textContent = "等待设置工作目录";
    action.textContent = data.last_action || "尚未建立本地项目上下文";
    root.textContent = "未设置";
    hint.textContent = "在本地服务启动后，第一条输入应为工作目录路径。";
  } else if (data.awaiting_confirm) {
    mode.textContent = "待保存";
    mode.className = "mode-pill pending";
    stateText.textContent = "等待确认保存";
    action.textContent = data.last_action || "存在待确认保存的编辑";
    root.textContent = data.workspace_root;
    hint.textContent = "当前有暂存编辑，需要在本地服务里执行 save 或 discard。";
  } else {
    mode.textContent = "已就绪";
    mode.className = "mode-pill";
    stateText.textContent = "工作区已就绪";
    action.textContent = data.last_action || "可继续向网页 AI 发送任务";
    root.textContent = data.workspace_root;
    hint.textContent = "工作区已同步到插件，可继续向网页 AI 发送任务。";
  }

  files.textContent = `文件 ${data.file_count || 0}`;
  dirs.textContent = `目录 ${data.dir_count || 0}`;
  pending.textContent = `待保存 ${data.pending_count || 0}`;

  pendingList.innerHTML = "";
  if (data.pending.length === 0) {
    pendingEmpty.style.display = "block";
  } else {
    pendingEmpty.style.display = "none";
    const fragment = document.createDocumentFragment();
    data.pending.forEach((item) => {
      const li = document.createElement("li");
      li.className = "list-item";
      const title = document.createElement("strong");
      title.textContent = item.rel_path || "(unknown)";
      const meta = document.createElement("div");
      meta.className = "subtle";
      meta.textContent = `${item.existed ? "更新" : "新建"} · staged ${formatBytes(item.bytes)} · original ${formatBytes(item.original_size)}`;
      li.appendChild(title);
      li.appendChild(meta);
      fragment.appendChild(li);
    });
    pendingList.appendChild(fragment);
  }

  summaryList.innerHTML = "";
  const summaryItems = [];
  if (data.language_summary.length > 0) {
    summaryItems.push(`语言分布: ${data.language_summary.join(", ")}`);
  }
  if (data.important_files.length > 0) {
    summaryItems.push(`关键文件: ${data.important_files.slice(0, 5).join(", ")}`);
  }
  if (data.notes.length > 0) {
    summaryItems.push(...data.notes.slice(0, 4));
  }
  if (data.updated_at) {
    summaryItems.push(`最近更新: ${formatTime(data.updated_at)}`);
  }

  if (summaryItems.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "工作区摘要尚未生成。";
    summaryList.appendChild(li);
  } else {
    const fragment = document.createDocumentFragment();
    summaryItems.forEach((text) => {
      const li = document.createElement("li");
      li.className = "list-item";
      li.textContent = text;
      fragment.appendChild(li);
    });
    summaryList.appendChild(fragment);
  }

  if (data.workspace_configured) {
    workspaceDetails.style.display = "block";
    treePreview.textContent =
      data.tree_preview && data.tree_preview.length > 0
        ? data.tree_preview.join("\n")
        : "暂无目录树预览";
  } else {
    workspaceDetails.style.display = "none";
    treePreview.textContent = "";
  }
}

function renderMessages() {
  const messageLog = document.getElementById("message-log");
  messageLog.innerHTML = "";

  if (messages.length === 0) {
    messageLog.innerHTML = '<div class="empty">暂无消息。</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  messages.forEach((item) => {
    const row = document.createElement("div");
    row.className = "log-item";
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = item.time;
    const content = document.createElement("div");
    content.textContent = item.content;
    row.appendChild(time);
    row.appendChild(content);
    fragment.appendChild(row);
  });
  messageLog.appendChild(fragment);
  messageLog.scrollTop = messageLog.scrollHeight;
}

function addMessage(message) {
  messages.push({
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    content: message,
  });
  if (messages.length > 100) {
    messages.shift();
  }
  renderMessages();
}

function setAgentState(nextState) {
  state.agentState = normalizeAgentState(nextState);
  renderAgentStatus();
}

function connectWs() {
  const wsUrl = document.getElementById("ws-url").value.trim();
  chrome.runtime.sendMessage(
    {
      action: "connect",
      url: wsUrl,
    },
    () => {
      if (chrome.runtime.lastError) {
        addMessage(`连接失败: ${chrome.runtime.lastError.message}`);
        return;
      }
      addMessage("正在连接 WebSocket...");
    },
  );
}

function disconnectWs() {
  chrome.runtime.sendMessage({ action: "disconnect" });
  addMessage("正在断开 WebSocket...");
}

async function notifyCurrentTabConnected() {
  if (!state.currentTab?.id) {
    return;
  }
  await ensureContentScriptReady(state.currentTab.id);
  try {
    await chrome.tabs.sendMessage(state.currentTab.id, { action: "connected" });
  } catch (error) {
    addMessage("当前标签页无法接收连接通知");
  }
}

async function ensureContentScriptReady(tabId) {
  const loaded = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "loaded" }, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        resolve(false);
        return;
      }
      resolve(true);
    });
  });

  if (loaded) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    chrome.tabs.sendMessage(tabId, { action: "loaded" }, () => {});
  } catch (error) {
    addMessage("当前标签页未注入内容脚本");
  }
}

function handleBackgroundMessage(request, sender) {
  if (request.type) {
    switch (request.type) {
      case "connected":
        state.linkStatus = "link";
        renderConnection();
        addMessage(request.message);
        notifyCurrentTabConnected();
        return;
      case "disconnected":
        state.linkStatus = "unlink";
        renderConnection();
        addMessage(request.message);
        return;
      case "error":
        state.linkStatus = "unlink";
        renderConnection();
        addMessage(request.message);
        return;
      case "pageRefreshed":
        addMessage("检测到页面刷新");
        return;
      case "detect":
        if (request.data?.model) {
          state.model = request.data.model;
          renderHeader();
          addMessage(`${request.data.message} ${request.data.model}`);
        }
        return;
      case "agentStatus":
        setAgentState(request.data);
        return;
      case "message": {
        const envelope = parseWsEnvelope(request.data);
        if (envelope?.type === 1001 && typeof envelope.message === "string") {
          addMessage(envelope.message);
        } else if (typeof request.data === "string") {
          addMessage(`收到: ${request.data}`);
        }
        return;
      }
    }
  }

  if (request.action && sender.tab) {
    switch (request.action) {
      case "detect":
        if (request.data?.model) {
          state.model = request.data.model;
          renderHeader();
          addMessage(`${request.data.message} ${request.data.model}`);
        }
        break;
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  renderHeader();
  renderConnection();
  renderAgentStatus();
  renderMessages();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    state.currentTab = tab;
  }

  chrome.runtime.sendMessage({ action: "getStatus" }, (response) => {
    if (!response) {
      return;
    }
    state.linkStatus = response.linkStatus || "unlink";
    if (Array.isArray(response.messageHistory) && response.messageHistory.length > 0) {
      messages.splice(0, messages.length, ...response.messageHistory);
    }
    if (response.agentState) {
      setAgentState(response.agentState);
    }
    renderConnection();
    renderMessages();
  });

  const stored = await chrome.storage.local.get(["wsUrl", "model", "agentState"]);
  if (stored.wsUrl) {
    document.getElementById("ws-url").value = stored.wsUrl;
  }
  if (stored.model) {
    state.model = stored.model;
    renderHeader();
  }
  if (stored.agentState) {
    setAgentState(stored.agentState);
  }

  addMessage("插件已初始化");

  if (state.currentTab?.id) {
    await ensureContentScriptReady(state.currentTab.id);
    if (state.linkStatus === "link") {
      notifyCurrentTabConnected();
    }
  }

  document.getElementById("connect-btn").addEventListener("click", () => {
    if (state.linkStatus === "unlink") {
      connectWs();
    } else {
      disconnectWs();
    }
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleBackgroundMessage(request, sender);
    sendResponse?.({ success: true });
    return true;
  });
});

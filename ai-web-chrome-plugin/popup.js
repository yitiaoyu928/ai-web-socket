function createEmptyAgentState() {
  return {
    protocol: "",
    protocol_version: 0,
    session_id: "",
    turn_count: 0,
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
    active_tool_calls: [],
    active_tool_count: 0,
    last_action: "",
    last_stop_reason: "",
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
    active_tool_calls: Array.isArray(raw.active_tool_calls) ? raw.active_tool_calls : [],
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
    button.textContent = "Disconnect";
    button.className = "btn disconnect";
    dot.className = "dot connected";
    text.textContent = "Connected";
  } else {
    button.textContent = "Connect WebSocket";
    button.className = "btn";
    dot.className = "dot";
    text.textContent = "Disconnected";
  }
}

function buildSummaryItems(data) {
  const items = [];

  if (data.language_summary.length > 0) {
    items.push(`Languages: ${data.language_summary.join(", ")}`);
  }
  if (data.important_files.length > 0) {
    items.push(`Important files: ${data.important_files.slice(0, 5).join(", ")}`);
  }
  if (data.notes.length > 0) {
    items.push(...data.notes.slice(0, 4));
  }
  if (data.protocol) {
    const protocolLabel = data.protocol_version
      ? `${data.protocol} v${data.protocol_version}`
      : data.protocol;
    items.push(`Protocol: ${protocolLabel}`);
  }
  if (data.session_id) {
    items.push(`Session: ${data.session_id}`);
  }
  if (Number.isInteger(data.turn_count) && data.turn_count > 0) {
    items.push(`Turns: ${data.turn_count}`);
  }
  const activeToolCount = data.active_tool_count || data.active_tool_calls.length || 0;
  if (activeToolCount > 0) {
    const preview = data.active_tool_calls
      .slice(0, 3)
      .map((item) => `${item.title || item.method || "tool"} (${item.status || "running"})`);
    items.push(`Active tools: ${preview.join(", ")}`);
  }
  if (data.last_stop_reason) {
    items.push(`Stop reason: ${data.last_stop_reason}`);
  }
  if (data.updated_at) {
    items.push(`Updated: ${formatTime(data.updated_at)}`);
  }

  return items;
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
  const activeToolCount = data.active_tool_count || data.active_tool_calls.length || 0;

  if (!data.workspace_configured) {
    mode.textContent = "Idle";
    mode.className = "mode-pill idle";
    stateText.textContent = "Waiting for workspace";
    action.textContent = data.last_action || "No workspace is configured yet.";
    root.textContent = "Not configured";
    hint.textContent = "After the local bridge starts, the first terminal input should be the workspace path.";
  } else if (activeToolCount > 0) {
    mode.textContent = "Running";
    mode.className = "mode-pill";
    stateText.textContent = "Agent is using local tools";
    action.textContent = data.last_action || "ACP-style tool calls are in progress.";
    root.textContent = data.workspace_root;
    hint.textContent = "The bridge is executing local tools. Watch the message log for results.";
  } else if (data.awaiting_confirm) {
    mode.textContent = "Pending";
    mode.className = "mode-pill pending";
    stateText.textContent = "Waiting for save confirmation";
    action.textContent = data.last_action || "There are staged edits waiting for `save` or `discard`.";
    root.textContent = data.workspace_root;
    hint.textContent = "Edits are staged only. Confirm them locally with `save` or `discard`.";
  } else {
    mode.textContent = "Ready";
    mode.className = "mode-pill";
    stateText.textContent = "Workspace synced";
    action.textContent = data.last_action || "You can continue sending tasks to the browser AI.";
    root.textContent = data.workspace_root;
    hint.textContent = "The workspace context is synced and ready for the next turn.";
  }

  files.textContent = `Files ${data.file_count || 0}`;
  dirs.textContent = `Dirs ${data.dir_count || 0}`;
  pending.textContent = `Pending ${data.pending_count || 0} / Tools ${activeToolCount}`;

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
      meta.textContent = `${item.existed ? "update" : "create"} | staged ${formatBytes(item.bytes)} | original ${formatBytes(item.original_size)}`;
      li.appendChild(title);
      li.appendChild(meta);
      fragment.appendChild(li);
    });
    pendingList.appendChild(fragment);
  }

  summaryList.innerHTML = "";
  const summaryItems = buildSummaryItems(data);
  if (summaryItems.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Workspace summary has not been generated yet.";
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
        : "No tree preview yet.";
  } else {
    workspaceDetails.style.display = "none";
    treePreview.textContent = "";
  }
}

function renderMessages() {
  const messageLog = document.getElementById("message-log");
  messageLog.innerHTML = "";

  if (messages.length === 0) {
    messageLog.innerHTML = '<div class="empty">No messages yet.</div>';
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
        addMessage(`Connect failed: ${chrome.runtime.lastError.message}`);
        return;
      }
      addMessage("Connecting WebSocket...");
    },
  );
}

function disconnectWs() {
  chrome.runtime.sendMessage({ action: "disconnect" });
  addMessage("Disconnecting WebSocket...");
}

async function notifyCurrentTabConnected() {
  if (!state.currentTab?.id) {
    return;
  }
  await ensureContentScriptReady(state.currentTab.id);
  try {
    await chrome.tabs.sendMessage(state.currentTab.id, { action: "connected" });
  } catch (error) {
    addMessage("The current tab could not receive the connection notice.");
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
    addMessage("The content script could not be injected into the current tab.");
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
        addMessage("Detected page refresh.");
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
          addMessage(`Received: ${request.data}`);
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

  addMessage("Popup initialized.");

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

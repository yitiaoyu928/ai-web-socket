// background.js - 持久化 WebSocket 连接
let ws = null;
let wsUrl = "ws://localhost:8899/ws";
let linkStatus = "unlink";
let timer = null;
let messageHistory = [];
let currentTabId = null;

// 初始化 WebSocket 连接
function connectWebSocket(url) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log("WebSocket 已连接");
    return;
  }

  wsUrl = url || wsUrl;
  chrome.storage.local.set({ wsUrl });

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Background: WebSocket 连接成功");
    linkStatus = "link";
    broadcastToAll({ type: "connected", message: "WebSocket 连接成功" });
    startHeartbeat();
    if (currentTabId) {
      chrome.tabs
        .sendMessage(currentTabId, { action: "connected" })
        .catch(() => {});
    }
  };

  ws.onclose = (event) => {
    console.log("Background: WebSocket 连接关闭", event.code, event.reason);
    linkStatus = "unlink";
    stopHeartbeat();
    broadcastToAll({ type: "disconnected", message: "WebSocket 连接关闭" });
  };

  ws.onmessage = (event) => {
    console.log("Background: 收到消息", event.data);
    const rawData =
      typeof event.data === "string" ? event.data : String(event.data ?? "");
    let parsedData = null;
    try {
      parsedData = JSON.parse(rawData);
      if (parsedData.type === 10001) {
        return;
      }
    } catch (e) {}
    const historyContent =
      parsedData?.data ?? parsedData?.message ?? parsedData?.content ?? rawData;
    const message = {
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      content:
        typeof historyContent === "string"
          ? historyContent
          : JSON.stringify(historyContent),
    };
    messageHistory.push(message);
    if (messageHistory.length > 100) messageHistory.shift();
    broadcastToContentScripts({ action: "message_receive", data: rawData });
    broadcastToAll({ type: "message", data: rawData });
  };

  ws.onerror = (error) => {
    console.error("Background: WebSocket 错误", error);
    linkStatus = "unlink";
    stopHeartbeat();
    broadcastToAll({ type: "error", message: "WebSocket 连接错误" });
  };
}

// 断开 WebSocket
function disconnectWebSocket() {
  if (ws) {
    ws.close(1000, "用户主动断开");
    ws = null;
  }
  stopHeartbeat();
}

// 心跳检测
function startHeartbeat() {
  stopHeartbeat();
  timer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 10001, message: "heartbeat" }));
    }
  }, 5000);
}

function stopHeartbeat() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// 向所有打开的 Popup 和 Content Script 广播消息
function broadcastToAll(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// 向所有标签页的 content script 广播消息
function broadcastToContentScripts(message) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {
          // 忽略发送失败的标签页（可能是特殊页面如chrome://等）
        });
      }
    });
  });
}

// 监听来自 Popup 或 Content Script 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case "connect":
      connectWebSocket(request.url);
      sendResponse({ success: true, status: linkStatus });
      break;

    case "disconnect":
      disconnectWebSocket();
      sendResponse({ success: true });
      break;

    case "getStatus":
      sendResponse({
        linkStatus,
        wsUrl,
        messageHistory,
      });
      break;

    case "sendMessage":
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(request.data);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: "WebSocket 未连接" });
      }
      break;

    case "pageRefreshed":
      currentTabId = sender.tab?.id;
      broadcastToAll({ type: "pageRefreshed", data: request.data });
      sendResponse({ success: true });
      break;

    case "detect":
      currentTabId = sender.tab?.id;
      console.log("Background: 收到 detect 消息，AI 模型:", request.data.model);
      chrome.storage.local.set({ model: request.data.model });
      broadcastToAll({ type: "detect", data: request.data });
      sendResponse({ success: true });
      break;

    case "injectHookMainWorld":
      if (!sender.tab?.id) {
        sendResponse({ success: false, error: "无法获取标签页" });
        break;
      }
      chrome.scripting
        .executeScript({
          target: { tabId: sender.tab.id, allFrames: true },
          files: ["injected.js"],
          world: "MAIN",
        })
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: error?.message || "注入失败",
          });
        });
      break;

    default:
      sendResponse({ success: false, error: "未知操作" });
  }

  return true;
});

// Service Worker 安装时恢复状态
chrome.runtime.onInstalled.addListener(() => {
  console.log("Background Service Worker 已安装");
  chrome.storage.local.get(["wsUrl"], (result) => {
    if (result.wsUrl) {
      wsUrl = result.wsUrl;
    }
  });
});

// 转发消息
// 存储未完成的流，按 requestId 拼接
const streamBuffers = new Map();
const streamParseStates = new Map();
let hookMessageCount = 0;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.source !== "ext_hook") return;
  console.log(msg);
  const { payload } = msg;
  if (!payload || !payload.type) return;
  hookMessageCount += 1;
  if (hookMessageCount <= 5 || hookMessageCount % 20 === 0) {
    console.log("[Background Hook] received", {
      count: hookMessageCount,
      type: payload.type,
      url: payload.url,
      tabId: sender?.tab?.id,
    });
  }

  // ── XHR 或非流式 Fetch ──────────────────────────────────────
  if (payload.type === "xhr" || payload.type === "fetch") {
    // handleComplete(payload, sender);
    return;
  }

  // ── 流式 Fetch：逐块拼接 ─────────────────────────────────────
  if (payload.type === "fetch_stream") {
    const { requestId } = payload;

    if (!streamBuffers.has(requestId)) {
      streamBuffers.set(requestId, { chunks: [], meta: payload });
    }

    const buf = streamBuffers.get(requestId);

    if (payload.chunk !== null) {
      buf.chunks.push(payload.chunk);
      onStreamChunk(payload);
    }
    if (payload.done) {
      streamParseStates.delete(requestId);
      streamBuffers.delete(requestId);
    }
  }
});

function flushSseFrame(requestId, state) {
  if (!state || !state.dataLines || state.dataLines.length === 0) {
    return;
  }
  const dataText = state.dataLines.join("\n").trim();
  state.dataLines = [];
  if (!dataText || dataText === "[DONE]") {
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(dataText);
  } catch (error) {
    return;
  }
  const eventType = state.event || parsed?.type || "message";
  if (
    parsed?.type === "content_block_start" &&
    parsed?.content_block?.type === "tool_use"
  ) {
    const indexKey = String(parsed?.index ?? "");
    state.toolInputs[indexKey] = "";
  }
  if (
    parsed?.type === "content_block_delta" &&
    parsed?.delta?.type === "input_json_delta"
  ) {
    const indexKey = String(parsed?.index ?? "");
    const partialJson = parsed?.delta?.partial_json || "";
    state.toolInputs[indexKey] = (state.toolInputs[indexKey] || "") + partialJson;
    if (!state.fileState) {
      state.fileState = {};
    }
    const fileState = state.fileState[indexKey] || {
      hasPath: false,
      inFileText: false,
    };
    if (!fileState.hasPath && partialJson.includes("\"path\"")) {
      fileState.hasPath = true;
    }
    if (!fileState.inFileText && partialJson.includes("\"file_text\"")) {
      fileState.inFileText = true;
    }
    if (fileState.inFileText) {
      sendToWebSocket({
        type: 1001,
        message: partialJson,
      });
    }
    state.fileState[indexKey] = fileState;
  }
  if (eventType === "content_block_stop" || parsed?.type === "content_block_stop") {
    const indexKey = String(parsed?.index ?? "");
    const inputText = state.toolInputs[indexKey] || "";
    if (inputText) {
      let inputJson = null;
      try {
        inputJson = JSON.parse(inputText);
      } catch (error) {}
      const questions = extractQuestions(inputJson);
      if (questions.length > 0) {
        sendToWebSocket({
          type: 2001,
          message: JSON.stringify({ questions }),
        });
      }
      const filePayload = extractFilePayload(inputJson);
      if (filePayload) {
        sendToWebSocket({
          type: 3002,
          message: JSON.stringify(filePayload),
        });
      }
      delete state.toolInputs[indexKey];
    }
    if (state.fileState && state.fileState[indexKey]) {
      delete state.fileState[indexKey];
    }
  }
  const content =
    parsed?.choices?.[0]?.delta?.content ||
    parsed?.delta?.text ||
    parsed?.content_block?.text ||
    "";
  if (content) {
    sendToWebSocket({
      type: 1001,
      message: content,
    });
  }
}

function extractQuestions(data) {
  const rawList = Array.isArray(data?.questions)
    ? data.questions
    : Array.isArray(data)
      ? data
      : [];
  const list = [];
  for (const item of rawList) {
    const question = typeof item?.question === "string" ? item.question.trim() : "";
    const options = Array.isArray(item?.options)
      ? item.options
          .filter((x) => typeof x === "string")
          .map((x) => x.trim())
          .filter((x) => x.length > 0)
      : [];
    if (question && options.length > 0) {
      list.push({ question, options });
    }
  }
  return list;
}

function extractFilePayload(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  if (typeof data.path === "string" && typeof data.file_text === "string") {
    return {
      path: data.path,
      file_text: data.file_text,
    };
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const hit = extractFilePayload(item);
      if (hit) {
        return hit;
      }
    }
    return null;
  }
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (value && typeof value === "object") {
      const hit = extractFilePayload(value);
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}

function onStreamChunk(payload) {
  if (!payload?.requestId || typeof payload.chunk !== "string") {
    return;
  }
  const requestId = payload.requestId;
  const state = streamParseStates.get(requestId) || {
    carry: "",
    event: "message",
    dataLines: [],
    toolInputs: {},
    fileState: {},
  };

  state.carry += payload.chunk;
  const lines = state.carry.split(/\r?\n/);
  state.carry = lines.pop() || "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushSseFrame(requestId, state);
      state.event = "message";
      continue;
    }
    if (line.startsWith("event:")) {
      state.event = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      state.dataLines.push(line.slice(5).trim());
    }
  }

  if (payload.done) {
    flushSseFrame(requestId, state);
    streamParseStates.delete(requestId);
    return;
  }
  streamParseStates.set(requestId, state);
}

// 通过 WebSocket 发送数据到服务端
function sendToWebSocket(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
      console.log("[WebSocket] 已发送拦截数据:", message.type);
    } catch (error) {
      console.error("[WebSocket] 发送失败:", error);
    }
  } else {
    console.warn("[WebSocket] 连接未建立，无法发送数据");
  }
}

// 完整响应就绪
function handleComplete(data, sender) {
  const tabId = sender?.tab?.id ?? "unknown";
  console.log(`[${data.type.toUpperCase()}] tab=${tabId}`, {
    url: data.url,
    method: data.method,
    status: data.status,
    size: data.body?.length ?? 0,
    body: data.body?.slice(0, 200), // 只打印前 200 字符，自行调整
  });
  console.log(1111111, data.body);
  // 通过 WebSocket 发送到 WS 服务
  sendToWebSocket({
    type: 1001,
    message: data.body,
  });
}

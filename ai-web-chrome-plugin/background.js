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

    // 过滤心跳包消息
    try {
      const data = JSON.parse(event.data);
      if (data.type === 10001) {
        return;
      }
    } catch (e) {
      // 如果不是 JSON 格式，继续处理
    }

    const message = {
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      content: event.data.data,
    };
    messageHistory.push(message);
    if (messageHistory.length > 100) messageHistory.shift();
    broadcastToAll({ type: "message", data: event.data });
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
      ws.send(JSON.stringify({ type: 10001, data: "heartbeat" }));
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
      // 只记录当前 Tab ID，不广播（Popup 会直接收到 Content Script 的消息）
      console.log("Background: 收到 detect 消息，AI 模型:", request.data.model);
      sendResponse({ success: true });
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

console.log("Background Service Worker 已启动");

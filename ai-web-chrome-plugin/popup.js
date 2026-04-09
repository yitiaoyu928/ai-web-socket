let state = { currentTab: null, linkStatus: "unlink", ws: null };
let messages = [];
let messageRef = null;
let p = new Proxy(state, {
  get: (target, key) => target[key],
  set: (target, key, value) => {
    target[key] = value;
    updateStatus();
    return true;
  },
});
let pMessage = new Proxy(messages, {
  get: (target, key) => target[key],
  set: (target, key, value) => {
    target[key] = value;
    updateMessage();
    return true;
  },
});
function linkWs() {
  const wsUrl = document.querySelector("#ws-url");
  p.ws = new WebSocket(wsUrl.value);
  console.log(p.ws)
  p.ws.onopen = () => {
    console.log("WebSocket 连接成功");
    addMessage("WebSocket 连接成功");
    p.linkStatus = "link";
  };
  p.ws.onclose = () => {
    console.log("WebSocket 连接关闭");
    addMessage("WebSocket 连接关闭");
    p.linkStatus = "unlink";
  };
  p.ws.onmessage = (event) => {
    console.log(event);
  };
}
function updateStatus() {
  let status = document.getElementById("status");
  let btn = document.getElementById("connect-btn");
  btn.textContent = p.linkStatus === "link" ? "断开连接" : "连接 WebSocket";
  status.textContent = p.linkStatus === "link" ? "已连接" : "未连接";
  status.className =
    p.linkStatus === "link" ? "status connected" : "status disconnected";
}
function updateMessage() {
  if (!messageRef) {
    messageRef = document.getElementById("message-log");
  }
  // 清空现有内容
  messageRef.innerHTML = "";

  let fragment = document.createDocumentFragment();
  pMessage.forEach((item) => {
    let messageElement = document.createElement("div");
    messageElement.textContent = `[${item.time}] ${item.content}`;
    fragment.appendChild(messageElement);
  });
  messageRef.appendChild(fragment);

  // 自动滚动到底部
  messageRef.scrollTop = messageRef.scrollHeight;
}
function addMessage(message) {
  pMessage.push({
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    content: message,
  });
}
// 页面加载时检查状态
document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    console.error("无法获取当前标签页");
    return;
  }
  p.currentTab = tab;
  addMessage("初始化完毕！");
  // 先注入 content script
  await chrome.scripting.executeScript({
    target: { tabId: p.currentTab.id },
    files: ["content.js"],
  });

  // 确认就绪后再发送业务消息
  chrome.tabs.sendMessage(p.currentTab.id, { action: "loaded" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("发送 loaded 消息失败:", chrome.runtime.lastError.message);
      return;
    }
    const connectBtn = document.getElementById("connect-btn");
    connectBtn.addEventListener("click", () => {
      if (p.linkStatus === "unlink") {
        linkWs();
      } else {
        console.log(p.ws)
        p.ws.close(1000, "正常关闭");
      }
    });
  });
});

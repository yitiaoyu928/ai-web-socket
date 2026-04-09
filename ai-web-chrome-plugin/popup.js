let state = {
  currentTab: null,
  linkStatus: "unlink",
  ws: null,
  model: "-----",
};
let messages = [];
let messageRef = null;
let timer = null;
let p = new Proxy(state, {
  get: (target, key) => target[key],
  set: (target, key, value) => {
    target[key] = value;
    // if (key === "linkStatus" || key === "wsUrl") {
    // }
    updateStatus();
    return true;
  },
});
let pMessage = new Proxy(messages, {
  get: (target, key) => target[key],
  set: (target, key, value) => {
    target[key] = value;
    // if (key === "messages") {
    //   chrome.storage.local.set({ messages: p.messages });
    // }
    updateMessage();
    return true;
  },
});
function linkWs() {
  const wsUrl = document.querySelector("#ws-url");
  p.ws = new WebSocket(wsUrl.value);
  p.ws.onopen = () => {
    addMessage("WebSocket 连接成功");
    p.linkStatus = "link";
    chrome.tabs.sendMessage(p.currentTab.id, { action: "connected" });
  };
  p.ws.onclose = () => {
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
function heartbeat() {
  timer = setInterval(() => {
    if (p.linkStatus === "link") {
      p.ws.send(
        JSON.stringify({
          type: 10001,
          data: "heartbeat",
        }),
      );
    } else {
      clearInterval(timer);
      timer = null;
    }
  }, 5000);
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

  // 从存储中恢复状态
  //  p.linkStatus

  updateMessage();
  document.querySelector(".title").innerHTML = "当前AI:" + p.model;
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
        heartbeat();
      } else {
        clearInterval(timer);
        timer = null;
        p.ws.close(1000, "正常关闭");
      }
    });
  });
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case "detect":
        document.querySelector(".title").innerHTML =
          "当前AI:" + request.data.model;
        p.model = request.data.model;
        addMessage(`${request.data.message} ${request.data.model}`);
        break;
    }
  });
});

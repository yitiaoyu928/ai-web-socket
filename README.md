# ai-web-socket

`ai-web-socket` 是一个本地 AI 协作桥接服务。它把浏览器里的 AI 网页聊天界面和本地代码工作区连接起来，让你继续在 Qwen、Claude、ChatGPT 这类网页里对话，同时让 AI 能通过受控方式读取项目、搜索代码、执行短命令，并提交“待确认保存”的文件修改。

它不直接调用模型 API，而是由以下几部分协作完成：

- 本地 Go 服务负责维护工作区、执行工具调用、暂存编辑结果、广播状态。
- Chrome 扩展负责连接本地 WebSocket、向网页聊天框自动发送消息、解析 AI 返回的结构化工具请求。
- 浏览器 AI 页面继续承担对话和推理本身。

## 适用场景

- 希望继续使用网页端 AI，而不是改造为直连 API 的工作流。
- 需要让 AI 基于本地项目目录做代码阅读、排查、重构建议和修改草案。
- 不希望 AI 直接覆盖磁盘文件，而是先暂存，等你人工确认后再落盘。

## 核心能力

### 1. 工作区摘要自动注入

本地服务启动后，第一条终端输入应为工作区目录。服务会扫描该目录并生成摘要，包括：

- 文件数、目录数
- 语言分布
- 重要文件
- 目录树预览
- 项目特征备注

扩展连接成功后，这份摘要会自动发送给浏览器 AI，帮助它快速建立上下文。

### 2. 本地工具调用

当前桥接层支持以下 ACP 风格方法：

- `fs/read_text_file`
- `fs/write_text_file`
- `_workspace/workspace_summary`
- `_workspace/read_text_files`
- `_workspace/list_dir`
- `_workspace/search_text`
- `_workspace/run_command`
- `terminal/create`
- `terminal/output`
- `terminal/wait_for_exit`
- `terminal/kill`
- `terminal/release`

其中：

- 读取类工具用于按需补充上下文。
- `_workspace/run_command` 适合执行短命令，例如 `go test ./...`。
- `terminal/*` 适合需要持续句柄的命令。
- `fs/write_text_file` 不会直接写盘，只会进入待确认暂存区。

### 3. 暂存后确认写盘

当 AI 生成文件修改时，本地服务会先把结果放入 pending 区，而不是立即覆盖原文件。你可以先查看、对比，再决定是否保存：

- `pending` 查看待保存文件列表
- `show [path]` 查看暂存内容
- `orig [path]` 查看原始内容
- `save [path]` 保存全部或单个文件
- `discard [path]` 丢弃全部或单个文件

### 4. 插件状态面板

扩展 `popup` 会显示当前桥接状态，包括：

- WebSocket 是否已连接
- 当前识别到的 AI 页面
- 工作区路径
- 文件数和目录数
- pending 编辑数量
- 正在执行的工具调用
- 最近动作和消息日志

## 支持的网站

当前 `manifest.json` 已配置以下页面：

- `https://chat.qwen.ai/*`
- `https://claude.ai/*`
- `https://chatgpt.com/*`

如果要接入更多站点，需要继续扩展扩展权限、页面识别逻辑和 DOM 选择器。

## 工作流程

```text
Terminal
  -> ai-web-socket
  -> Chrome Extension
  -> Browser AI Page
  -> Chrome Extension extracts structured blocks
  -> ai-web-socket executes tools or stages edits
  -> result goes back to Browser AI Page
```

更具体一点：

1. 在本地启动 `ai-web-socket`。
2. 在 Chrome 中加载扩展并连接 `ws://localhost:8899/ws`。
3. 在终端输入工作区路径。
4. 本地服务生成工作区摘要，并把 bootstrap prompt 发给浏览器 AI。
5. 你继续在网页里提问。
6. AI 若需要更多上下文，会输出结构化工具调用。
7. 扩展提取这些结构化块并转发给本地服务。
8. 本地服务返回 `[ACP Tool Result]`，AI 基于结果继续工作。
9. 若 AI 提交文件改动，本地只暂存，需你在终端执行 `save` 确认。

## 项目结构

```text
.
|-- main.go
|-- acp_bridge.go
|-- go.mod
|-- go.sum
|-- README.md
`-- ai-web-chrome-plugin/
    |-- manifest.json
    |-- background.js
    |-- content.js
    |-- injected.js
    |-- popup.html
    |-- popup.js
    `-- ai_search.png
```

关键文件说明：

- `main.go`：本地 WebSocket 服务、工作区扫描、pending 编辑管理、CLI 交互。
- `acp_bridge.go`：ACP 方法桥接、命令执行、终端句柄管理、工具结果格式化。
- `ai-web-chrome-plugin/background.js`：扩展后台，维护 WebSocket、提取结构化输出、转发消息。
- `ai-web-chrome-plugin/content.js`：注入 AI 页面，识别输入框并自动填充发送消息。
- `ai-web-chrome-plugin/injected.js`：监听页面内请求与流式响应，协助提取结构化输出。
- `ai-web-chrome-plugin/popup.*`：扩展状态面板和交互界面。

## 环境要求

- Go 1.24.3 或兼容版本
- Chrome / Chromium
- 可访问的 Qwen、Claude 或 ChatGPT 网页

## 快速开始

### 1. 启动本地服务

在项目根目录执行：

```bash
go run . serve
```

也可以先构建：

```bash
go build -o ai-web-socket.exe
./ai-web-socket.exe serve
```

默认地址：

```text
ws://localhost:8899/ws
```

指定端口：

```bash
go run . serve -p 8899
```

### 2. 加载 Chrome 扩展

1. 打开扩展管理页。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择目录 `ai-web-chrome-plugin`。

### 3. 打开支持的 AI 页面

任选其一：

- Qwen
- Claude
- ChatGPT

### 4. 在插件弹窗中连接本地服务

默认地址就是：

```text
ws://localhost:8899/ws
```

连接成功后，弹窗会显示连接状态和当前工作区状态。

### 5. 在终端输入工作区路径

服务启动后，第一条输入应为工作区目录，例如：

```text
D:\project\my-app
```

服务会扫描该目录，并在浏览器端连接存在时自动发送 bootstrap prompt。

如果需要重新发送上下文，可在终端执行：

```text
:context
```

## 终端命令

本地服务支持以下交互命令：

- `:root <dir>` 切换工作区
- `:context` 重新发送当前工作区上下文
- `:summary` 打印当前工作区摘要
- `pending` 查看待确认保存的编辑
- `show [path]` 查看暂存内容
- `orig [path]` 查看原始内容
- `save [path]` 保存全部或单个暂存文件
- `discard [path]` 丢弃全部或单个暂存文件
- `help` 打印帮助

除以上命令外，其他终端输入会被转发给浏览器 AI。

当存在 pending 编辑时，新的普通指令不会继续发送，直到你执行 `save` 或 `discard`。

## 浏览器 AI 输出格式

扩展会从 AI 输出中提取结构化块。推荐使用 ACP 风格调用：

### ACP 风格

读取单个文件：

```text
<aiws_call>{"method":"fs/read_text_file","params":{"path":"main.go"}}</aiws_call>
```

批量读取文件：

```text
<aiws_call>{"method":"_workspace/read_text_files","params":{"paths":["main.go","acp_bridge.go"]}}</aiws_call>
```

列目录：

```text
<aiws_call>{"method":"_workspace/list_dir","params":{"path":"ai-web-chrome-plugin","depth":2}}</aiws_call>
```

搜索文本：

```text
<aiws_call>{"method":"_workspace/search_text","params":{"query":"websocket","glob":"*.go","maxResults":20}}</aiws_call>
```

执行短命令：

```text
<aiws_call>{"method":"_workspace/run_command","params":{"command":"go","args":["test","./..."],"cwd":"."}}</aiws_call>
```

暂存文件修改：

```text
<aiws_call>{"method":"fs/write_text_file","params":{"path":"README.md","content":"full file contents"}}</aiws_call>
```

创建终端句柄：

```text
<aiws_call>{"method":"terminal/create","params":{"command":"npm","args":["run","dev"],"cwd":"."}}</aiws_call>
```

### 兼容的 legacy 风格

项目仍兼容旧结构：

```text
<aiws_command>{"command":"read_file","path":"main.go"}</aiws_command>
<aiws_command>{"command":"read_files","paths":["main.go","acp_bridge.go"]}</aiws_command>
<aiws_command>{"command":"list_dir","path":"ai-web-chrome-plugin","depth":2}</aiws_command>
<aiws_command>{"command":"search","query":"websocket","glob":"*.go","max_results":20}</aiws_command>
<aiws_file>{"path":"README.md","file_text":"full file contents"}</aiws_file>
<aiws_questions>{"questions":[{"question":"继续哪个方案？","options":["方案 A","方案 B"]}]}</aiws_questions>
```

注意：

- 结构化块必须是合法 JSON。
- 结构化块不能包在 Markdown 代码块里。
- 每次只输出一个结构化块最稳妥。
- `fs/write_text_file` 只是暂存编辑，不代表已经写盘。

## 典型使用方式

### 让网页 AI 分析当前项目

```text
先阅读 main.go、acp_bridge.go 和 ai-web-chrome-plugin/background.js，说明这个项目的整体架构。
```

### 让网页 AI 修改文件，但保留人工确认

```text
先读取 popup.html 和 popup.js，然后帮我优化插件状态区的展示。
```

AI 如果需要改文件，会把完整文件内容提交给本地桥接层。你再在终端里执行：

```text
pending
show ai-web-chrome-plugin/popup.js
save ai-web-chrome-plugin/popup.js
```

## 开发与验证

基础编译检查：

```bash
go test ./...
```

检查扩展脚本语法：

```bash
node --check ai-web-chrome-plugin/background.js
node --check ai-web-chrome-plugin/content.js
node --check ai-web-chrome-plugin/popup.js
```

## 当前限制

- 当前主要依赖网页 DOM 结构和响应拦截逻辑，目标站点改版后可能需要更新选择器或注入逻辑。
- 扩展目前面向 Chrome Manifest V3。
- 保存确认发生在本地终端，不在扩展弹窗里完成。
- pending 预览是文本级查看，不是完整 diff UI。
- 是否能稳定提取结构化块，也会受到不同 AI 页面输出格式影响。

## 设计原则

- AI 可以读本地上下文，但必须通过显式工具调用完成。
- AI 可以生成修改结果，但不能未经确认直接写盘。
- 工作区状态、pending 编辑和工具执行过程都应能在本地被观察到。


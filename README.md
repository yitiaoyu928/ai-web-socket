# ai-web-socket

`ai-web-socket` 是一个本地 AIAgent 桥接项目，用来把“浏览器里的网页 AI”与“本地代码目录”连接起来。

它的核心目标不是直接调用模型 API，而是配合仓库内的 Chrome 插件 `ai-web-chrome-plugin`，让你可以在 Qwen / Claude 网页中继续使用熟悉的聊天界面，同时让 AI 具备以下能力：

- 记录并分析你指定的本地项目目录
- 按需读取文件、列目录、搜索文本
- 生成文件修改草案
- 先暂存编辑结果，只有在你确认后才真正保存到磁盘
- 在插件 popup 中实时查看当前工作区、待保存文件和最近一次动作

## 适用场景

- 想继续在网页端使用 Qwen / Claude，而不是单独接模型 API
- 希望 AI 能基于本地项目目录做分析、问答、改代码
- 希望改动必须经过人工确认，避免模型直接覆盖本地文件

## 当前能力

### 1. 本地项目上下文注入

启动服务后，第一条输入就是项目目录路径。服务会：

- 记录该目录为当前工作区
- 扫描目录结构
- 统计文件和目录数量
- 提取重要文件和扩展名分布
- 生成目录树摘要
- 自动把这些上下文发送给网页 AI

这样后续你在网页里问“这个项目是做什么的”“帮我改某个模块”时，AI 才知道你说的是哪个项目。

### 2. 本地工具调用

网页 AI 不能直接访问你的磁盘，所以它会通过结构化命令向本地服务请求工具能力。

当前支持：

- `read_file`：读取单个文件
- `read_files`：批量读取多个文件
- `list_dir`：查看目录树
- `search`：按关键字搜索文本

### 3. 暂存编辑而不是直接写盘

当网页 AI 生成文件修改结果时：

- 先进入本地“暂存区”
- 不会自动写入磁盘
- 你可以先查看暂存内容
- 只有输入 `save` 后才真正落盘
- 如果输入 `discard`，则丢弃这次暂存，保留磁盘上的原始文件

这套机制适合把 AI 当作“代码助理”，而不是“直接改你文件的自动脚本”。

### 4. 插件状态看板

Chrome 插件 popup 会实时显示：

- WebSocket 连接状态
- 当前 AI 提供方
- 当前工作区目录
- 文件数 / 目录数 / 待保存数量
- 待确认保存的文件列表
- 最近一次动作
- 消息日志

## 项目结构

```text
.
├─ main.go
├─ go.mod
├─ go.sum
├─ ai-web-chrome-plugin/
│  ├─ manifest.json
│  ├─ background.js
│  ├─ content.js
│  ├─ injected.js
│  ├─ popup.html
│  └─ popup.js
└─ ai-web-socket.exe
```

### 关键文件说明

- `main.go`
  本地 WebSocket 服务，负责工作区分析、工具执行、编辑暂存、确认保存、状态广播。

- `ai-web-chrome-plugin/background.js`
  扩展后台 Service Worker，负责维护 WebSocket 连接、转发消息、同步 agent 状态。

- `ai-web-chrome-plugin/content.js`
  注入 Qwen / Claude 页面，负责识别输入框、自动填充消息、点击发送按钮。

- `ai-web-chrome-plugin/injected.js`
  监听页面内网络请求与流式响应，用于提取网页 AI 输出。

- `ai-web-chrome-plugin/popup.html`
  插件弹窗界面。

- `ai-web-chrome-plugin/popup.js`
  插件弹窗逻辑，负责连接服务、展示 agent 状态、显示消息日志。

## 工作流程

```text
本地终端 -> ai-web-socket 服务 -> Chrome 插件 -> Qwen / Claude 网页
                                              |
                                              v
                                   回传 AI 输出 / 工具请求 / 文件草案
```

更具体一点：

1. 你在终端启动本地服务
2. 插件连接本地 WebSocket 服务
3. 你在终端输入项目目录
4. 本地服务分析目录并把摘要发给网页 AI
5. 你在网页中继续提问
6. 如果 AI 需要更多上下文，会请求本地服务读文件 / 列目录 / 搜索
7. 如果 AI 生成文件编辑结果，本地服务先暂存
8. 你在终端用 `save` 或 `discard` 决定是否落盘

## 环境要求

- Go 1.24.x
- Chrome / Chromium 内核浏览器
- 可访问的 Qwen 或 Claude 网页

当前插件 `manifest.json` 中只配置了以下站点：

- `https://chat.qwen.ai/*`
- `https://claude.ai/*`

如果你想支持其他网页 AI，需要继续扩展插件权限和页面选择器。

## 快速开始

### 1. 启动本地服务

在项目根目录执行：

```bash
go run . serve
```

或者先构建：

```bash
go build -o ai-web-socket.exe
./ai-web-socket.exe serve
```

默认监听地址：

```text
ws://localhost:8899/ws
```

也可以手动指定端口：

```bash
go run . serve -p 8899
```

### 2. 加载 Chrome 插件

1. 打开浏览器扩展管理页
2. 开启“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 选择目录 `ai-web-chrome-plugin`

### 3. 打开支持的网页 AI

任选一个：

- Qwen
- Claude

### 4. 在 popup 中连接本地服务

插件默认地址就是：

```text
ws://localhost:8899/ws
```

连接成功后，popup 会显示当前连接状态。

### 5. 在终端输入项目目录

服务启动后，第一条输入必须是工作目录路径，例如：

```text
D:\project\my-app
```

此时本地服务会分析目录并自动把上下文发送给网页 AI。

如果你怀疑上下文没有发过去，可以手动执行：

```text
:context
```

## 推荐使用流程

### 首次进入项目

```text
1. 启动服务
2. 打开网页 AI
3. popup 连接本地服务
4. 在终端输入项目目录
5. 等待上下文注入完成
6. 开始提问
```

### 典型对话示例

```text
告诉我这个项目是做什么的
```

```text
先阅读 main.go 和 ai-web-chrome-plugin/background.js，帮我说明整体架构
```

```text
帮我在 popup 中增加一个按钮，但修改前先读取 popup.html 和 popup.js
```

## 编辑确认机制

这是本项目最重要的安全约束之一。

当 AI 提交文件修改后：

- 文件不会立即保存
- 会先显示为 pending
- 你可以先查看 staged 内容
- 再决定是否保存

### 查看暂存编辑

```text
pending
show
show ai-web-chrome-plugin/popup.js
orig ai-web-chrome-plugin/popup.js
```

### 确认保存

保存全部暂存文件：

```text
save
```

只保存某一个文件：

```text
save ai-web-chrome-plugin/popup.js
```

### 放弃编辑

丢弃全部暂存文件：

```text
discard
```

只丢弃某一个文件：

```text
discard ai-web-chrome-plugin/popup.js
```

## 终端命令

本地服务支持以下交互命令：

- `:root <dir>`
  切换工作区目录

- `:context`
  重新把当前工作区上下文发给网页 AI

- `:summary`
  打印当前工作区摘要

- `pending`
  查看待保存的暂存编辑

- `show [path]`
  查看暂存内容

- `orig [path]`
  查看磁盘上的原始内容

- `save [path]`
  保存全部或指定暂存文件

- `discard [path]`
  丢弃全部或指定暂存文件

- `help`
  查看帮助

## 插件说明

### popup 的作用

popup 不是直接操作网页 DOM 的地方，它主要负责：

- 连接 / 断开 WebSocket
- 显示当前 agent 状态
- 显示消息日志
- 在连接成功后通知当前标签页进入可自动填充状态

### content script 的作用

`content.js` 才是真正负责自动填充网页输入框和点击发送按钮的脚本。

它会：

- 识别当前页面属于 Qwen 还是 Claude
- 找到输入框和发送按钮
- 把本地服务转发来的 `1001` 文本消息填入输入区域
- 自动触发发送

如果你发现“popup 连上了，但网页没有自动发消息”，优先检查：

1. 当前页面是否是 Qwen / Claude
2. 内容脚本是否已经注入
3. 页面结构是否发生变化，导致选择器失效

## 与网页 AI 的协作方式

本地服务会在上下文注入时告诉网页 AI：

- 不能直接假装读取了本地文件
- 如果需要上下文，必须显式请求本地工具
- 如果要改文件，必须输出完整文件草案
- 不能声称已经保存

这让网页 AI 更像一个“通过工具工作的 agent”，而不是只会自由发挥的聊天模型。

## 开发说明

### 运行测试

当前仓库没有单元测试文件，但可以做基本编译检查：

```bash
go test ./...
```

### 插件脚本语法检查

```bash
node --check ai-web-chrome-plugin/background.js
node --check ai-web-chrome-plugin/popup.js
node --check ai-web-chrome-plugin/content.js
```

## 当前限制

- 当前只支持 Qwen 和 Claude 页面
- 页面 DOM 结构变化时，`content.js` 的选择器可能需要更新
- 目前保存确认是在终端完成的，不是在 popup 中完成
- 当前没有做真正的 diff 视图，只能查看 staged / original 文本
- 本地工具能力目前聚焦在代码阅读和文件编辑，尚未扩展为更完整的命令执行代理

## 后续可扩展方向

- 在 popup 中增加“重新发送上下文”按钮
- 在 popup 中增加暂存文件 diff 预览
- 支持更多网页 AI 提供方
- 增加更细粒度的目录白名单 / 黑名单控制
- 增加文件级别的变更历史与回滚能力

## 许可证

当前仓库未声明许可证。如需开源发布，建议补充 `LICENSE` 文件。

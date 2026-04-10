package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/spf13/cobra"
)

// Hub 管理所有客户端连接
type Hub struct {
	mu        sync.RWMutex
	clients   map[*websocket.Conn]bool
	broadcast chan []byte
}
type UMessage struct {
	Msg   string `json:"message"`
	MType int32  `json:"type"`
}

type QuestionItem struct {
	Question string   `json:"question"`
	Options  []string `json:"options"`
}

type QuestionPacket struct {
	Questions []QuestionItem `json:"questions"`
}

type PromptSession struct {
	Questions []QuestionItem
	Answers   []string
	Current   int
}

type FilePayload struct {
	Path     string `json:"path"`
	FileText string `json:"file_text"`
}

func newHub() *Hub {
	return &Hub{
		clients:   make(map[*websocket.Conn]bool),
		broadcast: make(chan []byte, 256),
	}
}

func (h *Hub) register(conn *websocket.Conn) {
	h.mu.Lock()
	h.clients[conn] = true
	h.mu.Unlock()
	fmt.Printf("[+] 客户端接入: %s (当前连接数: %d)\n", conn.RemoteAddr(), len(h.clients))
}

func (h *Hub) unregister(conn *websocket.Conn) {
	h.mu.Lock()
	delete(h.clients, conn)
	h.mu.Unlock()
	conn.Close()
	fmt.Printf("[-] 客户端断开: %s (当前连接数: %d)\n", conn.RemoteAddr(), len(h.clients))
}

// 广播消息给所有客户端
func (h *Hub) run() {
	for msg := range h.broadcast {
		h.mu.RLock()
		for conn := range h.clients {
			err := conn.WriteMessage(websocket.TextMessage, msg)
			if err != nil {
				log.Printf("发送失败 %s: %v", conn.RemoteAddr(), err)
				// 放到后台清理，避免死锁
				go h.unregister(conn)
			}
		}
		h.mu.RUnlock()
	}
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "启动 WebSocket 服务端，通过 CLI 向客户端发消息",
	Run: func(cmd *cobra.Command, args []string) {
		port, _ := cmd.Flags().GetString("port")
		hub := newHub()
		var inputMu sync.Mutex
		var promptMu sync.Mutex
		var promptSession *PromptSession

		// 启动广播协程
		go hub.run()

		// WebSocket 路由
		http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				log.Println("升级失败:", err)
				return
			}
			hub.register(conn)

			// 每个客户端单独一个协程接收消息（也可以处理客户端上行数据）
			go func() {
				defer hub.unregister(conn)
				for {
					_, msg, err := conn.ReadMessage()
					if err != nil {
						break
					}

					if msg != nil {
						// 解析 JSON
						var uMsg UMessage
						err := json.Unmarshal(msg, &uMsg)
						if err != nil {
							log.Println("json unmarshal error:", err)
							continue
						}
						if uMsg.MType == 10001 {
							continue
						}
						if uMsg.MType == 2001 {
							var packet QuestionPacket
							if err := json.Unmarshal([]byte(uMsg.Msg), &packet); err != nil {
								log.Println("question packet unmarshal error:", err)
								continue
							}
							if len(packet.Questions) == 0 {
								continue
							}
							promptMu.Lock()
							promptSession = &PromptSession{
								Questions: packet.Questions,
								Answers:   make([]string, 0, len(packet.Questions)),
								Current:   0,
							}
							showPromptQuestion(promptSession)
							promptMu.Unlock()
							continue
						}
						if uMsg.MType == 3002 {
							var payload FilePayload
							if err := json.Unmarshal([]byte(uMsg.Msg), &payload); err != nil {
								log.Println("file payload unmarshal error:", err)
								continue
							}
							savedPath, err := saveFilePayload(payload)
							if err != nil {
								log.Println("save file error:", err)
								continue
							}
							fmt.Printf("\n[文件已保存] %s\n", savedPath)
							continue
						}
						fmt.Print(string(uMsg.Msg))
						// 广播消息给所有客户端
						// hub.broadcast <- msg
						// fmt.Printf("[客户端 %s]: %s\n", conn.RemoteAddr(), msg)
					}
				}
			}()
		})

		// 启动 HTTP 服务
		go func() {
			fmt.Printf("WebSocket 服务已启动: ws://0.0.0.0:%s/ws\n", port)
			fmt.Println("输入消息后回车，即可发送给所有客户端：")
			log.Fatal(http.ListenAndServe(":"+port, nil))
		}()

		// stdin → 广播
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			text := strings.TrimSpace(scanner.Text())
			if text == "" {
				continue
			}
			promptMu.Lock()
			activePrompt := promptSession
			promptMu.Unlock()
			if activePrompt != nil {
				inputMu.Lock()
				index, err := strconv.Atoi(text)
				if err != nil || index < 1 || index > len(activePrompt.Questions[activePrompt.Current].Options) {
					fmt.Println("输入无效，请输入选项编号")
					showPromptQuestion(activePrompt)
					inputMu.Unlock()
					continue
				}
				selected := activePrompt.Questions[activePrompt.Current].Options[index-1]
				activePrompt.Answers = append(activePrompt.Answers, selected)
				activePrompt.Current++
				if activePrompt.Current < len(activePrompt.Questions) {
					showPromptQuestion(activePrompt)
					inputMu.Unlock()
					continue
				}
				formatted := formatQuestionAnswers(activePrompt)
				fmt.Printf("[问答已完成]\n%s\n", formatted)
				promptMu.Lock()
				promptSession = nil
				promptMu.Unlock()
				inputMu.Unlock()
				continue
			}
			var uMsg UMessage
			uMsg.Msg = text
			uMsg.MType = 1001
			jByte, err := json.Marshal(uMsg)
			if err != nil {
				log.Println("json marshal error:", err)
				continue
			}
			hub.broadcast <- jByte
			fmt.Printf("[已发送给 %d 个客户端] %s\n", len(hub.clients), text)
		}
	},
}

func showPromptQuestion(session *PromptSession) {
	if session == nil || session.Current >= len(session.Questions) {
		return
	}
	current := session.Questions[session.Current]
	fmt.Printf("\n[%d/%d] %s\n", session.Current+1, len(session.Questions), current.Question)
	for i, option := range current.Options {
		fmt.Printf("%d) %s\n", i+1, option)
	}
	fmt.Print("请输入选项编号: ")
}

func formatQuestionAnswers(session *PromptSession) string {
	if session == nil {
		return ""
	}
	var b strings.Builder
	for i, q := range session.Questions {
		if i < len(session.Answers) {
			b.WriteString("Q: ")
			b.WriteString(q.Question)
			b.WriteString("\nA: ")
			b.WriteString(session.Answers[i])
			if i != len(session.Questions)-1 {
				b.WriteString("\n\n")
			}
		}
	}
	return b.String()
}

func saveFilePayload(payload FilePayload) (string, error) {
	name := filepath.Base(strings.TrimSpace(payload.Path))
	if name == "" || name == "." || name == string(filepath.Separator) {
		name = "partial_output.txt"
	}
	targetDir := filepath.Join(".", "received_files")
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return "", err
	}
	targetPath := filepath.Join(targetDir, name)
	if err := os.WriteFile(targetPath, []byte(payload.FileText), 0644); err != nil {
		return "", err
	}
	absPath, err := filepath.Abs(targetPath)
	if err != nil {
		return targetPath, nil
	}
	return absPath, nil
}

func init() {
	serveCmd.Flags().StringP("port", "p", "8080", "监听端口")
}

func main() {
	if err := serveCmd.Execute(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}

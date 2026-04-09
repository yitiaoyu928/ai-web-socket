package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
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
					_, _, err := conn.ReadMessage()
					if err != nil {
						break
					}
					// fmt.Printf("[客户端 %s]: %s\n", conn.RemoteAddr(), msg)
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
			text := scanner.Text()
			if text == "" {
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

func init() {
	serveCmd.Flags().StringP("port", "p", "8080", "监听端口")
}

func main() {
	if err := serveCmd.Execute(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}

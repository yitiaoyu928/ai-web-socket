package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // 允许所有来源
	},
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket 升级失败: %v\n", err)
		return
	}
	defer conn.Close()

	clientAddr := r.RemoteAddr
	fmt.Printf("新客户端连接: %s\n", clientAddr)

	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			fmt.Printf("客户端 %s 断开连接: %v\n", clientAddr, err)
			break
		}

		fmt.Printf("收到消息 from %s: %s\n", clientAddr, string(message))

		// 回复客户端
		if err := conn.WriteMessage(messageType, []byte(string(message))); err != nil {
			fmt.Printf("发送消息失败: %v\n", err)
			break
		}
	}
}

func main() {
	http.HandleFunc("/ws", handleWebSocket)

	fmt.Println("WebSocket 服务器启动，监听端口 8899")
	fmt.Println("WebSocket 地址: ws://localhost:8899/ws")
	if err := http.ListenAndServe(":8899", nil); err != nil {
		fmt.Printf("服务器启动失败: %v\n", err)
	}
}

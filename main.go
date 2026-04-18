package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/spf13/cobra"
)

const (
	wsTypeText      int32 = 1001
	wsTypeHeartbeat int32 = 10001
	wsTypeQuestions int32 = 2001
	wsTypeFile      int32 = 3002
	wsTypeCommand   int32 = 4001
	wsTypeAgentInfo int32 = 5001

	maxTreeDepth          = 3
	maxTreeEntries        = 120
	maxCommandFileBytes   = 48 * 1024
	maxCommandSearchHits  = 30
	maxCommandReadFiles   = 6
	maxPendingPreviewSize = 32 * 1024
)

var ignoredDirNames = map[string]bool{
	".git":           true,
	".idea":          true,
	".vscode":        true,
	"node_modules":   true,
	"dist":           true,
	"build":          true,
	".next":          true,
	".turbo":         true,
	".cache":         true,
	"coverage":       true,
	"vendor":         true,
	"received_files": true,
}

type Hub struct {
	mu        sync.RWMutex
	clients   map[*websocket.Conn]bool
	broadcast chan []byte
}

type WSMessage struct {
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

type AgentCommand struct {
	Command    string   `json:"command"`
	Path       string   `json:"path,omitempty"`
	Paths      []string `json:"paths,omitempty"`
	Query      string   `json:"query,omitempty"`
	Glob       string   `json:"glob,omitempty"`
	Depth      int      `json:"depth,omitempty"`
	MaxResults int      `json:"max_results,omitempty"`
	Note       string   `json:"note,omitempty"`
}

type WorkspaceSummary struct {
	RootDir         string
	FileCount       int
	DirCount        int
	ImportantFiles  []string
	LanguageSummary []string
	Tree            []string
	Notes           []string
}

type PendingEdit struct {
	AbsPath      string
	RelPath      string
	OriginalText string
	StagedText   string
	Existed      bool
	UpdatedAt    time.Time
}

type PendingEditInfo struct {
	RelPath      string    `json:"rel_path"`
	Bytes        int       `json:"bytes"`
	OriginalSize int       `json:"original_size"`
	Existed      bool      `json:"existed"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type AgentStatusPayload struct {
	WorkspaceConfigured bool              `json:"workspace_configured"`
	WorkspaceRoot       string            `json:"workspace_root,omitempty"`
	FileCount           int               `json:"file_count,omitempty"`
	DirCount            int               `json:"dir_count,omitempty"`
	LanguageSummary     []string          `json:"language_summary,omitempty"`
	ImportantFiles      []string          `json:"important_files,omitempty"`
	Notes               []string          `json:"notes,omitempty"`
	TreePreview         []string          `json:"tree_preview,omitempty"`
	Pending             []PendingEditInfo `json:"pending,omitempty"`
	PendingCount        int               `json:"pending_count"`
	AwaitingConfirm     bool              `json:"awaiting_confirm"`
	LastAction          string            `json:"last_action,omitempty"`
	UpdatedAt           time.Time         `json:"updated_at,omitempty"`
}

type AgentState struct {
	mu              sync.Mutex
	rootDir         string
	summary         WorkspaceSummary
	pending         map[string]*PendingEdit
	bootstrapPrompt string
	bootstrapDirty  bool
	lastAction      string
	lastUpdatedAt   time.Time
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
	count := len(h.clients)
	h.mu.Unlock()
	fmt.Printf("[+] client connected: %s (total: %d)\n", conn.RemoteAddr(), count)
}

func (h *Hub) unregister(conn *websocket.Conn) {
	h.mu.Lock()
	delete(h.clients, conn)
	count := len(h.clients)
	h.mu.Unlock()
	_ = conn.Close()
	fmt.Printf("[-] client disconnected: %s (total: %d)\n", conn.RemoteAddr(), count)
}

func (h *Hub) run() {
	for msg := range h.broadcast {
		h.mu.RLock()
		conns := make([]*websocket.Conn, 0, len(h.clients))
		for conn := range h.clients {
			conns = append(conns, conn)
		}
		h.mu.RUnlock()

		for _, conn := range conns {
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				log.Printf("send failed to %s: %v", conn.RemoteAddr(), err)
				go h.unregister(conn)
			}
		}
	}
}

func (h *Hub) clientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

func (h *Hub) sendMessage(message WSMessage) bool {
	msg, err := json.Marshal(message)
	if err != nil {
		log.Printf("marshal outbound message failed: %v", err)
		return false
	}
	h.broadcast <- msg
	return true
}

func (h *Hub) sendAgentText(text string) bool {
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}
	return h.sendMessage(WSMessage{
		Msg:   text,
		MType: wsTypeText,
	})
}

func (h *Hub) sendAgentStatus(status AgentStatusPayload) bool {
	body, err := json.Marshal(status)
	if err != nil {
		log.Printf("marshal agent status failed: %v", err)
		return false
	}
	return h.sendMessage(WSMessage{
		Msg:   string(body),
		MType: wsTypeAgentInfo,
	})
}

func newAgentState() *AgentState {
	return &AgentState{
		pending: make(map[string]*PendingEdit),
	}
}

func (s *AgentState) rootConfigured() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rootDir != ""
}

func (s *AgentState) setLastActionLocked(action string) {
	s.lastAction = strings.TrimSpace(action)
	s.lastUpdatedAt = time.Now()
}

func (s *AgentState) configureRoot(input string) (WorkspaceSummary, string, error) {
	root, err := filepath.Abs(strings.TrimSpace(input))
	if err != nil {
		return WorkspaceSummary{}, "", err
	}
	info, err := os.Stat(root)
	if err != nil {
		return WorkspaceSummary{}, "", err
	}
	if !info.IsDir() {
		return WorkspaceSummary{}, "", fmt.Errorf("not a directory: %s", root)
	}

	summary, err := analyzeWorkspace(root)
	if err != nil {
		return WorkspaceSummary{}, "", err
	}
	bootstrap := buildBootstrapPrompt(summary)

	s.mu.Lock()
	s.rootDir = root
	s.summary = summary
	s.pending = make(map[string]*PendingEdit)
	s.bootstrapPrompt = bootstrap
	s.bootstrapDirty = true
	s.setLastActionLocked("workspace configured: " + root)
	s.mu.Unlock()

	return summary, bootstrap, nil
}

func (s *AgentState) consumeBootstrapPrompt() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.bootstrapDirty || strings.TrimSpace(s.bootstrapPrompt) == "" {
		return ""
	}
	s.bootstrapDirty = false
	return s.bootstrapPrompt
}

func (s *AgentState) buildWorkspaceSummaryText() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rootDir == "" {
		return "workspace not configured"
	}
	return formatWorkspaceSummary(s.summary)
}

func (s *AgentState) currentBootstrapPrompt() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rootDir == "" {
		return ""
	}
	return buildBootstrapPrompt(s.summary)
}

func (s *AgentState) snapshotStatus() AgentStatusPayload {
	s.mu.Lock()
	defer s.mu.Unlock()

	status := AgentStatusPayload{
		WorkspaceConfigured: s.rootDir != "",
		PendingCount:        len(s.pending),
		AwaitingConfirm:     len(s.pending) > 0,
		LastAction:          s.lastAction,
		UpdatedAt:           s.lastUpdatedAt,
	}
	if s.rootDir == "" {
		return status
	}

	status.WorkspaceRoot = s.rootDir
	status.FileCount = s.summary.FileCount
	status.DirCount = s.summary.DirCount
	status.LanguageSummary = append([]string(nil), s.summary.LanguageSummary...)
	status.ImportantFiles = append([]string(nil), s.summary.ImportantFiles...)
	status.Notes = append([]string(nil), s.summary.Notes...)
	if len(s.summary.Tree) > 0 {
		limit := len(s.summary.Tree)
		if limit > 14 {
			limit = 14
		}
		status.TreePreview = append([]string(nil), s.summary.Tree[:limit]...)
	}
	status.Pending = make([]PendingEditInfo, 0, len(s.pending))
	for _, edit := range s.pending {
		status.Pending = append(status.Pending, PendingEditInfo{
			RelPath:      edit.RelPath,
			Bytes:        len(edit.StagedText),
			OriginalSize: len(edit.OriginalText),
			Existed:      edit.Existed,
			UpdatedAt:    edit.UpdatedAt,
		})
	}
	sort.Slice(status.Pending, func(i, j int) bool {
		return status.Pending[i].RelPath < status.Pending[j].RelPath
	})
	return status
}

func (s *AgentState) stageEdit(payload FilePayload) (PendingEditInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.rootDir == "" {
		return PendingEditInfo{}, errors.New("workspace root is not configured")
	}

	absPath, relPath, err := resolveWorkspacePath(s.rootDir, payload.Path)
	if err != nil {
		return PendingEditInfo{}, err
	}

	originalText := ""
	existed := false
	if current, ok := s.pending[absPath]; ok {
		originalText = current.OriginalText
		existed = current.Existed
	} else {
		raw, readErr := os.ReadFile(absPath)
		if readErr == nil {
			existed = true
			originalText = string(raw)
		} else if !errors.Is(readErr, os.ErrNotExist) {
			return PendingEditInfo{}, readErr
		}
	}

	edit := &PendingEdit{
		AbsPath:      absPath,
		RelPath:      relPath,
		OriginalText: originalText,
		StagedText:   payload.FileText,
		Existed:      existed,
		UpdatedAt:    time.Now(),
	}
	s.pending[absPath] = edit
	s.setLastActionLocked("staged edit: " + relPath)

	return PendingEditInfo{
		RelPath:      relPath,
		Bytes:        len(payload.FileText),
		OriginalSize: len(originalText),
		Existed:      existed,
		UpdatedAt:    edit.UpdatedAt,
	}, nil
}

func (s *AgentState) listPending() []PendingEditInfo {
	s.mu.Lock()
	defer s.mu.Unlock()

	items := make([]PendingEditInfo, 0, len(s.pending))
	for _, edit := range s.pending {
		items = append(items, PendingEditInfo{
			RelPath:      edit.RelPath,
			Bytes:        len(edit.StagedText),
			OriginalSize: len(edit.OriginalText),
			Existed:      edit.Existed,
			UpdatedAt:    edit.UpdatedAt,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].RelPath < items[j].RelPath
	})
	return items
}

func (s *AgentState) hasPending() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending) > 0
}

func (s *AgentState) getPendingContent(path string, staged bool) (string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.pending) == 0 {
		return "", "", errors.New("no pending edits")
	}

	var target *PendingEdit
	if strings.TrimSpace(path) == "" && len(s.pending) == 1 {
		for _, edit := range s.pending {
			target = edit
		}
	} else if strings.TrimSpace(path) != "" {
		absPath, relPath, err := resolveWorkspacePath(s.rootDir, path)
		if err != nil {
			return "", "", err
		}
		target = s.pending[absPath]
		if target == nil {
			for _, edit := range s.pending {
				if edit.RelPath == relPath {
					target = edit
					break
				}
			}
		}
	}

	if target == nil {
		if len(s.pending) > 1 {
			return "", "", errors.New("multiple pending edits exist, specify a path")
		}
		for _, edit := range s.pending {
			target = edit
		}
	}
	if target == nil {
		return "", "", errors.New("pending edit not found")
	}

	text := target.OriginalText
	if staged {
		text = target.StagedText
	}
	if len(text) > maxPendingPreviewSize {
		text = text[:maxPendingPreviewSize] + "\n\n[output truncated]"
	}
	return target.RelPath, text, nil
}

func (s *AgentState) savePending(path string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	targets, err := s.selectPendingLocked(path)
	if err != nil {
		return nil, err
	}

	saved := make([]string, 0, len(targets))
	for _, edit := range targets {
		parent := filepath.Dir(edit.AbsPath)
		if err := os.MkdirAll(parent, 0755); err != nil {
			return saved, err
		}
		if err := os.WriteFile(edit.AbsPath, []byte(edit.StagedText), 0644); err != nil {
			return saved, err
		}
		saved = append(saved, edit.RelPath)
		delete(s.pending, edit.AbsPath)
	}
	sort.Strings(saved)
	if len(saved) > 0 {
		s.setLastActionLocked("saved files: " + strings.Join(saved, ", "))
	}
	return saved, nil
}

func (s *AgentState) discardPending(path string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	targets, err := s.selectPendingLocked(path)
	if err != nil {
		return nil, err
	}

	discarded := make([]string, 0, len(targets))
	for _, edit := range targets {
		discarded = append(discarded, edit.RelPath)
		delete(s.pending, edit.AbsPath)
	}
	sort.Strings(discarded)
	if len(discarded) > 0 {
		s.setLastActionLocked("discarded files: " + strings.Join(discarded, ", "))
	}
	return discarded, nil
}

func (s *AgentState) selectPendingLocked(path string) ([]*PendingEdit, error) {
	if len(s.pending) == 0 {
		return nil, errors.New("no pending edits")
	}

	if strings.TrimSpace(path) == "" {
		targets := make([]*PendingEdit, 0, len(s.pending))
		for _, edit := range s.pending {
			targets = append(targets, edit)
		}
		return targets, nil
	}

	absPath, relPath, err := resolveWorkspacePath(s.rootDir, path)
	if err != nil {
		return nil, err
	}
	if edit := s.pending[absPath]; edit != nil {
		return []*PendingEdit{edit}, nil
	}
	for _, edit := range s.pending {
		if edit.RelPath == relPath {
			return []*PendingEdit{edit}, nil
		}
	}
	return nil, fmt.Errorf("pending edit not found: %s", path)
}

func (s *AgentState) executeCommand(cmd AgentCommand) (string, error) {
	s.mu.Lock()
	root := s.rootDir
	summary := s.summary
	s.mu.Unlock()

	if root == "" {
		return "", errors.New("workspace root is not configured")
	}

	switch strings.ToLower(strings.TrimSpace(cmd.Command)) {
	case "workspace_summary", "scan_workspace":
		return formatWorkspaceSummaryMessage(root, "workspace_summary", formatWorkspaceSummary(summary)), nil
	case "read_file":
		path := strings.TrimSpace(cmd.Path)
		if path == "" && len(cmd.Paths) > 0 {
			path = cmd.Paths[0]
		}
		if path == "" {
			return "", errors.New("read_file requires path")
		}
		return executeReadFiles(root, []string{path})
	case "read_files":
		if len(cmd.Paths) == 0 {
			return "", errors.New("read_files requires paths")
		}
		return executeReadFiles(root, cmd.Paths)
	case "list_dir":
		return executeListDir(root, cmd.Path, cmd.Depth)
	case "search":
		return executeSearch(root, cmd.Query, cmd.Glob, cmd.MaxResults)
	default:
		return "", fmt.Errorf("unsupported command: %s", cmd.Command)
	}
}

func formatWorkspaceSummaryMessage(root, command, body string) string {
	var b strings.Builder
	b.WriteString("[Local Agent Tool Result]\n")
	b.WriteString("command: ")
	b.WriteString(command)
	b.WriteString("\n")
	b.WriteString("root_dir: ")
	b.WriteString(root)
	b.WriteString("\n\n")
	b.WriteString(body)
	return b.String()
}

func executeReadFiles(root string, paths []string) (string, error) {
	if len(paths) > maxCommandReadFiles {
		paths = paths[:maxCommandReadFiles]
	}

	var b strings.Builder
	b.WriteString("[Local Agent Tool Result]\n")
	b.WriteString("command: read_files\n")
	b.WriteString("root_dir: ")
	b.WriteString(root)
	b.WriteString("\n\n")

	for i, rawPath := range paths {
		absPath, relPath, err := resolveWorkspacePath(root, rawPath)
		if err != nil {
			return "", err
		}
		content, err := os.ReadFile(absPath)
		if err != nil {
			return "", err
		}
		text := string(content)
		if len(text) > maxCommandFileBytes {
			text = text[:maxCommandFileBytes] + "\n\n[output truncated]"
		}
		if i > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString("path: ")
		b.WriteString(relPath)
		b.WriteString("\n```text\n")
		b.WriteString(text)
		if !strings.HasSuffix(text, "\n") {
			b.WriteString("\n")
		}
		b.WriteString("```")
	}

	return b.String(), nil
}

func executeListDir(root, rel string, depth int) (string, error) {
	if depth <= 0 {
		depth = 2
	}
	if depth > 5 {
		depth = 5
	}

	targetAbs := root
	targetRel := "."
	if strings.TrimSpace(rel) != "" {
		var err error
		targetAbs, targetRel, err = resolveWorkspacePath(root, rel)
		if err != nil {
			return "", err
		}
	}
	info, err := os.Stat(targetAbs)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("not a directory: %s", targetRel)
	}

	lines, _, err := renderTree(targetAbs, depth, maxTreeEntries)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	b.WriteString("[Local Agent Tool Result]\n")
	b.WriteString("command: list_dir\n")
	b.WriteString("root_dir: ")
	b.WriteString(root)
	b.WriteString("\n")
	b.WriteString("path: ")
	b.WriteString(targetRel)
	b.WriteString("\n\n")
	b.WriteString(strings.Join(lines, "\n"))
	return b.String(), nil
}

func executeSearch(root, query, glob string, maxResults int) (string, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return "", errors.New("search requires query")
	}
	if maxResults <= 0 || maxResults > maxCommandSearchHits {
		maxResults = maxCommandSearchHits
	}

	type hit struct {
		Path string
		Line int
		Text string
	}

	results := make([]hit, 0, maxResults)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		name := d.Name()
		if d.IsDir() {
			if shouldSkipDir(name) && path != root {
				return filepath.SkipDir
			}
			return nil
		}
		if !matchesGlob(path, glob) {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		lines := strings.Split(string(raw), "\n")
		for idx, line := range lines {
			if strings.Contains(line, query) {
				rel, relErr := filepath.Rel(root, path)
				if relErr != nil {
					rel = path
				}
				results = append(results, hit{
					Path: filepath.ToSlash(rel),
					Line: idx + 1,
					Text: strings.TrimSpace(line),
				})
				if len(results) >= maxResults {
					return errors.New("stop-search")
				}
			}
		}
		return nil
	})
	if err != nil && err.Error() != "stop-search" {
		return "", err
	}

	var b strings.Builder
	b.WriteString("[Local Agent Tool Result]\n")
	b.WriteString("command: search\n")
	b.WriteString("root_dir: ")
	b.WriteString(root)
	b.WriteString("\n")
	b.WriteString("query: ")
	b.WriteString(query)
	b.WriteString("\n")
	if strings.TrimSpace(glob) != "" {
		b.WriteString("glob: ")
		b.WriteString(glob)
		b.WriteString("\n")
	}
	b.WriteString("\n")
	if len(results) == 0 {
		b.WriteString("no matches found")
		return b.String(), nil
	}
	for _, item := range results {
		b.WriteString("- ")
		b.WriteString(item.Path)
		b.WriteString(":")
		b.WriteString(strconv.Itoa(item.Line))
		b.WriteString(" ")
		b.WriteString(item.Text)
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String()), nil
}

func resolveWorkspacePath(root, rawPath string) (string, string, error) {
	cleaned := strings.TrimSpace(rawPath)
	if cleaned == "" {
		return "", "", errors.New("path is empty")
	}

	var absPath string
	if filepath.IsAbs(cleaned) {
		absPath = filepath.Clean(cleaned)
	} else {
		absPath = filepath.Clean(filepath.Join(root, filepath.FromSlash(cleaned)))
	}
	relPath, err := filepath.Rel(root, absPath)
	if err != nil {
		return "", "", err
	}
	if relPath == ".." || strings.HasPrefix(relPath, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("path escapes workspace: %s", rawPath)
	}
	return absPath, filepath.ToSlash(relPath), nil
}

func analyzeWorkspace(root string) (WorkspaceSummary, error) {
	summary := WorkspaceSummary{
		RootDir: root,
	}

	extCount := map[string]int{}
	important := []string{}

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path != root && d.IsDir() && shouldSkipDir(d.Name()) {
			return filepath.SkipDir
		}
		if d.IsDir() {
			if path != root {
				summary.DirCount++
			}
			return nil
		}

		summary.FileCount++
		rel, err := filepath.Rel(root, path)
		if err != nil {
			rel = path
		}
		rel = filepath.ToSlash(rel)
		if isImportantFile(rel) && len(important) < 20 {
			important = append(important, rel)
		}
		ext := strings.ToLower(filepath.Ext(d.Name()))
		if ext == "" {
			ext = "[no_ext]"
		}
		extCount[ext]++
		return nil
	})
	if err != nil {
		return WorkspaceSummary{}, err
	}

	tree, truncated, err := renderTree(root, maxTreeDepth, maxTreeEntries)
	if err != nil {
		return WorkspaceSummary{}, err
	}

	summary.Tree = tree
	sort.Strings(important)
	summary.ImportantFiles = important
	summary.LanguageSummary = summarizeExtensions(extCount)
	summary.Notes = detectWorkspaceNotes(root)
	if truncated {
		summary.Notes = append(summary.Notes, "tree output truncated to keep context small")
	}
	return summary, nil
}

func renderTree(root string, maxDepth, maxEntries int) ([]string, bool, error) {
	lines := []string{"."}
	count := 0
	truncated := false

	var walk func(string, int, string) error
	walk = func(dir string, depth int, prefix string) error {
		if depth >= maxDepth {
			return nil
		}

		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		sort.Slice(entries, func(i, j int) bool {
			if entries[i].IsDir() != entries[j].IsDir() {
				return entries[i].IsDir()
			}
			return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
		})

		visible := make([]fs.DirEntry, 0, len(entries))
		for _, entry := range entries {
			if entry.IsDir() && shouldSkipDir(entry.Name()) {
				continue
			}
			visible = append(visible, entry)
		}

		for idx, entry := range visible {
			if count >= maxEntries {
				truncated = true
				return nil
			}
			connector := "|- "
			nextPrefix := prefix + "|  "
			if idx == len(visible)-1 {
				connector = "`- "
				nextPrefix = prefix + "   "
			}
			name := entry.Name()
			if entry.IsDir() {
				name += "/"
			}
			lines = append(lines, prefix+connector+name)
			count++

			if entry.IsDir() {
				if err := walk(filepath.Join(dir, entry.Name()), depth+1, nextPrefix); err != nil {
					return err
				}
			}
		}
		return nil
	}

	if err := walk(root, 0, ""); err != nil {
		return nil, false, err
	}
	return lines, truncated, nil
}

func shouldSkipDir(name string) bool {
	return ignoredDirNames[strings.ToLower(strings.TrimSpace(name))]
}

func isImportantFile(rel string) bool {
	base := strings.ToLower(filepath.Base(rel))
	switch base {
	case "readme", "readme.md", "package.json", "go.mod", "go.sum", "manifest.json", "tsconfig.json", "vite.config.js", "vite.config.ts", "main.go":
		return true
	}
	if strings.HasSuffix(base, ".md") && strings.Count(rel, "/") <= 1 {
		return true
	}
	return strings.Count(rel, "/") <= 1
}

func summarizeExtensions(extCount map[string]int) []string {
	type pair struct {
		Ext   string
		Count int
	}
	items := make([]pair, 0, len(extCount))
	for ext, count := range extCount {
		items = append(items, pair{Ext: ext, Count: count})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		return items[i].Ext < items[j].Ext
	})

	limit := 8
	if len(items) < limit {
		limit = len(items)
	}
	result := make([]string, 0, limit)
	for _, item := range items[:limit] {
		result = append(result, fmt.Sprintf("%s(%d)", item.Ext, item.Count))
	}
	return result
}

func detectWorkspaceNotes(root string) []string {
	notes := []string{}
	if raw, err := os.ReadFile(filepath.Join(root, "go.mod")); err == nil {
		lines := strings.Split(string(raw), "\n")
		if len(lines) > 0 {
			moduleLine := strings.TrimSpace(lines[0])
			if moduleLine != "" {
				notes = append(notes, "go module: "+moduleLine)
			}
		}
	}
	if raw, err := os.ReadFile(filepath.Join(root, "ai-web-chrome-plugin", "manifest.json")); err == nil {
		text := string(raw)
		if strings.Contains(text, "\"manifest_version\": 3") {
			notes = append(notes, "chrome extension manifest v3 detected")
		}
	}
	return notes
}

func formatWorkspaceSummary(summary WorkspaceSummary) string {
	var b strings.Builder
	b.WriteString("workspace_root: ")
	b.WriteString(summary.RootDir)
	b.WriteString("\n")
	b.WriteString("files: ")
	b.WriteString(strconv.Itoa(summary.FileCount))
	b.WriteString("\n")
	b.WriteString("directories: ")
	b.WriteString(strconv.Itoa(summary.DirCount))
	b.WriteString("\n")

	if len(summary.LanguageSummary) > 0 {
		b.WriteString("languages: ")
		b.WriteString(strings.Join(summary.LanguageSummary, ", "))
		b.WriteString("\n")
	}
	if len(summary.ImportantFiles) > 0 {
		b.WriteString("important_files:\n")
		for _, item := range summary.ImportantFiles {
			b.WriteString("- ")
			b.WriteString(item)
			b.WriteString("\n")
		}
	}
	if len(summary.Notes) > 0 {
		b.WriteString("notes:\n")
		for _, note := range summary.Notes {
			b.WriteString("- ")
			b.WriteString(note)
			b.WriteString("\n")
		}
	}
	if len(summary.Tree) > 0 {
		b.WriteString("tree:\n")
		b.WriteString(strings.Join(summary.Tree, "\n"))
	}
	return strings.TrimSpace(b.String())
}

func buildBootstrapPrompt(summary WorkspaceSummary) string {
	var b strings.Builder
	b.WriteString("你现在是一个本地代码 AIAgent，通过浏览器页面和本地 WebSocket 服务协作。\n")
	b.WriteString("工作目录已经由本地服务设置好，所有路径都必须相对这个目录。\n\n")
	b.WriteString("工作目录摘要如下：\n")
	b.WriteString(formatWorkspaceSummary(summary))
	b.WriteString("\n\n")
	b.WriteString("你不能直接访问本地文件系统，所以当你需要更多上下文时，必须输出以下结构化块之一，且块内容必须是合法 JSON，不要放在 Markdown 代码块里。\n")
	b.WriteString("1. 读取文件:\n")
	b.WriteString("<aiws_command>{\"command\":\"read_file\",\"path\":\"relative/path\"}</aiws_command>\n")
	b.WriteString("或批量读取:\n")
	b.WriteString("<aiws_command>{\"command\":\"read_files\",\"paths\":[\"relative/path1\",\"relative/path2\"]}</aiws_command>\n")
	b.WriteString("2. 列目录:\n")
	b.WriteString("<aiws_command>{\"command\":\"list_dir\",\"path\":\"subdir\",\"depth\":2}</aiws_command>\n")
	b.WriteString("3. 搜索文本:\n")
	b.WriteString("<aiws_command>{\"command\":\"search\",\"query\":\"keyword\",\"glob\":\"*.go\",\"max_results\":20}</aiws_command>\n")
	b.WriteString("4. 向用户发起选择题:\n")
	b.WriteString("<aiws_questions>{\"questions\":[{\"question\":\"...\",\"options\":[\"...\",\"...\"]}]}</aiws_questions>\n")
	b.WriteString("5. 提交文件编辑草案:\n")
	b.WriteString("<aiws_file>{\"path\":\"relative/path\",\"file_text\":\"完整文件内容\"}</aiws_file>\n\n")
	b.WriteString("编辑规则:\n")
	b.WriteString("- 不要声称文件已经保存。本地服务只有在用户输入 save 确认后才会真正写盘。\n")
	b.WriteString("- 如果没有拿到目标文件的当前内容，不要直接改写它，先请求 read_file/read_files。\n")
	b.WriteString("- 如果需要多个文件，请分多个 <aiws_file> 块输出。\n")
	b.WriteString("- 收到 [Local Agent Tool Result] 后，把它当作工具返回继续工作，不要重复索取相同信息。\n")
	b.WriteString("- 普通说明文字照常输出，但结构化块必须独立且严格符合格式。\n\n")
	b.WriteString("先基于当前目录摘要做简短分析，然后等待用户任务或主动说明你下一步需要读取哪些文件。")
	return b.String()
}

func matchesGlob(path, pattern string) bool {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return true
	}
	base := filepath.Base(path)
	ok, err := filepath.Match(pattern, base)
	if err == nil && ok {
		return true
	}
	relPattern := filepath.ToSlash(pattern)
	relPath := filepath.ToSlash(path)
	ok, err = filepath.Match(relPattern, relPath)
	return err == nil && ok
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
	fmt.Print("select option number: ")
}

func formatQuestionAnswers(session *PromptSession) string {
	if session == nil {
		return ""
	}
	var b strings.Builder
	b.WriteString("[User Answers]\n")
	for i, q := range session.Questions {
		if i >= len(session.Answers) {
			continue
		}
		b.WriteString("Q: ")
		b.WriteString(q.Question)
		b.WriteString("\nA: ")
		b.WriteString(session.Answers[i])
		if i != len(session.Questions)-1 {
			b.WriteString("\n\n")
		}
	}
	return b.String()
}

func printWorkspaceSummary(summary WorkspaceSummary) {
	fmt.Println("\nWorkspace configured:")
	fmt.Println(formatWorkspaceSummary(summary))
	fmt.Println()
}

func pushAgentStatus(hub *Hub, state *AgentState) {
	if hub == nil || state == nil {
		return
	}
	_ = hub.sendAgentStatus(state.snapshotStatus())
}

func printPendingEdits(items []PendingEditInfo) {
	if len(items) == 0 {
		fmt.Println("no pending edits")
		return
	}
	fmt.Println("pending edits:")
	for _, item := range items {
		kind := "update"
		if !item.Existed {
			kind = "create"
		}
		fmt.Printf("- %s (%s, staged=%dB, original=%dB)\n", item.RelPath, kind, item.Bytes, item.OriginalSize)
	}
}

func printHelp() {
	fmt.Println("commands:")
	fmt.Println("- first input after startup: workspace directory")
	fmt.Println("- :root <dir>       switch workspace")
	fmt.Println("- :context          resend workspace bootstrap prompt to the AI")
	fmt.Println("- :summary          print current workspace summary")
	fmt.Println("- pending           list pending edits")
	fmt.Println("- show [path]       print staged content")
	fmt.Println("- orig [path]       print original content")
	fmt.Println("- save [path]       save all or one pending edit")
	fmt.Println("- discard [path]    discard all or one pending edit")
	fmt.Println("- help              print this help")
	fmt.Println("- anything else is forwarded to the browser AI")
}

func parseCommandLine(text string) (string, string) {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return "", ""
	}
	cmd := strings.ToLower(fields[0])
	arg := ""
	if len(fields) > 1 {
		arg = strings.TrimSpace(strings.TrimPrefix(text, fields[0]))
	}
	return cmd, strings.TrimSpace(arg)
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Run the local AI WebSocket agent bridge",
	Run: func(cmd *cobra.Command, args []string) {
		port, _ := cmd.Flags().GetString("port")
		hub := newHub()
		state := newAgentState()

		var inputMu sync.Mutex
		var promptMu sync.Mutex
		var promptSession *PromptSession

		go hub.run()

		http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				log.Println("upgrade failed:", err)
				return
			}
			hub.register(conn)
			pushAgentStatus(hub, state)

			if bootstrap := state.consumeBootstrapPrompt(); bootstrap != "" {
				hub.sendAgentText(bootstrap)
				fmt.Println("bootstrap prompt sent to the browser AI")
			}

			go func() {
				defer hub.unregister(conn)
				for {
					_, msg, err := conn.ReadMessage()
					if err != nil {
						break
					}
					if len(msg) == 0 {
						continue
					}

					var incoming WSMessage
					if err := json.Unmarshal(msg, &incoming); err != nil {
						log.Println("json unmarshal error:", err)
						continue
					}

					switch incoming.MType {
					case wsTypeHeartbeat:
						continue
					case wsTypeQuestions:
						var packet QuestionPacket
						if err := json.Unmarshal([]byte(incoming.Msg), &packet); err != nil {
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
					case wsTypeFile:
						var payload FilePayload
						if err := json.Unmarshal([]byte(incoming.Msg), &payload); err != nil {
							log.Println("file payload unmarshal error:", err)
							continue
						}
						info, err := state.stageEdit(payload)
						if err != nil {
							log.Println("stage edit error:", err)
							fmt.Printf("\nstage edit failed: %v\n", err)
							continue
						}
						fmt.Printf("\nstaged edit: %s (%d bytes)\n", info.RelPath, info.Bytes)
						fmt.Println("use `show`, `save`, `discard`, or `pending` before sending more instructions")
						pushAgentStatus(hub, state)
					case wsTypeCommand:
						var agentCmd AgentCommand
						if err := json.Unmarshal([]byte(incoming.Msg), &agentCmd); err != nil {
							log.Println("agent command unmarshal error:", err)
							continue
						}
						result, err := state.executeCommand(agentCmd)
						if err != nil {
							result = fmt.Sprintf("[Local Agent Tool Result]\ncommand: %s\nerror: %v", agentCmd.Command, err)
						}
						fmt.Printf("\nlocal tool request: %s\n", agentCmd.Command)
						if !hub.sendAgentText(result) {
							fmt.Println("tool result was not sent because no browser client is connected")
						}
					default:
						fmt.Print(incoming.Msg)
					}
				}
			}()
		})

		go func() {
			fmt.Printf("WebSocket server listening on ws://0.0.0.0:%s/ws\n", port)
			fmt.Println("first input should be the workspace directory path")
			log.Fatal(http.ListenAndServe(":"+port, nil))
		}()

		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
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
					fmt.Println("invalid selection, enter the option number")
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
				fmt.Printf("[answers collected]\n%s\n", formatted)
				promptMu.Lock()
				promptSession = nil
				promptMu.Unlock()
				inputMu.Unlock()
				if !hub.sendAgentText(formatted) {
					fmt.Println("answers were not sent because no browser client is connected")
				}
				continue
			}

			if !state.rootConfigured() {
				summary, _, err := state.configureRoot(text)
				if err != nil {
					fmt.Printf("workspace setup failed: %v\n", err)
					fmt.Println("please enter a valid directory path")
					continue
				}
				printWorkspaceSummary(summary)
				pushAgentStatus(hub, state)
				if hub.clientCount() == 0 {
					fmt.Println("workspace saved locally; connect the browser plugin and the bootstrap prompt will be sent automatically, or run `:context` manually")
				} else if bootstrap := state.consumeBootstrapPrompt(); bootstrap != "" {
					hub.sendAgentText(bootstrap)
					fmt.Println("bootstrap prompt sent to the browser AI")
				}
				continue
			}

			commandName, commandArg := parseCommandLine(text)
			switch commandName {
			case ":root":
				summary, _, err := state.configureRoot(commandArg)
				if err != nil {
					fmt.Printf("workspace switch failed: %v\n", err)
					continue
				}
				printWorkspaceSummary(summary)
				pushAgentStatus(hub, state)
				if hub.clientCount() == 0 {
					fmt.Println("workspace switched locally; connect the browser plugin, then run `:context`")
					continue
				}
				if bootstrap := state.consumeBootstrapPrompt(); bootstrap != "" {
					hub.sendAgentText(bootstrap)
					fmt.Println("bootstrap prompt sent to the browser AI")
				}
				continue
			case ":context":
				if hub.clientCount() == 0 {
					fmt.Println("no browser client is connected")
					continue
				}
				bootstrap := state.consumeBootstrapPrompt()
				if bootstrap == "" {
					bootstrap = state.currentBootstrapPrompt()
				}
				hub.sendAgentText(bootstrap)
				fmt.Println("workspace context sent")
				continue
			case ":summary":
				fmt.Println(state.buildWorkspaceSummaryText())
				continue
			case "help":
				printHelp()
				continue
			case "pending":
				printPendingEdits(state.listPending())
				continue
			case "show":
				relPath, content, err := state.getPendingContent(commandArg, true)
				if err != nil {
					fmt.Printf("show failed: %v\n", err)
					continue
				}
				fmt.Printf("--- staged: %s ---\n%s\n", relPath, content)
				continue
			case "orig":
				relPath, content, err := state.getPendingContent(commandArg, false)
				if err != nil {
					fmt.Printf("show original failed: %v\n", err)
					continue
				}
				fmt.Printf("--- original: %s ---\n%s\n", relPath, content)
				continue
			case "save":
				saved, err := state.savePending(commandArg)
				if err != nil {
					fmt.Printf("save failed: %v\n", err)
					continue
				}
				fmt.Printf("saved: %s\n", strings.Join(saved, ", "))
				pushAgentStatus(hub, state)
				if hub.clientCount() > 0 {
					hub.sendAgentText("[Local Agent Save Result]\nsaved files: " + strings.Join(saved, ", "))
				}
				continue
			case "discard":
				discarded, err := state.discardPending(commandArg)
				if err != nil {
					fmt.Printf("discard failed: %v\n", err)
					continue
				}
				fmt.Printf("discarded staged edits: %s\n", strings.Join(discarded, ", "))
				pushAgentStatus(hub, state)
				if hub.clientCount() > 0 {
					hub.sendAgentText("[Local Agent Save Result]\ndiscarded files: " + strings.Join(discarded, ", "))
				}
				continue
			}

			if state.hasPending() {
				fmt.Println("pending edits exist. resolve them with `save`, `discard`, `show`, or `pending` before sending more instructions")
				continue
			}

			if !hub.sendAgentText(text) {
				fmt.Println("message was not sent because no browser client is connected")
				continue
			}
			fmt.Printf("[sent to %d client(s)] %s\n", hub.clientCount(), text)
		}
	},
}

func init() {
	serveCmd.Flags().StringP("port", "p", "8899", "listening port")
}

func main() {
	if err := serveCmd.Execute(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}

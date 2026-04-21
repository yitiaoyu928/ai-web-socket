package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	acpProtocolName          = "acp-bridge"
	acpProtocolVersion       = 1
	defaultTerminalByteLimit = 64 * 1024
	maxTerminalByteLimit     = 256 * 1024

	methodReadTextFile  = "fs/read_text_file"
	methodWriteTextFile = "fs/write_text_file"
	methodTerminalNew   = "terminal/create"
	methodTerminalOut   = "terminal/output"
	methodTerminalWait  = "terminal/wait_for_exit"
	methodTerminalKill  = "terminal/kill"
	methodTerminalDrop  = "terminal/release"

	methodWorkspaceSummary   = "_workspace/workspace_summary"
	methodWorkspaceReadFiles = "_workspace/read_text_files"
	methodWorkspaceListDir   = "_workspace/list_dir"
	methodWorkspaceSearch    = "_workspace/search_text"
	methodWorkspaceRunCmd    = "_workspace/run_command"
)

type ToolCallInfo struct {
	ToolCallID string    `json:"tool_call_id"`
	Title      string    `json:"title"`
	Kind       string    `json:"kind"`
	Status     string    `json:"status"`
	Method     string    `json:"method"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type ACPMethodCall struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type ACPReadTextFileParams struct {
	SessionID string `json:"sessionId,omitempty"`
	Path      string `json:"path"`
	Line      int    `json:"line,omitempty"`
	Limit     int    `json:"limit,omitempty"`
}

type ACPReadTextFilesParams struct {
	SessionID string   `json:"sessionId,omitempty"`
	Paths     []string `json:"paths"`
}

type ACPWriteTextFileParams struct {
	SessionID string `json:"sessionId,omitempty"`
	Path      string `json:"path"`
	Content   string `json:"content"`
}

type ACPListDirParams struct {
	SessionID string `json:"sessionId,omitempty"`
	Path      string `json:"path,omitempty"`
	Depth     int    `json:"depth,omitempty"`
}

type ACPSearchParams struct {
	SessionID  string `json:"sessionId,omitempty"`
	Query      string `json:"query"`
	Glob       string `json:"glob,omitempty"`
	MaxResults int    `json:"maxResults,omitempty"`
}

type ACPEnvVariable struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type ACPCreateTerminalParams struct {
	SessionID       string           `json:"sessionId,omitempty"`
	Command         string           `json:"command"`
	Args            []string         `json:"args,omitempty"`
	Env             []ACPEnvVariable `json:"env,omitempty"`
	Cwd             string           `json:"cwd,omitempty"`
	OutputByteLimit int              `json:"outputByteLimit,omitempty"`
}

type ACPRunCommandParams struct {
	SessionID       string           `json:"sessionId,omitempty"`
	Command         string           `json:"command"`
	Args            []string         `json:"args,omitempty"`
	Env             []ACPEnvVariable `json:"env,omitempty"`
	Cwd             string           `json:"cwd,omitempty"`
	OutputByteLimit int              `json:"outputByteLimit,omitempty"`
	TimeoutSeconds  int              `json:"timeoutSeconds,omitempty"`
}

type ACPTerminalRefParams struct {
	SessionID  string `json:"sessionId,omitempty"`
	TerminalID string `json:"terminalId"`
}

type resultField struct {
	Key   string
	Value string
}

type TerminalSnapshot struct {
	TerminalID string
	Command    string
	Args       []string
	Cwd        string
	Output     string
	Truncated  bool
	ExitCode   *int
	Signal     string
	Running    bool
	UpdatedAt  time.Time
}

type TerminalEntry struct {
	ID          string
	SessionID   string
	Command     string
	Args        []string
	Cwd         string
	Output      string
	Truncated   bool
	OutputLimit int
	ExitCode    *int
	Signal      string
	Running     bool
	UpdatedAt   time.Time
	waitCh      chan struct{}
	cancel      context.CancelFunc
	cmd         *exec.Cmd
}

type TerminalManager struct {
	mu    sync.Mutex
	seq   int
	items map[string]*TerminalEntry
}

func newTerminalManager() *TerminalManager {
	return &TerminalManager{
		items: make(map[string]*TerminalEntry),
	}
}

func buildACPBootstrapPrompt(summary WorkspaceSummary) string {
	var b strings.Builder
	b.WriteString("You are a local coding agent working through a browser AI page and a local WebSocket bridge.\n")
	b.WriteString("The active workspace root is already configured. Prefer ACP-style method names when you need local tools.\n\n")
	b.WriteString("Workspace summary:\n")
	b.WriteString(formatWorkspaceSummary(summary))
	b.WriteString("\n\n")
	b.WriteString("When you need local context or actions, output exactly one structured block at a time. The JSON must be valid and must not be wrapped in markdown fences.\n")
	b.WriteString("When you are calling a tool, output only the structured block itself with no prose before or after it.\n")
	b.WriteString("Preferred ACP-style call tag:\n")
	b.WriteString("<aiws_call>{\"method\":\"fs/read_text_file\",\"params\":{\"path\":\"main.go\"}}</aiws_call>\n")
	b.WriteString("<aiws_call>{\"method\":\"fs/write_text_file\",\"params\":{\"path\":\"main.go\",\"content\":\"full file contents\"}}</aiws_call>\n")
	b.WriteString("<aiws_call>{\"method\":\"_workspace/list_dir\",\"params\":{\"path\":\"ai-web-chrome-plugin\",\"depth\":2}}</aiws_call>\n")
	b.WriteString("<aiws_call>{\"method\":\"_workspace/search_text\",\"params\":{\"query\":\"websocket\",\"glob\":\"*.go\",\"maxResults\":20}}</aiws_call>\n")
	b.WriteString("<aiws_call>{\"method\":\"_workspace/run_command\",\"params\":{\"command\":\"go\",\"args\":[\"test\",\"./...\"],\"cwd\":\".\"}}</aiws_call>\n")
	b.WriteString("<aiws_call>{\"method\":\"terminal/create\",\"params\":{\"command\":\"npm\",\"args\":[\"run\",\"dev\"],\"cwd\":\".\"}}</aiws_call>\n")
	b.WriteString("<aiws_call>{\"method\":\"terminal/output\",\"params\":{\"terminalId\":\"term_0001\"}}</aiws_call>\n")
	b.WriteString("<aiws_call>{\"method\":\"terminal/wait_for_exit\",\"params\":{\"terminalId\":\"term_0001\"}}</aiws_call>\n")
	b.WriteString("<aiws_call>{\"method\":\"terminal/release\",\"params\":{\"terminalId\":\"term_0001\"}}</aiws_call>\n\n")
	b.WriteString("Question blocks are still allowed when you need the user to choose:\n")
	b.WriteString("<aiws_questions>{\"questions\":[{\"question\":\"...\",\"options\":[\"...\",\"...\"]}]}</aiws_questions>\n\n")
	b.WriteString("Rules:\n")
	b.WriteString("- Read a file before rewriting it.\n")
	b.WriteString("- `fs/write_text_file` only stages a pending edit. The file is not saved until the user runs `save` locally.\n")
	b.WriteString("- Use `_workspace/run_command` for short checks such as tests or builds.\n")
	b.WriteString("- Use `terminal/*` only when you need a reusable long-running command handle.\n")
	b.WriteString("- Relative paths are accepted and resolved against the workspace root. Absolute paths are also accepted.\n")
	b.WriteString("- After you receive `[ACP Tool Result]`, treat it as tool output and continue without re-requesting the same context.\n")
	b.WriteString("- Normal explanation text is fine, but structured blocks must stand alone and stay valid JSON.\n\n")
	b.WriteString("Start with a short analysis of the workspace summary, then wait for the user's task or say which files you need to read next.")
	return b.String()
}

func newSessionID() string {
	return fmt.Sprintf("sess_%d", time.Now().UnixNano())
}

func rawParams(v any) json.RawMessage {
	if v == nil {
		return json.RawMessage(`{}`)
	}
	body, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return body
}

func normalizeIncomingToolCall(raw string) (ACPMethodCall, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ACPMethodCall{}, errors.New("tool payload is empty")
	}

	var call ACPMethodCall
	if err := json.Unmarshal([]byte(raw), &call); err == nil && strings.TrimSpace(call.Method) != "" {
		if len(call.Params) == 0 {
			call.Params = json.RawMessage(`{}`)
		}
		return call, nil
	}

	var legacy AgentCommand
	if err := json.Unmarshal([]byte(raw), &legacy); err == nil && strings.TrimSpace(legacy.Command) != "" {
		return normalizeLegacyCommand(legacy), nil
	}

	return ACPMethodCall{}, errors.New("unsupported tool payload")
}

func normalizeLegacyCommand(cmd AgentCommand) ACPMethodCall {
	switch strings.ToLower(strings.TrimSpace(cmd.Command)) {
	case "workspace_summary", "scan_workspace":
		return ACPMethodCall{Method: methodWorkspaceSummary, Params: json.RawMessage(`{}`)}
	case "read_file":
		path := strings.TrimSpace(cmd.Path)
		if path == "" && len(cmd.Paths) > 0 {
			path = strings.TrimSpace(cmd.Paths[0])
		}
		return ACPMethodCall{
			Method: methodReadTextFile,
			Params: rawParams(ACPReadTextFileParams{Path: path}),
		}
	case "read_files":
		return ACPMethodCall{
			Method: methodWorkspaceReadFiles,
			Params: rawParams(ACPReadTextFilesParams{Paths: append([]string(nil), cmd.Paths...)}),
		}
	case "list_dir":
		return ACPMethodCall{
			Method: methodWorkspaceListDir,
			Params: rawParams(ACPListDirParams{Path: cmd.Path, Depth: cmd.Depth}),
		}
	case "search":
		return ACPMethodCall{
			Method: methodWorkspaceSearch,
			Params: rawParams(ACPSearchParams{
				Query:      cmd.Query,
				Glob:       cmd.Glob,
				MaxResults: cmd.MaxResults,
			}),
		}
	default:
		return ACPMethodCall{
			Method: "_legacy/" + strings.ToLower(strings.TrimSpace(cmd.Command)),
			Params: rawParams(cmd),
		}
	}
}

func unmarshalCallParams(call ACPMethodCall, target any) error {
	payload := call.Params
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	if err := json.Unmarshal(payload, target); err != nil {
		return fmt.Errorf("invalid params for %s: %w", call.Method, err)
	}
	return nil
}

func describeToolCall(method string) (string, string) {
	switch method {
	case methodReadTextFile, methodWorkspaceReadFiles, methodWorkspaceSummary, methodWorkspaceListDir:
		return "Read workspace context", "read"
	case methodWorkspaceSearch:
		return "Search workspace text", "search"
	case methodWriteTextFile:
		return "Stage file edit", "edit"
	case methodWorkspaceRunCmd, methodTerminalNew, methodTerminalOut, methodTerminalWait, methodTerminalKill, methodTerminalDrop:
		return "Run workspace command", "execute"
	default:
		return method, "other"
	}
}

func (s *AgentState) startToolCall(method string) ToolCallInfo {
	title, kind := describeToolCall(method)

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.activeTools == nil {
		s.activeTools = make(map[string]*ToolCallInfo)
	}

	s.toolSeq++
	info := ToolCallInfo{
		ToolCallID: fmt.Sprintf("call_%04d", s.toolSeq),
		Title:      title,
		Kind:       kind,
		Status:     "in_progress",
		Method:     method,
		UpdatedAt:  time.Now(),
	}
	copyInfo := info
	s.activeTools[info.ToolCallID] = &copyInfo
	s.setLastActionLocked(title)
	return info
}

func (s *AgentState) finishToolCall(toolCallID, status, action string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if active := s.activeTools[toolCallID]; active != nil {
		active.Status = status
		active.UpdatedAt = time.Now()
		delete(s.activeTools, toolCallID)
	}
	if strings.TrimSpace(action) != "" {
		s.setLastActionLocked(action)
	}
}

func (s *AgentState) recordPromptSent(text string) {
	preview := strings.TrimSpace(text)
	if len(preview) > 88 {
		preview = preview[:88] + "..."
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.rootDir == "" {
		return
	}
	s.turnCount++
	s.lastStopReason = ""
	if preview == "" {
		s.setLastActionLocked("prompt sent to browser AI")
		return
	}
	s.setLastActionLocked("prompt sent: " + preview)
}

func (s *AgentState) resetSessionLocked() {
	s.sessionID = newSessionID()
	s.turnCount = 0
	s.toolSeq = 0
	s.activeTools = make(map[string]*ToolCallInfo)
	s.lastStopReason = ""
}

func (s *AgentState) stageWriteTextFile(path, content string) (PendingEditInfo, error) {
	return s.stageEdit(FilePayload{
		Path:     path,
		FileText: content,
	})
}

func (s *AgentState) sessionContext() (string, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rootDir, s.sessionID
}

func (s *AgentState) executeMethodCall(call ACPMethodCall, tool ToolCallInfo) (string, error) {
	root, sessionID := s.sessionContext()
	if root == "" {
		return "", errors.New("workspace root is not configured")
	}

	switch strings.TrimSpace(call.Method) {
	case methodWorkspaceSummary:
		return rewriteLegacyToolResult(
			methodWorkspaceSummary,
			sessionID,
			tool.ToolCallID,
			formatWorkspaceSummaryMessage(root, "workspace_summary", formatWorkspaceSummary(s.summary)),
		), nil
	case methodReadTextFile:
		var params ACPReadTextFileParams
		if err := unmarshalCallParams(call, &params); err != nil {
			return "", err
		}
		return s.executeReadTextFile(root, sessionID, tool.ToolCallID, params)
	case methodWorkspaceReadFiles:
		var params ACPReadTextFilesParams
		if err := unmarshalCallParams(call, &params); err != nil {
			return "", err
		}
		return s.executeReadTextFiles(root, sessionID, tool.ToolCallID, params)
	case methodWriteTextFile:
		var params ACPWriteTextFileParams
		if err := unmarshalCallParams(call, &params); err != nil {
			return "", err
		}
		return s.executeWriteTextFile(root, sessionID, tool.ToolCallID, params)
	case methodWorkspaceListDir:
		var params ACPListDirParams
		if err := unmarshalCallParams(call, &params); err != nil {
			return "", err
		}
		body, err := executeListDir(root, params.Path, params.Depth)
		if err != nil {
			return "", err
		}
		return rewriteLegacyToolResult(methodWorkspaceListDir, sessionID, tool.ToolCallID, body), nil
	case methodWorkspaceSearch:
		var params ACPSearchParams
		if err := unmarshalCallParams(call, &params); err != nil {
			return "", err
		}
		body, err := executeSearch(root, params.Query, params.Glob, params.MaxResults)
		if err != nil {
			return "", err
		}
		return rewriteLegacyToolResult(methodWorkspaceSearch, sessionID, tool.ToolCallID, body), nil
	case methodWorkspaceRunCmd:
		var params ACPRunCommandParams
		if err := unmarshalCallParams(call, &params); err != nil {
			return "", err
		}
		return s.executeRunCommand(root, sessionID, tool.ToolCallID, params)
	case methodTerminalNew:
		var params ACPCreateTerminalParams
		if err := unmarshalCallParams(call, &params); err != nil {
			return "", err
		}
		return s.executeCreateTerminal(root, sessionID, tool.ToolCallID, params)
	case methodTerminalOut:
		var params ACPTerminalRefParams
		if err := unmarshalCallParams(call, &params); err != nil {
			return "", err
		}
		return s.executeTerminalOutput(sessionID, tool.ToolCallID, params)
	case methodTerminalWait:
		var params ACPTerminalRefParams
		if err := unmarshalCallParams(call, &params); err != nil {
			return "", err
		}
		return s.executeTerminalWait(sessionID, tool.ToolCallID, params)
	case methodTerminalKill:
		var params ACPTerminalRefParams
		if err := unmarshalCallParams(call, &params); err != nil {
			return "", err
		}
		return s.executeTerminalKill(sessionID, tool.ToolCallID, params)
	case methodTerminalDrop:
		var params ACPTerminalRefParams
		if err := unmarshalCallParams(call, &params); err != nil {
			return "", err
		}
		return s.executeTerminalRelease(sessionID, tool.ToolCallID, params)
	default:
		return "", fmt.Errorf("unsupported method: %s", call.Method)
	}
}

func (s *AgentState) executeReadTextFile(root, sessionID, toolCallID string, params ACPReadTextFileParams) (string, error) {
	absPath, relPath, text, fromPending, err := s.readWorkspaceText(root, params.Path)
	if err != nil {
		return "", err
	}

	body, startLine, lineCount := sliceTextByLines(text, params.Line, params.Limit)
	body, truncated := truncateTextBytes(body, maxCommandFileBytes)

	fields := []resultField{
		{Key: "session_id", Value: sessionID},
		{Key: "tool_call_id", Value: toolCallID},
		{Key: "method", Value: methodReadTextFile},
		{Key: "path", Value: absPath},
		{Key: "relative_path", Value: relPath},
		{Key: "source", Value: map[bool]string{true: "pending_edit", false: "filesystem"}[fromPending]},
	}
	if startLine > 1 {
		fields = append(fields, resultField{Key: "start_line", Value: strconv.Itoa(startLine)})
	}
	if lineCount > 0 {
		fields = append(fields, resultField{Key: "line_count", Value: strconv.Itoa(lineCount)})
	}
	fields = append(fields, resultField{Key: "truncated", Value: strconv.FormatBool(truncated)})

	return formatACPToolResult(fields, wrapTextBlock(body)), nil
}

func (s *AgentState) executeReadTextFiles(root, sessionID, toolCallID string, params ACPReadTextFilesParams) (string, error) {
	if len(params.Paths) == 0 {
		return "", errors.New("paths are required")
	}
	paths := params.Paths
	if len(paths) > maxCommandReadFiles {
		paths = paths[:maxCommandReadFiles]
	}

	var sections []string
	for _, path := range paths {
		absPath, relPath, text, fromPending, err := s.readWorkspaceText(root, path)
		if err != nil {
			return "", err
		}
		body, truncated := truncateTextBytes(text, maxCommandFileBytes)
		sections = append(sections, strings.Join([]string{
			"path: " + absPath,
			"relative_path: " + relPath,
			"source: " + map[bool]string{true: "pending_edit", false: "filesystem"}[fromPending],
			"truncated: " + strconv.FormatBool(truncated),
			wrapTextBlock(body),
		}, "\n"))
	}

	fields := []resultField{
		{Key: "session_id", Value: sessionID},
		{Key: "tool_call_id", Value: toolCallID},
		{Key: "method", Value: methodWorkspaceReadFiles},
		{Key: "file_count", Value: strconv.Itoa(len(paths))},
	}
	return formatACPToolResult(fields, strings.Join(sections, "\n\n")), nil
}

func (s *AgentState) executeWriteTextFile(root, sessionID, toolCallID string, params ACPWriteTextFileParams) (string, error) {
	if strings.TrimSpace(params.Path) == "" {
		return "", errors.New("path is required")
	}
	absPath, relPath, err := resolveWorkspacePath(root, params.Path)
	if err != nil {
		return "", err
	}
	info, err := s.stageWriteTextFile(params.Path, params.Content)
	if err != nil {
		return "", err
	}

	fields := []resultField{
		{Key: "session_id", Value: sessionID},
		{Key: "tool_call_id", Value: toolCallID},
		{Key: "method", Value: methodWriteTextFile},
		{Key: "path", Value: absPath},
		{Key: "relative_path", Value: relPath},
		{Key: "staged_bytes", Value: strconv.Itoa(info.Bytes)},
		{Key: "original_bytes", Value: strconv.Itoa(info.OriginalSize)},
		{Key: "result", Value: "staged_pending_save"},
	}
	if info.Existed {
		fields = append(fields, resultField{Key: "mode", Value: "update"})
	} else {
		fields = append(fields, resultField{Key: "mode", Value: "create"})
	}

	body := "The edit has been staged in the local bridge but has not been written to disk.\nThe user must review it with `pending` / `show` and confirm with `save`."
	return formatACPToolResult(fields, body), nil
}

func (s *AgentState) executeRunCommand(root, sessionID, toolCallID string, params ACPRunCommandParams) (string, error) {
	snapshot, err := s.terminals.Create(root, sessionID, ACPCreateTerminalParams{
		Command:         params.Command,
		Args:            params.Args,
		Env:             params.Env,
		Cwd:             params.Cwd,
		OutputByteLimit: params.OutputByteLimit,
	})
	if err != nil {
		return "", err
	}

	terminalID := snapshot.TerminalID
	defer func() {
		_, _ = s.terminals.Release(terminalID)
	}()

	if params.TimeoutSeconds > 0 {
		waitDone := make(chan struct{})
		var waitErr error
		go func() {
			_, waitErr = s.terminals.WaitForExit(terminalID)
			close(waitDone)
		}()

		select {
		case <-waitDone:
			if waitErr != nil {
				return "", waitErr
			}
		case <-time.After(time.Duration(params.TimeoutSeconds) * time.Second):
			if _, err := s.terminals.Kill(terminalID); err != nil {
				return "", err
			}
		}
	} else {
		if _, err := s.terminals.WaitForExit(terminalID); err != nil {
			return "", err
		}
	}

	snapshot, err = s.terminals.Output(terminalID)
	if err != nil {
		return "", err
	}

	fields := []resultField{
		{Key: "session_id", Value: sessionID},
		{Key: "tool_call_id", Value: toolCallID},
		{Key: "method", Value: methodWorkspaceRunCmd},
		{Key: "terminal_id", Value: terminalID},
		{Key: "command", Value: formatCommandLine(snapshot.Command, snapshot.Args)},
		{Key: "cwd", Value: snapshot.Cwd},
		{Key: "truncated", Value: strconv.FormatBool(snapshot.Truncated)},
	}
	if snapshot.ExitCode != nil {
		fields = append(fields, resultField{Key: "exit_code", Value: strconv.Itoa(*snapshot.ExitCode)})
	}
	if snapshot.Signal != "" {
		fields = append(fields, resultField{Key: "signal", Value: snapshot.Signal})
	}

	body := wrapTextBlock(snapshot.Output)
	if strings.TrimSpace(snapshot.Output) == "" {
		body = "The command completed without terminal output."
	}
	return formatACPToolResult(fields, body), nil
}

func (s *AgentState) executeCreateTerminal(root, sessionID, toolCallID string, params ACPCreateTerminalParams) (string, error) {
	snapshot, err := s.terminals.Create(root, sessionID, params)
	if err != nil {
		return "", err
	}

	fields := []resultField{
		{Key: "session_id", Value: sessionID},
		{Key: "tool_call_id", Value: toolCallID},
		{Key: "method", Value: methodTerminalNew},
		{Key: "terminal_id", Value: snapshot.TerminalID},
		{Key: "command", Value: formatCommandLine(snapshot.Command, snapshot.Args)},
		{Key: "cwd", Value: snapshot.Cwd},
		{Key: "running", Value: strconv.FormatBool(snapshot.Running)},
	}
	body := "Terminal created. Use `terminal/output`, `terminal/wait_for_exit`, and `terminal/release` with this terminalId."
	return formatACPToolResult(fields, body), nil
}

func (s *AgentState) executeTerminalOutput(sessionID, toolCallID string, params ACPTerminalRefParams) (string, error) {
	snapshot, err := s.terminals.Output(params.TerminalID)
	if err != nil {
		return "", err
	}

	fields := []resultField{
		{Key: "session_id", Value: sessionID},
		{Key: "tool_call_id", Value: toolCallID},
		{Key: "method", Value: methodTerminalOut},
		{Key: "terminal_id", Value: snapshot.TerminalID},
		{Key: "command", Value: formatCommandLine(snapshot.Command, snapshot.Args)},
		{Key: "cwd", Value: snapshot.Cwd},
		{Key: "running", Value: strconv.FormatBool(snapshot.Running)},
		{Key: "truncated", Value: strconv.FormatBool(snapshot.Truncated)},
	}
	if snapshot.ExitCode != nil {
		fields = append(fields, resultField{Key: "exit_code", Value: strconv.Itoa(*snapshot.ExitCode)})
	}
	body := wrapTextBlock(snapshot.Output)
	if strings.TrimSpace(snapshot.Output) == "" {
		body = "No terminal output has been captured yet."
	}
	return formatACPToolResult(fields, body), nil
}

func (s *AgentState) executeTerminalWait(sessionID, toolCallID string, params ACPTerminalRefParams) (string, error) {
	snapshot, err := s.terminals.WaitForExit(params.TerminalID)
	if err != nil {
		return "", err
	}

	fields := []resultField{
		{Key: "session_id", Value: sessionID},
		{Key: "tool_call_id", Value: toolCallID},
		{Key: "method", Value: methodTerminalWait},
		{Key: "terminal_id", Value: snapshot.TerminalID},
		{Key: "command", Value: formatCommandLine(snapshot.Command, snapshot.Args)},
		{Key: "cwd", Value: snapshot.Cwd},
	}
	if snapshot.ExitCode != nil {
		fields = append(fields, resultField{Key: "exit_code", Value: strconv.Itoa(*snapshot.ExitCode)})
	}
	if snapshot.Signal != "" {
		fields = append(fields, resultField{Key: "signal", Value: snapshot.Signal})
	}
	return formatACPToolResult(fields, "The terminal command has exited."), nil
}

func (s *AgentState) executeTerminalKill(sessionID, toolCallID string, params ACPTerminalRefParams) (string, error) {
	snapshot, err := s.terminals.Kill(params.TerminalID)
	if err != nil {
		return "", err
	}

	fields := []resultField{
		{Key: "session_id", Value: sessionID},
		{Key: "tool_call_id", Value: toolCallID},
		{Key: "method", Value: methodTerminalKill},
		{Key: "terminal_id", Value: snapshot.TerminalID},
		{Key: "command", Value: formatCommandLine(snapshot.Command, snapshot.Args)},
	}
	if snapshot.ExitCode != nil {
		fields = append(fields, resultField{Key: "exit_code", Value: strconv.Itoa(*snapshot.ExitCode)})
	}
	return formatACPToolResult(fields, "The terminal command has been terminated."), nil
}

func (s *AgentState) executeTerminalRelease(sessionID, toolCallID string, params ACPTerminalRefParams) (string, error) {
	snapshot, err := s.terminals.Release(params.TerminalID)
	if err != nil {
		return "", err
	}

	fields := []resultField{
		{Key: "session_id", Value: sessionID},
		{Key: "tool_call_id", Value: toolCallID},
		{Key: "method", Value: methodTerminalDrop},
		{Key: "terminal_id", Value: snapshot.TerminalID},
		{Key: "command", Value: formatCommandLine(snapshot.Command, snapshot.Args)},
	}
	return formatACPToolResult(fields, "The terminal handle has been released and can no longer be used."), nil
}

func (s *AgentState) readWorkspaceText(root, rawPath string) (string, string, string, bool, error) {
	absPath, relPath, err := resolveWorkspacePath(root, rawPath)
	if err != nil {
		return "", "", "", false, err
	}

	s.mu.Lock()
	if pending := s.pending[absPath]; pending != nil {
		text := pending.StagedText
		s.mu.Unlock()
		return absPath, relPath, text, true, nil
	}
	s.mu.Unlock()

	body, err := os.ReadFile(absPath)
	if err != nil {
		return "", "", "", false, err
	}
	return absPath, relPath, string(body), false, nil
}

func sliceTextByLines(text string, line, limit int) (string, int, int) {
	if line <= 0 {
		line = 1
	}
	lines := strings.Split(text, "\n")
	startIndex := line - 1
	if startIndex >= len(lines) {
		return "", line, 0
	}

	endIndex := len(lines)
	if limit > 0 && startIndex+limit < endIndex {
		endIndex = startIndex + limit
	}
	return strings.Join(lines[startIndex:endIndex], "\n"), startIndex + 1, endIndex - startIndex
}

func truncateTextBytes(text string, limit int) (string, bool) {
	if limit <= 0 || len(text) <= limit {
		return text, false
	}
	trimmed := text[:limit]
	for len(trimmed) > 0 && !utf8.ValidString(trimmed) {
		trimmed = trimmed[:len(trimmed)-1]
	}
	if trimmed == "" {
		return "", true
	}
	return trimmed + "\n\n[output truncated]", true
}

func wrapTextBlock(text string) string {
	if text == "" {
		return "```text\n```"
	}
	var b strings.Builder
	b.WriteString("```text\n")
	b.WriteString(text)
	if !strings.HasSuffix(text, "\n") {
		b.WriteString("\n")
	}
	b.WriteString("```")
	return b.String()
}

func formatACPToolResult(fields []resultField, body string) string {
	var b strings.Builder
	b.WriteString("[ACP Tool Result]\n")
	for _, field := range fields {
		if strings.TrimSpace(field.Value) == "" {
			continue
		}
		b.WriteString(field.Key)
		b.WriteString(": ")
		b.WriteString(field.Value)
		b.WriteString("\n")
	}
	if strings.TrimSpace(body) != "" {
		b.WriteString("\n")
		b.WriteString(body)
	}
	return strings.TrimSpace(b.String())
}

func rewriteLegacyToolResult(method, sessionID, toolCallID, legacy string) string {
	legacy = strings.TrimSpace(legacy)
	if legacy == "" {
		return formatACPToolResult([]resultField{
			{Key: "session_id", Value: sessionID},
			{Key: "tool_call_id", Value: toolCallID},
			{Key: "method", Value: method},
		}, "")
	}

	fields := []resultField{
		{Key: "session_id", Value: sessionID},
		{Key: "tool_call_id", Value: toolCallID},
		{Key: "method", Value: method},
	}

	lines := strings.SplitN(legacy, "\n", 2)
	body := ""
	if len(lines) > 1 {
		body = lines[1]
	}
	return formatACPToolResult(fields, body)
}

func formatCommandLine(command string, args []string) string {
	parts := []string{strings.TrimSpace(command)}
	for _, arg := range args {
		arg = strings.TrimSpace(arg)
		if arg == "" {
			continue
		}
		parts = append(parts, arg)
	}
	return strings.TrimSpace(strings.Join(parts, " "))
}

func resolveWorkspaceDir(root, rawPath string) (string, string, error) {
	if strings.TrimSpace(rawPath) == "" || strings.TrimSpace(rawPath) == "." {
		return root, ".", nil
	}

	absPath, relPath, err := resolveWorkspacePath(root, rawPath)
	if err != nil {
		return "", "", err
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		return "", "", fmt.Errorf("not a directory: %s", relPath)
	}
	return absPath, relPath, nil
}

func (m *TerminalManager) Create(root, sessionID string, params ACPCreateTerminalParams) (TerminalSnapshot, error) {
	command := strings.TrimSpace(params.Command)
	if command == "" {
		return TerminalSnapshot{}, errors.New("command is required")
	}

	cwdAbs, _, err := resolveWorkspaceDir(root, params.Cwd)
	if err != nil {
		return TerminalSnapshot{}, err
	}

	outputLimit := params.OutputByteLimit
	if outputLimit <= 0 {
		outputLimit = defaultTerminalByteLimit
	}
	if outputLimit > maxTerminalByteLimit {
		outputLimit = maxTerminalByteLimit
	}

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, command, params.Args...)
	cmd.Dir = cwdAbs
	if len(params.Env) > 0 {
		env := append([]string(nil), os.Environ()...)
		for _, item := range params.Env {
			if strings.TrimSpace(item.Name) == "" {
				continue
			}
			env = append(env, item.Name+"="+item.Value)
		}
		cmd.Env = env
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return TerminalSnapshot{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return TerminalSnapshot{}, err
	}

	m.mu.Lock()
	m.seq++
	terminalID := fmt.Sprintf("term_%04d", m.seq)
	entry := &TerminalEntry{
		ID:          terminalID,
		SessionID:   sessionID,
		Command:     command,
		Args:        append([]string(nil), params.Args...),
		Cwd:         cwdAbs,
		OutputLimit: outputLimit,
		Running:     true,
		UpdatedAt:   time.Now(),
		waitCh:      make(chan struct{}),
		cancel:      cancel,
		cmd:         cmd,
	}
	m.items[terminalID] = entry
	m.mu.Unlock()

	if err := cmd.Start(); err != nil {
		cancel()
		m.mu.Lock()
		delete(m.items, terminalID)
		m.mu.Unlock()
		return TerminalSnapshot{}, err
	}

	go m.capture(terminalID, stdout)
	go m.capture(terminalID, stderr)
	go m.wait(entry)

	return m.snapshot(terminalID)
}

func (m *TerminalManager) capture(terminalID string, reader io.ReadCloser) {
	defer reader.Close()

	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			m.appendOutput(terminalID, string(buf[:n]))
		}
		if err != nil {
			return
		}
	}
}

func (m *TerminalManager) appendOutput(terminalID, chunk string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	entry := m.items[terminalID]
	if entry == nil {
		return
	}
	entry.Output += chunk
	if len(entry.Output) > entry.OutputLimit {
		entry.Truncated = true
		trimmed := entry.Output[len(entry.Output)-entry.OutputLimit:]
		for len(trimmed) > 0 && !utf8.ValidString(trimmed) {
			trimmed = trimmed[1:]
		}
		entry.Output = trimmed
	}
	entry.UpdatedAt = time.Now()
}

func (m *TerminalManager) wait(entry *TerminalEntry) {
	err := entry.cmd.Wait()

	m.mu.Lock()
	defer m.mu.Unlock()

	if current := m.items[entry.ID]; current != nil {
		current.Running = false
		current.UpdatedAt = time.Now()
		if current.cmd != nil && current.cmd.ProcessState != nil {
			exitCode := current.cmd.ProcessState.ExitCode()
			current.ExitCode = &exitCode
		}
		if err != nil && current.ExitCode == nil {
			exitCode := 1
			current.ExitCode = &exitCode
		}
		close(current.waitCh)
	}
}

func (m *TerminalManager) snapshot(terminalID string) (TerminalSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	entry := m.items[terminalID]
	if entry == nil {
		return TerminalSnapshot{}, fmt.Errorf("terminal not found: %s", terminalID)
	}
	return TerminalSnapshot{
		TerminalID: entry.ID,
		Command:    entry.Command,
		Args:       append([]string(nil), entry.Args...),
		Cwd:        entry.Cwd,
		Output:     entry.Output,
		Truncated:  entry.Truncated,
		ExitCode:   cloneIntPointer(entry.ExitCode),
		Signal:     entry.Signal,
		Running:    entry.Running,
		UpdatedAt:  entry.UpdatedAt,
	}, nil
}

func cloneIntPointer(value *int) *int {
	if value == nil {
		return nil
	}
	next := *value
	return &next
}

func (m *TerminalManager) Output(terminalID string) (TerminalSnapshot, error) {
	return m.snapshot(terminalID)
}

func (m *TerminalManager) WaitForExit(terminalID string) (TerminalSnapshot, error) {
	m.mu.Lock()
	entry := m.items[terminalID]
	if entry == nil {
		m.mu.Unlock()
		return TerminalSnapshot{}, fmt.Errorf("terminal not found: %s", terminalID)
	}
	waitCh := entry.waitCh
	m.mu.Unlock()

	<-waitCh
	return m.snapshot(terminalID)
}

func (m *TerminalManager) Kill(terminalID string) (TerminalSnapshot, error) {
	m.mu.Lock()
	entry := m.items[terminalID]
	if entry == nil {
		m.mu.Unlock()
		return TerminalSnapshot{}, fmt.Errorf("terminal not found: %s", terminalID)
	}
	running := entry.Running
	cmd := entry.cmd
	m.mu.Unlock()

	if running && cmd != nil && cmd.Process != nil {
		if err := cmd.Process.Kill(); err != nil && !strings.Contains(strings.ToLower(err.Error()), "already finished") {
			return TerminalSnapshot{}, err
		}
	}
	return m.WaitForExit(terminalID)
}

func (m *TerminalManager) Release(terminalID string) (TerminalSnapshot, error) {
	snapshot, err := m.snapshot(terminalID)
	if err != nil {
		return TerminalSnapshot{}, err
	}

	m.mu.Lock()
	entry := m.items[terminalID]
	delete(m.items, terminalID)
	m.mu.Unlock()

	if entry != nil && entry.Running && entry.cmd != nil && entry.cmd.Process != nil {
		_ = entry.cmd.Process.Kill()
	}
	if entry != nil && entry.cancel != nil {
		entry.cancel()
	}

	return snapshot, nil
}

func (m *TerminalManager) ReleaseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.items))
	for id := range m.items {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	m.mu.Unlock()

	for _, id := range ids {
		_, _ = m.Release(id)
	}
}

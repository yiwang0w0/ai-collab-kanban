package lifecycle

import (
	"context"
	"errors"
	"strings"

	agentctl "github.com/kandev/kandev/internal/agent/runtime/agentctl"
	"github.com/kandev/kandev/internal/agentctl/types/streams"
)

// EnableWorkActivity 在进程前为已绑定回合开启精简协议活动证据，不启动或恢复代理。
func (m *Manager) EnableWorkActivity(_ context.Context, executionID, turnID string) error {
	execution, exists := m.executionStore.Get(executionID)
	if !exists || executionOwnerKind(execution) != ExecutionOwnerTask {
		return errors.New("work_activity_execution_unavailable")
	}
	execution.promptLifecycleMu.Lock()
	valid := turnID != "" && execution.promptTurnID == turnID && execution.promptGeneration == 0
	execution.promptLifecycleMu.Unlock()
	if !valid {
		return errors.New("work_activity_turn_identity_conflict")
	}
	execution.workActivityCapture.Store(true)
	return nil
}

// publishWorkActivity 在协议输入边界捕获身份，不依赖合并文本或发布时的最新回合。
func (m *Manager) publishWorkActivity(execution *AgentExecution, event agentctl.AgentEvent, attemptID string) {
	if !execution.workActivityCapture.Load() || !eligibleWorkActivityIngress(execution, event) {
		return
	}
	kind := workActivityKind(execution, event)
	if kind == "" {
		return
	}
	// 非终结协议活动在此尚未进入回合锁；捕获后即释放，不持锁发布总线事件。
	execution.promptLifecycleMu.Lock()
	generation := event.PromptGeneration
	if generation == 0 {
		generation = execution.promptGeneration
	}
	turnID := execution.promptTurnIDs[generation]
	execution.promptLifecycleMu.Unlock()
	if generation == 0 || turnID == "" || (event.TurnID != "" && event.TurnID != turnID) {
		return
	}
	captured := agentctl.AgentEvent{Type: "work_activity", TurnID: turnID, PromptGeneration: generation,
		OperationID: event.OperationID, TurnStartSource: event.TurnStartSource, Role: event.Role, ToolCallID: event.ToolCallID,
		Data: map[string]interface{}{"host_activity_kind": kind}}
	m.eventPublisher.publishAgentStreamEventWithAttempt(execution, captured, attemptID)
}

func eligibleWorkActivityIngress(execution *AgentExecution, event agentctl.AgentEvent) bool {
	if executionOwnerKind(execution) != ExecutionOwnerTask || event.ParentToolCallID != "" ||
		event.ProviderDiagnosticCandidate || (event.Role != "" && event.Role != "assistant") {
		return false
	}
	switch execution.AgentID {
	case "claude-acp", "codex-acp", "codex-app-server":
		return true
	default:
		return false
	}
}

func workActivityKind(execution *AgentExecution, event agentctl.AgentEvent) string {
	switch event.Type {
	case "message_chunk":
		if strings.TrimSpace(event.Text) != "" {
			return "assistant"
		}
	case "reasoning":
		if strings.TrimSpace(event.ReasoningText) != "" {
			return "assistant"
		}
	case "tool_call", "tool_update":
		if event.ToolCallID != "" {
			return "tool"
		}
	case streams.EventTypeTurnStarted:
		if execution.AgentID == "codex-app-server" && event.TurnStartSource == streams.TurnStartCodexProvider && event.OperationID != "" {
			return "provider_turn_started"
		}
	}
	return ""
}

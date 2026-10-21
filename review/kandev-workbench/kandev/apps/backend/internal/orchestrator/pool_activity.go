package orchestrator

import (
	"context"
	"strings"

	"go.uber.org/zap"

	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	"github.com/kandev/kandev/internal/agentctl/types/streams"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

func (s *Service) observePoolStreamActivity(ctx context.Context, payload *lifecycle.AgentStreamEventPayload) {
	recorder, supported := s.poolTaskStartGuard.(PoolActivityRecorder)
	if !supported {
		return
	}
	activity, trusted := poolStreamActivity(payload)
	if !trusted {
		return
	}
	if _, err := recorder.ObservePoolActivity(ctx, activity); err != nil {
		s.logger.Warn("pool_activity_evidence_unconfirmed", zap.String("task_id", activity.TaskID),
			zap.String("session_id", activity.SessionID), zap.String("execution_id", activity.ExecutionID), zap.Error(err))
	}
}

// poolStreamActivity 只识别主轮次的真实活动，不把通用 turn_started、回显或诊断当开工。
func poolStreamActivity(payload *lifecycle.AgentStreamEventPayload) (runsmodels.PoolExecutionActivity, bool) {
	if !validPoolStreamOwner(payload) || !validPoolStreamPrompt(payload.Data) {
		return runsmodels.PoolExecutionActivity{}, false
	}
	d := payload.Data
	source := poolStreamWorkSource(payload)
	if source == "" {
		return runsmodels.PoolExecutionActivity{}, false
	}
	return runsmodels.PoolExecutionActivity{TaskID: payload.TaskID, AgentProfileID: payload.AgentProfileID,
		SessionID: payload.SessionID, ExecutionID: payload.ExecutionID, TurnID: d.TurnID,
		OperationID: d.OperationID, PromptGeneration: int64(d.PromptGeneration), AgentType: payload.AgentType, StartedSource: source}, true
}

func validPoolStreamOwner(p *lifecycle.AgentStreamEventPayload) bool {
	return p != nil && p.Data != nil && p.OwnerKind == lifecycle.ExecutionOwnerTask && p.RunID == "" &&
		p.RunSessionID == "" && p.ExecutionID != "" && (p.AgentID == "" || p.AgentID == p.ExecutionID) &&
		p.TaskID != "" && p.SessionID != "" && p.AgentProfileID != ""
}

func validPoolStreamPrompt(d *lifecycle.AgentStreamEventData) bool {
	return d.PromptGeneration == 1 && d.TurnID != "" && d.ParentToolCallID == "" && !d.ProviderDiagnosticCandidate &&
		(d.Role == "" || d.Role == "assistant")
}

func poolStreamWorkSource(payload *lifecycle.AgentStreamEventPayload) runsmodels.PoolStartSource {
	d := payload.Data
	switch d.Type {
	case "work_activity":
		return compactPoolWorkSource(payload)
	case "turn_started":
		if payload.AgentType != codexAppServerAgentType || d.TurnStartSource != streams.TurnStartCodexProvider || d.OperationID == "" {
			return ""
		}
		return runsmodels.PoolStartCodexProvider
	case "message_streaming", "thinking_streaming":
		if strings.TrimSpace(d.Text) != "" {
			return runsmodels.PoolStartAssistant
		}
	case "tool_call", "tool_update":
		if d.ToolCallID != "" {
			return runsmodels.PoolStartTool
		}
	}
	return ""
}

func compactPoolWorkSource(payload *lifecycle.AgentStreamEventPayload) runsmodels.PoolStartSource {
	data, ok := payload.Data.Data.(map[string]interface{})
	if !ok {
		return ""
	}
	switch data["host_activity_kind"] {
	case "assistant":
		return runsmodels.PoolStartAssistant
	case "tool":
		if payload.Data.ToolCallID != "" {
			return runsmodels.PoolStartTool
		}
	case "provider_turn_started":
		if payload.AgentType == codexAppServerAgentType && payload.Data.TurnStartSource == streams.TurnStartCodexProvider && payload.Data.OperationID != "" {
			return runsmodels.PoolStartCodexProvider
		}
	}
	return ""
}

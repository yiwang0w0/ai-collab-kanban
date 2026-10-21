package orchestrator

import (
	"testing"

	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	"github.com/kandev/kandev/internal/agentctl/types/streams"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

func poolActivityPayload() *lifecycle.AgentStreamEventPayload {
	return &lifecycle.AgentStreamEventPayload{TaskID: "task", SessionID: "session", ExecutionID: "execution", AgentID: "execution",
		OwnerKind: lifecycle.ExecutionOwnerTask, AgentProfileID: "fixed-cli", AgentType: "claude-acp",
		Data: &lifecycle.AgentStreamEventData{Type: "message_streaming", Text: "工作活动", Role: "assistant", TurnID: "turn", PromptGeneration: 1}}
}

// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-005.4
func TestPoolActivityClassifierRequiresTrustedPrimaryFirstTurnEvidence(t *testing.T) {
	cases := []struct {
		name   string
		change func(*lifecycle.AgentStreamEventPayload)
		source runsmodels.PoolStartSource
	}{
		{"assistant", func(*lifecycle.AgentStreamEventPayload) {}, runsmodels.PoolStartAssistant},
		{"thinking", func(p *lifecycle.AgentStreamEventPayload) { p.Data.Type = "thinking_streaming" }, runsmodels.PoolStartAssistant},
		{"tool", func(p *lifecycle.AgentStreamEventPayload) { p.Data.Type = "tool_call"; p.Data.ToolCallID = "tool" }, runsmodels.PoolStartTool},
		{"tool-update", func(p *lifecycle.AgentStreamEventPayload) { p.Data.Type = "tool_update"; p.Data.ToolCallID = "tool" }, runsmodels.PoolStartTool},
		{"codex-provider", func(p *lifecycle.AgentStreamEventPayload) {
			p.AgentType = "codex-app-server"
			p.Data.Type = "turn_started"
			p.Data.TurnStartSource = streams.TurnStartCodexProvider
			p.Data.OperationID = "provider-turn"
		}, runsmodels.PoolStartCodexProvider},
		{"public-turn-start", func(p *lifecycle.AgentStreamEventPayload) { p.Data.Type = "turn_started" }, ""},
		{"synthetic-codex-start", func(p *lifecycle.AgentStreamEventPayload) {
			p.AgentType = "codex-app-server"
			p.Data.Type = "turn_started"
			p.Data.OperationID = "operation"
		}, ""},
		{"empty", func(p *lifecycle.AgentStreamEventPayload) { p.Data.Text = " \n" }, ""},
		{"user-echo", func(p *lifecycle.AgentStreamEventPayload) { p.Data.Role = "user" }, ""},
		{"diagnostic", func(p *lifecycle.AgentStreamEventPayload) { p.Data.ProviderDiagnosticCandidate = true }, ""},
		{"child", func(p *lifecycle.AgentStreamEventPayload) { p.Data.ParentToolCallID = "child" }, ""},
		{"unbound-generation", func(p *lifecycle.AgentStreamEventPayload) { p.Data.PromptGeneration = 0 }, ""},
		{"later-generation", func(p *lifecycle.AgentStreamEventPayload) { p.Data.PromptGeneration = 2 }, ""},
		{"missing-turn", func(p *lifecycle.AgentStreamEventPayload) { p.Data.TurnID = "" }, ""},
		{"missing-execution", func(p *lifecycle.AgentStreamEventPayload) { p.ExecutionID = "" }, ""},
		{"wrong-owner", func(p *lifecycle.AgentStreamEventPayload) { p.OwnerKind = lifecycle.ExecutionOwnerRun }, ""},
		{"run-owned-identity", func(p *lifecycle.AgentStreamEventPayload) { p.RunSessionID = "run-session" }, ""},
		{"execution-alias-conflict", func(p *lifecycle.AgentStreamEventPayload) { p.AgentID = "old-execution" }, ""},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			payload := poolActivityPayload()
			item.change(payload)
			activity, trusted := poolStreamActivity(payload)
			require.Equal(t, item.source != "", trusted)
			require.Equal(t, item.source, activity.StartedSource)
			if trusted {
				require.Equal(t, payload.ExecutionID, activity.ExecutionID)
				require.Equal(t, payload.Data.TurnID, activity.TurnID)
				require.Equal(t, int64(1), activity.PromptGeneration)
			}
		})
	}
}

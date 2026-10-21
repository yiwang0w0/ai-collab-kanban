package orchestrator

import (
	"testing"

	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	"github.com/kandev/kandev/internal/agentctl/types/streams"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-002.4
func TestPoolTurnEndClassifierRequiresExactPrimaryTurnAndTypedOutcome(t *testing.T) {
	cases := []struct {
		name    string
		change  func(*lifecycle.AgentStreamEventPayload)
		trusted bool
		failed  bool
	}{
		{"completed", func(*lifecycle.AgentStreamEventPayload) {}, true, false},
		{"failed-retained-runtime", func(p *lifecycle.AgentStreamEventPayload) {
			p.Data.Data = map[string]interface{}{"is_error": true}
			p.Data.PromptFailureDisposition = streams.PromptFailureDispositionRetainRuntime
		}, true, true},
		{"message-is-not-end", func(p *lifecycle.AgentStreamEventPayload) { p.Data.Type = "message_streaming" }, false, false},
		{"user", func(p *lifecycle.AgentStreamEventPayload) { p.Data.Role = "user" }, false, false},
		{"diagnostic", func(p *lifecycle.AgentStreamEventPayload) { p.Data.ProviderDiagnosticCandidate = true }, false, false},
		{"child", func(p *lifecycle.AgentStreamEventPayload) { p.Data.ParentToolCallID = "child" }, false, false},
		{"no-generation", func(p *lifecycle.AgentStreamEventPayload) { p.Data.PromptGeneration = 0 }, false, false},
		{"later-generation", func(p *lifecycle.AgentStreamEventPayload) { p.Data.PromptGeneration = 2 }, false, false},
		{"no-turn", func(p *lifecycle.AgentStreamEventPayload) { p.Data.TurnID = "" }, false, false},
		{"no-execution", func(p *lifecycle.AgentStreamEventPayload) { p.ExecutionID = "" }, false, false},
		{"wrong-owner", func(p *lifecycle.AgentStreamEventPayload) { p.OwnerKind = lifecycle.ExecutionOwnerRun }, false, false},
		{"run-session", func(p *lifecycle.AgentStreamEventPayload) { p.RunSessionID = "run-session" }, false, false},
		{"alias-conflict", func(p *lifecycle.AgentStreamEventPayload) { p.AgentID = "other" }, false, false},
		{"untyped-error", func(p *lifecycle.AgentStreamEventPayload) { p.Data.Data = map[string]interface{}{"is_error": "false"} }, false, false},
		{"invalid-data", func(p *lifecycle.AgentStreamEventPayload) { p.Data.Data = "untrusted" }, false, false},
		{"no-data", func(p *lifecycle.AgentStreamEventPayload) { p.Data = nil }, false, false},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			payload := poolActivityPayload()
			payload.Data.Type, payload.Data.Text = "complete", ""
			item.change(payload)
			activity, failed, trusted := poolStreamTurnEnd(payload)
			require.Equal(t, item.trusted, trusted)
			require.Equal(t, item.failed, failed)
			if trusted {
				require.Equal(t, payload.ExecutionID, activity.ExecutionID)
				require.Equal(t, payload.Data.TurnID, activity.TurnID)
				require.Equal(t, int64(1), activity.PromptGeneration)
				require.Empty(t, activity.StartedSource, "回合结果不能冒充开工来源")
			}
		})
	}
}

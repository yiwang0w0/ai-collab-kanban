package orchestrator

import (
	"testing"

	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	"github.com/kandev/kandev/internal/orchestrator/watcher"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolExecutionStopClassifierRequiresPrimaryAllocatedScope(t *testing.T) {
	cases := []struct {
		name    string
		change  func(*watcher.AgentEventData)
		trusted bool
	}{
		{"confirmed", func(*watcher.AgentEventData) {}, true},
		{"pending-activity", func(d *watcher.AgentEventData) { d.RuntimeStopConfirmation.ExecutionActivityReleased = false }, true},
		{"logical-stop", func(d *watcher.AgentEventData) { d.RuntimeStopConfirmation = nil }, false},
		{"unknown-source", func(d *watcher.AgentEventData) { d.RuntimeStopConfirmation.Source = "agent.stopped" }, false},
		{"empty-runtime", func(d *watcher.AgentEventData) { d.RuntimeStopConfirmation.RuntimeInstanceID = "" }, false},
		{"run-owner", func(d *watcher.AgentEventData) { d.OwnerKind = string(lifecycle.ExecutionOwnerRun) }, false},
		{"empty-generation", func(d *watcher.AgentEventData) { d.PromptGeneration = 0 }, false},
		{"later-generation", func(d *watcher.AgentEventData) { d.PromptGeneration = 2 }, false},
		{"empty-task", func(d *watcher.AgentEventData) { d.TaskID = "" }, false},
		{"empty-session", func(d *watcher.AgentEventData) { d.SessionID = "" }, false},
		{"empty-execution", func(d *watcher.AgentEventData) { d.AgentExecutionID = "" }, false},
		{"empty-turn", func(d *watcher.AgentEventData) { d.TurnID = "" }, false},
		{"empty-agent", func(d *watcher.AgentEventData) { d.AgentID = "" }, false},
		{"wrong-profile", func(d *watcher.AgentEventData) { d.ExecutionProfileID = "other" }, false},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			data := watcher.AgentEventData{OwnerKind: string(lifecycle.ExecutionOwnerTask), TaskID: "task", SessionID: "session",
				AgentExecutionID: "execution", AgentID: "claude-acp", AgentProfileID: "fixed-cli", ExecutionProfileID: "fixed-cli", TurnID: "turn", PromptGeneration: 1,
				RuntimeStopConfirmation: &lifecycle.RuntimeStopConfirmation{Source: lifecycle.RuntimeStopSourceStandaloneControl, RuntimeInstanceID: "control-instance", ExecutionActivityReleased: true}}
			item.change(&data)
			require.Equal(t, item.trusted, trustedPoolExecutionStop(data))
		})
	}
}

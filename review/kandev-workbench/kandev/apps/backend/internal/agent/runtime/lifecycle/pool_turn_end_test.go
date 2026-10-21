package lifecycle

import (
	"context"
	"testing"

	agentctl "github.com/kandev/kandev/internal/agent/runtime/agentctl"
	"github.com/kandev/kandev/internal/agentctl/types/streams"
	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	"github.com/stretchr/testify/require"
)

type poolTurnAdvancingEventBus struct {
	*MockEventBusWithTracking
	execution  *AgentExecution
	store      *ExecutionStore
	generation uint64
	err        error
}

func (b *poolTurnAdvancingEventBus) Publish(ctx context.Context, subject string, event *bus.Event) error {
	if subject == events.AgentReady {
		b.execution.setPromptTurnID("successor-turn")
		b.generation, b.err = b.store.BeginPrompt(b.execution.ID)
	}
	return b.MockEventBusWithTracking.Publish(ctx, subject, event)
}

// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-002.3
func TestPoolTurnEndIngressKeepsCompletedIdentityAfterReadyAdvancesToSuccessor(t *testing.T) {
	mgr, tracking := createTestManagerWithTracking()
	execution := createTestExecution("pool-end-execution", "pool-end-task", "pool-end-session")
	execution.AgentID, execution.AgentProfileID = "codex-app-server", "pool-fixed-profile"
	execution.setPromptTurnID("completed-turn")
	require.NoError(t, mgr.executionStore.Add(execution))
	require.NoError(t, mgr.EnableWorkActivity(context.Background(), execution.ID, "completed-turn"))
	generation, err := mgr.executionStore.BeginPrompt(execution.ID)
	require.NoError(t, err)
	advancing := &poolTurnAdvancingEventBus{MockEventBusWithTracking: tracking, execution: execution, store: mgr.executionStore}
	mgr.eventBus, mgr.eventPublisher = advancing, NewEventPublisher(advancing, mgr.logger)
	mgr.handleAgentEvent(execution, agentctl.AgentEvent{Type: streams.EventTypeComplete,
		PromptGeneration: generation, OperationID: "completed-provider-operation", Data: map[string]interface{}{"is_error": false}})
	require.NoError(t, advancing.err)
	require.Equal(t, generation+1, advancing.generation, "正对照必须已在原生 Ready 回调中开启后继回合")
	require.Equal(t, "successor-turn", execution.promptTurnIDSnapshot())
	var completed []AgentStreamEventPayload
	for _, event := range tracking.getStreamEvents() {
		if event.Data != nil && event.Data.Type == streams.EventTypeComplete {
			completed = append(completed, event)
		}
	}
	require.Len(t, completed, 1)
	require.Equal(t, execution.ID, completed[0].ExecutionID)
	require.Equal(t, execution.SessionID, completed[0].SessionID)
	require.Equal(t, execution.AgentProfileID, completed[0].AgentProfileID)
	require.Equal(t, generation, completed[0].Data.PromptGeneration)
	require.Equal(t, "completed-turn", completed[0].Data.TurnID)
	require.Equal(t, "completed-provider-operation", completed[0].Data.OperationID)
}

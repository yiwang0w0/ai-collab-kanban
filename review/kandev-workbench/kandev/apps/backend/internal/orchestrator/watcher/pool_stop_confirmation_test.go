package watcher

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolStopConfirmationSurvivesNativeWatcherDecode(t *testing.T) {
	w := &Watcher{logger: logger.Default()}
	var observed map[string]json.RawMessage
	handler := w.createAgentEventHandler(func(_ context.Context, data AgentEventData) {
		encoded, err := json.Marshal(data)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(encoded, &observed))
	})
	payload := lifecycle.AgentEventPayload{OwnerKind: lifecycle.ExecutionOwnerTask, TaskID: "pool-task", SessionID: "pool-session",
		AgentExecutionID: "pool-execution", AgentID: "claude-acp", AgentProfileID: "pool-profile", ExecutionProfileID: "pool-profile",
		TurnID: "pool-turn", PromptGeneration: 1, RuntimeStopConfirmation: &lifecycle.RuntimeStopConfirmation{
			Source: lifecycle.RuntimeStopSourceStandaloneControl, RuntimeInstanceID: "control-instance", ExecutionActivityReleased: false}}
	encoded, err := json.Marshal(payload)
	require.NoError(t, err)
	var wire map[string]interface{}
	require.NoError(t, json.Unmarshal(encoded, &wire))
	require.NoError(t, handler(context.Background(), bus.NewEvent(events.AgentStopped, "agent-manager", wire)))
	require.NotEmpty(t, observed["runtime_stop_confirmation"], "原生停止确认不能在生命周期解码处丢失")
	var proof lifecycle.RuntimeStopConfirmation
	require.NoError(t, json.Unmarshal(observed["runtime_stop_confirmation"], &proof))
	require.Equal(t, *payload.RuntimeStopConfirmation, proof, "false 的活动释放状态也必须保留，不补真值")
}

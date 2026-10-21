package lifecycle

import (
	"context"
	"testing"

	agentctl "github.com/kandev/kandev/internal/agent/runtime/agentctl"
	"github.com/kandev/kandev/internal/agentctl/types/streams"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-002.3
func TestPoolWorkActivityIngressRejectsEchoDiagnosticsChildrenAndUnknownGeneration(t *testing.T) {
	cases := map[string]agentctl.AgentEvent{
		"user":               {Type: "message_chunk", Text: "用户回显", Role: "user"},
		"diagnostic":         {Type: "message_chunk", Text: "诊断", ProviderDiagnosticCandidate: true},
		"child":              {Type: "message_chunk", Text: "子代理", ParentToolCallID: "child"},
		"child-tool":         {Type: "tool_call", ToolCallID: "tool", ParentToolCallID: "child"},
		"unknown-generation": {Type: "message_chunk", Text: "不能匹配", PromptGeneration: 99},
		"wrong-turn":         {Type: "message_chunk", Text: "旧回合", TurnID: "wrong-turn", PromptGeneration: 1},
		"synthetic-start":    {Type: streams.EventTypeTurnStarted},
	}
	for name, incoming := range cases {
		t.Run(name, func(t *testing.T) {
			mgr, eventBus := createTestManagerWithTracking()
			execution := createTestExecution("work-reject", "task", "session")
			execution.AgentID = "codex-app-server"
			execution.setPromptTurnID("current-turn")
			require.NoError(t, mgr.executionStore.Add(execution))
			require.NoError(t, mgr.EnableWorkActivity(context.Background(), execution.ID, "current-turn"))
			_, err := mgr.executionStore.BeginPrompt(execution.ID)
			require.NoError(t, err)
			mgr.handleAgentEvent(execution, incoming)
			for _, event := range eventBus.getStreamEvents() {
				require.NotEqual(t, "work_activity", event.Data.Type)
			}
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-005.4
func TestPoolWorkActivityEnableRequiresNativeExecutionAndBoundInitialTurn(t *testing.T) {
	mgr, _ := createTestManagerWithTracking()
	require.Error(t, mgr.EnableWorkActivity(context.Background(), "missing", "turn"))
	execution := createTestExecution("enable-work", "task", "session")
	execution.setPromptTurnID("bound-turn")
	require.NoError(t, mgr.executionStore.Add(execution))
	require.Error(t, mgr.EnableWorkActivity(context.Background(), execution.ID, "wrong-turn"))
	require.False(t, execution.workActivityCapture.Load())
	require.NoError(t, mgr.EnableWorkActivity(context.Background(), execution.ID, "bound-turn"))
	require.True(t, execution.workActivityCapture.Load())
	_, err := mgr.executionStore.BeginPrompt(execution.ID)
	require.NoError(t, err)
	require.Error(t, mgr.EnableWorkActivity(context.Background(), execution.ID, "bound-turn"), "已开始的执行不能补造启动前授权")
}

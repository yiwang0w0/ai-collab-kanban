package lifecycle

import (
	"context"
	"testing"

	agentctl "github.com/kandev/kandev/internal/agent/runtime/agentctl"
	"github.com/kandev/kandev/internal/agentctl/types/streams"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.4
func TestPoolWorkActivityCaptureDoesNotChangeOrdinaryExecutionsByDefault(t *testing.T) {
	mgr, eventBus := createTestManagerWithTracking()
	execution := createTestExecution("ordinary-execution", "ordinary-task", "ordinary-session")
	execution.AgentID = "claude-acp"
	execution.setPromptTurnID("ordinary-turn")
	require.NoError(t, mgr.executionStore.Add(execution))
	_, err := mgr.executionStore.BeginPrompt(execution.ID)
	require.NoError(t, err)
	mgr.handleAgentEvent(execution, agentctl.AgentEvent{Type: "message_chunk", Text: "普通工作\n"})
	for _, event := range eventBus.getStreamEvents() {
		require.NotEqual(t, "work_activity", event.Data.Type, "未显式启用的普通执行不能新增证据事件")
	}
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-002.2
func TestPoolWorkActivityCapturesActualIngressBeforeCoalescingWithoutContent(t *testing.T) {
	mgr, eventBus := createTestManagerWithTracking()
	execution := createTestExecution("work-execution", "work-task", "work-session")
	execution.AgentID = "claude-acp"
	execution.AgentProfileID = "work-profile"
	execution.setPromptTurnID("captured-turn")
	require.NoError(t, mgr.executionStore.Add(execution))
	require.NoError(t, mgr.EnableWorkActivity(context.Background(), execution.ID, "captured-turn"))
	generation, err := mgr.executionStore.BeginPrompt(execution.ID)
	require.NoError(t, err)
	for _, event := range []agentctl.AgentEvent{
		{Type: "message_chunk", Text: "不得写入活动证据的原文", PromptGeneration: generation},
		{Type: "reasoning", ReasoningText: "不得写入活动证据的思考", PromptGeneration: generation},
		{Type: "tool_call", ToolCallID: "tool", ToolName: "bash", PromptGeneration: generation},
		{Type: "tool_update", ToolCallID: "tool", ToolStatus: "completed", PromptGeneration: generation},
	} {
		mgr.handleAgentEvent(execution, event)
	}
	var evidence []AgentStreamEventPayload
	for _, event := range eventBus.getStreamEvents() {
		if event.Data != nil && event.Data.Type == "work_activity" {
			evidence = append(evidence, event)
		}
	}
	require.Len(t, evidence, 4, "原生输入必须在文本合并或缓冲前产生四类可关联活动证据")
	for _, event := range evidence {
		require.Equal(t, execution.ID, event.ExecutionID)
		require.Equal(t, "captured-turn", event.Data.TurnID)
		require.Equal(t, generation, event.Data.PromptGeneration)
		require.Empty(t, event.Data.Text)
		require.Empty(t, event.Data.ToolName, "活动证据不携带工具参数或工具正文")
		data, ok := event.Data.Data.(map[string]interface{})
		require.True(t, ok)
		require.NotEmpty(t, data["host_activity_kind"])
	}
}

// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-002.3
func TestPoolWorkActivityUsesCapturedGenerationMappingNotLatestTurn(t *testing.T) {
	mgr, eventBus := createTestManagerWithTracking()
	execution := createTestExecution("generation-work-execution", "task", "session")
	execution.AgentID = "codex-app-server"
	execution.setPromptTurnID("original-turn")
	require.NoError(t, mgr.executionStore.Add(execution))
	require.NoError(t, mgr.EnableWorkActivity(context.Background(), execution.ID, "original-turn"))
	original, err := mgr.executionStore.BeginPrompt(execution.ID)
	require.NoError(t, err)
	execution.setPromptTurnID("replacement-turn")
	_, err = mgr.executionStore.BeginPrompt(execution.ID)
	require.NoError(t, err)
	mgr.handleAgentEvent(execution, agentctl.AgentEvent{Type: streams.EventTypeTurnStarted,
		TurnStartSource: streams.TurnStartCodexProvider, OperationID: "original-provider-operation", PromptGeneration: original})
	var found *AgentStreamEventPayload
	for _, event := range eventBus.getStreamEvents() {
		if event.Data != nil && event.Data.Type == "work_activity" {
			captured := event
			found = &captured
		}
	}
	require.NotNil(t, found)
	require.Equal(t, "original-turn", found.Data.TurnID)
	require.Equal(t, original, found.Data.PromptGeneration)
	require.Equal(t, "original-provider-operation", found.Data.OperationID)
}

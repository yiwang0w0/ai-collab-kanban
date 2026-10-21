package backendapp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	"github.com/kandev/kandev/internal/orchestrator/executor"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func assertPoolConsumerExecutionStopped(t *testing.T, f poolRuntimeFixture, request *executor.LaunchAgentRequest) {
	t.Helper()
	ctx := context.Background()
	runEvents, err := f.officeRepo.RunsRepository().ListRunEvents(ctx, f.run.ID, -1, 10)
	require.NoError(t, err)
	var allocation runsmodels.PoolExecutionAllocation
	require.NoError(t, json.Unmarshal([]byte(runEvents[1].Payload), &allocation))
	// 此处只驱动真实总线／观察器；停止生产者的实际控制服务合同由 lifecycle 测试独立证明。
	payload := poolMockStopPayload(request, allocation)
	require.NoError(t, f.eventBus.Publish(ctx, events.AgentStopped, bus.NewEvent(events.AgentStopped, "agent-manager", payload)))
	runEvents, err = f.officeRepo.RunsRepository().ListRunEvents(ctx, f.run.ID, -1, 10)
	require.NoError(t, err)
	require.Len(t, runEvents, 6, "实际原生订阅路径必须保存独立停止事实")
	require.Equal(t, runsmodels.RunEventType("pool.execution-stopped.v1"), runEvents[5].EventType)
	var stopped runsmodels.PoolExecutionStopReceipt
	require.NoError(t, json.Unmarshal([]byte(runEvents[5].Payload), &stopped))
	require.Equal(t, allocation.PoolExecutionIdentity, stopped.PoolExecutionIdentity)
	require.Equal(t, "mock-control-instance", stopped.RuntimeInstanceID)
	claim, err := f.officeRepo.RunsRepository().ResolveCurrentPoolClaim(ctx, f.run.ID)
	require.NoError(t, err)
	require.Equal(t, allocation.ClaimID, claim.ClaimID)
	require.Nil(t, claim.FinishedAt, "停止事实仍不能替代工作区和数据库占用的释放门禁")
}

func poolMockStopPayload(request *executor.LaunchAgentRequest, allocation runsmodels.PoolExecutionAllocation) lifecycle.AgentEventPayload {
	return lifecycle.AgentEventPayload{OwnerKind: lifecycle.ExecutionOwnerTask, TaskID: request.TaskID,
		SessionID: request.SessionID, AgentExecutionID: allocation.ExecutionID, AgentID: "claude-acp",
		AgentProfileID: request.AgentProfileID, ExecutionProfileID: request.AgentProfileID, TurnID: request.TurnID, PromptGeneration: 1,
		RuntimeStopConfirmation: &lifecycle.RuntimeStopConfirmation{Source: lifecycle.RuntimeStopSourceStandaloneControl,
			RuntimeInstanceID: "mock-control-instance", ExecutionActivityReleased: true}}
}

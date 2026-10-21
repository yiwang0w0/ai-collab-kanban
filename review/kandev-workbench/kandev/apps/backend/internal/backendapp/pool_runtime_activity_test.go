package backendapp

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	"github.com/kandev/kandev/internal/orchestrator/executor"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-002.2
func TestPoolNativeStartCapturesAllocationBeforeProcessAndRecordsActualActivity(t *testing.T) {
	f := newPoolRuntimeFixture(t)
	var request atomic.Pointer[executor.LaunchAgentRequest]
	previousLaunch := f.agentMgr.launchHook
	f.agentMgr.launchHook = func(ctx context.Context, req *executor.LaunchAgentRequest, response *executor.LaunchAgentResponse) error {
		if err := previousLaunch(ctx, req, response); err != nil {
			return err
		}
		request.Store(req)
		return nil
	}
	started := make(chan error, 1)
	f.agentMgr.startHook = func(ctx context.Context, id string) error {
		err := publishPoolFirstMockActivity(ctx, f, request.Load(), id)
		started <- err
		return err
	}
	execution, err := f.orchestrator.StartPoolTask(context.Background(), f.claim)
	require.NoError(t, err)
	require.NotNil(t, execution)
	select {
	case err := <-started:
		require.NoError(t, err, "执行分配必须在模拟进程前提交，首个活动随后才可成为开工")
	case <-time.After(5 * time.Second):
		t.Fatal("没有抵达模拟进程启动")
	}
	events, err := f.officeRepo.RunsRepository().ListRunEvents(context.Background(), f.claim.ID, -1, 10)
	require.NoError(t, err)
	require.Len(t, events, 4, "必须是意图、分配、活动绑定和开工四条不同证据")
	require.Equal(t, runsmodels.RunEventType("pool.execution-allocated.v1"), events[1].EventType)
	require.Equal(t, runsmodels.RunEventType(runsmodels.PoolExecutionBound), events[2].EventType)
	require.Equal(t, runsmodels.RunEventType(runsmodels.PoolWorkObserved), events[3].EventType)
	var work runsmodels.PoolWorkReceipt
	require.NoError(t, json.Unmarshal([]byte(events[3].Payload), &work))
	require.Equal(t, f.claim.ClaimID, work.ClaimID)
	require.Equal(t, execution.SessionID, work.SessionID)
	require.Equal(t, execution.AgentExecutionID, work.ExecutionID)
	require.Equal(t, request.Load().TurnID, work.TurnID)
	require.Equal(t, work.TurnID, work.OperationID, "ACP 没有提供商 operation，必须明确使用已绑定的原生回合")
	require.Equal(t, runsmodels.PoolOperationHostTurn, work.OperationSource)
}

func publishPoolFirstMockActivity(ctx context.Context, f poolRuntimeFixture, request *executor.LaunchAgentRequest, executionID string) error {
	if request == nil || request.TurnID == "" {
		return fmt.Errorf("模拟启动缺少实际原生请求或回合")
	}
	var allocated, work int
	if err := f.db.Get(&allocated, `SELECT COUNT(*) FROM run_events WHERE run_id = ? AND event_type = 'pool.execution-allocated.v1'`, f.claim.ID); err != nil {
		return err
	}
	if err := f.db.Get(&work, `SELECT COUNT(*) FROM run_events WHERE run_id = ? AND event_type = 'pool.work-observed.v1'`, f.claim.ID); err != nil {
		return err
	}
	if allocated != 1 || work != 0 {
		return fmt.Errorf("分配必须先于进程，分配本身不能开工: allocated=%d work=%d", allocated, work)
	}
	payload := lifecycle.AgentStreamEventPayload{ExecutionID: executionID, AgentID: executionID, OwnerKind: lifecycle.ExecutionOwnerTask,
		WorkspaceID: request.WorkspaceID, TaskID: request.TaskID, SessionID: request.SessionID,
		AgentProfileID: request.AgentProfileID, AgentType: "claude-acp", Data: &lifecycle.AgentStreamEventData{
			Type: "work_activity", Data: map[string]interface{}{"host_activity_kind": "assistant"},
			Role: "assistant", TurnID: request.TurnID, PromptGeneration: 1}}
	return f.eventBus.Publish(ctx, events.BuildAgentStreamSubject(request.SessionID), bus.NewEvent(events.AgentStream, "agent-manager", payload))
}

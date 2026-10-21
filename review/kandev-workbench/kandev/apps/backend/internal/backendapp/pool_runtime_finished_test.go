package backendapp

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/agent/runtime/activity"
	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	"github.com/kandev/kandev/internal/orchestrator/executor"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	v1 "github.com/kandev/kandev/pkg/api/v1"
	"github.com/stretchr/testify/require"
)

func (m *stubAgentManager) CheckExecutionQuiescent(ctx context.Context, executionID, taskID, sessionID string) error {
	if m.poolQuiescenceHook == nil {
		return lifecycle.ErrExecutionResourcesUnconfirmed
	}
	return m.poolQuiescenceHook(ctx, executionID, taskID, sessionID)
}

type poolFinishWitness struct {
	*runsservice.Service
	finished chan error
}

func (w *poolFinishWitness) FinalizeStoppedPoolRun(ctx context.Context, identity runsmodels.PoolExecutionIdentity) (*runsmodels.RunEvent, error) {
	event, err := w.Service.FinalizeStoppedPoolRun(ctx, identity)
	w.finished <- err
	return event, err
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolNativeStoppedLifecycleFinishesSameClaimButNotStrictDone(t *testing.T) {
	f := newPoolRuntimeFixture(t)
	f.taskRepo.SetStrictCompletionPolicy(&tasksqlite.StrictCompletionPolicy{VerifierID: "plugin:pool-fixture",
		Check: func(context.Context, string, string) error { return nil }})
	manager := lifecycle.NewManager(nil, nil, nil, nil, nil, nil, lifecycle.ExecutorFallbackDeny, t.TempDir(), newTestLogger())
	manager.SetActivityCoordinator(activity.NewCoordinator(activity.Options{}))
	f.agentMgr.poolQuiescenceHook = manager.CheckExecutionQuiescent
	previousLaunch := f.agentMgr.launchHook
	f.agentMgr.launchHook = func(ctx context.Context, req *executor.LaunchAgentRequest, response *executor.LaunchAgentResponse) error {
		if err := previousLaunch(ctx, req, response); err != nil {
			return err
		}
		return manager.ExecutionStoreForTesting().Add(&lifecycle.AgentExecution{ID: response.AgentExecutionID, TaskID: req.TaskID, SessionID: req.SessionID})
	}
	witness := &poolFinishWitness{Service: f.queue, finished: make(chan error, 1)}
	f.orchestrator.SetPoolTaskStartGuard(witness)
	ctx := context.Background()
	execution, err := f.orchestrator.StartPoolTask(ctx, f.claim)
	require.NoError(t, err)
	request := f.agentMgr.awaitLaunch(t)
	require.NoError(t, publishPoolFirstMockActivity(ctx, f, request, execution.AgentExecutionID))
	assertPoolConsumerTurnEnd(t, f, request)
	before, err := f.taskRepo.GetTask(ctx, f.task.ID)
	require.NoError(t, err)
	allocation := poolMockStopAllocation(t, f)
	running, err := f.taskRepo.GetExecutorRunningBySessionID(ctx, allocation.SessionID)
	require.NoError(t, err)
	require.NoError(t, f.taskRepo.DeleteExecutorRunningIfCurrent(ctx, allocation.SessionID, allocation.ExecutionID, running.UpdatedAt))
	// 模拟提供商显式卸载本次执行；这里只证明服务接缝，不声称实际 CLI 或 Git checkout 已停止。
	manager.ExecutionStoreForTesting().Remove(allocation.ExecutionID)
	payload := poolMockStopPayload(request, allocation)
	require.NoError(t, f.eventBus.Publish(ctx, events.AgentStopped, bus.NewEvent(events.AgentStopped, "agent-manager", payload)))
	select {
	case err := <-witness.finished:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("真实停止订阅路径没有完成原生资源核验与领取终结")
	}
	run, err := f.officeRepo.RunsRepository().GetRunByID(ctx, f.run.ID)
	require.NoError(t, err)
	require.Equal(t, runsmodels.RunStatusFinished, run.Status)
	require.NotNil(t, run.FinishedAt)
	runEvents, err := f.officeRepo.RunsRepository().ListRunEvents(ctx, run.ID, -1, 10)
	require.NoError(t, err)
	require.Len(t, runEvents, 7)
	require.Equal(t, runsmodels.RunEventType(runsmodels.PoolExecutionFinished), runEvents[6].EventType)
	after, err := f.taskRepo.GetTask(ctx, f.task.ID)
	require.NoError(t, err)
	require.Equal(t, before, after)
	ctx = authn.WithIdentity(ctx, authn.Identity{UserID: "pool-human", SessionID: "pool-browser", Role: authn.RoleAdmin})
	_, err = f.taskSvc.UpdateTaskState(ctx, f.task.ID, v1.TaskStateCompleted)
	require.ErrorIs(t, err, repoerrors.ErrTaskCompletionGateBlocked, "队列领取终结依然不能代替交付验收")
}

func poolMockStopAllocation(t *testing.T, f poolRuntimeFixture) runsmodels.PoolExecutionAllocation {
	t.Helper()
	events, err := f.officeRepo.RunsRepository().ListRunEvents(context.Background(), f.run.ID, -1, 10)
	require.NoError(t, err)
	var allocation runsmodels.PoolExecutionAllocation
	require.NoError(t, json.Unmarshal([]byte(events[1].Payload), &allocation))
	return allocation
}

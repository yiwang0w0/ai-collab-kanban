package backendapp

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	officeservice "github.com/kandev/kandev/internal/office/service"
	"github.com/kandev/kandev/internal/orchestrator/executor"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	v1 "github.com/kandev/kandev/pkg/api/v1"
	"github.com/stretchr/testify/require"
)

type nativePoolProcessor interface {
	ProcessPoolRun(context.Context, *runsmodels.ClaimedRun) error
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.1
// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-002.4
func TestPoolConsumerUsesExistingClaimLoopAndNativeTaskExecution(t *testing.T) {
	f := newQueuedPoolRuntimeFixture(t)
	f.taskRepo.SetStrictCompletionPolicy(&tasksqlite.StrictCompletionPolicy{VerifierID: "plugin:pool-fixture",
		Check: func(context.Context, string, string) error { return nil }})
	adapter := &officeOrchestratorTaskStarter{orch: f.orchestrator}
	processor, ok := any(adapter).(nativePoolProcessor)
	if !ok {
		t.Fatal("原生任务启动适配器缺少共享池消费者入口")
	}
	office := officeservice.NewService(officeservice.ServiceOptions{Repo: f.officeRepo, EventBus: f.eventBus,
		Logger: logger.Default(), TaskStarter: adapter})
	office.SetRunsService(f.queue)
	office.SetPoolRunProcessor(processor.ProcessPoolRun)
	consumer := officeservice.NewSchedulerIntegration(office, time.Second)
	var request atomic.Pointer[executor.LaunchAgentRequest]
	previousLaunch := f.agentMgr.launchHook
	f.agentMgr.launchHook = func(ctx context.Context, req *executor.LaunchAgentRequest, response *executor.LaunchAgentResponse) error {
		if err := previousLaunch(ctx, req, response); err != nil {
			return err
		}
		request.Store(req)
		return nil
	}
	processed := make(chan error, 1)
	f.agentMgr.startHook = func(ctx context.Context, executionID string) error {
		claim, err := f.officeRepo.RunsRepository().ResolveCurrentPoolClaim(ctx, f.run.ID)
		if err == nil {
			current := f
			current.claim = claim
			err = publishPoolFirstMockActivity(ctx, current, request.Load(), executionID)
		}
		processed <- err
		return err
	}
	consumer.Tick(context.Background())
	select {
	case err := <-processed:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("共享领取没有抵达模拟任务执行")
	}
	claim, err := f.officeRepo.RunsRepository().ResolveCurrentPoolClaim(context.Background(), f.run.ID)
	require.NoError(t, err)
	require.NotEmpty(t, claim.ClaimID)
	require.Equal(t, request.Load().SessionID, claim.SessionID)
	events, err := f.officeRepo.RunsRepository().ListRunEvents(context.Background(), f.run.ID, -1, 10)
	require.NoError(t, err)
	require.Len(t, events, 4)
	require.Equal(t, runsmodels.RunEventType(runsmodels.PoolWorkObserved), events[3].EventType)
	assertPoolConsumerTurnEnd(t, f, request.Load())
	assertPoolConsumerExecutionStopped(t, f, request.Load())
	consumer.Tick(context.Background())
	var ledger, runs int
	require.NoError(t, f.db.Get(&ledger, `SELECT COUNT(*) FROM office_launch_ledger WHERE run_id = ?`, f.run.ID))
	require.NoError(t, f.db.Get(&runs, `SELECT COUNT(*) FROM runs`))
	require.Equal(t, 1, ledger, "不能由新任务适配器再领取一次")
	require.Equal(t, 1, runs)
	sessions, err := f.taskRepo.ListTaskSessions(context.Background(), f.task.ID)
	require.NoError(t, err)
	require.Len(t, sessions, 1)
}

func assertPoolConsumerTurnEnd(t *testing.T, f poolRuntimeFixture, request *executor.LaunchAgentRequest) {
	t.Helper()
	ctx := context.Background()
	runEvents, err := f.officeRepo.RunsRepository().ListRunEvents(ctx, f.run.ID, -1, 10)
	require.NoError(t, err)
	var allocation runsmodels.PoolExecutionAllocation
	require.NoError(t, json.Unmarshal([]byte(runEvents[1].Payload), &allocation))
	payload := lifecycle.AgentStreamEventPayload{ExecutionID: allocation.ExecutionID, AgentID: allocation.ExecutionID,
		OwnerKind: lifecycle.ExecutionOwnerTask, WorkspaceID: request.WorkspaceID, TaskID: request.TaskID,
		SessionID: request.SessionID, AgentProfileID: request.AgentProfileID, AgentType: "claude-acp",
		Data: &lifecycle.AgentStreamEventData{Type: "complete", TurnID: request.TurnID, PromptGeneration: 1,
			Data: map[string]interface{}{"is_error": false, "stop_reason": "end_turn"}}}
	require.NoError(t, f.eventBus.Publish(ctx, events.BuildAgentStreamSubject(request.SessionID), bus.NewEvent(events.AgentStream, "agent-manager", payload)))
	runEvents, err = f.officeRepo.RunsRepository().ListRunEvents(ctx, f.run.ID, -1, 10)
	require.NoError(t, err)
	require.Len(t, runEvents, 5, "真实消费者的同一执行必须留下独立回合结束证据")
	require.Equal(t, runsmodels.RunEventType("pool.turn-ended.v1"), runEvents[4].EventType)
	run, err := f.officeRepo.RunsRepository().GetRunByID(ctx, f.run.ID)
	require.NoError(t, err)
	require.Equal(t, runsmodels.RunStatusClaimed, run.Status)
	require.Nil(t, run.FinishedAt)
	task, err := f.taskRepo.GetTask(ctx, f.task.ID)
	require.NoError(t, err)
	require.NotEqual(t, v1.TaskStateCompleted, task.State, "回合结束不能越过严格完成门禁")
	require.Equal(t, f.task.WorkflowStepID, task.WorkflowStepID)
	ctx = authn.WithIdentity(ctx, authn.Identity{UserID: "pool-human", SessionID: "pool-browser", Role: authn.RoleAdmin})
	_, err = f.taskSvc.UpdateTaskState(ctx, task.ID, v1.TaskStateCompleted)
	require.ErrorIs(t, err, repoerrors.ErrTaskCompletionGateBlocked, "已有回合结束回执也不能代替严格交付验收")
}

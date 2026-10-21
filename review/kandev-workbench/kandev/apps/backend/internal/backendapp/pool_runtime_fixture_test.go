package backendapp

import (
	"context"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/events/bus"
	officesqlite "github.com/kandev/kandev/internal/office/repository/sqlite"
	"github.com/kandev/kandev/internal/orchestrator"
	"github.com/kandev/kandev/internal/orchestrator/executor"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	"github.com/kandev/kandev/internal/steptelemetry"
	taskmodels "github.com/kandev/kandev/internal/task/models"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	taskservice "github.com/kandev/kandev/internal/task/service"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

type nativePoolTaskStarter interface {
	StartPoolTask(context.Context, *runsmodels.ClaimedRun) (*executor.TaskExecution, error)
}

type poolRuntimeFixture struct {
	*routineCronHarness
	queue *runsservice.Service
	claim *runsmodels.ClaimedRun
	run   *runsmodels.Run
	task  *taskmodels.Task
}

func newPoolRuntimeFixture(t *testing.T) poolRuntimeFixture {
	t.Helper()
	f := newQueuedPoolRuntimeFixture(t)
	claim, err := f.officeRepo.RunsRepository().ClaimNextEligibleRunWithClaim(context.Background())
	if err != nil || claim == nil {
		t.Fatalf("原生领取必须先成功: %+v %v", claim, err)
	}
	f.claim = claim
	return f
}

func newQueuedPoolRuntimeFixture(t *testing.T) poolRuntimeFixture {
	t.Helper()
	log, err := logger.NewLogger(logger.LoggingConfig{Level: "error", Format: "json"})
	if err != nil {
		t.Fatal(err)
	}
	var queue *runsservice.Service
	workspacePath := t.TempDir()
	h := newRoutineCronHarness(t, func(orch *orchestrator.Service, tasks *tasksqlite.Repository, office *officesqlite.Repository, eb bus.EventBus, agent *stubAgentManager, taskSvc *taskservice.Service) {
		orch.SetMessageCreator(&messageCreatorAdapter{svc: taskSvc})
		agent.workspacePath = workspacePath
		// 模拟提供商遵守真实 Launch 的原生运行清单合同；此行不是进程或开工证明。
		agent.launchHook = func(ctx context.Context, request *executor.LaunchAgentRequest, response *executor.LaunchAgentResponse) error {
			return tasks.UpsertExecutorRunning(ctx, &taskmodels.ExecutorRunning{ID: response.AgentExecutionID,
				TaskID: request.TaskID, SessionID: request.SessionID, ExecutionProfileID: request.AgentProfileID,
				AgentExecutionID: response.AgentExecutionID, ExecutorID: taskmodels.ExecutorIDWorktree,
				Status: taskmodels.ExecutorRunningStatusStarting})
		}
		queue = runsservice.New(office.RunsRepository(), eb, log, nil)
		queue.SetPoolReleaseSource(tasks)
		queue.SetPoolEnqueueAdmission(orch)
		orch.SetPoolTaskStartGuard(queue)
	})
	ctx := context.Background()
	if err := h.taskRepo.CreateWorkflow(ctx, &taskmodels.Workflow{ID: "pool-runtime-workflow", WorkspaceID: h.workspaceID, Name: "池运行夹具"}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := h.db.Exec(`INSERT INTO agents (id, name, created_at, updated_at) VALUES ('pool-runtime-cli', 'claude-acp', ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(`INSERT INTO agent_profiles (id, agent_id, name, agent_display_name, enabled, created_at, updated_at)
		VALUES ('pool-runtime-profile', 'pool-runtime-cli', '池固定配置', 'CLI', 1, ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	step := &wfmodels.WorkflowStep{ID: "pool-runtime-step", WorkflowID: "pool-runtime-workflow", Name: "实施", AllowManualMove: true,
		AgentProfileID: "pool-runtime-profile", Events: wfmodels.StepEvents{OnEnter: []wfmodels.OnEnterAction{
			{Type: wfmodels.OnEnterQueueRun, Config: map[string]any{"pool_version": 1}},
		}}}
	if err := h.workflowSvc.CreateStep(ctx, step); err != nil {
		t.Fatal(err)
	}
	task := &taskmodels.Task{ID: "pool-runtime-task", WorkspaceID: h.workspaceID, WorkflowID: step.WorkflowID,
		WorkflowStepID: step.ID, Title: "原生池启动", Description: "只验证模拟执行边界", State: v1.TaskStateTODO, Priority: "medium",
		Metadata: map[string]any{taskmodels.MetaKeyExecutorID: taskmodels.ExecutorIDWorktree}}
	ctx = authn.WithIdentity(ctx, authn.Identity{UserID: "pool-human", SessionID: "pool-browser", Role: authn.RoleAdmin})
	ctx = steptelemetry.WithAttribution(ctx, steptelemetry.Attribution{Trigger: steptelemetry.TriggerTaskCreated,
		ActorKind: steptelemetry.ActorHuman, ActorID: "pool-human"})
	ctx = taskmodels.WithPoolReleaseIntent(ctx, taskmodels.PoolReleaseIntent{TaskID: task.ID, WorkspaceID: task.WorkspaceID,
		WorkflowID: task.WorkflowID, StepID: step.ID, Creating: true, ConfirmCLIQuota: true,
		ExpectedAgentProfileID: step.AgentProfileID, ExpectedStepVersion: step.UpdatedAt.UTC().Format(time.RFC3339Nano)})
	if err := h.taskRepo.CreateTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	var entry int64
	if err := h.db.Get(&entry, `SELECT MAX(id) FROM task_step_transitions WHERE task_id = ?`, task.ID); err != nil {
		t.Fatal(err)
	}
	_, run, err := queue.QueuePoolRunAndReturn(context.Background(), task.ID, entry)
	if err != nil {
		t.Fatal(err)
	}
	return poolRuntimeFixture{routineCronHarness: h, queue: queue, run: run, task: task}
}

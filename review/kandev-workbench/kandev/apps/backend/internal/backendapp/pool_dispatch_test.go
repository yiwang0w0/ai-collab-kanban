package backendapp

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/steptelemetry"
	"github.com/kandev/kandev/internal/task/models"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	workflowengine "github.com/kandev/kandev/internal/workflow/engine"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
	workflowrepo "github.com/kandev/kandev/internal/workflow/repository"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.1
func TestPoolDispatchHostAdapterUsesCommittedApprovalNotOfficeCarrier(t *testing.T) {
	adapter, taskSvc, officeRepo, _ := newRunsEngineAdapterActorTestHarness(t)
	if _, ok := any(adapter).(workflowengine.PoolRunQueueAdapter); !ok {
		t.Fatal("宿主引擎适配器没有连接任务系统的可信池发布")
	}
	runs := officeRepo.RunsRepository()
	repo := tasksqlite.NewWithInitializedDB(runs.Writer(), runs.Reader(), nil)
	workflows, err := workflowrepo.NewWithDB(runs.Writer(), runs.Reader(), nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	workflow := &models.Workflow{ID: "pool-host-workflow", WorkspaceID: "ws-1", Name: "池流程"}
	if err := repo.CreateWorkflow(ctx, workflow); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := runs.Writer().Exec(`UPDATE agents SET name = 'claude-acp' WHERE id = 'cli-test'`); err != nil {
		t.Fatal(err)
	}
	if _, err := runs.Writer().Exec(`INSERT INTO agent_profiles (id, agent_id, name, agent_display_name, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)`, "pool-host-profile", "cli-test", "池执行配置", "CLI", now, now); err != nil {
		t.Fatal(err)
	}
	step := &wfmodels.WorkflowStep{ID: "pool-host-step", WorkflowID: workflow.ID, Name: "实施", AgentProfileID: "pool-host-profile",
		Events: wfmodels.StepEvents{OnEnter: []wfmodels.OnEnterAction{{Type: wfmodels.OnEnterQueueRun, Config: map[string]any{"pool_version": 1}}}}}
	if err := workflows.CreateStep(ctx, step); err != nil {
		t.Fatal(err)
	}
	task := &models.Task{ID: "pool-host-task", WorkspaceID: workflow.WorkspaceID, WorkflowID: workflow.ID,
		WorkflowStepID: step.ID, Title: "单卡派发", Priority: "medium",
		State:    v1.TaskStateTODO,
		Metadata: map[string]any{models.MetaKeyExecutorID: models.ExecutorIDWorktree}}
	releaseCtx := authn.WithIdentity(ctx, authn.Identity{UserID: "pool-real-human", SessionID: "real-browser", Role: authn.RoleAdmin})
	releaseCtx = steptelemetry.WithAttribution(releaseCtx, steptelemetry.Attribution{Trigger: steptelemetry.TriggerTaskCreated,
		ActorKind: steptelemetry.ActorHuman, ActorID: "pool-real-human"})
	releaseCtx = models.WithPoolReleaseIntent(releaseCtx, models.PoolReleaseIntent{TaskID: task.ID, WorkspaceID: task.WorkspaceID,
		WorkflowID: workflow.ID, StepID: step.ID, Creating: true, ConfirmCLIQuota: true,
		ExpectedAgentProfileID: step.AgentProfileID, ExpectedStepVersion: step.UpdatedAt.UTC().Format(time.RFC3339Nano)})
	if err := repo.CreateTask(releaseCtx, task); err != nil {
		t.Fatal(err)
	}
	var entryID int64
	if err := runs.Reader().Get(&entryID, `SELECT MAX(id) FROM task_step_transitions WHERE task_id = ?`, task.ID); err != nil {
		t.Fatal(err)
	}
	adapter.svc.SetPoolReleaseSource(repo)
	adapter.svc.SetPoolEnqueueAdmission(&orchestrator.Service{})
	taskSvc.SetPoolRunQueue(adapter.svc)
	adapter.poolPublisher = taskSvc
	compiled := workflowengine.CompileStep(step)
	callback := workflowengine.QueueRunCallback{Adapter: adapter}
	input := workflowengine.ActionInput{Trigger: workflowengine.TriggerOnEnter,
		State: workflowengine.MachineState{TaskID: task.ID, WorkflowID: workflow.ID, AgentProfileID: "not-the-approved-profile"},
		Step:  compiled, Action: compiled.Events[workflowengine.TriggerOnEnter][0], EntryID: fmt.Sprintf("entry:%020d", entryID),
		Payload: map[string]any{"actor_id": "forged", "agent_profile_id": "forged", "started_at": "forged"}}
	for range 2 {
		if _, err := callback.Execute(ctx, input); err != nil {
			t.Fatalf("原生阶段回调应能重复投递而不重复派发: %v", err)
		}
	}
	var rows []runsmodels.Run
	if err := runs.Reader().Select(&rows, `SELECT * FROM runs`); err != nil || len(rows) != 1 || rows[0].ActorID != "pool-real-human" ||
		rows[0].AgentProfileID != step.AgentProfileID || rows[0].ActorKind != runsmodels.ActorKindUser || rows[0].WorkspaceID != task.WorkspaceID {
		t.Fatalf("同一宿主链必须只产生一份真实批准运行: rows=%+v err=%v", rows, err)
	}
}

package service

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"

	settingsstore "github.com/kandev/kandev/internal/agent/settings/store"
	"github.com/kandev/kandev/internal/auth/authn"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	"github.com/kandev/kandev/internal/steptelemetry"
	"github.com/kandev/kandev/internal/task/models"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
	workflowrepo "github.com/kandev/kandev/internal/workflow/repository"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

type poolReleasePublisher interface {
	SetPoolRunQueue(PoolRunQueue)
	PublishPoolRelease(context.Context, string, string, string) (runsservice.QueueOutcome, error)
}

type taskPoolFixture struct {
	svc       *Service
	publisher poolReleasePublisher
	database  *sqlx.DB
	runs      *runssqlite.Repository
	queue     *runsservice.Service
	task      *models.Task
	entryID   int64
}

func newTaskPoolFixture(t *testing.T) taskPoolFixture {
	t.Helper()
	svc, _, repo := createTestService(t)
	publisher, ok := any(svc).(poolReleasePublisher)
	if !ok {
		t.Fatal("任务服务没有接通原生阶段到共享队列的发布入口")
	}
	database := sqlx.NewDb(repo.DB(), "sqlite3")
	if _, _, err := settingsstore.Provide(database, database, nil); err != nil {
		t.Fatal(err)
	}
	workflows, err := workflowrepo.NewWithDB(database, database, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := repo.CreateWorkspace(ctx, &models.Workspace{ID: "pool-native-ws", Name: "任务池", OwnerID: "pool-human"}); err != nil {
		t.Fatal(err)
	}
	if err := repo.CreateWorkflow(ctx, &models.Workflow{ID: "pool-native-wf", WorkspaceID: "pool-native-ws", Name: "原生流程"}); err != nil {
		t.Fatal(err)
	}
	backlog := &wfmodels.WorkflowStep{ID: "pool-native-backlog", WorkflowID: "pool-native-wf", Name: "待办", AllowManualMove: true}
	step := &wfmodels.WorkflowStep{ID: "pool-native-step", WorkflowID: "pool-native-wf", Name: "实施", AgentProfileID: "pool-native-cli",
		AllowManualMove: true, Position: 1,
		Events: wfmodels.StepEvents{OnEnter: []wfmodels.OnEnterAction{{Type: wfmodels.OnEnterQueueRun, Config: map[string]any{"pool_version": 1}}}}}
	for _, row := range []*wfmodels.WorkflowStep{backlog, step} {
		if err := workflows.CreateStep(ctx, row); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC()
	if _, err := database.Exec(`INSERT INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`, "pool-native-agent", "claude-acp", now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO agent_profiles (id, agent_id, name, agent_display_name, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)`, step.AgentProfileID, "pool-native-agent", "原生 CLI", "Claude", now, now); err != nil {
		t.Fatal(err)
	}
	task := &models.Task{ID: "pool-native-task", WorkspaceID: "pool-native-ws", WorkflowID: step.WorkflowID,
		WorkflowStepID: backlog.ID, Title: "单卡执行", Priority: "medium",
		State:    v1.TaskStateTODO,
		Metadata: map[string]any{models.MetaKeyExecutorID: models.ExecutorIDWorktree}}
	if err := repo.CreateTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	ctx = authn.WithIdentity(ctx, authn.Identity{UserID: "pool-human", SessionID: "native-browser", Role: authn.RoleAdmin})
	ctx = steptelemetry.WithAttribution(ctx, steptelemetry.Attribution{Trigger: steptelemetry.TriggerManualMove,
		ActorKind: steptelemetry.ActorHuman, ActorID: "pool-human"})
	ctx = models.WithPoolReleaseIntent(ctx, models.PoolReleaseIntent{TaskID: task.ID, WorkspaceID: task.WorkspaceID, WorkflowID: task.WorkflowID,
		StepID: step.ID, ExpectedResourceVersion: task.UpdatedAt.UTC().Format(time.RFC3339Nano), ConfirmCLIQuota: true,
		ExpectedAgentProfileID: step.AgentProfileID, ExpectedStepVersion: step.UpdatedAt.UTC().Format(time.RFC3339Nano)})
	task.WorkflowStepID = step.ID
	if err := repo.UpdateTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	var entryID int64
	if err := database.Get(&entryID, `SELECT MAX(id) FROM task_step_transitions WHERE task_id = ?`, task.ID); err != nil {
		t.Fatal(err)
	}
	runs := runssqlite.NewWithDB(database, database)
	queue := runsservice.New(runs, nil, svc.logger, nil)
	queue.SetPoolReleaseSource(repo)
	queue.SetPoolEnqueueAdmission(poolTaskTestAdmission{})
	publisher.SetPoolRunQueue(queue)
	return taskPoolFixture{svc: svc, publisher: publisher, database: database, runs: runs, queue: queue, task: task, entryID: entryID}
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolDispatchTaskServicePublishesNativeEntryOnce(t *testing.T) {
	f := newTaskPoolFixture(t)
	entry := fmt.Sprintf("entry:%020d", f.entryID)
	for _, expected := range []runsservice.QueueOutcome{runsservice.QueueOutcomeQueued, runsservice.QueueOutcomeDeduped} {
		outcome, err := f.publisher.PublishPoolRelease(context.Background(), f.task.ID, f.task.WorkflowStepID, entry)
		if err != nil || outcome != expected {
			t.Fatalf("原生阶段发布结果应准确: %s %v", outcome, err)
		}
	}
	var rows []runsmodels.Run
	if err := f.database.Select(&rows, `SELECT * FROM runs`); err != nil || len(rows) != 1 || rows[0].AgentProfileID != "pool-native-cli" || rows[0].ActorID != "pool-human" {
		t.Fatalf("必须沿用原生批准而非当前后台身份: rows=%d err=%v", len(rows), err)
	}
}

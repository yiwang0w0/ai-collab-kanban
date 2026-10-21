package service_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	"github.com/kandev/kandev/internal/steptelemetry"
	taskmodels "github.com/kandev/kandev/internal/task/models"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	workflowmodels "github.com/kandev/kandev/internal/workflow/models"
	workflowrepo "github.com/kandev/kandev/internal/workflow/repository"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

type nativePoolPublisher interface {
	SetPoolReleaseSource(runsservice.PoolReleaseSource)
	QueuePoolRunAndReturn(context.Context, string, int64) (runsservice.QueueOutcome, *runsmodels.Run, error)
}

type poolPublishFixture struct {
	svc       *runsservice.Service
	runs      *runssqlite.Repository
	tasks     *tasksqlite.Repository
	workflows *workflowrepo.Repository
	task      *taskmodels.Task
	step      *workflowmodels.WorkflowStep
	release   runsmodels.PoolReleaseSnapshot
	publisher nativePoolPublisher
}

func newPoolPublishFixture(t *testing.T) poolPublishFixture {
	t.Helper()
	svc, _, runs := newTestServiceWithRepo(t)
	publisher, ok := any(svc).(nativePoolPublisher)
	if !ok {
		t.Fatal("缺少只从原生批准派发的可信队列入口")
	}
	tasks, err := tasksqlite.NewWithDB(runs.Writer(), runs.Reader(), nil)
	if err != nil {
		t.Fatal(err)
	}
	workflows, err := workflowrepo.NewWithDB(runs.Writer(), runs.Reader(), nil)
	if err != nil {
		t.Fatal(err)
	}
	seedAgentProfile(t, runs.Writer(), "pool-fixed-cli")
	if _, err := runs.Writer().Exec(`UPDATE agents SET name = 'claude-acp' WHERE id = 'test-agent'`); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := tasks.CreateWorkspace(ctx, &taskmodels.Workspace{ID: testWorkspaceID, Name: "池派发夹具"}); err != nil {
		t.Fatal(err)
	}
	if err := tasks.CreateWorkflow(ctx, &taskmodels.Workflow{ID: "pool-workflow", WorkspaceID: testWorkspaceID, Name: "原生流程"}); err != nil {
		t.Fatal(err)
	}
	backlog := &workflowmodels.WorkflowStep{ID: "pool-backlog", WorkflowID: "pool-workflow", Name: "待办"}
	step := &workflowmodels.WorkflowStep{ID: "pool-implementation", WorkflowID: "pool-workflow", Name: "实施",
		AgentProfileID: "pool-fixed-cli", Events: workflowmodels.StepEvents{OnEnter: []workflowmodels.OnEnterAction{
			{Type: workflowmodels.OnEnterQueueRun, Config: map[string]any{"pool_version": 1}},
		}}}
	for _, item := range []*workflowmodels.WorkflowStep{backlog, step} {
		if err := workflows.CreateStep(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	task := &taskmodels.Task{ID: "pool-publish-task", WorkspaceID: testWorkspaceID, WorkflowID: "pool-workflow",
		WorkflowStepID: backlog.ID, Title: "同一张主卡", Priority: "medium",
		State:    v1.TaskStateTODO,
		Metadata: map[string]any{taskmodels.MetaKeyExecutorID: taskmodels.ExecutorIDWorktree}}
	if err := tasks.CreateTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	releaseCtx := authn.WithIdentity(ctx, authn.Identity{UserID: "pool-human", SessionID: "browser-session", Role: authn.RoleAdmin})
	releaseCtx = steptelemetry.WithAttribution(releaseCtx, steptelemetry.Attribution{
		Trigger: steptelemetry.TriggerManualMove, ActorKind: steptelemetry.ActorHuman, ActorID: "pool-human"})
	releaseCtx = taskmodels.WithPoolReleaseIntent(releaseCtx, taskmodels.PoolReleaseIntent{
		TaskID: task.ID, WorkspaceID: task.WorkspaceID, WorkflowID: task.WorkflowID, StepID: step.ID,
		ExpectedResourceVersion: task.UpdatedAt.UTC().Format(time.RFC3339Nano), ConfirmCLIQuota: true,
		ExpectedAgentProfileID: step.AgentProfileID, ExpectedStepVersion: step.UpdatedAt.UTC().Format(time.RFC3339Nano),
	})
	task.WorkflowStepID = step.ID
	if err := tasks.UpdateTask(releaseCtx, task); err != nil {
		t.Fatal(err)
	}
	var entryID int64
	if err := runs.Reader().Get(&entryID, `SELECT MAX(id) FROM task_step_transitions WHERE task_id = ?`, task.ID); err != nil {
		t.Fatal(err)
	}
	release, err := tasks.LoadPoolRelease(ctx, task.ID, entryID)
	if err != nil {
		t.Fatal(err)
	}
	source, ok := any(tasks).(runsservice.PoolReleaseSource)
	if !ok {
		t.Fatal("可信批准读取没有参与原生队列事务")
	}
	publisher.SetPoolReleaseSource(source)
	svc.SetPoolEnqueueAdmission(&orchestrator.Service{})
	return poolPublishFixture{svc: svc, runs: runs, tasks: tasks, workflows: workflows, task: task, step: step,
		release: release, publisher: publisher}
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.1
func TestPoolDispatchPublicationUsesNativeApprovalAndDurableIdentity(t *testing.T) {
	f := newPoolPublishFixture(t)
	ctx := context.Background()
	before := time.Now().UTC()
	outcome, run, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if err != nil || outcome != runsservice.QueueOutcomeQueued || run == nil {
		t.Fatalf("获准阶段应产生一份原生运行: %s %+v %v", outcome, run, err)
	}
	var payload struct {
		TaskID         string                         `json:"task_id"`
		WorkflowStepID string                         `json:"workflow_step_id"`
		AgentProfileID string                         `json:"agent_profile_id"`
		PoolRelease    runsmodels.PoolReleaseSnapshot `json:"pool_release"`
	}
	if err := json.Unmarshal([]byte(run.Payload), &payload); err != nil {
		t.Fatal(err)
	}
	if run.IdempotencyKey == nil || !strings.HasPrefix(*run.IdempotencyKey, runsmodels.PoolDispatchKeyPrefix) ||
		run.AgentProfileID != f.step.AgentProfileID || run.ActorKind != runsmodels.ActorKindUser || run.ActorID != f.release.ActorID ||
		run.WorkspaceID != f.task.WorkspaceID || run.WakeWaveKey != "" || run.CoalescedCount != 1 || run.Status != "queued" ||
		run.RequestedAt.Before(before) || payload.TaskID != f.task.ID || payload.WorkflowStepID != f.step.ID ||
		payload.AgentProfileID != f.step.AgentProfileID || payload.PoolRelease != f.release {
		t.Fatalf("派发绑定或真实时间不是原生来源: run=%+v payload=%+v release=%+v", run, payload, f.release)
	}
	<-f.svc.SubscribeSignal()
	outcome, duplicate, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if err != nil || outcome != runsservice.QueueOutcomeDeduped || duplicate == nil || duplicate.ID != run.ID ||
		!duplicate.RequestedAt.Equal(run.RequestedAt) || duplicate.Payload != run.Payload {
		t.Fatalf("同次批准重放应返回原运行，不生成新时间: %s %+v %v", outcome, duplicate, err)
	}
	var count int
	if err := f.runs.Reader().Get(&count, `SELECT COUNT(*) FROM runs`); err != nil || count != 1 {
		t.Fatalf("同次进入只能持久化一行: count=%d err=%v", count, err)
	}
	select {
	case <-f.svc.SubscribeSignal():
		t.Fatal("重复确认不能再次发出入队信号")
	default:
	}
}

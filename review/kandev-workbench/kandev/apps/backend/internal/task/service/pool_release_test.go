package service

import (
	"context"
	"fmt"
	"testing"
	"time"

	settingsmodels "github.com/kandev/kandev/internal/agent/settings/models"
	settingsstore "github.com/kandev/kandev/internal/agent/settings/store"
	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/task/models"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
	workflowrepo "github.com/kandev/kandev/internal/workflow/repository"
	workflowservice "github.com/kandev/kandev/internal/workflow/service"
)

type poolExecutorCompatibility struct{ err error }

func (v poolExecutorCompatibility) ValidateAgentProfileForExecutor(context.Context, *settingsmodels.AgentProfile, *models.Executor, *models.ExecutorProfile) error {
	return v.err
}

type poolMoveFixture struct {
	taskPoolFixture
	repo *tasksqlite.Repository
	step *wfmodels.WorkflowStep
	ctx  context.Context
	opts MoveTaskOptions
}

func newPoolMoveFixture(t *testing.T) poolMoveFixture {
	t.Helper()
	f := newTaskPoolFixture(t)
	repo := tasksqlite.NewWithInitializedDB(f.database, f.database, f.svc.logger)
	profiles, _, err := settingsstore.Provide(f.database, f.database, nil)
	if err != nil {
		t.Fatal(err)
	}
	workflows, err := workflowrepo.NewWithDB(f.database, f.database, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.svc.SetWorkflowStepGetter(workflowservice.NewService(workflows, f.svc.logger))
	f.svc.agentProfiles = profiles
	f.svc.agentProfileExecutorValidator = poolExecutorCompatibility{}
	f.svc.SetPoolReleaseAdmission(poolTaskTestAdmission{})
	if _, err := f.database.Exec(`UPDATE agents SET name = 'claude-acp' WHERE id = 'pool-native-agent'`); err != nil {
		t.Fatal(err)
	}
	f.task.WorkflowStepID = "pool-native-backlog"
	f.task.Metadata = map[string]any{models.MetaKeyExecutorID: models.ExecutorIDWorktree, "sentinel": "keep"}
	if err := repo.UpdateTask(context.Background(), f.task); err != nil {
		t.Fatal(err)
	}
	step, err := workflows.GetStep(context.Background(), "pool-native-step")
	if err != nil {
		t.Fatal(err)
	}
	ctx := authn.WithIdentity(context.Background(), authn.Identity{UserID: "pool-human", SessionID: "native-browser", Role: authn.RoleAdmin})
	confirmation := &PoolReleaseConfirmation{ConfirmCLIQuota: true,
		ExpectedResourceVersion: f.task.UpdatedAt.UTC().Format(time.RFC3339Nano), ExpectedStepVersion: step.UpdatedAt.UTC().Format(time.RFC3339Nano)}
	return poolMoveFixture{taskPoolFixture: f, repo: repo, step: step, ctx: ctx, opts: MoveTaskOptions{PoolRelease: confirmation}}
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3
func TestPoolDispatchConfirmedNativeMoveUsesHostBoundIntent(t *testing.T) {
	f := newPoolMoveFixture(t)
	result, err := f.svc.MoveTaskWithOptions(f.ctx, f.task.ID, f.task.WorkflowID, f.step.ID, 0, f.opts)
	if err != nil || result == nil {
		t.Fatalf("当前版本的真人确认应沿用原生移动: %v", err)
	}
	stored, err := f.repo.GetTask(context.Background(), f.task.ID)
	if err != nil || stored.WorkflowStepID != f.step.ID || stored.Title != f.task.Title || stored.Metadata["sentinel"] != "keep" {
		t.Fatalf("应该保留同一张原生主卡: %+v %v", stored, err)
	}
	var entryID int64
	var trigger, actor string
	if err := f.database.QueryRow(`SELECT id, trigger, actor_id FROM task_step_transitions WHERE task_id = ? ORDER BY id DESC LIMIT 1`, f.task.ID).Scan(&entryID, &trigger, &actor); err != nil {
		t.Fatal(err)
	}
	if trigger != "pool_release_v1" || actor != "pool-human" {
		t.Fatalf("必须由宿主记录真实确认，不使用普通移动证明: %s %s", trigger, actor)
	}
	if outcome, err := f.publisher.PublishPoolRelease(context.Background(), f.task.ID, f.step.ID, fmt.Sprintf("entry:%020d", entryID)); err != nil || outcome != "queued" {
		t.Fatalf("已提交的同次阶段进入应可经可信发布器入队: %s %v", outcome, err)
	}
}

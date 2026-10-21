package service_test

import (
	"context"
	"errors"
	"testing"
	"time"

	settingsstore "github.com/kandev/kandev/internal/agent/settings/store"
	"github.com/kandev/kandev/internal/common/logger"
	officesqlite "github.com/kandev/kandev/internal/office/repository/sqlite"
	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	taskrepo "github.com/kandev/kandev/internal/task/repository/sqlite"
	"github.com/kandev/kandev/internal/testutil"
)

func TestPoolDispatchPublicationPostgresUnavailablePreservesOrdinaryQueue(t *testing.T) {
	database := testutil.OpenIsolatedPostgres(t, testutil.PostgresDSNFromEnv(t))
	if _, _, err := settingsstore.Provide(database, database, nil); err != nil {
		t.Fatal(err)
	}
	tasks, err := taskrepo.NewWithDB(database, database, nil)
	if err != nil {
		t.Fatal(err)
	}
	office, err := officesqlite.NewWithDB(database, database, nil)
	if err != nil {
		t.Fatal(err)
	}
	seedAgentProfile(t, database, "pool-pg-profile")
	log, err := logger.NewLogger(logger.LoggingConfig{Level: "error", Format: "console"})
	if err != nil {
		t.Fatal(err)
	}
	svc := runsservice.New(office.RunsRepository(), nil, log, nil)
	svc.SetPoolReleaseSource(tasks)
	svc.SetPoolEnqueueAdmission(&orchestrator.Service{})
	ctx := context.Background()
	outcome, row, err := svc.QueuePoolRunAndReturn(ctx, "pool-pg-task", 1)
	if !errors.Is(err, runsservice.ErrPoolPublisherUnavailable) || row != nil || outcome != "" {
		t.Fatalf("未支持存储不能启用池发布: %s %t %v", outcome, row != nil, err)
	}
	if err := svc.CheckPoolTaskStart(ctx, "pool-pg-task"); !errors.Is(err, runsmodels.ErrPoolAdmissionUnavailable) {
		t.Fatalf("不能把未支持的存储当成启动守卫已核验: %v", err)
	}
	request := runsmodels.PoolClaimStart{RunID: "pool-pg-run", ClaimID: "pool-pg-claim", Release: runsmodels.PoolReleaseSnapshot{
		TaskID: "pool-pg-task", WorkspaceID: "test-workspace", WorkflowID: "workflow", WorkflowStepID: "step", EntryID: 1,
		AgentProfileID: "pool-pg-profile", ActorID: "human", ReleasedAt: time.Now().UTC()}}
	if err := svc.AdmitPoolClaimStart(ctx, request); !errors.Is(err, runsmodels.ErrPoolAdmissionUnavailable) {
		t.Fatalf("未验收存储不能签发领取启动许可: %v", err)
	}
	tx, err := database.BeginTxx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := tasks.CheckPoolClaimReadyTx(ctx, tx, request.Release, request.RunID); err == nil {
		t.Fatal("原生资格仓储也必须拒绝未支持的存储")
	}
	if _, err := office.RunsRepository().AppendPoolLaunchAdmissionTx(ctx, tx, request); err == nil {
		t.Fatal("原生事件仓储不能绕过存储能力守卫")
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if outcome, row, err := svc.QueueRunAndReturn(ctx, runsservice.QueueRunRequest{AgentProfileID: "pool-pg-profile",
		Reason: "ordinary-queue", ActorKind: runsmodels.ActorKindUser, ActorID: "human", SkipCoalesce: true}); err != nil || row == nil || outcome != runsservice.QueueOutcomeQueued {
		t.Fatalf("普通原生队列不能被池限制改变: %s %t %v", outcome, row != nil, err)
	}
	var count int
	if err := database.Get(&count, `SELECT COUNT(*) FROM runs`); err != nil || count != 1 {
		t.Fatalf("只能保留普通运行: %d %v", count, err)
	}
}

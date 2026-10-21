package service_test

import (
	"context"
	"errors"
	"testing"

	settingsmodels "github.com/kandev/kandev/internal/agent/settings/models"
	settingsstore "github.com/kandev/kandev/internal/agent/settings/store"
	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/office/service"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
)

type poolProcessorBridge interface {
	SetPoolRunProcessor(func(context.Context, *runsmodels.ClaimedRun) error)
}

func queuedOrdinaryPoolRun(t *testing.T) (*service.Service, *mockTaskStarter, *runsmodels.Run) {
	t.Helper()
	starter := &mockTaskStarter{}
	svc := newTestService(t, service.ServiceOptions{TaskStarter: starter})
	runs := svc.RepoForTest().RunsRepository()
	profiles, _, err := settingsstore.Provide(runs.Writer(), runs.Reader(), nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := profiles.CreateAgent(ctx, &settingsmodels.Agent{ID: "claude-pool", Name: "claude-pool"}); err != nil {
		t.Fatal(err)
	}
	if err := profiles.CreateAgentProfile(ctx, &settingsmodels.AgentProfile{
		ID: "pool-fixed-profile", AgentID: "claude-pool", Name: "pool-fixed-profile", MaxConcurrentSessions: 1,
	}); err != nil {
		t.Fatal(err)
	}
	insertTestTask(t, svc, "pool-task", "ws-1")
	queue := runsservice.New(runs, nil, logger.Default(), nil)
	svc.SetRunsService(queue)
	_, run, err := queue.QueueRunAndReturn(ctx, runsservice.QueueRunRequest{
		AgentProfileID: "pool-fixed-profile", TaskID: "pool-task", Reason: "pool_dispatch",
		IdempotencyKey: "native-queue-fixture", SkipCoalesce: true,
		ActorKind: runsmodels.ActorKindUser, ActorID: "authenticated-pool-human",
	})
	if err != nil || run == nil {
		t.Fatalf("入队失败: %+v %v", run, err)
	}
	// 此夹具模拟宿主已验证的池发布。通用入队接口本身不授予保留池身份。
	key := runsmodels.PoolDispatchKeyPrefix + "trusted-entry"
	if _, err := runs.Writer().Exec(`UPDATE runs SET idempotency_key = ? WHERE id = ?`, key, run.ID); err != nil {
		t.Fatal(err)
	}
	run.IdempotencyKey = &key
	return svc, starter, run
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.1
func TestPoolDispatchBridgeCarriesClaimWithoutOfficeIdentity(t *testing.T) {
	svc, officeStarter, run := queuedOrdinaryPoolRun(t)
	bridge, ok := any(svc).(poolProcessorBridge)
	if !ok {
		t.Fatal("共享消费者缺少任务池专用适配接缝")
	}
	var delivered *runsmodels.ClaimedRun
	bridge.SetPoolRunProcessor(func(_ context.Context, claimed *runsmodels.ClaimedRun) error {
		delivered = claimed
		return nil
	})
	service.RunSchedulerTick(svc, context.Background())
	if delivered == nil || delivered.Run == nil || delivered.ClaimID == "" || delivered.ID != run.ID ||
		delivered.WorkspaceID != "ws-1" || delivered.AgentProfileID != run.AgentProfileID {
		t.Fatalf("共享消费者没有传递真实领取上下文: %+v", delivered)
	}
	var ledgerID string
	if err := svc.RepoForTest().RunsRepository().Reader().Get(&ledgerID,
		`SELECT id FROM office_launch_ledger WHERE run_id = ?`, run.ID); err != nil || ledgerID != delivered.ClaimID {
		t.Fatalf("传递的领取不是原子账本: %q, %v", ledgerID, err)
	}
	current, err := svc.RepoForTest().RunsRepository().GetRunByID(context.Background(), run.ID)
	if err != nil || current.Status != runsmodels.RunStatusClaimed || officeStarter.callCount() != 0 {
		t.Fatalf("池运行不得经过 Office 启动: %+v, %v, calls=%d", current, err, officeStarter.callCount())
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.1
func TestPoolDispatchBridgeUnknownDoesNotRetryOrFallBack(t *testing.T) {
	for _, wired := range []bool{false, true} {
		name := "unconfigured"
		if wired {
			name = "launch_result_unknown"
		}
		t.Run(name, func(t *testing.T) {
			svc, officeStarter, run := queuedOrdinaryPoolRun(t)
			bridge, ok := any(svc).(poolProcessorBridge)
			if !ok {
				t.Fatal("共享消费者缺少任务池专用适配接缝")
			}
			calls := 0
			if wired {
				bridge.SetPoolRunProcessor(func(context.Context, *runsmodels.ClaimedRun) error {
					calls++
					return errors.New("execution_may_have_started")
				})
			}
			ctx := context.Background()
			service.RunSchedulerTick(svc, ctx)
			service.RunSchedulerTick(svc, ctx)
			current, err := svc.RepoForTest().RunsRepository().GetRunByID(ctx, run.ID)
			wantCalls := 0
			if wired {
				wantCalls = 1
			}
			if err != nil || current.Status != runsmodels.RunStatusClaimed || calls != wantCalls || officeStarter.callCount() != 0 {
				t.Fatalf("未知结果不得重入队、走 Office 或调用两次: %+v err=%v pool=%d office=%d",
					current, err, calls, officeStarter.callCount())
			}
		})
	}
}

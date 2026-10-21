package service_test

import (
	"context"
	"errors"
	"testing"

	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

func nativePoolStartGuard(t *testing.T, candidate any) orchestrator.PoolTaskStartGuard {
	t.Helper()
	guard, ok := candidate.(orchestrator.PoolTaskStartGuard)
	if !ok {
		t.Fatal("共享队列没有提供真实任务启动占用核验")
	}
	return guard
}

// @covers AC-TASKS-AGENT-POOL-001.1
func TestPoolDispatchNativeStartGuardLinksQueuedAndClaimedRunWithoutChangingIt(t *testing.T) {
	f := newPoolPublishFixture(t)
	guard := nativePoolStartGuard(t, f.svc)
	ctx := context.Background()
	if err := guard.CheckPoolTaskStart(ctx, f.task.ID); err != nil {
		t.Fatalf("同任务尚无池运行时应保持普通启动可用: %v", err)
	}
	_, run, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if err != nil || run == nil {
		t.Fatalf("入池正对照必须成功: %+v %v", run, err)
	}
	for _, claimed := range []bool{false, true} {
		if claimed {
			claim, err := f.runs.ClaimNextEligibleRunWithClaim(ctx)
			if err != nil || claim == nil || claim.ID != run.ID {
				t.Fatalf("必须沿原生领取事务产生账本: %+v %v", claim, err)
			}
		}
		err := guard.CheckPoolTaskStart(ctx, f.task.ID)
		var busy *runsmodels.PoolTaskBusyError
		if !errors.As(err, &busy) || busy.RunID != run.ID {
			t.Fatalf("普通启动应指向原生池运行，不能换 Profile 绕过: claimed=%t err=%v", claimed, err)
		}
		stored, err := f.runs.GetRunByID(ctx, run.ID)
		if err != nil || stored.ID != run.ID || !stored.RequestedAt.Equal(run.RequestedAt) || (stored.Status == runsmodels.RunStatusClaimed) != claimed {
			t.Fatalf("只核验占用不能修改原运行: %+v %v", stored, err)
		}
	}
	var ledgerCount, sessionCount int
	if err := f.runs.Reader().Get(&ledgerCount, `SELECT COUNT(*) FROM office_launch_ledger WHERE run_id = ?`, run.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.runs.Reader().Get(&sessionCount, `SELECT COUNT(*) FROM task_sessions WHERE task_id = ?`, f.task.ID); err != nil || ledgerCount != 1 || sessionCount != 0 {
		t.Fatalf("核验不补造领取或会话: claims=%d sessions=%d err=%v", ledgerCount, sessionCount, err)
	}
	storedTask, err := f.tasks.GetTask(ctx, f.task.ID)
	if err != nil || !storedTask.UpdatedAt.Equal(f.task.UpdatedAt) {
		t.Fatalf("占用核验不能改变任务版本: %+v %v", storedTask, err)
	}
}

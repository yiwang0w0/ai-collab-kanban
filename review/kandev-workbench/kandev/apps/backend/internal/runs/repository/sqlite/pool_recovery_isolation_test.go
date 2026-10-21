package sqlite_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/runs/models"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolAutomaticRecoveryIsolation(t *testing.T) {
	assertPoolAutomaticRecoveryIsolation(t, newTestRepo)
}

func TestPoolAutomaticRecoveryIsolationPostgres(t *testing.T) {
	assertPoolAutomaticRecoveryIsolation(t, newTestRepoPostgres)
}

func assertPoolAutomaticRecoveryIsolation(t *testing.T, factory func(*testing.T) *runssqlite.Repository) {
	t.Helper()
	for _, action := range []string{"requeue", "retry", "retry-claimed", "stale"} {
		for _, suffix := range []string{"stage-entry", ""} {
			t.Run(action+"/"+suffix, func(t *testing.T) {
				repo := factory(t)
				cutoff := time.Date(2026, 10, 19, 1, 0, 0, 0, time.UTC)
				key := models.PoolDispatchKeyPrefix + suffix
				pool := mustCreateRun(t, repo, &models.Run{ID: "protected-pool", AgentProfileID: "fixed-cli",
					Status: models.RunStatusClaimed, IdempotencyKey: &key, Payload: `{}`,
					SessionID: "existing-session", RetryCount: 2, PriorityClass: models.PriorityClassPeriodic})
				setStatus(t, repo, pool.ID, "claimed", timePtr(cutoff.Add(-time.Hour)), nil)
				before := mustGetRun(t, repo, pool.ID)
				ordinaryKey := "office:pool-dispatch:v1:ordinary"
				ordinary := mustCreateRun(t, repo, &models.Run{ID: "ordinary-recovery", AgentProfileID: "ordinary-cli",
					Status: models.RunStatusClaimed, Payload: `{}`, PriorityClass: models.PriorityClassPeriodic, IdempotencyKey: &ordinaryKey})
				setStatus(t, repo, ordinary.ID, "claimed", timePtr(cutoff.Add(-time.Hour)), nil)
				applyPoolRecoveryAction(t, repo, action, pool.ID, false, cutoff)
				if after := mustGetRun(t, repo, pool.ID); !reflect.DeepEqual(before, after) {
					t.Fatalf("通用 %s 不得重置池领取或执行证据: before=%+v after=%+v", action, before, after)
				}
				if action != "stale" {
					applyPoolRecoveryAction(t, repo, action, ordinary.ID, true, cutoff)
				}
				if after := mustGetRun(t, repo, ordinary.ID); after.Status != models.RunStatusQueued || after.ClaimedAt != nil {
					t.Fatalf("同一入口必须仍能恢复普通运行: %+v", after)
				}
			})
		}
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolAutomaticRecoveryPreservesCurrentClaimAndReceipts(t *testing.T) {
	repo, writer, receipts, identity := poolReceiptFixture(t)
	ctx := context.Background()
	if _, err := receipts.AppendPoolExecutionBinding(ctx, identity); err != nil {
		t.Fatal(err)
	}
	if _, err := receipts.AppendPoolWorkObserved(ctx, identity, models.PoolStartTool); err != nil {
		t.Fatal(err)
	}
	before := mustGetRun(t, repo, identity.RunID)
	events, err := repo.ListRunEvents(ctx, identity.RunID, -1, 10)
	if err != nil {
		t.Fatal(err)
	}
	cutoff := before.ClaimedAt.Add(time.Hour)
	for _, recover := range []func() error{
		func() error { _, err := repo.RequeueClaimedRun(ctx, identity.RunID); return err },
		func() error { return repo.ScheduleRetry(ctx, identity.RunID, cutoff, 3) },
		func() error { _, err := repo.ScheduleRetryIfClaimed(ctx, identity.RunID, cutoff, 3); return err },
		func() error { _, err := repo.RecoverStale(ctx, cutoff); return err },
	} {
		if err := recover(); err != nil {
			t.Fatal(err)
		}
	}
	rebuilt := runssqlite.NewWithDB(writer, repo.Reader())
	claim, err := rebuilt.ResolveCurrentPoolClaim(ctx, identity.RunID)
	if err != nil || claim == nil || claim.ClaimID != identity.ClaimID || !reflect.DeepEqual(before, claim.Run) {
		t.Fatalf("重建必须仍得到原领取和执行关联，不能自动领取第二次: claim=%+v err=%v", claim, err)
	}
	afterEvents, err := rebuilt.ListRunEvents(ctx, identity.RunID, -1, 10)
	if err != nil || !reflect.DeepEqual(events, afterEvents) {
		t.Fatalf("通用恢复不得覆盖或补造历史: before=%+v after=%+v err=%v", events, afterEvents, err)
	}
	var ledgerCount int
	if err := writer.Get(&ledgerCount, `SELECT COUNT(*) FROM office_launch_ledger WHERE run_id = ?`, identity.RunID); err != nil || ledgerCount != 1 {
		t.Fatalf("应保留唯一原领取账本: count=%d err=%v", ledgerCount, err)
	}
}

func applyPoolRecoveryAction(t *testing.T, repo *runssqlite.Repository, action, runID string, expected bool, cutoff time.Time) {
	t.Helper()
	ctx := context.Background()
	switch action {
	case "requeue":
		if wrote, err := repo.RequeueClaimedRun(ctx, runID); err != nil || wrote != expected {
			t.Fatalf("通用重入队结果不符: wrote=%v expected=%v err=%v", wrote, expected, err)
		}
	case "retry":
		if err := repo.ScheduleRetry(ctx, runID, cutoff.Add(time.Hour), 3); err != nil {
			t.Fatal(err)
		}
	case "retry-claimed":
		if wrote, err := repo.ScheduleRetryIfClaimed(ctx, runID, cutoff.Add(time.Hour), 3); err != nil || wrote != expected {
			t.Fatalf("通用条件重试结果不符: wrote=%v expected=%v err=%v", wrote, expected, err)
		}
	case "stale":
		if count, err := repo.RecoverStale(ctx, cutoff); err != nil || count != 1 {
			t.Fatalf("超时扫描只能恢复一份普通运行: count=%d err=%v", count, err)
		}
	default:
		t.Fatalf("未知测试动作: %s", action)
	}
}

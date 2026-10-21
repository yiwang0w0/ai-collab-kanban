package sqlite_test

import (
	"context"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/runs/models"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
)

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.3
func TestPoolMutationIsolation(t *testing.T) {
	t.Run("coalesce", func(t *testing.T) { assertPoolCoalesceIsolation(t, newTestRepo(t)) })
	t.Run("session", func(t *testing.T) { assertPoolSessionBindingIsolation(t, newTestRepo(t)) })
}

func TestPoolMutationIsolationPostgres(t *testing.T) {
	t.Run("coalesce", func(t *testing.T) { assertPoolCoalesceIsolation(t, newTestRepoPostgres(t)) })
	t.Run("session", func(t *testing.T) { assertPoolSessionBindingIsolation(t, newTestRepoPostgres(t)) })
}

func assertPoolCoalesceIsolation(t *testing.T, repo *runssqlite.Repository) {
	t.Helper()
	ordinary := mustCreateRun(t, repo, &models.Run{
		ID: "ordinary", AgentProfileID: "fixed-cli", Reason: "explicit_queue",
		Payload: `{"task_id":"task","original":"ordinary"}`, Status: "queued", CoalescedCount: 1,
	})
	setRequestedAt(t, repo, ordinary.ID, time.Now().UTC().Add(-time.Minute))
	key := models.PoolDispatchKeyPrefix + "trusted-entry"
	pool := mustCreateRun(t, repo, &models.Run{
		ID: "pool", AgentProfileID: "fixed-cli", Reason: "explicit_queue", IdempotencyKey: &key,
		Payload: `{"task_id":"task","original":"pool"}`, Status: "queued", CoalescedCount: 1,
	})
	merged, err := repo.CoalesceRun(context.Background(), "fixed-cli", "explicit_queue", 3600, `{"task_id":"task","updated":true}`)
	if err != nil || !merged {
		t.Fatalf("普通合并应继续可用: %v, %v", merged, err)
	}
	storedPool := mustGetRun(t, repo, pool.ID)
	storedOrdinary := mustGetRun(t, repo, ordinary.ID)
	if storedPool.Payload != pool.Payload || storedPool.CoalescedCount != 1 || storedOrdinary.CoalescedCount != 2 {
		t.Fatalf("普通唤醒不得覆盖池发布快照: pool=%+v ordinary=%+v", storedPool, storedOrdinary)
	}
}

func assertPoolSessionBindingIsolation(t *testing.T, repo *runssqlite.Repository) {
	t.Helper()
	key := models.PoolDispatchKeyPrefix + "trusted-entry"
	pool := mustCreateRun(t, repo, &models.Run{ID: "pool-session", AgentProfileID: "fixed-cli",
		Status: "claimed", IdempotencyKey: &key, SessionID: "current-session"})
	ctx := context.Background()
	if wrote, err := repo.SetRunSessionID(ctx, pool.ID, "late-unfenced-session"); err != nil || wrote {
		t.Fatalf("无领取身份的旧回调不得写入池会话: %v, %v", wrote, err)
	}
	if current := mustGetRun(t, repo, pool.ID); current.SessionID != "current-session" {
		t.Fatalf("旧回调覆盖了当前池会话: %+v", current)
	}
	ordinary := mustCreateRun(t, repo, &models.Run{ID: "ordinary-session", AgentProfileID: "fixed-cli", Status: "claimed"})
	if wrote, err := repo.SetRunSessionID(ctx, ordinary.ID, "ordinary-session-id"); err != nil || !wrote {
		t.Fatalf("普通运行的会话写入应保持原行为: %v, %v", wrote, err)
	}
}

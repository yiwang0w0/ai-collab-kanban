package sqlite_test

import (
	"context"
	"testing"

	"github.com/kandev/kandev/internal/runs/models"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolTerminalMutationIsolation(t *testing.T) {
	assertPoolTerminalMutationIsolation(t, newTestRepo)
}

func TestPoolTerminalMutationIsolationPostgres(t *testing.T) {
	assertPoolTerminalMutationIsolation(t, newTestRepoPostgres)
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolQueuedAndClaimedRemainProtectedInMixedCancelBatch(t *testing.T) {
	repo := newTestRepo(t)
	var before []*models.Run
	for _, status := range []models.RunStatus{models.RunStatusQueued, models.RunStatusClaimed} {
		key := models.PoolDispatchKeyPrefix + string(status)
		pool := mustCreateRun(t, repo, &models.Run{ID: "pool-" + string(status), AgentProfileID: "fixed-cli",
			Status: status, IdempotencyKey: &key})
		before = append(before, mustGetRun(t, repo, pool.ID))
		mustCreateRun(t, repo, &models.Run{ID: "ordinary-" + string(status), AgentProfileID: "ordinary-cli", Status: status})
	}
	rows, err := repo.BulkCancelRuns(context.Background(), []string{"pool-queued", "pool-claimed", "ordinary-queued", "ordinary-claimed"}, "mixed-cancel")
	require.NoError(t, err)
	var changed []string
	for _, row := range rows {
		changed = append(changed, row.ID)
	}
	require.ElementsMatch(t, []string{"ordinary-queued", "ordinary-claimed"}, changed)
	for _, pool := range before {
		require.Equal(t, pool, mustGetRun(t, repo, pool.ID))
	}
}

func assertPoolTerminalMutationIsolation(t *testing.T, factory func(*testing.T) *runssqlite.Repository) {
	t.Helper()
	for _, action := range []string{"finish", "fail", "cancel", "bulk-cancel", "selector-cancel"} {
		for _, suffix := range []string{"entry", ""} {
			t.Run(action+"/"+suffix, func(t *testing.T) {
				repo := factory(t)
				key := models.PoolDispatchKeyPrefix + suffix
				pool := mustCreateRun(t, repo, &models.Run{ID: "pool-terminal", AgentProfileID: "fixed-cli",
					Status: models.RunStatusClaimed, IdempotencyKey: &key, SessionID: "bound-session"})
				before := mustGetRun(t, repo, pool.ID)
				require.False(t, applyPoolTerminalMutation(t, repo, action, pool.ID), "普通终结没有本次领取和停止证据")
				require.Equal(t, before, mustGetRun(t, repo, pool.ID))
				ordinaryKey := "office:pool-dispatch:v1:ordinary"
				ordinary := mustCreateRun(t, repo, &models.Run{ID: "ordinary-terminal", AgentProfileID: "ordinary-cli",
					Status: models.RunStatusClaimed, IdempotencyKey: &ordinaryKey})
				require.True(t, applyPoolTerminalMutation(t, repo, action, ordinary.ID), "同一入口必须仍能终结普通运行")
				require.NotNil(t, mustGetRun(t, repo, ordinary.ID).FinishedAt)
			})
		}
	}
}

func applyPoolTerminalMutation(t *testing.T, repo *runssqlite.Repository, action, runID string) bool {
	t.Helper()
	ctx := context.Background()
	switch action {
	case "finish", "fail":
		status := models.RunStatusFinished
		if action == "fail" {
			status = models.RunStatusFailed
		}
		run, err := repo.FinishRun(ctx, runID, string(status), nil)
		require.NoError(t, err)
		return run != nil
	case "cancel":
		wrote, err := repo.CancelRun(ctx, runID, "unfenced-cancel")
		require.NoError(t, err)
		return wrote
	case "bulk-cancel":
		rows, err := repo.BulkCancelRuns(ctx, []string{runID}, "unfenced-cancel")
		require.NoError(t, err)
		return len(rows) > 0
	case "selector-cancel":
		rows, err := repo.CancelRunsWhere(ctx, "unfenced-cancel", `id = ?`, runID)
		require.NoError(t, err)
		return len(rows) > 0
	default:
		t.Fatalf("未知终结测试动作: %s", action)
		return false
	}
}

package sqlite_test

import (
	"context"
	"testing"

	officesqlite "github.com/kandev/kandev/internal/office/repository/sqlite"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	"github.com/kandev/kandev/internal/testutil"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolFailureMutationIsolation(t *testing.T) {
	assertPoolFailureMutationIsolation(t, newTestRepo(t))
}

func TestPoolFailureMutationIsolationPostgres(t *testing.T) {
	db := testutil.OpenIsolatedPostgres(t, testutil.PostgresDSNFromEnv(t))
	_, err := tasksqlite.NewWithDB(db, db, nil)
	require.NoError(t, err)
	repo, err := officesqlite.NewWithDB(db, db, nil)
	require.NoError(t, err)
	assertPoolFailureMutationIsolation(t, repo)
}

func assertPoolFailureMutationIsolation(t *testing.T, repo *officesqlite.Repository) {
	t.Helper()
	ctx := context.Background()
	for _, suffix := range []string{"entry", ""} {
		key := runsmodels.PoolDispatchKeyPrefix + suffix
		run := &runsmodels.Run{ID: "pool-failure-" + suffix, AgentProfileID: "fixed-cli",
			Status: runsmodels.RunStatusClaimed, SessionID: "bound-session", IdempotencyKey: &key}
		require.NoError(t, repo.CreateRun(ctx, run))
		before, err := repo.GetRun(ctx, run.ID)
		require.NoError(t, err)
		wrote, err := repo.MarkRunFailed(ctx, run.ID, "late-unfenced-failure")
		require.NoError(t, err)
		require.False(t, wrote, "通用失败不能替代池的身份与停止核验")
		after, err := repo.GetRun(ctx, run.ID)
		require.NoError(t, err)
		require.Equal(t, before, after)
	}
	ordinary := &runsmodels.Run{ID: "ordinary-failure", AgentProfileID: "ordinary-cli", Status: runsmodels.RunStatusClaimed}
	require.NoError(t, repo.CreateRun(ctx, ordinary))
	wrote, err := repo.MarkRunFailed(ctx, ordinary.ID, "ordinary-failure")
	require.NoError(t, err)
	require.True(t, wrote, "同一入口必须仍能记录普通运行失败")
}

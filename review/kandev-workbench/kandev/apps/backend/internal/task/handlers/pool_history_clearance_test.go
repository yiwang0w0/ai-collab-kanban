package handlers

import (
	"net/http"
	"strconv"
	"testing"
	"time"

	officesqlite "github.com/kandev/kandev/internal/office/repository/sqlite"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolHistoryLegacyApprovalWithoutDispatchEvidenceRequiresNewApproval(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	status, body := f.move(t, "http", f.payload())
	require.Equal(t, http.StatusOK, status, string(body))
	var entryID int64
	var releasedAt time.Time
	require.NoError(t, f.database.QueryRow(`SELECT id,occurred_at FROM task_step_transitions
		WHERE task_id=? ORDER BY id DESC LIMIT 1`, f.task.ID).Scan(&entryID, &releasedAt))
	// 模拟旧版已批准但派发证据无法确认；启用边界不是执行时间。
	_, err := f.database.Exec(`UPDATE run_pool_history_policy SET activated_at=? WHERE version=1`, releasedAt.Add(time.Hour))
	require.NoError(t, err)
	before := poolHistorySourceCounts(t, f)
	outcome, err := f.service.PublishPoolRelease(f.ctx, f.task.ID, f.step.ID, strconv.FormatInt(entryID, 10))
	require.ErrorIs(t, err, runsmodels.ErrPoolHistoryLegacy)
	require.Equal(t, runsservice.QueueOutcomeNone, outcome)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.3
func TestPoolHistoryClearanceInsertFailureRollsBackNativeDeletion(t *testing.T) {
	fixture := newPoolRetentionFixture(t)
	before := poolHistorySourceCounts(t, fixture.f)
	_, err := fixture.f.database.Exec(`CREATE TRIGGER fixture_clearance_failure
		BEFORE INSERT ON run_pool_history_clearances BEGIN SELECT RAISE(ABORT,'fixture write failure'); END`)
	require.NoError(t, err)
	result, err := fixture.cleaner.DeleteRunBatch(fixture.f.ctx, fixture.f.database, fixture.cutoff, 0, 100)
	require.Error(t, err)
	require.Zero(t, result.RunsDeleted)
	require.Zero(t, result.RunEventsDeleted)
	require.Equal(t, before, poolHistorySourceCounts(t, fixture.f))
	var count int
	require.NoError(t, fixture.f.database.Get(&count, `SELECT COUNT(*) FROM run_pool_history_clearances`))
	require.Zero(t, count)
	_, err = fixture.f.database.Exec(`DROP TRIGGER fixture_clearance_failure`)
	require.NoError(t, err)
	fixture.purge(t) // 同一夹具移除真实写故障后确实可清理。
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.3
func TestPoolHistoryClearanceSchemaReplayPreservesProofAndActivationBoundary(t *testing.T) {
	fixture := newPoolRetentionFixture(t)
	fixture.purge(t)
	known := readPoolRetentionHistory(t, fixture)
	var activatedAt time.Time
	require.NoError(t, fixture.f.database.Get(&activatedAt, `SELECT activated_at FROM run_pool_history_policy WHERE version=1`))
	_, err := officesqlite.NewWithDB(fixture.f.database, fixture.f.database, nil)
	require.NoError(t, err)
	var replayedAt time.Time
	require.NoError(t, fixture.f.database.Get(&replayedAt, `SELECT activated_at FROM run_pool_history_policy WHERE version=1`))
	require.True(t, activatedAt.Equal(replayedAt))
	require.Equal(t, known, readPoolRetentionHistory(t, fixture))
	_, err = fixture.f.service.PublishPoolRelease(fixture.f.ctx, fixture.f.task.ID, fixture.f.step.ID,
		strconv.FormatInt(fixture.entryID, 10))
	require.ErrorIs(t, err, runsmodels.ErrPoolHistoryCleaned)
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.3
func TestPoolHistoryClearanceUpgradeKeepsExistingRunDeduped(t *testing.T) {
	fixture := newPoolRetentionFixture(t)
	f := fixture.f
	before := poolHistorySourceCounts(t, f)
	// 只删除临时数据库中尚无数据的新表，构造此前没有清理凭证的升级形状。
	_, err := f.database.Exec(`DROP TABLE run_pool_history_clearances`)
	require.NoError(t, err)
	_, err = f.database.Exec(`DROP TABLE run_pool_history_policy`)
	require.NoError(t, err)
	_, err = officesqlite.NewWithDB(f.database, f.database, nil)
	require.NoError(t, err)
	outcome, err := f.service.PublishPoolRelease(f.ctx, f.task.ID, f.step.ID, strconv.FormatInt(fixture.entryID, 10))
	require.NoError(t, err)
	require.Equal(t, runsservice.QueueOutcomeDeduped, outcome)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
	fixture.purge(t)
	require.Equal(t, "history_cleaned", readPoolRetentionHistory(t, fixture).Items[0].Reason)
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.3
func TestPoolHistoryClearanceInvalidBindingRollsBackNativeDeletion(t *testing.T) {
	for _, payload := range []string{"{}", `{"pool_release":{"task_id":"foreign"}}`} {
		t.Run(payload, func(t *testing.T) {
			fixture := newPoolRetentionFixture(t)
			_, err := fixture.f.database.Exec(`UPDATE runs SET payload=? WHERE id=?`, payload, fixture.runID)
			require.NoError(t, err)
			before := poolHistorySourceCounts(t, fixture.f)
			result, err := fixture.cleaner.DeleteRunBatch(fixture.f.ctx, fixture.f.database, fixture.cutoff, 0, 100)
			require.Error(t, err)
			require.Zero(t, result.RunsDeleted)
			require.Equal(t, before, poolHistorySourceCounts(t, fixture.f))
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.3
func TestPoolHistoryClearanceLaterDeletionFailureCannotLeaveProofBehind(t *testing.T) {
	for _, scenario := range []struct {
		name, statement      string
		wantError, abandoned bool
	}{
		{"事件删除失败", `CREATE TRIGGER fixture_delete_failure BEFORE DELETE ON run_events
			BEGIN SELECT RAISE(ABORT,'fixture delete failure'); END`, true, false},
		{"运行删除数量不符", `CREATE TRIGGER fixture_delete_failure BEFORE DELETE ON runs
			BEGIN SELECT RAISE(IGNORE); END`, false, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newPoolRetentionFixture(t)
			before := poolHistorySourceCounts(t, fixture.f)
			_, err := fixture.f.database.Exec(scenario.statement)
			require.NoError(t, err)
			result, err := fixture.cleaner.DeleteRunBatch(fixture.f.ctx, fixture.f.database, fixture.cutoff, 0, 100)
			if scenario.wantError {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			require.Equal(t, scenario.abandoned, result.Abandoned)
			require.Zero(t, result.RunsDeleted)
			require.Zero(t, result.RunEventsDeleted)
			require.Equal(t, before, poolHistorySourceCounts(t, fixture.f))
			var count int
			require.NoError(t, fixture.f.database.Get(&count, `SELECT COUNT(*) FROM run_pool_history_clearances`))
			require.Zero(t, count, "已插入的凭证须随删除失败或两次重验不符一起回滚")
			_, err = fixture.f.database.Exec(`DROP TRIGGER fixture_delete_failure`)
			require.NoError(t, err)
			fixture.purge(t)
			require.NoError(t, fixture.f.database.Get(&count, `SELECT COUNT(*) FROM run_pool_history_clearances`))
			require.Equal(t, 1, count)
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.4
func TestPoolHistoryClearancePreservesNativeClaimsAcrossPages(t *testing.T) {
	fixture := newPoolRetentionFixture(t)
	_, err := fixture.f.database.Exec(`UPDATE runs SET status='queued',claimed_at=NULL WHERE id=?`, fixture.runID)
	require.NoError(t, err)
	second, err := fixture.f.runs.ClaimNextEligibleRunWithClaim(fixture.f.ctx)
	require.NoError(t, err)
	require.NotNil(t, second)
	_, err = fixture.f.database.Exec(`UPDATE runs SET status='finished',finished_at=? WHERE id=?`,
		second.ClaimedAt.Add(time.Second), fixture.runID)
	require.NoError(t, err)
	result, err := fixture.cleaner.DeleteRunBatch(fixture.f.ctx, fixture.f.database, fixture.cutoff, 0, 100)
	require.NoError(t, err)
	require.EqualValues(t, 1, result.RunsDeleted)
	seen, cursor := make(map[string]bool), ""
	for range 2 {
		query, err := poolhistory.ParseQuery(fixture.f.task.ID, 1, cursor)
		require.NoError(t, err)
		snapshot, err := fixture.f.tasks.ReadPoolHistorySnapshot(fixture.f.ctx, fixture.f.task.ID, fixture.f.task.WorkspaceID, query)
		require.NoError(t, err)
		page, err := poolhistory.Project(snapshot)
		require.NoError(t, err)
		require.Len(t, page.Items, 1)
		item := page.Items[0]
		require.Equal(t, "history_cleaned", item.Reason)
		require.NotEmpty(t, item.ClaimID)
		require.False(t, seen[item.ClaimID])
		require.False(t, item.Current)
		require.Nil(t, item.StartedAt)
		seen[item.ClaimID], cursor = true, page.NextCursor
	}
	require.True(t, seen[fixture.claimID])
	require.True(t, seen[second.ClaimID])
	require.Empty(t, cursor)
}

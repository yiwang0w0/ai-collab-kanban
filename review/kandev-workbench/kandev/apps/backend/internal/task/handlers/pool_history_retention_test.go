package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/db"
	"github.com/kandev/kandev/internal/office/retention"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/poolview"
	"github.com/stretchr/testify/require"
)

type poolRetentionFixture struct {
	f       poolMoveWireFixture
	runID   string
	claimID string
	entryID int64
	cutoff  time.Time
	cleaner *retention.Store
}

func newPoolRetentionFixture(t *testing.T) poolRetentionFixture {
	t.Helper()
	f := queuedPoolHistoryFixture(t)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, claim)
	finishedAt := claim.ClaimedAt.Add(time.Second)
	// 仅构造可被原生维护选择的终态元数据，不冒充真实执行、停止或人工恢复。
	_, err = f.database.Exec(`UPDATE runs SET status='finished',finished_at=?,outcome=? WHERE id=?`,
		finishedAt, runsmodels.PoolOutcomeExecutionStopped, claim.ID)
	require.NoError(t, err)
	_, err = f.database.Exec(`INSERT INTO run_events(run_id,seq,event_type,payload,created_at)
		VALUES (?,0,'fixture.metadata','{"fixture":true}',?)`, claim.ID, finishedAt)
	require.NoError(t, err)
	var entryID int64
	require.NoError(t, f.database.Get(&entryID, `SELECT MAX(id) FROM task_step_transitions WHERE task_id=?`, f.task.ID))
	return poolRetentionFixture{f: f, runID: claim.ID, claimID: claim.ClaimID, entryID: entryID,
		cutoff: finishedAt.Add(time.Hour), cleaner: retention.NewStore(db.NewPool(f.database, f.database))}
}

func (fixture poolRetentionFixture) purge(t *testing.T) {
	t.Helper()
	eligible, err := fixture.cleaner.CountEligibleRuns(fixture.f.ctx, fixture.f.database, fixture.cutoff, 0)
	require.NoError(t, err)
	require.EqualValues(t, 1, eligible, "必须经过原生维护的资格选择，而不是直接删除模拟其效果")
	result, err := fixture.cleaner.DeleteRunBatch(fixture.f.ctx, fixture.f.database, fixture.cutoff, 0, 100)
	require.NoError(t, err)
	require.EqualValues(t, 1, result.RunsDeleted)
	require.EqualValues(t, 1, result.RunEventsDeleted)
	remaining := poolHistorySourceCounts(t, fixture.f)
	require.Zero(t, remaining.Counts[0])
	require.Zero(t, remaining.Counts[1])
	require.Equal(t, 1, remaining.Counts[2], "原生领取账本未被清理，不能把它的缺乏任务关联当成没有领取")
}

func readPoolRetentionHistory(t *testing.T, fixture poolRetentionFixture) poolhistory.Page {
	t.Helper()
	response := poolHistoryHTTPRequest(t, fixture.f, fixture.f.ctx, "/api/v1/tasks/"+fixture.f.task.ID+"/pool-history")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var page poolhistory.Page
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	return page
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.2 AC-TASKS-AGENT-POOL-003.4
func TestPoolHistoryHTTPMarksNativeRetentionInsteadOfUnqueuedRelease(t *testing.T) {
	fixture := newPoolRetentionFixture(t)
	known := readPoolRetentionHistory(t, fixture)
	require.Equal(t, fixture.claimID, known.Items[0].ClaimID)
	require.Nil(t, known.Items[0].StartedAt, "本夹具没有任何开工回执")
	fixture.purge(t)
	before := poolHistorySourceCounts(t, fixture.f)
	after := readPoolRetentionHistory(t, fixture)
	require.Equal(t, before, poolHistorySourceCounts(t, fixture.f), "查询不能回填已被维护删除的原生事实")
	t.Logf("原生清理后状态=%s，原因=%s，运行行数=%d，领取账本行数=%d", after.Items[0].State,
		after.Items[0].Reason, before.Counts[0], before.Counts[2])
	require.Equal(t, "unknown", after.Items[0].State)
	require.Equal(t, "history_cleaned", after.Items[0].Reason)
	require.Equal(t, fixture.runID, after.Items[0].RunID)
	require.Equal(t, fixture.claimID, after.Items[0].ClaimID)
	require.Nil(t, after.Items[0].StartedAt, "清理凭证不构成开工证明，也不能从缓存补造时间")
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolHistoryNativeRetentionCannotRecreateSameApprovedRun(t *testing.T) {
	fixture := newPoolRetentionFixture(t)
	f := fixture.f
	entry := strconv.FormatInt(fixture.entryID, 10)
	beforeReplay := poolHistorySourceCounts(t, f)
	outcome, err := f.service.PublishPoolRelease(f.ctx, f.task.ID, f.step.ID, entry)
	require.NoError(t, err)
	require.Equal(t, runsservice.QueueOutcomeDeduped, outcome, "清理前同一批准必须实际去重，不能用始终拒绝的发布器证明防护")
	require.Equal(t, beforeReplay, poolHistorySourceCounts(t, f))
	fixture.purge(t)
	before := poolHistorySourceCounts(t, f)
	outcome, err = f.service.PublishPoolRelease(f.ctx, f.task.ID, f.step.ID, entry)
	after := poolHistorySourceCounts(t, f)
	t.Logf("同一批准在原生清理后重放: outcome=%s，error=%v，运行行数 %d -> %d", outcome, err, before.Counts[0], after.Counts[0])
	require.Equal(t, before, after, "同一批准不能因为维护删除去重记录而重新生成运行")
	require.Error(t, err)
	require.Equal(t, runsservice.QueueOutcomeNone, outcome)
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.2 AC-TASKS-AGENT-POOL-003.4
func TestPoolProjectionHTTPMarksNativeRetentionInsteadOfDispatchPending(t *testing.T) {
	fixture := newPoolRetentionFixture(t)
	known := readPoolProjectionCard(t, fixture.f)
	require.NotNil(t, known.PoolExecution)
	require.Equal(t, fixture.claimID, known.PoolExecution.ClaimID)
	fixture.purge(t)
	before := poolHistorySourceCounts(t, fixture.f)
	response := poolHistoryHTTPRequest(t, fixture.f, fixture.f.ctx,
		"/api/v1/workspaces/"+fixture.f.task.WorkspaceID+"/task-pool")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var page poolview.Page
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	require.Equal(t, before, poolHistorySourceCounts(t, fixture.f))
	card := page.Items[0]
	require.NotNil(t, card.PoolExecution)
	t.Logf("原生清理后工作区卡: 执行=%s，资格=%s，原因=%s", card.PoolExecution.State, card.Eligibility.State, card.Eligibility.Reason)
	require.Equal(t, "unknown", card.Eligibility.State)
	require.Equal(t, "history_cleaned", card.PoolExecution.Reason)
	require.Equal(t, fixture.claimID, card.PoolExecution.ClaimID)
	require.False(t, card.PoolExecution.Current)
}

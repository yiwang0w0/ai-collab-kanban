package handlers

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/poolview"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolHistoryLegacyApprovalReadDoesNotClaimNeverQueued(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	status, body := f.move(t, "http", f.payload())
	require.Equal(t, http.StatusOK, status, string(body))
	_, err := f.database.Exec(`UPDATE run_pool_history_policy SET activated_at=? WHERE version=1`, time.Now().UTC().Add(time.Hour))
	require.NoError(t, err)
	before := poolHistorySourceCounts(t, f)
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history")
	require.Equal(t, http.StatusOK, response.Code)
	var history poolhistory.Page
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &history))
	require.Len(t, history.Items, 1)
	require.Equal(t, "unknown", history.Items[0].State)
	require.Equal(t, "legacy_dispatch_unverified", history.Items[0].Reason)
	require.Empty(t, history.Items[0].RunID)
	require.Nil(t, history.Items[0].QueuedAt)
	response = poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool")
	require.Equal(t, http.StatusOK, response.Code)
	var page poolview.Page
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	card := page.Items[0]
	require.NotNil(t, card.PoolExecution)
	require.Equal(t, "unknown", card.Eligibility.State)
	require.Equal(t, "legacy_dispatch_unverified", card.PoolExecution.Reason)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.3
func TestPoolHistoryLegacyCleanerCannotBypassClearanceOwner(t *testing.T) {
	fixture := newPoolRetentionFixture(t)
	run, err := fixture.f.runs.GetRunByID(fixture.f.ctx, fixture.runID)
	require.NoError(t, err)
	run.ID, run.IdempotencyKey, run.Reason = "ordinary-expired-control", nil, "manual"
	require.NoError(t, fixture.f.runs.CreateRun(fixture.f.ctx, run))
	_, err = fixture.f.database.Exec(`UPDATE runs SET finished_at=? WHERE id=?`, fixture.cutoff.Add(-time.Second), run.ID)
	require.NoError(t, err)
	deleted, err := fixture.f.runs.CleanExpired(fixture.f.ctx, fixture.cutoff)
	require.NoError(t, err)
	require.EqualValues(t, 1, deleted, "普通终态正对照仍应清理，池历史只能经凭证事务删除")
	preserved, err := fixture.f.runs.GetRunByID(fixture.f.ctx, fixture.runID)
	require.NoError(t, err)
	require.NotNil(t, preserved)
}

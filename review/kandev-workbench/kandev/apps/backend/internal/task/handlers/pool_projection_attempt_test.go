package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func readPoolProjectionCard(t *testing.T, f poolMoveWireFixture) poolProjectionHTTPItem {
	t.Helper()
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var page poolProjectionHTTPPage
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	return page.Items[0]
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-002.2
func TestPoolProjectionHTTPUsesNativeReleaseQueueAndActualClaim(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	status, body := f.move(t, "http", f.payload())
	require.Equal(t, http.StatusOK, status, string(body))
	released := readPoolProjectionCard(t, f)
	require.Equal(t, f.step.ID, released.WorkflowStepID)
	require.Equal(t, f.step.Name, released.Stage)
	require.NotNil(t, released.PoolExecution)
	require.Equal(t, "released", released.PoolExecution.State)
	require.Nil(t, released.PoolExecution.ClaimedAt)
	var entryID int64
	require.NoError(t, f.database.QueryRow(`SELECT MAX(id) FROM task_step_transitions WHERE task_id=?`, f.task.ID).Scan(&entryID))
	_, err := f.service.PublishPoolRelease(f.ctx, f.task.ID, f.step.ID, strconv.FormatInt(entryID, 10))
	require.NoError(t, err)
	queued := readPoolProjectionCard(t, f)
	require.NotNil(t, queued.PoolExecution)
	require.Equal(t, "queued", queued.PoolExecution.State)
	require.Empty(t, queued.PoolExecution.ClaimedAgentProfileID)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, claim)
	// 故意插入时刻较新的旧账本，证明列表依据原生当前领取而不是 MAX(claimed_at)。
	_, err = f.database.Exec(`INSERT INTO office_launch_ledger (id,run_id,workspace_id,claimed_at) VALUES (?,?,?,?)`,
		"pool-list-not-current", claim.ID, f.task.WorkspaceID, claim.ClaimedAt.Add(time.Hour))
	require.NoError(t, err)
	_, err = f.database.Exec(`PRAGMA query_only=ON`)
	require.NoError(t, err)
	t.Cleanup(func() { _, err := f.database.Exec(`PRAGMA query_only=OFF`); require.NoError(t, err) })
	before := poolHistorySourceCounts(t, f)
	claimed := readPoolProjectionCard(t, f)
	require.NotNil(t, claimed.PoolExecution)
	require.Equal(t, "claimed", claimed.PoolExecution.State)
	require.Equal(t, claim.ID, claimed.PoolExecution.RunID)
	require.Equal(t, claim.ClaimID, claimed.PoolExecution.ClaimID)
	require.Equal(t, claim.AgentProfileID, claimed.PoolExecution.ClaimedAgentProfileID)
	require.True(t, claimed.PoolExecution.ClaimedAt.Equal(*claim.ClaimedAt))
	require.Nil(t, claimed.PoolExecution.StartedAt)
	require.Equal(t, before.TaskState, claimed.TaskState)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

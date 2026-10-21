package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/task/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-003.4 AC-TASKS-AGENT-POOL-002.3
func TestPoolHistoryHTTPBoundsActualLedgerRowsAndScopesOpaqueCursor(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, claim)
	require.NotNil(t, claim.ClaimedAt)
	// 历史容量夹具只补原生表的旧记录，不启动执行器或声称人工恢复已完成。
	for index := 0; index < 50; index++ {
		_, err := f.database.Exec(`INSERT INTO office_launch_ledger (id,run_id,workspace_id,claimed_at) VALUES (?,?,?,?)`,
			fmt.Sprintf("history-old-%02d", index), claim.ID, f.task.WorkspaceID, claim.ClaimedAt.Add(-time.Duration(index+1)*time.Second))
		require.NoError(t, err)
	}
	before := poolHistorySourceCounts(t, f)
	first := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history?limit=50")
	require.Equal(t, http.StatusOK, first.Code, first.Body.String())
	var page poolHistoryHTTPPage
	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &page))
	require.Len(t, page.Items, 50)
	require.NotEmpty(t, page.NextCursor)
	second := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history?limit=50&cursor="+url.QueryEscape(page.NextCursor))
	require.Equal(t, http.StatusOK, second.Code, second.Body.String())
	var tail poolHistoryHTTPPage
	require.NoError(t, json.Unmarshal(second.Body.Bytes(), &tail))
	require.Len(t, tail.Items, 1)
	require.Empty(t, tail.NextCursor)
	seen := make(map[string]bool)
	for _, item := range append(page.Items, tail.Items...) {
		require.NotEmpty(t, item.ClaimID)
		require.False(t, seen[item.ClaimID], "不允许页间重复或丢失旧领取")
		seen[item.ClaimID] = true
	}
	require.Len(t, seen, 51)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
	other := &models.Task{ID: "other-history-task", WorkspaceID: f.task.WorkspaceID, WorkflowID: f.task.WorkflowID,
		WorkflowStepID: "pool-wire-backlog", Title: "游标隔离", State: v1.TaskStateTODO, Priority: "medium"}
	require.NoError(t, f.tasks.CreateTask(f.ctx, other))
	wrong := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+other.ID+"/pool-history?cursor="+url.QueryEscape(page.NextCursor))
	require.Equal(t, http.StatusBadRequest, wrong.Code, wrong.Body.String())
}

func TestPoolHistoryHTTPRunsWithSQLiteQueryOnlyEnabled(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	_, err := f.database.Exec(`PRAGMA query_only=ON`)
	require.NoError(t, err)
	t.Cleanup(func() { _, err := f.database.Exec(`PRAGMA query_only=OFF`); require.NoError(t, err) })
	before := poolHistorySourceCounts(t, f)
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

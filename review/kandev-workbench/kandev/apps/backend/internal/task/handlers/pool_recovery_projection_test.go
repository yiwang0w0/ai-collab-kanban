package handlers

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/poolview"
	"github.com/stretchr/testify/require"
)

func TestPoolRecoveryHTTPWithdrawalProjectsNativeReceipt(t *testing.T) {
	f, command, run := readyPoolWireRecovery(t)
	base := "/api/v1/tasks/" + f.task.ID
	write := poolRecoveryWireRequest(t, f, f.ctx, http.MethodPost, base+"/pool-recovery", command)
	require.Equal(t, http.StatusOK, write.Code, write.Body.String())
	history := poolRecoveryWireRequest(t, f, f.ctx, http.MethodGet, base+"/pool-history?limit=50", nil)
	require.Equal(t, http.StatusOK, history.Code, history.Body.String())
	var page poolhistory.Page
	require.NoError(t, json.Unmarshal(history.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	require.Equal(t, "withdrawn", page.Items[0].State)
	require.Equal(t, run.ID, page.Items[0].RunID)
	require.Empty(t, page.Items[0].ClaimID)
	require.Nil(t, page.Items[0].StartedAt)
	require.NotNil(t, page.Items[0].EndedAt)
	list := poolRecoveryWireRequest(t, f, f.ctx, http.MethodGet, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool?limit=50", nil)
	require.Equal(t, http.StatusOK, list.Code, list.Body.String())
	var cards poolview.Page
	require.NoError(t, json.Unmarshal(list.Body.Bytes(), &cards))
	require.Len(t, cards.Items, 1)
	require.Equal(t, "withdrawn", cards.Items[0].PoolExecution.State)
	require.Equal(t, page.Items[0].EndedAt, cards.Items[0].PoolExecution.EndedAt)
	// 仅有 cancelled 行不够；缺少原生回执必须显示待核实。
	_, err := f.database.Exec(`DELETE FROM run_events WHERE run_id=?`, run.ID)
	require.NoError(t, err)
	missing := poolRecoveryWireRequest(t, f, f.ctx, http.MethodGet, base+"/pool-history?limit=50", nil)
	require.Equal(t, http.StatusOK, missing.Code)
	require.NoError(t, json.Unmarshal(missing.Body.Bytes(), &page))
	require.Equal(t, "unknown", page.Items[0].State)
	require.Nil(t, page.Items[0].EndedAt)
}

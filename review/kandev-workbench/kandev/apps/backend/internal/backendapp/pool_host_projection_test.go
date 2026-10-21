package backendapp

import (
	"database/sql"
	"net/http"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

type poolHostProjectionCard struct {
	TaskID        string `json:"task_id"`
	PoolExecution *struct {
		RunID       string     `json:"run_id"`
		ClaimID     string     `json:"claim_id"`
		SessionID   string     `json:"session_id"`
		State       string     `json:"state"`
		StartedAt   *time.Time `json:"started_at"`
		TurnEndedAt *time.Time `json:"turn_ended_at"`
		StoppedAt   *time.Time `json:"stopped_at"`
		EndedAt     *time.Time `json:"ended_at"`
	} `json:"pool_execution"`
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-003.4
func (f *poolBinaryHost) assertProjectionMatchesNativeEvents(t *testing.T, db *sql.DB, taskID, runID, claimID, sessionID string, finished bool) {
	t.Helper()
	var workspaceID string
	require.NoError(t, db.QueryRow(`SELECT workspace_id FROM tasks WHERE id=?`, taskID).Scan(&workspaceID))
	var page struct {
		WorkspaceID string                   `json:"workspace_id"`
		Items       []poolHostProjectionCard `json:"items"`
	}
	f.request(t, http.MethodGet, "/api/v1/workspaces/"+workspaceID+"/task-pool", nil, &page)
	require.Equal(t, workspaceID, page.WorkspaceID)
	var selected *poolHostProjectionCard
	for index := range page.Items {
		if page.Items[index].TaskID == taskID {
			selected = &page.Items[index]
		}
	}
	require.NotNil(t, selected)
	require.NotNil(t, selected.PoolExecution)
	item := selected.PoolExecution
	require.Equal(t, runID, item.RunID)
	require.Equal(t, claimID, item.ClaimID)
	require.Equal(t, sessionID, item.SessionID)
	assertPoolHostEventTime(t, db, runID, runsmodels.PoolWorkObserved, item.StartedAt)
	assertPoolHostEventTime(t, db, runID, runsmodels.PoolTurnEnded, item.TurnEndedAt)
	if finished {
		require.Equal(t, "ended", item.State)
		assertPoolHostEventTime(t, db, runID, runsmodels.PoolExecutionStopped, item.StoppedAt)
		assertPoolHostEventTime(t, db, runID, runsmodels.PoolExecutionFinished, item.EndedAt)
	} else {
		require.Equal(t, "turn_ended", item.State)
		require.Nil(t, item.StoppedAt)
		require.Nil(t, item.EndedAt)
	}
}

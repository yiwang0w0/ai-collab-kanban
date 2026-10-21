package backendapp

import (
	"database/sql"
	"net/http"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-002.4
func (f *poolBinaryHost) assertHistoryMatchesNativeEvents(t *testing.T, db *sql.DB, taskID, runID, claimID, sessionID string, finished bool) {
	t.Helper()
	var page struct {
		TaskID string `json:"task_id"`
		Items  []struct {
			RunID       string     `json:"run_id"`
			ClaimID     string     `json:"claim_id"`
			SessionID   string     `json:"session_id"`
			State       string     `json:"state"`
			StartedAt   *time.Time `json:"started_at"`
			TurnEndedAt *time.Time `json:"turn_ended_at"`
			StoppedAt   *time.Time `json:"stopped_at"`
			EndedAt     *time.Time `json:"ended_at"`
		} `json:"items"`
	}
	f.request(t, http.MethodGet, "/api/v1/tasks/"+taskID+"/pool-history", nil, &page)
	require.Equal(t, taskID, page.TaskID)
	require.Len(t, page.Items, 1)
	item := page.Items[0]
	require.Equal(t, runID, item.RunID)
	require.Equal(t, claimID, item.ClaimID)
	require.Equal(t, sessionID, item.SessionID)
	assertPoolHostEventTime(t, db, runID, runsmodels.PoolWorkObserved, item.StartedAt)
	assertPoolHostEventTime(t, db, runID, runsmodels.PoolTurnEnded, item.TurnEndedAt)
	if finished {
		require.Equal(t, "ended", item.State, "队列终结只表示本轮结束，不是主卡 Done")
		assertPoolHostEventTime(t, db, runID, runsmodels.PoolExecutionStopped, item.StoppedAt)
		assertPoolHostEventTime(t, db, runID, runsmodels.PoolExecutionFinished, item.EndedAt)
	} else {
		require.Equal(t, "turn_ended", item.State, "回合结束不等于进程已停止")
		require.Nil(t, item.StoppedAt)
		require.Nil(t, item.EndedAt)
	}
}

func assertPoolHostEventTime(t *testing.T, db *sql.DB, runID, kind string, actual *time.Time) {
	t.Helper()
	var recorded time.Time
	require.NoError(t, db.QueryRow(`SELECT created_at FROM run_events WHERE run_id=? AND event_type=?`, runID, kind).Scan(&recorded))
	require.NotNil(t, actual)
	require.True(t, actual.Equal(recorded), "时间必须来自实际原生事件")
}

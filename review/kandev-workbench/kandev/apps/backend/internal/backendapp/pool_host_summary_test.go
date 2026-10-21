package backendapp

import (
	"database/sql"
	"encoding/json"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.4
func (f *poolBinaryHost) assertStoredPoolSummaryMatchesNativeEvents(t *testing.T, db *sql.DB, taskID, runID, claimID, sessionID string, finished bool) {
	t.Helper()
	expected := "turn_ended"
	if finished {
		expected = "ended"
	}
	var latest poolHostProjectionCard
	var lastError error
	ready := assert.Eventually(t, func() bool {
		var encoded string
		lastError = db.QueryRow(`SELECT summary FROM task_status_summaries WHERE task_id=?`, taskID).Scan(&encoded)
		if lastError != nil {
			return false
		}
		latest = poolHostProjectionCard{}
		lastError = json.Unmarshal([]byte(encoded), &latest)
		pool := latest.PoolExecution
		return lastError == nil && pool != nil && pool.State == expected && pool.RunID == runID && pool.ClaimID == claimID && pool.SessionID == sessionID
	}, 15*time.Second, 100*time.Millisecond, "持久摘要必须在查询 API 前跟进已经提交的真实池回执")
	if !ready {
		t.Fatalf("池摘要未收敛：state=%+v error=%v", latest.PoolExecution, lastError)
	}
	pool := latest.PoolExecution
	require.NotNil(t, pool)
	assertPoolHostEventTime(t, db, runID, runsmodels.PoolWorkObserved, pool.StartedAt)
	assertPoolHostEventTime(t, db, runID, runsmodels.PoolTurnEnded, pool.TurnEndedAt)
	if finished {
		assertPoolHostEventTime(t, db, runID, runsmodels.PoolExecutionStopped, pool.StoppedAt)
		assertPoolHostEventTime(t, db, runID, runsmodels.PoolExecutionFinished, pool.EndedAt)
	}
}

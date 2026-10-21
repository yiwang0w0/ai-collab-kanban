package backendapp

import (
	"crypto/sha256"
	"database/sql"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/stretchr/testify/require"
)

func (f *poolBinaryHost) assertFinishedPoolFacts(t *testing.T, db *sql.DB, taskID, runID, claimID, sessionID string) {
	t.Helper()
	rows, err := db.Query(`SELECT event_type FROM run_events WHERE run_id=? AND event_type LIKE 'pool.%' ORDER BY seq`, runID)
	require.NoError(t, err)
	var kinds []string
	for rows.Next() {
		var kind string
		require.NoError(t, rows.Scan(&kind))
		kinds = append(kinds, kind)
	}
	require.NoError(t, rows.Err())
	require.NoError(t, rows.Close())
	require.Equal(t, []string{runsmodels.PoolLaunchAdmitted, runsmodels.PoolExecutionAllocated, runsmodels.PoolExecutionBound,
		runsmodels.PoolWorkObserved, runsmodels.PoolTurnEnded, runsmodels.PoolExecutionStopped, runsmodels.PoolExecutionFinished}, kinds)
	var outcome string
	require.NoError(t, db.QueryRow(`SELECT outcome FROM runs WHERE id=?`, runID).Scan(&outcome))
	require.Equal(t, runsmodels.PoolOutcomeExecutionStopped, outcome)
	var finishClaim, finishSession, finishExecution string
	var stoppedSeq, referencedSeq int
	require.NoError(t, db.QueryRow(`SELECT json_extract(payload,'$.claim_id'), json_extract(payload,'$.session_id'),
		json_extract(payload,'$.execution_id'), json_extract(payload,'$.stopped_seq') FROM run_events
		WHERE run_id=? AND event_type=?`, runID, runsmodels.PoolExecutionFinished).Scan(&finishClaim, &finishSession, &finishExecution, &referencedSeq))
	require.NoError(t, db.QueryRow(`SELECT seq FROM run_events WHERE run_id=? AND event_type=?`, runID, runsmodels.PoolExecutionStopped).Scan(&stoppedSeq))
	require.Equal(t, stoppedSeq, referencedSeq)
	require.Equal(t, claimID, finishClaim)
	require.Equal(t, sessionID, finishSession)
	carrier := readPoolHostCarrier(t, db, taskID)
	require.Equal(t, sessionID, carrier.ID)
	require.Equal(t, sessionID, carrier.SessionID)
	require.Equal(t, finishExecution, carrier.ExecutionID)
	require.Equal(t, models.ExecutorRunningStatusStopped, carrier.Status)
	require.Zero(t, carrier.LocalPID)
	require.Zero(t, carrier.RemotePID)
}

type poolHostCarrierSnapshot struct {
	ID, SessionID, ExecutionID, Status string
	LocalPID, RemotePID                int
	ResumeDigest                       [32]byte
}

func readPoolHostCarrier(t *testing.T, db *sql.DB, taskID string) poolHostCarrierSnapshot {
	t.Helper()
	var carrier poolHostCarrierSnapshot
	var token string
	require.NoError(t, db.QueryRow(`SELECT id, session_id, agent_execution_id, status,
		COALESCE(local_pid,0), COALESCE(pid,0), COALESCE(resume_token,'')
		FROM executors_running WHERE task_id=?`, taskID).Scan(&carrier.ID, &carrier.SessionID, &carrier.ExecutionID,
		&carrier.Status, &carrier.LocalPID, &carrier.RemotePID, &token))
	carrier.ResumeDigest = sha256.Sum256([]byte(token))
	return carrier
}

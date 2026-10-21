package backendapp

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	_ "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func (f *poolBinaryHost) assertNativePoolEvidence(t *testing.T, taskID string) {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:"+filepath.ToSlash(filepath.Join(f.home, "data", "kandev.db"))+"?mode=ro&_busy_timeout=5000")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, db.Close()) })
	var runID, claimID, sessionID string
	require.Eventually(t, func() bool {
		err := db.QueryRow(`SELECT id, COALESCE(session_id, '') FROM runs WHERE idempotency_key LIKE 'pool-dispatch:v1:%'
			AND json_extract(payload, '$.task_id')=? LIMIT 1`, taskID).Scan(&runID, &sessionID)
		if err != nil || runID == "" || sessionID == "" {
			return false
		}
		var count int
		err = db.QueryRow(`SELECT COUNT(*) FROM run_events WHERE run_id=? AND event_type IN (?, ?, ?, ?, ?)`,
			runID, runsmodels.PoolLaunchAdmitted, runsmodels.PoolExecutionAllocated, runsmodels.PoolExecutionBound, runsmodels.PoolWorkObserved, runsmodels.PoolTurnEnded).Scan(&count)
		return err == nil && count == 5
	}, 60*time.Second, 100*time.Millisecond, "实际模拟进程必须产生同一原生运行的五种记录")
	var count int
	require.NoError(t, db.QueryRow(`SELECT COUNT(*) FROM office_launch_ledger WHERE run_id=?`, runID).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, db.QueryRow(`SELECT id FROM office_launch_ledger WHERE run_id=?`, runID).Scan(&claimID))
	rows, err := db.Query(`SELECT event_type, payload FROM run_events WHERE run_id=? AND event_type LIKE 'pool.%'`, runID)
	require.NoError(t, err)
	defer rows.Close()
	for rows.Next() {
		var eventType, encoded string
		var identity runsmodels.PoolExecutionIdentity
		require.NoError(t, rows.Scan(&eventType, &encoded))
		if eventType == runsmodels.PoolLaunchAdmitted {
			var intent runsmodels.PoolClaimStart
			require.NoError(t, json.Unmarshal([]byte(encoded), &intent))
			require.Equal(t, taskID, intent.Release.TaskID)
			require.Equal(t, claimID, intent.ClaimID)
			continue
		}
		require.NoError(t, json.Unmarshal([]byte(encoded), &identity))
		require.Equal(t, taskID, identity.TaskID)
		require.Equal(t, claimID, identity.ClaimID)
		require.Equal(t, sessionID, identity.SessionID)
	}
	require.NoError(t, rows.Err())
	f.assertNativeMockProcessAndGit(t)
	status, body := f.call(t, http.MethodPatch, "/api/v1/tasks/"+taskID, map[string]any{"state": "COMPLETED"}, f.interlock(t, http.MethodPatch, "/api/v1/tasks/"+taskID))
	require.Equal(t, http.StatusConflict, status, string(body))
	require.NoError(t, rows.Close())
	f.assertStoredPoolSummaryMatchesNativeEvents(t, db, taskID, runID, claimID, sessionID, false)
	f.assertHistoryMatchesNativeEvents(t, db, taskID, runID, claimID, sessionID, false)
	f.assertProjectionMatchesNativeEvents(t, db, taskID, runID, claimID, sessionID, false)
	f.assertDirectLaunchAdmission(t, db, taskID, runID, true)
	require.NoError(t, f.stopTask(t.Context(), taskID))
	finished := assert.Eventually(t, func() bool {
		var status string
		err := db.QueryRow(`SELECT status FROM runs WHERE id=?`, runID).Scan(&status)
		return err == nil && status == "finished"
	}, 25*time.Second, 100*time.Millisecond, "真实停止和资源核验后才允许池运行终结")
	if !finished {
		logPoolHostResources(t, db, taskID, runID)
		t.FailNow()
	}
	f.assertFinishedPoolFacts(t, db, taskID, runID, claimID, sessionID)
	f.assertStoredPoolSummaryMatchesNativeEvents(t, db, taskID, runID, claimID, sessionID, true)
	f.assertHistoryMatchesNativeEvents(t, db, taskID, runID, claimID, sessionID, true)
	f.assertProjectionMatchesNativeEvents(t, db, taskID, runID, claimID, sessionID, true)
	f.assertDirectLaunchAdmission(t, db, taskID, runID, false)
}

func logPoolHostResources(t *testing.T, db *sql.DB, taskID, runID string) {
	t.Helper()
	queries := []struct{ name, query, id string }{
		{"会话", `SELECT id,state,executor_id,agent_profile_id,execution_profile_id FROM task_sessions WHERE task_id=? LIMIT 5`, taskID},
		{"回合", `SELECT id,task_session_id,completed_at,execution_profile_id FROM task_session_turns WHERE task_id=? LIMIT 5`, taskID},
		{"运行清单", `SELECT id,session_id,status,agent_execution_id FROM executors_running WHERE task_id=? LIMIT 5`, taskID},
		{"checkout", `SELECT checkout_agent_id,checkout_run_id,checkout_at FROM tasks WHERE id=?`, taskID},
		{"池回执", `SELECT event_type,payload FROM run_events WHERE run_id=? AND event_type LIKE 'pool.%' ORDER BY seq LIMIT 8`, runID},
	}
	for _, query := range queries {
		rows, err := db.Query(query.query, query.id)
		if err != nil {
			t.Logf("%s 读取失败：%v", query.name, err)
			continue
		}
		columns, err := rows.Columns()
		require.NoError(t, err)
		for rows.Next() {
			values, pointers := make([]any, len(columns)), make([]any, len(columns))
			for index := range pointers {
				pointers[index] = &values[index]
			}
			require.NoError(t, rows.Scan(pointers...))
			t.Logf("%s %v：%v", query.name, columns, values)
		}
		require.NoError(t, rows.Err())
		require.NoError(t, rows.Close())
	}
}

func (f *poolBinaryHost) assertNativeMockProcessAndGit(t *testing.T) {
	t.Helper()
	require.NotEmpty(t, f.mockProcessIDs(t), "必须有真实 mock-agent 子进程的协议记录")
	cmd := exec.Command("git", "-C", filepath.Join(f.root, "r"), "worktree", "list", "--porcelain")
	cmd.Env = f.command.Env
	hidePoolHostWindow(cmd)
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, string(output))
	require.GreaterOrEqual(t, strings.Count(string(output), "worktree "), 2, "必须实际创建 Git Worktree，不能只返回临时路径")
}

func (f *poolBinaryHost) mockProcessIDs(t *testing.T) []int {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.root, "trace.jsonl"))
	require.NoError(t, err)
	ids := make(map[int]bool)
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var record struct {
			ProcessID string `json:"process_id"`
		}
		require.NoError(t, json.Unmarshal([]byte(line), &record))
		pid, err := strconv.Atoi(record.ProcessID)
		require.NoError(t, err)
		require.Positive(t, pid)
		ids[pid] = true
	}
	result := make([]int, 0, len(ids))
	for pid := range ids {
		result = append(result, pid)
	}
	slices.Sort(result)
	return result
}

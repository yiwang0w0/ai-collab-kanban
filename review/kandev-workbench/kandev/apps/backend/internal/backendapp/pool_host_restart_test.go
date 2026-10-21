package backendapp

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func (f *poolBinaryHost) startCommand(t *testing.T) {
	t.Helper()
	command, done := f.command, make(chan struct{})
	f.done = done
	require.NoError(t, command.Start())
	go func() { _ = command.Wait(); close(done) }()
}

func (f *poolBinaryHost) restart(t *testing.T) {
	t.Helper()
	previous := f.command
	require.NoError(t, previous.Process.Kill())
	select {
	case <-f.done:
	case <-time.After(10 * time.Second):
		t.Fatal("本测试拥有的旧宿主未退出，禁止创建第二宿主")
	}
	f.command = exec.Command(previous.Path, previous.Args[1:]...)
	f.command.Dir, f.command.Env = previous.Dir, previous.Env
	f.command.Stdout, f.command.Stderr = previous.Stdout, previous.Stderr
	hidePoolHostWindow(f.command)
	f.startCommand(t)
	require.NotEqual(t, previous.Process.Pid, f.command.Process.Pid)
	f.waitReady(t, f.nonce)
	var identity struct {
		Mode string `json:"mode"`
	}
	f.request(t, http.MethodGet, "/api/v1/auth/me", nil, &identity)
	require.Equal(t, "enabled", identity.Mode, "重启后必须仍经原生登录鉴权")
}

func (f *poolBinaryHost) assertPoolRestartUnchanged(t *testing.T, taskID string, request map[string]any) {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:"+filepath.ToSlash(filepath.Join(f.home, "data", "kandev.db"))+"?mode=ro&_busy_timeout=5000")
	require.NoError(t, err)
	defer func() { require.NoError(t, db.Close()) }()
	before := readPoolHostHistory(t, db, taskID)
	var poolBefore string
	require.NoError(t, db.QueryRow(`SELECT COALESCE(json_extract(summary,'$.pool_execution'),'') FROM task_status_summaries WHERE task_id=?`, taskID).Scan(&poolBefore))
	require.NotEmpty(t, poolBefore)
	historyStatus, historyBody := f.call(t, http.MethodGet, "/api/v1/tasks/"+taskID+"/pool-history", nil, "")
	require.Equal(t, http.StatusOK, historyStatus, string(historyBody))
	var workspaceID string
	require.NoError(t, db.QueryRow(`SELECT workspace_id FROM tasks WHERE id=?`, taskID).Scan(&workspaceID))
	projectionPath := "/api/v1/workspaces/" + workspaceID + "/task-pool"
	projectionStatus, projectionBody := f.call(t, http.MethodGet, projectionPath, nil, "")
	require.Equal(t, http.StatusOK, projectionStatus, string(projectionBody))
	carrier := readPoolHostCarrier(t, db, taskID)
	processes := f.mockProcessIDs(t)
	f.restart(t)
	var replay struct {
		ID string `json:"id"`
	}
	f.request(t, http.MethodPost, "/api/v1/tasks", request, &replay)
	require.Equal(t, taskID, replay.ID, "同一外部幂等键必须返回原生已存在的卡片")
	restoredStatus, restoredBody := f.call(t, http.MethodGet, "/api/v1/tasks/"+taskID+"/pool-history", nil, "")
	require.Equal(t, http.StatusOK, restoredStatus, string(restoredBody))
	require.Equal(t, string(historyBody), string(restoredBody), "真实宿主重启后只读投影必须重建同一组事实和语义版本")
	restoredProjectionStatus, restoredProjectionBody := f.call(t, http.MethodGet, projectionPath, nil, "")
	require.Equal(t, http.StatusOK, restoredProjectionStatus, string(restoredProjectionBody))
	require.Equal(t, string(projectionBody), string(restoredProjectionBody), "批量列表在真实重启和幂等重放后也须保持同一组事实")
	var poolAfter string
	require.NoError(t, db.QueryRow(`SELECT COALESCE(json_extract(summary,'$.pool_execution'),'') FROM task_status_summaries WHERE task_id=?`, taskID).Scan(&poolAfter))
	require.Equal(t, poolBefore, poolAfter, "真实重启后的原生摘要必须保留同一组池事实，而不是只保持旁路历史接口正确")
	require.Equal(t, before, readPoolHostHistory(t, db, taskID), "重启和创建重放不得改写领取及执行历史")
	require.Equal(t, carrier, readPoolHostCarrier(t, db, taskID), "原生恢复载体及恢复令牌不得被池收尾或重启删除")
	require.Equal(t, processes, f.mockProcessIDs(t), "重启和幂等重放不得启动第二个模拟代理")
}

func readPoolHostHistory(t *testing.T, db *sql.DB, taskID string) []string {
	t.Helper()
	rows, err := db.Query(`SELECT r.id, r.status, r.outcome, r.session_id, r.claimed_at, r.finished_at,
		l.id, e.seq, e.event_type, e.payload FROM runs r
		JOIN office_launch_ledger l ON l.run_id=r.id JOIN run_events e ON e.run_id=r.id
		WHERE r.idempotency_key LIKE 'pool-dispatch:v1:%' AND json_extract(r.payload, '$.task_id')=?
		ORDER BY r.id, l.id, e.seq`, taskID)
	require.NoError(t, err)
	defer rows.Close()
	var history []string
	for rows.Next() {
		var id, status, outcome, session, claimedAt, finishedAt, claim, eventType, payload string
		var seq int
		require.NoError(t, rows.Scan(&id, &status, &outcome, &session, &claimedAt, &finishedAt, &claim, &seq, &eventType, &payload))
		encoded, err := json.Marshal([]any{id, status, outcome, session, claimedAt, finishedAt, claim, seq, eventType, payload})
		require.NoError(t, err)
		history = append(history, string(encoded))
	}
	require.NoError(t, rows.Err())
	require.NotEmpty(t, history)
	return history
}

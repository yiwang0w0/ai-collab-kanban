package backendapp

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/agent/dto"
	ws "github.com/kandev/kandev/pkg/websocket"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.4
func (f *poolBinaryHost) assertDirectLaunchAdmission(t *testing.T, db *sql.DB, taskID, runID string, busy bool) {
	t.Helper()
	var profile string
	require.NoError(t, db.QueryRow(`SELECT agent_profile_id FROM runs WHERE id=?`, runID).Scan(&profile))
	processes := f.mockProcessIDs(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	message, err := f.sendWS(ctx, ws.ActionAgentLaunch, map[string]any{
		"task_id": taskID, "agent_profile_id": profile, "workspace_path": filepath.Join(f.root, "r"),
	})
	require.NoError(t, err)
	if message.Type == ws.MessageTypeResponse {
		var response dto.LaunchAgentResponse
		require.NoError(t, json.Unmarshal(message.Payload, &response))
		require.True(t, response.Success)
		require.NotEmpty(t, response.AgentID)
		stopped := false
		cleanup := func() {
			if stopped {
				return
			}
			stopCtx, stopCancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer stopCancel()
			ack, err := f.sendWS(stopCtx, ws.ActionAgentStop, map[string]any{"agent_id": response.AgentID})
			require.NoError(t, err)
			require.Equal(t, ws.MessageTypeResponse, ack.Type, string(ack.Payload))
			stopped = true
		}
		t.Cleanup(cleanup)
		defer cleanup()
	}
	if busy {
		require.Equal(t, ws.MessageTypeError, message.Type, "已领取的池任务不能从独立入口再准备运行时")
		require.Contains(t, string(message.Payload), "pool_task_busy")
	} else {
		require.Equal(t, ws.MessageTypeError, message.Type)
		require.Contains(t, string(message.Payload), "persist execution registration: session_id is required",
			"无池占用时保留旧入口的原生会话约束，不扩成新的模型启动路径")
	}
	require.Equal(t, processes, f.mockProcessIDs(t), "仅准备运行时不能冒称或实际启动第二模型进程")
}

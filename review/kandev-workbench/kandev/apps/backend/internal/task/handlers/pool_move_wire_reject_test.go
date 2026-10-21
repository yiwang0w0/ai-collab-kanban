package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-005.4
func TestPoolMoveWireRejectsCallerSuppliedAuthorityBeforeNativeWrite(t *testing.T) {
	for _, transport := range []string{"http", "websocket"} {
		t.Run(transport, func(t *testing.T) {
			f := newPoolMoveWireFixture(t)
			before, err := f.tasks.GetTask(context.Background(), f.task.ID)
			require.NoError(t, err)
			payload := f.payload()
			confirmation := payload["pool_release"].(map[string]any)
			confirmation["actor_id"] = "forged-actor"
			confirmation["agent_profile_id"] = "forged-profile"
			confirmation["dispatched_at"] = "2000-01-01T00:00:00Z"
			status, body := f.move(t, transport, payload)
			require.Equal(t, http.StatusBadRequest, status, string(body))
			task, err := f.tasks.GetTask(context.Background(), f.task.ID)
			require.NoError(t, err)
			require.Equal(t, before, task, "非法批准字段不能改变阶段、版本或账本")
			var count int
			require.NoError(t, f.database.Get(&count, `SELECT COUNT(*) FROM runs`))
			require.Zero(t, count)
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-005.4
func TestPoolMoveWireConfirmationSchemaCannotGrowCallerAuthority(t *testing.T) {
	for _, transport := range []string{"http", "websocket"} {
		t.Run(transport, func(t *testing.T) {
			base := map[string]any{"workflow_id": "wire-workflow", "workflow_step_id": "wire-step",
				"pool_release": map[string]any{"confirm_cli_quota": true, "expected_resource_version": "2026-10-18T12:34:56.123456789Z",
					"expected_step_version": "2026-10-17T08:07:06.987654321Z"}}
			if transport == "websocket" {
				base["id"] = "wire-task"
			}
			encoded, err := json.Marshal(base)
			require.NoError(t, err)
			require.NoError(t, decodePoolMoveWire(transport, encoded), "同一生产形状的合法请求必须可解析")
			for _, field := range []string{"actor_id", "agent_profile_id", "claim_id", "run_id", "dispatched_at", "started_at"} {
				t.Run(field, func(t *testing.T) {
					confirmation := base["pool_release"].(map[string]any)
					confirmation[field] = "private-fixture-value"
					defer delete(confirmation, field)
					encoded, err := json.Marshal(base)
					require.NoError(t, err)
					err = decodePoolMoveWire(transport, encoded)
					require.Error(t, err)
					require.NotContains(t, err.Error(), "private-fixture-value")
				})
			}
		})
	}
}

func decodePoolMoveWire(transport string, payload []byte) error {
	if transport == "http" {
		var request httpMoveTaskRequest
		return json.Unmarshal(payload, &request)
	}
	var request wsMoveTaskRequest
	return json.Unmarshal(payload, &request)
}

package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.4
func TestPoolMoveWireReportsVersionAndAvailabilityWithoutWriting(t *testing.T) {
	for _, transport := range []string{"http", "websocket"} {
		for _, mode := range []string{"quota", "task-version", "step-version", "publisher-off", "admission-off"} {
			t.Run(transport+"/"+mode, func(t *testing.T) {
				f := newPoolMoveWireFixture(t)
				before, err := f.tasks.GetTask(context.Background(), f.task.ID)
				require.NoError(t, err)
				payload := f.payload()
				confirmation := payload["pool_release"].(map[string]any)
				status, code := http.StatusConflict, "pool_release_human_confirmation_required"
				switch mode {
				case "quota":
					confirmation["confirm_cli_quota"] = false
				case "task-version":
					confirmation["expected_resource_version"] = "2000-01-01T00:00:00Z"
					code = "task_version_conflict"
				case "step-version":
					confirmation["expected_step_version"] = "2000-01-01T00:00:00Z"
					code = "pool_release_step_configuration_changed"
				case "publisher-off":
					f.service.SetPoolRunQueue(nil)
					status, code = http.StatusServiceUnavailable, "pool_execution_capability_unavailable"
				case "admission-off":
					f.service.SetPoolReleaseAdmission(nil)
					status, code = http.StatusServiceUnavailable, "pool_admission_unavailable"
				}
				actual, body := f.move(t, transport, payload)
				require.Equal(t, status, actual, string(body))
				var response map[string]any
				require.NoError(t, json.Unmarshal(body, &response))
				if transport == "websocket" {
					details, ok := response["details"].(map[string]any)
					require.True(t, ok, "应保留可翻译的领域错误代码")
					require.Equal(t, code, details["error_code"])
				} else {
					require.Equal(t, code, response["code"])
				}
				after, err := f.tasks.GetTask(context.Background(), f.task.ID)
				require.NoError(t, err)
				require.Equal(t, before, after)
				var count int
				require.NoError(t, f.database.Get(&count, `SELECT COUNT(*) FROM task_step_transitions WHERE task_id=? AND trigger='pool_release_v1'`, f.task.ID))
				require.Zero(t, count)
			})
		}
	}
}

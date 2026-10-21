package handlers

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	runsservice "github.com/kandev/kandev/internal/runs/service"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3
func TestPoolMoveWireConfirmedRequestReachesNativeApprovalAndQueue(t *testing.T) {
	for _, transport := range []string{"http", "websocket"} {
		t.Run(transport, func(t *testing.T) {
			f := newPoolMoveWireFixture(t)
			status, body := f.move(t, transport, f.payload())
			require.Equal(t, http.StatusOK, status, string(body))
			task, err := f.tasks.GetTask(context.Background(), f.task.ID)
			require.NoError(t, err)
			require.Equal(t, f.step.ID, task.WorkflowStepID)
			var entryID int64
			var trigger, actor string
			require.NoError(t, f.database.QueryRow(`SELECT id,trigger,actor_id FROM task_step_transitions WHERE task_id=? ORDER BY id DESC LIMIT 1`, f.task.ID).Scan(&entryID, &trigger, &actor))
			require.Equal(t, "pool_release_v1", trigger)
			require.Equal(t, "pool-wire-human", actor)
			outcome, err := f.service.PublishPoolRelease(f.ctx, f.task.ID, f.step.ID, fmt.Sprintf("entry:%020d", entryID))
			require.NoError(t, err)
			require.Equal(t, runsservice.QueueOutcomeQueued, outcome)
			var count int
			require.NoError(t, f.database.Get(&count, `SELECT COUNT(*) FROM runs`))
			require.Equal(t, 1, count, "实际确认应产生共享队列的一行，不另建任务或队列")
		})
	}
}

package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/task/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
	"github.com/stretchr/testify/require"
)

func queuedPoolProjectionNeighbor(t *testing.T, f poolMoveWireFixture) poolMoveWireFixture {
	t.Helper()
	now := time.Now().UTC()
	_, err := f.database.Exec(`INSERT INTO agent_profiles (id,agent_id,name,agent_display_name,enabled,created_at,updated_at)
		VALUES ('pool-list-neighbor-profile','pool-wire-agent','邻卡 CLI','CLI',1,?,?)`, now, now)
	require.NoError(t, err)
	step := *f.step
	step.ID, step.AgentProfileID = "pool-list-neighbor-step", "pool-list-neighbor-profile"
	require.NoError(t, f.workflows.CreateStep(f.ctx, &step))
	card := &models.Task{ID: "pool-list-neighbor-task", WorkspaceID: f.task.WorkspaceID, WorkflowID: f.task.WorkflowID,
		WorkflowStepID: "pool-wire-backlog", Title: "独立邻卡", State: v1.TaskStateTODO, Priority: "medium",
		Metadata: map[string]any{models.MetaKeyExecutorID: models.ExecutorIDWorktree}}
	require.NoError(t, f.tasks.CreateTask(f.ctx, card))
	neighbor := f
	neighbor.task, neighbor.step = card, &step
	status, body := neighbor.move(t, "http", neighbor.payload())
	require.Equal(t, http.StatusOK, status, string(body))
	var entryID int64
	require.NoError(t, f.database.QueryRow(`SELECT MAX(id) FROM task_step_transitions WHERE task_id=?`, card.ID).Scan(&entryID))
	_, err = f.service.PublishPoolRelease(f.ctx, card.ID, step.ID, strconv.FormatInt(entryID, 10))
	require.NoError(t, err)
	return neighbor
}

// @covers AC-TASKS-AGENT-POOL-003.4
func TestPoolProjectionHTTPIsolatesExcessEvidenceFromOtherNativeClaim(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	neighbor := queuedPoolProjectionNeighbor(t, f)
	first, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, first)
	second, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, second)
	badRun, badClaim, goodRun, goodClaim := first.ID, first.ClaimID, second.ID, second.ClaimID
	if first.AgentProfileID != f.step.AgentProfileID {
		badRun, badClaim, goodRun, goodClaim = second.ID, second.ClaimID, first.ID, first.ClaimID
	}
	encoded, err := json.Marshal(map[string]string{"claim_id": badClaim, "private": "PRIVATE-POOL-EVIDENCE"})
	require.NoError(t, err)
	var last int64
	require.NoError(t, f.database.Get(&last, `SELECT COALESCE(MAX(seq),-1) FROM run_events WHERE run_id=?`, badRun))
	// 故意残缺的过量持久资料，不声称是真实执行回执或模型任务。
	for index := 1; index <= 17; index++ {
		_, err := f.database.Exec(`INSERT INTO run_events (run_id,seq,event_type,payload,created_at) VALUES (?,?,?,?,?)`,
			badRun, last+int64(index), "pool.launch-admitted.v1", string(encoded), time.Now().UTC())
		require.NoError(t, err)
	}
	before := poolHistorySourceCounts(t, f)
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var page poolProjectionHTTPPage
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &page))
	require.Len(t, page.Items, 2)
	byID := make(map[string]poolProjectionHTTPItem)
	for _, card := range page.Items {
		byID[card.TaskID] = card
	}
	require.NotNil(t, byID[f.task.ID].PoolExecution)
	require.Equal(t, "unknown", byID[f.task.ID].PoolExecution.State)
	require.NotNil(t, byID[neighbor.task.ID].PoolExecution)
	require.Equal(t, "claimed", byID[neighbor.task.ID].PoolExecution.State)
	require.Equal(t, goodRun, byID[neighbor.task.ID].PoolExecution.RunID)
	require.Equal(t, goodClaim, byID[neighbor.task.ID].PoolExecution.ClaimID)
	require.NotContains(t, response.Body.String(), "PRIVATE-POOL-EVIDENCE")
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/task/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-004.3
func TestPoolProjectionHTTPDoesNotLoseUnfinishedClaimWhenNativeStageChanges(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, claim)
	status, body := f.move(t, "http", map[string]any{"id": f.task.ID, "workflow_id": f.task.WorkflowID,
		"workflow_step_id": "pool-wire-backlog", "position": 0})
	require.Equal(t, http.StatusOK, status, string(body))
	before := poolHistorySourceCounts(t, f)
	card := readPoolProjectionCard(t, f)
	require.Equal(t, "待办", card.Stage)
	require.NotNil(t, card.PoolExecution, "原生移动不能让未终结领取从工作台消失")
	require.Equal(t, "unknown", card.PoolExecution.State)
	require.Equal(t, claim.ID, card.PoolExecution.RunID)
	require.Equal(t, claim.ClaimID, card.PoolExecution.ClaimID)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

// @covers AC-TASKS-AGENT-POOL-003.2 AC-TASKS-AGENT-POOL-004.2 AC-TASKS-AGENT-POOL-004.3
func TestPoolProjectionHTTPCountsNativeRelationsAndKeepsMissingDependenciesBlocked(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	child := &models.Task{ID: "pool-list-child", WorkspaceID: f.task.WorkspaceID, WorkflowID: f.task.WorkflowID,
		WorkflowStepID: "pool-wire-backlog", ParentID: f.task.ID, Title: "子卡", State: v1.TaskStateTODO, Priority: "medium"}
	dependency := &models.Task{ID: "pool-list-dependency", WorkspaceID: f.task.WorkspaceID, WorkflowID: f.task.WorkflowID,
		WorkflowStepID: "pool-wire-backlog", Title: "前置主卡", State: v1.TaskStateTODO, Priority: "medium"}
	require.NoError(t, f.tasks.CreateTask(f.ctx, child))
	require.NoError(t, f.tasks.CreateTask(f.ctx, dependency))
	other := &models.Workspace{ID: "PRIVATE-FOREIGN-WS", Name: "不可见工作区", OwnerID: "pool-list-foreign-owner"}
	require.NoError(t, f.tasks.CreateWorkspace(context.Background(), other))
	foreign := &models.Task{ID: "PRIVATE-FOREIGN-TASK", WorkspaceID: other.ID, Title: "PRIVATE-FOREIGN-TITLE",
		State: v1.TaskStateCompleted, Priority: "medium"}
	require.NoError(t, f.tasks.CreateTask(context.Background(), foreign))
	// 包含历史脏边，查询不应自行清理，也不能泄漏目标或把缺失前置当成已完成。
	for _, edge := range [][2]string{{f.task.ID, dependency.ID}, {child.ID, f.task.ID},
		{f.task.ID, foreign.ID}, {f.task.ID, "PRIVATE-MISSING-TASK"}} {
		_, err := f.database.Exec(`INSERT INTO task_blockers (task_id,blocker_task_id,created_at) VALUES (?,?,?)`, edge[0], edge[1], time.Now().UTC())
		require.NoError(t, err)
	}
	before := poolHistorySourceCounts(t, f)
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var page poolProjectionHTTPPage
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &page))
	require.Len(t, page.Items, 3)
	byID := make(map[string]poolProjectionHTTPItem)
	for _, card := range page.Items {
		byID[card.TaskID] = card
	}
	main := byID[f.task.ID]
	require.Equal(t, 1, main.Relations.ChildCount)
	require.Equal(t, 1, main.Relations.DependsOnCount)
	require.Equal(t, 1, main.Relations.BlocksCount)
	require.Equal(t, f.task.ID, byID[child.ID].Relations.ParentID)
	require.Equal(t, "blocked", main.Eligibility.State)
	require.Equal(t, "dependencies_unresolved", main.Eligibility.Reason)
	require.NotContains(t, response.Body.String(), "PRIVATE-FOREIGN")
	require.NotContains(t, response.Body.String(), "PRIVATE-MISSING")
	var edges int
	require.NoError(t, f.database.Get(&edges, `SELECT COUNT(*) FROM task_blockers`))
	require.Equal(t, 4, edges, "读取不能清理关系以伪造可执行状态")
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

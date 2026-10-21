package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/stretchr/testify/require"
)

type poolProjectionHTTPPage struct {
	WorkspaceID     string                   `json:"workspace_id"`
	SnapshotVersion string                   `json:"snapshot_version"`
	Items           []poolProjectionHTTPItem `json:"items"`
	NextCursor      string                   `json:"next_cursor"`
}

type poolProjectionHTTPItem struct {
	TaskID         string               `json:"task_id"`
	Title          string               `json:"title"`
	WorkflowID     string               `json:"workflow_id"`
	WorkflowStepID string               `json:"workflow_step_id"`
	Stage          string               `json:"stage"`
	TaskState      string               `json:"task_state"`
	PoolExecution  *poolHistoryHTTPItem `json:"pool_execution"`
	Eligibility    struct {
		State  string `json:"state"`
		Reason string `json:"reason"`
	} `json:"eligibility"`
	Relations struct {
		ParentID       string `json:"parent_id"`
		ChildCount     int    `json:"child_count"`
		DependsOnCount int    `json:"depends_on_count"`
		BlocksCount    int    `json:"blocks_count"`
	} `json:"relations"`
}

// @covers AC-TASKS-AGENT-POOL-003.4 AC-TASKS-AGENT-POOL-004.1
func TestPoolProjectionHTTPListsNativeCardsWithoutInventingPoolExecution(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	_, err := f.database.Exec(`UPDATE tasks SET description=? WHERE id=?`, "PRIVATE-BODY-NOT-FOR-POOL-LIST", f.task.ID)
	require.NoError(t, err)
	before := poolHistorySourceCounts(t, f)
	path := "/api/v1/workspaces/" + f.task.WorkspaceID + "/task-pool"
	response := poolHistoryHTTPRequest(t, f, f.ctx, path)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var page poolProjectionHTTPPage
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &page))
	require.Equal(t, f.task.WorkspaceID, page.WorkspaceID)
	require.NotEmpty(t, page.SnapshotVersion)
	require.Len(t, page.Items, 1)
	item := page.Items[0]
	require.Equal(t, f.task.ID, item.TaskID)
	require.Equal(t, f.task.Title, item.Title)
	require.Equal(t, f.task.WorkflowID, item.WorkflowID)
	require.Equal(t, f.task.WorkflowStepID, item.WorkflowStepID)
	require.Equal(t, "待办", item.Stage)
	require.Equal(t, string(f.task.State), item.TaskState)
	require.Nil(t, item.PoolExecution, "普通主卡不补造批准、领取或开工")
	require.Empty(t, page.NextCursor)
	require.NotContains(t, response.Body.String(), "PRIVATE-BODY")
	repeated := poolHistoryHTTPRequest(t, f, f.ctx, path)
	require.Equal(t, response.Body.String(), repeated.Body.String())
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

func TestPoolProjectionHTTPRejectsUnboundedOrInvalidPaging(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	before := poolHistorySourceCounts(t, f)
	for _, query := range []string{"limit=51", "limit=-1", "limit=invalid", "cursor=invalid"} {
		t.Run(query, func(t *testing.T) {
			response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool?"+query)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), "pool_projection_invalid_query")
		})
	}
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

func TestPoolProjectionHTTPHidesForeignWorkspaceLikeMissingWorkspace(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	foreign := authn.WithIdentity(context.Background(), authn.Identity{UserID: "pool-list-other", SessionID: "other-browser"})
	denied := poolHistoryHTTPRequest(t, f, foreign, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool")
	missing := poolHistoryHTTPRequest(t, f, foreign, "/api/v1/workspaces/missing-pool-workspace/task-pool")
	require.Equal(t, http.StatusNotFound, denied.Code, denied.Body.String())
	require.Equal(t, missing.Body.String(), denied.Body.String())
	positive := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool")
	require.Equal(t, http.StatusOK, positive.Code, "拒绝不能仅由未注册路由造成")
}

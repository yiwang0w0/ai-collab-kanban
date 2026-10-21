package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"

	"github.com/kandev/kandev/internal/task/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-003.4
func TestPoolProjectionHTTPBoundsNativeCardsAndBindsCursorToWorkspace(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	for index := 0; index < 50; index++ {
		card := &models.Task{ID: fmt.Sprintf("pool-list-%02d", index), WorkspaceID: f.task.WorkspaceID,
			WorkflowID: f.task.WorkflowID, WorkflowStepID: f.task.WorkflowStepID, Title: "分页主卡",
			State: v1.TaskStateTODO, Priority: "medium"}
		require.NoError(t, f.tasks.CreateTask(f.ctx, card))
	}
	before := poolHistorySourceCounts(t, f)
	path := "/api/v1/workspaces/" + f.task.WorkspaceID + "/task-pool"
	response := poolHistoryHTTPRequest(t, f, f.ctx, path)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var first poolProjectionHTTPPage
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &first))
	require.Len(t, first.Items, 50)
	require.NotEmpty(t, first.NextCursor)
	tailResponse := poolHistoryHTTPRequest(t, f, f.ctx, path+"?cursor="+url.QueryEscape(first.NextCursor))
	require.Equal(t, http.StatusOK, tailResponse.Code, tailResponse.Body.String())
	var tail poolProjectionHTTPPage
	require.NoError(t, json.Unmarshal(tailResponse.Body.Bytes(), &tail))
	require.Len(t, tail.Items, 1)
	require.Empty(t, tail.NextCursor)
	seen := make(map[string]bool)
	for _, card := range append(first.Items, tail.Items...) {
		require.False(t, seen[card.TaskID], "稳定主卡游标不重复卡片")
		seen[card.TaskID] = true
	}
	require.Len(t, seen, 51)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
	other := &models.Workspace{ID: "pool-list-other-ws", Name: "其他工作区", OwnerID: "pool-wire-human"}
	require.NoError(t, f.tasks.CreateWorkspace(f.ctx, other))
	wrong := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/workspaces/"+other.ID+"/task-pool?cursor="+url.QueryEscape(first.NextCursor))
	require.Equal(t, http.StatusBadRequest, wrong.Code, wrong.Body.String())
}

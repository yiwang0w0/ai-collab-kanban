package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kandev/kandev/internal/task/models"
	ws "github.com/kandev/kandev/pkg/websocket"
	"github.com/stretchr/testify/require"
)

type poolCreateDispatcher struct {
	t          *testing.T
	fixture    poolMoveWireFixture
	calls      int
	onDispatch func(context.Context, string)
}

func (d *poolCreateDispatcher) DispatchStepEntry(ctx context.Context, taskID, workflowID, stepID, entryID string, markerEntryID int64) {
	d.t.Helper()
	d.calls++
	var count int
	require.NoError(d.t, d.fixture.database.Get(&count, `SELECT COUNT(*) FROM task_repositories WHERE task_id=?`, taskID))
	require.Equal(d.t, 1, count, "仓库关系提交后才允许原生阶段回调派发")
	if d.onDispatch != nil {
		d.onDispatch(ctx, taskID)
	}
	_, err := d.fixture.service.PublishPoolRelease(ctx, taskID, stepID, entryID)
	require.NoError(d.t, err)
}

func (f poolMoveWireFixture) createPayload() map[string]any {
	return map[string]any{"workspace_id": f.task.WorkspaceID, "workflow_id": f.task.WorkflowID,
		"workflow_step_id": f.step.ID, "title": "直接创建入池", "executor_id": models.ExecutorIDWorktree,
		"repositories": []map[string]any{{"repository_id": "pool-create-repository", "base_branch": "main"}},
		"pool_release": map[string]any{"confirm_cli_quota": true, "expected_resource_version": "",
			"expected_step_version": f.step.UpdatedAt.UTC().Format(time.RFC3339Nano)}}
}

func (f poolMoveWireFixture) create(t *testing.T, transport string, payload map[string]any) (int, []byte) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	require.NoError(t, err)
	if transport == "http" {
		response := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(response)
		ctx.Request = httptest.NewRequest(http.MethodPost, "/api/v1/tasks", strings.NewReader(string(encoded))).WithContext(f.ctx)
		ctx.Request.Header.Set("Content-Type", "application/json")
		f.handler.httpCreateTask(ctx)
		return response.Code, response.Body.Bytes()
	}
	response, err := f.handler.wsCreateTask(f.ctx, &ws.Message{ID: "pool-wire-create", Action: "task.create", Type: ws.MessageTypeRequest, Payload: encoded})
	require.NoError(t, err)
	require.NotNil(t, response)
	if response.Type == ws.MessageTypeResponse {
		return http.StatusOK, response.Payload
	}
	return http.StatusInternalServerError, response.Payload
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3
func TestPoolCreateWirePublishesOnlyAfterNativeRequiredWork(t *testing.T) {
	for _, transport := range []string{"http", "websocket"} {
		t.Run(transport, func(t *testing.T) {
			f := newPoolMoveWireFixture(t)
			require.NoError(t, f.tasks.CreateRepository(f.ctx, &models.Repository{ID: "pool-create-repository",
				WorkspaceID: f.task.WorkspaceID, Name: "创建仓库", DefaultBranch: "main"}))
			dispatcher := &poolCreateDispatcher{t: t, fixture: f}
			f.tasks.SetStepEntryDispatcher(dispatcher)
			status, body := f.create(t, transport, f.createPayload())
			require.Equal(t, http.StatusOK, status, string(body))
			require.Equal(t, 1, dispatcher.calls)
			var count int
			require.NoError(t, f.database.Get(&count, `SELECT COUNT(*) FROM runs`))
			require.Equal(t, 1, count)
		})
	}
}

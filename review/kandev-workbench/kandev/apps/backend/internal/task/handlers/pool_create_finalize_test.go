package handlers

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/service"
	v1 "github.com/kandev/kandev/pkg/api/v1"
	"github.com/stretchr/testify/require"
)

func poolCreateServiceRequest(f poolMoveWireFixture) *service.CreateTaskRequest {
	return &service.CreateTaskRequest{WorkspaceID: f.task.WorkspaceID, WorkflowID: f.task.WorkflowID,
		WorkflowStepID: f.step.ID, Title: "原生分段创建", ExecutorID: models.ExecutorIDWorktree,
		Repositories: []service.TaskRepositoryInput{{RepositoryID: "pool-create-repository", BaseBranch: "main"}},
		PoolRelease: &service.PoolReleaseConfirmation{ConfirmCLIQuota: true,
			ExpectedStepVersion: f.step.UpdatedAt.UTC().Format(time.RFC3339Nano)}}
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3
func TestPoolCreateWireInterruptedRequestHasNoBackfillableApproval(t *testing.T) {
	f, dispatcher := newPoolCreateFixture(t)
	result, err := f.service.CreateTask(f.ctx, poolCreateServiceRequest(f))
	require.NoError(t, err)
	assertPoolCreateUnpublished(t, f, dispatcher)
	_, err = f.tasks.EnsureCurrentTaskStepTransition(f.ctx, result.Task.ID)
	require.Error(t, err, "普通读取／回填不能给中断的创建请求补造批准")
	_, err = f.service.PublishPoolRelease(f.ctx, result.Task.ID, f.step.ID, "1")
	require.Error(t, err)
	assertPoolCreateUnpublished(t, f, dispatcher)
	settled, _, err := f.service.CompleteTaskCreation(f.ctx, result)
	require.NoError(t, err)
	require.True(t, settled)
	require.Equal(t, 1, dispatcher.calls)
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolCreateWireFinalizationRejectsChangedNativeTask(t *testing.T) {
	f, dispatcher := newPoolCreateFixture(t)
	result, err := f.service.CreateTask(f.ctx, poolCreateServiceRequest(f))
	require.NoError(t, err)
	_, err = f.database.Exec(`UPDATE tasks SET title='并行编辑', updated_at=? WHERE id=?`, result.Task.UpdatedAt.Add(time.Second), result.Task.ID)
	require.NoError(t, err)
	settled, _, err := f.service.CompleteTaskCreation(f.ctx, result)
	require.Error(t, err)
	require.False(t, settled)
	assertPoolCreateUnpublished(t, f, dispatcher)
	current, err := f.tasks.GetTask(f.ctx, result.Task.ID)
	require.NoError(t, err)
	require.Equal(t, "并行编辑", current.Title)
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-005.4
func TestPoolCreateWireFinalizationCannotTransferCreatorApproval(t *testing.T) {
	f, dispatcher := newPoolCreateFixture(t)
	result, err := f.service.CreateTask(f.ctx, poolCreateServiceRequest(f))
	require.NoError(t, err)
	otherBrowser := authn.WithIdentity(f.ctx, authn.Identity{UserID: "pool-wire-human", Role: authn.RoleAdmin, SessionID: "another-browser"})
	settled, _, err := f.service.CompleteTaskCreation(otherBrowser, result)
	require.Error(t, err)
	require.False(t, settled)
	assertPoolCreateUnpublished(t, f, dispatcher)
	settled, _, err = f.service.CompleteTaskCreation(f.ctx, result)
	require.NoError(t, err)
	require.True(t, settled)
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3
func TestPoolCreateWireHTTPDependenciesArePresentBeforeApproval(t *testing.T) {
	for _, complete := range []bool{false, true} {
		t.Run(fmt.Sprint(complete), func(t *testing.T) {
			f, dispatcher := newPoolCreateFixture(t)
			if complete {
				_, err := f.database.Exec(`UPDATE tasks SET state=? WHERE id=?`, v1.TaskStateCompleted, f.task.ID)
				require.NoError(t, err)
			}
			payload := f.createPayload()
			payload["blocked_by"] = []string{f.task.ID}
			status, body := f.create(t, "http", payload)
			if complete {
				require.Equal(t, http.StatusOK, status, string(body))
				require.Equal(t, 1, dispatcher.calls)
			} else {
				require.NotEqual(t, http.StatusOK, status)
				assertPoolCreateUnpublished(t, f, dispatcher)
			}
			var count int
			require.NoError(t, f.database.Get(&count, `SELECT COUNT(*) FROM task_blockers WHERE blocker_task_id=?`, f.task.ID))
			require.Equal(t, 1, count)
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolCreateWireHTTPExternalIDRetryDoesNotRepublish(t *testing.T) {
	f, dispatcher := newPoolCreateFixture(t)
	payload := f.createPayload()
	payload["external_id"] = "pool-create-idempotent"
	for range 2 {
		status, body := f.create(t, "http", payload)
		require.Equal(t, http.StatusOK, status, string(body))
	}
	require.Equal(t, 1, dispatcher.calls)
	var count int
	require.NoError(t, f.database.Get(&count, `SELECT COUNT(*) FROM runs`))
	require.Equal(t, 1, count)
}

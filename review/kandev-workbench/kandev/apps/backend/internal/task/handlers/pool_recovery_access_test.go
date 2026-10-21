package handlers

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/authz"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	"github.com/kandev/kandev/internal/task/service"
	"github.com/stretchr/testify/require"
)

func readyPoolWireRecovery(t *testing.T) (poolMoveWireFixture, runsmodels.PoolRecoveryCommand, *runsmodels.Run) {
	t.Helper()
	f := newPoolMoveWireFixture(t)
	status, _ := f.move(t, "http", f.payload())
	require.Equal(t, http.StatusOK, status)
	var entry int64
	require.NoError(t, f.database.Get(&entry, `SELECT MAX(id) FROM task_step_transitions WHERE task_id=?`, f.task.ID))
	_, err := f.service.PublishPoolRelease(f.ctx, f.task.ID, f.step.ID, strconv.FormatInt(entry, 10))
	require.NoError(t, err)
	var ids []string
	require.NoError(t, f.database.Select(&ids, `SELECT id FROM runs WHERE workspace_id=?`, f.task.WorkspaceID))
	require.Len(t, ids, 1)
	run, err := f.runs.GetRunByID(context.Background(), ids[0])
	require.NoError(t, err)
	task, err := f.tasks.GetTask(context.Background(), f.task.ID)
	require.NoError(t, err)
	events, err := f.runs.ListRunEvents(context.Background(), run.ID, -1, 50)
	require.NoError(t, err)
	last := -1
	for _, event := range events {
		last = max(last, event.Seq)
	}
	return f, runsmodels.PoolRecoveryCommand{Action: "withdraw", OperationID: uuid.NewString(), RunID: run.ID, Confirm: true,
		ExpectedTaskVersion: task.UpdatedAt.UTC().Format(time.RFC3339Nano), ExpectedRunVersion: runsmodels.PoolRecoveryRunVersion(run, last)}, run
}

// @covers AC-TASKS-AGENT-POOL-005.4 AC-TASKS-AGENT-POOL-003.4
func TestPoolRecoveryTaskServiceScopesBeforeMutation(t *testing.T) {
	for _, mode := range []string{"foreign-admin", "viewer", "owner"} {
		t.Run(mode, func(t *testing.T) {
			f, command, before := readyPoolWireRecovery(t)
			ctx := f.ctx
			if mode == "foreign-admin" {
				ctx = authn.WithIdentity(context.Background(), authn.Identity{UserID: "foreign-admin", SessionID: "browser", Role: authn.RoleAdmin})
			}
			if mode == "viewer" {
				require.NoError(t, f.tasks.UpsertWorkspaceMember(context.Background(), &models.WorkspaceMember{
					WorkspaceID: f.task.WorkspaceID, UserID: "pool-viewer", Role: string(authz.WorkspaceRoleViewer),
				}))
				ctx = authn.WithIdentity(context.Background(), authn.Identity{UserID: "pool-viewer", SessionID: "browser", Role: authn.RoleGuest})
			}
			event, err := f.service.RecoverPoolRun(ctx, f.task.ID, command)
			switch mode {
			case "foreign-admin":
				require.ErrorIs(t, err, repoerrors.ErrTaskNotFound)
			case "viewer":
				require.True(t, service.IsForbidden(err), "可读不等于可撤回: %v", err)
			case "owner":
				require.NoError(t, err)
				require.NotNil(t, event)
			}
			after, readErr := f.runs.GetRunByID(context.Background(), before.ID)
			require.NoError(t, readErr)
			if mode == "owner" {
				require.Equal(t, "cancelled", string(after.Status))
			} else {
				require.Nil(t, event)
				require.Equal(t, before, after)
			}
		})
	}
}

package handlers

import (
	"context"
	"net/http"
	"testing"

	"github.com/kandev/kandev/internal/auth/authn"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-005.4
func TestPoolMoveWireCannotUseTokenSyntheticOrForeignIdentityAsHumanApproval(t *testing.T) {
	for _, transport := range []string{"http", "websocket"} {
		for _, identityKind := range []string{"token", "synthetic", "foreign"} {
			t.Run(transport+"/"+identityKind, func(t *testing.T) {
				f := newPoolMoveWireFixture(t)
				before, err := f.tasks.GetTask(context.Background(), f.task.ID)
				require.NoError(t, err)
				identity := authn.Identity{UserID: "pool-wire-human", SessionID: "pool-wire-browser", Role: authn.RoleAdmin}
				switch identityKind {
				case "token":
					identity.TokenID = "fixture-token-id"
				case "synthetic":
					identity.Synthetic = true
				case "foreign":
					identity.UserID, identity.Role = "different-user", authn.RoleMember
				}
				f.ctx = authn.WithIdentity(context.Background(), identity)
				status, body := f.move(t, transport, f.payload())
				require.NotEqual(t, http.StatusOK, status, string(body))
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

// @covers AC-TASKS-AGENT-POOL-001.4
func TestPoolMoveWireOmissionPreservesOrdinaryWorkflowMove(t *testing.T) {
	for _, transport := range []string{"http", "websocket"} {
		t.Run(transport, func(t *testing.T) {
			f := newPoolMoveWireFixture(t)
			step := &wfmodels.WorkflowStep{ID: "wire-ordinary-step", WorkflowID: f.task.WorkflowID, Name: "普通阶段", AllowManualMove: true, Position: 2}
			require.NoError(t, f.workflows.CreateStep(context.Background(), step))
			payload := f.payload()
			delete(payload, "pool_release")
			payload["workflow_step_id"] = step.ID
			status, body := f.move(t, transport, payload)
			require.Equal(t, http.StatusOK, status, string(body))
			stored, err := f.tasks.GetTask(context.Background(), f.task.ID)
			require.NoError(t, err)
			require.Equal(t, step.ID, stored.WorkflowStepID)
			var approved, runs int
			require.NoError(t, f.database.Get(&approved, `SELECT COUNT(*) FROM task_step_transitions WHERE task_id=? AND trigger='pool_release_v1'`, f.task.ID))
			require.NoError(t, f.database.Get(&runs, `SELECT COUNT(*) FROM runs`))
			require.Zero(t, approved)
			require.Zero(t, runs)
		})
	}
}

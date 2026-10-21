package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/authz"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/stretchr/testify/require"
)

func TestPoolRecoveryHTTPReadScopesAndAvailability(t *testing.T) {
	for _, mode := range []string{"viewer", "foreign-admin", "disabled", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			f, _, run := readyPoolWireRecovery(t)
			ctx, want := f.ctx, http.StatusOK
			switch mode {
			case "viewer":
				require.NoError(t, f.tasks.UpsertWorkspaceMember(ctx, &models.WorkspaceMember{
					WorkspaceID: f.task.WorkspaceID, UserID: "pool-viewer", Role: string(authz.WorkspaceRoleViewer)}))
				ctx = authn.WithIdentity(context.Background(), authn.Identity{UserID: "pool-viewer", SessionID: "browser", Role: authn.RoleGuest})
			case "foreign-admin":
				ctx = authn.WithIdentity(context.Background(), authn.Identity{UserID: "foreign-admin", SessionID: "browser", Role: authn.RoleAdmin})
				want = http.StatusNotFound
			case "disabled":
				f.service.SetPoolRunQueue(nil)
				want = http.StatusServiceUnavailable
			case "cancelled":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx, want = cancelled, http.StatusServiceUnavailable
			}
			before := poolHistorySourceCounts(t, f)
			response := poolRecoveryWireRequest(t, f, ctx, http.MethodGet, "/api/v1/tasks/"+f.task.ID+"/pool-recovery?run_id="+run.ID, nil)
			require.Equal(t, want, response.Code, response.Body.String())
			if mode == "viewer" {
				var state recoveryWireContext
				require.NoError(t, json.Unmarshal(response.Body.Bytes(), &state))
				require.False(t, state.Actions.Withdraw)
				require.False(t, state.Actions.Stop)
				require.False(t, state.Actions.Retry)
			}
			require.NotContains(t, response.Body.String(), "context canceled")
			require.Equal(t, before, poolHistorySourceCounts(t, f))
		})
	}
}

func TestPoolRecoveryHTTPReleaseChangedDoesNotLookMissing(t *testing.T) {
	f, command, run := readyPoolWireRecovery(t)
	// 模拟读到确认后、写入前已发生的原生阶段移动；保留原始运行及其批准。
	_, err := f.database.Exec(`UPDATE tasks SET workflow_step_id='pool-wire-backlog' WHERE id=?`, f.task.ID)
	require.NoError(t, err)
	before := poolHistorySourceCounts(t, f)
	base := "/api/v1/tasks/" + f.task.ID + "/pool-recovery"
	read := poolRecoveryWireRequest(t, f, f.ctx, http.MethodGet, base+"?run_id="+run.ID, nil)
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())
	var state recoveryWireContext
	require.NoError(t, json.Unmarshal(read.Body.Bytes(), &state))
	require.False(t, state.Actions.Withdraw)
	write := poolRecoveryWireRequest(t, f, f.ctx, http.MethodPost, base, command)
	require.Equal(t, http.StatusConflict, write.Code, write.Body.String())
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

func TestPoolRecoveryHTTPUnknownOperationAndStaleVersion(t *testing.T) {
	f, command, run := readyPoolWireRecovery(t)
	base := "/api/v1/tasks/" + f.task.ID + "/pool-recovery"
	before := poolHistorySourceCounts(t, f)
	query := poolRecoveryWireRequest(t, f, f.ctx, http.MethodGet, base+"/"+uuid.NewString()+"?run_id="+run.ID, nil)
	require.Equal(t, http.StatusNotFound, query.Code, query.Body.String())
	command.ExpectedRunVersion = strings.Repeat("0", 64)
	write := poolRecoveryWireRequest(t, f, f.ctx, http.MethodPost, base, command)
	require.Equal(t, http.StatusConflict, write.Code, write.Body.String())
	command.ExpectedManagementVersion = strings.Repeat("x", 20000)
	oversized := poolRecoveryWireRequest(t, f, f.ctx, http.MethodPost, base, command)
	require.Equal(t, http.StatusBadRequest, oversized.Code, oversized.Body.String())
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/kandev/kandev/internal/auth/authn"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

func poolRecoveryWireRequest(t *testing.T, f poolMoveWireFixture, ctx context.Context, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		require.NoError(t, err)
	}
	router := gin.New()
	router.Use(func(c *gin.Context) { c.Request = c.Request.WithContext(ctx); c.Next() })
	f.handler.registerHTTP(router)
	req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	return response
}

type recoveryWireContext struct {
	TaskID            string `json:"task_id"`
	RunID             string `json:"run_id"`
	ClaimID           string `json:"claim_id"`
	TaskVersion       string `json:"task_version"`
	RunVersion        string `json:"run_version"`
	ManagementVersion string `json:"management_version"`
	Actions           struct {
		Withdraw bool `json:"withdraw"`
		Stop     bool `json:"stop"`
		Retry    bool `json:"retry"`
	} `json:"actions"`
}

// @covers AC-TASKS-AGENT-POOL-005.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolRecoveryHTTPReadConfirmReplayAndQuery(t *testing.T) {
	f, command, run := readyPoolWireRecovery(t)
	base := "/api/v1/tasks/" + f.task.ID + "/pool-recovery"
	before := poolHistorySourceCounts(t, f)
	read := poolRecoveryWireRequest(t, f, f.ctx, http.MethodGet, base+"?run_id="+run.ID, nil)
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())
	var state recoveryWireContext
	require.NoError(t, json.Unmarshal(read.Body.Bytes(), &state))
	require.Equal(t, f.task.ID, state.TaskID)
	require.Equal(t, run.ID, state.RunID)
	require.Equal(t, command.ExpectedTaskVersion, state.TaskVersion)
	require.Equal(t, command.ExpectedRunVersion, state.RunVersion)
	require.Empty(t, state.ClaimID)
	require.True(t, state.Actions.Withdraw)
	require.False(t, state.Actions.Stop)
	require.False(t, state.Actions.Retry)
	require.Equal(t, before, poolHistorySourceCounts(t, f), "读取不能派发或确认")
	command.ExpectedTaskVersion = state.TaskVersion
	command.ExpectedRunVersion = state.RunVersion
	command.ExpectedManagementVersion = state.ManagementVersion
	first := poolRecoveryWireRequest(t, f, f.ctx, http.MethodPost, base, command)
	require.Equal(t, http.StatusOK, first.Code, first.Body.String())
	require.Contains(t, first.Body.String(), `"result":"withdrawn"`)
	replayed := poolRecoveryWireRequest(t, f, f.ctx, http.MethodPost, base, command)
	require.Equal(t, first.Code, replayed.Code)
	require.Equal(t, first.Body.String(), replayed.Body.String())
	query := poolRecoveryWireRequest(t, f, f.ctx, http.MethodGet, base+"/"+command.OperationID+"?run_id="+run.ID, nil)
	require.Equal(t, http.StatusOK, query.Code, query.Body.String())
	require.Equal(t, first.Body.String(), query.Body.String())
	var count int
	require.NoError(t, f.database.Get(&count, `SELECT COUNT(*) FROM runs`))
	require.Equal(t, 1, count)
}

func TestPoolRecoveryHTTPStrictConfirmationAndPrivateScope(t *testing.T) {
	for _, mode := range []string{"no-confirmation", "forged-actor", "foreign-admin"} {
		t.Run(mode, func(t *testing.T) {
			f, command, _ := readyPoolWireRecovery(t)
			ctx := f.ctx
			var body any = command
			want := http.StatusConflict
			if mode == "no-confirmation" {
				command.Confirm = false
				body = command
			}
			if mode == "forged-actor" {
				encoded, err := json.Marshal(command)
				require.NoError(t, err)
				var fields map[string]any
				require.NoError(t, json.Unmarshal(encoded, &fields))
				fields["actor_id"] = "self-reported"
				fields["stopped_at"] = "2026-10-20T00:00:00Z"
				body = fields
				want = http.StatusBadRequest
			}
			if mode == "foreign-admin" {
				ctx = authn.WithIdentity(context.Background(), authn.Identity{UserID: "foreign-admin", SessionID: "browser", Role: authn.RoleAdmin})
				want = http.StatusNotFound
			}
			before := poolHistorySourceCounts(t, f)
			response := poolRecoveryWireRequest(t, f, ctx, http.MethodPost, "/api/v1/tasks/"+f.task.ID+"/pool-recovery", body)
			require.Equal(t, want, response.Code, response.Body.String())
			require.Equal(t, before, poolHistorySourceCounts(t, f))
		})
	}
}

func TestPoolRecoveryHTTPForeignRunIsIndistinguishableFromMissing(t *testing.T) {
	f, command, _ := readyPoolWireRecovery(t)
	ordinary := &runsmodels.Run{ID: "unrelated-run", AgentProfileID: f.step.AgentProfileID, WorkspaceID: f.task.WorkspaceID,
		Reason: "ordinary", Payload: "{}", Status: runsmodels.RunStatusQueued}
	require.NoError(t, f.runs.CreateRun(context.Background(), ordinary))
	base := "/api/v1/tasks/" + f.task.ID + "/pool-recovery"
	for _, id := range []string{ordinary.ID, "missing-run"} {
		read := poolRecoveryWireRequest(t, f, f.ctx, http.MethodGet, base+"?run_id="+id, nil)
		require.Equal(t, http.StatusNotFound, read.Code, read.Body.String())
		wrong := command
		wrong.RunID = id
		write := poolRecoveryWireRequest(t, f, f.ctx, http.MethodPost, base, wrong)
		require.Equal(t, http.StatusNotFound, write.Code, write.Body.String())
	}
}

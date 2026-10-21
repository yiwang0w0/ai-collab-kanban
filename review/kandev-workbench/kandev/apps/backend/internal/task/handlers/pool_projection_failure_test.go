package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/task/poolview"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	"github.com/stretchr/testify/require"
)

type poolProjectionFaultRepo struct {
	*tasksqlite.Repository
	read func(context.Context, string, poolview.Query) (*poolview.Snapshot, error)
}

func (r *poolProjectionFaultRepo) ReadPoolProjectionSnapshot(ctx context.Context, workspaceID string, query poolview.Query) (*poolview.Snapshot, error) {
	return r.read(ctx, workspaceID, query)
}

func TestPoolProjectionHTTPRejectsOversizedAndRepeatedSourceRows(t *testing.T) {
	for _, mode := range []string{"oversized", "duplicate", "row_scope"} {
		t.Run(mode, func(t *testing.T) {
			f := newPoolMoveWireFixture(t)
			fault := &poolProjectionFaultRepo{Repository: f.tasks, read: func(ctx context.Context, workspaceID string, query poolview.Query) (*poolview.Snapshot, error) {
				snapshot, err := f.tasks.ReadPoolProjectionSnapshot(ctx, workspaceID, query)
				require.NoError(t, err)
				card := snapshot.Cards[0]
				if mode == "oversized" {
					for index := 0; index < 50; index++ {
						copy := card
						copy.TaskID = fmt.Sprintf("pool-source-%02d", index)
						snapshot.Cards = append(snapshot.Cards, copy)
					}
				} else if mode == "duplicate" {
					snapshot.Cards = append(snapshot.Cards, card)
				} else {
					snapshot.Cards[0].WorkspaceID = "PRIVATE-FOREIGN-ROW"
				}
				return snapshot, nil
			}}
			installPoolHistoryRepo(&f, fault)
			response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool")
			require.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), "pool_projection_unavailable")
		})
	}
}

func TestPoolProjectionHTTPFailsClosedWithoutReadCapability(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	installPoolHistoryRepo(&f, poolHistoryMissingCapability{f.tasks})
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool")
	require.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "pool_projection_unavailable")
}

func TestPoolProjectionHTTPDoesNotConfirmResultAfterCallerCancellation(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	ctx, cancel := context.WithCancel(f.ctx)
	defer cancel()
	reads := 0
	fault := &poolProjectionFaultRepo{Repository: f.tasks, read: func(readContext context.Context, workspaceID string, query poolview.Query) (*poolview.Snapshot, error) {
		reads++
		snapshot, err := f.tasks.ReadPoolProjectionSnapshot(readContext, workspaceID, query)
		require.NoError(t, err)
		cancel()
		return snapshot, nil
	}}
	installPoolHistoryRepo(&f, fault)
	response := poolHistoryHTTPRequest(t, f, ctx, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool")
	require.Equal(t, 1, reads, "取消发生在实际读取之后，不是权限查询前")
	require.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
}

func TestPoolProjectionHTTPKeepsSourceErrorsPrivateAndCarriesReadBudget(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	reads := 0
	fault := &poolProjectionFaultRepo{Repository: f.tasks, read: func(ctx context.Context, _ string, _ poolview.Query) (*poolview.Snapshot, error) {
		reads++
		deadline, ok := ctx.Deadline()
		require.True(t, ok)
		require.LessOrEqual(t, time.Until(deadline), 3*time.Second)
		return nil, errors.New("PRIVATE-POOL-LIST-DATABASE-DIAGNOSTIC")
	}}
	installPoolHistoryRepo(&f, fault)
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool")
	require.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
	require.Equal(t, 1, reads)
	require.NotContains(t, response.Body.String(), "PRIVATE-POOL-LIST")
	require.Contains(t, response.Body.String(), "pool_projection_unavailable")
}

func TestPoolProjectionHTTPRejectsNilAndForeignSourceSnapshots(t *testing.T) {
	for _, mode := range []string{"nil", "foreign"} {
		t.Run(mode, func(t *testing.T) {
			f := newPoolMoveWireFixture(t)
			fault := &poolProjectionFaultRepo{Repository: f.tasks, read: func(context.Context, string, poolview.Query) (*poolview.Snapshot, error) {
				if mode == "nil" {
					return nil, nil
				}
				return &poolview.Snapshot{WorkspaceID: "PRIVATE-FOREIGN-WORKSPACE"}, nil
			}}
			installPoolHistoryRepo(&f, fault)
			response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/workspaces/"+f.task.WorkspaceID+"/task-pool")
			require.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
			require.NotContains(t, response.Body.String(), "PRIVATE-FOREIGN")
		})
	}
}

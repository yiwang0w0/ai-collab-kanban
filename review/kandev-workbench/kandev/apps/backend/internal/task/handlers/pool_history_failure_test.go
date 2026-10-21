package handlers

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/repository"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	"github.com/kandev/kandev/internal/task/service"
	"github.com/stretchr/testify/require"
)

type poolHistoryFaultRepo struct {
	*tasksqlite.Repository
	workspace func(context.Context, string) (string, error)
	read      func(context.Context, string, string, poolhistory.Query) (*poolhistory.Snapshot, error)
}

func (r *poolHistoryFaultRepo) PoolHistoryWorkspace(ctx context.Context, taskID string) (string, error) {
	if r.workspace != nil {
		return r.workspace(ctx, taskID)
	}
	return r.Repository.PoolHistoryWorkspace(ctx, taskID)
}

func (r *poolHistoryFaultRepo) ReadPoolHistorySnapshot(ctx context.Context, taskID, workspaceID string, query poolhistory.Query) (*poolhistory.Snapshot, error) {
	if r.read != nil {
		return r.read(ctx, taskID, workspaceID, query)
	}
	return r.Repository.ReadPoolHistorySnapshot(ctx, taskID, workspaceID, query)
}

func installPoolHistoryRepo(f *poolMoveWireFixture, repo repository.TaskRepository) {
	f.service = service.NewService(service.Repos{Tasks: repo, Workspaces: f.tasks}, nil, f.handler.logger, service.RepositoryDiscoveryConfig{})
	f.handler.service = f.service
}

func TestPoolHistoryHTTPDoesNotReturnInternalSourceErrorsOrLoseReadDeadline(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	calls := 0
	fault := &poolHistoryFaultRepo{Repository: f.tasks, read: func(ctx context.Context, taskID, workspaceID string, query poolhistory.Query) (*poolhistory.Snapshot, error) {
		calls++
		require.Equal(t, f.task.ID, taskID)
		require.Equal(t, f.task.WorkspaceID, workspaceID)
		deadline, ok := ctx.Deadline()
		require.True(t, ok, "读取预算必须传到实际来源")
		require.LessOrEqual(t, time.Until(deadline), 3*time.Second)
		return nil, errors.New("PRIVATE-DATABASE-DIAGNOSTIC-NOT-FOR-HTTP")
	}}
	installPoolHistoryRepo(&f, fault)
	before := poolHistorySourceCounts(t, f)
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history")
	require.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
	require.Equal(t, 1, calls)
	require.NotContains(t, response.Body.String(), "PRIVATE-DATABASE-DIAGNOSTIC")
	require.Contains(t, response.Body.String(), "pool_history_unavailable")
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

func TestPoolHistoryHTTPRejectsEmptyPermissionScopeBeforeHistoryRead(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	reads := 0
	fault := &poolHistoryFaultRepo{Repository: f.tasks, workspace: func(context.Context, string) (string, error) { return "", nil },
		read: func(context.Context, string, string, poolhistory.Query) (*poolhistory.Snapshot, error) {
			reads++
			return &poolhistory.Snapshot{TaskID: f.task.ID}, nil
		}}
	installPoolHistoryRepo(&f, fault)
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history")
	require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
	require.Zero(t, reads, "空工作区不能借用原生内部调用的无作用域分支")
}

func TestPoolHistoryHTTPRejectsWrongSourceScopeAndNilSnapshots(t *testing.T) {
	for _, mode := range []string{"foreign", "nil"} {
		t.Run(mode, func(t *testing.T) {
			f := newPoolMoveWireFixture(t)
			fault := &poolHistoryFaultRepo{Repository: f.tasks, read: func(context.Context, string, string, poolhistory.Query) (*poolhistory.Snapshot, error) {
				if mode == "nil" {
					return nil, nil
				}
				return &poolhistory.Snapshot{TaskID: "PRIVATE-FOREIGN-TASK", WorkspaceID: "PRIVATE-FOREIGN-WORKSPACE"}, nil
			}}
			installPoolHistoryRepo(&f, fault)
			response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history")
			require.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
			require.NotContains(t, response.Body.String(), "PRIVATE-FOREIGN")
		})
	}
}

type poolHistoryMissingCapability struct{ repository.TaskRepository }

func TestPoolHistoryHTTPFailsClosedWithoutOptionalReadCapability(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	installPoolHistoryRepo(&f, poolHistoryMissingCapability{f.tasks})
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history")
	require.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "pool_history_unavailable")
}

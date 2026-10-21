package service

import (
	"context"
	"errors"
	"time"

	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

type poolHistoryReader interface {
	PoolHistoryWorkspace(context.Context, string) (string, error)
	ReadPoolHistorySnapshot(context.Context, string, string, poolhistory.Query) (*poolhistory.Snapshot, error)
}

func (s *Service) GetPoolHistory(ctx context.Context, taskID string, limit int, cursor string) (*poolhistory.Page, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	reader, ok := s.tasks.(poolHistoryReader)
	if !ok {
		return nil, poolhistory.ErrUnavailable
	}
	workspaceID, err := reader.PoolHistoryWorkspace(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if workspaceID == "" {
		return nil, repoerrors.ErrTaskNotFound
	}
	if err := s.authorizeWorkspaceID(ctx, workspaceID); err != nil {
		if errors.Is(err, repoerrors.ErrWorkspaceNotFound) {
			return nil, repoerrors.ErrTaskNotFound
		}
		return nil, err
	}
	query, err := poolhistory.ParseQuery(taskID, limit, cursor)
	if err != nil {
		return nil, err
	}
	snapshot, err := reader.ReadPoolHistorySnapshot(ctx, taskID, workspaceID, query)
	if err != nil {
		return nil, err
	}
	if snapshot == nil || snapshot.TaskID != taskID || snapshot.WorkspaceID != workspaceID {
		return nil, poolhistory.ErrUnavailable
	}
	return poolhistory.Project(snapshot)
}
